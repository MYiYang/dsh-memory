<#
.SYNOPSIS
  Install dsh-memory (host plugin) and its bundled skills into a DeepSeek Harness home.

.DESCRIPTION
  Two install sources:

    * default — this repository: `dsh-memory/` is the plugin source and
      `dsh-skills/` is the skills source (developer install).
    * -From <dir|tgz|zip> — an offline release artifact (end-user install).
      A directory is used as the plugin source as-is. A `.tgz` (from
      `npm pack`) is extracted into `$DSH_HOME/plugins/<name>-<version>`
      and the extracted `package/` is promoted so there is no extra nesting;
      the same version is reused on later runs. A release `.zip` is first
      expanded next to the archive, then the tgz inside it is installed the
      same way. Skills come from the extracted package (`skills/`), so the
      offline zip works without the repository.

  The package name is never hard-coded: it is read from the plugin's
  `package.json` (so the package can be renamed or scoped — e.g.
  `@yourscope/dsh-memory` — to avoid an npm name collision). Scoped names are
  handled too: the module link becomes `node_modules/@scope/name`.

  dsh-memory is then mounted the same way every first-class DSH plugin is:

    1. The profile manifest (`profiles/<name>/package.json`) records
       `"<package>": "link:<plugin source>"` and appends `<package>` to
       `dsh.profile.bundles`. A bundle is composed before the user patch
       layer and mounts the plugin's own `cordis.patch.yml`, so the plugin
       appears in the DSH plugin manager and needs no hand-written insert row.
    2. `profiles/<name>/node_modules/<package>` points at the plugin source,
       so the loader resolves the package without a copy step (or pnpm
       creates the same link if the plugin is installed from the plugin
       manager).
    3. `$DSH_HOME/skills` receives the shipped skills (existing ones are kept
       unless -ForceSkills is passed).

  The installer is idempotent (a second run prints `already linked` /
  `already registered` and changes nothing), backs up every file it edits,
  removes the legacy `- insert: id: memory` row from older installs (it would
  now collide with the bundle-owned row: duplicate entry id), and — when the
  package was renamed — drops stale `dsh-memory` entries left by older installs.

  Dry run by default: prints every action without touching anything
  (no extraction, no backup, no link, no copy).

.PARAMETER Apply
  Actually perform the changes.

.PARAMETER From
  Install from an offline release artifact instead of this repository.
  Accepts a plugin directory, the `dsh-memory-<version>.tgz` from `npm pack`,
  or the release `dsh-memory-<version>.zip`. Relative paths are resolved
  against the current directory, then against this script's directory.

.PARAMETER Profile
  Profile name(s) to install into. Default: every profile under
  $DSH_HOME/profiles that has a cordis.patch.yml.

.PARAMETER DshHome
  Override the dsh home (default: $env:DSH_HOME, else ~/.dsh). Handy for
  testing the installer against a throwaway home.

.PARAMETER SkipSkills
  Only install the memory plugin (the package also registers its 4 skills at
  runtime, so this only skips copying them into $DSH_HOME/skills).

.PARAMETER ForceSkills
  Overwrite existing skill directories in $DSH_HOME/skills.

.EXAMPLE
  pwsh -File .\install.ps1                                   # dry run from this repo
  pwsh -File .\install.ps1 -Apply                             # register the plugin in every profile

.EXAMPLE
  pwsh -File .\install.ps1 -From .\dist\dsh-memory-0.4.0.tgz -Apply
  pwsh -File .\install.ps1 -From C:\Downloads\dsh-memory-0.4.0.zip -Apply -DshHome D:\dsh-home

