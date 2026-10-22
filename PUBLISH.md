# 发布指南：dsh-memory + 随包 4 个技能

> **读者**：本仓库作者本人。用户视角的安装说明在 [dsh-memory/INSTALL.md](dsh-memory/INSTALL.md)，两篇不要混用。
> **环境**：Windows + pwsh；除特别标注外，命令都在仓库根 `F:\ssdwork\vscode\work\menm` 执行。

## 1. 发布物是什么

一个包同时装两样东西：**host 插件**（带 5 个 `memory_*` 工具 + 自动注入）和 **4 个 dsh 技能**。

| 产物 | 内容 | 给谁 |
| --- | --- | --- |
| npm 包（`@scope/dsh-memory` 或空号名） | 插件 `index.js` + `src/*.js` + `cordis.patch.yml`；技能 `skills/<4 个>/SKILL.md`；`README.md` / `INSTALL.md` / `DESIGN-v2.md` / `LICENSE` | `dsh plugin add`、GUI 安装的默认方式 |
| `dist/dsh-memory-0.4.0.tgz` | `npm pack` 的产物，内容和 npm 包一致 | GitHub Release 附件；`dsh plugin add <tarball-url>` |
| `dist/dsh-memory-0.4.0.zip` | 离线包：`install.ps1` + `scripts/profile-plugin.mjs` + tgz + `README.md` + `INSTALL.md` + `SHA256SUMS.txt` | 内网 / 没有 registry / 不想动 pnpm 的人 |
| `dist/SHA256SUMS.txt`、`dist/manifest.json` | 校验和与产物清单 | 下载后核对 |

要点：

- **技能不是独立包**。插件在 `apply()` 里把包内 `skills/` 读出来，用 `ctx.skills.registerProvider` 注册成一个 provider（`name: 'dsh-memory'`，`source: 'bundled'`，`rank: 600`）；插件卸载时 provider 随 fiber 一起撤销。所以 **装一个包 = 插件 + 4 个技能**，用户不需要拷 `~/.dsh/skills`。
- **技能不靠 `postinstall` 拷贝**。pnpm 10/11 默认拦下依赖的 build 脚本、要用户显式批准，靠 postinstall 往用户主目录写文件不可靠；包内注册是内存注册，不写盘、不猜用户 home 布局。
- `dsh-memory/skills/` 是 `dsh-skills/` 的**镜像**，真源在 `dsh-skills/`。改技能只改 `dsh-skills/`，然后跑 `node scripts\sync-skills.mjs` 同步；别手改镜像目录。
- `install.ps1` **不在 npm 包里**（`files` 只列包内文件），只出现在离线 zip 的根目录。

## 2. 命名（必做前置，不是建议）

### 2.1 现状

2026-10-22 查 npm registry 的结果：

| 名字 | 状态 | 说明 |
| --- | --- | --- |
| `dsh-memory` | **已占用** | 0.1.0，维护者 `bbnopromo`，同名不同实现（FTS5 + `memory_write/search/forget`），我们的包用这个名字 `npm publish` 会 403 |
| `dsh-layered-memory` | 已占用 | 0.11.0，另一套分层记忆实现（L0–L3 + Web UI + 本地/远程 embedding，README 自述「移植自 MemoryCore (TencentDB Agent Memory)」） |
| `dsh-memory-layered` | 空号（404） | 可用，但发布前必须再查一次 |

> 这些状态会变。**发布前永远先查**：`npm view <name> version`（404 = 空号）。

### 2.2 三条出路，选一条

**A. scoped 发布（推荐给公开分发）**

```powershell
cd dsh-memory
npm pkg set name=@yourscope/dsh-memory
npm view @yourscope/dsh-memory version     # 确认空号
npm publish --access public                # scoped 包必须带 --access public
```

用户装 `@yourscope/dsh-memory`。

**B. 换成不冲突的名字**

```powershell
npm view dsh-memory-layered version        # 404 才可用
npm pkg set name=dsh-memory-layered
```

**C. 不发 npm，只发 GitHub Release（内部分发最省事）**

跳过 registry：构建出 `dist\dsh-memory-0.4.0.tgz` 与 `.zip`，附件挂到 Release。用户二选一：

```powershell
# 1) 直接装 tarball URL（仍需把它加进 dsh.profile.bundles）
dsh plugin --profile web add https://github.com/<you>/<repo>/releases/download/v0.4.0/dsh-memory-0.4.0.tgz

# 2) 或下载 zip 走离线脚本
pwsh -File .\install.ps1 -From .\dsh-memory-0.4.0.tgz -Apply
```

