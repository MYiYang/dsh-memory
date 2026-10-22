/**
 * Bundled skills: expose `<package>/skills/<name>/SKILL.md` to the host skill
 * registry as one provider.
 *
 * Why a provider and not a copy into `~/.dsh/skills`:
 *   - a published npm package cannot write into the user's home from a
 *     `postinstall` script (pnpm ≥ 10 blocks dependency build scripts until the
 *     user approves them), so copying is unreliable by design;
 *   - `customSkillDirs` needs an absolute path, which the package cannot know;
 *   - a provider registers in memory, is disposed with the plugin, and carries
 *     a rank the user can outrank.
 *
 * Rank: bundled skills sit at {@link BUNDLED_SKILL_RANK} (600), the lowest band
 * in `dsh-skill-filesystem`, so a project (`.dsh/skills`, 100), a custom dir
 * (300) or the user's own `~/.dsh/skills` (400) copy of the same name wins.
 *
 * @module dsh-memory/skills
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Lowest skill band: user, custom and project roots all outrank it. */
export const BUNDLED_SKILL_RANK = 600
/** Origin bucket reported to the catalog; prompt-visible metadata only. */
export const BUNDLED_SKILL_SOURCE = 'bundled'
/** Provider name registered in the host skill registry. */
export const SKILL_PROVIDER = 'dsh-memory'

/** Same grammar the host registry enforces, so a bad directory name is skipped here too. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Absolute path of this package's `skills/` directory.
 * @returns {string}
 */
export function bundledSkillsDir() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills')
}

/**
 * Strip one YAML frontmatter block from a SKILL.md.
 *
 * Deliberately tiny: `key: value` scalars plus folded (`>`) / literal (`|`)
 * blocks, which is everything a skill header needs. Unknown nesting is ignored
 * rather than guessed at.
 * @param {string} raw - file contents.
 * @returns {{ meta: Record<string, string>, body: string }}
 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const empty = { meta: {}, body: text.trim() }
  if (!text.startsWith('---\n')) return empty
  const end = text.indexOf('\n---', 3)
  if (end === -1) return empty
  const header = text.slice(4, end)
  // `\n---` ends at the dashes; the body starts after that line.
  const bodyStart = text.indexOf('\n', end + 1)
  const body = bodyStart === -1 ? '' : text.slice(bodyStart + 1)

  /** @type {Record<string, string>} */
  const meta = {}
  const lines = header.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.startsWith('#')) continue
    if (/^\s/.test(line)) continue // nested / continuation lines are not supported
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const folded = value.startsWith('>')
      const collected = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        collected.push(lines[i + 1].trim())
        i += 1
      }
      meta[key] = folded ? collected.filter(Boolean).join(' ') : collected.join('\n').trim()
      continue
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    meta[key] = value
  }
  return { meta, body: body.trim() }
}

/**
 * Read one skill directory.
 * @param {string} dir - skill directory (contains SKILL.md).
 * @param {string} [fallbackName] - name to use when frontmatter omits one.
 * @returns {{ name: string, description: string, whenToUse?: string, path: string, content: string } | null}
 */
export function readSkill(dir, fallbackName) {
  const file = join(dir, 'SKILL.md')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const { meta, body } = parseFrontmatter(raw)
  const name = (meta.name || fallbackName || '').trim()
  const description = (meta.description || '').trim()
  if (!SKILL_NAME.test(name) || description === '' || body === '') return null
  return {
    name,
    description,
    whenToUse: meta.when_to_use?.trim() || meta.whenToUse?.trim() || undefined,
    path: file,
    content: body,
  }
}

/**
 * Load every valid skill under one `skills/` directory.
 * Never throws: a missing or unreadable pack degrades to "no bundled skills".
 * @param {{ dir?: string, log?: (level: string, message: string) => void }} [options]
 * @returns {{ skills: Array<{name: string, description: string, whenToUse?: string, path: string, content: string}>, skipped: string[] }}
 */
