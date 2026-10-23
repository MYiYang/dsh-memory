# dsh-memory-layered

> npm 包名：`dsh-memory-layered`（`npm i dsh-memory-layered` / `dsh plugin add dsh-memory-layered`）；GitHub 仓库仍叫 `MYiYang/dsh-memory`。插件内部的注入命名空间 `plugin:dsh-memory`、日志标签 `[dsh-memory]`、技能与工具名都跟包名无关，不受影响。

给 **DeepSeek Harness (dsh)** 加**分层跨会话记忆**的本地插件，并**随包带 4 个 dsh 技能**（`dsh-plugin-dev` / `memory-curator` / `repo-audit` / `windows-pwsh-ops`：插件启动时用 `ctx.skills.registerProvider` 以 rank 600 注册，装插件即装技能，不用拷 `~/.dsh/skills`）：

- **L0 原文**：每轮完整落库（用户/助手文本 + 工具名），不可变、可重放；
- **L1 原子事实**：按 warm-up 阈值异步调用 LLM 抽取，带 kind / priority / version / 冲突消解（store / update / merge / skip）；
- **L2 场景块**：把同类事实归并成 Markdown 场景（summary + heat + 热度衰减），生成「场景导航」；
- **L3 画像**：项目画像 + 跨项目全局画像（偏好/约定/决策/环境），由 JEV-lite 判决门控，只在值得时重写；
- **召回**：稳定段（画像 + 场景导航，每会话一次）+ 动态段（本轮命中的 L1 事实）两段注入；检索是 **FTS5 + 本地 384 维词法向量** 的混合（倒排特征预筛 + 精确余弦，无需 embedding 服务）；
- **工具**：`memory_search` / `memory_save` / `memory_forget` / `memory_stats` / `memory_extract`。

零外部依赖：存储用 Node 自带 `node:sqlite`（FTS5 + trigram），向量是进程内 **feature hashing**（字符 n-gram + 英文词，384 维 Float32），
不需要 Redis / Docker / 向量库，也不需要 embedding API。设计文档见 [DESIGN-v2.md](DESIGN-v2.md)。

## 它做什么

| 时机 | 行为 |
| --- | --- |
| 每轮结束 | L0 落库一轮原文；调度器按 warm-up 阈值（1→2→4→8→everyN）+ idle 60s 决定是否入队抽取 |
| 抽取（异步串行） | 一次 LLM 做「场景切分 + 事实抽取」→ 候选召回 → 二次 LLM 冲突消解 → 写 L1（含 version/history） |
| L1 之后 | 按场景聚合事实 → LLM 归并场景块；每 `triggerEveryN` 批或 JEV 判决命中时重写画像 |
| 每轮首次请求前 | 首轮注入稳定段（画像 + 场景导航）；每轮注入动态段（FTS + 向量混合召回的 L1 事实） |
| 模型需要时 | 主动检索/固化/删除记忆；`memory_extract` 手动补跑一次抽取 |

原则：**记忆是上下文，不是指令**。注入块明确标注「可能过时、仅参考、不要复述」；
**不是每轮都调 LLM**——阈值 + idle 把成本摊薄；LLM 失败降级为「不记忆」，绝不影响会话。

## 安装

随包发布，**装插件就装了技能**。三条路径任选，完整步骤、参数表、故障表见 [INSTALL.md](INSTALL.md)：

