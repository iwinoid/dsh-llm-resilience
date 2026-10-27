import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTimerDelayMs,
  classifyFailure,
  DEFAULT_ESCALATED_RETRIES,
  DEFAULT_ESCALATION_DELAY_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_JITTER_RATIO,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRYABLE_CODES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  ESCALATION_RETRYABLE_CODES,
  escalationDecision,
  escalationGaveUpNotice,
  escalationRetryNotice,
  normalizeConfig,
  normalizeFailure,
  normalizeRetryPolicy,
  providerPolicyOps,
  readField,
  resolveEffectivePolicy,
  seedProviderIdleTimeoutOps,
  toProviderRetryPolicy,
} from '../lib/policy.js';

/** 一份合法的默认重试策略（已归一化）。 */
const retry = normalizeRetryPolicy({});

test('配置校验：非法字段抛错，不会静默降级', () => {
  assert.throws(() => normalizeConfig({ defaultStreamIdleTimeoutMs: 0 }), /defaultStreamIdleTimeoutMs/);
  assert.throws(() => normalizeConfig({ defaultStreamIdleTimeoutMs: 1.5 }), /正整数/);
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /enabled/);
  assert.throws(() => normalizeConfig({ providerNamespaces: [] }), /providerNamespaces/);
  assert.throws(() => normalizeConfig({ defaultRetry: { maxRetries: -1 } }), /maxRetries/);
  assert.throws(() => normalizeConfig({ defaultRetry: { retryableCodes: [] } }), /retryableCodes/);
  assert.throws(
    () => normalizeConfig({ defaultRetry: { retryableCodes: ['TIMEOUT', 'TIMEOUT'] } }),
    /重复/,
  );
  assert.throws(
    () => normalizeConfig({ defaultRetry: { backoff: { initialDelayMs: 5000, maxDelayMs: 100 } } }),
    /initialDelayMs/,
  );
  assert.throws(
    () => normalizeConfig({ defaultRetry: { backoff: { jitterRatio: 1.5 } } }),
    /jitterRatio/,
  );
  assert.throws(() => assertTimerDelayMs('x', Number.MAX_SAFE_INTEGER), /不能大于/);
  // 合法边界值可以接受。
  assert.equal(normalizeConfig({ defaultRetry: { maxRetries: 0 } }).defaultRetry.maxRetries, 0);
  assert.equal(normalizeRetryPolicy({ backoff: { jitterRatio: 0 } }).backoff.jitterRatio, 0);
  assert.throws(() => normalizeConfig({ escalatedRetries: -1 }), /escalatedRetries/);
  assert.throws(() => normalizeConfig({ escalationDelayMs: 0 }), /escalationDelayMs/);
  assert.equal(normalizeConfig({ escalatedRetries: 0 }).escalatedRetries, 0);
});

test('Volatile 引用解包：readField 递归读取 get()', () => {
  const ref = { get: () => ({ get: () => 42 }) };
  assert.equal(readField(ref), 42);
  const config = normalizeConfig({
    enabled: { get: () => false },
    defaultStreamIdleTimeoutMs: { get: () => 1234 },
  });
  assert.equal(config.enabled, false);
  assert.equal(config.defaultStreamIdleTimeoutMs, 1234);
});