.EXAMPLE
  pwsh -File .\install.ps1 -Apply -Profile desktop -ForceSkills
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string[]]$Profile,
  [string]$DshHome,
  [switch]$SkipSkills,
  [switch]$ForceSkills,
  [string]$From
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dshHome = if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$dshHome = [System.IO.Path]::GetFullPath($dshHome)
$repoPluginSource = Join-Path $root 'dsh-memory'
$repoSkillsSource = Join-Path $root 'dsh-skills'
$registerScript = @(
  (Join-Path $root 'scripts/profile-plugin.mjs'),
  (Join-Path $root 'notes/profile-plugin.mjs')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

function Say($message, $color = 'Gray') {
  Write-Host $message -ForegroundColor $color
}

function Get-PathLink($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $item = Get-Item -LiteralPath $path -Force
  $target = @($item.Target)[0]
  return [pscustomobject]@{
    Path     = $path
    LinkType = $item.LinkType
    IsLink   = ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink')
    Target   = $target
  }
}

function Get-FullPath($path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  return [System.IO.Path]::GetFullPath($path).TrimEnd('\', '/')
}

# Remove a junction/symlink itself, never its target contents.
function Remove-LinkOnly($path) {
  & cmd /c rmdir "$path" | Out-Null
  if (Test-Path -LiteralPath $path) { throw "could not remove link: $path" }
}

function New-DirectoryJunction($link, $target) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $link) | Out-Null
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  if (-not (Test-Path -LiteralPath $link)) { throw "junction not created: $link" }
}

function Resolve-InputPath([string]$path) {
  if ([System.IO.Path]::IsPathRooted($path)) { return [System.IO.Path]::GetFullPath($path) }
  foreach ($base in @((Get-Location).Path, $root)) {
    $candidate = Join-Path $base $path
    if (Test-Path -LiteralPath $candidate) { return [System.IO.Path]::GetFullPath($candidate) }
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $path))
}

function Get-PluginManifest([string]$dir) {
  $manifest = Join-Path $dir 'package.json'
  if (-not (Test-Path -LiteralPath $manifest)) { return $null }
  try { return (Get-Content -LiteralPath $manifest -Raw -Encoding utf8 | ConvertFrom-Json) } catch { return $null }
}

function Get-TgzPackageManifest([string]$tgz) {
  $json = (& tar -xOf $tgz 'package/package.json' 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) {
    throw "cannot read package/package.json from archive: $tgz"
  }
  return ($json | ConvertFrom-Json)
}

function Test-TgzPluginLayout([string]$tgz) {
  $names = @(& tar -tzf $tgz 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "cannot list archive: $tgz" }
  foreach ($required in @('package/index.js', 'package/cordis.patch.yml')) {
    if ($names -notcontains $required) { throw "archive is not a dsh-memory plugin (missing $required): $tgz" }
  }
  return $names
}

