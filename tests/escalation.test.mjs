import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ESCALATION_POLICY_KEY, createEscalationHandler, sleepCancellable } from '../lib/escalation.js';
import { normalizeConfig } from '../lib/policy.js';

/**
 * 最小 fake 契约：模拟 DSH agent/request-error waterfall 的 payload 与 next()，
 * 不启动真 Host。payload 字段与上游事件签名一致：
 * { agent, turn, step, provider, failure, retryPolicy, signal }；
 * agent.session.append 收集 durable 事件，用于断言复用原生 llm/retry 事件。
 */
function makeHarness({
  config = {},
  downstream = async () => undefined,
  sleepResult = true,
  appendFails = false,
} = {}) {
  const logs = [];
  const sleeps = [];
  const events = [];
  const lifetime = new AbortController();
  const currentConfig = { value: normalizeConfig(config) };
  const sleep = (delayMs, signal) => {
    const result = typeof sleepResult === 'function' ? sleepResult(delayMs, signal) : sleepResult;
    sleeps.push({ delayMs, signal, result });
    return Promise.resolve(result);
  };
  const handler = createEscalationHandler({
    readConfig: () => currentConfig.value,
    log: (level, message) => logs.push({ level, message }),
    lifetime,
    sleep,
    retryId: () => 'retry-id-1',
  });
  const payloadOf = ({
    turn = 1,
    step = 1,
    provider = 'opencode-go',
    failure = { code: 'TIMEOUT', message: '流空闲超时' },
    signal,
    retryPolicy = undefined,
    agentId = 'agent-1',
  } = {}) => ({
    agent: {
      id: agentId,
      session: {
        append: (type, data) => {
          if (appendFails) throw new Error('llm/retry is not a known session event');
          events.push({ type, data });
        },
      },
    },
    turn,
    step,
    provider,
    failure,
    retryPolicy,
    signal: signal ?? new AbortController().signal,
  });
  const run = (payload, next = () => downstream(payload)) => handler(payload, next);
  return { handler, logs, sleeps, events, lifetime, currentConfig, payloadOf, run };
}

test('升级监听器：next() 返回 retry 时原样透传，不叠加、不写事件、不延时', async () => {
  const harness = makeHarness();
  const retryDecision = { kind: 'retry' };
  const result = await harness.run(harness.payloadOf(), async () => retryDecision);
  assert.equal(result, retryDecision);
  assert.equal(harness.sleeps.length, 0);
  assert.equal(harness.events.length, 0);
  assert.equal(harness.handler.state.count, 0);
  assert.ok(harness.logs.some(entry => entry.message.includes('内层恢复策略已安排重试')));
});

test('升级监听器：next() 为 undefined 时复用原生 llm/retry 事件并返回 retry', async () => {
  const harness = makeHarness({ config: { escalatedRetries: 2, escalationDelayMs: 5000 } });
  const payload = harness.payloadOf();
  const result = await harness.run(payload);
  assert.deepEqual(result, { kind: 'retry' });

  // 先 append llm/retry（独立 policyKey、retry 从 1 起、同一 retryId）。
  assert.equal(harness.events.length, 2);
  const [scheduled, started] = harness.events;
  assert.equal(scheduled.type, 'llm/retry');
  assert.deepEqual(scheduled.data, {
    retryId: 'retry-id-1',
    turn: 1,
    step: 1,
    provider: 'opencode-go',
    mode: 'normal',
    policyKey: ESCALATION_POLICY_KEY,
    retry: 1,
    maxRetries: 2,
    delayMs: 5000,
    failure: { code: 'TIMEOUT', message: '流空闲超时' },
  });
  assert.equal(started.type, 'llm/retry-started');
  assert.deepEqual(started.data, { retryId: 'retry-id-1', turn: 1, step: 1, retry: 1 });

  assert.equal(harness.sleeps.length, 1);
  assert.equal(harness.sleeps[0].delayMs, 5000);
  assert.equal(harness.handler.state.count, 1);
  assert.ok(harness.logs.some(entry => entry.message.includes('同路由第 1/2 次续重试')));

  // 第二次续重试沿用同一 retryId，retry 递增，UI 会连成同一条重试链。
  await harness.run(payload);
  assert.equal(harness.events.length, 4);
  assert.equal(harness.events[2].type, 'llm/retry');
  assert.equal(harness.events[2].data.retry, 2);
  assert.equal(harness.events[2].data.retryId, 'retry-id-1');
  assert.equal(harness.events[3].type, 'llm/retry-started');
  assert.equal(harness.events[3].data.retry, 2);
});

test('升级监听器：预算耗尽后 return undefined 并记录放弃通知', async () => {
  const harness = makeHarness({ config: { escalatedRetries: 2 } });
  const payload = harness.payloadOf();
  await harness.run(payload);
  await harness.run(payload);
  const third = await harness.run(payload);
  assert.equal(third, undefined, '终局必须返回 undefined，让循环抛原始 LlmError');
  assert.equal(harness.sleeps.length, 2, '预算耗尽后不得再等待');
  assert.equal(harness.handler.state.count, 2);
  assert.equal(harness.events.length, 4);
  assert.ok(harness.logs.some(entry => entry.level === 'warn' && entry.message.includes('已放弃')));
  assert.ok(harness.logs.some(entry => entry.message.includes('设置 → LLM 韧性')));
});

test('升级监听器：会话事件不可用时退化为仅日志，续重试仍进行', async () => {
  const harness = makeHarness({ config: { escalatedRetries: 1 }, appendFails: true });
  const result = await harness.run(harness.payloadOf());
  assert.deepEqual(result, { kind: 'retry' });
  assert.equal(harness.events.length, 0);
  assert.ok(harness.logs.some(entry => entry.level === 'warn' && entry.message.includes('仅日志可见')));
  assert.ok(harness.logs.some(entry => entry.message.includes('同路由第 1/1 次续重试')));
});

