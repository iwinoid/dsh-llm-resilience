/**
 * agent/request-error 的升级续重试处理器（可单测，不 import 任何 DSH 包）。
 *
 * 分层语义（顺序已由上游源码核实）：
 *  1. llm-retry 在 base bundle 里先注册，是 waterfall 的外层；normal 模式下预算
 *     未尽的失败由它直接 return {kind:'retry'} 且不调用 next()，本处理器不会被
 *     调用。只有它放弃（调用 next()）时才轮到本处理器兜底。
 *  2. 本处理器先 await next()：若内层还有别的恢复策略返回 {kind:'retry'}，原样
 *     透传；否则在失败码属于 ESCALATION_RETRYABLE_CODES、升级预算未耗尽、signal
 *     未 abort 时做一次同路由续重试。
 *  3. 续重试复用原生 durable 事件：先 append `llm/retry`（独立 policyKey、retry 从
 *     1 起、同一 retryId 递增），等待结束再 append `llm/retry-started`，然后返回
 *     {kind:'retry'}。Web UI 的 model-retry 节点因此自动显示「正在重试（k/N）」，
 *     零 UI 成本，也不会污染模型上下文。
 *  4. 若会话或事件类型不可用（headless/未装 llm-retry），append 失败只记日志，
 *     续重试照常进行（退化为仅日志可见）。
 *  5. 预算耗尽/不可重试/abort 时 return undefined，让循环抛出适配器原始 LlmError
 *     （turn-error 节点展示原始 code/message），绝不伪造失败或切换路由。
 *
 * 任何路径都不写 provider/model 选择，也不塞 user/message。
 */
import {
  classifyFailure,
  escalationDecision,
  escalationGaveUpNotice,
  escalationRetryNotice,
} from './policy.js';

/** 升级续重试写 llm/retry 事件时使用的独立 policyKey（与 llm-retry 的预算互不干扰）。 */
export const ESCALATION_POLICY_KEY = 'llm-resilience:escalation';

/**
 * 生成一次升级续重试链的 retryId（同一 turn+step 内复用）。
 * @returns {string} 去重后的随机 id。
 */
