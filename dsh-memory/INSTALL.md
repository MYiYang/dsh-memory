# 安装 dsh-memory-layered

给 **DeepSeek Harness (dsh)** 加分层跨会话记忆的本地插件。一个包同时带 **4 个 dsh 技能**（`dsh-plugin-dev`、`memory-curator`、`repo-audit`、`windows-pwsh-ops`），装一次两样都有。

零外部依赖：存储用 Node 自带的 `node:sqlite`（FTS5），向量是进程内 384 维**词法**特征哈希，不需要 Docker / Redis / 向量库 / embedding API，也不联网。

- 插件做什么、参数与评测数据：见 [README.md](README.md)
- 设计细节：见 [DESIGN-v2.md](DESIGN-v2.md)

> **关于包名**：npm 上的正式包名是 **`dsh-memory-layered`**（本文命令直接照抄即可）。若你改发 scoped 名（形如 `@yourscope/dsh-memory`），把命令里的包名换掉就行。插件身份、`memory_*` 工具名、4 个技能名都跟包名无关，不受影响。

## 0. 装完你会得到什么

- 5 个工具：`memory_search` / `memory_save` / `memory_forget` / `memory_stats` / `memory_extract`；
- 每轮自动把原文落库（L0），按阈值异步抽取事实（L1）→ 场景（L2）→ 项目画像（L3）；
- 新会话自动注入 `<memory_context type="stable|dynamic" source="dsh-memory">`；
- 技能目录里多出上面 4 个技能（来源 `bundled`，随插件加载/卸载）；
- **设置 → 记忆** 页面：参数、记忆库/设置文件的目录、统计都在里面改和看（见 [README.md 的设置页一节](README.md#设置页记忆)）；
- 数据在 `~/.dsh/memory/memory.db`（WAL）。

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| dsh | 已安装且**至少启动过一次**（`~/.dsh/profiles/<名字>/` 存在）。桌面版或 CLI（`npx -y @deepseek-ai/dsh`）都行，两者共用同一个 dsh home |
| Node | **≥ 22.16**（`node:sqlite` 需要）。检查：`node -v` |
| profile | 知道要装进哪个 profile：`Get-ChildItem ~\.dsh\profiles`（常见 `web` / `desktop`） |
| 重启意识 | **安装、升级、卸载后都要重启 DSH**。host 插件不支持热更新；只有 profile 启用 HMR 时，配置变化才即时生效 |
| 网络 | 走 npm/GitHub 时能访问对应源；内网用下面的离线路径 |

不需要的东西：不需要装 Docker、不需要向量库、不需要 embedding key。

## 2. 三种安装方式，选一个

### 路径 A：GUI（第一次装，推荐）

1. 打开 dsh Web，左侧边栏 →「**插件**」；
2. 页头按钮「**添加插件**」（或箭头「选择添加插件方式」→「安装第三方插件」），打开安装对话框；
3. 输入包名 `dsh-memory-layered`（要指定版本写 `dsh-memory-layered@0.7.0`），回车；
   - 对话框也接受 **Git 地址、压缩包 URL、本地绝对路径**；
   - 安装进度对话框里可以「查看安装任务」「取消安装」；
4. 等它跑完 → **重启 DSH**。

这条路会自动完成两件事：把包写进 profile 的 `dependencies`（等价于 `pnpm add`），并把它选入 `dsh.profile.bundles`（有序数组）。**不用手改 JSON。**

> - 首次安装若没配源，dsh 会并发探测 npm 官方源与国内镜像挑最快的；直连 GitHub 不通时会提示「无法访问 GitHub」，可选「改用国内镜像」。
> - 「设置 → 内置插件」是**只读**的内置插件清单，安装入口不在这里。
> - 组合包详情页的「来源信息」会显示「在别的机器上装它所需的 spec」（就是 `pnpm add` 那一段），方便复制到另一台机器。

### 路径 B：CLI（脚本化 / 远程机器 / 只装了 CLI）

```powershell
dsh plugin --profile web add dsh-memory-layered
```

`dsh plugin` 做的事就是「在 profile 目录里跑 pnpm」，所以 spec 可以是：

| spec 形式 | 例子 |
| --- | --- |
| registry 包名（可带版本/标签） | `dsh-memory-layered@0.7.0` |
| git https 地址 | `https://github.com/<you>/<repo>` |
| tarball URL | `https://github.com/<you>/<repo>/releases/download/v<ver>/dsh-memory-layered-<ver>.tgz` |
| 本地目录 | `file:F:\path\to\dsh-memory` 或 `link:F:\path\to\dsh-memory` |

没装桌面版、只有 CLI 的话，用 npx 跑同一个命令（共用同一个 `~/.dsh`，profile 也是同一个）：

```powershell
npx -y @deepseek-ai/dsh plugin --profile web add dsh-memory-layered
npx -y @deepseek-ai/dsh --profile web --dump-config    # 可选：确认这一行进了组合后的配置
```

**只 add 不会激活。** 还要把包名加进 profile 的 `dsh.profile.bundles`，编辑 `~/.dsh/profiles/web/package.json`：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-memory-layered": "^0.7.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-memory-layered"
      ]
    }
  }
}
```

- 只在 `bundles` 数组**末尾加一项**（写你实际装的包名，含 scope），别动别的行；顺序有优先级含义，追加到末尾最安全。
- 没有 `dsh plugin enable` 之类的命令；这一步 GUI 会替你改，CLI 得手改。
- 忘了这一步的症状：包确实装上了、`node_modules` 里也有，但重启后插件列表里没有它、`memory_*` 工具不存在。

然后**重启 DSH**。

### 路径 C：离线包（内网 / 没有 registry / 不想动 pnpm）

从 Release 下载 `dsh-memory-layered-<ver>.zip`（`<ver>` 换成版本号），解压后在该目录执行：

```powershell
pwsh -File .\install.ps1 -From .\dsh-memory-layered-<ver>.tgz            # 1) dry-run：只打印要做什么，不写任何文件
pwsh -File .\install.ps1 -From .\dsh-memory-layered-<ver>.tgz -Apply     # 2) 真装
```

> 离线目录里**必须带 `-From`**：不带时脚本按「从源码仓库安装」处理，会去找同目录的 `dsh-memory\` 源码而报错。

`-From` 接受 `.tgz`、`.zip` 或解压后的目录（目录里只有 tgz 也行，脚本会自己找；传仓库根目录也行，会自动下探到 `dsh-memory\`）。脚本做四件事：

1. 把包解到 `$DSH_HOME\plugins\dsh-memory-layered-<版本>`（tgz 直接解包并把里面的 `package\*` 提上一层，没有多余嵌套；zip 先解到 `<zip 名>.unpacked\`，再用里面的 tgz 走同样流程；目标目录已有同版本则直接复用）；
2. 在该 profile 的 `package.json` 写 `"<包名>": "link:<插件目录>"`，并把包名追加进 `dsh.profile.bundles`；
3. 建 `profiles\<名字>\node_modules\<包名>` → 插件目录的 **junction**（scoped 包名会落到 `node_modules\@scope\name`）；
4. 兼容行为：`$DSH_HOME\skills` 里没有同名技能时，额外拷一份（用 `-SkipSkills` 关掉。插件本来就注册包内技能，这步只是给老习惯留的退路）。

顺手会清理两类历史遗留：profile patch 里旧版手写的 `- insert: id: memory` 行（它会和包自带的 bundle patch 撞成 duplicate entry id），以及改过包名时残留的旧 `dsh-memory` 依赖 / `node_modules\dsh-memory` 链接。改 profile 的 `package.json`、`cordis.patch.yml` 前都会留 `*.bak-<时间戳>` 备份；重复跑是幂等的（已注册 / 已链接会直接跳过）。换版本重跑不删旧版本目录，只在结尾提示可以去 `$DSH_HOME\plugins\` 手删。

| 参数 | 含义 | 默认 |
| --- | --- | --- |
| `-Apply` | 真正执行 | 不加就是 dry-run（不解压、不备份、不建链接、不拷技能） |
| `-Profile <名字...>` | 装进哪些 profile（可多个，空格分隔）。名字必须**精确等于** `$DSH_HOME\profiles\` 下的目录名；拼错会**直接报错**并列出现有 profile（exit 1，不会静默跳过） | 所有含 `cordis.patch.yml` 的 profile |
| `-DshHome <路径>` | 覆盖 dsh home（测试用；目录必须已存在） | `$env:DSH_HOME`，否则 `~\.dsh` |
| `-From <tgz｜zip｜目录>` | 离线包来源；目录直接当插件源用 | 不传 = 从当前仓库的 `dsh-memory\` 源码安装（离线包场景必须传） |
| `-SkipSkills` | 不往 `$DSH_HOME\skills` 额外拷技能（插件仍会在运行时注册包内 4 个技能） | 关 |
| `-ForceSkills` | 覆盖 `$DSH_HOME\skills` 里的同名目录 | 关（已存在则跳过） |

然后**重启 DSH**。

## 3. 装完验证（五步）

1. **插件已加载**：侧栏「插件」页能看到它（来源是已安装依赖，状态启用）。
2. **工具在**：新会话里说「看下你的记忆库」→ 模型应调用 `memory_stats`，输出含 `l0=`、`scenes=`、`vec=`、`tokens=`。
3. **注入生效**：再开一个新会话，问「我之前的偏好是什么」→ 会话里出现 `<memory_context type="stable|dynamic" source="dsh-memory">`（**第一次是空的**，聊几轮、抽取出事实后才有内容）。
4. **技能在**：问「你有哪些技能」，或直接 `/memory-curator` → 目录里应有 `dsh-plugin-dev`、`memory-curator`、`repo-audit`、`windows-pwsh-ops`。
5. **设置页在**：打开 **设置 → 记忆**，「存储位置」卡片里的目录路径显示出真实路径（缺省 `…\.dsh\memory`），说明 host 路由和页面都通了 —— 这一眼就是安装成功的判据。看不到这一栏先**刷新页面**；纯 CLI（headless）profile 没有 Web 设置面板，看不到属正常，插件其余功能不受影响。

只要第 1、2 步出现，插件就装对了；第 3 步需要先积累事实（默认 1→2→4→8→每 5 轮触发一次抽取，idle 60s 兜底）。

## 4. 配置（可选）

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖。**patch 的 `config` 是整行替换、不深合并**：同一个 `- id: memory` 在多个 patch 层出现时，后一层的 `config` 会整体盖掉前一层，不要指望合并。本插件对每个字段都有内置默认值，所以只写想改的字段通常也能工作；但覆盖 `extraction` 这类嵌套段时，建议把该段写全。

> **不想改 YAML 也行**：装好后打开 **设置 → 记忆**，同一批参数都能在 GUI 里改，保存即生效（只有 `storage.dbPath`、`skills.enabled`/`skills.dir`、`extraction.provider`/`extraction.model` 要重启）。
> 设置页只把**你改过的 key** 写进 `$DSH_HOME\memory\settings.json`（`DSH_HOME` 缺省 `%USERPROFILE%\.dsh`；默认与数据库同目录，位置不随 `dbPath` 变），优先级 **内置默认 < profile YAML < 设置页**。
> 注意两种合并不是一回事：**YAML 各层之间**仍是整行替换（上一段说的）；**设置页与 YAML 之间**是深合并，只覆盖你改过的字段。YAML 里留着的值仍然是「恢复 YAML 基线」回落的目标。
> 字段分组、HTTP 端点、重置方式见 [README.md 的设置页一节](README.md#设置页记忆)。

最小示例（关心隐私就关掉 LLM）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: memory
  name: 'dsh-memory-layered'          # 用来定位这一行；包改名/加 scope 后写实际包名（entry id 仍是 memory）
  config:
    maxItems: 8               # 动态段最多注入几条事实
    extraction:
      enabled: false          # 完全不调 LLM：只存原文 + FTS 召回，memory_save 仍可用
    skills:
      enabled: true           # 关掉就不注册包内 4 个技能
```

