import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { createEscalationHandler } from '../lib/escalation.js';
import { normalizeConfig } from '../lib/policy.js';

/**
 * 真实 Cordis 的 waterfall 顺序测试。
 *
 * 依赖本机安装的 DSH 自带 @deepseek-ai/cordis（只读使用）；找不到时整组 skip。
 * 目的：锁死「llm-retry 先注册（外层）→ 预算未尽时它直接 return retry 且不调
 * next()，我们的监听器不被调用；它放弃时才调用 next() 轮到我们兜底」这一假设。
 */
const CORDIS_ENTRY = process.env.DSH_CORDIS_ENTRY ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
const cordisAvailable = existsSync(CORDIS_ENTRY);
const skip = cordisAvailable ? false : 'installed @deepseek-ai/cordis not found';

/** 动态加载真实 Cordis。 */
async function loadContext() {
  const module = await import(CORDIS_ENTRY);
  return module.Context;
}

/**
 * 搭一个最小真实-Cordis 场景：第一个监听器模拟 llm-retry 的外层位置，
 * 第二个监听器是我们真实的 escalation handler。
 */
async function makeScenario({ config = {}, outerBehaviour = 'give-up' } = {}) {
  const Context = await loadContext();
  const ctx = new Context();
  const events = [];
  const sleeps = [];
  const logs = [];
  let oursCalled = 0;
  const lifetime = new AbortController();
  const handler = createEscalationHandler({
    readConfig: () => normalizeConfig(config),
    log: (level, message) => logs.push({ level, message }),
    lifetime,
    sleep: (delayMs) => { sleeps.push(delayMs); return Promise.resolve(true); },
    retryId: () => 'retry-id-real-cordis',
  });
  const session = { append: (type, data) => events.push({ type, data }) };
  const payload = {
    agent: { id: 'agent-1', session },
    turn: 1,
    step: 1,
    provider: 'opencode-go',
    failure: { code: 'TIMEOUT', message: 'pi-ai stream idle timeout after 30000ms' },
    retryPolicy: { mode: 'normal', maxRetries: 5, retryableCodes: ['TIMEOUT'], backoff: {} },
    signal: new AbortController().signal,
  };

  ctx.on('agent/request-error', async (_payload, next) => {
    if (outerBehaviour === 'handle') return { kind: 'retry' };
    // 模拟 llm-retry 预算耗尽/不可重试：return next()。
    return next();
  });
  ctx.on('agent/request-error', async (innerPayload, next) => {
    oursCalled += 1;
    return handler(innerPayload, next);
  });
  const dispatch = () => ctx.waterfall('agent/request-error', payload, () => Promise.resolve(undefined));
  return { ctx, events, sleeps, logs, handler, dispatch, oursCalled: () => oursCalled, payload };
}

test('真实 Cordis：基础策略直接 retry 时不会调用我们的监听器', { skip }, async () => {
  const scenario = await makeScenario({ outerBehaviour: 'handle' });
  const result = await scenario.dispatch();
  assert.deepEqual(result, { kind: 'retry' });
  assert.equal(scenario.oursCalled(), 0);
  assert.equal(scenario.events.length, 0);
});

test('真实 Cordis：基础策略放弃（return next()）时轮到我们续重试', { skip }, async () => {
  const scenario = await makeScenario({ config: { escalatedRetries: 2, escalationDelayMs: 5000 } });
  const result = await scenario.dispatch();
  assert.deepEqual(result, { kind: 'retry' });
  assert.equal(scenario.oursCalled(), 1);
  assert.equal(scenario.sleeps.length, 1);
  assert.equal(scenario.sleeps[0], 5000);
  assert.deepEqual(scenario.events.map(event => event.type), ['llm/retry', 'llm/retry-started']);
  assert.equal(scenario.events[0].data.policyKey, 'llm-resilience:escalation');
  assert.equal(scenario.events[0].data.retry, 1);
  assert.equal(scenario.events[0].data.maxRetries, 2);

  // 第二次：仍由我们续重试，retry 递增且沿同一 retryId。
  await scenario.dispatch();
  assert.equal(scenario.events[2].data.retry, 2);
  assert.equal(scenario.events[2].data.retryId, scenario.events[0].data.retryId);
});

test('真实 Cordis：升级预算耗尽后返回 undefined（循环抛原始 LlmError）', { skip }, async () => {
  const scenario = await makeScenario({ config: { escalatedRetries: 1, escalationDelayMs: 1 } });
  assert.deepEqual(await scenario.dispatch(), { kind: 'retry' });
  assert.equal(await scenario.dispatch(), undefined);
  assert.equal(scenario.sleeps.length, 1, '预算耗尽后不再等待');
  assert.ok(scenario.logs.some(entry => entry.level === 'warn' && entry.message.includes('已放弃')));
});

test('真实 Cordis：abort 后不续重试也不等待', { skip }, async () => {
  const Context = await loadContext();
  const ctx = new Context();
  const aborted = new AbortController();
  aborted.abort();
  const handler = createEscalationHandler({
    readConfig: () => normalizeConfig({ escalatedRetries: 2 }),
    log: () => {},
    lifetime: new AbortController(),
    sleep: () => { throw new Error('不应等待'); },
  });
  ctx.on('agent/request-error', async (_payload, next) => next());
  ctx.on('agent/request-error', async (payload, next) => handler(payload, next));
  const result = await ctx.waterfall('agent/request-error', {
    agent: { id: 'agent-1', session: { append: () => {} } },
    turn: 1,
    step: 1,
    provider: 'opencode-go',
    failure: { code: 'TIMEOUT', message: 'x' },
    retryPolicy: { mode: 'normal', maxRetries: 5 },
    signal: aborted.signal,
  }, () => Promise.resolve(undefined));
  assert.equal(result, undefined);
});