完全绕开命名冲突和 registry。

> **本项目已选 C**（内部分发）：步骤见 §4.2。C 路径下**包名保持 `dsh-memory` 不改**——不走 registry 就没有占用问题，`cordis.patch.yml` 的 insert 行和用户的 `dsh.profile.bundles` 都继续用 `dsh-memory`。

### 2.3 改名要同步什么

| 位置 | 改？ | 说明 |
| --- | --- | --- |
| `dsh-memory/package.json` 的 `name` | **改** | 唯一权威来源 |
| `dsh-memory/cordis.patch.yml` 里 insert 行的 `name:` | **改** | 这行的 `name` 是 loader 的模块说明符，必须解析到安装后的包名。**未在改 scope 的实装上验证过**——改名后务必按 §5 第 7 条冒烟一次 |
| `package.json` 的 `repository` / `homepage` / `bugs` | 改 | 现在是 `CHANGE-ME` 占位，见 §4.2 |
| 文档里出现的包名与命令 | 改 | `README.md` / `INSTALL.md` / `PUBLISH.md` |
| 注入消息的 `source.kind = 'plugin:dsh-memory'` | **不改** | producer-owned 命名空间，与 npm 包名无关；改了反而会让会话格式校验失败 |
| 数据库路径、4 个技能名、`memory_*` 工具名 | 不改 | |
| `cordis.patch.yml` 里的 entry `id: memory` | 不改 | 它只是 loader 行的稳定 id，用户 profile patch 靠它覆盖（`- id: memory`） |
| `dsh.profile.bundles` 里写的名字 | 跟着变 | 用户侧必须写**新包名** |

脚本本身已经做了改名适配，不用改代码：`install.ps1` 从插件的 `package.json.name` 读包名（支持 scoped，链接会落到 `node_modules\@scope\name`），并会清掉旧 `dsh-memory` 的依赖和 `node_modules\dsh-memory` 链接；`scripts\profile-plugin.mjs` 同理，且会顺手删掉旧版手写的 `- insert: id: memory` 行。

产物文件名：`npm pack` 决定 tgz 名（scoped 包会被 npm 写成 `scope-name-<ver>.tgz`），`build-release` 的 zip 名是 `<去掉 scope 的包名>-<ver>.zip`。改名后重跑一次，确认 `dist\` 里的文件名和你文档里写的一致；`node scripts\build-release.mjs --name <新包名>` 只是给构建产物打标签（写进 `manifest.json`），**不会**改写 `package.json`。

### 2.4 和同名/相似项目的差异（一句话，够用户判断）

我们是**零依赖**：`node:sqlite` 单文件库 + 本地 384 维**词法**特征哈希向量，不引 `sqlite-vec` / `jieba` / `transformers.js`，不联网、不需要 embedding 服务；能力是 L0 原文 → L1 冲突消解事实 → L2 场景 → L3 画像四层 + 召回注入；并且**随包带 4 个技能**。

不写星数、下载量之类未核实的数字。

## 3. 版本与兼容

### 3.1 版本号

- 只改 `dsh-memory/package.json` 的 `version`，构建脚本从它取号（当前 `0.4.0`）。
- 0.x 期间：minor 可以有破坏性变更（配置项、schema、注入格式），patch 只修 bug。
- 每个版本至少记清：实测的 dsh 版本、Node 最低版本（`>=22.16`，`node:sqlite` 需要）、数据库是否有迁移。

### 3.2 CHANGELOG

建议加 `CHANGELOG.md`，Keep a Changelog 风格，tag 用 `v0.4.0`：

```markdown
## [0.4.0] - 2026-10-22
### Added
- 随包 4 个技能：插件用 `ctx.skills.registerProvider` 以 rank 600 注册（`skills.enabled` / `skills.dir` 可配）
- 离线安装器 `install.ps1 -From <tgz|zip|目录>`
### Changed
### Fixed
```

### 3.3 和 dsh 的版本关系

本包**故意不声明** `engines.dsh`，也不声明 `@deepseek-ai/*` 的 `peerDependencies`。

- 声明了、而运行时版本不满足，dsh 会**在 pnpm 之前**直接拒绝安装（错误码 `incompatible-version`），用户必须跑
  `dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <runtime> --accept-risk` 才能装。
- 不声明的代价：dsh 大版本不兼容时不会在安装时被拦，只在启动/运行时暴露。所以 README/Release notes 里要写清实测版本。

## 4. 三条发布通道

### 4.1 npm 公共源

```powershell
# 0) 先定名字（见 §2），确认空号
npm view @yourscope/dsh-memory version

# 1) 技能镜像自检（build-release 也会自动同步一次）
node scripts\sync-skills.mjs --check          # 有漂移则 exit 1，先跑不带 --check 的同步

# 2) 产出 dist\（会自己再同步技能、npm pack、校验 tar 内容、打离线 zip、写校验和）
node scripts\build-release.mjs
# 想给产物打个改名标签（只影响 manifest.json，不改 package.json）：
# node scripts\build-release.mjs --name @yourscope/dsh-memory

# 3) 看清单再发
cd dsh-memory
npm pack --dry-run                            # 打印将发布的文件列表，不写文件
npm publish --access public                   # 非 scoped 可省 --access
```

须知：

- `package.json` 不能有 `"private": true`（已删），`publishConfig.access` 已是 `public`。
- `files` 已包含 `skills/**/SKILL.md`、`INSTALL.md`、`LICENSE`；`test/`、`scripts/`、`dist/` 不进包。
- `npm pack --dry-run` 每次都看：确认 `package/skills/` 下 4 个目录都在、`cordis.patch.yml` 在。
- 发布前 `npm whoami` 确认登录；2FA 会要一次验证码。
- 发完核对：`npm view @yourscope/dsh-memory`，再按 §5 第 8 条真装一遍。

### 4.2 GitHub Release（**本项目选用**：内部分发 + 离线安装）

不经过 registry，因此**不需要改名、不需要 npm 账号**；用户拿到的是 `https://github.com/<owner>/<repo>/releases/download/<tag>/…tgz` 这样的直链，或者离线 zip。