| 路径 | 怎么装 | 说明 |
| --- | --- | --- |
| **A. GUI** | 侧栏「插件」→「添加插件」→ 输包名 → 重启 | 自动写依赖 + 选入 `dsh.profile.bundles`，不用手改 JSON |
| **B. CLI** | `dsh plugin --profile web add <包名>`，再把包名加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` → 重启 | **只 add 不激活**，漏了这一步重启也不会加载 |
| **C. 离线** | 解压 `dsh-memory-layered-<ver>.zip` → `pwsh -File .\install.ps1 -From .\dsh-memory-layered-<ver>.tgz`（默认 dry-run，加 `-Apply` 才写盘）→ 重启 | 内网/无 registry；脚本也能直接对源码目录用（`link:` + 拷技能） |

> 本文命令里的 `<包名>` 就是 npm 上的 **`dsh-memory-layered`**；`@yourscope/dsh-memory` 只是「若你改发 scoped 名」的占位写法。两种写法除了安装 spec 不同，别处完全一样。

三种方式的结果相同：profile 的 `package.json` 里有依赖、`dsh.profile.bundles` 里有它（写在数组末尾，顺序影响优先级）、`node_modules` 里是指向实际目录的链接。插件自带的 `cordis.patch.yml` 负责插入 `memory` 行——**不要**再在 profile patch 里手写同 id 的 insert，否则 duplicate entry id。

> 装完**重启 DeepSeek Harness**（host 插件不支持热更新；只有 profile 启用 HMR 时配置变化才即时生效）。
> 首次启动会在 `~/.dsh/memory/memory.db` 建库（WAL 模式）。删掉该文件即可重置全部记忆。
> 回滚：从 profile 的 `package.json` 里删掉包名（`dependencies` 和 `dsh.profile.bundles` 两处）→ 重启。

### 为什么是 bundle（两次真实的翻车）

1. **只写 patch insert → 插件管理里看不到。** 插件管理列的是 profile 的插件包（`dsh.profile.bundles`）与 loader 条目；单靠 `cordis.patch.yml` 里一行 insert 只是一个匿名 loader 条目，没有包身份，不会出现在「已安装插件」列表里。
2. **拷贝安装 → 目录丢失后插件静默消失。** 旧脚本先把 `local-plugins/dsh-memory` 删掉再拷贝；拷贝失败时目录没了，而 profile 的 junction 仍指向它。dsh 启动时该条目 `enabled: true` 但 `fiberPhase: null`（disposed），`memory_*` 工具静默消失、没有任何弹窗。

现在改为「直接 link 源码 + bundle 注册」：不拷贝、不删目录，插件身份和挂载都由 profile manifest 声明。

## 配置

在 profile patch 里覆盖；**patch 的 config 是整行替换、不深合并**，要覆盖就写全：

> 运行时改参数不用改这里：装好后 **设置 → 记忆** 能改同一批 46 个参数并立即生效（5 个字段要重启），优先级 默认 < YAML < 设置页。详见 [设置页（记忆）](#设置页记忆)。

```yaml
- id: memory
  name: 'dsh-memory-layered'      # loader 模块说明符，必须等于安装后的包名
  config:
    dbPath: '~/.dsh/memory/memory.db'
    maxItems: 6                 # 动态段最多几条事实
    maxChars: 1400              # 动态段字符预算
    minScore: 0.2
    capture: true               # 是否保留 episode（v1 兼容）
    injectGlobalFacts: true
    scope: project
    stableMaxChars: 1800        # stable 段（长期约定 + 画像 + 场景导航）字符预算
    core:                       # 「每轮都必须生效」的置顶/硬规则，按策略注入、不靠词法命中
      enabled: true
      maxItems: 6               # 首轮最多注入几条
      minPriority: 85           # persona/instruction 达到该优先级即视为硬规则
    layers: { l0: true, l1: true, l2: true, l3: true }
    extraction:
      enabled: true             # 关掉就退回纯 FTS 记忆
      provider: ''              # 空 = 跟随 agentDefaultModel
      model: ''
      everyN: 5                 # warm-up 毕业阈值
      idleMs: 60000             # idle 兜底
      maxInputChars: 8000
      maxMemories: 10
      maxAttempts: 3
      timeoutMs: 60000
      maxTokens: 2400           # 推理模型的 reasoning 也吃这份预算，别再往下调
    scenes:
      enabled: true
      minFacts: 3
      maxScenes: 20             # 超出的场景按衰减热度淘汰（persona 引用的保留）
      halfLifeDays: 14
    persona:
      enabled: true
      triggerEveryN: 10         # 每 N 个成功批次过一道 JEV-lite 门控
      maxChars: 1200            # 硬上限（超出直接截断）
      targetChars: 700          # 生成目标长度；超过 1.4 倍即视为膨胀，当场重写压缩
      globalTargetChars: 240    # 全局画像的生成目标（它与长期约定重复，宜更短）
      personaMaxTokens: 4000    # 画像重写的输出预算（reasoning 先吃预算，别调太小）
      personaTimeoutMs: 120000  # 画像重写超时（默认 2 分钟）
      personaReasoningEffort: low  # 画像重写用低推理档；空字符串 = 跟随模型默认
      global: true              # 额外维护跨项目全局画像（只吃 global 事实）
    vector:
      enabled: true             # 关掉就只用 FTS/LIKE
      weight: 0.1               # 向量分权重（实测 0.2+ 会掉点，默认 0.1）
      scanLimit: 2000           # 预筛没有命中时的有界兜底扫描行数
      prefilter: true           # 倒排特征索引预筛（memory_features）
      featureLimit: 96          # 预筛查询侧最多用多少个特征（存储固定 96/条）
    skills:
      enabled: true             # 关掉就不注册包内技能
      dir: ''                   # 覆盖技能目录（默认 = 包内 skills/）
