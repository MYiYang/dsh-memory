# dsh-skills — 个人技能库（DeepSeek Harness）

给 dsh 的**原生技能系统**用的一组 `SKILL.md`。dsh 会扫描技能目录、把「技能目录」注入会话，模型按需用 `skill` 工具加载正文；你也可以在输入框里打 `/技能名` 直接加载。

## 目录内容

| 技能 | 什么时候用 |
| --- | --- |
| `repo-audit` | 看一个陌生开源仓库、做技术尽调、评估能不能用 |
| `dsh-plugin-dev` | 给 dsh 写插件（host/client、pre-step 注入、工具注册、安装回滚） |
| `memory-curator` | 维护跨会话记忆的质量：什么值得存、冲突怎么合并、召回怎么调 |
| `windows-pwsh-ops` | Windows/pwsh 下的命令、编码、沙箱、无外网取数 |

## 这 4 个技能已随 `dsh-memory` 发布

`dsh-memory`（npm 包）里带一份 `skills/`，插件在 `apply()` 里用 `ctx.skills.registerProvider(...)` 把它们注册进宿主技能注册表：

- provider 名 `dsh-memory`，`source: 'bundled'`，**rank 600**——`dsh-skill-filesystem` 里最低的一档；
- 优先级（数字越小越优先）：项目 `.dsh/skills`(100) > 项目 `.agents/skills`(200) > `customSkillDirs`(300) > `~/.dsh/skills`(400) > `~/.agents/skills`(500) > 包内 bundled(600)。**同名时你自己的副本赢**，日志里会写 `from bundled ignored because a higher-priority skill already exists`；
- 注册绑在插件的 fiber 上：插件停用/卸载，这 4 个技能随之下线；
- 配置项 `skills.enabled`（默认 `true`）与 `skills.dir`（默认包内 `skills/`）可以关掉或改目录。

所以**装了 dsh-memory 就不用再手工拷技能**（下面「安装」里的三种位置，留给不使用该插件的项目或想自己改一版的人）。包内注册走内存、不写盘，也不依赖 `postinstall`——pnpm 10/11 默认拦依赖的 build 脚本，靠安装脚本往用户主目录写文件不可靠。

> 你自己拷到 `~/.dsh/skills` 的同名技能会盖住包内那份（400 赢 600），这是设计：用户自己的文件优先。

## 安装：三个位置，按用途选

dsh 的技能根（按优先级从高到低，来自 `dsh-skill-filesystem`）：

| 位置 | 绝对路径 | 适合 |
| --- | --- | --- |
| 项目级（最高优先级） | `<git 根>/.dsh/skills/<name>/SKILL.md` | 只属于这个仓库的流程 |
| 项目级备用 | `<git 根>/.agents/skills/` | 与 Claude Code 等工具共用 |
| 自定义根 | `cordis.patch.yml` 的 `customSkillDirs` | 团队共享目录 |
| **用户级（推荐给个人技能库）** | `~/.dsh/skills/<name>/SKILL.md` | 跨项目可用 |
| 用户级备用 | `~/.agents/skills/` | 与其它 agent 共用 |
| 包内（随插件注册） | `dsh-memory` 包里的 `skills/`（rank 600，最低） | 装了 dsh-memory 就有，不用拷 |

> ⚠️ 两个坑：
> 1. **项目根是「含 `.git` 的目录」**，不是当前工作目录。把 `.dsh/skills` 放在子目录里永远不会被扫到。
> 2. 技能名必须 **kebab-case**（`^[a-z0-9]+(?:-[a-z0-9]+)*$`），且必须有 `name` / `description` frontmatter，否则**静默跳过**。

### 方式 A：拷到用户级（最省事）

```powershell
# 从本仓库根目录执行
$dst = "$env:USERPROFILE\.dsh\skills"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force .\dsh-skills\* $dst
```

重启 dsh 后，问一句「你有哪些技能」或直接 `/repo-audit` 验证。

### 方式 B：挂自定义根（保留在本仓库，便于 git 管理）

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`，**整行替换** `skill-filesystem` 的配置（patch 不深合并，必须写全 `name` + 完整 `config`）：

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - 'F:/ssdwork/vscode/work/menm/dsh-skills'
```

## 写一个新技能

```markdown
---
name: my-skill                     # 必需，kebab-case
description: 一句话说明「什么时候该用」 # 必需，会出现在技能目录里（截断 500 字）
whenToUse: 额外路由提示（可选，驼峰命名）
disable-model-invocation: false    # true = 模型看不到，只能用户手动 /my-skill
user-invocable: true
metadata:                          # 可选，原样透传
  owner: me
---

# 正文

加载后整段注入模型上下文：步骤、检查清单、坑、示例。写成可执行的指令，不要写营销文案。
```

设计建议：

- **description 决定能否被选中**：写「用户说什么的时候用」，而不是「这个技能是什么」。
- 一个技能只解决一类任务；超过 150 行就拆。
- 把「踩过的坑」写进去——那是技能相对通用知识的唯一增量。
- 需要脚本/模板时，放在同目录（如 `scripts/`），技能正文里用相对路径引用。

## 验证与排错

```powershell
# 1) 目录是否在扫描范围内
Get-ChildItem "$env:USERPROFILE\.dsh\skills" -Directory | Select-Object Name

# 2) frontmatter 是否合法（name 必须是 kebab-case）
Get-Content "$env:USERPROFILE\.dsh\skills\repo-audit\SKILL.md" -TotalCount 5

# 3) 看 dsh 日志里有没有 "skill" 相关的 warn（坏 frontmatter 会被跳过并 warn）
Get-ChildItem "$env:USERPROFILE\.dsh\logs" -File | Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 | ForEach-Object { Select-String -Path $_.FullName -Pattern 'skill' }
```

常见问题：

| 现象 | 原因 |
| --- | --- |
| 技能列表里没有新技能 | 放错目录（按 git 根，不是 cwd）；或 frontmatter 缺 `name`/`description`；或名字不是 kebab-case |
| 模型不主动用 | `description` 没写「什么时候用」；或 `disable-model-invocation: true` |
| `/my-skill` 没反应 | `user-invocable: false`；或名字拼错 |
| 改完不生效 | `watch` 默认开，但跨盘符/网络盘可能收不到事件；重启 dsh 或改 `watchUsePolling: true` |
