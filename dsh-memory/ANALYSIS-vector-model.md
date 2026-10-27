# 可配置向量模型：分析与设计

> 目标（用户原话）：**在设置里可以配置向量模型；默认不配置走目前的自有算法，配置后就走配置的模型；可以配置维度，或者根据模型读取默认维度。**
>
> 本文先给分析（现状、约束、方案对比、风险），再给落地设计（配置字段、表结构、写入/回填/查询链路、降级矩阵、测试计划）。实现见同批次提交。

---

## 1. 需求拆解

| # | 需求 | 判定标准 |
| --- | --- | --- |
| R1 | 设置页能配置向量模型 | Settings → 记忆 → 向量 分组里出现「模型 / 维度 / 地址 / 密钥 / 阈值」等字段，保存后写入 `$DSH_HOME/memory/settings.json` |
| R2 | **不配置**时行为与今天完全一致 | `provider=hash`（默认）时走的还是 `src/vector.js` 的 384 维词法哈希，不联网、不加初始化耗时、老数据继续命中 |
| R3 | 配置后走配置的模型 | 写入与查询都用外部 `/embeddings` 接口产出的向量；召回结果能体现「字面不重合但语义相近」 |
| R4 | 维度可配置，也可从模型读取 | `vector.dims > 0` 用它并校验；`= 0` 时按「内置模型维度表 → 库内探测缓存 → 现场探测一次」的顺序解析 |
| R5 | 切换/关闭不毁数据、可回退 | 换模型不改 `memory` 表；回退到 `hash` 后词法向量立即可用；外部向量单独存表，删掉即可回收 |

非目标（本批次不做）：外部向量库（Milvus/Qdrant）、ANN 索引、rerank 模型、把 embedding 结果写回 `memory.vec` 列、DSH 内核级 embedding 服务（内核没有，见 §3）。

---

## 2. 现状（代码级事实）

### 2.1 已有「自有算法」

- `src/vector.js`：`VECTOR_DIMS = 384`，`VECTOR_MODEL = 'hash-ngram-v1-384'`；`embed()` 是 feature hashing（CJK 2/3/4-gram + 拉丁词 + `l3:` 三元组），带符号哈希 + L2 归一化；`packVector/unpackVector/cosine`。
- `src/feature-index.js`：把**未哈希**的特征倒排进 `memory_features`，召回时先用稀有特征提名候选（`candidateMemoryIds`），再用精确余弦重排。
- 写入：`store.saveMemory()`、`data.createMemory/updateMemory()`、`l1.js` 三处**同步**调用 `embed()` 并把 `packVector(...)` 写进 `memory.vec`，`vec_model = VECTOR_MODEL`。
- 回填：`store.openDatabase()` 里 `backfillVectors(db, {limit: 500})`，也在 `backfillFeatureIndex()`。
- 召回：`src/recall.js` 的 `recall()` **是同步函数**，先 FTS、再 LIKE、再向量（倒排预筛 → 精确余弦，或 `scanLimit` 有界兜底扫描）；`scoreRow()` 里 `vector * vectorWeight`。
- 设置：`src/settings.js` 的 `FIELDS` 目录 + `resolveConfig()`；设置页（`client.js`）由目录**自动渲染**，`vector` 分组现有 5 个字段。

### 2.2 关键约束

1. **`recall()` 必须保持同步**：它被 `agent/pre-step`（async，可以 await）和 `memory_search` 工具调用，但内部是纯 SQLite 读 + 纯计算。把它改成 async 会波及 20 多个测试与全部调用点。
2. **三处写入路径都是同步的**：`saveMemory()` 在工具执行、L0→L1 抽取、场景归并里被同步调用。把 `embed()` 换成 HTTP 会让每次存记忆都可能等网络。
3. **`memory.vec` 只有一个列 + 一个 `vec_model` 取值**：`recall()` 用 `row.vec_model !== VECTOR_MODEL` 直接判废。不同模型、不同维度的向量**不能**混进同一列。
4. **DSH 内核没有 embedding 能力**：`@deepseek-ai/dsh-llm` 的 `LlmRuntime` 只暴露 `stream()` / `listModels()`（已核对 `lib/types/index.d.ts`），`llm-deepseek` / `llm-pi-ai` 里也没有 embeddings 调用。所以必须由插件自己发 HTTP。
5. **密钥不能进 settings.json 明文**：DSH 的惯例是 `ctx.credentials.resolve(ref)`（`@deepseek-ai/dsh-credentials`：配置只存**环境变量名**，值由 provider 管）。
6. 插件里任何 IO 失败都不能拖垮会话；设置页/召回必须能「降级而不是抛错」。

