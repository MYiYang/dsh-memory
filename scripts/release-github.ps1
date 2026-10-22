<#
.SYNOPSIS
  Local one-shot for the "GitHub Release only" publishing path (no npm).

.DESCRIPTION
  Runs the same steps the release workflow runs, then either prints the exact
  tag / upload commands (default, dry) or performs them (-Create).

    1. `node scripts/sync-skills.mjs --check`   — skills mirror must be current
    2. `node scripts/build-release.mjs`         — dist/: tgz + offline zip + checksums
    3. verify dist/SHA256SUMS.txt against the files
    4. print the artifact manifest and the user-facing install commands
    5. -Create: `git tag -a <tag>` -> `git push <remote> <tag>` -> `gh release create`
       (falls back to manual upload instructions when the GitHub CLI is missing)

  Nothing is published without -Create. A dirty working tree only warns: the tag
  would then point at the previous commit, which is usually not what you want.

.PARAMETER Tag
  Release tag. Default: v<package.json version> (e.g. v0.4.0).

.PARAMETER Remote
  Git remote to push the tag to. Default: origin.

.PARAMETER Create
  Actually tag, push and create the release. Without it everything is a dry run.

.PARAMETER SkipTests
  Skip the plugin test suite (not recommended before a release).

.EXAMPLE
  pwsh -File .\scripts\release-github.ps1                  # build + verify + print commands
  pwsh -File .\scripts\release-github.ps1 -Create          # tag, push, create the Release
  pwsh -File .\scripts\release-github.ps1 -Tag v0.4.1 -Create
