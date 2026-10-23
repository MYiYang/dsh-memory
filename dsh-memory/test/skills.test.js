import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUNDLED_SKILL_RANK,
  SKILL_PROVIDER,
  bundledSkillsDir,
  createSkillProvider,
  loadBundledSkills,
  parseFrontmatter,
  readSkill,
  registerBundledSkills,
} from '../src/skills.js'
import { apply } from '../index.js'

const quietLog = () => {}

function skillDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-skills-'))
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(full, { recursive: true })
    writeFileSync(join(full, 'SKILL.md'), content)
  }
  return dir
}

function fakeCtx({ withInject = true, withRegistry = true } = {}) {
  const providers = []
  const injections = []
  const registry = withRegistry
    ? {
        registerProvider(create) {
          const provider = create({ signal: new AbortController().signal, invalidate() {} })
          providers.push(provider)
          return () => providers.pop()
        },
      }
    : {}
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on() {
      return () => {}
    },
    effect(factory) {
      const cleanup = factory()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    get() {
      return undefined
    },
    tools: { register: () => () => {} },
    skills: registry,
  }
  if (withInject) {
    ctx.inject = (deps, callback) => {
      injections.push(deps)
      callback(ctx)
    }
  }
  return { ctx, providers, injections }
}

test('parseFrontmatter reads scalars, quotes and folded blocks', () => {
  const plain = parseFrontmatter('---\nname: demo-skill\ndescription: 一句话说明\n---\n\n# 标题\n正文\n')
  assert.equal(plain.meta.name, 'demo-skill')
  assert.equal(plain.meta.description, '一句话说明')
  assert.equal(plain.body, '# 标题\n正文')

  const crlf = parseFrontmatter('---\r\nname: crlf-skill\r\ndescription: "带冒号: 的值"\r\n---\r\n\r\n# T\r\n')
  assert.equal(crlf.meta.name, 'crlf-skill')
  assert.equal(crlf.meta.description, '带冒号: 的值')
  assert.equal(crlf.body, '# T')

  const folded = parseFrontmatter("---\nname: fold-skill\ndescription: >\n  第一行\n  第二行\n---\n\nbody\n")
  assert.equal(folded.meta.description, '第一行 第二行')

  const none = parseFrontmatter('# 没有 frontmatter\n')
  assert.deepEqual(none.meta, {})
  assert.equal(none.body, '# 没有 frontmatter')
})

test('readSkill rejects bad names and empty bodies, keeps the resource dir', () => {
  const dir = skillDir({
    'ok-skill': '---\nname: ok-skill\ndescription: 说明\nwhen_to_use: 需要时\n---\n\n# OK\n',
    'Bad_Name': '---\nname: Bad_Name\ndescription: 说明\n---\n\n# x\n',
    'no-desc': '---\nname: no-desc\n---\n\n# x\n',
    'no-body': '---\nname: no-body\ndescription: 说明\n---\n',
  })
  const ok = readSkill(join(dir, 'ok-skill'), 'ok-skill')
  assert.equal(ok.name, 'ok-skill')
  assert.equal(ok.whenToUse, '需要时')
  assert.equal(ok.content, '# OK')
  assert.equal(readSkill(join(dir, 'Bad_Name'), 'Bad_Name'), null)
  assert.equal(readSkill(join(dir, 'no-desc'), 'no-desc'), null)
  assert.equal(readSkill(join(dir, 'no-body'), 'no-body'), null)
  assert.equal(readSkill(join(dir, 'missing'), 'missing'), null)
})

test('loadBundledSkills reads the four shipped skills from the package', () => {
  const loaded = loadBundledSkills({ log: quietLog })
  const names = loaded.skills.map((skill) => skill.name).sort()
  assert.deepEqual(names, ['dsh-plugin-dev', 'memory-curator', 'repo-audit', 'windows-pwsh-ops'])
  assert.deepEqual(loaded.skipped, [])
  for (const skill of loaded.skills) {
    assert.ok(skill.description.length > 10, `${skill.name} has a description`)
    assert.ok(skill.content.startsWith('#'), `${skill.name} body starts with a heading`)
    assert.ok(!skill.content.includes('description:'), `${skill.name} body excludes frontmatter`)
    assert.equal(skill.path, join(bundledSkillsDir(), skill.name, 'SKILL.md'))
  }
})