---

## 3. 方案对比

| 方案 | 做法 | 优点 | 致命点 |
| --- | --- | --- | --- |
| **A. 原地改 `memory.vec`**：写入时改调远端 | `saveMemory` 等改成 async，`embed()` 换成 HTTP | 复用现有列/预筛/召回代码 | ① 三条写入路径全部异步化，工具与抽取链路都要改，同步测试全崩；② 一次网络抖动就丢记忆；③ `vec_model` 单值，换模型要么全量重算要么数据互串；④ 每次保存都要等 RTT |
| **B. 独立向量表 + 后台 worker**（选用） | `memory_embeddings(memory_id, model, dims, text_hash, vec)`；写入路径**不动**，worker 异步补齐；召回时按当前模型 tag 取向量 | ① 写入零延迟、失败只影响「语义召回缺席」；② 多模型/多维度天然共存；③ 换模型=换 tag，旧数据自动失效且可回收；④ `recall()` 保持同步（只多读一张表）；⑤ 回退 `hash` 时老数据原封不动 |
| C. 外挂向量库 | 引入 Qdrant/Chroma | 检索规模大 | 违背「零依赖、单文件 SQLite」的既有承诺；运维成本与插件定位不符 |

**结论：方案 B。** 外部模型与内置算法在同一插件里是**两条并行通道**，靠配置切换；`memory.vec` 继续承载「自有算法」，新表承载「外部模型」。

---

## 4. 设计

### 4.1 配置（新增字段，全部可热更新）

`src/settings.js` 的 `vector` 分组新增 7 个字段（`live: true`，保存即生效；worker 会被重建）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `vector.provider` | enum `hash` \| `openai` | `hash` | `hash`＝内置词法（今天的行为）；`openai`＝OpenAI 兼容 `/embeddings` |
| `vector.model` | text | `''` | 如 `text-embedding-3-small`、`BAAI/bge-m3`、`nomic-embed-text:latest` |
| `vector.dims` | number 0..4096 | `0` | `0` = 自动解析（见 §4.2）；显式值用于校验与建 tag |
| `vector.baseUrl` | text | `''` | 留空 → `https://api.openai.com/v1`；不以 `/embeddings` 结尾时自动补 |
| `vector.apiKeyRef` | text | `''` | **优先当凭据引用**（`OPENAI_API_KEY`，经 `ctx.credentials` → `process.env`）；不像标识符时当字面密钥 |
| `vector.minCosine` | number 0..1 | `0.5` | 语义召回的绝对下限（不同模型分布不同，必须可调） |
| `vector.timeoutMs` | number 500..60000 | `5000` | 单次嵌入请求超时 |

> `vector.enabled=false` 时**完全**不发请求（语义通道与词法通道一起关）。

### 4.2 维度解析（R4）

按顺序取第一个可用值，并把「来源」显示在设置页 runtime 里：

1. `vector.dims > 0` → `config`；
2. 内置维度表 `KNOWN_MODEL_DIMS`（归一化后匹配：小写、去 `:tag`、去 `org/` 前缀、最长前缀匹配）→ `known`；
   覆盖 `text-embedding-3-small/large`、`ada-002`、`bge-m3`、`bge-{large,base,small}-zh-v1.5`、`nomic-embed-text`、`mxbai-embed-large`、`all-minilm`、`jina-embeddings-v2/v3`、`text2vec`、`m3e-base`、`gte-large`、`qwen text-embedding-v*` 等；
3. 库内缓存 `meta['embedding-dims']`（`JSON {endpoint|model: dims}`，上次探测结果）→ `cache`；
4. 现场探测：发一条 `probe` 文本，取返回数组长度，写回（3）→ `probed`；
5. 都失败 → 维度未知 → 语义通道不可用，**降级到词法**并在设置页显示错误（不抛）。

返回长度与已解析维度不一致时：`dimension-mismatch` 错误（不写库、不静默截断）。

### 4.3 模型 tag（失效的关键）

`embeddingTag()`：

- `hash` → `hash-ngram-v1-384`（即现有 `VECTOR_MODEL`，老数据天然有效）
- `openai` → `openai:<model>@<dims>`，例如 `openai:text-embedding-3-small@1536`

tag 是 `memory_embeddings.model` 的取值，也是「这条向量属于哪个模型」的唯一判据：换模型或改维度 ⇒ 新 tag ⇒ 旧行不再参与打分，worker 在下一轮把旧 tag 的行清掉并重算。**不写 `memory` 表、不改 schema 语义**。

### 4.4 数据模型（schema v4 → v5，纯增量）

