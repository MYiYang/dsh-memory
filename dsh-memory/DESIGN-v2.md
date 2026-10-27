# dsh-memory v2 设计：L0 → L3 分层记忆

> 目标：把现在「episode + 人工 fact + FTS 召回」的轻量记忆，升级成腾讯 TencentDB-Agent-Memory 那套
> **L0 原文 → L1 原子事实 → L2 场景 → L3 画像** 的分层管线，同时保留 dsh 插件的约束：
> 零外部依赖、失败不拖垮会话、成本可控、数据留在本地。
>
> 参考：`TencentDB-Agent-Memory-分析报告.md` 第 3–4 章、`notes/A-core.md` 第 2–4 节。
> 本文是实施前的设计决策记录；代码落地后以 README 为准。

---

## 1. 范围

### 做

- **L0**：原始轮次落库（用户/助手全文 + 工具名 + 游标），不可变追加。
- **L1**：按阈值批量调用 LLM，抽取「原子事实」；与既有事实做冲突消解（store / update / merge / skip）；带 priority、version、superseded 审计。
- **L2**：按场景归并 L1 事实成 Markdown 场景块（summary + heat），提供「场景导航」注入。
- **L3**：项目/全局画像（persona）重写，由 JEV-lite 判决门控。
- **召回**：稳定段（persona + 场景导航）+ 动态段（本轮命中的 L1 事实）两段注入。
- **工具**：`memory_search` 支持层过滤；新增 `memory_extract`（手动触发）与 `memory_scene`（读场景正文）。

### 不做（v2 明确排除）

- **语义 embedding**：dsh 没有 embedding 服务，v2 先用本地 **384 维词法向量（feature hashing）** 做混合召回；
  真正的语义向量留给后续（见 §18/§19）。**v0.8.0 已补上可选的 OpenAI 兼容嵌入模型，见 §26。**
- 多租户团队共享（Team/Agent ACL）：单机单用户。
- 腾讯的 Offload（上下文压缩）、Skill、Wiki、CodeGraph：不在本插件范围。
- 原文级 L0 全量消息（含 tool 输出）：只存 user/assistant 文本 + 工具名，避免 tool 输出撑爆库。

---

## 2. 现状与差距

| 层 | 现状（v1） | 差距 |
| --- | --- | --- |
| L0 | 只把一轮压缩成 2.4k 字 episode | 无原文、无游标、无法重放抽取 |
| L1 | 只有 `memory_save` 人工 fact | 无 LLM 抽取、无冲突消解、无 priority/version |
| L2 | 无 | 无场景、无热度、无导航 |
| L3 | 无 | 无画像/信条 |
| 调度 | 每轮都落一条 episode | 无 warm-up、无 idle、无串行队列 |
| 注入 | 动态段（命中事实） | 无稳定段（persona/scene nav） |

v1 已有的资产保留：SQLite + FTS5 trigram、打分函数、`<memory_context>` 注入约定、
`source.kind='plugin:dsh-memory'`、28 个单测、bundle 安装方式。

---

## 3. 总体架构

```text
session/event
  ├─ turn/start…turn/end → L0: appendTurn(不裁剪) + cursor 计数
  └─ scheduler.notifyTurn(session)
        ├─ warm-up 阈值：1 → 2 → 4 → 8 → everyN(默认 5)
        ├─ idle 兜底：60s
        └─ 入队 L1 job（全局串行，异步，不阻塞会话）
              ├─ 取 pending L0 turns
              ├─ 一次 llm.stream：场景切分 + 事实抽取（JSON）
              ├─ 解析容错 → 候选召回(FTS) → 二次 LLM 冲突消解
              ├─ 落 L1：store/update/merge/skip + version + history
              ├─ L2：新事实按 scene 聚合 → LLM 归并场景块 + heat
              └─ L3：JEV-lite 判决 → 触发时重写 persona.md

agent/pre-step（每轮首 step）
  ├─ 稳定段（每会话一次）：persona（global+project）+ 场景导航
  └─ 动态段（每轮）：L1 事实召回（priority/heat/recency 加权）
  两段合并成一条 source.kind='plugin:dsh-memory' 的消息注入
```

关键原则（沿用腾讯的设计判断）：

1. **L0 先落盘，再提炼**：任何上层失败都不丢原文。
2. **不是每轮都调 LLM**：阈值 + idle 把成本摊薄；失败不重试到死。
3. **单串行队列**：同一时刻最多一个抽取任务，避免并发写库与 token 飙升。
4. **记忆是上下文不是指令**：注入块继续标注「可能过时、不要复述」。
5. **可解释**：每条 L1 有 kind/priority/version/source，`memory_stats` 能看 token 花费。

---

## 4. 数据模型（SQLite，schema v4；v5 追加 `memory_embeddings`，见 §26）

### 4.1 L0

```sql
CREATE TABLE l0_turns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL,
  turn             INTEGER NOT NULL,
  project          TEXT,
  user_text        TEXT NOT NULL DEFAULT '',
  assistant_text   TEXT NOT NULL DEFAULT '',
  tool_names       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  seq_from         INTEGER,                      -- 会话日志 seq 范围（可追溯）
  seq_to           INTEGER,
  created_at       INTEGER NOT NULL,
  extracted_at     INTEGER,                      -- NULL = 待抽取
  extract_attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, turn)
);
CREATE INDEX l0_pending_idx ON l0_turns(extracted_at, id);

CREATE TABLE l0_cursor (
  session_id                  TEXT PRIMARY KEY,
  last_turn                   INTEGER NOT NULL DEFAULT 0,
  conversations_since_extract INTEGER NOT NULL DEFAULT 0,
  threshold                   INTEGER NOT NULL DEFAULT 1,  -- 1,2,4,8,…,everyN
  pending_since               INTEGER,                     -- idle 计时起点
  updated_at                  INTEGER NOT NULL
);
```

- 保留策略：`l0KeepTurns`（默认 5000/会话）+ 90 天，超出按 id 从旧删。
- 去重：`UNIQUE(session_id, turn)`，重启/重放幂等。

### 4.2 L1（复用 `memory` 表，加列）

```sql
ALTER TABLE memory ADD COLUMN priority      INTEGER NOT NULL DEFAULT 50;
ALTER TABLE memory ADD COLUMN version       INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memory ADD COLUMN superseded_by INTEGER;      -- 被哪条取代（NULL=有效）
ALTER TABLE memory ADD COLUMN scene         TEXT;         -- 场景名（L2 聚合键）
ALTER TABLE memory ADD COLUMN source_seqs   TEXT;         -- JSON: [l0_turn_id,…] 溯源
-- v3：本地 384 维词法向量（见 §19）
ALTER TABLE memory ADD COLUMN vec           BLOB;         -- Float32Array(384)，L2 归一化
ALTER TABLE memory ADD COLUMN vec_model     TEXT;         -- 'hash-ngram-v1-384'

CREATE TABLE memory_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  INTEGER NOT NULL,
  version    INTEGER NOT NULL,
  op         TEXT NOT NULL,          -- store|update|merge|skip
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- v4：倒排特征索引（向量预筛，见 §19/§23）
-- 只存未哈希特征，key 是 fnv1a(feature)；不写 memory 表，不触发 FTS 同步。
CREATE TABLE memory_features (
  memory_id INTEGER NOT NULL,
  feature   INTEGER NOT NULL,
  weight    REAL NOT NULL,          -- 1 + ln(tf)
  PRIMARY KEY(memory_id, feature)
);
CREATE INDEX memory_features_feature_idx ON memory_features(feature);
-- AFTER DELETE ON memory → DELETE FROM memory_features WHERE memory_id = old.id
```

kind 集合扩展（保留 v1 的 fact/note/episode 兼容）：

| kind | 含义 | 默认 kind 权重 |
| --- | --- | --- |
| `persona` | 用户/团队长期偏好 | 1.0 |
| `instruction` | 明确要求模型遵守的规则 | 1.0 |
| `work_fact` | 项目事实（技术栈、路径、约定） | 0.9 |
| `work_method` | 跑通过的方法/流程 | 0.8 |
| `work_task` | 进行中的任务状态 | 0.6 |
| `work_artifact` | 产物位置（文件/表/服务） | 0.7 |
| `episodic` | 一次性事件 | 0.4 |
| `fact`/`note`/`episode` | v1 兼容 | 0.9 / 0.8 / 0.5 |

### 4.3 L2 / L3

```sql
CREATE TABLE l2_scenes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL DEFAULT 'project',   -- project|global
  project    TEXT,
  name       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',          -- Markdown
  heat       REAL NOT NULL DEFAULT 1,
  fact_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, project, name)
);

CREATE TABLE l3_persona (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,          -- project|global
  project    TEXT,
  body       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, project)
);
```

- 单一真相在 SQLite；**不**另写 md 文件再回读（腾讯 rowfs 的教训：两份真相必然漂移）。
  需要人读时用 `memory_scene` / `memory_stats` 导出即可（后续可加 `-Export` 脚本，只导出不读回）。

### 4.4 迁移

- `SCHEMA_VERSION = 4`；`migrate()` 先建 v1 表，再 `ensureColumn()` 逐列补（幂等），最后写版本。
- v1 → v2/v3/v4 不删任何数据；旧 fact/episode 继续可召回（`superseded_by IS NULL`）。
- v4 新增 `memory_features`（倒排特征索引）与删除触发器；旧行由 `openDatabase()` 每次最多补 500 行。

---

## 5. 调度器（warm-up + idle + 串行）

> 状态：`l0_cursor.conversations_since_extract` / `threshold` / `pending_since`。

```
turn/end:
  cursor.conversations_since_extract += 1
  cursor.pending_since ??= now
  if conversations_since_extract >= threshold:
      enqueueExtraction(session)
  else:
      armIdleTimer(session, idleMs=60s)

enqueueExtraction:
  timer 取消; conversations_since_extract = 0
  threshold = min(threshold * 2, everyN)          # 1→2→4→8→5
  queue.push(job)                                  # 串行

idle 到期: enqueueExtraction(session)（有待抽取时）
手动: memory_extract 工具直接 enqueue
```

- 抽取成功后 `sinceExtract` 归零、`pending_since` 清空；`threshold` 保持在 warm-up 阶梯上继续翻倍（1→2→4→8→everyN），不回到 1——否则每个会话的第一轮都会重新抽取。失败时游标不前进，由下一轮/ idle 重试；同一批连续失败 `maxAttempts(3)` 次后丢弃并记录原因，防止毒批死循环。
- 队列并发 = 1；job 内 `try/catch`，失败最多重试 1 次（指数退避 2s），仍失败则
  `extract_attempts += 1` 且本轮跳过（游标不前进，下个阈值重试；`attempts >= 3` 才丢弃该批并记 `l1-empty reason=...`）。
- 插件 dispose：abort 在途请求、清定时器、队列清空。
- **绝不在 pre-step / turn 事件里 await LLM**。

---

## 6. LLM 集成

```js
const llm = ctx.get('llm')                          // 可选服务
const selection = ctx.get('agentDefaultModel')?.currentSelection()  // {provider,model,…}
const provider = config.extraction.provider || selection?.provider
const model    = config.extraction.model    || selection?.model
```

- 调用：`llm.stream({ provider, model, system, messages:[{role:'user',content:[{type:'text',text}]}], maxTokens, signal })`；
  逐 chunk 收 `text-delta`，`finish` 结束；`usage` 记入 `meta`（`l1_tokens_total`、`l1_calls_total`）。
- `purpose` 字段只允许 `compaction|session-title`，**不传**。
- 超时：默认 60s（AbortController）；失败不抛出到会话。
- 无 `llm` 服务 / 无 model → 抽取整体降级为关闭，只 log 一次 warn（人工 fact 仍可用）。
- 成本护栏：`maxInputChars=8000`、`maxMemories=10`、`maxTokens=1500`；每轮注入预算独立。

