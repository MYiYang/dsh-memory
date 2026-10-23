# dsh-memory

给 **DeepSeek Harness (dsh)** 加分层跨会话记忆的本地插件，**且随包带 4 个 dsh 技能**：
装一个包就同时得到 5 个 `memory_*` 工具、每轮召回注入，以及 `dsh-plugin-dev` / `memory-curator` / `repo-audit` / `windows-pwsh-ops` 四个技能。

零外部依赖：`node:sqlite`（FTS5）+ 进程内 384 维**词法**特征哈希向量，不联网、不要 Docker / 向量库 / embedding key。

- 插件做什么、配置、评测数据：[dsh-memory/README.md](dsh-memory/README.md)
- **安装（三种路径）**：[dsh-memory/INSTALL.md](dsh-memory/INSTALL.md)
- 设计与实现细节：[dsh-memory/DESIGN-v2.md](dsh-memory/DESIGN-v2.md)
- **全局记忆失效审计**（为什么「标了全局」还会忘）：[dsh-memory/AUDIT-global-recall.md](dsh-memory/AUDIT-global-recall.md)
- **发版指南**：[PUBLISH.md](PUBLISH.md)

## 安装（给人看的三个入口）

已发布版本：[v0.4.2](https://github.com/MYiYang/dsh-memory/releases/tag/v0.4.2)

```powershell
# A. CLI：直装 Release 里的 tarball（再把 dsh-memory 加进 profile 的 dsh.profile.bundles 后重启）
dsh plugin --profile web add https://github.com/MYiYang/dsh-memory/releases/download/v0.4.2/dsh-memory-0.4.2.tgz

# B. GUI：侧栏「插件」→「添加插件」→ 粘上面这条 URL（自动选入 bundles，不用手改 JSON）

# C. 离线：下 [dsh-memory-0.4.2.zip](https://github.com/MYiYang/dsh-memory/releases/download/v0.4.2/dsh-memory-0.4.2.zip)
#    → 解压 → 先干跑看动作，再加 -Apply 真装 → 重启 DSH
pwsh -File .\install.ps1 -From .\dsh-memory-0.4.2.tgz
pwsh -File .\install.ps1 -From .\dsh-memory-0.4.2.tgz -Apply
```

| 场景 | 一句话 |
| --- | --- |
| GUI | 侧栏「插件」→「添加插件」→ 输包名 / tarball URL / 本地路径 → 重启 |
| CLI | `dsh plugin --profile web add <spec>`，再把包名加进 `~/.dsh/profiles/<p>/package.json` 的 `dsh.profile.bundles` → 重启（**只 add 不激活**） |
| 离线 | 下载 Release 里的 `dsh-memory-<ver>.zip` → `pwsh -File .\install.ps1 -From .\dsh-memory-<ver>.tgz -Apply` → 重启 |

技能由插件在 `apply()` 里用 `ctx.skills.registerProvider` 以 **rank 600** 注册，**不需要**手工拷 `~/.dsh/skills`；
如果你自己 `~/.dsh/skills` 里有同名技能（rank 400），那是你那份赢——见 INSTALL.md 的故障表。

## 发版（维护者）

推 tag 即发：GitHub Actions 会跑技能同步校验 + 全部测试 + 构建 + 校验和比对，然后把产物挂到 Release。

```powershell
# 首次（还没有 .git 时）：
git init; git checkout -b main
git add -A; git commit -m "dsh-memory 0.4.0: plugin + 4 bundled skills"
git remote add origin https://github.com/<you>/<repo>.git; git push -u origin main

# 此后每次发版：
# 1) 改版本号 dsh-memory/package.json 的 version
node scripts\sync-skills.mjs --check          # 技能镜像是否最新
node scripts\build-release.mjs                # 本地先构建一遍（dist\）
git add -A; git commit -m "release v<ver>"
git tag -a v<ver> -m "dsh-memory <ver>"
git push origin main --tags                   # 触发 .github/workflows/release.yml
```

没有 gh CLI、想手工挂附件也行：`dist\` 里的 `.tgz` / `.zip` / `SHA256SUMS.txt` / `manifest.json` 四个文件传上去即可。
本地一把梭：`pwsh -File .\scripts\release-github.ps1`（默认只构建+打印清单，加 `-Create` 才打 tag 并尝试 `gh release create`）。
细节见 [PUBLISH.md](PUBLISH.md) §4.2。

## 仓库结构

```text
dsh-memory/          # 可发布的 npm 包 = 插件 host 半边 + 包内 skills/（镜像）+ README/INSTALL/DESIGN/LICENSE
dsh-skills/          # 4 个技能的【唯一真源】；跑 scripts/sync-skills.mjs 镜像到 dsh-memory/skills/
scripts/
  sync-skills.mjs    # dsh-skills → dsh-memory/skills，幂等，--check 只校验
  build-release.mjs  # 同步 → preflight → npm pack → 校验 → 离线 zip → SHA256SUMS + manifest
  profile-plugin.mjs # 把包注册成某个 profile 的 bundle（包名无关，支持 scoped）
  release-github.ps1 # 本地发版助手（构建 + 校验 + tag/gh release）
install.ps1          # 安装器：源码 / -From <tgz|zip|目录> 离线安装，幂等 + 备份
PUBLISH.md           # 发布指南（npm / GitHub Release / 私服 三条通道）
```

## 许可

MIT，见 [dsh-memory/LICENSE](dsh-memory/LICENSE)。
