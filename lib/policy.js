/**
 * dsh-llm-resilience 纯策略引擎。
 *
 * 这个模块不 import 任何 DSH 包、不碰 ctx、不做 IO：Host 插件用它计算
 * 「有效超时/重试策略」，客户端设置页用它渲染默认值，`node --test` 直接跑。
 *
 * 术语：
 * - 提供商路由（provider route）：GenerateOptions.provider，例如 opencode-go。
 * - 失败（failure）：LlmFailure，{ code, message, status?, providerRetryAfterMs? }。
 * - 重试预算（retry budget）：一次失败后最多再尝试 maxRetries 次，全部同路由；
 *   预算用尽即 fail-fast，绝不切换 provider/model。
 */

/** Node 定时器允许的最大延迟（毫秒），与 DSH 的 MAX_TIMER_DELAY_MS 一致。 */
export const MAX_TIMER_DELAY_MS = 2147483647;

/** 默认流空闲超时：30 秒。DSH 上游 llm-pi-ai 的默认值是 300 秒。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30000;

/** 默认重试次数（首次请求之后的额外尝试次数）。与上游 dsh-llm-retry 的 provider 默认一致。 */
export const DEFAULT_MAX_RETRIES = 5;

/** 默认首次退避延迟（毫秒）。与上游 dsh-llm-retry 的 provider 默认一致。 */
export const DEFAULT_INITIAL_DELAY_MS = 500;

/** 默认单次退避延迟上限（毫秒）。与上游 dsh-llm-retry 的 provider 默认一致。 */
export const DEFAULT_MAX_DELAY_MS = 10000;

/** 默认抖动比例：0.1 表示每个延迟在 ±10% 区间内随机。与上游 dsh-llm-retry 的 provider 默认一致。 */
export const DEFAULT_JITTER_RATIO = 0.1;

/**
 * 升级（escalation）续重试的默认可重试失败码：基础预算耗尽后，本插件在这些
 * 失败码上再做有限次同路由续重试。
 */
export const ESCALATION_RETRYABLE_CODES = Object.freeze([
  'TRANSPORT',
  'SERVER',
  'TIMEOUT',
  'RATE_LIMIT',
  'EMPTY_RESPONSE',
]);

/** 默认升级续重试次数：基础预算（llm-retry）耗尽后额外再试 2 次。 */
export const DEFAULT_ESCALATED_RETRIES = 2;

/** 默认每次升级续重试前的等待（毫秒）。 */
export const DEFAULT_ESCALATION_DELAY_MS = 5000;

/**
 * 默认可重试的稳定失败码，与上游 dsh-llm 的默认集合一致：
 * EMPTY_RESPONSE（空响应）、RATE_LIMIT（限流）、SERVER（5xx）、
 * TIMEOUT（超时）、TRANSPORT（传输层失败）。
 */
export const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]);

/** 默认由本插件管理的设置命名空间（llm-pi-ai 的 provider 配置所在条目）。 */
export const DEFAULT_PROVIDER_NAMESPACES = Object.freeze(['llm-pi-ai']);

/**
 * 失败码 → 分类表。分类只用于展示与诊断；是否重试最终由策略的
 * retryableCodes 决定（与上游 dsh-llm-retry 的语义一致）。
 */