export function loadBundledSkills(options = {}) {
  const log = options.log ?? (() => {})
  const dir = options.dir ?? bundledSkillsDir()
  /** @type {Array<{name: string, description: string, whenToUse?: string, path: string, content: string}>} */
  const skills = []
  /** @type {string[]} */
  const skipped = []
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      log('warn', `bundled skills directory not found: ${dir}`)
      return { skills, skipped }
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (!existsSync(join(full, 'SKILL.md'))) continue
      const skill = readSkill(full, entry.name)
      if (skill === null) {
        skipped.push(entry.name)
        continue
      }
      if (skills.some((existing) => existing.name === skill.name)) {
        skipped.push(entry.name)
        continue
      }
      skills.push(skill)
    }
  } catch (error) {
    log('warn', `bundled skills unreadable (${dir}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (skipped.length > 0) log('warn', `bundled skills skipped (bad name/description/body): ${skipped.join(', ')}`)
  return { skills, skipped }
}

/**
 * Build the `ctx.skills.registerProvider()` payload for an already-read pack.
 * @param {ReadonlyArray<{name: string, description: string, whenToUse?: string, path: string, content: string}>} skills
 * @returns {{ name: string, list: Function, get: Function }}
 */
export function createSkillProvider(skills) {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const candidates = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: { modelInvocable: true, userInvocable: true },
    source: BUNDLED_SKILL_SOURCE,
    provider: SKILL_PROVIDER,
    resourceBase: { kind: 'directory', path: dirname(skill.path) },
    rank: BUNDLED_SKILL_RANK,
    locator: skill.name,
    path: skill.path,
  }))
  return {
    name: SKILL_PROVIDER,
    async list() {
      return candidates
    },
    async get(candidate) {
      const key = typeof candidate?.locator === 'string' ? candidate.locator : candidate?.name
      const skill = byName.get(key)
      if (skill === undefined) return undefined
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        invocation: { modelInvocable: true, userInvocable: true },
        source: BUNDLED_SKILL_SOURCE,
        provider: SKILL_PROVIDER,
        resourceBase: { kind: 'directory', path: dirname(skill.path) },
        content: skill.content,
        path: skill.path,
      }
    },
  }
}

/**
 * Register the package's bundled skills on the host registry, once the
 * `skills` service is available. Degrades to a log line when the host has no
 * skill registry (older dsh, or a headless profile without the skill packages).
 *
 * Must be called from `apply()`; `ctx.inject` ties the registration to this
 * plugin's fiber, so unloading the plugin unregisters the provider.
 * @param {any} ctx - cordis context of the plugin.
 * @param {{ dir?: string, log?: (level: string, message: string) => void }} [options]
 * @returns {{ registered: boolean, skills: string[] }}
 */
export function registerBundledSkills(ctx, options = {}) {
  const log = options.log ?? (() => {})
  const loaded = loadBundledSkills({ dir: options.dir, log })
  const names = loaded.skills.map((skill) => skill.name)
  if (loaded.skills.length === 0) return { registered: false, skills: names }
  if (typeof ctx?.inject !== 'function') {
    log('warn', `host exposes no ctx.inject(); ${names.length} bundled skill(s) stay unregistered`)
    return { registered: false, skills: names }
  }
  try {
    ctx.inject(['skills'], (scope) => {
      try {
        const registry = scope?.skills
        if (registry === undefined || typeof registry.registerProvider !== 'function') {
          log('warn', 'skills registry has no registerProvider(); bundled skills skipped')
          return
        }
        registry.registerProvider(() => createSkillProvider(loaded.skills))
        log('debug', `registered ${names.length} bundled skill(s): ${names.join(', ')}`)
      } catch (error) {
        log('warn', `bundled skill registration failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    log('warn', `bundled skill injection failed: ${error instanceof Error ? error.message : String(error)}`)
    return { registered: false, skills: names }
  }
  return { registered: true, skills: names }
}
