#!/usr/bin/env node
/**
 * Register (or inspect) a dsh plugin as a plugin bundle of one dsh profile.
 *
 * A profile is `$DSH_HOME/profiles/<name>/package.json` + `cordis.patch.yml`.
 * `dsh.profile.bundles` lists npm packages whose `dsh.bundle.patch` is
 * composed before the user patch layer, so a plugin listed there:
 *   - shows up in the DSH plugin manager (it is a declared profile plugin),
 *   - mounts its own `cordis.patch.yml` (`- insert: id: memory`) automatically,
 *   - must NOT also be inserted by hand in the profile patch (duplicate id).
 *
 * The package name is never hard-coded: it comes from `--name <pkgspec>` or,
 * when that flag is absent, from `<pluginSourceDir>/package.json`. This keeps
 * the installer working when the package is renamed or scoped
 * (`@yourscope/dsh-memory`) to dodge an npm name collision.
 *
 * Usage:
 *   node profile-plugin.mjs <profileDir> <pluginSourceDir> [--name <pkgspec>] [--dry-run]
 *
 * Exit code 0 on success; 1 on an unusable profile/plugin.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LEGACY_NAME = 'dsh-memory'

const argv = process.argv.slice(2)
const options = { dryRun: false, name: null }
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--dry-run') options.dryRun = true
  else if (arg === '--name') {
    options.name = argv[i + 1] ?? null
    i += 1
  } else if (arg.startsWith('--name=')) options.name = arg.slice('--name='.length)
  else positional.push(arg)
}

const [profileDirArg, sourceArg] = positional
if (!profileDirArg || !sourceArg) {
  console.error('usage: node profile-plugin.mjs <profileDir> <pluginSourceDir> [--name <pkgspec>] [--dry-run]')
  process.exit(2)
}
const dry = options.dryRun
const profileDir = resolve(profileDirArg)
const sourceDir = resolve(sourceArg)
const pkgPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')

if (!existsSync(pkgPath)) {
  console.error(`profile manifest missing: ${pkgPath}`)
  process.exit(1)
}
if (!existsSync(join(sourceDir, 'index.js')) || !existsSync(join(sourceDir, 'cordis.patch.yml'))) {
  console.error(`plugin source missing index.js/cordis.patch.yml: ${sourceDir}`)
  process.exit(1)
}
const sourceManifestPath = join(sourceDir, 'package.json')
if (!existsSync(sourceManifestPath)) {
  console.error(`plugin source missing package.json: ${sourceDir}`)
  process.exit(1)
}

const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
const nameSource = options.name ? '--name' : 'plugin package.json'
const name = (options.name ?? sourceManifest.name ?? '').trim()
if (!name) {
  console.error('could not determine the package name (pass --name <pkgspec>)')
  process.exit(1)
}

const linkSpec = `link:${sourceDir.replace(/\\/g, '/')}`
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? [...pkg.dsh.profile.bundles] : []

const dependencyChanged = pkg.dependencies[name] !== linkSpec
if (dependencyChanged) pkg.dependencies[name] = linkSpec
const bundleChanged = !bundles.includes(name)
if (bundleChanged) bundles.push(name)

// Upgrading from a renamed/scoped package: drop the old hard-coded name so the
// profile does not end up loading the same plugin twice (duplicate entry id).
let legacyDependencyRemoved = false
let legacyBundleRemoved = false
if (name !== LEGACY_NAME) {
  if (Object.prototype.hasOwnProperty.call(pkg.dependencies, LEGACY_NAME)) {
    delete pkg.dependencies[LEGACY_NAME]
    legacyDependencyRemoved = true
  }
  for (let index = bundles.indexOf(LEGACY_NAME); index >= 0; index = bundles.indexOf(LEGACY_NAME)) {
    bundles.splice(index, 1)
    legacyBundleRemoved = true
  }
}
if (bundleChanged || legacyBundleRemoved) pkg.dsh.profile.bundles = bundles

let patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
const marker = '# dsh-memory: cross-session memory'
const legacyAt = patch.indexOf(marker)
const legacyInsert = legacyAt >= 0
if (legacyInsert) patch = patch.slice(0, legacyAt).replace(/\s+$/, '') + '\n'

console.log(`profile: ${profileDir}`)
console.log(`  package name: ${name} (from ${nameSource})`)
console.log(`  dependency ${name}: ${dependencyChanged ? `-> ${linkSpec}` : 'already registered'}`)
console.log(`  bundle list: ${bundleChanged ? `appended ${name}` : `already lists ${name}`}`)
if (name !== LEGACY_NAME) {
  console.log(
    `  legacy '${LEGACY_NAME}' entries: ${
      legacyDependencyRemoved || legacyBundleRemoved ? 'removed (renamed package)' : 'none'
    }`
  )
}
console.log(`  legacy hand insert in cordis.patch.yml: ${legacyInsert ? 'removed (bundle owns the row now)' : 'none'}`)

if (dry) {
  console.log('  (dry run: nothing written)')
  process.exit(0)
}

const wrote = dependencyChanged || bundleChanged || legacyBundleRemoved
if (wrote) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
if (legacyInsert) writeFileSync(patchPath, patch)
console.log(wrote || legacyInsert ? '  written' : '  nothing to write')
