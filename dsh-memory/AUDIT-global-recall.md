# 审计：为什么「标成全局」的记忆，跨会话 / 跨项目还是会忘

> 对象：`dsh-memory` v0.4.2 · 真实记忆库 `C:\Users\17915\.dsh\memory\memory.db`（130 条）
> 日期：2026-10-23 · 方法：真实库快照 + 代码路径阅读 + 可复现实验（脚本见 §7）

## 0. 结论先行

**不是单点 bug，是四层叠加的系统性失效。** 一句话概括：

> 写入侧几乎不产出全局行（95 条抽取结果全部是项目级），改写侧会把全局行降级成项目行，
> 读取侧三道闸门（词法命中 / 每会话一次 / 必须有文字）都在过滤全局事实，
> 而人格层从不生成全局人格 —— 于是「标了全局」在大多数会话里等于「没标」。

**最锋利的一条实测**：库里唯一那条 global 行（#104）跨项目可见性 **100% 由 `pinned=1` 撑着**。
把 pinned 去掉、其余一律不动：60 个（项目 × 短句）格子里它可见 **0/60**；20 条真实短句里词法命中 **0/20**。
换句话说，`scope='global'` 在实现里只是「不限项目」，**并不等于「每轮生效」**——
一个 global 但既不 pinned、也不是高优先 persona/instruction 的偏好，没有任何通道能进入上下文。
这是本次审计最重要的结论，也解释了为什么「我明明标了全局」和「它还是忘了」可以同时成立。

| 层 | 机制 | 现状 |
| --- | --- | --- |
| 写入 | 抽取器没有 `scope` 概念，一律按当前项目落库 | 95/95 抽取结果是 `project`；唯一的 global 来自手工工具（#104） |
| 改写 | `update`/`merge` 用**当前会话的项目**覆盖目标行的 scope | global 行被改一次就变成某个项目的私有行 |
| 读取 | 全局事实走**词法召回**（问候语零命中） | 10 条真实查询里 9 条检索不到任何 global 行 |
| 读取 | 全局通道**每会话只开一次**，首轮没命中就整场关闭 | 开场是「你好啊」→ 这一整场都不再看全局 |
| 读取 | `query === ''` 直接 return | 只发图片/附件的轮，连画像与约定都不注入 |
| 人格 | `putPersona` / `upsertScene` 只写 `scope:'project'` | 3 条人格全是项目级；只有 dsh 那份写了「官人」 |

## 1. 链路：一条全局记忆要活下来，得穿过什么

```text
写入     extract(L1) ──► applyDecision ──► memory 行(scope=?)
                          ↑ 用当前会话 project 覆盖（降级/升格都在这里）

读取     agent/pre-step
          ├─ isSubagentSession?     跳过
          ├─ injectedTurn == turn?  每轮一次
          ├─ isHumanTurn?           非人类轮跳过
          ├─ query == ''?           旧版直接 return（连 stable 都不注入）
          ├─ stable 段（每会话一次）: core 记忆 + L3 人格 + L2 场景导航（预算 1800 字符）
          ├─ globals 段（旧版每会话一次）: recall(scope=global) —— 必须是词法命中
          └─ dynamic 段（每轮）: recall(scope=project) —— global 行参与，但得分低 0.06
```

三道闸门的共同点：**它们都以「当前这句话里有没有匹配的字词」为前提**，而「你是谁、该怎么称呼我」恰恰是
和提问内容无关的偏好。这就是症状集中在「开场寒暄」「换个项目」「换台机器开会话」的原因。

## 2. 失败模式清单（M1–M10）