test('升级监听器：step 变化清零升级计数，agent 变化互不影响', async () => {
  const harness = makeHarness({ config: { escalatedRetries: 2 } });
  await harness.run(harness.payloadOf({ turn: 1, step: 1 }));
  await harness.run(harness.payloadOf({ turn: 1, step: 1 }));
  assert.equal(harness.handler.state.count, 2);
  const nextStep = await harness.run(harness.payloadOf({ turn: 1, step: 2 }));
  assert.deepEqual(nextStep, { kind: 'retry' });
  assert.equal(harness.handler.state.count, 1);
  // 另一个 agent 使用独立状态。
  const otherAgent = await harness.run(harness.payloadOf({ turn: 1, step: 2, agentId: 'agent-2' }));
  assert.deepEqual(otherAgent, { kind: 'retry' });
  assert.equal(harness.handler.state.count, 1);
  assert.match(harness.handler.state.key, /^agent-2:/);
});

test('升级监听器：always 基础策略/关闭开关/不可重试码/abort 时绝不续重试', async () => {
  // 基础策略是 always：无上限重试，不再叠加。
  const always = makeHarness();
  assert.equal(
    await always.run(always.payloadOf({ retryPolicy: { mode: 'always' } })),
    undefined,
  );
  assert.equal(always.sleeps.length, 0);
  assert.equal(always.events.length, 0);

  // escalatedRetries=0 关闭升级。
  const disabled = makeHarness({ config: { escalatedRetries: 0 } });
  assert.equal(await disabled.run(disabled.payloadOf()), undefined);
  assert.equal(disabled.sleeps.length, 0);

  // 插件整体禁用。
  const pluginOff = makeHarness({ config: { enabled: false } });
  assert.equal(await pluginOff.run(pluginOff.payloadOf()), undefined);
  assert.equal(pluginOff.sleeps.length, 0);

  // 不可重试失败码（AUTH）不进入升级。
  const auth = makeHarness();
  assert.equal(await auth.run(auth.payloadOf({ failure: { code: 'AUTH', message: 'bad key' } })), undefined);
  assert.equal(auth.sleeps.length, 0);

  // signal 已 abort：不等待、不重试、不写事件。
  const aborted = new AbortController();
  aborted.abort();
  const abortedHarness = makeHarness();
  assert.equal(await abortedHarness.run(abortedHarness.payloadOf({ signal: aborted.signal })), undefined);
  assert.equal(abortedHarness.sleeps.length, 0);
  assert.equal(abortedHarness.events.length, 0);
});

test('升级监听器：等待期间 abort 立即取消，不返回 retry、不写 started 事件', async () => {
  const lifetime = new AbortController();
  const events = [];
  const logs = [];
  const handler = createEscalationHandler({
    readConfig: () => normalizeConfig({ escalatedRetries: 2, escalationDelayMs: 10000 }),
    log: (level, message) => logs.push({ level, message }),
    lifetime,
    sleep: sleepCancellable,
    retryId: () => 'retry-id-2',
  });
  const payload = {
    agent: { id: 'agent-1', session: { append: (type, data) => events.push({ type, data }) } },
    turn: 1,
    step: 1,
    provider: 'opencode-go',
    failure: { code: 'TIMEOUT', message: '流空闲超时' },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  };
  const pending = handler(payload, async () => undefined);
  await new Promise(resolve => setTimeout(resolve, 10));
  lifetime.abort(new Error('disposed'));
  const result = await pending;
  assert.equal(result, undefined, 'abort 后不得返回 retry');
  assert.equal(handler.state.count, 0, '取消的等待不计入升级预算');
  assert.equal(events.filter(event => event.type === 'llm/retry-started').length, 0);
  await handler.drain();
});

test('升级监听器：下游抛错时原样抛出，不吞错', async () => {
  const harness = makeHarness();
  const boom = new Error('downstream exploded');
  await assert.rejects(harness.run(harness.payloadOf(), async () => { throw boom; }), error => error === boom);
  assert.equal(harness.sleeps.length, 0);
});

test('升级监听器：配置非法时保持 next() 决定（默认失败处理）', async () => {
  const logs = [];
  const handler = createEscalationHandler({
    readConfig: () => undefined,
    log: (level, message) => logs.push({ level, message }),
    lifetime: new AbortController(),
    sleep: async () => true,
  });
  const result = await handler({
    agent: { id: 'agent-1' },
    turn: 1,
    step: 1,
    provider: 'opencode-go',
    failure: { code: 'TIMEOUT', message: 'x' },
    signal: new AbortController().signal,
  }, async () => undefined);
  assert.equal(result, undefined);
  assert.equal(logs.length, 0, '配置非法读取失败时只保持默认处理，不产生升级日志');
});

test('可取消延时：到点返回 true，abort 立即返回 false 且无残留定时器', async () => {
  assert.equal(await sleepCancellable(1, new AbortController().signal), true);

  const preAborted = new AbortController();
  preAborted.abort();
  assert.equal(await sleepCancellable(10000, preAborted.signal), false);

  const controller = new AbortController();
  const started = Date.now();
  const pending = sleepCancellable(10000, controller.signal);
  setTimeout(() => controller.abort(), 10);
  const elapsed = await pending;
  assert.equal(elapsed, false);
  assert.ok(Date.now() - started < 5000, 'abort 必须立即结算而不是等满 10 秒');
});