```sql
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id INTEGER NOT NULL,
  model     TEXT NOT NULL,          -- tag
  dims      INTEGER NOT NULL,
  text_hash TEXT NOT NULL,          -- = memory.hash，用于发现「正文被改过」
  vec       BLOB NOT NULL,          -- Float32，已 L2 归一化（余弦=点积）
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, model)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx ON memory_embeddings(model);

CREATE TRIGGER IF NOT EXISTS memory_embeddings_ad AFTER DELETE ON memory BEGIN
  DELETE FROM memory_embeddings WHERE memory_id = old.id;
END;
```

- 和 `memory_features` 一样：**只写自己的表**，不触发 FTS 同步触发器，不碰 `updated_at`。
- 6 KB/行（1536 维）→ 1 万条约 60 MB；换模型时清旧 tag，库不会被历史模型撑爆。
- 迁移只在 `migrate()` 里 `CREATE TABLE IF NOT EXISTS`，`SCHEMA_VERSION` 提到 5；老库打开即建表，空表不影响任何既有行为。

### 4.5 写入路径（不改）

`saveMemory` / `createMemory` / `updateMemory` / `l1.js` 保持同步、继续写 `memory.vec`（词法向量）。理由：

- 外部模型的向量由 worker 异步补；正文变了（`hash` 变）worker 会发现（`text_hash <> memory.hash`）并重算。
- 保留词法向量 ⇒ 外部接口挂掉时召回还能退化到今天的水平（R5 的兜底）。

### 4.6 后台 worker（`src/embed-worker.js`）

- `note(delay=300ms)`：去抖调度一次；`kick()` 立刻调度；`drainOnce()` 供测试直接调用。
- 每轮：`pendingEmbeddingRows(tag, limit=256)`（`LEFT JOIN` 找缺行或 `text_hash` 过期，`updated_at DESC`）→ 按 32 条一批 `POST /embeddings` → `putEmbedding()`。
- 失败：指数退避 5s → 10s → … → 5min 封顶；成功后清零。**永不抛**给调用方，只记 `lastError`。
- 定时器 `unref()`，插件卸载 `dispose()`；空闲时 30s 轮询一次（覆盖「重启后补齐」）。
- 触发点：`apply` 启动一次、保存设置后 `refresh()`、`memory_save` / 抽取落库 / 设置页手动建记忆后 `note()`。

### 4.7 查询路径（`recall()` 仍同步）

```
agent/pre-step (async)
  └─ queryEmbedding(text)            # 仅 provider=openai && enabled && 库里有已嵌入行
       └─ client.embedOne(text)      # 带 timeoutMs 上限 5s，失败 → null
  └─ recall(db, text, { vector: {...config.vector, queryVector, model} })
       ├─ FTS  → candidates
       ├─ LIKE → candidates
       └─ 语义通道（useSemantic 时替代倒排预筛/兜底扫描）
            ├─ semanticCandidates(model, scope, scanLimit)  # 有界、按 updated_at DESC
            ├─ 过滤 cosine >= minCosine，取前 maxItems*2
            ├─ getByIds() 拿整行
            └─ scoreRow: vector = (cos - minCosine) / (1 - minCosine)
```

- **查询嵌入失败** → `queryVector = null` → `recall()` 走原来的词法分支（`embed(query)` 本地算），行为等于今天；日志 debug 一行。
- **库里还没有任何该 tag 的行**（刚开语义模型）→ 直接不调接口，省一次 RTT。
- 语义通道不使用 `memory_features` 倒排预筛（那是词法向量的加速结构）；`prefilter` / `featureLimit` 只影响词法分支。语料超过 `vector.scanLimit` 时更老的行不参与语义提名（与今天兜底扫描的取舍一致，写进 README）。
- 打分归一：`vectorScore = clamp((cos - minCosine) / (1 - minCosine), 0, 1)`，绝对、可解释、可调；不使用「按批 min-max」，避免同一行在不同查询里分数飘。
- `strategy` 变成 `fts+like+sem`（词法仍是 `+vec`），便于日志与测试断言走了哪条通道。

### 4.8 设置页 / API

- 字段由 `FIELDS` 自动渲染，`client.js` 只需补 `zh`/`en` 两份词典条目（现有约定：加字段＝加词典项，无构建步骤）。
- `state.runtime.vector` 扩展为：
  `{ enabled, provider, model, dims, dimsSource, tag, endpoint, available, embedded, pending, total, lastError }`
  设置页在「统计」卡片下面用一行小字显示：`向量模型 · tag · 已嵌入 x/y · 待回填 n`，有错误则红字提示。