test('按提供商路由解析有效超时与重试策略', () => {
  const config = normalizeConfig({
    defaultStreamIdleTimeoutMs: 30000,
    defaultRetry: { maxRetries: 2 },
  });
  const fallback = resolveEffectivePolicy(config, 'opencode-go');
  assert.equal(fallback.route, 'opencode-go');
  assert.equal(fallback.streamIdleTimeoutMs, 30000);
  assert.equal(fallback.retry.maxRetries, 2);

  const overrides = {
    'opencode-go': { streamIdleTimeoutMs: 45000, retry: { maxRetries: 5 } },
    'deepseek-account': { streamIdleTimeoutMs: 12000 },
  };
  const overridden = resolveEffectivePolicy(config, 'opencode-go', overrides);
  assert.equal(overridden.streamIdleTimeoutMs, 45000);
  assert.equal(overridden.retry.maxRetries, 5);
  // 未覆盖路由仍回落默认值。
  const other = resolveEffectivePolicy(config, 'deepseek-account', overrides);
  assert.equal(other.streamIdleTimeoutMs, 12000);
  assert.equal(other.retry.maxRetries, 2);
  // 非法覆盖值必须抛错，绝不能静默沿用。
  assert.throws(
    () => resolveEffectivePolicy(config, 'opencode-go', { 'opencode-go': { streamIdleTimeoutMs: -1 } }),
    /providers\.opencode-go\.streamIdleTimeoutMs/,
  );
});

test('失败分类：覆盖每个已知失败码', () => {
  /** 期望值：失败码 → [类别, 是否默认可重试]。 */
  const expected = {
    TRANSPORT: ['transport', true],
    TIMEOUT: ['timeout', true],
    SERVER: ['server', true],
    RATE_LIMIT: ['rate-limit', true],
    EMPTY_RESPONSE: ['empty-response', true],
    ABORTED: ['aborted', false],
    AUTH: ['auth', false],
    INVALID_CREDENTIAL: ['credential', false],
    MISSING_CREDENTIAL: ['credential', false],
    QUOTA: ['quota', false],
    ACCOUNT_QUOTA: ['quota', false],
    CONTEXT_WINDOW_EXCEEDED: ['context-window', false],
    UNKNOWN_MODEL: ['model', false],
    NO_ADAPTER: ['routing', false],
    UNSUPPORTED_OPTION: ['request', false],
    IMAGE_OFFLOAD_REQUIRED: ['request', false],
    IMAGE_INPUT_UNSUPPORTED: ['request', false],
    UNRECOGNIZED: ['unknown', false],
  };
  for (const [code, [category, retryable]] of Object.entries(expected)) {
    const classified = classifyFailure({ code, message: `boom ${code}` });
    assert.equal(classified.code, code);
    assert.equal(classified.category, category, `${code} 类别`);
    assert.equal(classified.retryable, retryable, `${code} 默认可重试性`);
    assert.ok(classified.labelZh.length > 0, `${code} 中文标签`);
    assert.ok(classified.labelEn.length > 0, `${code} 英文标签`);
  }
});

test('失败分类：HTTP 状态推断与任意抛出值', () => {
  assert.equal(classifyFailure({ code: 'MYSTERY', message: 'x', status: 503 }).category, 'server');
  assert.equal(classifyFailure({ code: 'MYSTERY', message: 'x', status: 429 }).category, 'rate-limit');
  assert.equal(classifyFailure({ code: 'MYSTERY', message: 'x', status: 408 }).category, 'timeout');
  assert.equal(classifyFailure({ code: 'MYSTERY', message: 'x', status: 401 }).category, 'auth');
  assert.equal(classifyFailure({ code: 'MYSTERY', message: 'x', status: 418 }).category, 'unknown');
  assert.equal(classifyFailure(new Error('socket hang up')).code, 'UNRECOGNIZED');
  assert.equal(normalizeFailure(new Error('socket hang up')).message, 'socket hang up');
  assert.deepEqual(normalizeFailure({ code: 'TIMEOUT', message: 't', status: 408 }), {
    code: 'TIMEOUT',
    message: 't',
    status: 408,
  });
  assert.deepEqual(normalizeFailure('plain text'), { code: 'UNRECOGNIZED', message: 'plain text' });
});