---

## 7. L1 抽取

### 7.1 输入

- `pendingTurns(sessionId, limit)`：最多 20 轮 / 8000 字（从旧到新，超限截断最早轮次）。
- 每轮格式：`#<turn> [tool: a,b]\n用户: …\n助手: …`。

### 7.2 输出契约（JSON）

```json
{
  "memories": [
    {
      "kind": "work_fact",
      "text": "项目用 pnpm 而非 npm",
      "priority": 70,
      "scene": "构建与工具链",
      "op": "store",
      "target_id": null
    }
  ]
}
```

- `op` 由第二次冲突消解调用决定；首次抽取只输出 kind/text/priority/scene。
- 约束：`text` ≤ 400 字、单批 ≤ 10 条、kind 必须在枚举内、priority 0–100（缺省 50）。

### 7.3 容错解析（照抄腾讯经验）

1. 剥 `<think>…</think>`；
2. 去 ```json 围栏；
3. 贪心取第一个 `[...]` 或 `{…}`；
4. 单引号/裸标识符修复（`priority: 70` → `"priority": 70`）；
5. 校验后逐条 `try`，坏条丢弃并计数；
6. 空结果记录封闭原因：`parse|empty|timeout|llm_error|filtered`，写 `meta` 便于 grep。

### 7.4 冲突消解

1. 对每条新事实：`findFactCandidates(text, top=3)`（FTS + LIKE，排除 superseded、episode）。
2. 无候选 → `store`。
3. 有候选 → **一次批量** LLM 调用，输入「新事实 + 候选(id/text/kind)」，
   输出 `[{index, op: store|update|merge|skip, target_id}]`；失败则走本地启发式：
   - 同 hash → skip；
   - 文本相似度（trigram Jaccard）> 0.75 → update；
   - 否则 store。
4. `update/merge`：`memory_history` 留旧版，`version = max(version)+1`，
   `updated_at=now`，被合并的行 `superseded_by=目标 id`。
5. 任何决策写 `meta`/日志：`l1 op=store n=3 update=1 merge=1 skip=2`。

---

## 8. L2 场景

- 触发：L1 批次落库后，按 `scene` 聚合；某场景新增事实 ≥ `minFacts(3)` 或
  summary 过期 > 1 天 → 一次 LLM 归并：输入该场景全部有效事实（≤ 30 条），
  输出 `{summary, body}`（body ≤ 1200 字 Markdown，分「要点/约定/坑」）。
- heat：`heat = heat * 0.5^(Δdays/halfLife=14) + 1`（每次更新/被召回命中 +1）。
- 场景数量上限 `maxScenes=20`：每批 `runScenes` 末尾按**衰减热度**（`effectiveHeat`）分桶淘汰——当前项目桶与 global 桶各自计数；
  超出者删除，但 persona 正文里出现过的场景名会「加回」保留（不占 maxScenes 名额）。
  被删场景写入 meta `l2-evicted:<project>`，下一批若没有 `updated_at > evictedAt` 的新事实就跳过，不再重建（防淘汰/重建抖动）；
  一旦有新事实则删除记录并正常恢复。只删 `l2_scenes` 行，L1 事实不动。
- 导航：按 heat 取 top 8，渲染
  `- 场景名（heat, N 条）: 一句话摘要`，总长 ≤ 600 字。
- 失败：LLM 失败时保留旧 body，只更新 fact_count/heat。

---

## 9. L3 画像

- 内容：Markdown，固定小标题（用户偏好 / 项目约定 / 关键决策 / 环境与工具）。
- 触发：
  - 首次有 ≥ 5 条有效事实 → 生成；
  - 之后每 `triggerEveryN(10)` 个 L1 批次，或 JEV-lite 判定为 `conflict|boundary_change|new_rule`。
- JEV-lite（一次小调用）：输入「当前 persona + 最近 10 条事实变化」，
  输出五分类之一：`conflict | boundary_change | new_rule | reinforcement | none`。
  只有前三类才真正重写；`reinforcement/none` → 记录 deferred，省一次大调用。
- 长度上限 `maxChars=1200`；超限截断并保留小标题结构。
- 两个 scope（§22 复核时曾以「core 层已覆盖」为由否决，v0.5.0 按用户要求落地）：
  - **project**：事实池 `(scope='global' OR project=?)`，批次键 `l3-batches:<project>`，写 `scope='project'`；
  - **global**：事实池只取 `scope='global'`，独立批次键 `l3-batches:@global`，写 `scope='global'/project=NULL`；
    `persona.global:false` 可关闭。两者各自 gate，互不清零；`ctx.project` 为空时项目画像直接返回 `no-project`（不写幽灵行）。
- 注入：稳定段（项目画像 + 全局画像各一段，`renderStableBlock` 按 scope 标标题）。

---

## 10. 召回与注入

- 候选：`memory` 表（`superseded_by IS NULL`），FTS + LIKE；v3 起再加一路本地词法向量（§19）。
- 打分（v3）：
  `text 1.0 + vector*0.1 + recency 0.20 + usage 0.15 + project 0.15 + priority/100*0.20 + kindWeight 0.20 + pinned(0.35)`；
  其中 vector 只对 `vec_model='hash-ngram-v1-384'` 的行计算；无 bm25 的候选（LIKE/纯向量）统一拿 0.15 中性 text 分。
- 向量候选生成（v4）：词法候选不足 `maxItems*2` 时，先用倒排特征索引 `memory_features` 按「查询侧最稀有的特征」提名候选，
  再对候选算精确 cosine（≥0.15）；预筛没有提名时才按 `updated_at DESC` 有界兜底扫描最多 `vector.scanLimit` 行。
  预筛命中时不再兜底：向量是词法的，真实重叠必然共享特征，兜底只会引入哈希碰撞噪声（未补建索引的旧行由下一次 open 补齐）。
- 稳定段（每会话首轮一次）：
  `<memory_context type="stable">` persona + 场景导航 `</memory_context>`，≤ 900 字。
- 动态段（每轮）：
  `<memory_context type="dynamic">` 命中事实 `</memory_context>`，≤ 1400 字。
- 两段同一条消息发送（`source.kind='plugin:dsh-memory'`）；预算独立、互不挤占。
- 同一 turn 只注入一次；子 agent / 定时任务跳过。

---

## 11. 工具

| 工具 | 变化 |
| --- | --- |
| `memory_search` | 新增 `layer?: 'all'|'fact'|'episode'|'scene'|'persona'`（默认 all） |
| `memory_save` | 不变；kind 枚举扩展到新类型 |
| `memory_forget` | 支持 `layer` 过滤删除 |
| `memory_stats` | 增加 l0 未抽取数、facts by kind、scenes、persona version、token 花费 |
| `memory_extract` | 手动触发抽取（调试/补跑）；`all:true` 补抽全部有 L0 积压的会话（≤20 个），`sessionId` 指定单个会话 |
| `memory_scene` | 读场景正文（name 或 top N） |

工具数 6 个，仍然轻量；`memory_extract` 不自动暴露给普通对话（description 写明「调试用」）。

> v0.2.0 实际落地：`memory_extract` 已实现；`memory_search` 的 `layer` 过滤与 `memory_scene` 顺延（见 §18）。

---

## 12. 配置（patch 的 config 整行替换）

```yaml
- id: memory
  name: 'dsh-memory'
  config:
    dbPath: '~/.dsh/memory/memory.db'
    maxItems: 6
    maxChars: 1400
    minScore: 0.2
    capture: true
    injectGlobalFacts: true
    scope: project
    layers: { l0: true, l1: true, l2: true, l3: true }
    extraction:
      enabled: true
      provider: ''        # 空 = 跟随 agentDefaultModel
      model: ''
      everyN: 5           # warm-up 毕业阈值
      idleMs: 60000
      maxInputChars: 8000
      maxMemories: 10
      timeoutMs: 60000
      retries: 1
    scenes:
      enabled: true
      minFacts: 3
      maxScenes: 20       # 超出的按衰减热度淘汰（persona 引用的保留）
      halfLifeDays: 14
    persona:
      enabled: true
      triggerEveryN: 10
      maxChars: 1200
      global: true        # 额外维护全局画像（只吃 global 事实）
    vector:
      enabled: true
      weight: 0.1         # 向量分权重（实测 0.2+ 掉点，默认 0.1）
      scanLimit: 2000     # 预筛没有提名时的有界兜底扫描上限
      prefilter: true     # 倒排特征索引预筛
      featureLimit: 96    # 预筛查询侧特征上限（存储固定 96/条）
    debug: false