```

包内技能以 `ctx.skills.registerProvider` 注册、`source: 'bundled'`、rank **600**（最低档）：
项目 `.dsh/skills`(100) > 项目 `.agents/skills`(200) > `customSkillDirs`(300) > `~/.dsh/skills`(400) > `~/.agents/skills`(500) > 包内 bundled(600)。
**同名时用户自己的技能赢**，日志会写 `from bundled ignored because a higher-priority skill already exists`——想用包内版本就删/改名 `~/.dsh/skills` 里那份。

## 设置页（记忆）

> 这节解决两件事：改参数不用手改 YAML、不用重启；以及「记忆到底存在哪个目录」。

装好插件并**刷新页面**后，**设置 → 记忆**（`settings.section`，id `memory`）里能看到四块，数据全部来自 `POST /memory/api/state`，前端不写死任何默认值：

| 区块 | 内容 |
| --- | --- |
| 存储位置 | 存储目录 + 复制路径 + 打开目录；目录里的文件（名称、体积、修改时间）与数据库体积；「当前数据库路径」（运行中的库）与「设置文件路径」（还没创建时标「尚未创建」） |
| 统计 | 记忆总数、事实、片段、待提炼、场景、人设、词元消耗 |
| 记忆数据 | 一行摘要 + **管理数据** 按钮：弹窗里直接对记忆条目做搜索 / 新增 / 编辑 / 删除（见下节） |
| 参数 | 8 张分组卡（合计 46 项），每行「标题 + 说明 + 控件 + 来源徽标（默认/YAML/设置页）+ 未保存徽标 + 重启生效徽标 + 行内恢复默认」 |
| 操作条 | 页头「刷新」；有改动时出现「保存（n）」「撤销」；常驻「恢复 YAML 基线」 |

### 能改什么

46 个字段分 8 组，组的顺序就是页面上的顺序：

| 分组 | 代表字段（`key`） | 管什么 |
| --- | --- | --- |
| `recall`（召回） | `recall.scope` `recall.maxItems` `recall.maxChars` `recall.minScore` `recall.injectGlobalFacts` `recall.stableMaxChars`、`core.enabled` `core.maxItems` `core.minPriority` | 动态段召回条数/字符/阈值、稳定段预算、长期约定（core）层 |
| `capture`（捕获） | `capture`、`layers.l0` `layers.l1` `layers.l2` `layers.l3` | 是否记原文/episode，四层各自开关 |
| `extraction`（提炼） | `extraction.enabled` `extraction.everyN` `extraction.idleMs` `extraction.maxInputChars` `extraction.maxMemories` `extraction.maxAttempts` `extraction.timeoutMs` `extraction.maxTokens`、`extraction.provider` `extraction.model` | 抽取节奏、单批上限、LLM 预算与路由 |
| `scenes`（场景） | `scenes.enabled` `scenes.minFacts` `scenes.maxScenes` `scenes.halfLifeDays` | L2 场景归并与热度淘汰 |
| `persona`（人设） | `persona.enabled` `persona.global` `persona.triggerEveryN` `persona.maxChars` `persona.targetChars` `persona.globalTargetChars` `persona.personaMaxTokens` `persona.personaTimeoutMs` `persona.personaReasoningEffort` | L3 画像（项目 + 全局）的节奏与长度 |
| `vector`（向量） | `vector.enabled` `vector.weight` `vector.scanLimit` `vector.prefilter` `vector.featureLimit` | 词法向量召回 |
| `storage`（存储） | `storage.dbPath` | 数据库路径（重启才生效） |
| `advanced`（高级） | `debug`、`skills.enabled` `skills.dir` | 调试开关、包内技能注册 |

> `debug` 打开后，每轮召回会把「query 长度 / 命中数 / 检索策略」打到 info 日志（只记尺寸与策略，不记 query 正文）；默认仅在 debug 级日志里记同样内容。

每个字段对象（`state` 返回的 `groups[].fields[]`）：

| 字段 | 含义 |
| --- | --- |
| `key` | 上表的点号 key，保存/重置都用它 |
| `type` | `number` / `boolean` / `enum` / `text` |
| `min` `max` `step` | 仅 `number`：范围与步长 |
| `options` | 仅 `enum`：可选值 |
| `default` | 内置默认值（来自 `resolveConfig({})`，和插件启动用的是同一个归一化函数） |
| `value` | 合并 YAML + 设置页后的生效值，也就是**下次启动**会用的值 |
| `active` | 仅 `live:false` 字段：**正在运行**的实例实际在用的值；与 `value` 不同 = 改了但还没重启 |
| `source` | `default` / `config` / `settings`（来源徽标） |
| `live` | `false` = 需重启 |

> 数字越界**不报错**，会被夹到边界（`recall.maxItems: 999` 存成 20）；`text` 最长 500 字。
> 真正会 400 的是：未知 key、类型不对、枚举不在列表（例如 `recall.scope` 传 `team`）、`patch`/`unset` 不是对象/数组。

### 保存是立即生效还是重启

- **立即生效**（`live:true`，46 个里 41 个）：保存时直接改插件内存里那份 config —— 召回、捕获、工具都闭包读同一个对象，下一次触发就用新值；抽取节奏额外通过 `pipeline.refresh()` 与 `scheduler.configure()` 同步到已创建的对象上。已排队的 idle 定时器保留原延迟，下一轮结束才按新值重新计时（保存时清掉它会丢掉这次兜底触发）。
- **需要重启**（`live:false`，保存响应里的 `restartRequired` 会列出来，行上也有「重启生效」徽标）：

| key | 为什么必须重启 |
| --- | --- |
| `storage.dbPath` | 数据库句柄在插件加载时打开，换路径等于换库 |
| `skills.enabled` / `skills.dir` | 技能在加载时注册进宿主的技能表，生命周期与插件绑定 |
| `extraction.provider` / `extraction.model` | LLM 客户端在加载时解析一次路由 |

这些字段的保存**照样落盘**（重启后生效），页面不会假装它已经生效。想确认「改了但还没重启」：看 `storage` 组里 `storage.dbPath` 这一行——`value` 是下次启动会用的路径，`active` 是运行中真正在用的路径，两者不同就是待重启；「存储位置」卡片始终指向运行中的库。

> 还有一个容易踩的边界：抽取管线只在**插件启动时**满足 `layers.l1 && extraction.enabled && 能解析到模型` 才创建。
> 如果启动时它就是关的，在设置页把 `extraction.enabled` / `layers.l1` 打开**不会凭空创建 LLM 客户端与调度器**——要真正开始抽取，改完重启一次。
> `state` 里的 `runtime.extraction.scheduled` / `available` 能看出管线在不在（这块页面暂不展示）。

### 配置优先级

```text
resolveConfig 内置默认值（46 个字段各一份）
  < profile 的 cordis.patch.yml（loader 行 config）
    < $DSH_HOME/memory/settings.json（设置页写的）