| # | 机制 | 触发条件 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| M1 | 全局事实靠词法召回 | 提问与偏好文本零字词重叠（问候、寒暄、短追问） | 10 条查询 × 真实库：仅「官人今天心情如何」命中 #104，其余 9 条 global 命中 0 | ✅ 已修：`coreMemories()` 按行属性注入 |
| M2 | 全局通道每会话只开一次 | 首轮没命中 → `globalsInjected=true`，整场不再查 | 旧 `index.js` 在通道末尾无条件置位；实验：首轮「你好啊」后第二轮命中也不注入 | ✅ 已修：每轮重查 + 会话内按 id 去重 |
| M3 | 无文字轮整体跳过 | 只发图片/附件、消息内容无 `text` 块 | `capture.js:25` 的 `extractText` 对 `{type:'image'}` 返回 `''`；旧 `if (query === '') return` | ✅ 已修：stable 段不看 query |
| M4 | 改写把 global 降级为 project | L1 去重判定 `update`/`merge` 命中一条全局行，且当时在某个项目里 | 实验：`scope=global,pinned` → 改写后 `scope=project,project=menm`，从 dsh 查询不到 | ✅ 已修：`l1.js:193-194` 继承目标行 scope |
| M5 | 无 cwd 会话把项目事实升成 global | 会话没有 cwd（`project === null`）时的抽取/工具写入 | `applyDecision` 旧逻辑 `scope = project === null ? 'global'`；实测 `project row + 无 cwd 改写 → scope=global` | ✅ 已修：新行 global 时 `project=null`，改写继承原 scope |
| M6 | 幽灵行：`scope=project` 且 `project IS NULL` | 保存时拿不到项目键（如 cwd 是盘符根） | 库中现网 1 条（#5）；所有读取 SQL 都带 `project = ?`，永不命中 | ✅ 写入侧已修（转 global）；存量待人工清理 |
| M7 | 抽取器零全局产出 | 任何一次 L1 抽取 | 95 条 `source=extract` 全部 `scope=project`；唯一 global #104 的 `source=tool` | ✅ 已修：抽取契约新增 `scope` 字段（仅 persona/instruction 可用） |
| M8 | 人格层从不生成全局人格 | 新项目第一次会话 | `l3_persona` 3 条全 `project`；只有 dsh 那份含「官人」，menm/novel-ai 不含。新项目首份画像会吸收 global 事实，但要等**一次抽取批次 + 下一个会话**才注入；既有项目还要过 `triggerEveryN`(10) + 门控 | ⚠️ 未修（理由见 §5）；批次计数器已按项目隔离，缓解了跨项目互相拖延 |
| M9 | 打分对 global 略低 | 同分候选竞争注入位次 | `recall.js:119`：global 的 `projectMatch=0.6`，同项目行 1.0，权重 0.15 → 差 0.06 | ⚠️ 未修（实测 0/10 影响，见 §3.3） |
| M10 | 同一偏好被抽取成多份拷贝 | 每个项目各自抽到同一偏好 | 已清理 4 条（#106/#107/#116/#117）；**本会话期间又新增 #123**（menm、persona、p95） | ⚠️ 部分缓解（抽取侧 global + 提示词），无自动合并 |
| M11 | 冲突消解看不到手工保存的行 | 候选按 `L1_KINDS` 过滤，而 `memory_save` 写的是 v1 的 `fact`/`note` | #104 是 `kind=fact` → 从不在候选里 → 永远不会被合并/跳过，#123 才会被反复重建 | ✅ 已修：候选 kind 增加 `fact`/`note`（episode 仍排除） |
| M12 | 无 cwd 会话读遍所有项目 | `searchFts/searchLike` 仅在 `options.project` 为真时才加 scope 过滤 | 实测 `recall(project=null)` 对 dsh 语境查询返回 6 条 menm 行 | ✅ 已修：`scope='project'` 且无项目键 → 只看 global |
| M13 | 同一条约定一轮注入两次 | stable 段的 core id 没有种进 `state.globalIds` | 实测「官人」「称呼」等查询每次多 291 字符的重复块 | ✅ 已修：stable 渲染后把 core id 一并种进会话集 |
| M14 | 画像批次计数器是全局的 | `l3-batches` 由任一项目清零 | menm 画像停在 v1、落后事实 16.9 小时；跨项目互相 `deferred` | ✅ 已修：改为 `l3-batches:<project>` |
| M15 | 弱词法命中比没命中还差 | `textScore = bm25/8`，`|rank|<1.2` 时低于无 bm25 的 0.15 基线 | 代码路径 `recall.js:116` | ✅ 已修：`textScore` 下限钉在 0.15 |
| M16 | 无文字轮用上一轮的问题检索 | `userTextOf` 回退到日志里最后一条非空消息 | 附件轮实测注入 2900 字符、内容是上一个问题 | ✅ 已修：本轮有人类消息就用它的文本（哪怕是空串） |