test('provider 策略写入操作：路径与值符合 llm-pi-ai 配置', () => {
  const effective = resolveEffectivePolicy(normalizeConfig({}), 'opencode-go');
  const ops = providerPolicyOps('opencode-go', effective);
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0], {
    op: 'set',
    path: ['providers', 'opencode-go', 'streamIdleTimeoutMs'],
    value: 30000,
  });
  assert.deepEqual(ops[1].path, ['providers', 'opencode-go', 'retryPolicy']);
  assert.deepEqual(ops[1].value, {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: [...DEFAULT_RETRYABLE_CODES],
    backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
  });
  assert.deepEqual(toProviderRetryPolicy(retry), ops[1].value);
});

test('启动补齐策略：只补 streamIdleTimeoutMs，不写 retryPolicy，不覆盖用户值', () => {
  const effective = resolveEffectivePolicy(normalizeConfig({}), 'opencode-go');
  const empty = seedProviderIdleTimeoutOps(undefined, effective);
  assert.equal(empty.length, 1);
  assert.deepEqual(empty[0], {
    op: 'set',
    path: ['streamIdleTimeoutMs'],
    value: 30000,
  });
  // 用户层已有超时值：一行都不写（启动期不覆盖用户配置）。
  const existing = seedProviderIdleTimeoutOps({ streamIdleTimeoutMs: 60000 }, effective);
  assert.equal(existing.length, 0);
  // 用户只写了 retryPolicy：仍然只补超时，绝不碰 retryPolicy
  // （避免 adapter 原子重注册造成的 reload 抖动）。
  const retryOnly = seedProviderIdleTimeoutOps(
    { retryPolicy: { mode: 'normal', maxRetries: 2 } },
    effective,
  );
  assert.equal(retryOnly.length, 1);
  assert.deepEqual(retryOnly[0].path, ['streamIdleTimeoutMs']);
});

test('升级续重试决策：可升级、关闭、预算耗尽与不可重试码', () => {
  const config = normalizeConfig({ escalatedRetries: 2, escalationDelayMs: 5000 });
  assert.deepEqual(ESCALATION_RETRYABLE_CODES, ['TRANSPORT', 'SERVER', 'TIMEOUT', 'RATE_LIMIT', 'EMPTY_RESPONSE']);
  const first = escalationDecision({ failure: { code: 'TIMEOUT', message: 't' }, escalatedCount: 0, config });
  assert.equal(first.kind, 'escalate');
  assert.equal(first.escalatedCount, 1);
  assert.equal(first.delayMs, 5000);
  const second = escalationDecision({ failure: { code: 'TRANSPORT', message: 't' }, escalatedCount: 1, config });
  assert.equal(second.kind, 'escalate');
  assert.equal(second.escalatedCount, 2);
  const exhausted = escalationDecision({ failure: { code: 'SERVER', message: 's' }, escalatedCount: 2, config });
  assert.equal(exhausted.kind, 'stop');
  assert.equal(exhausted.reason, 'budget-exhausted');
  // 关闭升级（escalatedRetries=0）与非法码。
  assert.equal(escalationDecision({ failure: { code: 'TIMEOUT', message: 't' }, escalatedCount: 0, config: normalizeConfig({ escalatedRetries: 0 }) }).reason, 'escalation-disabled');
  assert.equal(escalationDecision({ failure: { code: 'AUTH', message: 'a' }, escalatedCount: 0, config }).reason, 'not-retryable');
  assert.equal(escalationDecision({ failure: { code: 'TIMEOUT', message: 't' }, escalatedCount: 0, config, aborted: true }).reason, 'aborted');
  // 提示文案本身。
  const notice = escalationRetryNotice({ provider: 'opencode-go', failure: { code: 'TIMEOUT', message: 'x' }, attempt: 2, maxRetries: 2 });
  assert.equal(notice.zh, '提供商 opencode-go 请求失败（TIMEOUT），同路由第 2/2 次续重试');
  assert.match(escalationGaveUpNotice({ provider: 'opencode-go', failure: { code: 'SERVER', message: 'x' }, escalatedRetries: 2 }).zh, /设置 → LLM 韧性/);
});

