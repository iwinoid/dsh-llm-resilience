# dsh-llm-resilience 实现说明

本文把每个用户需求映射到具体代码、给出所需的 profile patch 行、说明验证方式与已知限制。参考源码：DSH v0.2.1-rc.3（`~/Documents/项目/dsh/deepseek-harness-upstream`，下称 `UP/`）。运行时 API 已用 `cordis_inspect_query`（Host `Service.listService('settings')`、`Event.listEvents('agent/request-error')`）与本机安装包核对。

## 1. 设计结论（为什么是"配置既有原生机制 + 一层补齐"）

| 能力 | 上游现状 | 本插件做什么 |
|---|---|---|
| 空闲超时 | `llm-pi-ai` 每 provider 有 `streamIdleTimeoutMs`，默认 300000ms（`UP/packages/llm/llm-pi-ai/src/config.ts`），超时抛 `TIMEOUT` | 通过 DSH settings 把默认 30000ms 写入 `llm-pi-ai` 命名空间的 `providers.<route>.streamIdleTimeoutMs`；只补缺失值，热生效 |
| 基础重试 | base bundle 内置 `@deepseek-ai/dsh-llm-retry`，按 provider-owned `retryPolicy` 执行，写 `llm/retry`/`llm/retry-started`，Web 聊天渲染 k/N 提示 | 不重复实现；设置页可编辑每个 provider 的 `retryPolicy` |
| 超出基础预算的恢复 | 上游 `llm-retry` 放弃后返回 `undefined`，本轮失败 | `agent/request-error` 的**内层**监听（默认 append，不 prepend）：`await next()` 后若无 retry 决定，对可恢复失败码做有界同路由续重试，复用原生 `llm/retry` 事件 |
| 可见提示 | 基础重试有原生 k/N 行；终局有 turn-error 行 | 升级层复用原生事件（零 UI 成本）；事件不可用时退化为 `ctx.logger` 日志 |
| 快速失败 | 预算耗尽后循环抛原始 `LlmError`，turn-error 显示 code/message | 升级层预算耗尽同样 `return undefined`，保留原始失败事实 |
| 不切换模型 | — | 全程不写 model/provider/selection；`agent/request-error` 只返回 `{kind:'retry'}` 或 `undefined`，循环用同一 step 的同一 route/header 重放 |

## 2. 文件映射

| 需求 | 文件 | 关键实现 |
|---|---|---|
| 配置 schema（volatile，设置页可热改） | `lib/index.js` | `Config`：`enabled` / `seedOnActivation` / `providerNamespaces` / `defaultStreamIdleTimeoutMs` / `defaultRetry` / `escalatedRetries` / `escalationDelayMs` |
| 启动期补齐 30s 空闲超时 | `lib/index.js` → `reconcile()` | `loader.await()` 后 `ctx.settings.describe()` 找 `llm-pi-ai`，对每个 provider 用 `seedProviderIdleTimeoutOps()` 只补缺失的 `streamIdleTimeoutMs`，`ctx.settings.mutate(ns, ops, revision)` 写入；`app-boot/config-reload` 再次补齐 |
| 重试策略（基础） | `lib/policy.js` | `normalizeRetryPolicy`（对齐上游默认 5 / 500ms / 10000ms / 0.1）；`toProviderRetryPolicy`/`providerPolicyOps` 只被 `tests/settings-schema.test.mjs` 用作写入形状契约，Host 不生成 ops（设置页 ops 由 client 自己生成） |
| 失败分类 | `lib/policy.js` | `classifyFailure`：TRANSPORT/TIMEOUT/SERVER/RATE_LIMIT/EMPTY_RESPONSE 等分类表 + HTTP 状态推断 |
| 升级续重试（超出基础预算） | `lib/escalation.js` | `createEscalationHandler`：`await next()` → 有 retry 决定则透传 → 否则按 `escalationDecision` 追加 `llm/retry` → 可取消等待 → 追加 `llm/retry-started` → `{kind:'retry'}`；`always` 基础策略直接 delegate；abort/卸载立即中断；`drain()` 等待在途 |
| Host 接线 | `lib/index.js` | `ctx.on('agent/request-error', handler)`（默认 append，内层）；`ctx.settings.configure({auto:false}, ctx.fiber)`；卸载时 `lifetime.abort()` + `handler.drain()` |
| 设置页 | `lib/client.js` | ModuleLoader 动态模块；`inject=['slots','locale','configForms']`；注册 keyed slot `plugins.row.config`，key `dsh-llm-resilience#llm-resilience`；owner props `{view, form}`；跨命名空间用 `ctx.configForms.get('llm-pi-ai')`；只写白名单路径 |
| 显示元数据 | `locale/en.json`、`locale/zh.json`、`icon.svg` | 中英文标题/描述 + 原创 SVG |

## 3. 所需 profile patch 行

bundle 安装时由 `cordis.patch.yml` 提供：

```yaml
- insert:
    - id: llm-resilience
      name: dsh-llm-resilience
```

