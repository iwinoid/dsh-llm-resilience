# dsh-llm-resilience

> [!WARNING]
> 个人自用项目。仅在我的机器与工作流上验证过，不保证在其他 DSH 版本、平台或环境下可用。请先审阅代码、谨慎使用，风险自负。

为 DSH（DeepSeek Harness）的 LLM 请求提供**可配置的空闲超时策略**与**同路由重试补齐**，并提供一个真正可编辑的 Web 配置页。它**绝不切换提供商或模型**：所有重试都留在当前 provider 路由，失败只影响本轮请求。

- 空闲超时默认 **30000ms（30 秒）**：修掉上游 `llm-pi-ai` 的 `streamIdleTimeoutMs` 默认 300000ms（5 分钟）导致的长时间静默等待。
- 基础重试沿用 DSH 内置的 `@deepseek-ai/dsh-llm-retry`（同路由、指数退避、聊天中显示「正在重试模型请求（k/N）」），本插件只按用户配置补充策略。
- 超出基础预算后，本插件做有限次（默认 2 次、默认间隔 5s，可配置/可关闭）**同路由升级续重试**，并复用原生 `llm/retry` / `llm/retry-started` 持久化事件，因此聊天里同样会出现重试行；事件不可用时自动退化为仅日志。
- 所有设置通过 DSH settings 服务持久化到当前 profile 的 `cordis.patch.yml` 用户配置层，写入后**下一次请求即生效，无需重启 Host**。

## 功能

### A. 可配置超时策略

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultStreamIdleTimeoutMs` | `30000` | 默认空闲超时（等待模型输出的最长时间），按 provider 路由可覆盖 |
| 每个 provider 的 `streamIdleTimeoutMs` | 使用默认值补齐 | 写入 `llm-pi-ai` 设置命名空间的 `providers.<route>.streamIdleTimeoutMs` |
| 每个 provider 的 `timeoutMs` | 不设置（可选） | pi-ai SDK/HTTP 层总超时，留空表示不设置 |

启动期只补齐缺失的 `streamIdleTimeoutMs`；用户已设置的值不会被覆盖，也**不会在启动期写 `retryPolicy`**（避免 adapter 原子重注册造成的 reload 抖动）。

### B. 同路由错误处理

1. 基础层：DSH 内置 `llm-retry` 按 provider 的 `retryPolicy` 重试（上游默认 `maxRetries=5`、`initialDelayMs=500`、`maxDelayMs=10000`、`jitterRatio=0.1`、可重试码 `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`）。本插件不重复实现这一层。
2. 升级层：当 `agent/request-error` 瀑布中基础策略返回 `undefined`（预算耗尽或该失败不可重试）时，对 `TRANSPORT / SERVER / TIMEOUT / RATE_LIMIT / EMPTY_RESPONSE` 追加有界同路由续重试：
   - 次数默认 `2`（`escalatedRetries=0` 可关闭），每次等待默认 `5000ms`（`escalationDelayMs` 可配）；
   - 先向会话追加 `llm/retry`（独立 `policyKey=llm-resilience:escalation`、`retry` 从 1 起、同一 `retryId`），等待后追加 `llm/retry-started`，再返回 `{kind:'retry'}`；
   - 等待可被 abort/插件卸载立即打断，无定时器泄漏；
   - 预算耗尽返回 `undefined`，由循环抛出适配器原始 `LlmError`，聊天显示原始失败原因（快速失败）。
3. 不变量：不写任何模型/提供商选择事件，不修改 `provider/model/reasoning/baseURL/凭据`，不做 fallback 路由。

## 设置页

安装后在 **Plugins（插件）面板 → 本 bundle 的 `llm-resilience` 行 → 配置**（keyed slot `plugins.row.config`，key = `dsh-llm-resilience#llm-resilience`）打开：

- 本插件默认值与开关（启用、启动补齐、默认空闲超时、基础重试默认值、升级续重试次数/等待）；
- 每个 `llm-pi-ai` provider 路由的空闲超时、基础重试次数、可重试错误码、可选总超时；
- 「应用推荐值到全部提供商」一键写入 30000ms 与上游默认重试策略。

写入前做本地校验，非法值不会发给 Host；Host 拒绝（例如 revision 冲突）时页面显示失败提示而不会写入坏值。

## 安装

本包**不包含安装脚本，也不会自行安装**。由用户批准后，用 DSH 的 plugin_manager 以本地目录安装（安装会写入 profile 并激活，可能需要刷新页面）：

```
plugin_manager action=install_bundle target=~/Documents/项目/dsh/dsh-llm-resilience
```

也可以按 `cordis.patch.yml` 注释里的手动方式，在 profile 的 `cordis.patch.yml` 中 insert 一行：

```yaml
- insert:
    - id: llm-resilience
      name: dsh-llm-resilience
```

