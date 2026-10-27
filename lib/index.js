/**
 * dsh-llm-resilience —— Host 半边。
 *
 * 职责：
 *  1. 暴露本插件 Config（全部字段 volatile，设置页可热改）。
 *  2. 在 Loader 稳定后，把「默认空闲超时」补齐到运行中 profile 的 llm-pi-ai
 *     配置行（通过 DSH settings 服务写入用户配置层，与 Models 设置页同一机制，
 *     pi-ai 原生 idle watchdog 因此按 30000ms 工作，无需重启）。
 *     启动期只写 streamIdleTimeoutMs，不写 retryPolicy：后者会触发 adapter 的
 *     原子重注册（reload 抖动），且会覆盖上游默认策略；retryPolicy 只由用户在
 *     设置页显式保存。用户层已有 streamIdleTimeoutMs 时不覆盖。
 *  3. 在 agent/request-error 上挂一个**默认 append**（不 prepend）的监听：
 *     - 先 await next()，把 llm-retry（基础同路由重试，带原生 k/N UI 提示）与
 *       其它内层恢复策略的决定原样传递，绝不叠加、绝不自己再加延时；
 *     - 当 next() 返回 undefined（基础预算耗尽或该失败不重试）且失败码属于
 *       可升级集合时，做有限次「同路由续重试」（默认 2 次、每次等待 5 秒，
 *       可配置、可经 escalatedRetries=0 关闭）；等待可被 abort 立即打断；
 *     - 升级重试复用原生 durable 事件 llm/retry / llm/retry-started（独立
 *       policyKey），因此 Web 聊天自动显示重试行；事件不可用时退化为仅日志；
 *     - 预算耗尽返回 undefined，循环抛出适配器原始 LlmError（快速失败）。
 *
 * 任何路径都不写模型/提供商选择：只按当前请求的 provider 路由重试，从不改路由。
 */
import z from '@deepseek-ai/schemastery';
import { createEscalationHandler } from './escalation.js';
import {
  DEFAULT_ESCALATED_RETRIES,
  DEFAULT_ESCALATION_DELAY_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_JITTER_RATIO,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PROVIDER_NAMESPACES,
  DEFAULT_RETRYABLE_CODES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  normalizeConfig,
  resolveEffectivePolicy,
  seedProviderIdleTimeoutOps,
} from './policy.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'dsh-llm-resilience';

/** 硬依赖 settings 服务：没有设置服务就没有可编辑的持久化层。 */
export const inject = ['settings'];

/** 重试退避的 Config 片段。 */
const RetryBackoffConfig = z.object({
  initialDelayMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
  maxDelayMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
  jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO),
});

/** 重试策略的 Config 片段。 */
const RetryConfig = z.object({
  maxRetries: z.number().step(1).min(0).max(50).default(DEFAULT_MAX_RETRIES),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
  backoff: RetryBackoffConfig,
});

/**
 * 插件 Config。所有字段标 volatile：Loader 以引用方式热更新，设置页写入即可
 * 生效，无需重启 Host。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  seedOnActivation: z.boolean().default(true).volatile(),
  providerNamespaces: z.array(z.string()).default([...DEFAULT_PROVIDER_NAMESPACES]).volatile(),
  defaultStreamIdleTimeoutMs: z
    .number()
    .step(1)
    .min(1)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    .volatile(),
  defaultRetry: RetryConfig.default({
    maxRetries: DEFAULT_MAX_RETRIES,
    retryableCodes: [...DEFAULT_RETRYABLE_CODES],
    backoff: {
      initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
      jitterRatio: DEFAULT_JITTER_RATIO,
    },
  }).volatile(),
  escalatedRetries: z.number().step(1).min(0).max(50).default(DEFAULT_ESCALATED_RETRIES).volatile(),
  escalationDelayMs: z
    .number()
    .step(1)
    .min(1)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_ESCALATION_DELAY_MS)
    .volatile(),
});

/** 普通对象判断（不含数组/null）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 把可能带 Volatile 引用/原型包装的命名空间值转成只读普通对象。 */
function asPlainObject(value) {
  return isPlainObject(value) ? value : {};
}

/**
 * 安装 Host 行为。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {Record<string, unknown>} config Loader 解析后的 Config（字段可能是 Volatile 引用）。
 */
