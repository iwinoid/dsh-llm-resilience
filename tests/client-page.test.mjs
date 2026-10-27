import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 动态客户端模块的无浏览器冒烟测试。
 *
 * 用最小 React/ctx 替身加载 lib/client.js，验证：
 *  - ModuleLoader 模块 id 与包名一致，factory 返回 { inject, apply }；
 *  - apply 注册 plugins.row.config，key 为 `<packageName>#<rowId>`；
 *  - summary 与 page 两种 view 在「设置已就绪 + llm-pi-ai 就绪」下能完成
 *    React 渲染且输出包含预期文案；llm-pi-ai 不可用时 page 显示提示而不崩溃。
 * 它不能替代真实浏览器验证，但能在无浏览器环境抓到渲染期崩溃/契约写错。
 */

/** 最小 React 替身：只实现本插件用到的 API。 */
function createReactStub() {
  let hookIndex = 0;
  const hooks = [];
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && typeof child !== 'boolean') };
    },
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex++;
      if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
    },
    useCallback(fn) { return fn; },
    useEffect() {},
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); },
    // 测试渲染前重置 hook 槽位，模拟一次全新 mount。
    __reset() { hookIndex = 0; hooks.length = 0; },
  };
}

/**
 * 递归执行函数组件并收集渲染出的文本。
 * 测试替身没有 React 调度器，因此这里手动调用函数组件；hook 替身按调用顺序返回。
 */
function renderText(node) {
  const out = [];
  const walk = (current) => {
    if (current === null || current === undefined || typeof current === 'boolean') return;
    if (typeof current === 'string' || typeof current === 'number') { out.push(String(current)); return; }
    if (Array.isArray(current)) { for (const child of current) walk(child); return; }
    if (typeof current === 'object') {
      if (typeof current.type === 'function') { walk(current.type(current.props)); return; }
      const children = Array.isArray(current.children) ? current.children : [];
      for (const child of children) walk(child);
    }
  };
  walk(node);
  return out.join(' ');
}

/** 首次 import 时捕获的 ModuleLoader 模块定义（ESM 每进程只执行一次）。 */
let cachedDefinition;

/** 用真实 client.js 的模块定义搭出 apply 环境；每个测试重新调用 factory。 */
async function loadClientModule() {
  if (cachedDefinition === undefined) {
    globalThis.window = {
      __ModuleLoader__: {
        load(candidate) { cachedDefinition = candidate; },
      },
    };
    await import('../lib/client.js');
  }
  const definition = cachedDefinition;
  assert.equal(definition?.id, 'dsh-llm-resilience');
  const ReactStub = createReactStub();
  const exports = definition.factory((specifier) => {
    assert.equal(specifier, 'react');
    return ReactStub;
  });
  return { definition, exports, ReactStub };
}

/** 构造 llm-pi-ai 的 ConfigForm 替身。 */
function piFormStub({ ready = true } = {}) {
  const snapshot = ready
    ? {
      status: 'ready',
      writable: true,
      revision: 7,
      value: {
        providers: {
          'opencode-go': {
            streamIdleTimeoutMs: 30000,
            retryPolicy: {
              mode: 'normal',
              maxRetries: 5,
              retryableCodes: ['TIMEOUT', 'TRANSPORT'],
              backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
            },
          },
        },
      },
      user: { providers: { 'opencode-go': { streamIdleTimeoutMs: 30000 } } },
    }
    : { status: 'unavailable', writable: false, revision: undefined, value: undefined, user: undefined };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => true,
  };
}

/** 构造 own ConfigForm 替身（owner props.form 的形态）。 */
function ownFormStub() {
  return {
    state: {
      status: 'ready',
      writable: true,
      revision: 3,
      value: {
        enabled: true,
        seedOnActivation: true,
        defaultStreamIdleTimeoutMs: 30000,
        escalatedRetries: 2,
        escalationDelayMs: 5000,
        defaultRetry: {
          maxRetries: 5,
          retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
          backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
        },
      },
      base: {},
      user: {},
    },
    mutate: async () => true,
  };
}