```

- 合并是**深合并**：YAML 与 settings 的对象层级递归合并，数组与标量整体覆盖（后者赢）。设置页只写「你显式改过的 key」，不整份拷贝默认值 → YAML 里以后调整别的字段仍然生效。
- `source` 判定：settings 里出现过该 key → `settings`；否则 YAML 里出现过 → `config`；否则 `default`。所以「填一个和默认值一样的数」会把来源变成 `settings`，真想回默认请用行上的「恢复默认」。
- 「恢复 YAML 基线」= 清掉 settings.json 里的全部覆盖 → 回到 **YAML + 默认**。它不是出厂值，也不动记忆库。

### 文件在哪

| 文件 | 位置 | 说明 |
| --- | --- | --- |
| 数据库 | `$DSH_HOME/memory/memory.db`（缺省 `~/.dsh/memory/memory.db`，可用 `storage.dbPath` 改） | schema v4、WAL 模式；同目录还有 `-wal` / `-shm` |
| 设置文件 | `$DSH_HOME/memory/settings.json` | **固定**在这个目录，与 `storage.dbPath` 无关——否则「把库挪到别处」这条设置会把自己弄丢；删掉即回基线 |
| 技能 | 包内 `skills/`（`skills.dir` 可改） | 加载时注册进宿主，不落盘 |

> 存储卡片里列的是**数据库所在目录**（`storage.dbPath` 的父目录）；改了 `storage.dbPath` 以后目录也跟着换，而设置文件仍在 `$DSH_HOME/memory/`，卡片上的「设置文件路径」单独显示它。

```json
{
  "version": 1,
  "updatedAt": "2026-10-23T08:00:00.000Z",
  "settings": {
    "maxItems": 8,
    "core": { "enabled": false },
    "extraction": { "everyN": 10 },
    "dbPath": "D:\\dsh\\memory.db"
  }
}
```

- `settings` 里是 **loader 行 config 的形状**，不是页面上的分组名：UI 的 `recall.maxItems` 落在顶层 `maxItems`，`extraction.everyN` 落在 `extraction.everyN`，`storage.dbPath` 落在顶层 `dbPath`。好处是这段 JSON 可以直接粘进 `cordis.patch.yml` 的 `config:`。
- 写盘是「临时文件 + rename」的原子替换；`version`/`updatedAt` 只是记账，读回时会剔除，不会混进配置。
- 文件坏掉（不是合法 JSON、顶层不是对象、超过 1 MB）→ 读回 `{}`，插件照常启动，原因显示在 `storage.error` 里。
- 手写兼容：顶层没有 `settings` 包装时，整个对象会被当作 settings 层。
- 设置文件的位置可以用 loader 行 config 里的 `settingsPath` 改（测试 / 打包用的口子，不属于设置页字段）。

### 宿主 HTTP API

页面只调这些端点，全部 **POST** + `content-type: application/json`，响应统一 `{ok:true,value}` / `{ok:false,error:{code,message}}`：

| 端点 | 请求体 | 响应 `value` 要点 |
| --- | --- | --- |
| `POST /memory/api/state` | `{}` | `plugin{name,version,dbReady,startedAt}`、`storage{home,dir,dbPath,settingsPath,settingsExists,files[],totalBytes,error}`、`stats{total,facts,episodes,superseded,projects,byKind,l0Total,l0Pending,scenes,personas,vectorized,featureIndexed,tokensSpent,dbBytes}`、`runtime{extraction{available,provider,model,scheduled},skills{enabled,dir},vector{enabled}}`、`groups[].fields[]` |
| `POST /memory/api/save` | `{"patch":{"recall.maxItems":8},"unset":["scenes.maxScenes"]}` | `{state, applied[], unset[], restartRequired[]}` |
| `POST /memory/api/reset` | `{}` 或 `{"keys":["recall.maxItems"]}`（省略 `keys` = 全部） | `{state, applied[], restartRequired[], reset:true}` |
| `POST /memory/api/reveal` | `{}` | `{opened,dir,error?}`：在系统文件管理器里打开**数据库所在目录**（Windows `explorer.exe`、macOS `open`、其他 `xdg-open`）；spawn 本身失败才回 `opened:false`，文件管理器异步启动失败只记日志 |
| `POST /memory/api/memories` | `{query?,kind?,scope?,project?,includeSuperseded?,sort?,page?,pageSize?}` | 一页记忆 + 下拉筛选数据：`{items[],total,page,pageSize,pages,sort,includeSuperseded,facets{kinds[],scopes[],projects[],total}}`；`query` 是子串搜索（LIKE，2 字中文也能命中）；默认隐藏 `superseded_by` 非空的行，`includeSuperseded:true` 才带出来；`sort ∈ updated\|created\|priority\|id`，`pageSize` 上限 100 |
| `POST /memory/api/memory` | `{id}` | `{item,history[]}`：单行 + 最近 10 条旧正文（`version/op/text/createdAt`） |
| `POST /memory/api/memoryCreate` | `{text,title?,kind?,scope?,project?,tags?,pinned?,priority?}` | `{item,inserted}`；`text` 必填（≤ 20000 字）；**同文本幂等**：已存在时更新属性并回 `inserted:false`（`hash` 唯一索引决定一行只存一份正文）；`scope:'project'` 必须带 `project` |
| `POST /memory/api/memoryUpdate` | `{id,text?,title?,kind?,scope?,project?,tags?,pinned?,priority?}` | `{item,version}`；只改传入的字段；**改正文**才 `version+1` 并写 `memory_history`，改标签/置顶/优先级只更新 `updated_at`；改正文会重算 `hash`/向量/特征索引；撞上另一行正文回 409 `conflict` |
| `POST /memory/api/memoryDelete` | `{id}` 或 `{ids:[…]}` | `{deleted,ids[]}`；不存在的 id 被忽略；FTS 与特征索引由触发器一并清掉 |

错误码：

| code | HTTP | 触发 |
| --- | --- | --- |
| `bad-request` | 400 | 请求体不是 JSON object / 超过 64 KB、未知 key、类型或枚举不合法（`message` 形如 `recall.scope: expected one of "project", "global"`）；数据接口的非法正文/超长/未知 kind/项目缺名同样是 400；**不落盘** |
| `conflict` | 409 | 改名后的正文和另一条记忆完全相同（`hash` 唯一）——`message` 会给出占用的行号，改成编辑那一行即可 |
| `forbidden` | 403 | 宿主提供 connection 信任校验且请求被拒（跨站）——这一步在判断方法之前 |
| `method-not-allowed` | 405 | 用了 POST 以外的方法 |
| `not-found` | 404 | 未知方法 / 路径不匹配 / `memory`、`memoryUpdate` 的 id 不存在 |
| `not-ready` | 503 | 数据库没打开（例如目录只读）：参数页照常可用，只有数据接口回这个 |
| `io-error` | 500 | 写 `settings.json` 失败；内存里的运行时配置保持不变 |
| `internal` | 500 | 兜底异常；细节只进日志 |

> 纯 CLI / headless profile 没有 `webServer`，这套路由不会挂载，插件其余功能照常。

### 恢复默认

| 想做什么 | 怎么做 |
| --- | --- |
| 单个字段回默认 | 行上「恢复默认」→ 标成「待恢复」，随下一次「保存」以 `unset` 提交（只删 settings 层里这个 key） |
| 整页回 YAML 基线 | 底部「恢复 YAML 基线」→ 立即调 `reset`（清空 settings 层），会先确认 |
| 只用命令行 | 删 `$DSH_HOME/memory/settings.json`，再刷新页面 |
| 连记忆一起重来 | 停 DSH，删 `~/.dsh/memory/`（数据库 + 设置一起没，不可恢复） |

### 记忆数据管理（增删改查）

「设置 → 记忆 → 记忆数据 → 管理数据」打开一个覆盖整个设置面板的弹窗，直接管 `memory` 表里的条目，不用再让模型调工具：

| 动作 | 怎么做 | 背后 |
| --- | --- | --- |
| 查 | 搜索框（标题/正文/标签子串，2 字中文也命中）+ 类型/范围/项目下拉 + 「含已取代」开关 + 翻页（每页 20） | `memories` |
| 增 | 「新增记忆」→ 填正文（必填）、标题、类型、范围、项目、标签、优先级、常驻 | `memoryCreate` |
| 改 | 行上「编辑」→ 同一表单，带最近 10 条旧正文（历史版本） | `memory` + `memoryUpdate` |
| 删 | 行上「删除」→ 二次确认 | `memoryDelete` |

几个刻意设计的行为：

- **改正文 ≠ 改属性**：正文变了才 `version+1`、写 `memory_history`、重算 `hash`/向量/倒排特征，和 LLM 抽取改写走同一套不变量；只改标签/优先级/常驻时 `version` 不动（版本号表示「第几版正文」）。
- **同文本幂等**：`memory.hash` 是唯一索引，一行正文只存在一份。新增时命中已有正文 → 更新那条的属性并提示「相同内容已存在，已更新 #id」，不会报错也不会造重复行；编辑时撞上另一行 → 409，提示去改那一行。
- **项目范围的硬约束**：`scope='project'` 必须给 `project`，否则这行在召回里永远不可见（所有读路径都按 `project = ?` 过滤）——host 直接 400，不静默改全局。
- **删除是真的删**：FTS 行与 `memory_features` 由触发器一并清理；`memory_history` 保留（审计用途），和 `memory_forget` 的行为一致。
- **`tags` 两种写法都收**：数组或逗号分隔字符串（中英文逗号均可），最多 20 个、每个 ≤ 64 字。
- **弹窗用 portal 挂到 `<body>`**：设置面板可能处于滚动/变换容器里，`react-dom` 可用时用 `createPortal`，不可用时退化为 `position:fixed`。

> 改完一条，页面顶部的统计卡会重新拉 `state`，计数立刻更新；弹窗自己的列表也会按当前筛选/页码重读。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `memory_search` | `query`, `limit?`, `scope?` | 检索记忆（含 L1 事实 / episode），返回 id/日期/类型 |
| `memory_save` | `text`, `kind?`, `scope?`, `tags?`, `pinned?` | 人工固化一条记忆（同文本幂等） |
| `memory_forget` | `ids?` / `query?` | 删除错误/过期记忆 |
| `memory_stats` | — | 分层计数、L0 待抽取数、场景/画像数、token 花费、库大小 |
| `memory_extract` | `all?`, `sessionId?` | **手动**补跑抽取（调试/恢复）；`all:true` 处理所有还有 L0 待抽取的会话（最多 20 个，最老积压优先） |
| `memory_compact` | `scope?`（`project`/`global`/`both`） | **手动**重写画像，跳过批次阈值与 JEV 门控；用于把膨胀的画像压回去，或按需刷新 |

## 工作方式

```text
session/event(turn/end)
  ├─ L0: appendTurn(原文 + 工具名 + seq 范围)
  └─ scheduler: warm-up 阈值 / idle 60s
        └─ pipeline（全局串行队列）
              ├─ 取 pending L0 → 一次 LLM 抽取（JSON）
              ├─ 解析容错（think/围栏/裸 priority/坏条）
              ├─ 候选召回(FTS) → 二次 LLM 冲突消解 → 启发式兜底
              ├─ L1: store/update/merge/skip + version/history
              ├─ L2: 场景归并（事实 ≥ minFacts）→ summary/body/heat → 超 maxScenes 淘汰
              └─ L3: JEV-lite 判决 → 重写项目画像 + 全局画像