test('loadBundledSkills degrades quietly when the pack is missing', () => {
  const warnings = []
  const loaded = loadBundledSkills({
    dir: join(tmpdir(), 'dsh-memory-no-such-skills-dir'),
    log: (level, message) => warnings.push(`${level}:${message}`),
  })
  assert.deepEqual(loaded.skills, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^warn:bundled skills directory not found/)
})

test('loadBundledSkills reports skipped directories instead of throwing', () => {
  const dir = skillDir({
    'good-one': '---\nname: good-one\ndescription: 说明\n---\n\n# good\n',
    'bad-one': '---\nname: BAD ONE\ndescription: 说明\n---\n\n# bad\n',
  })
  const warnings = []
  const loaded = loadBundledSkills({ dir, log: (level, message) => warnings.push(`${level}:${message}`) })
  assert.deepEqual(loaded.skills.map((skill) => skill.name), ['good-one'])
  assert.deepEqual(loaded.skipped, ['bad-one'])
  assert.ok(warnings.some((line) => line.includes('bad-one')))
})

test('the provider publishes rank 600 candidates and loads bodies by locator', async () => {
  const loaded = loadBundledSkills({ log: quietLog })
  const provider = createSkillProvider(loaded.skills)
  assert.equal(provider.name, SKILL_PROVIDER)

  const candidates = await provider.list()
  assert.equal(candidates.length, loaded.skills.length)
  for (const candidate of candidates) {
    assert.equal(candidate.rank, BUNDLED_SKILL_RANK)
    assert.equal(candidate.provider, SKILL_PROVIDER)
    assert.equal(candidate.source, 'bundled')
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(candidate.resourceBase.kind, 'directory')
    assert.equal(typeof candidate.locator, 'string')
  }

  const curator = candidates.find((candidate) => candidate.name === 'memory-curator')
  const definition = await provider.get(curator)
  assert.equal(definition.name, 'memory-curator')
  assert.ok(definition.content.includes('记忆维护'))
  assert.equal(await provider.get({ locator: 'no-such-skill' }), undefined)
})

test('registerBundledSkills registers one provider once the skills service exists', async () => {
  const { ctx, providers, injections } = fakeCtx()
  const result = registerBundledSkills(ctx, { log: quietLog })
  assert.equal(result.registered, true)
  assert.equal(result.skills.length, 4)
  assert.deepEqual(injections, [['skills']])
  assert.equal(providers.length, 1)
  const names = (await providers[0].list()).map((candidate) => candidate.name).sort()
  assert.deepEqual(names, ['dsh-plugin-dev', 'memory-curator', 'repo-audit', 'windows-pwsh-ops'])
})

test('registerBundledSkills stays silent when the host has no skill registry', () => {
  const withoutInject = fakeCtx({ withInject: false })
  const first = registerBundledSkills(withoutInject.ctx, { log: quietLog })
  assert.equal(first.registered, false)
  assert.equal(withoutInject.providers.length, 0)

  const withoutProvider = fakeCtx({ withRegistry: false })
  const second = registerBundledSkills(withoutProvider.ctx, { log: quietLog })
  assert.equal(second.registered, true)
  assert.equal(withoutProvider.providers.length, 0)
})

test('apply() wires bundled skills without needing a model or a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-apply-'))
  const { ctx, providers } = fakeCtx()
  apply(ctx, {
    dbPath: join(dir, 'memory.db'),
    settingsPath: join(dir, 'settings.json'),
    capture: false,
    extraction: { enabled: false },
  })
  assert.equal(providers.length, 1)
  assert.equal(providers[0].name, SKILL_PROVIDER)

  const off = fakeCtx()
  apply(off.ctx, {
    dbPath: join(dir, 'memory-off.db'),
    settingsPath: join(dir, 'settings.json'),
    capture: false,
    extraction: { enabled: false },
    skills: { enabled: false },
  })
  assert.equal(off.providers.length, 0)
})