- 新增 API 方法 `embeddingTest`：现场跑一次嵌入，返回 `{ ok, dims, model, tag, endpoint, ms, error }`，供 CLI/排障与后续 UI 复用（不新增按钮，避免本轮把客户端做复杂）。

### 4.9 失败/降级矩阵

| 场景 | 行为 |
| --- | --- |
| 没配 `provider`/留空 | 走内置词法，零网络请求 |
| 配了但 `model` 为空 | `available=false`，日志 warn，走词法 |
| 密钥缺失/无效（401/403） | 语义通道不可用，worker 退避重试，召回走词法，设置页显示错误 |
| 接口 5xx / 超时 | 同上，指数退避 |
| 返回维度 ≠ 配置维度 | `dimension-mismatch`，不写库，显示错误 |
| 维度无法解析（表里没有且探测失败） | 同上，直到修好配置 |
| 用户切回 `hash` | 立即生效；`memory.vec` 本来就有，召回无变化；外部向量表保留但不再被读（下次切回 openai 且 tag 相同则立即可用） |
| 数据库被更老版本的插件打开 | 新表不存在 → 所有 embedding 访问 try/catch + `hasEmbeddingTable()` 守卫，插件照常工作 |

---

## 5. 成本与性能

- 查询侧：1 次 `/embeddings`（约 50–300 ms，视网络；本地 Ollama 更快），仅在 `provider=openai && enabled` 且库里有已嵌入行时发生。缓存最近 32 条查询文本。
- 写入侧：0 额外延迟（异步补齐）。
- 回填：1 万条记忆、32 条/请求 ≈ 313 次请求；按 256 行/轮、轮间 50 ms 摊平，不阻塞事件循环（每批之间 `await`）。
- 存储：1536 维 ≈ 6 KB/行；只保留当前 tag。
- 召回内存：`scanLimit=2000` × 1536 × 4B ≈ 12 MB 临时读入 → 常驻不保留（打分后丢弃）；如只命中几百行则远小于此。

---

## 6. 迁移与回滚

- 迁移：`SCHEMA_VERSION 4 → 5`，只有 `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`，无数据搬迁；`memory` 表不动。
- 回滚：把 `vector.provider` 设回 `hash`（或删掉 settings.json 里那段）即恢复旧行为；`DROP TABLE memory_embeddings` 可回收空间。代码回滚到旧版本也安全（旧代码不认识新表，只是忽略）。

---

## 7. 测试计划

| 文件 | 覆盖 |
| --- | --- |
| `test/embedding.test.js` | 维度解析（显式/已知表/归一化/最长前缀）、endpoint 归一化、tag 生成、密钥引用 vs 字面、成功解析与 L2 归一化、维度不一致、HTTP 错误、超时、查询缓存 |
| `test/embedding-store.test.js` | 建表、upsert、`text_hash` 过期检测、pending 选取顺序、按 tag 取向量、清其它模型、删除级联、统计 |
| `test/embed-worker.test.js` | 批量大小、失败退避与恢复、换 tag 清旧行、无客户端/无维度时跳过、`dispose()` 后不再跑 |
| `test/recall-semantic.test.js` | 语义提名（字面完全不重合也能召回）、`minCosine` 过滤、归一化打分、FTS 候选也被语义重排、`strategy` 含 `+sem`、缺向量时安静降级 |
| `test/settings.test.js` | 新字段的默认值一致性、类型/范围校验、`live` 契约（重启字段列表不变） |
| `test/wiring.test.js`（追加） | 端到端：假 `/embeddings` 服务 + `apply()` → `memory_save` → worker 补齐 → `agent/pre-step` 注入语义命中的记忆 |

---

## 8. 已知取舍

1. **不做 ANN**：语料规模在万级以内时，`scanLimit` 有界扫描 + 精确余弦足够；引入 HNSW 需要原生依赖，违背零依赖。
2. **语义通道不用倒排预筛**：倒排是给词法哈希用的；语义相似与字面重合无关，用它提名会漏，所以改为有界全扫（按 `updated_at DESC`）。
3. **`dimensions` 请求参数不发送**：OpenAI `text-embedding-3-*` 支持截断维度，但多数兼容服务会 400；因此 `vector.dims` 的语义是「声明/校验」，不改变模型输出宽度。
4. **不做按批归一化**：分数留在绝对 cos 区间，换查询不会「同一行分数乱跳」，代价是要为不同模型家族调 `minCosine`（已给出参考值）。
5. **不自动写回 `memory.vec`**：保留词法向量作为降级通道，是「配置后走模型、挂掉仍可用」的物理保证。