agent/pre-step（每轮首 step）
  ├─ 稳定段（每会话一次）: 长期约定（pinned / 高优先 persona+instruction）+ 画像 + 场景导航
  └─ 动态段（每轮）: FTS/LIKE + 384 维词法向量混合召回（text/priority/kind/recency/vector 加权）
```

- **长期约定（core）**：召回是**词法**的，问候（「你好啊」）与偏好文本零重叠，pinned 偏好会永远进不了上下文——
  所以 `pinned=1` 或 `priority>=85` 的 persona/instruction 行改由 `coreMemories()` **按策略**取，
  放进 stable 段最前面（`### 长期约定（每轮都要遵守，优先级最高）`），与提问内容无关。
  有这一层，用户「记住我是谁」类的要求才在每一轮都生效。
  - 预算：core 段最多占 `stableMaxChars` 的 60%（含标题与第一条），超出按条裁、不挤占画像。
  - `pinned` 对**任意** kind 生效（用户显式置顶即视为「每轮都要」）：`memory_save` 只在称呼/语气/硬规则这类
    「永远成立」的要求上置顶，别把进行中的任务状态置顶。
  - 手工 `memory_save` 只能写 `fact`/`note`，所以工具侧进入 core 的唯一入口是 `pinned`；未置顶的 `fact` 只走动态召回。

