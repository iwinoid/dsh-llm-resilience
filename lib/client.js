// dsh-llm-resilience browser half: the plugin row's configuration page in the
// Plugins panel (view: 'summary' one-liner, view: 'page' editor). The page
// supplies `{ view, form }` as owner props: `form.state` is our own settings
// namespace snapshot and `form.mutate(ops, revision)` its fenced writer.
// The llm-pi-ai namespace is reached through the shared `ctx.configForms`
// service, so route timeouts/retry policies are edited and persisted through
// the same DSH settings document with live effect and no restart.
//
// Hand-written in the loader's factory format (same shape as a built DSH
// client bundle): plain JS, React.createElement only, no build step.
// It requires only "react"; it must not import Harness Client packages.
window.__ModuleLoader__.load({
  id: 'dsh-llm-resilience',
  factory: (require) => {
    var module = { exports: {} };
    const React = require('react');

    /** Our bundle row id; also our settings namespace. */
    const ENTRY_ID = 'llm-resilience';
    /** The llm-pi-ai settings namespace whose provider routes we manage. */
    const PI_ENTRY = 'llm-pi-ai';
    /** Locale dictionary namespace. */
    const DICT_NS = 'settings.llm-resilience';
    /** Max timer delay, same as Node/DSH. */
    const MAX_TIMER = 2147483647;
    /** Upstream dsh-llm-retry provider defaults (kept identical on purpose). */
    const UPSTREAM_RETRY = { maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 };
    const UPSTREAM_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];
    /** The user-confirmed idle-timeout default (upstream is 300000). */
    const DEFAULT_IDLE_MS = 30000;

    const zh = {
      summary: (idle, retries, escalation, enabled) => (enabled
        ? `空闲超时 ${idle}ms · 基础重试 ${retries} 次 · 升级续重试 ${escalation} 次`
        : '已禁用（不补齐默认策略、不做升级续重试）'),
      ownSection: '本插件策略（默认值与开关）',
      ownHint: '默认值用于启动期补齐空闲超时，以及「应用推荐值」按钮。基础重试预算由 DSH 内置 llm-retry 执行。',
      enabled: '启用超时与重试策略',
      seedOnActivation: '启动时补齐缺失的空闲超时',
      seedHint: '只补 streamIdleTimeoutMs，不写 retryPolicy（避免 adapter 重注册抖动）；用户已设置的值不会被覆盖。',
      defaultIdle: '默认空闲超时（毫秒）',
      maxRetries: '基础最大重试次数',
      initialDelay: '首次退避（毫秒）',
      maxDelay: '退避上限（毫秒）',
      jitter: '抖动比例（0-1）',
      codes: '可重试错误码（逗号分隔）',
      escalatedRetries: '升级续重试次数（0=关闭）',
      escalationDelay: '升级续重试等待（毫秒）',
      providerSection: 'llm-pi-ai 提供商路由',
      providerHint: '只写白名单字段：空闲超时、重试策略、可选总超时。绝不修改 provider、model、reasoning、baseURL 或凭据。',
      providerUnavailable: 'llm-pi-ai 命名空间当前不可用（该适配器未装配或未配置提供商）。',
      idle: '空闲超时（ms）',
      retryPolicy: '基础重试次数',
      providerCodes: '可重试错误码',
      timeoutMs: '总超时（ms，可选）',
      applyRecommended: '应用推荐值到全部提供商',
      applyRecommendedHint: '写入 30000ms 空闲超时与上游默认重试策略（5 次 / 500ms / 10s / 0.1）。',
      save: '保存',
      discard: '放弃修改',
      saving: '保存中…',
      unsaved: '有未保存的修改',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '设置文档只读，无法保存修改。',
      saveFailed: '保存未完全生效，请检查输入后重试。',
      invalidNumber: '请输入有效数字',
      loading: '读取设置中…',
      unavailable: '当前 Host 没有提供该设置命名空间。',
    };
    const en = {
      summary: (idle, retries, escalation, enabled) => (enabled
        ? `Idle timeout ${idle}ms · base retries ${retries} · escalated retries ${escalation}`
        : 'Disabled (no default seeding, no escalated retries)'),
      ownSection: 'Plugin policy (defaults and switches)',
      ownHint: 'Defaults seed idle timeouts on activation and back the "apply recommended" button. The base retry budget is executed by the built-in DSH llm-retry.',
      enabled: 'Enable timeout and retry policy',
      seedOnActivation: 'Seed missing idle timeouts on activation',
      seedHint: 'Only streamIdleTimeoutMs is seeded, never retryPolicy (avoids adapter re-registration churn); user values are never overwritten.',
      defaultIdle: 'Default idle timeout (ms)',
      maxRetries: 'Base maximum retries',
      initialDelay: 'Initial backoff (ms)',
      maxDelay: 'Backoff cap (ms)',
      jitter: 'Jitter ratio (0-1)',
      codes: 'Retryable codes (comma separated)',
      escalatedRetries: 'Escalated retries (0 = off)',
      escalationDelay: 'Escalated retry wait (ms)',
      providerSection: 'llm-pi-ai provider routes',
      providerHint: 'Only whitelisted fields are written: idle timeout, retry policy, optional total timeout. Provider, model, reasoning, baseURL, and credentials are never modified.',
      providerUnavailable: 'The llm-pi-ai namespace is unavailable (adapter not composed or no provider configured).',
      idle: 'Idle timeout (ms)',
      retryPolicy: 'Base retries',
      providerCodes: 'Retryable codes',
      timeoutMs: 'Total timeout (ms, optional)',
      applyRecommended: 'Apply recommended values to all providers',
      applyRecommendedHint: 'Writes 30000ms idle timeout and the upstream default retry policy (5 / 500ms / 10s / 0.1).',
      save: 'Save',
      discard: 'Discard',
      saving: 'Saving…',
      unsaved: 'Unsaved changes',
      overridden: 'Overridden',
      reset: 'Reset',
      readOnly: 'Settings document is read-only; cannot save.',
      saveFailed: 'Save did not fully land; check the inputs and retry.',
      invalidNumber: 'Enter a valid number',
      loading: 'Reading settings…',
      unavailable: 'The Host does not serve this settings namespace.',
    };

    const inject = ['slots', 'locale', 'configForms'];

    /** Plain-object test. */
    function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    /** Nested path read with fallback. */
    function pick(root, path, fallback) {
      let cursor = root;
      for (let i = 0; i < path.length; i++) {
        if (!isObject(cursor) || !(path[i] in cursor)) return fallback;
        cursor = cursor[path[i]];
      }
      return cursor === undefined ? fallback : cursor;
    }
    /** Whether the user layer stores this path (marks an override). */
    function storedAt(snap, path) {
      if (!isObject(snap.user)) return false;
      let cursor = snap.user;
      for (let i = 0; i < path.length; i++) {
        if (!isObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, path[i])) return false;
        cursor = cursor[path[i]];
      }
      return true;
    }
    /** Integer parse with bounds. */
    function parseInteger(text, min, max) {
      const t = String(text).trim();
      if (!/^\d+$/.test(t)) return undefined;
      const n = Number(t);
      return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
    }
    /** Float parse with bounds. */
    function parseRatio(text) {
      const t = String(text).trim();
      if (t === '') return undefined;
      const n = Number(t);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
    }
    /** Comma/space separated list parse. */
    function parseCodes(text) {
      const parts = String(text).split(/[,，\s]+/).map(s => s.trim()).filter(s => s !== '');
      const out = [];
      for (const part of parts) if (!out.includes(part)) out.push(part);
      return out;
    }
    /** Normalize the plugin's own resolved config for display. */
    function ownConfig(value) {
      const v = isObject(value) ? value : {};
      const retry = isObject(v.defaultRetry) ? v.defaultRetry : {};
      const backoff = isObject(retry.backoff) ? retry.backoff : {};
      return {
        enabled: v.enabled !== false,
        seedOnActivation: v.seedOnActivation !== false,
        defaultStreamIdleTimeoutMs: typeof v.defaultStreamIdleTimeoutMs === 'number' && v.defaultStreamIdleTimeoutMs > 0
          ? v.defaultStreamIdleTimeoutMs : DEFAULT_IDLE_MS,
        escalatedRetries: typeof v.escalatedRetries === 'number' && v.escalatedRetries >= 0
          ? v.escalatedRetries : 2,
        escalationDelayMs: typeof v.escalationDelayMs === 'number' && v.escalationDelayMs > 0
          ? v.escalationDelayMs : 5000,
        defaultRetry: {
          maxRetries: typeof retry.maxRetries === 'number' && retry.maxRetries >= 0 ? retry.maxRetries : UPSTREAM_RETRY.maxRetries,
          retryableCodes: Array.isArray(retry.retryableCodes) && retry.retryableCodes.length > 0
            ? retry.retryableCodes : UPSTREAM_CODES,
          backoff: {
            initialDelayMs: typeof backoff.initialDelayMs === 'number' && backoff.initialDelayMs > 0
              ? backoff.initialDelayMs : UPSTREAM_RETRY.initialDelayMs,
            maxDelayMs: typeof backoff.maxDelayMs === 'number' && backoff.maxDelayMs > 0
              ? backoff.maxDelayMs : UPSTREAM_RETRY.maxDelayMs,
            jitterRatio: typeof backoff.jitterRatio === 'number' && backoff.jitterRatio >= 0
              ? backoff.jitterRatio : UPSTREAM_RETRY.jitterRatio,
          },
        },
      };
    }
    /** Normalize one provider's resolved retry policy for display. */
    function providerRetry(profile) {
      const retry = isObject(profile) && isObject(profile.retryPolicy) ? profile.retryPolicy : {};
      const backoff = isObject(retry.backoff) ? retry.backoff : {};
      return {
        maxRetries: typeof retry.maxRetries === 'number' && retry.maxRetries >= 0 ? retry.maxRetries : UPSTREAM_RETRY.maxRetries,
        retryableCodes: Array.isArray(retry.retryableCodes) && retry.retryableCodes.length > 0
          ? retry.retryableCodes : UPSTREAM_CODES,
        backoff: {
          initialDelayMs: typeof backoff.initialDelayMs === 'number' && backoff.initialDelayMs > 0
            ? backoff.initialDelayMs : UPSTREAM_RETRY.initialDelayMs,
          maxDelayMs: typeof backoff.maxDelayMs === 'number' && backoff.maxDelayMs > 0
            ? backoff.maxDelayMs : UPSTREAM_RETRY.maxDelayMs,
          jitterRatio: typeof backoff.jitterRatio === 'number' && backoff.jitterRatio >= 0
            ? backoff.jitterRatio : UPSTREAM_RETRY.jitterRatio,
        },
      };
    }
    /** Build a provider retryPolicy config value. */
    function retryConfig(retry) {
      return {
        mode: 'normal',
        maxRetries: retry.maxRetries,
        retryableCodes: [...retry.retryableCodes],
        backoff: { ...retry.backoff },
      };
    }
    /** Provider rows derived from the llm-pi-ai namespace snapshot. */
    function providerRows(snap) {
      if (!snap || snap.status !== 'ready') return [];
      const value = isObject(snap.value) ? snap.value : {};
      const user = isObject(snap.user) ? snap.user : {};
      const profiles = isObject(value.providers) ? value.providers : {};
      const userProfiles = isObject(user.providers) ? user.providers : {};
      return Object.keys(profiles).sort().map(route => {
        const profile = isObject(profiles[route]) ? profiles[route] : {};
        const userProfile = isObject(userProfiles[route]) ? userProfiles[route] : {};
        return {
          route,
          streamIdleTimeoutMs: typeof profile.streamIdleTimeoutMs === 'number' && profile.streamIdleTimeoutMs > 0
            ? profile.streamIdleTimeoutMs : DEFAULT_IDLE_MS,
          timeoutMs: typeof profile.timeoutMs === 'number' && profile.timeoutMs > 0 ? profile.timeoutMs : undefined,
          retry: providerRetry(profile),
          customized: userProfile.streamIdleTimeoutMs !== undefined
            || userProfile.retryPolicy !== undefined
            || userProfile.timeoutMs !== undefined,
        };
      });
    }

    // ---- our own namespace: path-addressed field specs and staged plan ----
    const SPECS = [
      { id: 'enabled', path: ['enabled'], kind: 'bool' },
      { id: 'seedOnActivation', path: ['seedOnActivation'], kind: 'bool' },
      { id: 'defaultIdle', path: ['defaultStreamIdleTimeoutMs'], kind: 'int', min: 1, max: MAX_TIMER },
      { id: 'maxRetries', path: ['defaultRetry', 'maxRetries'], kind: 'int', min: 0, max: 50 },
      { id: 'initialDelay', path: ['defaultRetry', 'backoff', 'initialDelayMs'], kind: 'int', min: 1, max: MAX_TIMER },
      { id: 'maxDelay', path: ['defaultRetry', 'backoff', 'maxDelayMs'], kind: 'int', min: 1, max: MAX_TIMER },
      { id: 'jitter', path: ['defaultRetry', 'backoff', 'jitterRatio'], kind: 'ratio' },
      { id: 'codes', path: ['defaultRetry', 'retryableCodes'], kind: 'codes' },
      { id: 'escalatedRetries', path: ['escalatedRetries'], kind: 'int', min: 0, max: 50 },
      { id: 'escalationDelay', path: ['escalationDelayMs'], kind: 'int', min: 1, max: MAX_TIMER },
    ];
    function specOf(id) {
      for (const spec of SPECS) if (spec.id === id) return spec;
      throw new Error('no spec ' + id);
    }
    function formatValue(spec, value) {
      if (spec.kind === 'bool') return value === true ? 'true' : 'false';
      if (spec.kind === 'codes') return Array.isArray(value) ? value.join(', ') : '';
      if (value === undefined || value === null) return '';
      return String(value);
    }
    function parseValue(spec, text) {
      if (spec.kind === 'bool') {
        const t = String(text).trim().toLowerCase();
        if (t === 'true') return { kind: 'set', value: true };
        if (t === 'false') return { kind: 'set', value: false };
        return undefined;
      }
      const t = String(text).trim();
      if (t === '') return { kind: 'clear' };
      if (spec.kind === 'codes') {
        const codes = parseCodes(t);
        return codes.length === 0 ? undefined : { kind: 'set', value: codes };
      }
      if (spec.kind === 'ratio') {
        const n = parseRatio(t);
        return n === undefined ? undefined : { kind: 'set', value: n };
      }
      const n = parseInteger(t, spec.min, spec.max);
      return n === undefined ? undefined : { kind: 'set', value: n };
    }
    /** One field's render state for the staged editor. */
    function fieldState(snap, staged, id) {
      const spec = specOf(id);
      const edit = staged[id];
      const current = pick(snap.value, spec.path, undefined);
      if (edit === undefined) {
        return { text: formatValue(spec, current), overridden: storedAt(snap, spec.path), invalid: false };
      }
      if (edit.clear) return { text: edit.text, overridden: false, invalid: false };
      const parsed = parseValue(spec, edit.text);
      return {
        text: edit.text,
        overridden: parsed !== undefined && parsed.kind === 'set',
        invalid: parsed === undefined,
      };
    }
    /** Plan our own namespace's staged edits as wire ops. */
    function planOwnOps(snap, staged) {
      const ops = [];
      let invalid = false;
      for (const key of Object.keys(staged)) {
        const spec = specOf(key);
        const edit = staged[key];
        if (edit.clear) {
          if (storedAt(snap, spec.path)) ops.push({ op: 'unset', path: spec.path });
          continue;
        }
        const current = pick(snap.value, spec.path, undefined);
        if (edit.text === formatValue(spec, current)) continue;
        const parsed = parseValue(spec, edit.text);
        if (parsed === undefined) { invalid = true; continue; }
        if (parsed.kind === 'clear') {
          if (storedAt(snap, spec.path)) ops.push({ op: 'unset', path: spec.path });
        } else {
          ops.push({ op: 'set', path: spec.path, value: parsed.value });
        }
      }
      // Cross-field rule: initialDelayMs <= maxDelayMs, evaluated on the merged view.
      const merged = planMergedConfig(snap, staged);
      if (merged.invalid || merged.retry.backoff.initialDelayMs > merged.retry.backoff.maxDelayMs) invalid = true;
      return { ops, invalid };
    }
    /** Merge staged edits over the current values for cross-field validation. */
    function planMergedConfig(snap, staged) {
      const config = ownConfig(snap.value);
      let invalid = false;
      for (const key of Object.keys(staged)) {
        const spec = specOf(key);
        const edit = staged[key];
        if (edit.clear) continue;
        const parsed = parseValue(spec, edit.text);
        if (parsed === undefined) { invalid = true; continue; }
        if (parsed.kind !== 'set') continue;
        if (spec.id === 'defaultIdle') config.defaultStreamIdleTimeoutMs = parsed.value;
        else if (spec.id === 'escalatedRetries') config.escalatedRetries = parsed.value;
        else if (spec.id === 'escalationDelay') config.escalationDelayMs = parsed.value;
        else if (spec.id === 'enabled') config.enabled = parsed.value;
        else if (spec.id === 'seedOnActivation') config.seedOnActivation = parsed.value;
        else if (spec.id === 'maxRetries') config.defaultRetry.maxRetries = parsed.value;
        else if (spec.id === 'initialDelay') config.defaultRetry.backoff.initialDelayMs = parsed.value;
        else if (spec.id === 'maxDelay') config.defaultRetry.backoff.maxDelayMs = parsed.value;
        else if (spec.id === 'jitter') config.defaultRetry.backoff.jitterRatio = parsed.value;
        else if (spec.id === 'codes') config.defaultRetry.retryableCodes = parsed.value;
      }
      return { config, retry: config.defaultRetry, invalid };
    }

    // ---- llm-pi-ai provider rows: staged drafts and save plan ----
    /** Empty draft for one route. */
    function emptyPiDraft() {
      return { idle: undefined, retries: undefined, codes: undefined, timeout: undefined };
    }
    /** Whether a provider draft carries edits. */
    function piDraftDirty(draft) {
      return draft !== undefined && (draft.idle !== undefined || draft.retries !== undefined
        || draft.codes !== undefined || draft.timeout !== undefined);
    }
    /**
     * Plan llm-pi-ai writes from provider drafts.
     * @returns {{ops: object[], invalid: boolean}} wire ops and validation flag.
     */
    function planPiOps(rows, drafts) {
      const ops = [];
      let invalid = false;
      for (const row of rows) {
        const draft = drafts[row.route];
        if (!piDraftDirty(draft)) continue;
        if (draft.idle !== undefined) {
          const idle = parseInteger(draft.idle, 1, MAX_TIMER);
          if (idle === undefined) invalid = true;
          else ops.push({ op: 'set', path: ['providers', row.route, 'streamIdleTimeoutMs'], value: idle });
        }
        const nextRetry = providerRetry({ retryPolicy: retryConfig(row.retry) });
        if (draft.retries !== undefined) {
          const retries = parseInteger(draft.retries, 0, 50);
          if (retries === undefined) invalid = true;
          else nextRetry.maxRetries = retries;
        }
        if (draft.codes !== undefined) {
          const codes = parseCodes(draft.codes);
          if (codes.length === 0) invalid = true;
          else nextRetry.retryableCodes = codes;
        }
        if (draft.retries !== undefined || draft.codes !== undefined) {
          ops.push({ op: 'set', path: ['providers', row.route, 'retryPolicy'], value: retryConfig(nextRetry) });
        }
        if (draft.timeout !== undefined) {
          const trimmed = String(draft.timeout).trim();
          if (trimmed === '') {
            if (row.timeoutMs !== undefined) ops.push({ op: 'unset', path: ['providers', row.route, 'timeoutMs'] });
          } else {
            const timeout = parseInteger(trimmed, 1, MAX_TIMER);
            if (timeout === undefined) invalid = true;
            else ops.push({ op: 'set', path: ['providers', row.route, 'timeoutMs'], value: timeout });
          }
        }
      }
      return { ops, invalid };
    }

    // ---- styles: same tokens and metrics as shipped settings cards ----
    const S = {
      body: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: 8 },
      section: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 12 },
      sectionTitle: { margin: '0 0 2px', fontSize: 14, fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' },
      sectionHint: { margin: '0 0 6px', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      fieldFirst: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0' },
      head: { display: 'flex', alignItems: 'center', gap: 8 },
      label: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
      badges: { display: 'inline-flex', alignItems: 'center', gap: 8 },
      badge: { borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px', fontWeight: 500, whiteSpace: 'nowrap', background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)' },
      reset: { border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
      input: { height: 34, padding: '0 12px', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', width: '100%', boxSizing: 'border-box' },
      inputInvalid: { height: 34, padding: '0 12px', border: '0.5px solid var(--dsw-alias-label-error)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', width: '100%', boxSizing: 'border-box' },
      hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      invalid: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' },
      checkLabel: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      checkbox: { width: 15, height: 15, accentColor: 'var(--dsw-alias-brand-primary)', flex: 'none' },
      footer: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 0 4px', borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      failed: { flex: 1, minWidth: 0, margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' },
      discard: { appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: 1.5, cursor: 'pointer', background: 'none', color: 'var(--dsw-alias-label-secondary)' },
      save: { appearance: 'none', border: '1px solid transparent', borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: 1.5, cursor: 'pointer', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)' },
      apply: { appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: 1.5, cursor: 'pointer', background: 'none', color: 'var(--dsw-alias-label-primary)' },
      btnDisabled: { opacity: 0.4, cursor: 'default' },
      readOnly: { margin: '12px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      providerRow: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      providerName: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      providerGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 },
      miniLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
    };

    /** Text/checkbox field row for our own config. */
    function OwnField(p) {
      if (p.kind === 'check') {
        return React.createElement('div', { style: p.first ? S.fieldFirst : S.field },
          React.createElement('div', { style: S.head },
            React.createElement('label', { style: S.checkLabel, htmlFor: p.id },
              React.createElement('input', {
                id: p.id, type: 'checkbox', style: S.checkbox, checked: p.state.text === 'true',
                disabled: p.disabled, onChange: (event) => p.onEdit(event.target.checked ? 'true' : 'false'),
              }),
              p.label),
            p.state.overridden
              ? React.createElement('span', { style: S.badges },
                React.createElement('span', { style: S.badge }, p.overriddenLabel),
                React.createElement('button', { type: 'button', style: S.reset, disabled: p.disabled, onClick: p.onReset }, p.resetLabel))
              : null),
          p.hint ? React.createElement('p', { style: S.hint }, p.hint) : null);
      }
      const invalid = p.state.invalid;
      return React.createElement('div', { style: p.first ? S.fieldFirst : S.field },
        React.createElement('div', { style: S.head },
          React.createElement('label', { style: S.label, htmlFor: p.id }, p.label),
          p.state.overridden
            ? React.createElement('span', { style: S.badges },
              React.createElement('span', { style: S.badge }, p.overriddenLabel),
              React.createElement('button', { type: 'button', style: S.reset, disabled: p.disabled, onClick: p.onReset }, p.resetLabel))
            : null),
        React.createElement('input', {
          id: p.id,
          style: invalid ? S.inputInvalid : S.input,
          type: 'text',
          inputMode: p.numeric ? 'numeric' : undefined,
          'aria-invalid': invalid ? true : undefined,
          value: p.state.text,
          disabled: p.disabled,
          onChange: (event) => p.onEdit(event.target.value),
        }),
        React.createElement('p', { style: invalid ? S.invalid : S.hint }, invalid ? p.invalidLabel : p.hint));
    }

    /** Provider route row: idle timeout, retry count, codes, optional total timeout. */
    function ProviderRow(p) {
      const row = p.row;
      const draft = p.draft;
      const valueOf = (key, current) => (draft[key] !== undefined
        ? draft[key]
        : current === undefined || current === null ? '' : String(current));
      const input = (key, current, onDraft, numeric) => React.createElement('input', {
        style: S.input,
        type: 'text',
        inputMode: numeric === false ? undefined : 'numeric',
        value: valueOf(key, current),
        disabled: p.disabled,
        onChange: (event) => onDraft(event.target.value),
      });
      return React.createElement('div', { style: S.providerRow },
        React.createElement('div', { style: S.providerName },
          React.createElement('span', null, row.route),
          row.customized ? React.createElement('span', { style: S.badge }, p.overriddenLabel) : null),
        React.createElement('div', { style: S.providerGrid },
          React.createElement('label', { style: S.miniLabel }, p.labels.idle,
            input('idle', row.streamIdleTimeoutMs, (v) => p.onDraft({ idle: v }))),
          React.createElement('label', { style: S.miniLabel }, p.labels.retryPolicy,
            input('retries', row.retry.maxRetries, (v) => p.onDraft({ retries: v }))),
          React.createElement('label', { style: S.miniLabel }, p.labels.timeoutMs,
            input('timeout', row.timeoutMs, (v) => p.onDraft({ timeout: v }))),
          React.createElement('label', { style: S.miniLabel }, p.labels.providerCodes,
            input('codes', row.retry.retryableCodes.join(', '), (v) => p.onDraft({ codes: v }), false))));
    }

    /** One-line summary under the plugin row title. */
    function Summary(props) {
      const t = props.t;
      const form = props.form;
      const llmPi = props.llmPi;
      const piSnapshot = React.useSyncExternalStore(
        React.useCallback((listener) => llmPi.subscribe(listener), [llmPi]),
        React.useCallback(() => llmPi.getSnapshot(), [llmPi]),
      );
      if (!form || !form.state || form.state.status !== 'ready') return null;
      const config = ownConfig(form.state.value);
      let idle = config.defaultStreamIdleTimeoutMs;
      let retries = config.defaultRetry.maxRetries;
      if (piSnapshot.status === 'ready') {
        const rows = providerRows(piSnapshot);
        if (rows.length === 1) {
          idle = rows[0].streamIdleTimeoutMs;
          retries = rows[0].retry.maxRetries;
        }
      }
      return React.createElement('span', null,
        t('summary')(idle, retries, config.escalatedRetries, config.enabled));
    }

    /** Full configuration page. */
    function ResilienceCard(props) {
      const t = props.t;
      const view = props.view;
      const form = props.form;
      const llmPi = props.llmPi;

      // Hooks run unconditionally: early returns must not change the hook count.
      const [staged, setStaged] = React.useState({});
      const [piDrafts, setPiDrafts] = React.useState({});
      const [savingOwn, setSavingOwn] = React.useState(false);
      const [savingPi, setSavingPi] = React.useState(false);
      const [ownFailed, setOwnFailed] = React.useState(false);
      const [piFailed, setPiFailed] = React.useState(false);

      const piSnapshot = React.useSyncExternalStore(
        React.useCallback((listener) => llmPi.subscribe(listener), [llmPi]),
        React.useCallback(() => llmPi.getSnapshot(), [llmPi]),
      );

      if (view === 'summary') return React.createElement(Summary, { t, form, llmPi });

      if (!form || !form.state || form.state.status !== 'ready') {
        return React.createElement('div', { style: S.body },
          React.createElement('p', { style: S.hint, role: 'status' }, t('loading')));
      }
      const snap = form.state;
      const disabled = !snap.writable;
      const rows = piSnapshot.status === 'ready' ? providerRows(piSnapshot) : [];
      const piWritable = piSnapshot.status === 'ready' && piSnapshot.writable !== false;

      const editOwn = (id, text) => {
        const next = { ...staged };
        next[id] = { text, clear: false };
        setOwnFailed(false);
        setStaged(next);
      };
      const resetOwn = (id) => {
        const spec = specOf(id);
        const next = { ...staged };
        next[id] = { text: formatValue(spec, pick(snap.base, spec.path, undefined)), clear: true };
        setOwnFailed(false);
        setStaged(next);
      };
      const discardOwn = () => {
        setStaged({});
        setOwnFailed(false);
      };
      const saveOwn = () => {
        const plan = planOwnOps(snap, staged);
        if (plan.ops.length === 0 || plan.invalid || savingOwn) return;
        setSavingOwn(true);
        setOwnFailed(false);
        let settled;
        try {
          settled = form.mutate(plan.ops, snap.revision);
        } catch (error) {
          setSavingOwn(false);
          setOwnFailed(true);
          return;
        }
        Promise.resolve(settled).then(
          (ok) => { setSavingOwn(false); if (ok) setStaged({}); else setOwnFailed(true); },
          () => { setSavingOwn(false); setOwnFailed(true); },
        );
      };
      const editPi = (route, patch) => {
        const current = piDrafts[route] === undefined ? emptyPiDraft() : piDrafts[route];
        setPiDrafts({ ...piDrafts, [route]: { ...current, ...patch } });
        setPiFailed(false);
      };
      const discardPi = () => {
        setPiDrafts({});
        setPiFailed(false);
      };
      const savePi = () => {
        const plan = planPiOps(rows, piDrafts);
        if (plan.ops.length === 0 || plan.invalid || savingPi || !piWritable) return;
        setSavingPi(true);
        setPiFailed(false);
        let settled;
        try {
          settled = llmPi.mutate(plan.ops, piSnapshot.revision);
        } catch (error) {
          setSavingPi(false);
          setPiFailed(true);
          return;
        }
        Promise.resolve(settled).then(
          (ok) => { setSavingPi(false); if (ok) setPiDrafts({}); else setPiFailed(true); },
          () => { setSavingPi(false); setPiFailed(true); },
        );
      };
      const applyRecommended = () => {
        if (savingPi || !piWritable || rows.length === 0) return;
        const target = planMergedConfig(snap, staged).config;
        const idle = target.defaultStreamIdleTimeoutMs;
        const policy = retryConfig(target.defaultRetry);
        const ops = [];
        for (const row of rows) {
          ops.push({ op: 'set', path: ['providers', row.route, 'streamIdleTimeoutMs'], value: idle });
          ops.push({ op: 'set', path: ['providers', row.route, 'retryPolicy'], value: policy });
        }
        setSavingPi(true);
        setPiFailed(false);
        let settled;
        try {
          settled = llmPi.mutate(ops, piSnapshot.revision);
        } catch (error) {
          setSavingPi(false);
          setPiFailed(true);
          return;
        }
        Promise.resolve(settled).then(
          (ok) => { setSavingPi(false); if (ok) setPiDrafts({}); else setPiFailed(true); },
          () => { setSavingPi(false); setPiFailed(true); },
        );
      };

      const ownPlan = planOwnOps(snap, staged);
      const ownDirty = ownPlan.ops.length > 0 || ownPlan.invalid;
      const ownBlocked = !ownDirty || ownPlan.invalid || savingOwn || disabled;
      const piPlan = planPiOps(rows, piDrafts);
      const piDirty = piPlan.ops.length > 0 || piPlan.invalid;
      const piBlocked = !piDirty || piPlan.invalid || savingPi || !piWritable;
      const btn = (base, isDisabled) => (isDisabled ? { ...base, ...S.btnDisabled } : base);
      const fs = (id) => fieldState(snap, staged, id);
      const rowLabels = {
        idle: t('idle'), retryPolicy: t('retryPolicy'), providerCodes: t('providerCodes'), timeoutMs: t('timeoutMs'),
      };

      const ownFields = [
        { id: 'enabled', kind: 'check', label: t('enabled'), hint: t('seedHint') },
        { id: 'seedOnActivation', kind: 'check', label: t('seedOnActivation'), hint: t('seedHint') },
        { id: 'defaultIdle', kind: 'text', label: t('defaultIdle'), hint: t('seedHint'), numeric: true },
        { id: 'maxRetries', kind: 'text', label: t('maxRetries'), numeric: true },
        { id: 'initialDelay', kind: 'text', label: t('initialDelay'), numeric: true },
        { id: 'maxDelay', kind: 'text', label: t('maxDelay'), numeric: true },
        { id: 'jitter', kind: 'text', label: t('jitter') },
        { id: 'codes', kind: 'text', label: t('codes') },
        { id: 'escalatedRetries', kind: 'text', label: t('escalatedRetries'), numeric: true },
        { id: 'escalationDelay', kind: 'text', label: t('escalationDelay'), numeric: true },
      ];
      const children = [
        React.createElement('div', { key: 'own-head', style: S.section },
          React.createElement('h4', { style: S.sectionTitle }, t('ownSection')),
          React.createElement('p', { style: S.sectionHint }, t('ownHint'))),
      ];
      ownFields.forEach((field, index) => {
        children.push(React.createElement(OwnField, {
          key: field.id,
          id: 'llr-' + field.id,
          kind: field.kind,
          first: index === 0,
          label: field.label,
          hint: field.hint,
          numeric: field.numeric === true,
          state: fs(field.id),
          disabled,
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('invalidNumber'),
          onEdit: (text) => editOwn(field.id, text),
          onReset: () => resetOwn(field.id),
        }));
      });
      children.push(React.createElement('div', { key: 'own-footer', style: S.footer },
        ownFailed ? React.createElement('p', { style: S.failed, role: 'status' }, t('saveFailed')) : null,
        ownDirty && !ownPlan.invalid
          ? React.createElement('p', { style: S.hint, role: 'status' }, t('unsaved'))
          : null,
        React.createElement('button', { type: 'button', style: btn(S.discard, !ownDirty || savingOwn), disabled: !ownDirty || savingOwn, onClick: discardOwn }, t('discard')),
        React.createElement('button', { type: 'button', style: btn(S.save, ownBlocked), disabled: ownBlocked, onClick: saveOwn }, t(savingOwn ? 'saving' : 'save'))));

      const providerSection = [
        React.createElement('div', { key: 'pi-head', style: S.section },
          React.createElement('h4', { style: S.sectionTitle }, t('providerSection')),
          React.createElement('p', { style: S.sectionHint }, piSnapshot.status === 'ready' ? t('providerHint') : t('providerUnavailable'))),
      ];
      if (piSnapshot.status !== 'ready') {
        providerSection.push(React.createElement('p', { key: 'pi-status', style: S.hint, role: 'status' },
          piSnapshot.status === 'loading' ? t('loading') : t('unavailable')));
      } else {
        const applyDisabled = savingPi || !piWritable || rows.length === 0;
        providerSection.push(React.createElement('div', { key: 'pi-apply', style: S.field },
          React.createElement('div', { style: S.head },
            React.createElement('span', { style: S.label }, t('applyRecommendedHint')),
            React.createElement('button', {
              type: 'button', style: btn(S.apply, applyDisabled), disabled: applyDisabled, onClick: applyRecommended,
            }, t('applyRecommended')))));
        for (const row of rows) {
          providerSection.push(React.createElement(ProviderRow, {
            key: 'pi-' + row.route,
            row,
            draft: piDrafts[row.route] === undefined ? emptyPiDraft() : piDrafts[row.route],
            labels: rowLabels,
            disabled: !piWritable,
            overriddenLabel: t('overridden'),
            onDraft: (patch) => editPi(row.route, patch),
          }));
        }
        providerSection.push(React.createElement('div', { key: 'pi-footer', style: S.footer },
          piFailed ? React.createElement('p', { style: S.failed, role: 'status' }, t('saveFailed')) : null,
          piDirty && !piPlan.invalid
            ? React.createElement('p', { style: S.hint, role: 'status' }, t('unsaved'))
            : null,
          React.createElement('button', { type: 'button', style: btn(S.discard, !piDirty || savingPi), disabled: !piDirty || savingPi, onClick: discardPi }, t('discard')),
          React.createElement('button', { type: 'button', style: btn(S.save, piBlocked), disabled: piBlocked, onClick: savePi }, t(savingPi ? 'saving' : 'save'))));
      }

      return React.createElement('div', { style: S.body },
        !disabled ? null : React.createElement('p', { style: S.readOnly, role: 'status' }, t('readOnly')),
        ...children,
        ...providerSection);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(DICT_NS, { zh, en }), 'dsh-llm-resilience: dictionaries');
      const t = ctx.locale.bind(DICT_NS);
      const llmPi = ctx.configForms.get(PI_ENTRY);
      // The row page exists while the Host serves our own namespace; the page
      // owner supplies `{ view, form }` and we inject our copy plus the
      // cross-namespace llm-pi-ai form.
      ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject(
        'plugins.row.config',
        () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-llm-resilience#' + ENTRY_ID,
          locale: DICT_NS,
          inject: () => ({ t, llmPi }),
        }, ResilienceCard),
      )), 'dsh-llm-resilience: row config page');
    }

    module.exports = { inject, apply };
    return module.exports;
  },
});
