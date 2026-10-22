#!/usr/bin/env node
/**
 * sync-skills — mirror the single source of truth for skills
 * (`dsh-skills/<name>/`) into the publishable package
 * (`dsh-memory/skills/<name>/`).
 *
 * Only directories that contain a `SKILL.md` are treated as skills. The target
 * tree is mirrored exactly, so stale files/directories in `dsh-memory/skills`
 * are deleted; the two trees never drift. The script is idempotent: a second
 * run with no upstream change reports 0 changes and writes nothing.
 *
 * Usage:
 *   node scripts/sync-skills.mjs           # apply the sync
 *   node scripts/sync-skills.mjs --check   # report drift only; exit 1 if any
 *
 * Exit codes: 0 = in sync / synced, 1 = drift found by --check (or bad state).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'dsh-skills')
const DEST = join(ROOT, 'dsh-memory', 'skills')
const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const verbose = !args.has('--quiet')

function fail(message) {
  console.error(`sync-skills: ${message}`)
  process.exit(1)
}

if (!existsSync(SRC) || !statSync(SRC).isDirectory()) fail(`source directory missing: ${SRC}`)

/** Skill directories = direct children of dsh-skills that own a SKILL.md. */
function listSkills(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Recursive listing. Symlinks/junctions are skipped on purpose: following a
 * link out of the skills tree is never intended and could loop.
 */
function walk(root, rel = '') {
  const files = new Set()
  const dirs = new Set()
  const here = rel ? join(root, rel) : root
  let entries
  try {
    entries = readdirSync(here, { withFileTypes: true })
  } catch {
    return { files, dirs }
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      dirs.add(childRel)
      const nested = walk(root, childRel)
      for (const file of nested.files) files.add(file)
      for (const dir of nested.dirs) dirs.add(dir)
    } else if (entry.isFile()) {
      files.add(childRel)
    }
  }
  return { files, dirs }
}

function sameFile(a, b) {
  const left = readFileSync(a)
  const right = readFileSync(b)
  return left.equals(right)
}

// ── Build the plan ──────────────────────────────────────────────────────────
const sourceSkills = listSkills(SRC)
if (sourceSkills.length === 0) fail(`no skill directory (with SKILL.md) found under ${SRC}`)

const changed = [] // { kind, path }
const dirsToCreate = []
const dirsToRemove = []

const targetSkills = existsSync(DEST) ? listSkills(DEST) : []
const staleSkills = targetSkills.filter((name) => !sourceSkills.includes(name))

for (const name of sourceSkills) {
  const srcRoot = join(SRC, name)
  const destRoot = join(DEST, name)
  const src = walk(srcRoot)
  const dest = walk(destRoot)

  if (!existsSync(destRoot)) dirsToCreate.push(name)
  for (const relDir of [...src.dirs].sort()) {
    if (!existsSync(join(destRoot, relDir))) dirsToCreate.push(`${name}/${relDir}`)
  }

  for (const relFile of [...src.files].sort()) {
    const from = join(srcRoot, relFile)
    const to = join(destRoot, relFile)
    if (!existsSync(to)) changed.push({ kind: 'added', path: `${name}/${relFile}` })
    else if (!sameFile(from, to)) changed.push({ kind: 'updated', path: `${name}/${relFile}` })
  }
  for (const relFile of [...dest.files].sort()) {
    if (!src.files.has(relFile)) changed.push({ kind: 'removed', path: `${name}/${relFile}` })
  }
  for (const relDir of [...dest.dirs].sort()) {
    if (!src.dirs.has(relDir)) dirsToRemove.push(`${name}/${relDir}`)
  }
}

for (const name of staleSkills) {
  const { files, dirs } = walk(join(DEST, name))
  for (const relFile of [...files].sort()) changed.push({ kind: 'removed', path: `${name}/${relFile}` })
  for (const relDir of [...dirs].sort()) dirsToRemove.push(`${name}/${relDir}`)
  dirsToRemove.push(name)
}

const counts = { added: 0, updated: 0, removed: 0 }
for (const item of changed) counts[item.kind] += 1

// ── Report / apply ──────────────────────────────────────────────────────────
console.log(`sync-skills${checkOnly ? ' (check)' : ''}`)
console.log(`  source: ${SRC}`)
console.log(`  target: ${DEST}`)
console.log(`  skills: ${sourceSkills.join(', ')}`)

const marker = { added: '+', updated: '~', removed: '-' }
if (verbose) {
  for (const item of changed) console.log(`  ${marker[item.kind]} ${item.path}`)
}

if (checkOnly) {
  if (counts.added + counts.updated + counts.removed > 0) {
    console.log(
      `drift: added ${counts.added}, updated ${counts.updated}, removed ${counts.removed}` +
        ` (run: node scripts/sync-skills.mjs)`
    )
    process.exit(1)
  }
  console.log('in sync: added 0, updated 0, removed 0')
  process.exit(0)
}

if (counts.added + counts.updated + counts.removed === 0 && dirsToCreate.length === 0 && dirsToRemove.length === 0) {
  console.log('added 0, updated 0, removed 0 — nothing to do')
  process.exit(0)
}

mkdirSync(DEST, { recursive: true })
for (const relDir of dirsToCreate) mkdirSync(join(DEST, relDir), { recursive: true })
for (const item of changed) {
  if (item.kind === 'removed') continue
  const [name, ...rest] = item.path.split('/')
  const to = join(DEST, name, ...rest)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, readFileSync(join(SRC, name, ...rest)))
}
for (const item of changed) {
  if (item.kind !== 'removed') continue
  const [name, ...rest] = item.path.split('/')
  rmSync(join(DEST, name, ...rest), { force: true })
}
for (const name of staleSkills) {
  const dir = join(DEST, name)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

// Remove directories that only existed in the target (deepest first).
for (const relDir of [...new Set(dirsToRemove)].sort((a, b) => b.length - a.length)) {
  const dir = join(DEST, relDir)
  if (!existsSync(dir)) continue
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: false, force: true })
  } catch {
    /* already gone */
  }
}

console.log(`added ${counts.added}, updated ${counts.updated}, removed ${counts.removed}`)