**一次性准备**（仓库里没有 `.git` 时）：

```powershell
cd F:\ssdwork\vscode\work\menm
git init
git checkout -b main          # 本机 git 2.18 不支持 `git init -b main`；新版本 git 可直接 `git init -b main`
# .gitignore 已就位：dist/、repo/（上游研究快照 11.8MB）、notes/、*.bak-*、根目录一次性探针脚本
# 先把 package.json 里 3 处 CHANGE-ME 换成真实地址：
#   dsh-memory/package.json → repository.url / homepage / bugs.url
git add -A                    # 实测：52 个文件，不含 repo/ notes/ dist/
git commit -m "dsh-memory 0.4.0: plugin + 4 bundled skills"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

**发一版：推 tag 即发**（`.github/workflows/release.yml` 已就位）：

```powershell
# 1) 改版本：dsh-memory/package.json 的 version（例如 0.4.0 -> 0.4.1）
# 2) 技能真源改完先同步并提交
node scripts\sync-skills.mjs
git add -A; git commit -m "release v0.4.1"
# 3) 打 tag 推上去，Actions 自动构建并发 Release
git tag -a v0.4.1 -m "dsh-memory 0.4.1"
git push origin main --tags
```

workflow 在 `windows-latest` 上跑（`install.ps1` 与离线 zip 只在 Windows 实测过），顺序是：
技能镜像 `--check` → 逐个跑 `dsh-memory/test/*.test.js` → `node scripts\build-release.mjs` → 用 `dist\SHA256SUMS.txt` 反向校验每个产物 → 挂 4 个附件（`.tgz`、`.zip`、`SHA256SUMS.txt`、`manifest.json`）。
任一步失败就不发版；`Re-run all jobs` 会用同一个 tag 重跑并覆盖附件。

**本地一把梭 / 没有 gh CLI**：

```powershell
pwsh -File .\scripts\release-github.ps1            # 构建 + 校验 + 打印 tag/上传命令（不改任何东西）
pwsh -File .\scripts\release-github.ps1 -Create    # 真打 tag、push、有 gh 就 gh release create
```

没有 `gh`：把 `dist\` 里的 `.tgz` / `.zip` / `SHA256SUMS.txt` / `manifest.json` 四个文件手工拖到 GitHub 的 Release 页面即可（脚本会把说明文字打印出来）。

**用户怎么用**（把 `<tag>` 换成本次版本）：

```powershell
# A. 直装 tarball 直链（仍需把它加进 dsh.profile.bundles）
dsh plugin --profile web add https://github.com/<owner>/<repo>/releases/download/<tag>/dsh-memory-0.4.0.tgz

# B. GUI：侧栏「插件」→「添加插件」→ 粘同一条 tarball 直链（GUI 自动选入 bundles）

# C. 离线：下载 zip → 解压 → 干跑一遍再装
pwsh -File .\install.ps1 -From .\dsh-memory-0.4.0.tgz          # dry-run
pwsh -File .\install.ps1 -From .\dsh-memory-0.4.0.tgz -Apply
# 装完重启 DSH
```

注意：

- **私有仓库的 Release 附件需要认证**，外部用户拉不到直链；要给别人装就让仓库公开，或让内网人下 zip 走离线路径。
- tag 名建议和版本对齐（`v0.4.0`），附件名由 `npm pack` 决定（`dsh-memory-0.4.0.tgz`），别手改名。
- 每次构建 zip 的 sha256 都会变（zip 条目带时间戳），发版一律以当次 `dist\SHA256SUMS.txt` 为准。
- 想让 `dsh plugin add` 的 spec 更短：在 Release 说明里贴直链，或以后补一条 `npm` 通道（§4.1）再做 `dsh plugin add <包名>`。

### 4.3 私服 / 内网 registry

```powershell
npm publish --registry https://npm.internal.example/
```

用户端（`dsh plugin` 把参数原样转发给 pnpm，`--registry` 由 pnpm 处理）：

```powershell
dsh plugin --profile web add @yourscope/dsh-memory --registry https://npm.internal.example/
```

注意：

- pnpm 会按**默认** registry 校验锁文件里的 tarball URL；换源装过包之后再用默认源装别的包可能 `ERR_PNPM_TARBALL_URL_MISMATCH`。同一套源操作到底即可。
- 完全没有 registry：发 zip + `install.ps1 -From`。

## 5. 发布前检查单

按顺序，全绿再发：

1. **技能同步**：`node scripts\sync-skills.mjs --check` → `in sync`（exit 0）。
2. **测试**：`cd dsh-memory; node --test test\` 全绿（0 fail）。受限环境里 `node --test` 会 spawn 子进程触发 EPERM，改成逐个跑：
   `Get-ChildItem test\*.test.js | ForEach-Object { node $_.FullName }`。
3. **元数据**：`version` 已升、`repository`/`homepage`/`bugs` 无 `CHANGE-ME`、`license` 为 MIT、`files` 含 `skills/**/SKILL.md` 与 `INSTALL.md`、无 `private`、`engines.node >= 22.16`。
4. **构建**：`node scripts\build-release.mjs`，`dist\` 里 `dsh-memory-0.4.0.tgz`、`dsh-memory-0.4.0.zip`、`SHA256SUMS.txt`、`manifest.json` 都在，`manifest.json` 的 `version`/`files[].sha256` 对。构建脚本自己会：同步技能 → preflight（`private`、必需文件、`files[]`、技能目录）→ `npm pack` → 校验 tar 内容 → 打 zip → 写校验和；它**失败即停**，末尾的 `warning:` 行要逐条看（例如 `INSTALL.md` 缺失只会警告，不会失败）。
5. **内容核对**：`tar -tzf dist\dsh-memory-0.4.0.tgz`，应看到 `package/index.js`、`package/src/*.js`、`package/cordis.patch.yml`、`package/skills/<4 个>/SKILL.md`、`package/INSTALL.md`、`package/README.md`；**不该**看到 `package/test/`、`package/scripts/`、`package/node_modules/`、`package/dist/`（这条构建脚本已经断言过，手工再扫一眼）。
6. **校验和**：`Get-FileHash .\dist\dsh-memory-0.4.0.tgz -Algorithm SHA256` 与 `dist\SHA256SUMS.txt` 一致。
7. **冒烟安装（不碰真实 home）**：

   ```powershell
   $h = Join-Path $env:TEMP ('dsh-smoke-' + (Get-Date -Format 'HHmmss'))
   New-Item -ItemType Directory -Force "$h\profiles\smoke" | Out-Null
   # 造最小 profile：profiles\smoke\package.json（含 dsh.profile.bundles）与 cordis.patch.yml
   pwsh -File .\install.ps1 -DshHome $h -From .\dist\dsh-memory-0.4.0.tgz          # dry-run，先看动作
   pwsh -File .\install.ps1 -DshHome $h -From .\dist\dsh-memory-0.4.0.tgz -Apply  # 真装
   pwsh -File .\install.ps1 -DshHome $h -From .\dist\dsh-memory-0.4.0.tgz -Apply  # 再跑：应全 already / reusing
   ```

   预期：解到 `$h\plugins\dsh-memory-0.4.0`，profile 的 `package.json` 多一条 `"dsh-memory": "link:<该目录>"` 且 `dsh.profile.bundles` 末尾多一项，`node_modules\dsh-memory` 是指向该目录的 junction。
   dry-run 对 tgz/zip **不会解压**，所以 profile 那一步只会打印「would register …」——这是预期行为，不是跳过。
8. **真装一遍**：在真实 profile 上按 INSTALL.md §2 的某条路径装，走完 §3 的四步验证（插件出现、`memory_stats` 有 `l0=`/`scenes=`/`vec=`、新会话出现 `<memory_context>`、4 个技能在）。验完把 profile 清回去。
9. **收尾**：README/INSTALL 的版本号与命令和脚本对齐 → tag → Release notes 写清 §8 的边界。

## 6. 用户端三种安装路径（一句话版）

详见 [dsh-memory/INSTALL.md](dsh-memory/INSTALL.md)。

| 场景 | 一句话 |
| --- | --- |
| GUI | 侧栏「插件」→「添加插件」→ 输包名（如 `@yourscope/dsh-memory`）→ 安装 → 重启 |
| CLI | `dsh plugin --profile web add <spec>`，再把包名加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` → 重启（**只 add 不激活**） |
| 离线 | 解 zip → `pwsh -File .\install.ps1 -From .\dsh-memory-0.4.0.tgz`（dry-run）→ 加 `-Apply` → 重启 |

三条路径共同点：技能随包注册，**不需要**手工拷 `~/.dsh/skills`；装完都要重启 DSH（host 插件不热更，只有 profile 启用 HMR 时配置变化才即时生效）。

## 7. 升级、回滚、卸载

### 7.1 升级

- npm / GUI：`dsh plugin --profile web add <包名>@latest`（GUI 里重装同名字段也行）。`bundles` 里已有它，不用再动。
- 离线：用新的 zip 再跑一次 `install.ps1 -From`。新版解到 `$DSH_HOME\plugins\dsh-memory-<新版本>`，**旧版本目录不会自动删**（脚本只在结尾提示一行），确认不再被引用后手删。
- 数据库 schema 迁移在 `src/store.js` 里自动完成（v1→v3）；**降级不保证兼容**，升级前备份 `~/.dsh/memory/memory.db`（含 `-wal`、`-shm`，停掉 dsh 再拷）。
- 升级后必须重启。

### 7.2 回滚

最小回滚：从 `~/.dsh/profiles/<p>/package.json` 删两处 —— `dependencies` 里的包名、`dsh.profile.bundles` 里的同名项 → 重启。插件不再加载，记忆库原样保留。

退回旧版本：回滚后再 `dsh plugin --profile web add <包名>@0.3.0`，并把名字加回 `bundles` → 重启；离线版把 `-From` 指向旧版本包重跑。

### 7.3 卸载

- GUI：插件页卸载（内部顺序是先移出 `bundles`、卸载运行时、再 `pnpm remove`）。
- CLI：`dsh plugin --profile web remove <包名>`；若 `dsh.profile.bundles` 里还留着名字，手删那一项 → 重启。
- 想连数据一起清：删 `~/.dsh/memory\`（**不可恢复**）。
- 卸载**不会**删用户以前手拷到 `~/.dsh/skills\` 的同名技能（那是用户自己的文件），要清得自己删那 4 个目录。
- 离线安装的还要删 `$DSH_HOME\plugins\dsh-memory-<ver>`。

## 8. 已知边界（写进 Release notes 的那几条）

| 边界 | 说明 |
| --- | --- |
| 平台 | 只在 **Windows**（pwsh + junction）实测；macOS/Linux **未实测**，`install.ps1` 需要改符号链接与路径写法 |
| dsh 版本 | 不声明 `engines.dsh` / DSH peer：不兼容时表现为启动或运行时错误，而不是安装前被拦；实测版本写在 README 顶部 |
| 技能优先级 | 包内注册 rank **600**（最低档）：`~/.dsh/skills`(400)、`customSkillDirs`(300)、项目 `.dsh/skills`(100) 的同名技能都会赢，日志里会有 `from bundled ignored because a higher-priority skill already exists`。这是设计，不是 bug |
| 用户已装同名技能 | 首次装完可能「看不见包内技能」：因为用户 400 档那份赢了。处理见 INSTALL.md 故障表 |
| `memory_extract` | 调试/恢复用，正常不需要调用 |
| 向量 | 384 维**词法**特征哈希，不是语义 embedding：同义词、跨语言改写召回不到 |
| 隐私 | 抽取会把会话文本发给当前会话用的模型 provider；`extraction.enabled: false` 可完全关闭 LLM |
| 多机同步 | 没有：单机单库，DB 在 `~/.dsh/memory/memory.db` |