# `<scope>/<name>` -> `node_modules/<scope>/<name>`
function Get-PackageNodeModulesPath([string]$profileDir, [string]$packageName) {
  return Join-Path (Join-Path $profileDir 'node_modules') ($packageName -replace '/', '\')
}

function Get-PluginDirName([string]$packageName, [string]$version) {
  $short = ($packageName -split '/')[-1]
  return "$short-$version"
}

function Install-TgzPlugin([string]$tgz) {
  # Read manifest + layout without writing anything (dry run safe).
  $manifest = Get-TgzPackageManifest $tgz
  Test-TgzPluginLayout $tgz | Out-Null
  if (-not $manifest.name -or -not $manifest.version) { throw "archive package.json lacks name/version: $tgz" }

  $pluginsRoot = Join-Path $dshHome 'plugins'
  $pluginDir = Join-Path $pluginsRoot (Get-PluginDirName $manifest.name $manifest.version)

  $installed = Get-PluginManifest $pluginDir
  if ($installed -and $installed.version -eq $manifest.version -and $installed.name -eq $manifest.name -and
      (Test-Path -LiteralPath (Join-Path $pluginDir 'index.js'))) {
    Say "      plugin: reusing $pluginDir (version $($manifest.version) already extracted)" 'Green'
    return [pscustomobject]@{ Dir = $pluginDir; Name = $manifest.name; Version = $manifest.version; Reused = $true }
  }

  if (-not $Apply) {
    Say "      plugin: would extract $tgz -> $pluginDir (promote package/*)"
    return [pscustomobject]@{ Dir = $pluginDir; Name = $manifest.name; Version = $manifest.version; Reused = $false }
  }

  $staging = Join-Path $pluginsRoot ('.extract-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  try {
    & tar -xzf $tgz -C $staging
    if ($LASTEXITCODE -ne 0) { throw "tar failed to extract $tgz" }
    $packageRoot = Join-Path $staging 'package'
    if (-not (Test-Path -LiteralPath $packageRoot)) { throw "archive has no package/ directory: $tgz" }

    $fullPlugin = [System.IO.Path]::GetFullPath($pluginDir)
    $fullRoot = [System.IO.Path]::GetFullPath($pluginsRoot)
    if (-not $fullPlugin.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "refusing to write outside $fullRoot`: $fullPlugin"
    }
    if (Test-Path -LiteralPath $pluginDir) { Remove-Item -LiteralPath $pluginDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
    Get-ChildItem -LiteralPath $packageRoot -Force | ForEach-Object {
      Move-Item -LiteralPath $_.FullName -Destination $pluginDir -Force
    }
    Say "      plugin: extracted -> $pluginDir" 'Green'
  } finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
  }
  return [pscustomobject]@{ Dir = $pluginDir; Name = $manifest.name; Version = $manifest.version; Reused = $false }
}

function Install-ZipRelease([string]$zip) {
  $entries = @(& tar -tf $zip 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "cannot list archive: $zip" }
  $tgzEntry = $entries | Where-Object { $_ -match '^[^/]+\.tgz$' } | Select-Object -First 1
  if (-not $tgzEntry) { throw "zip does not contain a plugin .tgz at its root: $zip" }

  $unzipDir = Join-Path (Split-Path -Parent $zip) (([System.IO.Path]::GetFileNameWithoutExtension($zip)) + '.unpacked')
  if (-not $Apply) {
    $version = $null
    if ($tgzEntry -match '-(?<v>\d+\.\d+\.\d+[^/]*)\.tgz$') { $version = $Matches['v'] }
    # Package name is whatever precedes -<version> in the tgz name (npm pack strips the scope),
    # so a renamed/scoped package still previews the right target directory.
    $pkgFromTgz = $tgzEntry -replace '-\d+(\.\d+)*[^/]*\.tgz$', ''
    $pluginDir = if ($version) { Join-Path (Join-Path $dshHome 'plugins') "$pkgFromTgz-$version" } else { Join-Path (Join-Path $dshHome 'plugins') "$pkgFromTgz-<version>" }
    Say "      zip: would expand $zip -> $unzipDir, then install $tgzEntry -> $pluginDir"
    return [pscustomobject]@{ Dir = $pluginDir; Name = $pkgFromTgz; Version = $version; Reused = $false }
  }

  Say "      zip: expanding -> $unzipDir" 'Yellow'
  Expand-Archive -LiteralPath $zip -DestinationPath $unzipDir -Force
  $tgz = Join-Path $unzipDir $tgzEntry
  if (-not (Test-Path -LiteralPath $tgz)) { throw "expanded zip is missing $tgzEntry" }
  return Install-TgzPlugin $tgz
}

Say "DSH_HOME      : $dshHome" 'Cyan'

# ── Resolve the install source + package name ───────────────────────────────
$fromPath = $null
$fromKind = $null
if ($From) {
  $fromPath = Resolve-InputPath $From
  if (-not (Test-Path -LiteralPath $fromPath)) { throw "-From path does not exist: $fromPath" }
  $fromItem = Get-Item -LiteralPath $fromPath -Force
  $fromKind = if ($fromItem.PSIsContainer) { 'dir' }
    elseif ($fromPath -match '\.zip$') { 'zip' }
    elseif ($fromPath -match '\.(tgz|tar\.gz)$') { 'tgz' }
    else { throw "-From must be a plugin directory, a .tgz or a .zip: $fromPath" }
  # Convenience: a directory holding the release tgz (e.g. a manually unzipped
  # release) is treated as that tgz instead of failing on a missing package.json.
  if ($fromKind -eq 'dir') {
    $probe = $fromPath
    if (-not (Test-Path -LiteralPath (Join-Path $probe 'index.js')) -and
        (Test-Path -LiteralPath (Join-Path $probe 'dsh-memory/index.js'))) {
      $probe = Join-Path $probe 'dsh-memory'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $probe 'package.json'))) {
      $innerTgz = Get-ChildItem -LiteralPath $fromPath -Filter *.tgz -File -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($innerTgz) {
        $fromKind = 'tgz'
        $fromPath = $innerTgz.FullName
      }
    }
  }
}
$modeLabel = switch ($fromKind) {
  'dir' { "offline directory: $fromPath" }
  'zip' { "offline zip: $fromPath" }
  'tgz' { "offline tgz: $fromPath" }
  default { 'repository (this checkout)' }
}

Say "install from  : $modeLabel"
Say "mode          : $(if ($Apply) { 'APPLY' } else { 'DRY RUN (pass -Apply to change anything)' })" 'Yellow'