- `id: llm-resilience` 同时是本插件的 settings 命名空间（client 页的 owner `form` 即它）。
- 依赖既有 `llm-pi-ai` 行（base bundle 提供，profile 里通常已有 `providers.opencode-go` 配置）。本插件不会创建/删除 provider，只会对已存在的 provider 路由补超时、以及由用户在设置页显式写入重试策略。
- 不需要修改 `~/.dsh` 或 profile 文件：插件通过 `ctx.settings`（底层 `configEditor`）持久化。

## 4. 关键 API 与证据

### 4.1 settings 服务

- `describe()` 返回 `{ns, schema, value, revision, base?, user?, applies:'live'}`；`mutate(ns, ops, expectedRevision?)` 按路径写用户配置层；仅允许 volatile 路径。已用 Host inspect 的 `Service.listService('settings')` 与 `UP/packages/settings/settings/src/index.ts:302,347,367` 核对。
- 持久化位置：profile 的 `cordis.patch.yml`（`UP/packages/boot/config-editor`），对 `llm-pi-ai` 的 `providers`（整个 dict 标了 `.volatile()`，`UP/packages/llm/llm-pi-ai/src/config.ts:352-354`）写入后 Loader 只发 `loader/volatile-update`，不 remount。
- `streamIdleTimeoutMs` / `timeoutMs` 改动在下一次请求/重试生效；`retryPolicy` 改动触发同实例原子重注册（也无需重启）。本插件启动期不写 `retryPolicy` 正是为了避免注册抖动。

### 4.2 agent/request-error

- 签名：`(payload:{agent,turn,step,provider,failure,retryPolicy,signal}, next) => Promise<{kind:'retry'}|undefined>`，waterfall。
- `llm-retry` 在 base bundle 先注册（外层）；normal 模式预算未尽时直接 `return {kind:'retry'}` 且不调用 `next()`；只有它放弃时才调用 `next()` → 本插件（内层）兜底。**因此不能 prepend，也不能在 `await next()` 之前返回 retry**（会抢在 compaction 的 context-overflow / image-offload 修复之前）。
- 返回 `{kind:'retry'}` 后循环 `continue`，同一 turn/step 内重建请求（同一 route/header）。
- 终局返回 `undefined` → 循环抛原始 `LlmError(failure.message, failure.code, failure)`。

### 4.3 原生重试事件

- `llm/retry`：`{retryId, turn, step, provider, mode:'normal', policyKey, retry, maxRetries, delayMs, failure}`；`llm/retry-started`：`{retryId, turn, step, retry}`。
- Web 端 `model-retry` 节点按 `retryId` 连链、`retry===1` 为 start，显示「正在重试模型请求（k/N）」（`UP/packages/client/ui-chat/src/client/conversation-nodes/retry.ts`）。
- 本插件用独立 `policyKey='llm-resilience:escalation'`，不会污染 `llm-retry` 的预算投影；append 失败（headless/事件不可用）时只记录日志，续重试继续。

### 4.4 设置页 slot

- keyed slot `plugins.row.config`，key = `` `${packageName}#${rowId}` ``，owner props `{view:'summary'|'page', form:{state, mutate}}`（`UP/packages/client/ui-plugin-manager/src/client/slot-contract.ts`）。
- 手写动态模块模板：本机同版本已验证的 `fakeip-compat/lib/client.js`（ModuleLoader factory 格式、只 require `react`）。
- 跨命名空间写：`ctx.configForms.get('llm-pi-ai')` → `mutate(ops, revision)` → Remote → Host `settings.mutate`；服务层无 ownership 校验。

## 5. 默认值

| 字段 | 默认 | 与上游关系 |
|---|---|---|
| `defaultStreamIdleTimeoutMs` | 30000 | **有意变更**（上游 300000） |
| `defaultRetry.maxRetries` | 5 | 与上游一致 |
| `defaultRetry.backoff.initialDelayMs` | 500 | 与上游一致 |
| `defaultRetry.backoff.maxDelayMs` | 10000 | 与上游一致 |
| `defaultRetry.backoff.jitterRatio` | 0.1 | 与上游一致 |
| `defaultRetry.retryableCodes` | EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT | 与上游一致 |
| `escalatedRetries` | 2 | 本插件能力；0 关闭 |
| `escalationDelayMs` | 5000 | 本插件能力 |
| `enabled` / `seedOnActivation` | true / true | 本插件开关 |

## 6. 验证

```sh
cd ~/Documents/项目/dsh/dsh-llm-resilience
npm test            # 全部 node --test
npm run check       # node --check lib/*.js scripts/*.mjs
node scripts/smoke.mjs                 # 静态包结构检查（不读写 profile）
node scripts/smoke.mjs --profile web   # 安装后检查 profile；自动识别"已启用/未启用"形态
node scripts/smoke.mjs --profile web --fix  # 删除"未启用"形态下会导致启动告警的残留配置
```

测试分层：

