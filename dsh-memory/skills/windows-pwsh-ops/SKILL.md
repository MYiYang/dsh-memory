---
name: windows-pwsh-ops
description: 在这台 Windows 机器上安全高效地执行命令与改文件：pwsh 语法与编码、路径与沙箱边界、无外网时的替代取数方式、后台任务与超时处理。当命令因引号/编码/编码/权限/网络失败，或需要批量处理文件、跑长任务、访问受限目录时使用。
---

# Windows / pwsh 操作手册（windows-pwsh-ops）

## 1. 语法与编码

- 一律 **pwsh**（PowerShell 7）语法，不是 bash：`$env:NAME`、`Get-ChildItem`、`Select-Object`、`Where-Object`。
- 中文输出乱码时：读取用 `Get-Content -Raw -Encoding utf8`，写入用 `Set-Content -Encoding utf8`；控制台代码页用 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`。
- 引号：路径含空格用单引号包整段；JSON 内联用 here-string `@' ... '@` 再 `| Set-Content`，不要和多层转义搏斗。
- 反斜杠在正则/替换里要转义；`-replace` 用单引号字符串更省心。

## 2. 路径与沙箱

- 删除/移动前先 **打印解析后的绝对路径**并断言前缀，再执行：`$p=(Resolve-Path $x).Path; if ($p -like 'F:\expected\*') { Remove-Item -Recurse -Force $p }`。
- 工作区之外的写入会被沙箱拒绝（`[sandbox: file access denied]`）。需要时先问用户，或把产物写进工作区再让用户自己拷贝。
- 不要用 `cd` 切目录（每次调用是新进程）：用工具的 `workdir` 参数，或在同一条命令里 `Set-Location`。
- 长路径（>260 字符）用 `\\?\` 前缀；Git Bash 风格路径（`/f/xxx`）只有部分工具认。

## 3. 无外网时的取数

本机常见限制：`raw.githubusercontent.com` 解析到 `0.0.0.0`，`github.com`/`codeload` TLS 失败，但 **npm registry 与 api.github.com 可用**。

- 取 GitHub 仓库：`api.github.com` 拿树 + `cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}` 逐文件下载（Node 的 `fetch` 可用；`curl.exe` 与 `Invoke-WebRequest` 常被拦）。
- 取 npm 包源码：`npm pack <pkg>`（registry 可用），解包看 `dist/` 与 `src/`。
- 需要网页正文：只能用内置的 `web_fetch` 工具（走 harness 代理），不要在 shell 里试。

## 4. 长任务与后台

- 超过 ~60s 的命令用 `run_in_background`，拿到 job id 后用 `job_output` 取增量，不要 sleep 轮询。
- 需要边跑边看的脚本，把进度 `Write-Output` 到 stdout；注意 `| Select-Object -Last N` 会**缓冲到进程结束**，看似没输出。
- 大批量文件处理用 Node 脚本（`fs.readdirSync` 递归）比 `Get-ChildItem -Recurse` 快且不受执行策略影响。

## 5. 常见失败对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `spawn EPERM` | 沙箱禁止子进程 piped stdio | 改用 `stdio: inherit`，或直接在当前进程内跑（如 `node test/foo.js` 而非 `node --test test/`） |
| `只核心类型` 报错 | 只读模式下 ConstrainedLanguage | 避免 `[System.IO.*]::`、`Add-Type`、COM，改用 cmdlet |
| `SSL connection could not be established` | 出网被拦 | 换 npm registry / jsDelivr（见第 3 节） |
| 中文文件名找不到 | 编码不一致 | 统一 UTF-8；必要时用 `[System.IO.Directory]` 或 Node 处理 |
| 命令"成功"但没效果 | 管道缓冲 / 改了别的 profile | 加 `-Verbose`，或落地文件后 `Get-Content` 验证 |

## 6. 交付前自检

- 改过的文件用 `Get-FileHash` 或 `Select-String` 复核关键行，别只看命令退出码。
- 清理临时文件（探针脚本、下载残留），但保留可复现的脚本并注明用途。
- 报告里贴**可复现命令**，不要贴一次性调试片段。
