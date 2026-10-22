#!/usr/bin/env node
/**
 * build-release — produce the publishable artifacts for dsh-memory.
 *
 * Steps (all idempotent; re-running overwrites the same files in dist/):
 *   1. mirror dsh-skills/* into dsh-memory/skills/*    (scripts/sync-skills.mjs)
 *   2. preflight the package (required files / skills present)
 *   3. `npm pack` inside dsh-memory/ -> dist/dsh-memory-<version>.tgz
 *   4. verify the tarball actually contains the intended files
 *   5. stage tgz + installer + docs + checksums, zip them with bsdtar
 *      -> dist/dsh-memory-<version>.zip
 *   6. write dist/SHA256SUMS.txt and dist/manifest.json, print a summary table
 *
 * Subprocesses that write use `stdio: 'inherit'` on purpose: piped stdio can be
 * refused (EPERM) by sandboxed Windows shells. Read-only captures go through a
 * file descriptor instead of a pipe for the same reason.
 *
 * Usage:
 *   node scripts/build-release.mjs [--name <pkgspec>]
 *
 * `--name` only labels the build (console output + manifest.json) for the case
 * where the package is renamed/scoped before publishing; it never rewrites
 * `dsh-memory/package.json`, so it cannot collide with the docs/lead edits.
 * Rename the package in package.json yourself (see PUBLISH.md), then rebuild.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = join(ROOT, 'dsh-memory')
const DIST = join(ROOT, 'dist')
const warnings = []

/** Optional `--name <pkgspec>`: label the build, never touches package.json. */
const argv = process.argv.slice(2)
let nameOverride = null
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--name') nameOverride = argv[i + 1] ?? null
  else if (argv[i].startsWith('--name=')) nameOverride = argv[i].slice('--name='.length)
}
if (nameOverride !== null && !/^(@[^/\s]+\/)?[^/\s]+$/.test(nameOverride)) {
  console.error(`build-release: --name is not a valid package name: ${nameOverride}`)
  process.exit(2)
}

function say(message = '') {
  console.log(message)
}

function fail(message) {
  console.error(`\nbuild-release: ${message}`)
  process.exit(1)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function bytes(file) {
  return statSync(file).size
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The `name:` under `insert:` in cordis.patch.yml is the loader module spec, so
 * it must equal the installed package name. Keep it in sync with package.json
 * (idempotent rewrite; only that one field is touched, `id: memory` stays).
 */
function syncBundleEntryName(packageName) {
  const file = join(PKG_DIR, 'cordis.patch.yml')
  if (!existsSync(file)) fail('missing dsh-memory/cordis.patch.yml')
  const text = readFileSync(file, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  let inInsert = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!inInsert) {
      if (/^\s*-\s*insert:\s*$/.test(line)) inInsert = true
      continue
    }
    if (/^\S/.test(line) && !line.trimStart().startsWith('#')) break // left the insert block
    const match = line.match(/^(\s*name:\s*)(.*)$/)
    if (!match) continue
    const current = match[2].trim().replace(/^['"]|['"]$/g, '')
    if (current === packageName) return { changed: false, file }
    lines[i] = `${match[1]}'${packageName}'`
    writeFileSync(file, lines.join(eol))
    return { changed: true, file }
  }
  fail('cordis.patch.yml has no insert row with a name: field')
}

/**
 * Run a command and return its stdout without using a pipe: stdout goes to a
 * temporary file descriptor, so sandboxed shells cannot reject it with EPERM.
 */
function capture(cmd, args, cwd = ROOT) {
  const tmp = join(tmpdir(), `dsh-capture-${process.pid}-${Date.now()}.txt`)
  const fd = openSync(tmp, 'w')
  try {
    const result = spawnSync(cmd, args, { cwd, stdio: ['ignore', fd, 'inherit'] })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`command failed (${result.status}): ${cmd} ${args.join(' ')}`)
    return readFileSync(tmp, 'utf8')
  } finally {
    closeSync(fd)
    rmSync(tmp, { force: true })
  }
}

function runInherit(cmd, args, cwd = ROOT, extra = {}) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', ...extra })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`command failed (${result.status}): ${cmd} ${args.join(' ')}`)
}

/** Whether an executable exists on PATH (a missing binary surfaces as spawn error). */
function hasCommand(cmd, probe) {
  const result = spawnSync(cmd, probe, { stdio: 'ignore' })
  return !result.error && result.status === 0
}

/** npm executable: prefer `node <npm-cli.js>` (no shell, no quoting traps). */
function npmRunner() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return { cmd: process.execPath, prefix: [cli], shell: false, label: 'node npm-cli.js' }
  if (process.platform === 'win32') return { cmd: 'npm.cmd', prefix: [], shell: true, label: 'npm.cmd via shell' }
  return { cmd: 'npm', prefix: [], shell: false, label: 'npm' }
}