### 本地 link 包的运行期依赖

`install_bundle` 以 `link:` 方式登记本地目录，Host 会从本包的真实路径 import，因此运行期依赖必须在包目录内可解析。本插件只依赖 `@deepseek-ai/schemastery`（Config schema），本机已建立软链：

```sh
node_modules/@deepseek-ai/schemastery -> <profile>/node_modules/@deepseek-ai/schemastery
```

换机器/换 profile 时，在该目录执行 `pnpm install --prod`（或建立等价软链）后再启用，否则 Host 会报
`Cannot find package '@deepseek-ai/schemastery'` 且该行不会激活。若后续把插件改为不依赖外部包，可去掉这一步。

卸载后已写入 profile 的超时/重试值会保留在用户配置层，用下面的自检脚本可以发现并清理。

### 停用（装了不加载）

插件有两种"不启用"的形态，都会让 dsh 正常启动、不产生任何 patch 告警：

| 形态 | 做法 | 效果 |
|---|---|---|
| 行级禁用（推荐临时停用） | bundle 保留在 `dsh.profile.bundles`，profile patch 里写 `- id: llm-resilience` + `disabled: true` | 行仍在组合树里，id 始终存在；插件不加载、不补齐、不做升级续重试 |
| 只留依赖（推荐长期不用） | 从 `dsh.profile.bundles` 移除 `dsh-llm-resilience`，保留 `dependencies` 里的链接 | bundle 层不应用，Host 与浏览器半边都不会加载 |

**唯一的告警来源**：设置页保存过配置后，DSH 的 `configEditor` 会在 profile 用户层写一项

```yaml
- id: llm-resilience
  name: dsh-llm-resilience
  config: { ... }
```

这是 DSH patch 模型的通用行为（任何"保存过配置的 bundle"被取消选中都会这样），不是本插件的运行时代码产生的：插件未加载时没有任何代码在执行。目标行不存在时，Loader 每次启动打印
`patch: entry "llm-resilience" not found` 并丢弃该段。

自检与修复：

```sh
node scripts/smoke.mjs --profile web        # 发现残留 → FAIL 并打印产生告警的原因
node scripts/smoke.mjs --profile web --fix  # 精确删除残留段（先写 .bak-<时间戳> 备份，再原子替换）
```

`--fix` 只删除第 0 列的 `- id: llm-resilience` 覆盖块，不会碰 `insert:` 里的子项，也不会动其它行。


## 开发与验证

```sh
npm test          # node --test：纯策略、升级处理器、包结构、真实 Cordis 顺序、安装版 llm-pi-ai schema、profile 状态分析
npm run check     # node --check 所有 JS
node scripts/smoke.mjs             # 静态包结构 smoke（不读写 profile）
node scripts/smoke.mjs --profile web   # 安装后检查 profile；自动区分"已启用/未启用"两种形态
node scripts/smoke.mjs --profile web --fix  # 清理"未启用"形态下会让 dsh 启动告警的残留配置
```

## 文件结构

```
package.json           ESM bundle manifest（dsh.bundle.patch + dsh.client.web）
cordis.patch.yml       bundle 行：id=llm-resilience
lib/index.js           Host 插件：Config、启动补齐、agent/request-error 接线
lib/policy.js          纯策略引擎：默认值、失败分类、退避、决策、文案
lib/escalation.js      升级续重试处理器：原生事件复用、可取消等待、状态
lib/client.js          浏览器配置页（ModuleLoader 动态模块，无构建步骤）
locale/{en,zh}.json    插件显示元数据
icon.svg               原创图标
tests/                 node --test 测试
docs/IMPLEMENTATION.md 实现映射、安装行、不变量与验证清单
scripts/smoke.mjs      安装后 smoke 检查脚本（--profile / --fix）
scripts/profile-state.mjs  profile 状态分析与孤儿 patch 精确删除（纯函数，可单测）
```

## 已知限制

- 超时与重试的「实际执行者」是上游 `llm-pi-ai`（idle watchdog）与 `llm-retry`（重试执行器）；本插件负责策略、默认值补齐、升级层与设置页。若 composition 未装配这两个包，对应能力不生效（升级层会退化为仅日志）。
- 升级续重试只对 `llm-pi-ai` provider 的失败生效于当前 composition；升级层的可见通知依赖 `llm/retry` 事件被当前 composition 注册（headless 可能没有 UI，但事件仍写入）。
- 单步内升级次数按 `agent + turn + step` 计数，step/turn 变化自动清零；插件重启后计数清零。
- 30s 是**每次 read 的空闲上限**：长 prefill 的慢路由可能需要在设置页按 provider 单独放宽。
- 本插件不管理 `llm-deepseek` 等其它适配器的超时（可在后续版本扩展 `providerNamespaces` 配置）。

## License

MIT