- **阈值**：新会话 1→2→4→8→`everyN`（默认 5），之后按 `everyN`；idle 60s 兜底。
- **失败**：LLM 超时/报错/JSON 坏 → 重试，最多 3 次后丢弃该批并记录 `l1-last-reason`；
  抽取失败不影响会话，L0 原文仍在。
- **成本**：一次抽取约 2–5k tokens，按阈值摊薄；`memory_stats` 的 `tokens=` 是累计花费。
- **向量**：每行写入时算一个 384 维 `Float32` 向量（字符 2/3/4-gram + 英文词，feature hashing + signed hash + L2 归一化），
  存成 BLOB（约 1.5 KB/条）。召回时先用**倒排特征索引**（`memory_features`，存未哈希的 n-gram/英文词）按稀有特征取候选，
  再对候选算精确余弦；索引没有提名时才按 `updated_at DESC` 做有界兜底扫描（最多 `vector.scanLimit` 行）。
  **它是词法向量，不是语义向量**：能补字词重叠与排序，不理解同义词（「构建」和「编译」仍不同）。
- **规模化**：向量召回不再对整表做暴力余弦。`memory_features` 在每次打开库时渐进补建（每次最多 500 行），
  大库首次升级可能需要几次重启才补齐；没补齐的行仍由兜底扫描覆盖。索引模型（`feature-index-model`）变化时整表重建。
- **注入**：`<memory_context type="stable|dynamic" source="dsh-memory">`，
  `source.kind='plugin:dsh-memory'`（会话格式 v4 只接受 producer-owned kind；
  写成 `{kind:'plugin', plugin:…}` 会让整轮失败）。
- **全局记忆的三条硬规则**（v0.4.2，详见 [AUDIT-global-recall.md](AUDIT-global-recall.md)）：
  1. `scope` **只在新建时决定**：`update`/`merge` 改写一条已存在的行时沿用该行自己的 scope，
     不会因为「在哪改」而被降级成项目行（除非调用方显式传 `decision.scope`）；
  2. 全局偏好**每轮都重查**一次（按 id 在会话内去重），不是「每会话只开一次门」——
     开场是问候语时也不会把这一整场的全局通道关掉；
  3. 没有文字的轮（只发附件/图片）仍注入 stable 段（长期约定 + 画像），只是不做词法检索。
     另外 `scope=project` 但拿不到项目键的行按 `global` 落库，不产生永远召不回的幽灵行。