1. `tests/policy.test.mjs`：默认值、配置校验、按 provider 解析、每个失败码、退避边界/抖动、预算耗尽、提示文案、启动补齐 ops、设置页视图。
2. `tests/escalation.test.mjs`：用最小 fake `agent/request-error` 契约（payload + next + `agent.session.append`）验证：next 返回 retry 时透传不叠加、next 为 undefined 时追加原生事件并升级、预算耗尽返回 undefined、abort 不等待、事件不可用退化为日志、step/agent 状态隔离。
3. `tests/waterfall.test.mjs`：用本机安装的真实 `@deepseek-ai/cordis` 验证 waterfall 顺序：外层（llm-retry 位置）直接 retry 时内层不会被调用；外层放弃时内层兜底并可返回 retry；预算耗尽返回 undefined；abort 不重试。
4. `tests/settings-schema.test.mjs`：用本机安装的 `llm-pi-ai` Config schema 校验写入形状、非法值拒绝、`providers` 子树 volatile、上游默认 300000 未被无意改变。
5. `tests/package.test.mjs`：manifest/exports/files/locale/icon/patch 行、各 JS `node --check`、Host/Client 入口契约。

安装后的手工验证清单（需 Lead/用户批准后执行）：

1. Plugins 面板出现 bundle 与 `llm-resilience` 行，标题/描述/图标正常（中英文）。
2. 打开行配置页：显示 `opencode-go` 行，空闲超时初始为 30000（启动补齐已生效）。
3. 修改默认空闲超时/重试次数并保存；确认 profile `cordis.patch.yml` 的 `llm-resilience` 行与 `llm-pi-ai` 行出现对应字段。
4. 触发一次超时（例如把 idle 临时设为 1ms 或断开网络），聊天出现「正在重试模型请求（k/N）」与原始失败原因；升级层日志出现「同路由第 k/N 次续重试」。
5. 确认会话日志中没有任何模型/提供商选择变化事件；当前模型选择保持不变。

## 7. 不变量（代码中必须保持）

- 不写 `model/selection` 事件，不返回/修改 provider、model、reasoning。
- 只写 `llm-pi-ai` 的 `providers.<route>.streamIdleTimeoutMs | retryPolicy | timeoutMs` 与本插件自己的字段。
- 不伪造 `user/message` 或 `model/selection` source；升级提示只走原生 `llm/retry` 事件或日志。
- 任何监听器都必须先 `await next()`，不吞掉下游失败，不改变 compaction 修复链。
- 所有等待可被 abort；卸载时 abort + drain，无定时器泄漏。

## 8. 已知限制

- 行为实际由上游 `llm-pi-ai` 与 `llm-retry` 执行；缺少它们时超时/基础重试不生效，升级层退化为仅日志。
- 启动期只补 `streamIdleTimeoutMs`；用户在设置页「恢复默认」清空该字段后，下一次 `config-reload` 会再次补齐（插件将该字段视为受管字段）。
- 升级续重试计数仅在进程内、按 `agent+turn+step`，Host 重启清零；不跨会话持久化。
- 升级层只覆盖 `llm-pi-ai` 的失败；其它适配器的 timeout 管理需要扩展 `providerNamespaces`/单独适配。
- 30s 是每次 stream read 的 idle 上限；长 prefill 慢路由需按 provider 放宽。
- 设置页依赖 shipped Web 的 `plugins.row.config` slot（v0.2.1-rc.3 已验证；旧/新版本 slot 改名时页面不显示，但 Host 策略仍生效）。

## 9. 未启用形态（装了不加载）与孤儿配置自检

两种停用形态都不会让 dsh 启动告警，前提是不留下"没有目标行"的 id 覆盖配置：

| 形态 | profile 状态 | 组合结果 |
|---|---|---|
| 行级禁用 | bundle 保留；patch 里 `- id: llm-resilience` + `disabled: true` | 行在树里（id 始终存在），插件不加载 |
| 只留依赖（不启用） | 从 `dsh.profile.bundles` 移除；`dependencies` 保留链接 | bundle 层不应用；Host 与浏览器半边都不加载 |

**告警的唯一来源**：设置页保存过配置后，DSH 的 `configEditor` 会在 profile 用户层写一项
`- id: llm-resilience / config: {...}`。这属于 DSH patch 模型的通用行为（任何"保存过配置的
bundle"取消选中后都会产生同样的孤儿项），**不是本插件的运行时代码产生的**——插件未加载时
没有任何代码在执行。目标行不存在时 Loader 会打印
`patch: entry "llm-resilience" not found` 并丢弃该段。

检测与精确删除由 `scripts/profile-state.mjs` 提供，`scripts/smoke.mjs --profile <name> [--fix]`
调用它：

- `analyzeProfileState()`：判定形态（`enabled` / `disabled`）、列出问题；`disabled` 形态下发现
  第 0 列的 `- id: llm-resilience` 覆盖块即报 `orphan-patch`。
- `findRowBlocks()` / `removeRowBlocks()`：按行区间删除，缩进更深的 `insert:` 子项不会被误删。
- `writePatchWithBackup()`：先写 `.bak-<stamp>` 备份，再临时文件 + rename 原子替换并保持权限。
- `--fix` 只在 `disabled` 形态下生效；`enabled` 形态下用户层该段是正常配置，脚本只提示不删除。

对应单测：`tests/profile-state.test.mjs`（识别、引号/注释、边界、幂等、备份写回、端到端修复）。