// ── 1. skills: single source of truth -> package ────────────────────────────
say('[1/5] sync skills (dsh-skills -> dsh-memory/skills)')
runInherit(process.execPath, [join(ROOT, 'scripts', 'sync-skills.mjs')])

// ── 2. preflight ────────────────────────────────────────────────────────────
say('\n[2/5] preflight')
const pkgPath = join(PKG_DIR, 'package.json')
if (!existsSync(pkgPath)) fail(`missing ${pkgPath}`)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
if (pkg.private) fail('dsh-memory/package.json still has "private": true — npm publish would refuse it')
if (!pkg.version) fail('dsh-memory/package.json has no version')
if (!pkg.files?.includes('skills/**/SKILL.md')) fail('dsh-memory/package.json files[] must list skills/**/SKILL.md')

const required = ['index.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'src/skills.js']
for (const rel of required) {
  if (!existsSync(join(PKG_DIR, rel))) fail(`missing required package file: dsh-memory/${rel}`)
}
if (!existsSync(join(PKG_DIR, 'INSTALL.md'))) {
  warnings.push('dsh-memory/INSTALL.md is missing — release docs incomplete, rebuild after it lands')
}
const skills = readdirSync(join(PKG_DIR, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(PKG_DIR, 'skills', entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
  .sort()
if (skills.length === 0) fail('dsh-memory/skills has no skill directories with SKILL.md')
say(`  package: ${pkg.name}@${pkg.version}  (private=${pkg.private ?? false}, license=${pkg.license})`)
if (nameOverride) say(`  publish name: ${nameOverride} (label only; package.json keeps ${pkg.name})`)
say(`  skills : ${skills.join(', ')}`)

// ── 3. bundle entry name + npm pack ─────────────────────────────────────────
say('\n[3/5] bundle entry + npm pack')
const bundleEntry = pkg.name
const bundleSync = syncBundleEntryName(bundleEntry)
say(
  bundleSync.changed
    ? `  cordis.patch.yml: insert name -> ${bundleEntry}`
    : `  cordis.patch.yml: insert name already ${bundleEntry}`
)
mkdirSync(DIST, { recursive: true })
// npm strips the scope when naming a tarball: @scope/dsh-memory -> scope-dsh-memory-<v>.tgz
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-')
const expectedTgzName = `${pkg.name}-${pkg.version}.tgz`
const expectedTgzPath = join(DIST, expectedTgzName)
const zipName = `${safeName}-${pkg.version}.zip`
const zipPath = join(DIST, zipName)
for (const stale of [
  expectedTgzPath,
  join(DIST, `${safeName}-${pkg.version}.tgz`),
  zipPath,
  join(DIST, 'SHA256SUMS.txt'),
  join(DIST, 'manifest.json'),
]) {
  rmSync(stale, { force: true })
}

const npm = npmRunner()
say(`  runner: ${npm.label}`)
runInherit(npm.cmd, [...npm.prefix, 'pack', '--pack-destination', DIST], PKG_DIR, { shell: npm.shell })
let tgzPath = expectedTgzPath
if (!existsSync(tgzPath)) {
  const packed = readdirSync(DIST)
    .filter((file) => file.endsWith('.tgz') && file.includes(pkg.version))
    .sort()
  if (packed.length === 0) fail(`npm pack produced no .tgz for ${pkg.name}@${pkg.version} in ${DIST}`)
  tgzPath = join(DIST, packed[packed.length - 1])
}
const tgzName = tgzPath.slice(DIST.length + 1)
say(`  -> ${tgzName} (${bytes(tgzPath)} bytes)`)

// ── 4. verify the tarball contents ──────────────────────────────────────────
say('\n[4/5] verify tarball contents')
const entries = capture('tar', ['-tzf', tgzPath])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
const expected = [
  'package/index.js',
  'package/src/skills.js',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/LICENSE',
  'package/package.json',
  ...skills.map((name) => `package/skills/${name}/SKILL.md`),
]
if (existsSync(join(PKG_DIR, 'INSTALL.md'))) expected.push('package/INSTALL.md')
const missing = expected.filter((entry) => !entries.includes(entry))
if (missing.length) fail(`tarball is missing: ${missing.join(', ')}`)
const unexpected = entries.filter((entry) => /^package\/(test|dist|node_modules)\//.test(entry))
if (unexpected.length) fail(`tarball must not ship test/dist/node_modules: ${unexpected.slice(0, 5).join(', ')}`)
const packedPatch = capture('tar', ['-xOf', tgzPath, 'package/cordis.patch.yml'])
if (!/id:\s*memory\b/.test(packedPatch)) fail('packed cordis.patch.yml lost the `id: memory` row')
if (!new RegExp(`name:\\s*['"]?${escapeRegex(bundleEntry)}['"]?`).test(packedPatch)) {
  fail(`packed cordis.patch.yml insert name does not match package name '${bundleEntry}'`)
}
say(`  ${entries.length} entries, all required files present`)
say(`  packaged bundle row: id=memory, name=${bundleEntry}`)

// ── 5. offline zip + checksums + manifest ───────────────────────────────────
say('\n[5/5] offline zip + checksums')
const staging = mkdtempSync(join(tmpdir(), 'dsh-memory-release-'))
const zipEntries = [] // relative paths inside the zip
try {
  const stage = (from, rel) => {
    const to = join(staging, ...rel.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    zipEntries.push(rel)
  }

  stage(tgzPath, tgzName)
  stage(join(ROOT, 'install.ps1'), 'install.ps1')
  stage(join(ROOT, 'scripts', 'profile-plugin.mjs'), 'scripts/profile-plugin.mjs')
  stage(join(PKG_DIR, 'README.md'), 'README.md')
  if (existsSync(join(PKG_DIR, 'INSTALL.md'))) {
    stage(join(PKG_DIR, 'INSTALL.md'), 'INSTALL.md')
  } else {
    say('  warning: dsh-memory/INSTALL.md missing — zip ships without it')
  }

  // checksums inside the zip (sha256sum -c / shasum -c compatible)
  const innerSums = zipEntries
    .map((rel) => `${sha256(join(staging, ...rel.split('/')))}  ${rel}`)
    .join('\n')
  writeFileSync(join(staging, 'SHA256SUMS.txt'), `${innerSums}\n`)
  zipEntries.push('SHA256SUMS.txt')

  // `tar -a` (auto-detect archive type from the extension) is bsdtar-only; GNU
  // tar on Linux runners rejects it, so prefer Info-ZIP when the platform has
  // it and fall back to bsdtar otherwise.
  if (hasCommand('zip', ['-v'])) {
    runInherit('zip', ['-q', '-r', '-X', zipPath, ...zipEntries], staging)
  } else {
    runInherit('tar', ['-a', '-c', '-f', zipPath, '-C', staging, ...zipEntries])
  }
} finally {
  rmSync(staging, { recursive: true, force: true })
}
if (!existsSync(zipPath)) fail(`zip was not produced: ${zipPath}`)
say(`  -> ${zipName} (${bytes(zipPath)} bytes)`)

const artifacts = [
  { name: tgzName, path: tgzPath },
  { name: zipName, path: zipPath },
].map(({ name, path }) => ({ name, bytes: bytes(path), sha256: sha256(path) }))

writeFileSync(
  join(DIST, 'SHA256SUMS.txt'),
  `${artifacts.map((a) => `${a.sha256}  ${a.name}`).join('\n')}\n`
)

const manifest = {
  name: nameOverride ?? pkg.name,
  ...(nameOverride && nameOverride !== pkg.name ? { packageJsonName: pkg.name } : {}),
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  files: artifacts,
  skills,
  bundleEntry,
  install: `pwsh -File .\\install.ps1 -From .\\${tgzName} -Apply`,
  ...(warnings.length ? { warnings } : {}),
}
writeFileSync(join(DIST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// ── summary ─────────────────────────────────────────────────────────────────
say('')
const rows = [
  ...artifacts.map((a) => [a.name, String(a.bytes), a.sha256.slice(0, 12)]),
  ['SHA256SUMS.txt', String(bytes(join(DIST, 'SHA256SUMS.txt'))), sha256(join(DIST, 'SHA256SUMS.txt')).slice(0, 12)],
  ['manifest.json', String(bytes(join(DIST, 'manifest.json'))), sha256(join(DIST, 'manifest.json')).slice(0, 12)],
]
const width = Math.max(...rows.map((row) => row[0].length), 'file'.length)
say(`${'file'.padEnd(width)}  ${'bytes'.padStart(10)}  sha256[0..12]`)
say(`${'-'.repeat(width)}  ${'-'.repeat(10)}  ${'-'.repeat(12)}`)
for (const [name, size, hash] of rows) say(`${name.padEnd(width)}  ${size.padStart(10)}  ${hash}`)
for (const warning of warnings) say(`warning: ${warning}`)
say(`\ndist: ${DIST}`)