- **`scope='global'` ≠ 「每轮都注入」**（最容易误解的一条，详见 [AUDIT-global-recall.md](AUDIT-global-recall.md)）：
  global 只表示「不限项目、各项目都可见」，注入仍要靠策略（`pinned` 或 `persona/instruction ≥85`）
  或词法命中。实测：库里唯一那条 global 行去掉 `pinned` 后，20 条真实短句 × 3 个项目的可见性是 **0/60**。
  想让一句话「每轮都生效」，显式 `pinned: true`。

## 效果实测（2026-10-22，v0.3.0）

数据：真实记忆库副本（28 条有效记忆：9 episode / 11 work_fact / 3 fact / 2 work_method / 1 work_artifact / 2 work_task），
13 条多词查询 + 4 条 2 字中文查询，人工标注期望命中 id；脚本 [notes/vector-eval.mjs](../notes/vector-eval.mjs)。

| 配置 | hit@1 | hit@3 | hit@5 | MRR | 平均召回 |
| --- | --- | --- | --- | --- | --- |
| 向量关闭 | 82.4% | 94.1% | 94.1% | 0.882 | 2.5 ms |
| 向量 weight 0.1 | 82.4% | 94.1% | 94.1% | 0.882 | 2.8 ms |
| 向量 weight 0.2 | 82.4% | 94.1% | 94.1% | 0.873 | 3.3 ms |
| 向量 weight 0.35 | 82.4% | 94.1% | 94.1% | 0.873 | 2.7 ms |

结论：

- 在这个语料上**词法向量是中性**：命中率不变；权重 ≥0.2 反而轻微掉 MRR（把长文事实顶到前面）。
- 开销：+1.5 KB/条（28 条共 43 KB），查询 +0.3 ms（扫描/反序列化）。
- 它补不了语义：`编译构建流程` 仍然 miss（没有行包含「编译」）。
- 评测还发现并修复了一个真实 bug：启用向量时，LIKE-only 候选（2 字中文）曾被误扣 0.15 基础分；修复后各模式对齐。
- 默认权重因此设为 **0.1**；向量保留的价值在于大语料/短查询时的候选兜底，而不是语义理解。

## 隐私

- 抽取会把**会话文本**发给当前会话配置的同一个模型 provider（默认跟随 `agentDefaultModel`）；
  不想发送就设 `extraction.enabled: false`，插件退回「原文 episode + FTS 召回」，不调任何 LLM。
- 数据全部在本地 `~/.dsh/memory/memory.db`，不引入第三方服务。

## 验证是否真的加载了

1. **插件列表**：侧栏「插件」页里应出现 `dsh-memory-layered`（来自 `dsh.profile.bundles`），状态为启用/active。
2. **工具层**：新会话里说「看下你的记忆库」→ 模型应调用 `memory_stats`，输出含 `l0=`、`scenes=`、`vec=`、`feat=`、`tokens=`。
3. **抽取层**：聊几轮后 `memory_stats` 的 `l0=0/N`（待抽取为 0）且 `kinds={...}` 出现 `work_fact` 等；
   或直接让模型调 `memory_extract` 看 `reason=ok`。
4. **注入层**：消息里出现 `<memory_context type="stable|dynamic">`；会话日志 request/header 里有 `memory_*` 工具：

   ```powershell
   node notes\session-inspect.mjs "$env:USERPROFILE\.dsh\sessions\<项目目录>\<会话目录>\session.v4.jsonl.zstd" --tools
   ```

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件列表里看不到 `dsh-memory-layered` | 只写了 patch insert，没注册成 bundle | `pwsh -File .\install.ps1 -Apply` → 重启 |
| 条目 `enabled: true` 但 `fiberPhase: null`，工具消失 | `node_modules/dsh-memory-layered` 断链或目录丢失 | 同上（脚本会重建 link） |
| 本轮失败：`format v4 message requires a producer-owned source kind` | 注入消息用了旧 source 形状 | 本版已用 `{ kind: 'plugin:dsh-memory' }` |
| `memory_stats` 里 `l0` 一直不降 | 没有 llm 服务/模型，或抽取一直失败；重启后旧会话不会自动重试 | 看日志 `[dsh-memory]`；`l1-last-reason` 会写 `llm_error/parse/timeout`；调 `memory_extract` 传 `{all:true}` 补抽积压 |
| 抽取 `reason=parse` | 模型把 Windows 路径写成单反斜杠（`\U`/`\m` 非法转义），或前面带示例 JSON | 本版 `repairStringEscapes` 修非法转义与裸控制字符，并在多个 JSON 片段中选 `memories` 最多的一个；仍失败可用 `all:true` 重跑 |
| 没有人格/场景 | 事实太少（`minFacts`）或还没到 `triggerEveryN` | 多聊几轮，或调小阈值 |
| 召回为空 | 语料太少，或 2 字中文走 LIKE 兜底 | 用 `memory_save` 固化关键结论（`fact` 权重高） |
| `memory_stats` 的 `vec=` 小于总数 | 旧行还没回填（每次 open 最多补 500 行）或写入路径没跑 v3 | 重启一次让它继续回填；或 `enabled: false` 临时关掉向量 |
| `memory_stats` 的 `feat=` 小于总数 | 特征索引还在渐进补建（每次 open 最多 500 行） | 重启一次继续；不影响召回，未索引行仍走有界兜底 |
| 向量把不相关记忆排上来 | 词法哈希碰撞或权重过高 | 调低 `vector.weight`（如 0.2）或 `enabled: false` |