其余可调项（完整默认值）：`maxChars`、`minScore`、`scope`、`layers`、`extraction.{provider,model,everyN,idleMs,maxInputChars,maxMemories,maxAttempts,timeoutMs,maxTokens}`、`scenes.*`、`persona.*`、`vector.*`，见 [README.md](README.md#配置)。

### 隐私开关

- 抽取会把**会话文本**发给**当前会话用的同一个模型 provider**（默认跟随 `agentDefaultModel`）；不想发就 `extraction.enabled: false`。
- 数据只在本地 `~/.dsh/memory/memory.db`，不引入第三方服务；抽取的累计 token 花费用 `memory_stats` 的 `tokens=` 看。
- 想更省：把 `extraction.model` 指到便宜模型，或调大 `everyN`。

### 重置记忆

停掉 DSH，删 `~/.dsh/memory/` 下的 `memory.db`、`memory.db-wal`、`memory.db-shm` → 重启即空库。

**只重置参数（不动记忆）**：删 `$DSH_HOME\memory\settings.json`（缺省 `%USERPROFILE%\.dsh\memory\settings.json`），或在页面底部点「恢复 YAML 基线」——两者等价，都回到「YAML + 内置默认」。单个字段回默认用该行上的「恢复默认」。注意这里恢复的是**基线**，不是出厂值：YAML 里写过的值会继续生效。

## 5. 升级 / 回滚 / 卸载

| 操作 | 做法 |
| --- | --- |
| 升级 | GUI 里重装同名；或 `dsh plugin --profile web add <包名>@latest`；离线用新 zip 重跑 `-From`。`bundles` 里已有它，不用再动。**升级后重启** |
| 回滚 | 从 profile 的 `package.json` 删两处：`dependencies` 里的包名、`dsh.profile.bundles` 里的同名项 → 重启。记忆库不动 |
| 卸载 | 插件页卸载，或 `dsh plugin --profile web remove <包名>`（若 `bundles` 里还留着名字，手删那一项）→ 重启 |
| 清数据 | 删 `~/.dsh/memory\`（**不可恢复**）；离线装的再删 `$DSH_HOME\plugins\dsh-memory-layered-<ver>` |

> 卸载**不会**删 `~/.dsh/skills\<技能名>` 里你自己拷过的副本——那是你的文件，要清得自己删。同理，插件随包注册的技能在卸载/停用后会自动消失，不需要手工清理。

## 6. 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件页里看不到它 | ①只 `add` 没加进 `dsh.profile.bundles` ②装到了别的 profile（`-Profile` 名字拼错时脚本会报错退出；`dsh plugin --profile` 拼错则是 dsh 报错）③没重启 ④离线装时 junction 指向的目录被删了 | 补 `bundles` 那一行 / `-Profile` 用 `$DSH_HOME\profiles\` 下的精确目录名 / 重启 / 重跑 `install.ps1 -From` |
| 插件条目在，但 `memory_*` 工具全消失，条目状态 `fiberPhase: null` | `profiles\<p>\node_modules\<包名>` 断链，或包目录没了（旧版「先删后拷」安装脚本会这样） | 重跑安装（离线版会重建 junction）→ 重启 |
| 启动报 `duplicate entry id`，或出现两个 `memory` 行 | profile 的 `cordis.patch.yml` 里手写了 `- insert: id: memory`，和包自带的 bundle patch 撞了 | 删掉 profile 里那段手写 insert（包自带），重启 |
| `memory_stats` 里 `l0=` 一直不降 | 模型/llm 服务解析不到，或抽取一直失败；也可能 `extraction.enabled: false` | 看日志里的 `[dsh-memory]` 与 `l1-last-reason`（`llm_error` / `parse` / `timeout`）；确认 provider/model 配对本机已有模型 |
| 聊了几轮还是没记忆 | 还没到抽取阈值（默认 1→2→4→8→每 5 轮） | 多聊几轮；或让模型调一次 `memory_extract` 手动补跑，看 `reason=` |
| 4 个技能没出现 | 插件没加载（技能随插件注册）；或 dsh 版本太老没有 skills 注册表；或包里 `skills/` 丢了 | 先按第 1 条排查插件；看日志里有没有 `bundled skill` 相关 warn |
| 技能出现了，但你改过的那份没生效 | 你 `~/.dsh/skills` 里有同名技能：它的优先级（400）高于包内注册（600），日志会写 `from bundled ignored because a higher-priority skill already exists` | 想用包内版：删掉或改名 `~/.dsh/skills\<技能名>`；想安静：配 `skills.enabled: false` |
| 改了配置/升级了但没变化 | host 插件不热更 | 重启 |
| 设置面板里没有「记忆」一栏 | ①装完没刷新页面 ②当前 profile 没有 Web 设置面板（纯 CLI headless 启动）③包是旧版本，没带 `client.js`/`dsh.client` 元数据 | 先刷新页面，再重启；确认 dsh 版本有 `settings.section` 槽位；换新版包 |
| 设置页里改了参数，行为没变 | 该字段是**重启生效**项：`storage.dbPath`、`skills.enabled`/`skills.dir`、`extraction.provider`/`extraction.model` | 看行上的「重启生效」徽标与保存提示的「n 项重启后生效」→ 重启 DSH |
| 点「打开目录」没反应 | 宿主进程调不起桌面文件管理器（无 GUI 会话），或非 Windows 平台没有 `xdg-open` | 按「存储位置」卡片显示的路径手动打开；这个按钮是尽力而为（异步失败只记日志，不影响别的功能） |
| 改完设置页，重启后变回旧值 | ①保存报错没落盘（目录不可写 / 杀软拦截）②事后删过 `settings.json` 或点过「恢复 YAML 基线」 | 看保存提示；确认 `$DSH_HOME\memory\settings.json` 里确有那个 key（YAML 不会盖回来，它优先级更低） |
| `memory_stats` 的 `vec=` 小于总数 | 旧行还没回填（每次启动最多补 500 行） | 再重启一两次；或临时 `vector.enabled: false` |
| 召回为空 | 语料太少，或 2 字中文查询走了 LIKE 兜底 | 用 `memory_save` 固化关键结论，再聊几轮 |

## 7. 边界

- **只在 Windows 上实测**（pwsh + junction）。macOS / Linux **未实测**：`install.ps1` 需要改成 symlink 与 POSIX 路径；npm/GUI 安装路径理论上跨平台，但没验证过。
- 技能是**包内注册**（rank 600，最低一档）：你自己的同名技能永远赢，插件不会覆盖你的文件。
- 向量是**词法**向量（字符 n-gram 特征哈希），不是语义 embedding：同义词、跨语言改写召回不到。
- `memory_extract` 是调试/恢复用，正常不需要调用。
- 单机单库（SQLite WAL），没有多机同步；多人共享需要换存储后端。
- 抽取会消耗 token，`memory_stats` 的 `tokens=` 是累计值。
