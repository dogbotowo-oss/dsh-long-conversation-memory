# dsh-long-memory

DeepSeek Harness（DSH）长会话记忆插件。

## 简介

`dsh-long-memory` 为 DSH 会话提供面向 100–1000+ 轮的持久、证据优先的长对话记忆：记录宿主已提交的会话事件，用确定性规则抽取事实、决定、更正与当前任务状态，把启用的 skill 索引为带版本的规则，并在每个模型步骤前按 token 预算注入一小段标注为"证据"的上下文。插件不额外调用模型、不修改宿主会话日志，所有数据以 SQLite 保存在本地。它面向的是这样一类会话：早期指令、精确数字、更正与未完成的线索，本会被压缩、摘要或重启冲掉；效果由离线长会话评测与两种基线对照测量（见[评测结果](#评测结果实测)）。

已在 **DSH 0.2.1-rc.3** 上验证。全部数据留在本机。

## 功能

- **捕获**（capture）：把宿主已提交的会话事件（用户/助手消息、工具调用与结果、压缩事件、命令）写入本地只追加的 SQLite 证据表。按事件序号幂等，因此重试、重启与重放不会产生重复数据。
- **抽取**（extract）：用确定性规则从用户消息中抽取记忆项，不调用模型。事实、决定、约束、偏好、未解决问题分别存储；数字与单位和限定条件一起存；助手的话只作为*建议*保存。
- **索引 skill 规则**：把规则分成四类——稳定规则（stable rule）、数据口径（data convention）、当前状态（current state）、经验教训（operational lesson），并让"当前状态"保持动态：它是上下文，永远不会被当成固定的校验规则。
- **检索**（retrieve）：用 SQLite FTS5（trigram）加 LIKE 兜底，按精确命中、scope、近因加权，作用域限定在当前会话。
- **组装**（assemble）：在 token 预算内生成一条 user 角色的证据消息，顺序确定，并记录哪些部分被包含、截断或省略以及原因（`memory explain`）。
- **校验**（validate）：可选地执行确定性检查与前置条件，并带有限次数的修复提醒。默认关闭，且从不猜测。
- **与压缩协作**：宿主压缩表面（surface）后，下一步从本地证据重新组装；插件从不改写宿主会话日志。

## 设计优先级：准确性优先于节省 token

token 效率重要，但不是第一目标。本插件偏好：

- 正确、可核验的记忆，而不是更短的摘要；
- 保留原始证据，而不是无法审计的派生结论；
- 明确说"未知 / 未检索到"，而不是编造回忆；
- 冲突时保留两方并记录替代关系，而不是悄悄选一个；
- 已验证的宿主接口，而不是看起来正确的接口。

注入的记忆消息有明确预算（默认软预算 3000 估计 token），但预算限制的是*注入多少*，不是*是否保存证据*。

## 工作方式

```
DSH 步骤边界
  agent/pre-step ──► 检索 ──► 组装 ──► 注入 user 角色证据消息
                                          │
session/event（已提交）──► 捕获 ──► 抽取 ──► 校验（可选）
                                          │
                                      组装日志
```

1. **捕获**（`src/capture.js`）：把宿主已提交事件转成 `events` 行：规范化文本、来源种类、turn/step、工具名、内容哈希，以及表示原文能否从宿主日志重放的 `store` 列。大体量工具结果与压缩摘要会在宿主可能无法重放时额外归档。
2. **抽取**（`src/memory/extraction.js`）：从 `checkpoints.last_extract_seq` 游标增量执行。创建记忆项、识别用户显式更正、合并带标签的任务状态行（`Goal:`、`Progress:`、`TODO:` 等）。抽取失败进入 `pending_extraction` 重试队列；原始证据永不丢弃。
3. **Skill**（`src/skills.js`）：把 skill 内容快照成版本化记录，并把规则文件解析成分类的 `rules`。
4. **检索**（`src/retrieval.js`）：为当前步骤给活跃记忆项、规则和证据打分排序。
5. **组装**（`src/assembly.js`）：构建注入消息：稳定头部、常驻规则核心、任务状态、相关规则/记忆项与证据片段，并适配预算。`memory explain` 报告每个部分的取舍。
6. **校验**（`src/validation.js`）：对已提交的助手输出应用配置的确定性检查；可选地在分发前检查前置条件。
7. **诊断**（`src/diagnostics.js`）：报告 schema、计数、检查点滞后、兼容性与完整性。

模块表、存储 schema 与写入原则见 [docs/architecture.md](docs/architecture.md)。

## 环境要求

- **DSH 0.2.1-rc.3**（`@deepseek-ai/cordis` 4.x）。
- **Node.js 22.15+ 或 24+**，用于 `node:sqlite`；支持 CJK 的 FTS5 `trigram` 分词要求 Node >= 22.5。包的 `engines` 声明为 `^22.15.0 || >=24.0.0`。
- Windows、macOS 或 Linux。插件本身不需要原生构建：SQLite 来自 Node 运行时（`node:sqlite`）。

## 安装

在本仓库的检出目录中：

```sh
dsh plugin --profile <profile> add <path-to-plugin>
```

把 `<path-to-plugin>` 换成该仓库的检出路径。包内自带 `cordis.patch.yml` 的 bundle patch，`package.json` 中声明了 `dsh.bundle.patch`，因此添加包即可，没有单独的构建步骤。也可以直接从 GitHub 安装：

```sh
dsh plugin --profile <profile> add github:dogbotowo-oss/dsh-long-memory
```

安装后在某个会话中运行：

```
memory status
```

确认插件已加载、数据库已打开、schema 版本一致。

## 配置

所有键都可选；缺省使用 [`src/config.js`](src/config.js) 中的默认值。完整示例见 [`examples/config.json`](examples/config.json)。

```json
{
  "enabled": true,
  "dataDir": "",
  "dbFile": "memory.sqlite",
  "includeSubagents": false,
  "assembly": {
    "enabled": true,
    "softBudgetTokens": 3000,
    "minBudgetTokens": 600,
    "maxMemoryItems": 40,
    "maxRules": 12,
    "maxEvidence": 8,
    "evidenceTypes": ["user/message"],
    "skipWhenEmpty": true,
    "reinjectUnchangedTurns": 0,
    "includeTaskState": true
  },
  "extraction": {
    "enabled": true,
    "immediateCorrections": true,
    "scanUserMessages": true,
    "recordAssistantProposals": true
  },
  "retrieval": {
    "limit": 24,
    "exactMatchBoost": 3,
    "scopeBoost": 2,
    "recencyBoost": 0.5,
    "minScore": 0.5
  },
  "compatibility": {
    "compactionPolicy": "auto",
    "reinjectAfterCompaction": true,
    "reportUnknownCompatibility": true
  }
}
```

主要分组：

| 分组 | 用途 |
| --- | --- |
| `enabled`、`dataDir`、`dbFile` | 总开关与数据库位置。`dataDir` 为空表示 `<DSH_HOME>/long-memory/`。 |
| `assembly` | 注入消息预算（`softBudgetTokens`）、各部分上限与重新注入策略。`evidenceTypes` 决定哪些原始事件类型可以被逐字引用；默认 `["user/message"]`，工具输出（不可信、可能含注入内容）仍会存储和可搜索，但默认不粘贴进请求。 |
| `extraction` | 确定性抽取开关；`recordAssistantProposals` 控制是否保存助手建议。 |
| `retrieval` | 候选数量上限与排序加权；`minScore` 过滤弱命中。 |
| `validation` | 确定性 `checks` / `preconditions`、`maxRepairAttempts`、`blockOnViolation`。 |
| `commands` | 斜杠命令注册、命令名（默认 `memory`）与可选的模型工具。 |
| `compatibility` | 压缩协作策略（`auto` / `compaction-basic` / `billion-context` / `none`）。 |
| `diagnostics` | 详细日志与组装日志保留条数。 |
| `archive` | 对宿主可能无法重放的原文做选择性归档。 |
| `skills` | skill 包含/排除、常驻核心与单条规则长度上限。 |

未知键会被保留；数值会被钳制到安全范围（例如 `softBudgetTokens` 为 200–20000），避免笔误产生退化预算。

## 命令

插件注册 `memory` 斜杠命令（可用 `commands.name` 改名；`commands.register: false` 可关闭注册）。

| 命令 | 作用 |
| --- | --- |
| `memory status` | 数据库路径、会话 id、事件/记忆/规则/skill 计数、检查点、软预算、最近装配，以及压缩兼容性一行。 |
| `memory inspect <id>` | 单条记忆：类型、证据级别、状态、内容、条件、范围、来源引用、替代关系、数字、修订历史与原文证据。 |
| `memory search <query>` | 在记忆项与已捕获证据中做关键词搜索，返回分数、条件与来源事件引用。 |
| `memory explain` | 上一条注入消息为何长这样：触发、步骤、预算、token 来源、各部分裁剪、被包含/省略的条目及原因。 |
| `memory retract <id> [原因]` | 撤回一条记忆项：状态变为 `retracted`，退出检索，但保留在审计轨迹中。 |
| `memory export [--events]` | 把本会话记忆打印为 JSON；`--events` 额外包含已捕获的原始事件。 |
| `memory purge` | 从本地数据库不可逆地删除**本会话**记忆（含索引与派生数据）。宿主会话日志不受影响。 |
| `memory help` | 显示帮助。 |

输出刻意使用纯文本，便于复制到问题报告。`memory status` 同时也是兼容性检查：报告检测到的压缩策略，并在无法确认兼容性时给出警告。

## 数据与存储

- 每个 DSH home 一个 SQLite 文件：`<DSH_HOME>/long-memory/memory.sqlite`（可用 `dataDir`/`dbFile` 覆盖）。通过 `node:sqlite` 以 WAL 模式打开。
- 表：`events`、`memory_items`、`memory_events`、`task_state`、`checkpoints`、`skill_versions`、`skill_files`、`rules`、`rule_overrides`、`assembly_logs`、`validation_logs`、`archive`、`pending_extraction`、`sessions`、`meta`，外加两个 FTS5 索引。
- `events` 是完整审计记录：宿主提交的事件都会保存（包括其他插件注入的生成上下文，按 `source.kind` 区分）。"什么算证据"由各消费方执行：抽取只取真实用户输入，检索过滤生成上下文，组装默认只逐字引用 `user/message`。因此工具输出可搜索但默认不进入请求。
- 原始证据只追加。派生索引可重建；修订流程从不删除记忆行（撤回是状态变更；purge 是显式且不可逆的命令）。
- 无遥测、无网络请求。插件不自己调用模型，也不会把任何记忆内容发往别处。
- 插件从不写宿主会话持久化数据库、从不编辑宿主会话日志、也不碰其他插件的存储。

## 记忆写入原则

1. 原始证据不可变：摘要只是索引，不是替代品。
2. 建议永远不会被自动提升为决定。
3. 数字与单位和限定条件一起保存。
4. 更正创建新条目并替代旧条目；被替代关系被记录，而不是抹除。
5. 冲突时双方都可见，直到用户决定解决。
6. 写入按会话事件序号幂等。

这些原则在存储层（`src/memory/store.js`）执行，详见 [docs/architecture.md](docs/architecture.md#记忆写入原则)（英文）。

## 评测结果（实测）

离线评测（`node scripts/eval.mjs --profile full`）在带独立答案表的种子合成会话上比较三种基线：仅 skill、skill + 滚动摘要、本插件。各项指标分开报告，不合并为单一分数。测量时间 2026-10-31，Node v24.19.0，种子 `dsh-long-memory-eval-v1`（6 个会话，100/200/500/1000 轮，68 个问题）：

| 指标 | 仅 skill | skill + 滚动摘要 | 本插件 |
| --- | --- | --- | --- |
| 存储正确性（答案表断言） | 不适用 | 不适用 | **100.0%**（338/338） |
| 检索召回 / 首位命中 | 不适用 | 不适用 | **84.0% / 76.5%** |
| 组装覆盖率 | 46.0% | 46.0% | **86.2%** |
| 每问额外 token（估计） | 352.0 | 546.7 | 1154.8 |
| 延迟 均值 / p95 | 0.0 / 0.0 ms | 0.0 / 0.0 ms | 14.1 / 37.6 ms |
| 规则覆盖 / 任务状态准确率 | 100.0% / 不适用 | 100.0% / 不适用 | 100.0% / 100.0% |
| 守卫通过率（禁用/必须出现的术语） | 100.0% | 100.0% | 100.0% |
| 硬性不变量 | 不适用 | 不适用 | **9/9 通过** |

本插件注入的 token 约为基线的 2.1–3.3 倍，覆盖的答案表条目约为 1.9 倍；延迟为本地毫秒级，且不额外调用模型。token 数按字符估算，默认不对模型回答质量作任何声明（确切协议、分尺寸明细与可选 LLM 回答评测见 [docs/evaluation.md](docs/evaluation.md)）。1000 轮长会话由 `full` 配置覆盖：从 100 到 1000 轮，组装覆盖率稳定在 85.4%，而基线稳定在 46.3%。

## 已知限制

- **不承诺零遗忘。** 它是记忆辅助，不是证明系统：从未说出口、从未被捕获、或在插件看到之前就被宿主裁剪掉的内容无法恢复。检索也可能漏掉相关条目。
- **语义检索预留但未实现。** v1 检索基于关键词（FTS5 trigram + LIKE）加确定性加权。语义 provider 接缝存在，但默认关闭。
- **仅确定性抽取。** 抽取依赖标记与模式，会把一些噪声当成记忆，也会漏掉一些改写。
- **token 数是估计值。** 组装器按字符数（CJK 感知）估算，而不是模型分词器。`assembly_logs` 记录 `token_source: estimate`。
- **校验默认关闭且保守。** 只执行你配置的检查，默认只报告不阻断。
- **压缩行为取决于所用宿主策略**——见 [docs/compatibility.md](docs/compatibility.md)。绕过 DSH 事件模型重写请求体的代理无法被观测，插件会报告为"未验证"，而不是猜测。

## 隐私

- 所有数据留在本地：DSH home（或你配置的 `dataDir`）下的 SQLite 文件。
- 无遥测、无分析、无网络请求、无模型调用。
- 插件不会把记忆内容发往任何地方；它只被注入当前会话自己的模型上下文，和其他 DSH 消息一样。
- 导出/清除都是本地命令。`memory purge` 对插件数据库不可逆，但不修改宿主会话日志。

## 兼容性

- 已在 DSH **0.2.1-rc.3** 上验证。
- 可与 `compaction-basic` 共存；插件在压缩事件后重新组装，且从不修改宿主日志。
- 当类似 `billion-context` 的压缩器禁用串行 pre-step 监听或对压缩设门控时，插件会从事件流中检测策略并在 `memory status` 中报告。所用公开 API 与"有意不验证"的内容见 [docs/compatibility.md](docs/compatibility.md)。

## 开发

```sh
node --test "tests/unit/*.test.mjs" "tests/integration/*.test.mjs" "tests/replay/*.test.mjs"  # 全部测试
node scripts/check.mjs                     # 8 项结构/行为自检，含完整端到端冒烟测试
node scripts/eval.mjs --profile full       # 离线长会话评测
```

Node 24 在部分平台上会把目录形式的 `node --test <目录>` 当作模块执行，因此请使用上面的 glob 形式（`npm test` / `npm run check` 已内置）。

评测协议（三种基线、100/200/500/1000 轮会话、存储/检索/组装/回答/token/延迟分开报告）见 [docs/evaluation.md](docs/evaluation.md)。测试与示例使用的合成 skill 位于 [`examples/synthetic-skill/SKILL.md`](examples/synthetic-skill/SKILL.md)。

## 许可证

MIT——见 [LICENSE](LICENSE)。
