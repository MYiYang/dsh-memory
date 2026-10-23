/**
 * Persistence for the settings page layer.
 *
 * One small JSON file beside the memory database:
 *
 *   $DSH_HOME/memory/settings.json
 *
 * It stores only the keys the user changed in the settings page — never a full
 * copy of the defaults — so YAML configuration keeps working underneath and a
 * deleted file is the cleanest "reset to the profile's baseline".
 *
 * The file is written atomically (temp file + rename) and every read is
 * failure-isolated: a corrupt or half-written settings file must never stop the
 * plugin from booting, it just loses the overrides and reports the error to the
 * settings page.
 *
 * @module dsh-memory/settings-store
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn as spawnProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { resolveHome, SETTINGS_VERSION } from './settings.js'

/** Refuse to parse absurdly large files (a settings file is a few hundred bytes). */
const MAX_SETTINGS_BYTES = 1024 * 1024

/**
 * Read the settings layer.
 * @param {string} path
 * @returns {{ settings: Record<string, any>, exists: boolean, updatedAt: string|null, error: string|null }}
 */
export function readSettingsFile(path) {
  let text
  try {
    if (!existsSync(path)) return { settings: {}, exists: false, updatedAt: null, error: null }
    const size = statSync(path).size
    if (size > MAX_SETTINGS_BYTES) {
      return { settings: {}, exists: true, updatedAt: null, error: `settings file is larger than ${MAX_SETTINGS_BYTES} bytes` }
    }
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { settings: {}, exists: false, updatedAt: null, error: messageOf(error) }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { settings: {}, exists: true, updatedAt: null, error: 'settings file must contain a JSON object' }
    }
    const settings = isPlainObject(parsed.settings) ? parsed.settings : parsed
    // The wrapper's own bookkeeping must never leak into the config merge.
    const clean = { ...settings }
    delete clean.version
    delete clean.updatedAt
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
    return { settings: clean, exists: true, updatedAt, error: null }
  } catch (error) {
    return { settings: {}, exists: true, updatedAt: null, error: `settings file is not valid JSON: ${messageOf(error)}` }
  }
}

/**
 * Persist the settings layer atomically.
 * @param {string} path
 * @param {Record<string, any>} settings
 * @returns {{ updatedAt: string, bytes: number }}
 */
export function writeSettingsFile(path, settings) {
  const updatedAt = new Date().toISOString()
  const payload = `${JSON.stringify({ version: SETTINGS_VERSION, updatedAt, settings }, null, 2)}\n`
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.tmp`
  try {
    // Rename is atomic within one filesystem on every supported platform, so a
    // crash leaves either the old complete file or the new complete file.
    writeFileSync(temporary, payload, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* best effort */
    }
    throw error
  }
  return { updatedAt, bytes: Buffer.byteLength(payload) }
}

/**
 * Remove the settings layer (reverting every field to the profile baseline).
 * @param {string} path
 * @returns {boolean} whether a file was removed
 */
export function clearSettingsFile(path) {
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

/**
 * Describe the storage directory for the settings page: the directory itself,
 * the database + settings paths, and the files that actually exist there
 * (database, `-wal`, `-shm`, settings file, any backup).
 *
 * @param {{ dir: string, dbPath: string, settingsPath: string, home?: string }} input
 * @returns {{
 *   home: string, dir: string, dbPath: string, settingsPath: string,
 *   settingsExists: boolean, files: Array<{ name: string, bytes: number, modifiedAt: number }>,
 *   totalBytes: number, error: string|null,
 * }}
 */
export function describeStorage(input) {
  /** @type {Array<{ name: string, bytes: number, modifiedAt: number }>} */
  const files = []
  let error = null
  try {
    for (const entry of readdirSync(input.dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const basename = String(entry.name)
      try {
        const info = statSync(join(input.dir, basename))
        files.push({ name: basename, bytes: info.size, modifiedAt: Math.round(info.mtimeMs) })
      } catch {
        /* a file that vanished mid-listing is not an error */
      }
    }
  } catch (failure) {
    // A missing directory is normal before the first database open; anything
    // else (permissions, a file where the directory should be) is reported.
    if (/** @type {any} */ (failure)?.code !== 'ENOENT') error = messageOf(failure)
  }
  files.sort((left, right) => left.name.localeCompare(right.name))
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  return {
    home: input.home ?? resolveHome(),
    dir: input.dir,
    dbPath: input.dbPath,
    settingsPath: input.settingsPath,
    settingsExists: existsSync(input.settingsPath),
    files,
    totalBytes,
    error,
  }
}

/** Plain-object check that excludes arrays and null. */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Open a directory in the platform file manager (the "打开目录" button).
 *
 * Best effort by design: the settings page still shows the path when spawning
 * a file manager fails (headless box, locked-down session, unknown platform).
 * `spawnImpl`/`platform` are injectable so tests never open a real window.
 *
 * @param {string} directory
 * @param {{
 *   spawn?: (command: string, args: string[], options: Record<string, unknown>) => any,
 *   platform?: NodeJS.Platform,
 *   log?: (level: string, message: string) => void,
 * }} [options]
 * @returns {{ opened: boolean, dir: string, error?: string }}
 */
export function revealDirectory(directory, options = {}) {
  const spawn = options.spawn ?? spawnProcess
  const platform = options.platform ?? process.platform
  const log = options.log ?? (() => {})
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(command, [directory], { detached: true, stdio: 'ignore' })
    // A failed spawn reports asynchronously on the child, never by throwing.
    child?.on?.('error', (error) => log('warn', `cannot open storage directory: ${messageOf(error)}`))
    child?.unref?.()
    return { opened: true, dir: directory }
  } catch (error) {
    log('warn', `cannot open storage directory: ${messageOf(error)}`)
    return { opened: false, dir: directory, error: messageOf(error) }
  }
}

/** Error → stable one-line message. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