$pluginSource = $repoPluginSource
$skillsSource = $repoSkillsSource
$packageName = 'dsh-memory'

if ($fromKind -eq 'dir') {
  $pluginSource = $fromPath
  # Convenience: accept the repo root as well as the package directory.
  if (-not (Test-Path -LiteralPath (Join-Path $pluginSource 'index.js')) -and
      (Test-Path -LiteralPath (Join-Path $pluginSource 'dsh-memory/index.js'))) {
    $pluginSource = Join-Path $pluginSource 'dsh-memory'
  }
  $manifest = Get-PluginManifest $pluginSource
  if (-not $manifest -or -not $manifest.name) { throw "plugin directory has no package.json name: $pluginSource" }
  $packageName = $manifest.name
} elseif ($fromKind -eq 'zip') {
  $resolved = Install-ZipRelease $fromPath
  $pluginSource = $resolved.Dir
  if ($resolved.Name) { $packageName = $resolved.Name }
} elseif ($fromKind -eq 'tgz') {
  $resolved = Install-TgzPlugin $fromPath
  $pluginSource = $resolved.Dir
  $packageName = $resolved.Name
} else {
  $manifest = Get-PluginManifest $repoPluginSource
  if (-not $manifest -or -not $manifest.name) { throw "plugin source has no package.json name: $repoPluginSource" }
  $packageName = $manifest.name
}

if ($fromKind) {
  $packageSkills = Join-Path $pluginSource 'skills'
  $skillsSource = if (Test-Path -LiteralPath $packageSkills) { $packageSkills } elseif (Test-Path -LiteralPath $repoSkillsSource) { $repoSkillsSource } else { $null }
}

Say "package name  : $packageName"
Say "plugin source : $pluginSource"
Say "skills source : $(if ($skillsSource) { $skillsSource } else { '(none)' })"

if (-not (Test-Path -LiteralPath $dshHome)) { throw "DSH_HOME does not exist: $dshHome" }
if (-not $registerScript) {
  throw "registration helper missing: expected scripts/profile-plugin.mjs or notes/profile-plugin.mjs"
}
$helperSupportsName = ((Get-Content -LiteralPath $registerScript -Raw -Encoding utf8) -match '--name')
$pluginReady = Test-Path -LiteralPath (Join-Path $pluginSource 'index.js')
if ($pluginReady) {
  if (-not (Test-Path -LiteralPath (Join-Path $pluginSource 'cordis.patch.yml'))) {
    throw "plugin source missing cordis.patch.yml: $pluginSource"
  }
} elseif ($Apply) {
  throw "plugin source missing index.js: $pluginSource"
} else {
  Say "note          : plugin not extracted yet (dry run); the profile step below is simulated" 'DarkYellow'
}