test('客户端模块：factory 契约与 row 配置页注册', async () => {
  const { definition, exports } = await loadClientModule();
  assert.equal(definition.id, 'dsh-llm-resilience');
  assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms']);
  assert.equal(typeof exports.apply, 'function');

  const dictionaries = {};
  const registrations = [];
  let servedCallback;
  const locale = {
    register(ns, dict) { dictionaries[ns] = dict; return () => {}; },
    bind(ns) {
      return (key) => {
        const dict = dictionaries[ns];
        assert.ok(dict !== undefined, `locale ${ns} registered before bind`);
        return dict.zh[key];
      };
    },
  };
  const ctx = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    locale,
    configForms: {
      get(ns) { assert.equal(ns, 'llm-pi-ai'); return piFormStub(); },
      whileServed(namespaces, register) { servedCallback = () => register(); return () => {}; },
    },
    slots: {
      inject(name, register) { assert.equal(name, 'plugins.row.config'); return register(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  };
  exports.apply(ctx);
  servedCallback();
  assert.equal(registrations.length, 1);
  const { options } = registrations[0];
  assert.equal(options.name, 'plugins.row.config');
  assert.equal(options.key, 'dsh-llm-resilience#llm-resilience');
  assert.equal(options.locale, 'settings.llm-resilience');
});

test('客户端页面：summary 正常渲染，page 含插件策略与 provider 行', async () => {
  const { exports, ReactStub } = await loadClientModule();
  const dictionaries = {};
  const registrations = [];
  const locale = {
    register(ns, dict) { dictionaries[ns] = dict; return () => {}; },
    bind(ns) { return (key) => dictionaries[ns].zh[key]; },
  };
  const ctx = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    locale,
    configForms: {
      get() { return piFormStub(); },
      whileServed(_namespaces, register) { register(); return () => {}; },
    },
    slots: {
      inject(_name, register) { return register(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  };
  exports.apply(ctx);
  const { component } = registrations[0];
  const form = ownFormStub();
  const llmPi = piFormStub();

  // summary：包含引擎默认值的摘要。
  ReactStub.__reset();
  const summary = component({ view: 'summary', form, llmPi, t: locale.bind('settings.llm-resilience') });
  const summaryText = renderText(summary);
  assert.match(summaryText, /空闲超时 30000ms/);
  assert.match(summaryText, /基础重试 5 次/);
  assert.match(summaryText, /升级续重试 2 次/);

  // page：包含两个区块与 provider 行。
  ReactStub.__reset();
  const page = component({ view: 'page', form, llmPi, t: locale.bind('settings.llm-resilience') });
  const pageText = renderText(page);
  assert.match(pageText, /本插件策略/);
  assert.match(pageText, /llm-pi-ai 提供商路由/);
  assert.match(pageText, /opencode-go/);
  assert.match(pageText, /应用推荐值到全部提供商/);
  assert.match(pageText, /保存/);
  // 白名单提示存在，页面不含其它 provider 字段的编辑项。
  assert.match(pageText, /只写白名单字段/);
  assert.match(pageText, /绝不修改 provider、model、reasoning、baseURL 或凭据/);

  // llm-pi-ai 不可用：page 仍能渲染并提示，不崩溃。
  ReactStub.__reset();
  const unavailable = component({
    view: 'page',
    form,
    llmPi: piFormStub({ ready: false }),
    t: locale.bind('settings.llm-resilience'),
  });
  const unavailableText = renderText(unavailable);
  assert.match(unavailableText, /llm-pi-ai 命名空间当前不可用/);
});

test('客户端页面：设置文档只读时显示只读提示且不写', async () => {
  const { exports, ReactStub } = await loadClientModule();
  const dictionaries = {};
  const registrations = [];
  const ctx = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    locale: {
      register(ns, dict) { dictionaries[ns] = dict; return () => {}; },
      bind(ns) { return (key) => dictionaries[ns].zh[key]; },
    },
    configForms: {
      get() { return piFormStub(); },
      whileServed(_namespaces, register) { register(); return () => {}; },
    },
    slots: {
      inject(_name, register) { return register(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  };
  exports.apply(ctx);
  const { component } = registrations[0];
  const form = ownFormStub();
  form.state.writable = false;
  ReactStub.__reset();
  const page = component({
    view: 'page', form, llmPi: piFormStub(), t: ctx.locale.bind('settings.llm-resilience'),
  });
  assert.match(renderText(page), /设置文档只读/);
});