export function newRetryId() {
  const crypto = globalThis.crypto;
  if (crypto !== undefined && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `llm-resilience-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 可取消延时：signal abort 时立即结算并清理定时器与监听器，绝不泄漏。
 * @param {number} delayMs 等待毫秒数。
 * @param {AbortSignal} signal 取消信号。
 * @returns {Promise<boolean>} true 表示完整等待结束，false 表示被取消。
 */
export function sleepCancellable(delayMs, signal) {
  const { promise, resolve } = Promise.withResolvers();
  if (signal.aborted) {
    resolve(false);
    return promise;
  }
  const timer = setTimeout(() => finish(true), delayMs);
  timer.unref?.();
  const onAbort = () => finish(false);
  function finish(elapsed) {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    resolve(elapsed);
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

/**
 * 创建一个绑定到单次插件生命周期的升级续重试处理器。
 * @param {{
 *   readConfig: () => object | undefined,
 *   log: (level: string, message: string) => void,
 *   lifetime: AbortController,
 *   sleep?: (delayMs: number, signal: AbortSignal) => Promise<boolean>,
 *   retryId?: () => string,
 * }} options
 *   readConfig 每次失败时重新读取（Volatile 配置可热改）；log 为诊断输出；
 *   lifetime 在插件卸载时 abort；sleep/retryId 可注入测试替身。
 * @returns {((payload: object, next: () => Promise<object | undefined>) => Promise<object | undefined>) & {
 *   state: { key: string, count: number, retryId: string | undefined },
 *   drain: () => Promise<void>,
 * }} 可直接注册到 ctx.on('agent/request-error', handler)（默认 append）的函数。
 */
export function createEscalationHandler({
  readConfig,
  log,
  lifetime,
  sleep = sleepCancellable,
  retryId = newRetryId,
}) {
  /** 升级计数与 retry 链 id，按 agent+turn+step 归属；step 变化即清零。 */
  const state = { key: '', count: 0, retryId: undefined };
  /** 正在进行的可取消等待，drain() 时一并结算。 */
  const activeWaits = new Set();

  /**
   * 追加一条 durable 会话事件；失败只记日志，退化为仅日志可见。
   * @param {object | undefined} session Agent 的 Session。
   * @param {string} type 事件类型（llm/retry 或 llm/retry-started）。
   * @param {object} data 事件负载。
   * @returns {boolean} 是否成功追加。
   */
  function appendEvent(session, type, data) {
    if (session === undefined || session === null || typeof session.append !== 'function') {
      log('warn', `会话不可用，${type} 事件未写入（续重试仅日志可见）`);
      return false;
    }
    try {
      session.append(type, data);
      return true;
    } catch (error) {
      log('warn', `追加 ${type} 事件失败（续重试仅日志可见）：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function handler(payload, next) {
    let decision;
    try {
      decision = await next();
    } catch (error) {
      log('warn', `请求失败处理链的下游抛错：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    try {
      const current = readConfig();
      if (current === undefined || !current.enabled) return decision;
      const provider = typeof payload.provider === 'string' ? payload.provider : 'unknown';
      // 内层其它恢复策略（若存在）已经安排了重试：尊重它，不叠加、不再延时。
      if (decision !== undefined) {
        if (decision.kind === 'retry') {
          const classified = classifyFailure(payload.failure);
          log('info', `提供商 "${provider}" 请求失败（${classified.labelZh}：${classified.message}）；内层恢复策略已安排重试`);
        }
        return decision;
      }
      // 基础策略是 always（无上限重试）时不再叠加本层预算。
      const basePolicy = payload.retryPolicy;
      if (basePolicy !== undefined && basePolicy !== null && basePolicy.mode === 'always') return undefined;

      const turn = payload.turn;
      const step = payload.step;
      const agentId = payload.agent !== undefined && typeof payload.agent.id === 'string' ? payload.agent.id : 'unknown';
      const stateKey = `${agentId}:${String(turn)}:${String(step)}`;
      if (state.key !== stateKey) {
        state.key = stateKey;
        state.count = 0;
        state.retryId = undefined;
      }
      const callerSignal = payload.signal ?? new AbortController().signal;
      const signal = AbortSignal.any([callerSignal, lifetime.signal]);
      const escalated = escalationDecision({
        failure: payload.failure,
        escalatedCount: state.count,
        config: current,
        aborted: signal.aborted,
      });
      if (escalated.kind !== 'escalate') {
        if (escalated.reason === 'budget-exhausted') {
          log(
            'warn',
            escalationGaveUpNotice({
              provider,
              failure: payload.failure,
              escalatedRetries: state.count,
            }).zh,
          );
        }
        return undefined;
      }
      if (state.retryId === undefined) state.retryId = retryId();
      const retry = escalated.escalatedCount;
      const session = payload.agent === undefined ? undefined : payload.agent.session;
      const recorded = appendEvent(session, 'llm/retry', {
        retryId: state.retryId,
        turn,
        step,
        provider,
        mode: 'normal',
        policyKey: ESCALATION_POLICY_KEY,
        retry,
        maxRetries: current.escalatedRetries,
        delayMs: escalated.delayMs,
        failure: payload.failure,
      });
      log(
        'info',
        escalationRetryNotice({
          provider,
          failure: payload.failure,
          attempt: retry,
          maxRetries: current.escalatedRetries,
        }).zh,
      );
      const wait = sleep(escalated.delayMs, signal);
      activeWaits.add(wait);
      let elapsed;
      try {
        elapsed = await wait;
      } finally {
        activeWaits.delete(wait);
      }
      if (!elapsed || signal.aborted || lifetime.signal.aborted) return undefined;
      if (recorded) {
        appendEvent(session, 'llm/retry-started', {
          retryId: state.retryId,
          turn,
          step,
          retry,
        });
      }
      state.count = retry;
      return { kind: 'retry' };
    } catch (error) {
      // 升级逻辑自身出错时交回循环默认处理，绝不改变请求路由。
      log('warn', `升级续重试逻辑出错，交回默认失败处理：${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
  }

  handler.state = state;
  /** 等待所有在途可取消延时结算（abort 后立即完成）。 */
  handler.drain = async () => {
    await Promise.allSettled([...activeWaits]);
  };
  return handler;
}