```

---

## 13. 失败模式与降级

| 失败 | 行为 |
| --- | --- |
| 无 `llm` 服务/无模型 | L1–L3 关闭（warn 一次），人工 fact + FTS 召回照常 |
| LLM 超时/报错 | 重试 1 次；仍失败则本批跳过、游标不前进；attempts≥3 丢弃并记录原因 |
| JSON 解析失败 | 修复尝试 → 仍失败丢弃本批；记录 `l1-empty reason=parse` |
| DB busy | `busy_timeout=3000` + 串行队列 |
| 抽取出坏事实 | priority 截断、text 截断、kind 白名单、同 hash 去重 |
| 插件 dispose | abort 在途、清 timer、关闭 db 句柄 |
| 上下文爆炸 | 注入预算固定；抽取输入截断；场景/画像长度上限 |

---

## 14. 安全与隐私

- 抽取会把对话文本发给**当前会话配置的同一个模型 provider**；README 明确写出，
  并给 `extraction.enabled: false` 开关。
- 数据全部本地（`~/.dsh/memory/memory.db`），不引入第三方服务。
- 工具入参做长度/枚举校验；不执行 LLM 返回的任何命令。

---

## 15. 测试策略（零依赖，node:test）

- `store`：v1→v4 迁移幂等；l0 append/游标/幂等；L1 ops（store/update/merge/skip）与 version/history；superseded 过滤；场景 upsert/heat；persona put/get；向量写入与 backfill；特征索引表/触发器/覆盖统计。
- `vector`：确定性、L2 归一化、相似/不相似、2 字中文重叠、pack/unpack 宽度、FNV-1a 稳定性。
- `feature-index`：topFeatures 确定性与上限、index/replace、候选按稀有特征提名、scope/kinds/superseded 过滤、backfill、删除触发器、空特征哨兵、模型变更清表。
- `recall`：FTS/LIKE 候选、priority/kind 打分、向量加分、倒排预筛救回 2 字拉丁查询、`prefilter:false` 兜底路径、stable/dynamic 注入块预算。
- `extract`：prompt 构造；JSON 容错（think/围栏/裸 priority/坏条、Windows 路径的非法反斜杠、裸控制字符、多个示例片段中选最终答案）；op 决策启发式；输出白名单。
- `scheduler`：阈值 1→2→4→8→5；idle；失败重试；dispose 取消。用注入的 `now` + 假定时器，不 sleep。
- `llm`：假 llm 服务（脚本化响应）+ 超时/错误分支。
- `plugin`：模拟多轮 → L0 入库 → 触发抽取 → 注入 stable+dynamic；注入 source kind 仍为 `plugin:dsh-memory`；`memory_extract {all:true}` 补抽非活跃会话。
- 回归：153 个测试全绿（v0.5.0；v0.3.0 时 93）。

---

## 16. 实施顺序（里程碑）

| # | 内容 | 验收 |
| --- | --- | --- |
| M1 | store v2：schema/迁移/l0/l1 ops/scenes/persona + 单测 | 旧库升级不丢数据；新表单测绿 |
| M2 | extract 模块：prompt、解析容错、冲突消解（含启发式） + 单测 | 假 LLM 下产出正确 op |
| M3 | scheduler + llm client + index.js 接线 | 模拟 6 轮只触发 2–3 次抽取；失败不影响 turn |
| M4 | 召回 v2：stable/dynamic 两段、priority 打分、layer 过滤 | 注入块结构/预算单测 |
| M5 | L2/L3：场景归并、heat、导航、persona + JEV-lite | 场景/画像单测 |
| M6 | 工具面 + README + 配置 + 真机验证（临时 DSH_HOME + headless） | 重启后 active，抽取真实发生，token 记账可见 |

每完成一个里程碑：`node test/*.test.js` 全绿 + 更新 README 对应章节。

---

## 17. 待定/开放问题

1. **抽取模型**：默认跟随会话模型（贵但质量好）；是否默认降级到便宜模型？→ 先跟随，配置可改。
2. **L3 的 scope**：已落地——project persona 事实池 = 本项目 + global 事实；global persona 只吃 global 事实、独立批次键与 gate（`persona.global`，默认 true）。
3. **episode 是否保留**：v2 之后 episode 仅作 v1 兼容与「原文近邻」兜底，默认仍捕获（`capture` 开关）。
4. **场景命名一致性**：LLM 每次命名可能漂移 → 用「已有场景名清单 + 相似度匹配」约束，超阈值才新建。
5. **多会话并发抽取**：串行队列下按 session 轮转，饥饿保护（每 session 最多 pending 1 个 job）。

---

## 18. 实施状态（v0.3.0，2026-10-22）

### 已完成

| 里程碑 | 状态 | 证据 |
| --- | --- | --- |
| M1 store v2 | ✅ | `test/layers.test.js`（迁移/l0/l1）；`store` 8 项回归全绿 |
| M2 extract | ✅ | `test/extract.test.js` 10 项（think/围栏/裸 priority/坏条/去重决策） |
| M3 scheduler + llm + 接线 | ✅ | `test/scheduler.test.js` 5、`test/llm.test.js` 5、`test/pipeline.test.js` 7、`test/wiring.test.js` 3 |
| M4 召回 v2（stable/dynamic + priority） | ✅ | `test/recall.test.js`；注入块 `type="stable|dynamic"` |
| M5 L2/L3（场景、画像、JEV-lite） | ✅ | `test/profile.test.js` 6、`test/consolidate.test.js` 5；wiring 的 L2/L3 端到端 |
| M6 文档 + 真机验证 | ✅ | 见下；README 配置/工具/排错已更新 |
| M7 本地词法向量 + 混合召回 | ✅ | `test/vector.test.js` 7、`test/recall.test.js` 向量 3 项、`test/layers.test.js` 向量写入/回填 1 项；schema v3 |

真机验证（临时 DSH_HOME + headless + 真实 workbuddy 模型）：

1. 第一轮落 L0；`memory_extract` 触发真实抽取 → `l1-last-reason=ok`，4 条事实
  （`work_method` pnpm build / pnpm deploy、`work_fact` MySQL 8.0、`instruction` 不自动 git push），
   token 累计 1027；项目画像 v1 生成。
2. 同一会话再问「构建用什么命令？」→ 注入 stable（画像，1065 字）+ dynamic（事实，509 字），
   模型回答 `pnpm build`。

### 与设计的偏差（有意/顺延）

- `memory_search` 的 `layer` 过滤、`memory_scene` 工具：顺延（当前 5 个工具，README 为准）。
- `maxScenes` 淘汰策略：v0.3.0 未实现；**v0.5.0 已实现**（§8/§23）。
- L3 只写**项目画像**（事实池含 global 事实）；**v0.5.0 已补全局画像**（§9/§23）。
- L2 场景需要同一场景 ≥ `minFacts(3)` 条事实才会生成；真机测试里每个场景 1 条，故 scenes 为空（符合预期）。
- 向量是**词法**向量（feature hashing），不是语义 embedding；语义向量仍列为后续（§19）。
- L0 只存 user/assistant 文本与工具名，不存 tool 输出。

### 回归

`dsh-memory` 全量测试 **93 项，0 失败**（13 个测试文件）。

---

## 19. 本地词法向量（v0.3.0）

> 背景：dsh 没有 embedding 服务，用户提出「用算法自己实现 300 多维度向量」。结论：**可以，但它是词法向量，不是语义向量**。

### 算法

- 特征：英文词（≥2 字符）+ 词内 3-gram；CJK 连续段的 2/3/4-gram；单字 CJK 单独成特征。
- 映射：FNV-1a 32-bit → `index = hash % 384`，符号位 `sign = (hash >> 31) & 1 ? -1 : +1`（signed hashing 降碰撞偏差）。
- 权重：sublinear TF `1 + ln(count)`；向量 L2 归一化 → `cosine = dot`。
- 存储：`Float32Array(384)` → BLOB ≈ 1.5 KB/行；`vec_model='hash-ngram-v1-384'` 标记代数，换代时自动回填。
- 写入：`saveMemory` / L1 `insertFact` / `applyDecision(update)` 都重算；`openDatabase` 分批回填旧行（每次最多 500）。

### 检索（v4：倒排预筛）

- 先跑 FTS（trigram bm25）+ LIKE；对候选算余弦，作为第 8 个信号进入 `scoreRow`（权重 `vector.weight`，默认 0.1）。
- 词法候选 < `maxItems*2` 时（典型：2 字中文查询、词序变化），用 `memory_features` 倒排索引提名候选：
  查询侧取最多 48 个特征，按 document frequency 从稀有到常见探测（df≥256 视为无区分度，跳过），
  选最多 12 个稀有特征做一次 `GROUP BY memory_id`，再对候选做精确 cosine（≥0.15）。
- 预筛没有提名时才走有界兜底：先只取 id（`ORDER BY updated_at DESC LIMIT vector.scanLimit`），再 `getByIds`，
  避免把向量 BLOB 带入排序；旧的「无 ORDER BY LIMIT 2000」会永远只扫到最老的行。
- 纯向量/LIKE-only 候选没有 bm25，统一拿 0.15 的中性基础分——**不能因为启用了向量就惩罚另一条召回腿**（评测时发现并修复的真实 bug）。
- `strategy` 会带 `+vec` 便于诊断。

### 为什么用倒排预筛而不是 LSH/ANN

- 这个向量本身就是**词法** feature hashing：两段文本有真实字词重叠 ⇔ 共享未哈希特征（哈希碰撞除外）。
  把未哈希特征存进倒排表，用稀有特征提名候选，对真实重叠是**无损**的；哈希碰撞只会让候选多一点，最终分仍是精确 cosine。
- LSH/ANN 会引入近似误差，还要处理重建、桶参数、删除；在这种特征空间里收益为负。真正需要 ANN 的是**语义 embedding**（384 维稠密、无共享特征可枚举），
  而 dsh 目前没有 embedding 服务（§19 结论）。
- 代价：`memory_features` 约 +0.3–1 KB/行；旧库渐进补建（每次 open 最多 500 行）；df 探测最多 48 次索引查询，10k 库实测 p90 ≈ 11ms。

### 实测（2026-10-22，真实库副本 28 条 / 17 条查询，脚本 `notes/vector-eval.mjs`）

| 配置 | hit@1 | hit@3 | hit@5 | MRR | 平均召回 |
| --- | --- | --- | --- | --- | --- |
| 向量关闭 | 82.4% | 94.1% | 94.1% | 0.882 | 2.5 ms |
| weight 0.1 | 82.4% | 94.1% | 94.1% | 0.882 | 2.8 ms |
| weight 0.2 | 82.4% | 94.1% | 94.1% | 0.873 | 3.3 ms |
| weight 0.35 | 82.4% | 94.1% | 94.1% | 0.873 | 2.7 ms |

结论：**词法向量在该语料上是中性**，权重 ≥0.2 会轻微掉 MRR；它补不了语义（`编译构建流程` 仍 miss）。
保留价值：大语料/短查询时补候选；默认权重降到 0.1，存储 +1.5 KB/行。

### 为什么不做「随机投影/SVD」

- 随机投影只是另一种 hashing，无法凭空产生语义；SVD 需要训练语料与矩阵分解，收益不确定。
- 真正的语义召回要么接 embedding API（dsh 无此服务），要么用 LLM 做查询扩展；后者可作为后续增量（一次小调用生成同义词/别名）。

## 20. 包内技能与发布形态（v0.4.0，2026-10-22）

目标：**一个 npm 包装完插件 + 技能**，别人用 GUI 或 `pnpm add` 安装、重启后既有记忆能力又有 4 个技能，不需要手工拷目录。

### 为什么不做 `postinstall` 拷贝

| 方案 | 问题 |
| --- | --- |
| `postinstall` 把 `skills/` 拷进 `~/.dsh/skills` | pnpm ≥10 默认拦依赖的 build 脚本，要用户显式批准（dsh 插件管理器会报 `pendingBuilds`）；拷贝型安装还会制造"目录丢了插件静默消失"的老坑 |
| profile patch 里配 `customSkillDirs` | 需要**绝对路径**，包自己算不出来；用户还得手改 patch |
| 插件包内注册（采用） | 内存注册、随插件释放、rank 可被用户覆盖、零文件写入 |

### 机制

```text
dsh-memory/apply()
  └─ ctx.inject(['skills'], scope => {                 // 等 skills 服务就绪，随插件 fiber 释放
       scope.skills.registerProvider(() => provider)   // provider.name = 'dsh-memory'
     })
provider.list()  → 4 个 candidate：rank 600 / source 'bundled' / resourceBase = 技能目录
provider.get(c)  → 该技能的 SKILL.md 正文（frontmatter 已剥离）
```

- **rank 600** = `dsh-skill-filesystem` 的最低位（bundled 带）。项目 `.dsh/skills`(100)、`customSkillDirs`(300)、用户 `~/.dsh/skills`(400) 的同名技能一律优先；重复时宿主只打一行 warn。
- **资源基址**：`resourceBase.kind='directory'` 指向技能自己的目录，SKILL.md 里写的相对路径照旧可解析。
- **frontmatter 解析**：只认 `key: value` 标量与 `>` / `|` 折叠块；名字必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`、描述与正文非空，否则该目录被跳过并记 warn（不会让插件加载失败）。
- **降级**：没有 `ctx.inject`（老宿主）、没有 `skills.registerProvider`（未装 skill 包）、`skills/` 目录缺失 → 只写一行日志，记忆功能照常。
- **配置**：`skills.enabled`（默认 true）、`skills.dir`（默认包内 `skills/`）。

### 测试

- `test/skills.test.js`（9 项）：frontmatter 解析（LF/CRLF/引号/折叠块/无头）、坏目录跳过、4 个真实技能的 name/description/body、provider 的 rank/source/invocation、`get()` 命中与未知名字、有/无 registry 两种宿主下的注册结果、`apply()` 端到端接线。
- 真实宿主冒烟：`notes/skills-smoke.mjs` 直接 import 安装包里的 `@deepseek-ai/dsh-skill` → `new Context()` → `ctx.plugin(SkillRegistry)` → 注册本 provider → `list()` 出 4 个、`get('memory-curator')` 取到正文。

### 发布形态

- npm 包 `dsh-memory`：`index.js` + `src/*.js` + `skills/*/SKILL.md` + `cordis.patch.yml` + README/INSTALL/LICENSE + DESIGN。
- `package.json` 刻意**不声明** `@deepseek-ai/*` peerDependencies 与 `engines.dsh`：声明后 dsh 会在安装前做版本兼容门（不满足直接拒装，要 `dsh plugin allow-version` 豁免），而本插件对 DSH 包零 import，没必要挡用户。
- 离线包：`scripts/build-release.mjs` 产 `dist/dsh-memory-<ver>.tgz` + `-bundle.zip` + `SHA256SUMS.txt` + `manifest.json`；`install.ps1 -From <tgz|zip|目录>` 负责无网安装。
- 后续可选：`skills.rank` 配置化、按 profile 白名单只注册部分技能。



## 21. 长期约定层：按策略注入，不靠词法命中（v0.4.1，2026-10-23）

### 症状

用户反复抱怨「助手忘了我是谁」：库里有一条 `pinned`、`scope=global` 的偏好（#104：每轮称「官人」、语气温柔、自称「妾身」），但每个新会话的开场都是公事公办的口吻；用户提醒后才翻记忆库道歉，下一轮又忘。

### 根因（可复现）

`agent/pre-step` 的两段注入里，只有画像/场景是「按策略」取的，事实层全靠 `recall()` 的**词法**匹配：

```
recall(db, '你好啊', {scope:'global'})  → 0 条候选（FTS trigram 命中 0，LIKE 也没有）
```

问候语与偏好文本没有任何字词重叠，`globalsInjected` 这条通道等于对问候轮永久失明；动态段同样取不到。再加上 stable 段 900 字符预算被 1200 字的项目画像吃满，画像之后的内容还会被截断。三条叠加 = 每轮开场「失忆」。

### 设计

新增**长期约定层**（core），与「检索」并列而不是混在一起：

| 维度 | 检索（dynamic） | 长期约定（core） |
| --- | --- | --- |
| 选择依据 | 与当前提问的词法/向量相似度 | 行属性：`pinned=1` 或 `persona/instruction` 且 `priority>=85` |
| 生效范围 | 当轮 | 每会话首轮，与提问内容无关 |
| 预算 | `maxChars`（默认 1400） | `stableMaxChars` 的 60%，最多 `core.maxItems` 条 |
| 排序 | 分数 | `pinned` → `priority` → `use_count` → `updated_at` |

- 实现：`store.coreMemories()` 一条 SQL；`recall.renderStableBlock({cores,…})` 把它渲染成 `### 长期约定（每轮都要遵守，优先级最高）` 并**排在最前**（预算不够先裁画像、不裁约定）；`index.js` 里 stable 段不再受 `layers.l2/l3` 开关限制，取到 cores 后 `touchMemories` 记一次使用。
- 为什么不扩大 `pinned` 语义、或把 stable 段每轮都注入：pinned 已经是用户「永远优先」的显式表达，缺的是**取用路径**不是表达力；stable 段每轮注入会重复烧 prompt（画像 1200 字 × 每轮）。
- 数据侧：一次性把 L1 抽取在两个项目里各存一份的 4 条平行偏好（#106/#107 menm、#116/#117 dsh）标成 `superseded_by=104`，只留全局置顶那条；#104 补上「自称妾身」、priority 50→95、旧文本进 `memory_history`。备份 `.tmp/live-backup-20261023-085530.db`。
- 防复发：抽取/去重提示词各加一条——跨项目偏好写成通用表述；候选里包含全局行时语义等价就 `skip`/`merge`，不要因为「不在同一项目」再存一条平行偏好。

### 测试与验证

- `test/core-inject.test.js`（3 项）：`coreMemories` 的过滤/排序/项目可见性、`renderStableBlock` 的段序与预算、`agent/pre-step` 端到端（问候轮注入 #104、同会话第二轮不重复）。
- 真实库副本回放：`project=menm/dsh` + 问候语 → stable 段第一行即 #104；`memory_stats` 的 superseded 计数 0→4。
- 已知边界：pinned 的**任意** kind 都会被注入（用户显式置顶即视为「每轮都要」）；`coreMemories` 不做相似度合并，重复条目仍要靠抽取侧的去重提示词与人工 curation 控制。

### 独立复核后的三处修正

| 问题（复核发现） | 修正 |
| --- | --- |
| stable 段首行还写着「仅在确实相关时参考」，与「每轮都要遵守」自相矛盾 | 有 core 时改用专门首行：长期约定「必须体现在回复里」，画像/场景才是「背景参考」 |
| globals 段没过 `rendered`，query 命中同一条置顶偏好时一轮注入两次 | globals 也按 `rendered` 过滤，一条本轮只出现一次（加断言） |
| core 的 60% 预算只约束第 2 条起，首条无条件进，配置压到下限时会超 23% | 预算改成含标题与首条的硬上界，超出裁剪；首条仍保证保留 |

补测：`includePinned:false` 分支、core 段硬预算（6 条 400 字 / maxChars=300 → 段长 ≤ 180）、`官人` 命中轮「同一条只出现一次」。

## 22. 全局记忆为什么会忘：审计结论（v0.4.2，2026-10-23）

用户报告「标了 global 的记忆，跨会话/跨项目还是会忘」。完整审计（失败模式 M1–M10、量化证据、复现命令）见
[AUDIT-global-recall.md](AUDIT-global-recall.md)。这里只记结论与否决项：

- **四层叠加**：写入侧抽取器不产出 global（95/95 是 project）、改写侧用当前会话项目覆盖 scope（会降级）、
  读取侧三道闸门都以「词法命中」为前提（词法闸门 / 每会话一次性 / 必须有文字）、人格层只做项目级。
- **已修**：core 层（§21）；`applyDecision` 继承目标行 scope；全局段每轮重查 + 会话内去重；无文字轮仍注入
  stable；无项目键不再写幽灵行；抽取契约新增 `scope:"global"`（仅 persona/instruction）。
- **否决**：调 `projectMatch` 权重（实测 0/10 影响）；新增全局人格（core 层已覆盖边际收益太低）；
  启发式「全局孪生」自动合并（3-gram 包含度把真重复 #123 判成 0.19，和无关 episode 0.15~0.19 无法区分）。

### 复核后追加的六处（M11–M16）

| # | 缺口 | 修法 |
| --- | --- | --- |
| M11 | 冲突候选按 `L1_KINDS` 过滤，`memory_save` 写的 `fact`/`note` 永远不在候选里（#104 因此从未参与合并） | `findCandidates` 候选 kind 加上 `fact`/`note`（episode 仍排除） |
| M12 | 无 cwd 会话 `searchFts/searchLike` 不加 scope 过滤 → 读遍所有项目 | `scope='project'` 且无项目键时只看 global |
| M13 | stable 段 core id 没种进 `state.globalIds` → 同会话重复注入（实测 291 字符/次） | 渲染 stable 时一并种入 |
| M14 | `l3-batches` 是全局计数器，任一项目清零 → 其他项目画像永远 `deferred`（menm 落后 16.9h） | 改为 `l3-batches:<project>` |
| M15 | `textScore = bm25/8`，`|rank|<1.2` 的弱命中低于「无 bm25」的 0.15 基线 | 下限钉在 0.15 |
| M16 | 无文字轮 `userTextOf` 回退到上一轮问题 → 用旧问题检索（实测 2900 字符） | 本轮有人类消息就用它（哪怕是空串） |

回归：112 → 117 项测试全绿（新增 recall 的弱 bm25/无项目键、core 的会话去重/附件轮、layers 的候选 kind 三组用例）。

## 23. v0.5.0：向量召回规模化 + L2 淘汰 + L3 全局画像（2026-10-23，源码）

同时清掉 README「限制与后续」里长期挂着的两条：暴力向量扫描、maxScenes 不淘汰 / 只有项目画像。

### 23.1 向量召回：倒排特征预筛替代暴力扫描

**问题**：旧代码在词法候选不足时执行

```sql
SELECT * FROM memory
 WHERE superseded_by IS NULL AND vec IS NOT NULL AND vec_model = ?
   AND (scope='global' OR project = ?)
 LIMIT ?              -- vector.scanLimit，默认 2000，且没有 ORDER BY
```

SQLite 的 `LIMIT` 在这里等于「按 rowid 取最老的 2000 行」：大库时新记忆永远进不了向量候选。
基准（12,001 行、query `db`、scanLimit=2000）：旧代码 **found=false / 18.9ms**，目标行（rowid 12001）根本不在扫描范围。

**实现**（schema v4）：

- 新表 `memory_features(memory_id, feature, weight, PRIMARY KEY(memory_id, feature))` + `feature` 索引 + `AFTER DELETE` 清理触发器。
  `feature = fnv1a(未哈希特征)`；`weight = 1+ln(tf)`；每条记忆固定存 96 个最强特征（`FEATURE_INDEX_MODEL` 的一部分；`vector.featureLimit` 只约束查询侧预筛）。
- 写入路径都在同一事务里维护：`saveMemory`（含重复 hash 的补索引）、L1 `insertFact`、`applyDecision(update/merge)`；
  `openDatabase()` 每次最多补 500 行（`feature-index-model` 变化时整表清空重建）。
- `candidateMemoryIds()`：查询侧取最多 48 个特征逐个求 document frequency（`df >= 256` 视为无区分度丢弃），
  选最稀有的 12 个跑一次 `GROUP BY memory_id`；SQL 强制 `INDEXED BY memory_features_feature_idx`
  （否则 SQLite 从 memory 侧驱动，10k 库同查询 106ms vs 5ms）。
- `recall()`：预筛 → 精确 cosine（≥0.15）→ 仅当预筛「零提名」时才做有界兜底
  （先 `SELECT id ORDER BY updated_at DESC LIMIT scanLimit`，再 `getByIds`；避免向量 BLOB 进入排序）。
  预筛命中后不再兜底：词法向量的真实重叠必然共享特征，兜底只会带进哈希碰撞噪声；未补建的旧行由下一次 open 补齐。
- schema v4 同时补了 `memory_updated_idx(updated_at DESC)` 与 `memory_scope_updated_idx(scope, updated_at DESC)`，
  让兜底扫描按索引取最近 N 行，不再对整表做 ORDER BY 排序。
- `stats()` 新增 `featureIndexed`；`memory_stats` 输出 `feat=N/total`。

**基准**（12,001 行、query `db`）：新代码 **found=true / 12.0ms**；10k 库特征预筛 p50≈0ms、p90≈11ms（398k 特征行）。
`memory_features` 约 +0.3–1 KB/行；写入成本 1.69 vs 1.66 ms/行（基本持平）。

### 23.2 L2 maxScenes 淘汰（含防抖）

- `profile.pruneScenes(db, { maxScenes, project, now, halfLifeDays, protectReferenced })`：
  当前项目桶与 global 桶**分别**按 `effectiveHeat` 降序保留前 N；persona 正文引用到的场景名（≥2 字）即使越界也加回保留；
  删除只动 `l2_scenes`，L1 事实不动；返回 `{ deleted, kept, protected, removed }`。
- `runScenes` 每批结束都执行淘汰（即使本批 0 更新），返回 `{ updated, skipped, pruned }`。
- **防淘汰/重建抖动**：被删场景名 + 时间写入 meta `l2-evicted:<projectKey>`（≤200 条、≤90 天、空则删键）。
  下一批若该场景没有 `updated_at > evictedAt` 的新事实，直接 skipped、不调 LLM；有新事实才恢复重建并清条目。
  场景行被其他写入方重建时视为淘汰作废，不误跳过。

### 23.3 L3 全局画像

- `runPersona` 增加 `ctx.scope`：project（默认，行为不变）与 global。
- global 画像：事实池只取 `scope='global' AND superseded_by IS NULL`；批次键 `l3-batches:@global`；
  `getPersona/putPersona(scope='global', project=NULL)`；JEV-lite 门控同逻辑；日志区分 `(project|global vN)`。
- 注入侧无需改动：`listPersonas` 早已按 project→global 返回，`renderStableBlock` 按 scope 渲染「项目画像/全局画像」。
- `ctx.project` 为空时 project 模式直接返回 `no-project`，不再写读不回来的幽灵画像。
- `pipeline` 先项目后全局，各自 try/catch；`persona.global:false` 可关闭。
- 与 §22「否决新增全局人格」的关系：§22 否决的是**用全局画像替代 core 长期约定层**（规则类内容 core 更便宜、每轮必到）；
  本次实现的是**跨项目背景/决策摘要**，只吃 global 事实、独立 gate，与 core 互补，默认开启但可关。

### 23.4 回归

- DSH 插件测试：**117 → 153 项全绿**（新增 feature-index 13、recall 3、store 3、profile 4、consolidate 8、extract 2、layers 1、wiring 2）。
- 迁移验证（真实库副本 139 条）：v3→v4 open 64ms，`schema=4`、`feat=139/139`、11,921 特征行；
  5 条真实查询召回 0.85–6ms，命中包含 pinned #104。
- 命令：`node --test --test-isolation=none (Get-ChildItem .\test\*.test.js | ForEach-Object FullName)`。

### 23.5 L1 抽取 parse 修复与存量 L0 补抽（2026-10-23）

**症状**：live 库 `l0=15/30` 待抽取、`l1-last-reason=parse`；重启后旧会话的待抽取不会自动重试
（scheduler 的 idle timer 是进程内的），积压最老到前一天 16:41。

**根因**（用 headless 模型重放同一批提示复现）：

1. 模型把 Windows 路径按单反斜杠写进 JSON 字符串（`C:\Users\…` 里的 `\U`/`\m` 不是合法转义），`JSON.parse` 直接失败；
   旧 `repairJson` 只修尾逗号/裸键/单引号，不修非法转义。
2. 模型在推理里先打印示例 `{"memories":[...]}`，旧 `parseExtraction` 只取第一个 `{`，于是解析到示例或直接失败。

**修复**：

- `repairStringEscapes()`：string-aware 修复字符串内的非法反斜杠、裸换行/制表/控制字符；合法转义保持不动。
- `extractJsonSlices()` / `parseJsonCandidates()`：遍历全部顶层 JSON 片段；`parseExtraction`/`parseDedupe`
  选 `memories`/`decisions` 最多的一项（数量相同取后者，即最终答案）。
- `memory_extract` 新增 `all` / `sessionId`：`all` 按最老积压优先处理最多 20 个会话，专治重启后旧会话 backlog；
  底层 `pendingSessionIds()` 负责分组查询。
- 测试 +4（extract 2、l0 1、wiring 1）。

**真实库补抽**（2026-10-23 10:47–10:55）：对 8 个会话 / 15 条待抽取 L0 用 headless 模型重跑抽取，
人工剔除过期/重复/跨项目噪音后写入 39 条（ids 145–183），15 条 L0 全部标记已抽取，`pending 15→0`；
备份在 `.tmp/memory-backup-20261023-104808/`。修复前 8 个输出里有 3 个拿不到正确结果（2 个 parse 失败、
1 个只解析到推理示例），修复后 8/8 正确。补抽走的是离线脚本而非真实 pipeline，所以本轮没有触发 L2/L3；
重启后可直接用 `memory_extract {all:true}` 走真实 pipeline。

### 23.6 重启后真机验证与记忆库清理（2026-10-23 11:00–11:10）

**验证 1 — 新代码真的加载了**：`memory_extract` 的 `all` / `sessionId` 参数在 live 工具面上可见，
说明 host 侧 0.5.0 已生效。重启前那次 `l1-last-reason=timeout`（10:59:22）不是模型超时，而是退出 DSH 时
把进行中的抽取流 abort 掉，`llm.complete()` 把它归到 `aborted` → pipeline 记成 `timeout`；同一批数据重启后一次成功。

**验证 2 — 真实 pipeline 全链路**（`memory_extract {all:true}`，走 host llm 而非离线脚本）：

| 层 | 结果 |
|---|---|
| L1 | `reason=ok`，1 个会话，store 9（ids 185–193），`pending 1→0`，`l1_calls_total 29→30` |
| L2 | 场景 `技术尽调`/`记忆注入` heat 2→3、facts 4→5，新增场景「发布流程」（共 10 个） |
| L3 | **全局画像 v1 首次生成**（595 字，独立批次键 `l3-batches:@global`）；menm 项目画像仍被门控 defer（batches 1 < 10） |

**记忆库清理**（`memory_forget`，删除前备份 `.tmp/memory-backup-20261023-110526/`）：

- 删 16 条：`#9 #11 #12 #14 #15 #19 #27 #29 #36 #43 #91 #131 #185 #190 #191 #193`。
  前七条是 10-22 会话里「当时状态」类事实（v0.2/v0.3 里程碑、248 KB+schema v2、幽灵行 bug 描述、四项待办、
  v3 迁移方法、待重启到 v0.3）；`#15/#36/#91/#131` 是同一类「下一步/待执行」；`#43` 是 v0.3.0 发布状态；
  `#185` 与 pinned `#104` 重复（还被 core 层当成第三条长期约定）；`#190/#191/#193` 是本次补抽自己写进去的
  瞬时计数（L0 条数、vec 覆盖率、测试数），正是抽取契约明令不落库的那类内容。
- 结果：`190 → 174` 条（有效 168 / 历史被替代 6），FTS 174 行、特征索引 174 个 memory / 15,110 行，
  `missing FTS/feature = 0`，`memory_history` 无孤儿子行。

**menm 项目画像 v1 → v2**：v1（1200 字）还写着 schema v2、幽灵行未修、src 三模块、四项待办，全部已过时；
v2（891 字）按现存事实重写为「项目定位 / 架构 / 操作约定 / 环境」四段。`putPersona` 走正常版本递增，旧版可在备份里找回。

**stable 段预算：压缩画像，而不是加预算**：`stableMaxChars=1800`，压缩前 cores ≈300 + menm 画像 891 + 全局画像 595
≈1808 已顶满，`### 场景导航`（457 字）进不来。选择压画像而不是抬预算：

| 画像 | 之前 | 之后 | 取舍 |
|---|---|---|---|
| menm 项目画像 | v1 1200（过期）→ v2 891 | **v3 650** | 保留项目定位 / 架构 / 操作约定，砍掉与工具面重复的环境清单 |
| 全局画像 | v1 595 | **v2 203** | 只留跨项目背景（工作盘、常用目录、记忆库、相识日）与指向 `#104` 的引用，删掉与长期约定重复的称呼/语气段落 |

压缩后实测：cores 298 + 项目 661 + 全局 214 + 导航 468 ≈ **1641 / 1800**，渲染出的 stable block
（含 intro）1791 字，**场景导航恢复注入且无 `…` 截断**。`stableMaxChars` 未改动，无需重启；两张画像都走
`putPersona` 正常递增版本，旧版仍在 `.tmp/memory-backup-20261023-110526/` 备份里。

### 23.7 输出预算截断导致的 `parse` 失败与救援（2026-10-23 11:15）

**症状**：本轮那篇长回答（表格 + 大量事实）被抽取时连续两次 `l1-last-reason=parse`（`extract_attempts 1→2`，
`l1_calls_total 30→31`），同一批数据在 10:53 之前却能成功——说明不是输入格式问题，而是**这次输出被截断**。

**根因**：`maxTokens=1200` 是整段输出的预算，而 deepseek 推理模型先吐 reasoning，reasoning 同样计入输出预算。
这批提示词可抽 10 条事实，答案 JSON 写到数组中间就被截断，`extractJsonSlice` 找不到配平的括号 → 无切片 →
`parseJsonCandidates` 返回空 → `reason=parse`。0.5.0 的 `repairStringEscapes` 只救「括号配平但转义非法」，
救不了「根本没有闭合」，所以这次仍然失败。

**修复**：

1. `closeTruncatedJson()` / `salvageTruncatedJson()`：只在一个**完整元素的闭合括号**处回退（最长前缀优先），
   补齐缺失的 `]` / `}` 再解析；若截断发生在第一个元素内部（没有任何完整元素可回退）则**拒绝救援**——
   宁可让这一批失败重试，也不把半句话当事实存进库。`parseJsonCandidates` 在「无配平切片」时改为救援
   最后一个切片之后的尾巴；`parseJsonLoose` 同样兜底，去重/门控的 JSON 一并受益。
2. `maxTokens` 默认 1200 → **2400**（`PIPELINE_DEFAULTS` 与 `index.js` 的配置默认同步），给 reasoning 留余量。
3. `parse` 失败时把原始输出写进 meta `l1-last-raw`（`chars` / `finish` / `head` 前 1200 字）。此前这种失败
   事后完全不可诊断，只能猜是截断、散文还是结构不对。

**回归**：153 → **154** 项全绿，新增用例覆盖「数组中间被截断」「示例 JSON 之后的最终答案被截断」
「无可回退元素时拒绝救援」。

**处置**：待抽取的 L0 turn #33（本轮回答）已把 `extract_attempts` 归零，避免被旧解析器的两次失败提前丢弃；
重启加载新代码后走真实 pipeline 重试。

### 23.8 画像自动压缩（2026-10-23 11:30）

**问题**：§23.6 的手工压缩是一次性的。`maxChars` 只是硬上限，而 prompt 原话是「目标长度：不超过 1200 字」——
模型会老老实实写满 1200（最早的 menm / novel-ai 两张项目画像都恰好 1200 字，就是这么来的）。同时
`triggerEveryN=10` 管的是「多久重写一次」，不是「写多长」：只要门控通过一次重写，手工压缩的结果立刻被推翻，
场景导航又要被挤掉。也就是说「达到阈值自己压缩」在旧代码里并不成立。

**改法**：

- 新增 `persona.targetChars`（默认 700）与 `persona.globalTargetChars`（默认 240），prompt 改为
  「约 N 字（硬上限 M 字）」，并追加「压缩要求」：不与长期约定/其他层重复、同一意思只写一次、
  优先保留命令/路径/约束这类可执行信息。`maxChars` 仍是硬截断。
- **膨胀即压**：现有画像长度 > `1.4 × targetChars` 时跳过 JEV 门控直接重写（日志 `l3 compact (project 1200 > 980 chars)`），
  写回后自动回到「每 N 批过一道门控」的节奏。这样画像一旦膨胀就自己瘦回来，不用等人手工收拾。
- 预算核对：cores ≈300 + 项目 700 + 全局 240 + 场景导航 ≈470 ≈ **1710 / 1800**，留约 90 字余量；
  新画像按 `globalTargetChars` 生成，不再出现「项目 1200 + 全局 600 把导航挤没」的局面。

**回归**：154 → **156** 项全绿（新增「膨胀画像跳过门控直接压」「prompt 携带目标长度与压缩要求」两条）。
配置默认值同步进 README 的配置示例。

### 23.9 自动压缩首轮实测未生效：静默失败与手动压缩工具（2026-10-23 11:22–11:40）

**自检过程**：确认进程（11:21:55 启动）晚于 `consolidate.js`（11:17:34）与 `index.js`（11:17:40），即 0.5.2 已加载；
把 menm 项目画像人工写到 **1448 字**（越过 `1.4 × 700 = 980` 的膨胀线），再用 `memory_extract {all:true}` 触发一批真实
pipeline（L1 `reason=ok`，store 9；L2 三个场景 11:23:05 正常改写）。

**结果**：画像**没有被压**——仍是 v5/1448，但 `l3-batches:menm` 2→3、`@global` 1→2，说明 `runPersona` 确实跑过。
也就是说压缩分支要么没进、要么进了却静默失败：

- 同类调用（L2 场景，`maxTokens=700`）成功，而画像这条 `maxTokens=1200`、prompt 最长，最可能被 reasoning 吃掉预算或超时；
- 更糟的是**失败无痕**：`askJson` 只返回 `{value:null}`，`runPersona` 直接 `return 'empty'`，meta 里什么都不留，
  事后只能靠猜。这正是这次排查卡住的原因。

**0.5.3 改法**（观测优先，其次才是调参）：

1. `askJson()` 返回完整诊断：`ok / error / finish / chars / head`（前 240 字）。
2. `runPersona` 每条返回路径都写 meta：`l3-last-at`、`l3-last-reason`（形如 `menm:written` / `@global:deferred` /
   `menm:empty` / `menm:gate:none`）、`l3-last-detail`（JSON：ok/error/chars/head/batches）；膨胀分支额外写
   `l3-last-compact`。失败时 `log('warn', ...)` 带原因，不再静默。
3. 画像专用预算：`persona.personaMaxTokens`（默认 **3000**）、`persona.personaTimeoutMs`（默认 **120 秒**），
   与 L1 的 2400 同理——推理模型的 reasoning 先吃输出预算，最长的 JSON 最容易被截断。
4. 新工具 **`memory_compact`**（`scope: project|global|both`）：跳过批次阈值与 JEV 门控，立刻重写画像，
   并回传前后长度。它既是「按需压缩」的开关，也是验证压缩链路最短的路径（不必等 10 个批次）。
5. `runPersona` 支持 `force`（上面那个工具用的就是它），强制重写时不问门控。

**回归**：156 → **159** 项全绿（新增「force 无视阈值直接重写」「画像答案不可用时留下诊断而非静默」「memory_compact
工具按需压缩」三条；`plugin.test.js` 的工具清单同步加上 `memory_compact`）。

**自检残留已清**：测试用的 1448 字画像已改回 `v6/650`；备份在 `.tmp/memory-backup-20261023-112230/`。
加载 0.5.3 后，用 `memory_compact` 直接重跑一次自检即可定论。

### 23.10 画像重写失败的真正原因：输出预算被 reasoning 吃光（2026-10-23 11:31）

**0.5.3 的观测第一次把失败讲清楚了**。重启后直接调 `memory_compact {scope:'project'}`，`l3-last-detail` 记录：

```json
{ "ok": false, "error": null, "finish": "max-tokens", "chars": 0, "head": "" }
```

`finish=max-tokens` + `chars=0`：模型把 3000 token 的预算全花在 reasoning 上，**可见文本一个字符都没产出**，
所以 `parseJsonLoose('')` 为 null → `body` 空 → `empty`。这不是解析问题，是「预算全部被思考吃掉」。
根因是 `agent-default-model` 里配的是 `reasoningEffort: max`，而插件调用 `llm.stream()` 时没有覆盖它。

**0.5.4 改法**：

1. `llm.complete()` 支持 `reasoningEffort` / `purpose` 透传（`GenerateOptions` 本来就有这两个字段）。
2. 画像重写走**三段式**：① `personaReasoningEffort`（默认 `low`）+ `personaMaxTokens`（默认 4000）；
   ② 同档推理、预算 ×4（上限 32000）；③ **去掉 effort**、预算 ×4（给不接受该 effort 的 provider 兜底）。
   任一段拿到可用 `body` 即停，所有尝试都记进 `l3-last-detail.attempts`。
3. `askJson` 的 consolidation 调用带 `purpose:'compaction'`，让适配器按「辅助调用」对待。
4. 失败日志改为 `warn` 并输出整组 attempts，不再只有一句 reason。

**回归**：159 → **160** 项全绿（新增「空答案 max-tokens 会加大预算重试」；「不可用答案留诊断」改为校验三段式记录）。

**未验证项（需加载 0.5.4）**：`reasoningEffort:'low'` 是否被 workbuddy 适配器接受、以及 4000 预算 + low 档是否足以产出
700 字画像。若仍失败，`l3-last-detail.attempts` 会逐条给出 ok/finish/chars，下一步按实际值再调。

### 23.11 低推理档生效，但模型写超长：压缩回合 + 行边界裁剪（2026-10-23 11:36）

**0.5.4 实测（重启后直接 `memory_compact {scope:'project'}`）**：

```json
{ "reason": "written", "chars": 2624, "rawChars": 2624, "attempts": [
  { "tokens": 4000, "effort": "low", "ok": true, "finish": "stop", "chars": 2671 } ] }
```

- `effort:"low"` **被接受**，`finish:"stop"`、产出 2671 字 → **0.5.4 之前那次「chars=0 / max-tokens」的死结解开了**；
- 但模型把「长度硬性上限 700 字」当耳旁风，实际写了 2624 字，被 `maxChars=1200` 硬切，长度超预算 →
  场景导航又被挤出去（`has 场景导航: false`）。

**0.5.5 改法（两层兜底，先质量后确定性）**：

1. **压缩回合**：首轮 `body` 超过 `targetChars` 时，追加一次专门的压缩调用
   （`buildPersonaCompressPrompt`：保留小标题结构、优先命令/路径/约束、删重复），成功则用压缩结果；
2. **行边界裁剪**：压缩仍超长（或压缩调用失败）时，`trimPersonaBody()` 按整行回退到 `targetChars`，
   末尾加 `…`，绝不切断句子；结果与 `rawChars/trimmed` 一起记进 `l3-last-detail`；
3. prompt 措辞从「约 N 字（硬上限 M 字）」改成「**长度硬性上限：N 字（超出部分会被直接截断丢弃）**」，
   让模型先按硬约束写。

**回归**：160 → **163** 项全绿（新增「压缩回合先于裁剪」「行边界裁剪」「超长画像落库前被收敛」三条）。

**实测残留已清**：0.5.4 写出的 v7（1200 字）已恢复成整理好的 `v8/650`，场景导航回到注入里
（cores 2 + 650 + 203 + 524 ≈ 1700 / 1800）。0.5.5 加载后再跑一次 `memory_compact` 即可看到
「压缩回合 → 落库 ≈700 字」的完整闭环。

### 23.12 自动压缩首次闭环成功 + 两处收尾（2026-10-23 11:41）

**0.5.5 实测**（重启后 `memory_compact {scope:'project'}`）：

```json
{ "reason": "written", "chars": 618, "rawChars": 1770, "trimmed": true, "attempts": [
  { "tokens": 4000, "effort": "low", "ok": true, "finish": "stop", "chars": 1811 },
  { "stage": "compress", "ok": false, "finish": "max-tokens", "chars": 0 } ] }
```

- **无人干预下第一次真正把画像压小了**：模型生成 1770 字 → 落库 **618 字**（≤ target 700），
  `stableBlock` 实测 1859 字（含 intro），**场景导航回到注入里**，这一步的目标达成；
- 但压缩回合**自己**又栽在 `max-tokens / chars:0`（同样是 reasoning 吃光预算），所以这次实际走的是裁剪兜底；
- 而当时的裁剪切的是尾段，把排最后的「操作约定」（记忆库路径、重启规则、测试 EPERM、代理）裁掉了——
  内容上能接受，但不是最优。

**0.5.6 两处收尾**：

1. **压缩回合也三级升级**：`4000/低档 → 8000/低档 → 8000/默认档`，不再一次 max-tokens 就放弃；
2. **裁剪改为按小节**：保留每个 `## ` 小标题、按「每节先保 1 行、再放 2 行…」逐步放宽直到装进预算，
   保证排最后的「操作约定」不会整节消失；只有连「每节 1 行」都装不下时才退回头部截断。

**回归**：163 → **164** 项全绿（新增「按小节裁剪保留全部小标题」；`trimPersonaBody` 相关断言按新语义调整）。

**部署说明**：0.5.6 不是修 bug，只是质量优化；当前 live 画像已恢复成整理版 `v10/650`，
**不需要为它专门重启**——下次重启自然生效，届时下一次画像重写会先走压缩回合、必要时再按小节裁剪。

## 24. 动态配置与设置页（2026-10-23）

> 这节回答四件事：为什么这些参数**能不重启就改**、设置写在哪、怎么校验与合并、路由对外暴露时怎么防跨站。

### 24.1 问题

| # | 事实 | 后果 |
| --- | --- | --- |
| 1 | 所有参数只能写在 profile 的 `cordis.patch.yml` / bundle 行 config 里 | 改一个 `maxItems` 也要改文件 + 重启 DSH |
| 2 | 46 个参数分散在 8 个嵌套段，没有校验与反馈 | 写错只是静默回落默认值，用户以为改生效了 |
| 3 | 只有 `memory_stats` 的文本输出末尾带 `path=` | 用户不知道记忆库/设置文件到底在哪、有多大 |
| 4 | 没有 UI，`settings.section` 里没有记忆这一栏 | 「临时关掉捕获/召回」只能改配置重启或卸载插件 |
| 5 | 参数只存在 YAML 一处 | 用户改过的值与「profile 基线」无法区分，也没有「恢复默认」的入口 |

### 24.2 三层配置：默认 < YAML < 设置页

```text
resolveConfig 内置默认值        （src/settings.js：46 个字段各一份）
  < loader 行 config            （cordis.patch.yml / bundle insert config）
    < $DSH_HOME/memory/settings.json   （设置页写的，只含显式改过的 key）
```

- **默认值单源**：`resolveConfig` 从 `index.js` 搬到 `src/settings.js`，字段目录里的 `default` 由 `resolveConfig({})` 推导，所以「设置页显示的默认值」与「插件启动时真正用的值」不可能漂移。
- **设置文件与 `dbPath` 解耦**：固定 `$DSH_HOME/memory/settings.json`。若跟着 `dbPath` 走，把库挪到别处会让「挪库」这条设置本身丢失。需要重定向时用 loader 行 config 的 `settingsPath`（测试/打包口子，不暴露给 UI）。
- **合并顺序**：`deepMerge(loaderRaw, storedSettings)` 得到原始合并对象，再交给 `resolveConfig` 归一化。深合并意味着 YAML 里写全的 `extraction` 段与设置页只改的 `extraction.everyN` 可以共存；标量/数组整体覆盖，后者赢。
- **来源判定**（`collectSources`）：settings 层里出现过该 key → `settings`；否则 YAML 里出现过 → `config`；否则 `default`。UI 的「来源徽标」就是它。注意「填一个和默认值相同的数」同样算 `settings` —— 想回默认必须 `unset`。

### 24.3 为什么能原地生效

`apply()` 里的 `config` 是 `resolveConfig(...)` 返回的普通对象，召回（`agent/pre-step`）、捕获（`session/event`）、工具都在闭包里反复读它的**属性**，所以改属性就等于改行为：

| 读取点 | 每次何时读 | 改完何时生效 |
| --- | --- | --- |
| `config.maxItems/maxChars/minScore/scope/injectGlobalFacts/stableMaxChars`、`core.*`、`layers.*`、`scenes.halfLifeDays` | 每个 `agent/pre-step` | 下一轮 |
| `config.capture`、`layers.l0` | 每个 `session/event` | 下一轮 |
| `config.vector.*` | 每次 `recall()` | 下一次召回 |
| `config.persona.*`、`scenes.*` | 每批 L2/L3 任务 | 下一批 |

两个**构造时拷贝**的例外，保存后由宿主显式推一把：

- `pipeline` 在 `createPipeline` 里 `cfg = { ...PIPELINE_DEFAULTS, ...config.extraction }` → 新增 `pipeline.refresh()` 重新从 `options.config.extraction` 同步（`src/pipeline.js`）。
- `scheduler` 构造时复制 `everyN/idleMs` → 新增 `scheduler.configure({ everyN, idleMs })`（`src/scheduler.js`）。**已 armed 的 idle 定时器保留原延迟**：保存时清掉它会丢掉这次兜底触发，下一轮结束自然按新值重排。

写入用 `writePath`（`src/settings.js`）逐字段赋值，并且**保留中间对象的引用**：把整个 `config.extraction` 换成新对象，`pipeline` 里已经拿到的引用就与后续更新脱钩了。

**五个字段不能热改**（`live:false`）：

| key | 为什么 |
| --- | --- |
| `storage.dbPath` | 数据库句柄在 `apply()` 打开，换路径=换库 |
| `skills.enabled` / `skills.dir` | 技能在 `apply()` 注册进宿主技能表，生命周期与插件 fiber 绑定 |
| `extraction.provider` / `extraction.model` | LLM 客户端在 `apply()` 解析一次模型路由 |

它们的 `state` 里同时给 `value`（合并后、下次启动会用）与 `active`（运行中实例实际在用），两者不同 = 改了但还没重启；保存响应把它们列进 `restartRequired`，不假装生效。

一条**只在启动时成立的前置条件**：抽取管线（`pipeline`/`scheduler`/LLM 客户端）只有在 `apply()` 时满足 `layers.l1 && extraction.enabled && 能解析到 provider/model` 才会创建。启动时就是关的，设置页把开关打开也不会凭空造出管线（`pipeline === null`，`pipeline?.refresh()` 是空操作），只有保存后的字段值变了；要真的开始抽取得重启。`state.runtime.extraction.{available,scheduled}` 就是把这个事实摊开，页面暂未渲染它。

不采用「保存后 dispose + 重新 apply」：那会丢会话级注入状态（`stableInjected`/`globalIds`）、可能中途关库、还会让工具注册表短暂消失；为了 5 个字段不值得，重启是更诚实的语义。

### 24.4 设置文件

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

- `settings` 的形状 = **loader 行 config 的形状**，不是 UI 分组名：`recall.maxItems` → 顶层 `maxItems`，`storage.dbPath` → 顶层 `dbPath`。这样同一段 JSON 可以直接粘进 `cordis.patch.yml` 的 `config:`，也让 `deepMerge` 与 `resolveConfig` 直接复用启动时的同一套代码。
- 写入 `writeSettingsFile`：`mkdir -p` → 写 `settings.json.tmp` → `rename` 原子替换；失败时尽力删掉临时文件，并把错误交给上层（→ 500 `io-error`）。
- 读取 `readSettingsFile`：文件不存在 → `exists:false, settings:{}`；不是合法 JSON / 顶层不是对象 / 超过 1 MB → `settings:{}` + `error`（**不抛**，插件照常启动，原因显示在设置页 `storage.error`）。读回时剔除 `version`/`updatedAt`，避免它们混进配置合并。
- 兼容手写：顶层没有 `settings` 包装时，整个对象当作 settings 层。
- 删除文件 / 点「恢复 YAML 基线」= 清空这一层，回到 YAML + 默认（`clearSettingsFile`）。

### 24.5 校验与合并算法

`POST /memory/api/save` 一次请求走完下面 6 步，任一步失败都**不落盘、不动内存**：

| # | 步骤 | 实现 | 失败语义 |
| --- | --- | --- | --- |
| 1 | 校验 `patch` | `validatePatch`：逐个 key 查 `FIELDS`；`number` 非数字才报错、越界**夹到 [min,max]**；`text` trim + ≤500 字；`enum` 白名单；`boolean` 严格 | 收集**全部**错误后一次性 400，`message` 是 `key: message` 用 `; ` 连接 |
| 2 | 校验 `unset` | `validateUnset`：必须是字符串数组且 key 在 `FIELDS` 里 | 同上 400 |
| 3 | 转成 config 形状 | `toNested(flat)` 用字段的 `path` 写嵌套对象 | — |
| 4 | 合并到 settings 层 | `deepMerge(storedSettings, toNested(...))`，再按 `unset` 逐个 `deletePath`（顺带清掉空对象） | — |
| 5 | 重新归一化 | `resolveConfig(mergeRaw(loaderRaw, nextStored))` | 归一化不会抛（`number` 有 fallback） |
| 6 | **先落盘，再应用** | `writeSettingsFile` → `applyLiveConfig(config, next)` → `pipeline.refresh()` → `scheduler.configure()` | 落盘失败 → 500 `io-error`，内存与磁盘都不变 |

为什么先落盘：页面、`state` 与下次启动必须一致。先改内存再写盘，一旦写失败，运行中的行为与下次启动就会分叉（页面显示已生效、重启又变回去）。

为什么数字越界夹取而不是报错：控件本来就是滑块/步进，正常操作不可能越界；粘贴一个 `999` 时夹到上限比拒绝更符合预期。但**未知 key / 类型错 / 枚举外**必须报错——那是客户端或人手写 YAML 的错误，静默接受只会更难查。

`reset` 复用同一套尾部逻辑：`keys` 为空 → `clearSettingsFile`；给了 keys → 从 settings 层删除这些 `path`，删空也清文件；随后同样 `applyLiveConfig + refresh + configure`。

### 24.6 路由：POST-only + 惰性挂载 + 连接信任

`src/api.js` 只做「一个前缀路由 + 方法表」，业务在 `index.js`：

| 检查顺序 | 行为 | 为什么是这个顺序 |
| --- | --- | --- |
| 1. 连接信任 `admits(req)` | 不通过 → 403 `forbidden` | 未受信任的调用方连「有哪些方法」都不该知道 |
| 2. `req.method !== 'POST'` | → 405 `method-not-allowed` | 跨站 `<form>`/`<img>` 只能发 GET/form-urlencoded，发 `application/json` 会触发 CORS 预检；同源页面 `fetch` 不受影响 |
| 3. 路径前缀 `/memory/api/` | 不匹配 → 404 `not-found` | 前缀路由被宿主交给本插件时才可能进来 |
| 4. 方法名在方法表里 | 否 → 404 `not-found` | 避免把「方法不存在」与「参数错」混成一个码 |
| 5. 读 body | 非 JSON / 非 object / > 64 KB → 400 `bad-request` | 这里的 payload 都是几百字节的小对象 |
| 6. 执行 handler | 业务错 → 对应 code；`TypeError`/`RangeError` → 500 `internal` + 稳定文案 | 编程错误不该把堆栈泄露给页面，细节只进日志 |

- **惰性挂载**：插件主 `inject` 只有 `['tools','agents','sessions']`，路由在 `ctx.effect` 里用 `ctx.inject(['webServer'], webCtx => webCtx.effect(() => webCtx.webServer.register(apiRoute)))` 单独等 `webServer`，返回的 fiber 随插件释放时 dispose。纯 CLI / headless profile 没有 `webServer` 时路由根本不挂载，记忆、工具、注入全部照常——插件不会因为「没有 GUI」而加载失败；宿主没有 `ctx.inject`（很老的版本）时同样跳过挂载，挂载过程抛错只 warn 一行。
- **连接信任**：`admits` 读 `ctx.get('connection')?.requestRejection(req)`，`undefined` 才算可信；没有 `connection` 服务（自托管/测试宿主）时放行。拒绝时返回 403 且**不解释**原因。
- **响应**：`content-type: application/json; charset=utf-8`、`cache-control: no-store`；成功 `{ok:true,value}`，失败 `{ok:false,error:{code,message}}`，`code` 稳定、`message` 可展示给用户。
- **不挂 CORS 头**：页面与路由同源，允许跨源只会扩大攻击面。

### 24.7 前端契约（`client.js`）

- 单文件、无构建：`window.__ModuleLoader__.load({ id: 'dsh-memory-layered', factory(require) })`，`require('react')` + `React.createElement`（无 JSX）；数据弹窗额外尝试 `require('react-dom')` 的 `createPortal`（解析不到就退化为内联 fixed 定位）。
- 注册一个 `settings.section` occupant（id `memory`），只调 `/memory/api/{state,save,reset,reveal}`，**不读 DOM、不碰别家状态、不自己决定默认值**。
- host 是唯一真相：保存/重置后直接用响应里的 `state` 重渲染；页头「刷新」重新拉 `state`，别处改的 YAML 也能看到。
- 文案中英双语，字段标签/说明按 **host 的 field key** 索引；新增一个字段 = `src/settings.js` 加一行 + 字典加两条，页面自动出现。
- 请求 15 秒超时（挂死的请求不能冻住设置页）；样式只用 `--dsw-alias-*` 主题 token（带回退），单 `<style data-plugin-css="dsh-memory/section">`。

### 24.8 失败降级

| 失败 | 行为 |
| --- | --- |
| `settings.json` 损坏 / 超大 / 顶层不是对象 | 读回 `{}`，warn 一行，插件照常启动，页面 `storage.error` 显示原因 |
| 写 `settings.json` 失败（只读、占用、杀软） | 500 `io-error`，内存配置保持原样；页面提示保存失败 |
| 没有 `webServer`（headless） | 路由不挂载，其余功能照常 |
| 没有 `connection` 服务 | 信任校验放行（本地/测试宿主） |
| `reveal` 调不起文件管理器 | spawn 抛错 → `{opened:false,error}`；文件管理器异步启动失败只记 warn（`opened` 仍为 true）。页面提示「已打开存储目录」不代表窗口一定出现，路径始终可复制 |
| 数据库打不开 | `dbReady=false`；`state.stats` 返回全 0，设置页仍可读可写参数 |
| 设置页请求失败/超时 | 页面显示错误 + 「重试」，已渲染的内容保留 |

### 24.9 手工核对

```powershell
# 读全量状态（桌面版启用连接信任时，未带浏览器会话的请求会被 403 —— 这是预期）
$state = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/memory/api/state -ContentType 'application/json' -Body '{}'
$state.value.storage.dir
$state.value.groups | ForEach-Object { $_.id + ': ' + $_.fields.Count }

# 改一个立即生效的参数，再读回来
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/memory/api/save -ContentType 'application/json' -Body '{"patch":{"recall.maxItems":8}}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/memory/api/reset -ContentType 'application/json' -Body '{}'
```

> 设置页是 dsh Web 界面的一部分，端口随本次启动而变（桌面版窗口里跑的就是它）；插件不额外提供 CLI。

### 24.10 行为用例

两个测试文件覆盖这一层的可判定行为，全部在 `mkdtempSync` 的临时目录里跑，不碰真实 `~/.dsh`、不监听端口、不 spawn 真实进程（`revealDirectory` 注入 fake spawn，`/memory/api/reveal` 不在测试里调用）：

**`test/settings.test.js`**（纯函数 + 文件层）

| 分组 | 覆盖点 |
| --- | --- |
| 字段目录 | 每个 `default` 都等于 `resolveConfig({})` 在同一 `path` 上的值；key 唯一、group 存在、类型元数据完整；重启项恰好那 5 个 |
| 校验 | 数字钳位（`100 → 20`、`-5 → 0`）、数字字符串接受、`text` 裁剪与 ≤500、enum 空串合法；错误类型/未知 key/非对象 `patch` 被拒且不进 `flat` |
| 合并 | `mergeRaw` 的 settings > loader > 默认、深合并嵌套段、不改入参；`collectSources` 三态来源；`undefined` 不算「设置过」 |
| 原地生效 | `applyLiveConfig` 只写 live 字段、`config.extraction/core/layers` 引用不变、`applied` 只列真正变化的 key、重启项只报告不应用 |
| 设置文件 | 缺失/损坏/非对象/超 1 MB 的读回降级；`{settings}` 包装与裸对象；原子写可读回、不残留 `.tmp`、覆盖写不残留旧 key；删除语义 |
| 存储目录 | `describeStorage` 的文件列表/体积/`settingsExists`、缺目录不算错误 |
| 打开目录 | 三平台命令（`explorer.exe`/`open`/`xdg-open`）、同步抛错 → `opened:false`、异步 ENOENT 只记 warn |

**`test/settings-route.test.js`**（stub cordis context 跑真实 `apply()`，再让真实 POST 请求穿过 handler）

| 分组 | 覆盖点 |
| --- | --- |
| 挂载与 state | `ctx.inject(['webServer'])` 注册 prefix 路由；`state` 的 `plugin/storage/stats/runtime/groups` 结构；分组顺序；字段元数据；空请求体可用 |
| 启动期优先级 | settings 层盖过 YAML（`source=settings`）、YAML 盖过默认（`source=config`）、坏设置文件照常启动并在 `storage.error` 报错 |
| save | 动态字段立即生效（关掉 `capture` 后下一轮真的不落库）、只落盘改过的 key、重复保存 `applied=[]`、`unset` 回默认并剪掉空分组 |
| 重启项 | `storage.dbPath` 的 `applied=[]` / `restartRequired` / `value` vs `active` / 运行中存储卡片仍指旧库 / 照样落盘 |
| reset | 全量：删文件、回到 YAML/默认；`keys`：只退指定字段，其余覆盖保留 |
| 错误码 | 校验失败 400 且不落盘、未知方法 404（含 `state/extra`）、非 POST 405、非法 JSON 与非对象 400、超 64 KB 400、`requestRejection` 拒绝时 403 且先于方法校验 |

## 25. 记忆数据弹窗：设置页里的行级 CRUD（源码，2026-10-23）

### 25.1 问题

设置页只能改参数，看得到「共 N 条」却看不到 N 是什么，更删不掉一条记错的记忆。此前唯一的行级入口是模型工具
（`memory_search` / `memory_forget`），用户得让模型代劳；`memory_save` 还只允许 `fact`/`note`，无法修正类型或置顶。

### 25.2 形态

「记忆数据」卡片（统计卡下面）→「管理数据」→ 覆盖视口的弹窗：

- **查**：标题/正文/标签子串搜索（LIKE，2 字中文可命中）；类型/范围/项目三个下拉的选项与计数来自 `facets`；「含已取代」开关；每页 20 条，服务端分页。
- **增/改**：同一个表单（正文必填、标题、类型、范围、项目、标签、优先级、常驻），编辑时额外显示最近 10 条旧正文。
- **删**：行上删除 + `window.confirm` 二次确认。
- 所有请求走 `POST /memory/api/{memories,memory,memoryCreate,memoryUpdate,memoryDelete}`；成功/失败提示都在弹窗内，不打断设置页的参数编辑状态。

### 25.3 为什么 CRUD 落在 `src/data.js` 而不是 `index.js`

- 页面只认 camelCase JSON，schema（`superseded_by` / `vec_model` / `memory_features`）不外泄；
- 手工编辑必须复用抽取管线的全部不变量，不能另开一条「只 UPDATE 文本」的捷径；
- 纯函数 `(db, payload) => result` 才能用 `mkdtempSync` 的临时库单测，不需要 cordis context。

### 25.4 不变量

| 动作 | 必须发生什么 |
| --- | --- |
| 新增 | 写 `memory` 行 → FTS 触发器建索引 → 写 `vec/vec_model` → `indexMemoryFeatures`；文本命中已有 `hash` 时不插新行，改为更新那行的属性并回 `inserted:false` |
| 改正文 | 旧正文写 `memory_history` → `version+1` → 重算 `hash` → 重算向量 → 重写特征索引；新正文若被另一行占用 → 409 `conflict`，两行都不动 |
| 改属性（标题/标签/优先级/置顶/类型/范围） | 只更新列与 `updated_at`；**不**涨 `version`、**不**写历史（版本号表示正文版本） |
| 删除 | `DELETE memory`；FTS 与 `memory_features` 由既有触发器清理；`memory_history` 保留（与 `memory_forget` 一致） |

校验边界：正文 ≤ 20000 字；标签 ≤ 20 个、每个 ≤ 64 字；`priority` 夹到 0–100；`kind` 必须在 `KINDS` 内；
`scope='project'` 必须带 `project`（否则该行在所有读路径上都不可见）；`ids` 一次最多 100 个。

### 25.5 路由与错误码

新增 5 个方法（全部 POST）与 2 个稳定错误码：`conflict`(409)、`not-ready`(503)。数据库没打开时参数页照常可用，
只有数据接口回 `not-ready`；未知 id 回 `not-found`；正文冲突回 `conflict` 并给出占用的行号。

### 25.6 前端实现要点

- 弹窗是独立组件 `MemoryDataBrowser`（`createSection` 只负责开关），每次打开重新拉第一页，不在关闭时保留旧列表。
- `react-dom` 在宿主静态模块表里，因此用 `createPortal(overlay, document.body)`：设置面板可能位于滚动/变换容器中，
  fixed 定位会被祖先建立包含块；解析不到 `react-dom` 时退回内联渲染（CSS 仍是 fixed）。
- 筛选变化在**同一次调用**里带上新值（`fetchPage(1, {kind})`），不依赖 setState 后的闭包；删除最后一页唯一一行时自动退一页。
- 每次写成功调 `onChanged()`（父级重拉 `state`），统计卡立即更新；列表按当前筛选/页码重读。
- 表单不自己造默认值：`kind` 默认 `work_fact`、`priority` 50、`scope` global，与 `src/data.js` 的 host 默认一致；
  真正的校验以 host 的 400/409 为准，前端只挡「正文为空 / 超长 / 项目缺名」。

### 25.7 验证证据（2026-10-23）

| 层 | 手段 | 结果 |
| --- | --- | --- |
| 单元 | `test/data.test.js`（13 例：插入/幂等/校验/分页/2 字中文搜索/失效行过滤/facets/历史/改正文/只改属性/冲突/删除/FTS+特征清理） | pass |
| 路由 | `test/data-route.test.js`（5 例：完整增查改删 + `state.stats` 跟随 + 400/404/409/503/403） | pass |
| 全量回归 | `node --test --test-isolation=none <test/*.test.js>` | **214/214 pass** |
| 真实浏览器渲染 | `.tmp/ui-check`：真实 `client.js` + React 18 UMD + Edge headless（`--dump-dom` / `--screenshot`），宿主响应由页内 mock 按同一契约提供 | 列表/表单/暗色截图；14 项交互断言全绿（打开→搜索→含已取代→清空→编辑带历史→保存→新增→删除→关闭） |
| 既有页面 | `.tmp/client-render-check.mjs`（迷你 hook runtime 渲染真实 state） | 仍通过；字典 260 键、zh/en 对称 |

> 已知限制：会话里没有浏览器控制能力，无法替用户点击真实 GUI；真实宿主的路由受连接信任闸门保护（CLI 无 cookie → 403），
> 因此端到端证据由「真实 apply() + 真实 POST 穿过 handler」的路由测试承担，客户端由真实 React 的浏览器渲染承担。
---

## 26. v0.8.0：可配置向量模型（2026-10-27，源码）

完整分析见 [ANALYSIS-vector-model.md](ANALYSIS-vector-model.md)，这里只记决策与证据。

### 26.1 需求

设置页能配置向量模型；不配 = 今天的内置词法；配了 = 走配置的模型；维度可填，也可从模型读默认。

### 26.2 关键决策

| 决策 | 取舍 |
| --- | --- |
| **独立 `memory_embeddings` 表**，不接管 `memory.vec` | `vec` 只有一个 `vec_model` 取值，混入不同模型/维度会互串；独立表让「换模型 = 换 tag」，无需迁移、可随时回退 |
| **写入路径保持同步**，外部向量由后台 worker 补 | `saveMemory`/`createMemory`/`l1` 三处都是同步调用，改成 async 会波及工具链与全部测试；异步补齐把「网络慢/挂」隔离成召回质量问题 |
| **`recall()` 保持同步**，查询向量由 pre-step 算好传入 | 只有查询侧需要一次 HTTP；在 async 的 pre-step 里 await 一次，比把 `recall` 改成 async 的改动面小一个数量级 |
| **绝对阈值 + 线性归一** `(cos-floor)/(1-floor)` | 不做按批 min-max：同一行不该因为别的候选加入而改变分数；代价是 `minCosine` 必须按模型家族调 |
| **不发送 `dimensions` 参数** | 多数 OpenAI 兼容服务会 400；`vector.dims` 只做声明与校验 |
| **维度 tag 化** `openai:<model>@<dims>` | 改维度也必须让旧行失效，否则会把不可比的向量混算 |
| **语义通道不用倒排预筛** | 倒排按字词重合提名，正好漏掉语义匹配；改为 `scanLimit` 有界扫描（与词法兜底同一取舍） |

### 26.3 新增/改动模块

- `src/embedding.js` — 模型运行时：`hash`（内置）与 `openai`（兼容接口）两种实现，维度解析（配置 → 模型表 → 探测缓存 → 现场探测）、tag、密钥引用解析（`ctx.credentials` → `process.env` → 字面值）、查询缓存、L2 归一化、永不抛错。
- `src/embedding-store.js` — `memory_embeddings(memory_id, model, dims, text_hash, vec, created_at)`（`WITHOUT ROWID` + 删除触发器）、pending 查询（`text_hash <> memory.hash` 即过期）、按 tag 取向量、有界语义扫描、计数、清其它模型。
- `src/embed-worker.js` — 32 条/请求、256 行/轮、失败指数退避（5s→5min）、换 tag 清旧行、`unref` 定时器、`drainOnce()` 可测。
- `src/recall.js` — 语义分支（提名 + `minCosine` + 归一打分）、`strategy` 增加 `+sem`；词法分支一字未改。
- `src/settings.js` — 7 个新字段（全部 `live:true`），`resolveConfig` 默认 `provider: 'hash'` / `dims: 0`。
- `index.js` — 模型运行时的构建/重建、pre-step 与 `memory_search` 的查询嵌入、写入后的 nudge、`runtime.vector` 状态、`embeddingTest` 诊断端点、`memory_stats` 的 `sem=`。
- `src/store.js` — `SCHEMA_VERSION` 4→5，`ensureEmbeddingSchema`。
- `client.js` — 新字段的中英词典、统计卡下的「向量模型」状态行（含最后一条错误）。

### 26.4 验证证据（2026-10-27）

| 层 | 手段 | 结果 |
| --- | --- | --- |
| 维度/接口 | `test/embedding.test.js`（19 例：归一化、已知表、探测与缓存、密钥（含凭据对象解包）、HTTP 错误、超时、维度不一致、缓存） | pass |
| 存储 | `test/embedding-store.test.js`（8 例：宽/模型隔离、pending 顺序、过期、作用域扫描、清旧模型、级联删除、计数） | pass |
| 回填 | `test/embed-worker.test.js`（9 例：分批、失败退避与恢复、换 tag 清行、配错不毁旧向量、内置/不可用跳过、维度解析、dispose、调度） | pass |
| 召回 | `test/recall-semantic.test.js`（8 例：无字面重合命中、阈值、排序、无向量不增益、词法回归、关闭、宽度不匹配、tag 隔离） | pass |
| 端到端 | `test/semantic-e2e.test.js`：真实 `apply()` + 本地假 `/v1/embeddings` → `memory_save` → worker 回填 → 下一轮 pre-step 语义注入；关掉服务后退回词法 | pass |
| 设置层 | `test/settings.test.js` / `test/settings-route.test.js`：新字段默认值/钳位/枚举、热更新、落盘、`runtime.vector`、`embeddingTest` | pass |
| 页面渲染 | `test/client-render.test.js`：用 ~40 行 hook runtime + `vm` 跑**真实** `client.js`，断言向量模型行（tag/维度/已嵌入 x/y/错误红字）与内置模式下不渲染该行 | pass |
| 全量回归 | `node --test --test-isolation=none test/*.test.js` | **265/265 pass** |