## 开发与测试

按文件跑（**不要用 `node --test test/`**：它会为每个文件 spawn 子进程，在 DSH 沙箱下报 `spawn EPERM`）：

```powershell
cd dsh-memory
# 全量：214 项，0 fail（settings 32 项 + 记忆数据 CRUD 18 项）
node --test --test-isolation=none (Get-ChildItem .\test\*.test.js | ForEach-Object FullName)
# 单文件
node test/recall.test.js
```

CI（`.github/workflows/release.yml`）用同样的「逐个文件跑」策略，新增测试文件无需改 workflow。

模块：

- `src/store.js` — schema v1→v4 迁移、memory 表、FTS、meta、stats、向量/特征索引回填
- `src/vector.js` — 384 维词法向量（feature hashing、pack/unpack、cosine）
- `src/feature-index.js` — 倒排特征索引（向量预筛、df 探测、渐进补建）
- `src/l0.js` — L0 原文、游标、pending、transcript 预算
- `src/l1.js` — 候选、冲突决策（store/update/merge/skip）、version/history
- `src/extract.js` — 抽取/去重 prompt、JSON 容错解析、决策落库
- `src/scheduler.js` — warm-up 阈值 + idle（可注入定时器）
- `src/llm.js` — `ctx.get('llm')` 封装（超时/usage/降级）
- `src/pipeline.js` — 串行队列、失败重试/丢弃、L2/L3 串接（项目 + 全局画像）
- `src/profile.js` — L2 场景、maxScenes 淘汰、L3 画像、heat 衰减/导航
- `src/consolidate.js` — 场景归并、画像重写（项目/全局）、JEV-lite 判决
- `src/recall.js` — 查询词、FTS/LIKE + 倒排预筛 + 向量混合打分、稳定/动态注入块
- `src/capture.js` — v1 episode 捕获（兼容保留）
- `src/settings.js` — 字段目录（46 个 key）、`resolveConfig` 归一化、校验/深合并/来源、原地应用
- `src/settings-store.js` — `settings.json` 读写（原子替换、损坏隔离）、存储目录描述
- `src/data.js` — 记忆条目 CRUD（分页/筛选、hash 冲突、版本历史、向量与特征重算）
- `src/api.js` — `POST /memory/api/*` 路由（POST-only、64 KB 上限、稳定错误码）
- `index.js` — 与 dsh 接线（事件、pre-step、工具、设置页路由、降级）

> 在受限环境里不要用 `node --test test/`（会 spawn 子进程触发 EPERM），逐个跑文件即可。

## 限制与后续

- 向量是**词法向量**（字符 n-gram hashing），不是语义 embedding：同义词、跨语言改写仍然召回不到；
  要语义得接真的 embedding 服务（dsh 目前没有），或用 LLM 做查询扩展。
- 向量召回已改为「倒排特征索引预筛 → 精确余弦 → 有界兜底」，不再对整表暴力扫描。
  **没有引入 LSH/ANN**：向量本身就是词法哈希，倒排预筛对真实字词重叠是无损的（哈希碰撞只影响候选排序，最终分仍是精确 cosine），
  ANN 的近似误差在这个特征空间没有收益。代价：`memory_features` 约 +0.3–1 KB/条；大库升级后每次 open 补 500 行，
  未补齐的行仍由兜底扫描覆盖。2 字中文/短拉丁查询的 LIKE 兜底仍是全表扫描（10k 行约百毫秒级），是下一步可优化项。
- L2 场景超过 `maxScenes` 会按**衰减热度**淘汰（persona 正文引用的场景保留）；被淘汰场景用 `l2-evicted:<project>` 记录，
  在没有更新事实前不会重建，避免「淘汰→重建→再淘汰」反复烧 LLM。引用保护是子串匹配，2 字常用词可能过度保护。
- L3 现在同时维护**项目画像**与**全局画像**（`persona.global`，默认 true）：全局画像只吃 `scope='global'` 的事实，
  有独立的批次计数 `l3-batches:@global` 与 JEV-lite 门控；与 core 长期约定层互补（core 管「每轮必须遵守的规则」，
  全局画像管跨项目的背景与决策摘要）。只想要项目画像可设 `persona.global: false`。
- 抽取/场景/画像共用会话模型；想更省可配便宜模型（`extraction.model`）。
- 重启后旧会话的 L0 待抽取**不会自动重试**（idle timer 是进程内的）；用 `memory_extract {all:true}` 按最老积压补抽，最多 20 个会话。
- 单机单库；多人共享需换存储后端（接口隔离在 `store.js`）。