const FAILURE_TABLE = Object.freeze({
  TRANSPORT: { category: 'transport', retryable: true, labelZh: '网络传输失败', labelEn: 'transport failure' },
  TIMEOUT: { category: 'timeout', retryable: true, labelZh: '请求超时', labelEn: 'request timeout' },
  SERVER: { category: 'server', retryable: true, labelZh: '服务端错误', labelEn: 'server error' },
  RATE_LIMIT: { category: 'rate-limit', retryable: true, labelZh: '请求被限流', labelEn: 'rate limited' },
  EMPTY_RESPONSE: { category: 'empty-response', retryable: true, labelZh: '模型返回空响应', labelEn: 'empty model response' },
  ABORTED: { category: 'aborted', retryable: false, labelZh: '请求已取消', labelEn: 'request aborted' },
  AUTH: { category: 'auth', retryable: false, labelZh: '认证失败', labelEn: 'authentication failed' },
  INVALID_CREDENTIAL: { category: 'credential', retryable: false, labelZh: '凭据无效', labelEn: 'invalid credential' },
  MISSING_CREDENTIAL: { category: 'credential', retryable: false, labelZh: '缺少凭据', labelEn: 'missing credential' },
  QUOTA: { category: 'quota', retryable: false, labelZh: '额度已用尽', labelEn: 'quota exhausted' },
  ACCOUNT_QUOTA: { category: 'quota', retryable: false, labelZh: '账户额度已用尽', labelEn: 'account quota exhausted' },
  CONTEXT_WINDOW_EXCEEDED: { category: 'context-window', retryable: false, labelZh: '超出上下文窗口', labelEn: 'context window exceeded' },
  UNKNOWN_MODEL: { category: 'model', retryable: false, labelZh: '未知模型', labelEn: 'unknown model' },
  NO_ADAPTER: { category: 'routing', retryable: false, labelZh: '没有可用的提供商适配器', labelEn: 'no provider adapter' },
  UNSUPPORTED_OPTION: { category: 'request', retryable: false, labelZh: '不支持的请求选项', labelEn: 'unsupported request option' },
  IMAGE_OFFLOAD_REQUIRED: { category: 'request', retryable: false, labelZh: '图片负载超出上限', labelEn: 'image payload limit exceeded' },
  IMAGE_INPUT_UNSUPPORTED: { category: 'request', retryable: false, labelZh: '该模型不支持图片输入', labelEn: 'model does not accept images' },
  UNRECOGNIZED: { category: 'unknown', retryable: false, labelZh: '未识别的失败', labelEn: 'unrecognized failure' },
});


/** 判断值是否是普通对象（非 null、非数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 读取 config 字段：DSH 的 Config 字段可能是 `Volatile` 引用（带 get()），
 * 也可能是普通值（测试或旧版加载器）。统一解包一次。
 * @param {unknown} value 原始字段值。
 * @returns {unknown} 解包后的普通值。
 */
export function readField(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return readField(value.get());
  }
  return value;
}

/** 把任意快照对象解包成普通 JSON 形状。 */
function plain(value) {
  const unwrapped = readField(value);
  if (Array.isArray(unwrapped)) return unwrapped.map(plain);
  if (isPlainObject(unwrapped)) {
    const result = {};
    for (const [key, child] of Object.entries(unwrapped)) result[key] = plain(child);
    return result;
  }
  return unwrapped;
}

/**
 * 校验毫秒定时器字段。
 * @param {string} field 字段名（用于错误信息）。
 * @param {unknown} value 候选值。
 * @returns {number} 校验后的整数毫秒。
 * @throws {Error} 非正整数或超出 Node 定时器上限时抛出。
 */