export function apply(ctx, config) {
  const log = (level, message) => {
    const logger = ctx.logger;
    if (logger === undefined) return;
    const write = typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined;
    if (write !== undefined) write(`[dsh-llm-resilience] ${message}`);
  };

  /** 读取当前 Config 快照并归一化；配置非法时返回 undefined 并记录警告。 */
  const readConfig = () => {
    try {
      return normalizeConfig(config);
    } catch (error) {
      log('warn', `配置非法，本次不应用超时/重试策略：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  /** 记录过的 provider 命名空间缺失诊断，避免每次重载刷屏。 */
  const missingNamespaces = new Set();

  /**
   * 把本插件的有效策略补齐到配置的 provider 命名空间：只补用户层缺失的字段，
   * 不覆盖用户已显式设置的值。
   * @param {string} reason 触发原因（诊断用）。
   */
  const reconcile = async (reason) => {
    const normalized = readConfig();
    if (normalized === undefined) return;
    if (!normalized.enabled) {
      log('info', '插件当前已禁用，跳过默认策略补齐');
      return;
    }
    if (!normalized.seedOnActivation) return;

    let descriptors;
    try {
      descriptors = ctx.settings.describe();
    } catch (error) {
      log('warn', `读取设置描述失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const namespace of normalized.providerNamespaces) {
      const descriptor = descriptors.find(row => row.ns === namespace);
      if (descriptor === undefined) {
        if (!missingNamespaces.has(namespace)) {
          missingNamespaces.add(namespace);
          log('info', `设置命名空间 "${namespace}" 当前未加载（可能未配置该提供商适配器），跳过默认策略补齐`);
        }
        continue;
      }
      missingNamespaces.delete(namespace);

      const value = asPlainObject(descriptor.value);
      const providers = asPlainObject(value.providers);
      const userRoot = asPlainObject(descriptor.user);
      const userProviders = asPlainObject(userRoot.providers);
      const routes = Object.keys(providers).filter(route => typeof route === 'string' && route.length > 0);
      if (routes.length === 0) continue;

      /** @type {Array<{ op: 'set', path: string[], value: unknown }>} */
      const ops = [];
      const seeded = [];
      for (const route of routes) {
        let effective;
        try {
          effective = resolveEffectivePolicy(normalized, route);
        } catch (error) {
          log('warn', `提供商 "${route}" 的有效策略非法，跳过：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const routeOps = seedProviderIdleTimeoutOps(userProviders[route], effective);
        if (routeOps.length === 0) continue;
        seeded.push(route);
        for (const op of routeOps) {
          ops.push({ op: 'set', path: ['providers', route, ...op.path], value: op.value });
        }
      }
      if (ops.length === 0) {
        log('debug', `"${namespace}" 的全部提供商已有显式策略，无需补齐（${reason}）`);
        continue;
      }
      try {
        await ctx.settings.mutate(namespace, ops, descriptor.revision);
        log(
          'info',
          `已为 "${namespace}" 的 ${seeded.length} 个提供商补齐空闲超时：`
            + `${normalized.defaultStreamIdleTimeoutMs}ms（只写超时；重试策略仅由设置页显式写入，${reason}）`,
        );
      } catch (error) {
        log(
          'warn',
          `写入 "${namespace}" 默认策略失败（将在下次配置重载时重试）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  ctx.effect(function* lifecycleEffect() {
    let closed = false;
    let scheduled = false;
    let lastReason = 'activation';

    /** 插件生命周期信号：卸载时立即中断所有升级等待。 */
    const lifetime = new AbortController();

    const requestReconcile = (reason, delayMs = 0) => {
      if (closed) return;
      lastReason = reason;
      if (scheduled) return;
      scheduled = true;
      const run = () => {
        scheduled = false;
        if (closed) return;
        void reconcile(lastReason).catch((error) => {
          log('warn', `默认策略补齐失败：${error instanceof Error ? error.message : String(error)}`);
        });
      };
      if (delayMs > 0) setTimeout(run, delayMs).unref?.();
      else queueMicrotask(run);
    };

    // 1) 本插件使用自定义设置页，声明 auto:false 以免出现重复的自动生成页。
    try {
      yield ctx.settings.configure({ auto: false }, ctx.fiber);
    } catch (error) {
      log('warn', `声明设置页策略失败（不影响配置读写）：${error instanceof Error ? error.message : String(error)}`);
    }

    // 2) agent/request-error：基础重试原样透传；预算耗尽时做有限次同路由续重试。
    //    处理器抽在 lib/escalation.js 中，便于用最小 fake 契约做单测。
    const escalationHandler = createEscalationHandler({ readConfig, log, lifetime });
    // 默认 append（与 llm-retry 的注册方式一致）：llm-retry 是外层，预算未尽的失败
    // 由它直接处理并不调用 next()；只有它放弃（调用 next()）时才轮到本监听器兜底。
    // 绝不能 prepend：那会抢在 compaction 的 context-overflow/image-offload 修复之前。
    yield ctx.on('agent/request-error', escalationHandler);

    // 3) profile 配置重载（含设置页写入）后重新补齐缺失字段。
    yield ctx.on('app-boot/config-reload', () => {
      requestReconcile('config-reload');
    });

    // 4) Loader 稳定后再补齐：此时 llm-pi-ai 等条目已激活，describe 才能看到。
    const loader = ctx.root?.loader;
    if (loader !== undefined && typeof loader.await === 'function') {
      loader.await().then(
        () => requestReconcile('activation'),
        (error) => {
          log('warn', `等待 Loader 稳定失败，仍尝试补齐默认策略：${error instanceof Error ? error.message : String(error)}`);
          requestReconcile('activation-fallback');
        },
      );
    } else {
      requestReconcile('activation');
    }

    yield async () => {
      closed = true;
      lifetime.abort(new Error('dsh-llm-resilience disposed'));
      await escalationHandler.drain();
    };
  }, 'dsh-llm-resilience lifecycle');
}