## 3. 量化证据

### 3.1 全局层有多空

```sql
SELECT source, scope, COUNT(*) FROM memory GROUP BY 1,2;
-- extract | project | 95      ← 自动抽取：零全局
-- turn    | project | 30      ← 会话 episode
-- tool    | project |  3
-- manual  | project |  1
-- tool    | global  |  1      ← 唯一一条全局：#104（人工 memory_save + pinned）
```

**130 条记忆，全局层只有 1 条。** 用户以为「我标记了全局」，实际上除了那一次手动置顶，抽取流水线
从来没有产出过全局行——这是「跨项目忘记」最上游的原因。

### 3.2 词法闸门的命中率

真实库快照，10 条贴近真实提问的短句，`recall(scope=global)`：

| 命中 global 的查询 | 未命中（9 条） |
| --- | --- |
| 「官人今天心情如何」→ #104（rank 2） | 你好啊 / 今天做什么 / 这个仓库怎么构建 / 发布流程是什么 / 记忆库在哪 / dsh-memory 的向量是怎么算的 / 生产库能不能写 / 修改一个插件要重启吗 / 帮我看看测试 |

命中率 **1/10**。原因是结构性的：偏好类文本（「称呼」「语气」「温柔」）几乎不会出现在任务型提问里。

### 3.3 global 与 project 的打分差

`scoreRow` 里 `projectMatch`：global = 0.6，同项目 = 1.0，权重 0.15 → **0.06 的分差**。
在 10 条查询上逐条重算「若把分差补上，会不会改变第 6 名入选线」：**0/10 改变**。
结论：分差是理论上的不公，但在当前数据规模下不是致因，不值得为此调参（见 §5）。

### 3.4 降级链的实测（M4）

```text
before : {"id":1,"scope":"global","project":null,"pinned":1,"version":1}
decision: {"op":"update","id":1,"version":2}
after  : {"id":1,"scope":"project","project":"menm","pinned":1,"version":2}   ← 全局变项目
visible from project dsh: null                                                 ← 换项目即消失
merge target after: {"id":2,"scope":"project","project":"dsh"}                 ← merge 同样降级
project row updated with project=null: {"id":3,"scope":"global","project":null} ← 反向升格
```

### 3.5 会话进行中的活证据

今天这次会话里，抽取流水线又给「官人/妾身」偏好新建了一条项目级拷贝：

```json
{"id":123,"kind":"persona","scope":"project","project":"menm","priority":95,"source":"extract",
 "text":"用户要求：每轮回复都要称呼他为「官人」，助手自称「妾身」，语气温柔；该偏好为 global + pinned 记忆（priority 95）。"}
```

也就是说：即使知识在全局层（#104），抽取器仍会在每个项目里再造一份「本地版」——它不会让它「忘」，
但会让全局层与项目层长期分叉、互相覆盖。

### 3.6 唯一 global 行其实靠 pinned 活着（反事实实验）

| 条件 | 20 条真实短句 × 3 个项目 | 可见格数 |
| --- | --- | --- |
| #104 保持 `pinned=1` | 走 core 策略通道 | **60/60 = 100%** |
| #104 去掉 `pinned`（其余不动） | 只剩词法通道 | **0/60 = 0%** |