# ── 1. Profiles: bundle entry + module link ─────────────────────────────────
$profilesRoot = Join-Path $dshHome 'profiles'
$explicitProfiles = [bool]$Profile
$targets = if ($Profile) { $Profile } else {
  Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'cordis.patch.yml') } |
    ForEach-Object { $_.Name }
}
if (-not $targets) { throw "no dsh profile found under $profilesRoot" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($name in $targets) {
  $profileDir = Join-Path $profilesRoot $name
  $patch = Join-Path $profileDir 'cordis.patch.yml'
  Say "`n[1/2] profile '$name'"
  if (-not (Test-Path -LiteralPath $patch)) {
    if ($explicitProfiles) {
      throw "profile '$name' has no cordis.patch.yml (found: $((Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue).Name -join ', '))"
    }
    Say "      skip: no cordis.patch.yml" 'DarkYellow'
    continue
  }

  if ($Apply) {
    foreach ($file in @((Join-Path $profileDir 'package.json'), $patch)) {
      if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination "$file.bak-$stamp" -Force }
    }
  }

  if ($pluginReady) {
    $registerArgs = @($registerScript, $profileDir, $pluginSource)
    if ($helperSupportsName) { $registerArgs += @('--name', $packageName) }
    elseif ($packageName -ne 'dsh-memory') { Say "      warning: $registerScript does not support --name; profile keys may fall back to 'dsh-memory'" 'DarkYellow' }
    if (-not $Apply) { $registerArgs += '--dry-run' }
    & node @registerArgs
    if ($LASTEXITCODE -ne 0) { throw "failed to register the bundle in profile '$name'" }
  } else {
    Say "      would register bundle '$packageName' (dependency link:$pluginSource) in $profileDir" 'Yellow'
    Say "      would keep dsh.profile.bundles in sync"
  }

  $link = Get-PackageNodeModulesPath $profileDir $packageName
  $current = Get-PathLink $link
  if ($current -and $current.IsLink -and (Get-FullPath $current.Target) -eq (Get-FullPath $pluginSource)) {
    Say "      $($packageName) module link: already linked -> $pluginSource" 'Green'
  } elseif ($Apply) {
    if ($current) {
      if ($current.IsLink) { Remove-LinkOnly $link } else { Move-Item -LiteralPath $link -Destination "$link.bak-$stamp" }
      Say "      $($packageName) module link: replaced stale entry" 'Yellow'
    }
    New-DirectoryJunction $link $pluginSource
    Say "      $($packageName) module link: linked -> $pluginSource" 'Green'
  } else {
    Say "      $($packageName) module link: would link -> $pluginSource"
  }

  # Renamed/scoped package: drop the old hard-coded link so nothing stale is left.
  if ($packageName -ne 'dsh-memory') {
    $legacyLink = Get-PackageNodeModulesPath $profileDir 'dsh-memory'
    if (Test-Path -LiteralPath $legacyLink) {
      if ($Apply) {
        $legacy = Get-PathLink $legacyLink
        if ($legacy -and $legacy.IsLink) { Remove-LinkOnly $legacyLink }
        else { Move-Item -LiteralPath $legacyLink -Destination "$legacyLink.bak-$stamp" }
        Say "      node_modules/dsh-memory: removed legacy entry (renamed package)" 'Yellow'
      } else {
        Say "      node_modules/dsh-memory: would remove legacy entry (renamed package)"
      }
    }
  }
}

# ── 2. Skills -> $DSH_HOME/skills ───────────────────────────────────────────
if (-not $SkipSkills) {
  $skillsTarget = Join-Path $dshHome 'skills'
  Say "`n[2/2] skills -> $skillsTarget"
  if (-not $skillsSource -or -not (Test-Path -LiteralPath $skillsSource)) {
    Say "      skip: no skills source found (expected dsh-skills/ or <package>/skills/)" 'DarkYellow'
  } else {
    $skillDirs = Get-ChildItem $skillsSource -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') }
    foreach ($dir in $skillDirs) {
      $dest = Join-Path $skillsTarget $dir.Name
      if ((Test-Path -LiteralPath $dest) -and -not $ForceSkills) {
        Say "      $($dir.Name): exists (use -ForceSkills to overwrite)"
        continue
      }
      if ($Apply) {
        New-Item -ItemType Directory -Force -Path $skillsTarget | Out-Null
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
        Copy-Item -LiteralPath $dir.FullName -Destination $dest -Recurse -Force
        Say "      $($dir.Name): installed" 'Green'
      } else {
        Say "      $($dir.Name): would install"
      }
    }
  }
}

if ($From -and (Test-Path -LiteralPath (Join-Path $dshHome 'plugins'))) {
  $currentLeaf = Split-Path -Leaf $pluginSource
  $otherVersions = Get-ChildItem (Join-Path $dshHome 'plugins') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*-*' -and $_.Name -ne $currentLeaf -and (Test-Path -LiteralPath (Join-Path $_.FullName 'package.json')) }
  if ($otherVersions) {
    Say "`nnote: other plugin copies still under plugins/: $($otherVersions.Name -join ', ')" 'DarkGray'
    Say "      (safe to delete once you no longer need them)" 'DarkGray'
  }
}

Say "`nDone. Restart DeepSeek Harness (host plugins are not hot-reloaded), then:" 'Cyan'
Say "  1) open the Plugins page in the sidebar: '$packageName' should be listed as an installed plugin (bundle)."
Say "  2) ask: '记住：我所有命令都用 pwsh' -> the model calls memory_save."
Say "  3) open a new session, ask: '我之前的偏好是什么' -> auto-recall injects <memory_context>."
Say "  db: $(Join-Path $dshHome 'memory/memory.db')"
Say "  rollback: remove '$packageName' from dsh.profile.bundles and dependencies in profiles/<name>/package.json and restart" 'DarkGray'
