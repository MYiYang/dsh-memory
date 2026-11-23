/**
 * End-to-end encryption for sync payloads.
 *
 * One 32-byte key, base64 in the settings file so the operator can see it and
 * copy it to another device. Everything that leaves the machine — segment bodies
 * and snapshot parts — is sealed with AES-256-GCM before brotli is uploaded, so
 * the bucket only ever holds ciphertext.
 *
 * The key never travels with the data: a device that does not have it cannot
 * read the bucket, and nothing here writes the key into an object.
 *
 * @module dsh-memory/sync/crypto
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const KEY_BYTES = 32
export const CIPHER = 'aes-256-gcm'
const IV_BYTES = 12

/**
 * A fresh base64 key.
 * @returns {string}
 */
export function generateKey() {
  return randomBytes(KEY_BYTES).toString('base64')
}

/**
 * Parse a base64 key. Returns null for empty or wrong-length input, so callers
 * can tell "no key configured" from "key configured but broken".
 *
 * @param {unknown} value
 * @returns {Buffer | null}
 */
export function parseKey(value) {
  const text = String(value ?? '').trim()
  if (text === '') return null
  let buffer
  try {
    buffer = Buffer.from(text, 'base64')
  } catch {
    return null
  }
  if (!Buffer.isBuffer(buffer) || buffer.length !== KEY_BYTES) return null
  return buffer
}

/**
 * Build the `{ encrypt, decrypt }` pair `segment.js` expects.
 *
 * @param {unknown} value - base64 key from settings
 * @returns {{ encrypt: (buffer: Buffer) => { enc: string, iv: string, tag: string, body: Buffer }, decrypt: (header: Record<string, any>, body: Buffer) => Buffer } | null}
 */
export function createCrypto(value) {
  const key = parseKey(value)
  if (key === null) return null
  return {
    /**
     * @param {Buffer} buffer
     * @returns {{ enc: string, iv: string, tag: string, body: Buffer }}
     */
    encrypt(buffer) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(CIPHER, key, iv)
      const body = Buffer.concat([cipher.update(buffer), cipher.final()])
      return {
        enc: CIPHER,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        body,
      }
    },
    /**
     * @param {Record<string, any>} header
     * @param {Buffer} body
     * @returns {Buffer}
     */
    decrypt(header, body) {
      const iv = Buffer.from(String(header?.iv ?? ''), 'base64')
      const tag = Buffer.from(String(header?.tag ?? ''), 'base64')
      if (iv.length !== IV_BYTES || tag.length === 0) {
        const error = new Error('segment is encrypted but its IV/tag are unusable')
        Object.assign(error, { code: 'decrypt-failed' })
        throw error
      }
      const decipher = createDecipheriv(CIPHER, key, iv)
      decipher.setAuthTag(tag)
      try {
        return Buffer.concat([decipher.update(body), decipher.final()])
      } catch {
        const error = new Error('segment could not be decrypted with the configured key')
        Object.assign(error, { code: 'decrypt-failed' })
        throw error
      }
    },
  }
}
