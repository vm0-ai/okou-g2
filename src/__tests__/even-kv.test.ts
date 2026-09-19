import { beforeEach, describe, expect, it } from 'vitest'

import { createBrowserStore } from '../store/even-kv'

const slots = new Map<string, string>()

beforeEach(() => {
  slots.clear()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => slots.get(key) ?? null,
        setItem: (key: string, value: string) => void slots.set(key, value),
      },
    },
  })
})

describe('chunked key-value store', () => {
  it('round-trips a value larger than one chunk', async () => {
    const store = createBrowserStore()
    const value = `${'x'.repeat(100_000)}✓unicode✓`

    await store.write('big', value)

    expect(await store.read('big')).toBe(value)
    expect([...slots.keys()].filter((key) => key.startsWith('big#')).length).toBeGreaterThan(1)
  })

  it('reports an unwritten key as absent', async () => {
    expect(await createBrowserStore().read('absent')).toBeNull()
  })

  it('distinguishes a stored empty string from a removed key', async () => {
    const store = createBrowserStore()

    await store.write('empty', '')
    expect(await store.read('empty')).toBe('')

    await store.write('gone', 'value')
    await store.remove('gone')
    expect(await store.read('gone')).toBeNull()
  })

  it('ignores orphan chunks when a value shrinks', async () => {
    const store = createBrowserStore()

    await store.write('key', 'y'.repeat(80_000))
    await store.write('key', 'short')

    expect(await store.read('key')).toBe('short')
  })

  it('treats a torn write as absent rather than returning truncated data', async () => {
    const store = createBrowserStore()
    await store.write('key', 'z'.repeat(80_000))
    // Simulate a write that recorded its header but lost a chunk.
    slots.delete('key#1')

    expect(await store.read('key')).toBeNull()
  })
})