配套 sanity control：探针能命中「官人」「称呼与语气偏好」所在的文本，对「你好啊」返回 false（不是恒假）。
→ 结论：`scope='global'` 本身不带注入能力；跨项目「记得你」这件事，目前完全押在 `pinned` 上。

### 3.7 预算与槽位（为什么「排进去了也可能被挤掉」）

- 真实查询「记忆库 memory.db 在哪」在 menm 下 **42 条候选**过 `minScore`，最终只留 6 条（1016 字符）。
- 字符预算常先于条数生效：episode 行被 `formatItem` 裁到 320 + 前缀 ≈ **347 字符**，1400 预算下**只装得下 4 条**。
- 0.06 的分差若要靠信号追平：需 Δbm25 **0.48**（可达）或 Δcos **0.60**（实测最高 0.218，不可达）。
- globals 段相对 dynamic 段的唯一贡献：60 个格子里 **0 条**——dynamic 的 SQL 本就包含 global 行，
  globals 段的价值只在「独立预算 + 独立措辞（长期偏好）」，不在可达性。

## 4. 本次修复

| 位置 | 改动 |
| --- | --- |
| [src/store.js](src/store.js) `coreMemories()` | 新增「按行属性取」的通道：`pinned=1` 或 `persona/instruction && priority>=85`，不受词法影响 |
| [src/recall.js](src/recall.js) `renderStableBlock()` | stable 段首位新增 `### 长期约定（每轮都要遵守，优先级最高）`，core 段硬预算 = 块预算 60% |
| [index.js](index.js) pre-step | ① stable 段不再依赖 query/L2/L3；② 全局段**每轮**重查、会话内按 id 去重；③ 无文字轮仍注入 stable |
| [src/l1.js](src/l1.js) `applyDecision()` | 改写继承目标行 scope（显式 `decision.scope` 才可迁移）；新行 global 时 `project=null` |
| [src/store.js](src/store.js) `saveMemory()` | `scope=project` 但没有项目键 → 按 global 落库，不再产生幽灵行 |
| [src/extract.js](src/extract.js) | 抽取契约新增 `"scope":"global"`（仅 persona/instruction 生效），跨项目偏好直接进全局层 |
| 提示词 | 抽取/去重各加一条：跨项目偏好写通用表述；候选含全局行时等价即 `skip`/`merge` |
| [src/l1.js](src/l1.js) `findCandidates()` | 候选 kind 纳入 `fact`/`note`——否则手工保存的偏好永远不参与冲突消解 |
| [src/store.js](src/store.js) `searchFts` / `searchLike` | 无项目键的会话只看 global 行，不再「读遍所有项目」 |
| [index.js](index.js) `userTextOf()` | 本轮有人类消息就用它（哪怕是空串），不再回退到上一轮的问题 |
| [index.js](index.js) stable 段 | core id 同时种进 `state.globalIds`，同会话不再重复注入 |
| [src/consolidate.js](src/consolidate.js) `runPersona()` | 画像批次计数器按项目隔离（`l3-batches:<project>`） |
| [src/recall.js](src/recall.js) `scoreRow()` | 弱 bm25 命中的 `textScore` 下限钉在 0.15，避免「弱匹配劣于无匹配」 |
| `memory_save` 工具 | 返回值提示「global ≠ 每轮注入，要 pinned」；description 同步写清语义 |

数据侧整改（改前备份 `.tmp/live-backup-20261023-085530.db`）：

- #104（唯一全局行）补「自称妾身」、priority 50→95、version 2，旧文本进 `memory_history`；
- #106/#107（menm）、#116/#117（dsh）四条平行偏好 → `superseded_by=104`；
- 回归：`108 → 112` 项测试全绿（新增 `test/core-inject.test.js`、`test/scope-drift.test.js`、`extract` 的 scope 用例）。

## 5. 没修的三项，及理由

1. **M9 打分差（global 0.6 vs project 1.0）**：实测 0/10 影响入选线。改权重会牵动既有的召回精度
   评测（README §效果实测），收益不抵风险；留作可调项，若将来全局行增多再评估。