#>
[CmdletBinding()]
param(
  [string]$Tag,
  [string]$Remote = 'origin',
  [switch]$Create,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($message) { Write-Host "`n== $message" -ForegroundColor Cyan }
function Info($message) { Write-Host "   $message" }
function Warn($message) { Write-Host "   $message" -ForegroundColor Yellow }

$pkg = Get-Content 'dsh-memory/package.json' -Raw | ConvertFrom-Json
if (-not $Tag) { $Tag = "v$($pkg.version)" }

Step "release $($pkg.name)@$($pkg.version) (tag $Tag)$(if (-not $Create) { ' — DRY RUN' })"
Info "root: $root"

# ── 1. skills mirror ────────────────────────────────────────────────────────
Step 'skills mirror (dsh-skills -> dsh-memory/skills)'
node scripts/sync-skills.mjs --check
if ($LASTEXITCODE -ne 0) {
  throw 'dsh-memory/skills is out of sync; run `node scripts/sync-skills.mjs` and commit the result first'
}

# ── 2. tests ────────────────────────────────────────────────────────────────
if (-not $SkipTests) {
  Step 'plugin tests'
  $failed = @()
  $total = 0
  Get-ChildItem 'dsh-memory/test' -Filter *.test.js | ForEach-Object {
    $out = node $_.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { $failed += $_.Name; $out | Select-Object -Last 15 }
    else {
      $line = ($out | Select-String -Pattern '^# pass|^ℹ pass' | Select-Object -First 1).Line
      $total += [int]($line -replace '[^0-9]', '')
    }
  }
  if ($failed.Count -gt 0) { throw "test files failed: $($failed -join ', ')" }
  Info "$total assertions passed"
}

# ── 3. build + verify ───────────────────────────────────────────────────────
Step 'build dist/'
node scripts/build-release.mjs
if ($LASTEXITCODE -ne 0) { throw 'build-release failed' }

Step 'verify SHA256SUMS.txt'
$sums = Join-Path 'dist' 'SHA256SUMS.txt'
if (-not (Test-Path $sums)) { throw "missing $sums" }
$bad = @()
foreach ($line in Get-Content $sums) {
  if ($line -notmatch '^([0-9a-f]{64})\s+(.+)$') { continue }
  $expected = $Matches[1]
  $file = $Matches[2].Trim()
  $actual = (Get-FileHash (Join-Path 'dist' $file) -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) { $bad += $file } else { Info "ok  $file" }
}
if ($bad.Count -gt 0) { throw "checksum mismatch: $($bad -join ', ')" }

$tgz = Get-ChildItem 'dist' -Filter 'dsh-memory-*.tgz' | Select-Object -First 1
$zip = Get-ChildItem 'dist' -Filter 'dsh-memory-*.zip' | Select-Object -First 1
if (-not $tgz -or -not $zip) { throw 'dist/ is missing the tgz or the zip' }
$assets = @($tgz.FullName, $zip.FullName, $sums, (Join-Path 'dist' 'manifest.json'))

# ── 4. where would users download it from ───────────────────────────────────
$isRepo = Test-Path '.git'
$remoteUrl = $null
$slug = $null
if ($isRepo) {
  $remoteUrl = (git remote get-url $Remote 2>$null)
  if ($remoteUrl -match 'github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+?)(?:\.git)?$') {
    $slug = "$($Matches.owner)/$($Matches.repo)"
  }
}

Step 'artifacts'
Get-ChildItem dist | Select-Object Name, Length | Format-Table -AutoSize | Out-String | Write-Host

if ($slug) {
  $base = "https://github.com/$slug/releases/download/$Tag"
  Step "user-facing install commands (after the Release is published)"
  Info "GUI   : 侧栏「插件」→「添加插件」→ 粘 $base/$($tgz.Name)"
  Info "CLI   : dsh plugin --profile web add $base/$($tgz.Name)"
  Info "       然后把它加进 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles"
  Info "离线   : 下载 $($zip.Name) → pwsh -File .\install.ps1 -From .\$($tgz.Name) -Apply → 重启 DSH"
} else {
  Warn 'remote 不是 GitHub（或还不是 git 仓库），发布后按下面模板拼下载地址：'
  Info 'https://github.com/<owner>/<repo>/releases/download/<tag>/dsh-memory-<version>.tgz'
}

# ── 5. tag / release ────────────────────────────────────────────────────────
if (-not $isRepo) {
  Step 'not a git repository yet — run these first'
  Info 'git init'
  Info 'git checkout -b main        # git 2.28+ 可用 git init -b main'
  Info 'git add -A'
  Info 'git commit -m "dsh-memory 0.4.0: plugin + 4 bundled skills"'
  Info 'git remote add origin https://github.com/<you>/<repo>.git'
  Info 'git push -u origin main'
  Info '然后重跑：pwsh -File .\scripts\release-github.ps1 -Create'
  return
}

$dirty = git status --porcelain
if ($dirty) {
  Warn '工作区有未提交改动；tag 会指向最后一次提交，先 commit 再发版：'
  $dirty | ForEach-Object { Info $_ }
}

$gh = Get-Command gh -ErrorAction SilentlyContinue
$notes = @(
  "$($pkg.name) $($pkg.version)",
  '',
  '- 插件 host 半边：L0 原文 / L1 事实 / L2 场景 / L3 画像 + 召回注入 + 5 个 memory_* 工具',
  '- 随包 4 个技能（ctx.skills.registerProvider，rank 600）',
  '- 安装见 INSTALL.md；离线包见附件 zip',
  '- 校验：dist/SHA256SUMS.txt（sha256sum -c 兼容）'
) -join "`n"

if (-not $Create) {
  Step 'dry run — nothing tagged or uploaded; add -Create to do it'
  Info "git tag -a $Tag -m `"$($pkg.name) $($pkg.version)`""
  Info "git push $Remote $Tag"
  if ($gh) {
    Info "gh release create $Tag $($tgz.Name) $($zip.Name) SHA256SUMS.txt manifest.json --title `"$Tag`" --notes-file <notes.md>"
  } else {
    Info '未安装 gh CLI：把 dist/ 里四个文件手工传到 GitHub Release 页面'
  }
  return
}

Step "tag $Tag"
git tag -a $Tag -m "$($pkg.name) $($pkg.version)"

Step "push tag to $Remote"
git push $Remote $Tag
if ($LASTEXITCODE -ne 0) { throw "git push $Remote $Tag failed" }

if ($gh) {
  Step 'create GitHub Release'
  $notesFile = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-memory-$Tag-notes.md"
  Set-Content -LiteralPath $notesFile -Value $notes -Encoding utf8
  & gh release create $Tag @assets --title "$($pkg.name) $($pkg.version)" --notes-file $notesFile
  if ($LASTEXITCODE -ne 0) { throw 'gh release create failed' }
  Info "gh release view $Tag --web"
} else {
  Step 'GitHub CLI not found — finish the release in the browser'
  Info "打开 https://github.com/$slug/releases/new?tag=$Tag ，把 dist/ 里四个文件拖进附件区"
  Info '标题/说明可用：'
  Write-Host $notes
}
