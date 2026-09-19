/**
 * Chunked key-value storage over the Even App's persistence API.
 *
 * `bridge.setLocalStorage` / `getLocalStorage` is a flat string store with no
 * key enumeration, no delete, and no documented size limit. Three consequences
 * shape this module:
 *
 * - Large values are split into `<key>#<n>` chunks with the count recorded in a
 *   header at `<key>`, because a single oversized write may be rejected.
 * - Anything that needs listing must keep its own index; nothing here can walk
 *   the keyspace.
 * - "Delete" is an overwrite with a tombstone. Orphaned chunks from a
 *   previous longer value are ignored because the header bounds the read.
 *
 * Outside the Even App the same interface runs on `window.localStorage`, so the
 * whole sync layer is testable in a plain browser.
 */
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

import { STORE_CHUNK_BYTES } from '../config'

export interface KeyValueStore {
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

/** `v<chunks>:<totalLength>` — absent or unparsable means "no value". */
const HEADER_PATTERN = /^v(\d+):(\d+)$/u

/**
 * Explicit tombstone.
 *
 * The store has no delete, so removal is an overwrite. It needs its own marker
 * rather than a zero-length header: `v0:0` is a legitimately stored empty
 * string, and collapsing the two would make a removed key read as `''`.
 */
const TOMBSTONE = 'x'

function header(chunks: number, length: number): string {
  return `v${chunks}:${length}`
}

function chunkKey(key: string, index: number): string {
  return `${key}#${index}`
}

function splitValue(value: string): string[] {
  if (value.length === 0) return []
  const chunks: string[] = []
  for (let offset = 0; offset < value.length; offset += STORE_CHUNK_BYTES) {
    chunks.push(value.slice(offset, offset + STORE_CHUNK_BYTES))
  }
  return chunks
}

/** Raw single-slot access, supplied by the bridge or by `window.localStorage`. */
interface RawSlots {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

function createChunkedStore(slots: RawSlots): KeyValueStore {
  return {
    async read(key) {
      const head = await slots.get(key)
      if (head === null || head === TOMBSTONE) return null
      const match = HEADER_PATTERN.exec(head)
      if (!match) return null
      const chunks = Number(match[1])
      const length = Number(match[2])
      if (chunks === 0) return length === 0 ? '' : null

      const parts: string[] = []
      for (let index = 0; index < chunks; index += 1) {
        const part = await slots.get(chunkKey(key, index))
        // A missing chunk means a torn write; treat the whole value as absent
        // rather than returning truncated JSON that would parse into garbage.
        if (part === null) return null
        parts.push(part)
      }
      const value = parts.join('')
      return value.length === length ? value : null
    },

    async write(key, value) {
      const chunks = splitValue(value)
      // Chunks first, header last: a crash mid-write leaves the old header
      // pointing at old chunks rather than a header with no body.
      for (const [index, chunk] of chunks.entries()) {
        await slots.set(chunkKey(key, index), chunk)
      }
      await slots.set(key, header(chunks.length, value.length))
    },

    async remove(key) {
      await slots.set(key, TOMBSTONE)
    },
  }
}

export function createEvenStore(bridge: EvenAppBridge): KeyValueStore {
  return createChunkedStore({
    async get(key) {
      const value = await bridge.getLocalStorage(key)
      // The host returns an empty string for an unset key, which is
      // indistinguishable from a stored empty string. Headers are never empty,
      // so treating it as absent is safe for this layout.
      return value === '' || value === undefined || value === null ? null : value
    },
    async set(key, value) {
      const ok = await bridge.setLocalStorage(key, value)
      if (!ok) throw new Error(`Even storage rejected the write for "${key}"`)
    },
  })
}

export function createBrowserStore(): KeyValueStore {
  return createChunkedStore({
    get(key) {
      return Promise.resolve(window.localStorage.getItem(key))
    },
    set(key, value) {
      window.localStorage.setItem(key, value)
      return Promise.resolve()
    },
  })
}