2. **M8 全局人格**：`runPersona` 只写项目级人格。补一条全局人格需要跨项目汇总 + 一次额外 LLM 调用，
   而 core 层已经把「每轮都要遵守」的偏好逐轮注入，全局人格的边际收益很低。设计上判断：
   人格 = 「这个项目怎么干活」，约定 = 「怎么对待用户」，后者已由 core 层承担。
3. **M10 自动去重**：试过 3-gram 包含度做「全局孪生」判据，**不可分**——真重复 #123 = 0.19，
   而无关的 episode（#105、#115）= 0.15~0.19。余弦相似度同样不可分（#106 = 0.151）。
   因此不加启发式阈值，改为「抽取侧直接产出 global + 去重提示词 + 定期人工 curation」。
4. **不把 `global` 自动等价成 `pinned`**：这条路最省事，但会让「项目事实被误标 global」的噪音
   每轮注入。选择把语义写清（global = 不限项目，pinned = 每轮注入），并在 `memory_save`
   的返回值与工具描述里提示，由保存方决定；core 通道仍无条件收 `persona/instruction ≥85`。

## 5.1 复核（独立上下文的两名审计员）

- **闸门量化**：20 条真实短句词法命中 0/20；去掉 pinned 后 0/60；Δ 分差精确 0.0600；
  6 槽位实验里 global 稳定排第 7 被淘汰、加 pinned 直接 rank 1；HEAD（无 core 层）在 6 轮会话里
  #104 只出现 1/6 轮，当前 2/6 轮。
- **数据层**：`update/merge` 降级在 HEAD 上可复现但现网未触发（唯一 global 行恰好是 `kind='fact'`，
  被候选 kind 过滤「意外救下」——这条正是 M11 的另一面）；幽灵行 1 条；persona/scene 0 条 global；
  menm 画像落后事实 16.9 小时；`textSimilarity` 真实数据最高 0.575，永远够不到 0.75 去重线。
- 两人都只读真实库（`mode=ro` + `backup()`，实验前后 sha256 一致），实验库全在 mkdtemp。

## 6. 残留数据债（本轮已清）

| 项 | 内容 | 处理 |
| --- | --- | --- |
| #5 | 幽灵行（scope=project、project=NULL），内容为安装方式 | 已补 `project=menm`，幽灵行归零 |
| #123 | 项目级拷贝（persona、p95，本会话中由抽取器新建） | 已标 `superseded_by=104` |
| #124 | 「发布策略选 C」与 #83 同文重复（p85） | 已标 `superseded_by=83` |
| #118/#119 | 关于「该偏好是全局规则」的元描述 | 保留（有帮助），不进 core |
| 寒暄 episode | #2/#94/#111 等「你好」会话 | 未动（按 curator 建议：30 天未召回再清） |

清理后库况：130 条 / pinned 1 / superseded 6 / global 1 / 幽灵行 0。

## 7. 复现方式

```powershell
# 快照（真实库 WAL 未 checkpoint，直接 copy 会拿到旧内容）
python -c "import sqlite3;src=sqlite3.connect(r'C:\Users\17915\.dsh\memory\memory.db');dst=sqlite3.connect(r'.tmp/live-curated.db');src.backup(dst)"

# 注入回放：真实库快照 + 新注入链路，打印第一轮实际注入的消息
node notes/core-inject-replay.mjs

# 降级链实验 / 打分差实验 / 数据盘点
node .tmp/lead-audit/demote.mjs
node .tmp/lead-audit/score-gap.mjs
node .tmp/lead-audit/data-facts.mjs

# 回归
cd dsh-memory
node --test --test-isolation=none (Get-ChildItem .\test\*.test.js | % FullName)
```

> 说明：`.tmp/` 与 `notes/` 均在 .gitignore 内，属于本地取证产物，不随包发布。
