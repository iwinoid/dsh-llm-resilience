import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { normalizeConfig, providerPolicyOps, resolveEffectivePolicy, toProviderRetryPolicy } from '../lib/policy.js';

/**
 * 用本机安装的 llm-pi-ai Config schema 校验我们生成的设置写入形状：
 * 值合法、路径落在 volatile 子树内、并且上游默认值未被无意改变。
 * 找不到安装包时整组 skip。
 */
const PI_AI_ENTRY = process.env.DSH_PI_AI_ENTRY ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js';
const available = existsSync(PI_AI_ENTRY);
const skip = available ? false : 'installed @deepseek-ai/dsh-llm-pi-ai not found';

/** 动态加载 llm-pi-ai 的 Config。 */
async function loadConfigSchema() {
  const module = await import(PI_AI_ENTRY);
  assert.equal(typeof module.Config, 'function', 'llm-pi-ai 导出 Config schema');
  return module.Config;
}

/** 把路径操作应用到（深拷贝后的）provider 对象上。 */
function applyOps(base, ops) {
  const next = JSON.parse(JSON.stringify(base));
  for (const op of ops) {
    assert.equal(op.op, 'set');
    let cursor = next;
    for (const key of op.path.slice(0, -1)) {
      if (cursor[key] === undefined) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[op.path.at(-1)] = op.value;
  }
  return next;
}

test('写入形状：providerPolicyOps 的结果能被安装版 llm-pi-ai Config 接受', { skip }, async () => {
  const Config = await loadConfigSchema();
  const effective = resolveEffectivePolicy(normalizeConfig({}), 'opencode-go');
  const ops = providerPolicyOps('opencode-go', effective);
  const candidate = applyOps({ providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_API_KEY' } } }, ops);
  const resolved = Config(candidate);
  const profile = resolved.providers.get()['opencode-go'];
  assert.equal(profile.streamIdleTimeoutMs, 30000);
  assert.equal(profile.apiKeyEnv, 'OPENCODE_API_KEY', '写入不丢失其它 provider 字段');
});

test('写入形状：retryPolicy 是上游 schema 接受的 normal 策略', { skip }, async () => {
  const Config = await loadConfigSchema();
  const policy = toProviderRetryPolicy(normalizeConfig({}).defaultRetry);
  const resolved = Config({
    providers: {
      'opencode-go': {
        streamIdleTimeoutMs: 30000,
        retryPolicy: policy,
      },
    },
  });
  const profile = resolved.providers.get()['opencode-go'];
  assert.equal(profile.retryPolicy.mode, 'normal');
  assert.equal(profile.retryPolicy.maxRetries, 5);
  assert.equal(profile.retryPolicy.backoff.initialDelayMs, 500);
  assert.equal(profile.retryPolicy.backoff.maxDelayMs, 10000);
  assert.equal(profile.retryPolicy.backoff.jitterRatio, 0.1);
});

test('写入形状：非法值会被安装版 schema 拒绝（不会落盘坏值）', { skip }, async () => {
  const Config = await loadConfigSchema();
  assert.throws(() => Config({ providers: { 'opencode-go': { streamIdleTimeoutMs: 0 } } }), /streamIdleTimeoutMs/);
  assert.throws(() => Config({ providers: { 'opencode-go': { streamIdleTimeoutMs: -5 } } }), /streamIdleTimeoutMs/);
  assert.throws(
    () => Config({ providers: { 'opencode-go': { retryPolicy: { maxRetries: 3 } } } }),
    /retryPolicy|mode/,
  );
  // 空 retryableCodes 由引擎侧 normalizeRetryPolicy 拒绝（schema 层允许，
  // 上游 resolveRetryPolicy 在注册时拒绝），页面写入前已校验。
});

test('volatile 路径：providers 子树是 volatile，settings.mutate 才允许写入', { skip }, async () => {
  const Config = await loadConfigSchema();
  const providers = Config.dict.providers;
  assert.equal(providers.type, 'dict');
  assert.equal(providers.meta?.volatile, true, 'providers 字段标了 volatile');
  // 我们只写这三个白名单字段，且都位于 volatile 的 providers 子树内。
  const profile = providers.inner.dict;
  for (const field of ['streamIdleTimeoutMs', 'retryPolicy', 'timeoutMs']) {
    assert.ok(profile[field] !== undefined, `schema 中存在 ${field}`);
  }
  // 不能写入的字段（绝不触碰）：provider/model 选择不在 pi-ai provider 配置里，
  // 但凭据/端点等字段必须保持只读策略。
  for (const forbidden of ['apiKeyEnv', 'baseURL', 'api']) {
    assert.ok(profile[forbidden] !== undefined, `${forbidden} 存在但本插件不写`);
  }
});

test('上游默认值：未被设置时 streamIdleTimeoutMs 仍是 300000，只有显式写入才变 30000', { skip }, async () => {
  const Config = await loadConfigSchema();
  const untouched = Config({ providers: { 'opencode-go': {} } });
  assert.equal(untouched.providers.get()['opencode-go'].streamIdleTimeoutMs, 300000);
  const written = Config({ providers: { 'opencode-go': { streamIdleTimeoutMs: 30000 } } });
  assert.equal(written.providers.get()['opencode-go'].streamIdleTimeoutMs, 30000);
});