export function assertTimerDelayMs(field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`dsh-llm-resilience: ${field} 必须是正整数毫秒`);
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-llm-resilience: ${field} 不能大于 ${MAX_TIMER_DELAY_MS}`);
  }
  return value;
}

/**
 * 归一化并校验重试策略。
 * @param {unknown} raw 候选重试配置 { maxRetries?, retryableCodes?, backoff? }。
 * @param {string} [path] 诊断路径前缀。
 * @returns {{ maxRetries: number, retryableCodes: string[], backoff: { initialDelayMs: number, maxDelayMs: number, jitterRatio: number } }}
 * @throws {Error} 任一字段非法时抛出。
 */
export function normalizeRetryPolicy(raw, path = 'defaultRetry') {
  const input = plain(raw);
  if (input === undefined) return normalizeRetryPolicy({}, path);
  if (!isPlainObject(input)) throw new Error(`dsh-llm-resilience: ${path} 必须是对象`);

  const maxRetries = input.maxRetries === undefined ? DEFAULT_MAX_RETRIES : input.maxRetries;
  if (typeof maxRetries !== 'number' || !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 50) {
    throw new Error(`dsh-llm-resilience: ${path}.maxRetries 必须是 0 到 50 之间的整数`);
  }

  const codes = input.retryableCodes === undefined ? [...DEFAULT_RETRYABLE_CODES] : input.retryableCodes;
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error(`dsh-llm-resilience: ${path}.retryableCodes 必须是非空字符串数组`);
  }
  const normalizedCodes = [];
  for (const code of codes) {
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error(`dsh-llm-resilience: ${path}.retryableCodes 只能包含非空字符串`);
    }
    if (normalizedCodes.includes(code)) {
      throw new Error(`dsh-llm-resilience: ${path}.retryableCodes 不能包含重复项 "${code}"`);
    }
    normalizedCodes.push(code);
  }

  const backoffInput = input.backoff === undefined ? {} : plain(input.backoff);
  if (!isPlainObject(backoffInput)) throw new Error(`dsh-llm-resilience: ${path}.backoff 必须是对象`);
  const initialDelayMs = backoffInput.initialDelayMs === undefined
    ? DEFAULT_INITIAL_DELAY_MS
    : assertTimerDelayMs(`${path}.backoff.initialDelayMs`, backoffInput.initialDelayMs);
  const maxDelayMs = backoffInput.maxDelayMs === undefined
    ? DEFAULT_MAX_DELAY_MS
    : assertTimerDelayMs(`${path}.backoff.maxDelayMs`, backoffInput.maxDelayMs);
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`dsh-llm-resilience: ${path}.backoff.initialDelayMs 不能大于 maxDelayMs`);
  }
  const jitterRatio = backoffInput.jitterRatio === undefined ? DEFAULT_JITTER_RATIO : backoffInput.jitterRatio;
  if (typeof jitterRatio !== 'number' || !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(`dsh-llm-resilience: ${path}.backoff.jitterRatio 必须在 0 到 1 之间`);
  }

  return {
    maxRetries,
    retryableCodes: normalizedCodes,
    backoff: { initialDelayMs, maxDelayMs, jitterRatio },
  };
}

/**
 * 归一化并校验插件配置（Host 的 Config 快照或设置页的表单值）。
 * @param {unknown} raw 原始配置对象（可含 Volatile 引用）。
 * @returns {{ enabled: boolean, seedOnActivation: boolean, providerNamespaces: string[],
 *   defaultStreamIdleTimeoutMs: number, escalatedRetries: number, escalationDelayMs: number,
 *   defaultRetry: { maxRetries: number, retryableCodes: string[], backoff: object } }} 已归一化的配置。
 * @throws {Error} 任一字段非法时抛出。
 */
export function normalizeConfig(raw) {
  const input = plain(raw);
  if (input === undefined || input === null) {
    return normalizeConfig({});
  }
  if (!isPlainObject(input)) throw new Error('dsh-llm-resilience: 配置必须是对象');

  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') throw new Error('dsh-llm-resilience: enabled 必须是布尔值');

  const seedOnActivation = input.seedOnActivation === undefined ? true : input.seedOnActivation;
  if (typeof seedOnActivation !== 'boolean') throw new Error('dsh-llm-resilience: seedOnActivation 必须是布尔值');

  const rawNamespaces = input.providerNamespaces === undefined
    ? [...DEFAULT_PROVIDER_NAMESPACES]
    : input.providerNamespaces;
  if (!Array.isArray(rawNamespaces) || rawNamespaces.length === 0) {
    throw new Error('dsh-llm-resilience: providerNamespaces 必须是非空字符串数组');
  }
  const providerNamespaces = [];
  for (const ns of rawNamespaces) {
    if (typeof ns !== 'string' || ns.trim().length === 0) {
      throw new Error('dsh-llm-resilience: providerNamespaces 只能包含非空字符串');
    }
    const value = ns.trim();
    if (!providerNamespaces.includes(value)) providerNamespaces.push(value);
  }

  const defaultStreamIdleTimeoutMs = input.defaultStreamIdleTimeoutMs === undefined
    ? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    : assertTimerDelayMs('defaultStreamIdleTimeoutMs', input.defaultStreamIdleTimeoutMs);

  const defaultRetry = normalizeRetryPolicy(input.defaultRetry, 'defaultRetry');

  const escalatedRetries = input.escalatedRetries === undefined
    ? DEFAULT_ESCALATED_RETRIES
    : input.escalatedRetries;
  if (typeof escalatedRetries !== 'number' || !Number.isSafeInteger(escalatedRetries) || escalatedRetries < 0 || escalatedRetries > 50) {
    throw new Error('dsh-llm-resilience: escalatedRetries 必须是 0 到 50 之间的整数（0 表示关闭升级续重试）');
  }

  const escalationDelayMs = input.escalationDelayMs === undefined
    ? DEFAULT_ESCALATION_DELAY_MS
    : assertTimerDelayMs('escalationDelayMs', input.escalationDelayMs);

  return {
    enabled,
    seedOnActivation,
    providerNamespaces,
    defaultStreamIdleTimeoutMs,
    escalatedRetries,
    escalationDelayMs,
    defaultRetry,
  };
}

/**
 * 把引擎内的重试策略转成 llm-pi-ai 的 provider `retryPolicy` 配置值。
 * @param {{ maxRetries: number, retryableCodes: string[], backoff: object }} retry 已归一化策略。
 * @returns {{ mode: 'normal', maxRetries: number, retryableCodes: string[], backoff: object }} provider 配置值。
 */
export function toProviderRetryPolicy(retry) {
  const normalized = normalizeRetryPolicy(retry);
  return {
    mode: 'normal',
    maxRetries: normalized.maxRetries,
    retryableCodes: [...normalized.retryableCodes],
    backoff: { ...normalized.backoff },
  };
}

/**
 * 解析一条提供商路由的有效策略：显式覆盖优先，否则用插件默认值。
 * @param {ReturnType<typeof normalizeConfig>} config 已归一化配置。
 * @param {string} route 提供商路由 id（如 opencode-go）。
 * @param {Record<string, { streamIdleTimeoutMs?: number, retry?: object }>} [overrides] 按路由的覆盖表。
 * @returns {{ route: string, streamIdleTimeoutMs: number, retry: object }} 有效策略。
 */
export function resolveEffectivePolicy(config, route, overrides = {}) {
  if (typeof route !== 'string' || route.length === 0) {
    throw new Error('dsh-llm-resilience: route 必须是非空字符串');
  }
  const override = isPlainObject(overrides) ? plain(overrides[route]) : undefined;
  const streamIdleTimeoutMs = override?.streamIdleTimeoutMs === undefined
    ? config.defaultStreamIdleTimeoutMs
    : assertTimerDelayMs(`providers.${route}.streamIdleTimeoutMs`, override.streamIdleTimeoutMs);
  const retry = normalizeRetryPolicy(
    override?.retry === undefined ? config.defaultRetry : override.retry,
    `providers.${route}.retry`,
  );
  return { route, streamIdleTimeoutMs, retry };
}

/**
 * 规范化失败对象（LlmFailure 或任意抛出值）。
 * @param {unknown} failure 失败值。
 * @returns {{ code: string, message: string, status?: number }} 规范化失败。
 */
export function normalizeFailure(failure) {
  if (failure !== null && typeof failure === 'object') {
    const record = /** @type {Record<string, unknown>} */ (failure);
    const code = typeof record.code === 'string' && record.code.length > 0 ? record.code : 'UNRECOGNIZED';
    const message = typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : typeof record.error === 'string' && record.error.length > 0
        ? record.error
        : code;
    const status = typeof record.status === 'number' && Number.isInteger(record.status) ? record.status : undefined;
    return { code, message, ...(status === undefined ? {} : { status }) };
  }
  if (typeof failure === 'string' && failure.length > 0) return { code: 'UNRECOGNIZED', message: failure };
  return { code: 'UNRECOGNIZED', message: String(failure ?? '') };
}

/**
 * 把失败归类到面向用户的类别。
 * @param {unknown} failure 失败值（LlmFailure 或异常）。
 * @returns {{ code: string, message: string, status?: number, category: string, retryable: boolean, labelZh: string, labelEn: string }}
 */
export function classifyFailure(failure) {
  const normalized = normalizeFailure(failure);
  const known = FAILURE_TABLE[normalized.code];
  if (known !== undefined) {
    return { ...normalized, ...known };
  }
  // 未知失败码：按 HTTP 状态做保守推断；其余一律视为不可重试。
  const status = normalized.status;
  if (status !== undefined) {
    if (status === 408) {
      return { ...normalized, ...FAILURE_TABLE.TIMEOUT };
    }
    if (status === 429) {
      return { ...normalized, ...FAILURE_TABLE.RATE_LIMIT };
    }
    if (status >= 500 && status <= 599) {
      return { ...normalized, ...FAILURE_TABLE.SERVER };
    }
    if (status === 401 || status === 403) {
      return { ...normalized, ...FAILURE_TABLE.AUTH };
    }
  }
  return { ...normalized, ...FAILURE_TABLE.UNRECOGNIZED };
}


/**
 * 构建「升级续重试」的诊断文案（只写 ctx.logger，不伪造会话事件：
 * 升级重试没有原生可见事件，基础重试的 k/N UI 提示由 llm-retry 提供）。
 * @param {{ provider: string, failure: unknown, attempt: number, maxRetries: number }} input 提示数据。
 * @returns {{ zh: string, en: string }}
 */
export function escalationRetryNotice({ provider, failure, attempt, maxRetries }) {
  const classified = classifyFailure(failure);
  return {
    zh: `提供商 ${provider} 请求失败（${classified.code}），同路由第 ${attempt}/${maxRetries} 次续重试`,
    en: `Provider ${provider} failed (${classified.code}); escalated same-route retry ${attempt}/${maxRetries}`,
  };
}

/**
 * 构建「升级续重试预算用尽、已放弃」的诊断文案。
 * @param {{ provider: string, failure: unknown, escalatedRetries: number }} input 提示数据。
 * @returns {{ zh: string, en: string }}
 */
export function escalationGaveUpNotice({ provider, failure, escalatedRetries }) {
  const classified = classifyFailure(failure);
  return {
    zh: `已放弃：${provider} 的 ${classified.code}；升级续重试已用 ${escalatedRetries} 次。`
      + '空闲超时与重试策略见「设置 → LLM 韧性」页',
    en: `Gave up: ${classified.code} from ${provider}; used ${escalatedRetries} escalated retries.`
      + ' See Settings → LLM Resilience for the idle-timeout and retry policy',
  };
}

/**
 * 判断基础重试预算耗尽（next() 返回 undefined）后是否做一次升级续重试。
 *
 * 条件（全部满足才升级）：
 *  - 插件启用、升级预算 escalatedRetries > 0；
 *  - 失败码在 {@link ESCALATION_RETRYABLE_CODES} 内；
 *  - 同 turn+step 的升级计数未达上限；
 *  - 调用方的 signal 未 abort。
 *
 * @param {{ failure: unknown, escalatedCount: number, config: ReturnType<typeof normalizeConfig>, aborted?: boolean }} input
 * @returns {{ kind: 'escalate'|'stop', reason: string, escalatedCount: number, delayMs?: number }}
 */
export function escalationDecision({ failure, escalatedCount, config, aborted = false }) {
  const count = Number.isSafeInteger(escalatedCount) && escalatedCount >= 0 ? escalatedCount : 0;
  const stop = (reason) => ({ kind: 'stop', reason, escalatedCount: count });
  if (aborted) return stop('aborted');
  if (!config.enabled) return stop('disabled');
  if (config.escalatedRetries <= 0) return stop('escalation-disabled');
  if (count >= config.escalatedRetries) return stop('budget-exhausted');
  const { code } = normalizeFailure(failure);
  if (!ESCALATION_RETRYABLE_CODES.includes(code)) return stop('not-retryable');
  const attempt = count + 1;
  return {
    kind: 'escalate',
    reason: 'retry',
    escalatedCount: attempt,
    delayMs: config.escalationDelayMs,
  };
}

/**
 * 计算把一条提供商路由的有效策略写入 settings 命名空间所需的路径操作。
 * 路径格式与 DSH settings 的 SettingsPathOp 一致：
 * ['providers', route, 'streamIdleTimeoutMs'] 等。
 * @param {string} route 提供商路由 id。
 * @param {{ streamIdleTimeoutMs: number, retry: object }} effective 有效策略。
 * @returns {Array<{ op: 'set', path: string[], value: unknown }>} 路径操作列表。
 */
export function providerPolicyOps(route, effective) {
  const retry = normalizeRetryPolicy(effective.retry, `providers.${route}.retry`);
  return [
    {
      op: 'set',
      path: ['providers', route, 'streamIdleTimeoutMs'],
      value: assertTimerDelayMs(`providers.${route}.streamIdleTimeoutMs`, effective.streamIdleTimeoutMs),
    },
    { op: 'set', path: ['providers', route, 'retryPolicy'], value: toProviderRetryPolicy(retry) },
  ];
}

/**
 * 计算「启动期为一条路由补齐空闲超时」所需的路径操作。
 *
 * 只补 streamIdleTimeoutMs 这一个字段，不补 retryPolicy：
 *  - retryPolicy 会触发 llm-pi-ai adapter 的原子重注册，启动期写它会造成
 *    reload 抖动，也会覆盖上游的默认策略（5 次/500ms/10s/0.1）。重试策略
 *    只在用户于设置页显式保存时写入。
 *  - 用户层已经有 streamIdleTimeoutMs 时不覆盖用户值。
 *
 * @param {unknown} userProfile settings 命名空间中该路由的用户层配置（可能为空）。
 * @param {{ streamIdleTimeoutMs: number }} effective 有效策略。
 * @returns {Array<{ op: 'set', path: string[], value: unknown }>} 路径操作列表；无缺失时为空数组。
 */
export function seedProviderIdleTimeoutOps(userProfile, effective) {
  const user = isPlainObject(userProfile) ? plain(userProfile) : {};
  if (user.streamIdleTimeoutMs !== undefined) return [];
  return [{
    op: 'set',
    path: ['streamIdleTimeoutMs'],
    value: assertTimerDelayMs('streamIdleTimeoutMs', effective.streamIdleTimeoutMs),
  }];
}

