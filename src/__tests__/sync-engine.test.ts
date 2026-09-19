import { afterEach, describe, expect, it, vi } from 'vitest'

import { SyncEngine, type SyncState } from '../sync/engine'
import { ChatStore } from '../store/chat-store'
import type { KeyValueStore } from '../store/even-kv'
import type { ChatEventRow, ChatThread } from '../types'
import { isRunInProgress, toLensMessages } from '../lens/messages'

const identity = { userId: 'user-test', orgId: 'org-test' }
const engines: SyncEngine[] = []
const now = '2026-09-19T12:00:00Z'

function memoryStore(): KeyValueStore {
  const values = new Map<string, string>()
  return {
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => { values.set(key, value) },
    remove: async (key) => { values.delete(key) },
  }
}

function thread(id: string, agentId = 'original-agent'): ChatThread {
  return { id, agentId, title: 'A conversation', sortAt: now, createdAt: now, updatedAt: now, pinnedAt: null }
}

function row(id: string, threadId: string, seqId: number, text: string, assistant = false): ChatEventRow {
  return {
    id, chatThreadId: threadId, seqId, runId: 'run-test', revokesEventId: null,
    createdAt: now, eventType: assistant ? 'output.message' : 'input.prompt',
    payload: assistant ? { content: text } : { userMessage: { version: 1, parts: [{ type: 'text', text }] } },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function setupApi() {
  const kv = memoryStore()
  const store = new ChatStore(kv, identity)
  const states: SyncState[] = []
  const engine = new SyncEngine(kv, identity, async () => 'test-token', (state) => { states.push(state) })
  engines.push(engine)
  const posted: Record<string, unknown>[] = []
  const rows = new Map<string, ChatEventRow[]>()
  const settings = { rejectSend: false, failHistory: false, personalModel: 'gpt-6-astra' as string | null }
  const serverThreads: ChatThread[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    switch (url.pathname) {
      case '/api/chat-threads/snapshot':
        return json({ chatThreads: serverThreads, latestEventId: 'list-event', latestSeqId: 1 })
      case '/api/chat-threads/events':
        return json({ events: [], hasMore: false })
      case '/api/agents':
        return json([{ agentId: 'default-agent', isDefaultAgent: true }])
      case '/api/user-model-preference':
        return json({ selectedModel: settings.personalModel, serviceTier: 'priority', modelSettings: { 'gpt-6-astra': { effort: 'high' } } })
      case '/api/model-policies':
        return json({ workspaceDefaultModel: 'gpt-5.6-sol', policies: [
          { model: 'gpt-5.6-sol', isDefault: true, routeStatus: 'valid' },
          { model: 'gpt-6-astra', isDefault: false, routeStatus: 'valid' },
        ] })
      case '/api/chat/events': {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        posted.push(body)
        if (settings.rejectSend || (!body.threadId && !body.model)) {
          return json({ error: { code: 'BAD_REQUEST', message: 'A model selection is required' } }, 400)
        }
        const id = (body.threadId ?? body.clientThreadId) as string
        rows.set(id, [...(rows.get(id) ?? []), row(body.clientEventId as string, id, 1, body.prompt as string)])
        return json({ threadId: id, runId: 'run-test' }, 201)
      }
    }
    if (url.pathname.endsWith('/event-snapshot')) {
      return json({ error: { code: 'CHAT_EVENT_SNAPSHOT_NOT_FOUND' } }, 404)
    }
    if (url.pathname.endsWith('/event-rows')) {
      if (settings.failHistory) return json({ error: { message: 'History is unavailable' } }, 503)
      expect(new Headers(init?.headers).get('X-Chat-Event-Schema-Version')).toBe('7')
      const id = url.pathname.split('/')[3]!
      const all = rows.get(id) ?? []
      const tail = all.filter((entry) => entry.seqId > Number(url.searchParams.get('sinceSeqId')))
      const last = all.at(-1)
      return json({ rows: tail, cursor: { lastEventId: last?.id ?? null, lastSeqId: last?.seqId ?? 0 }, hasMore: false })
    }
    throw new Error(`Unexpected test request: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return { engine, store, kv, states, posted, rows, settings, fetcher, serverThreads }
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
  vi.unstubAllGlobals()
})

describe('sending through the sync engine', () => {
  it('uses the personal model and reconciles the optimistic message with the server row', async () => {
    const app = setupApi()
    let optimisticId: string | undefined
    const id = await app.engine.send('Hello from G2', undefined, (value) => { optimisticId = value })
    expect(optimisticId).toBe(id)
    expect(app.posted[0]).toMatchObject({
      clientThreadId: id, model: 'gpt-6-astra', agentId: 'default-agent',
      runOptions: { reasoningEffort: 'high', codexServiceTier: 'fast' },
    })
    await app.engine.syncMessages(id)
    expect(toLensMessages(await app.engine.readMessages(id))).toEqual([
      { id: app.posted[0]!.clientEventId, role: 'user', seqId: 1, text: 'Hello from G2' },
    ])
    expect(isRunInProgress(await app.engine.readMessages(id))).toBe(true)
  })

  it('falls back to the configured workspace model when no personal model is selected', async () => {
    const app = setupApi()
    app.settings.personalModel = null
    const id = await app.engine.send('Use the workspace default')
    expect(app.posted[0]).toMatchObject({ model: 'gpt-5.6-sol' })
    expect(app.posted[0]!.runOptions).toBeUndefined()
    await app.engine.syncMessages(id)
  })

  it('rejects a failed send, removes the optimistic state and remains usable for a retry', async () => {
    const app = setupApi()
    app.settings.rejectSend = true
    await expect(app.engine.send('Rejected prompt')).rejects.toThrow('A model selection is required')
    const rejectedId = app.posted[0]!.clientThreadId as string
    expect((await app.store.readThreadList()).threads).toEqual([])
    expect(await app.engine.readMessages(rejectedId)).toEqual([])
    expect(app.states.at(-1)).toMatchObject({
      error: 'A model selection is required', messageCounts: { [rejectedId]: 0 },
    })

    app.settings.rejectSend = false
    const id = await app.engine.send('Try again')
    await app.engine.syncMessages(id)
    expect(toLensMessages(await app.engine.readMessages(id))[0]!.text).toBe('Try again')
  })

  it('replies with the conversation agent and preserves its model', async () => {
    const app = setupApi()
    await app.store.writeThreadList({ threads: [thread('existing-thread')], seqId: 1 })
    await app.engine.send('A reply', 'existing-thread')
    expect(app.posted[0]).toMatchObject({ threadId: 'existing-thread', agentId: 'original-agent' })
    expect(app.posted[0]!.model).toBeUndefined()
    expect(app.fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain('/api/agents')
    await app.engine.syncMessages('existing-thread')
  })

  it('does not report an accepted send as failed when the follow-up history request fails', async () => {
    const app = setupApi()
    app.settings.failHistory = true
    const id = await app.engine.send('Accepted once')
    await expect(app.engine.syncMessages(id)).rejects.toThrow('History is unavailable')
    expect(app.posted).toHaveLength(1)
    expect(toLensMessages(await app.engine.readMessages(id))[0]!.text).toBe('Accepted once')
  })
})

describe('history persistence', () => {
  it('lets opening a conversation run between batches of background history sync', async () => {
    const app = setupApi()
    app.serverThreads.push(...Array.from({ length: 8 }, (_, index) => thread(`thread-${index}`)))
    const originalFetch = app.fetcher.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let ready!: () => void
    const firstBatch = new Promise<void>((resolve) => { ready = resolve })
    let started = 0
    const reads: string[] = []
    app.fetcher.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/event-rows')) {
        const id = path.split('/')[3]!
        reads.push(id)
        if (['thread-0', 'thread-1', 'thread-2', 'thread-3'].includes(id)) {
          started += 1
          if (started === 4) ready()
          await gate
        }
      }
      return originalFetch(input, init)
    })
    const full = app.engine.syncAll()
    await firstBatch
    const opened = app.engine.syncMessages('thread-7')
    release()
    await opened
    await full
    expect(reads.indexOf('thread-7')).toBeLessThan(reads.indexOf('thread-4'))
  })

  it('retains readable history when hundreds of thinking events follow the messages', async () => {
    const store = new ChatStore(memoryStore(), identity)
    const noisyTail: ChatEventRow[] = Array.from({ length: 220 }, (_, index) => ({
      ...row(`thinking-${index}`, 'long-thread', index + 3, ''),
      eventType: 'output.thinking', payload: { thinking: 'Working' },
    }))
    await store.writeMessages('long-thread', {
      rows: [row('question', 'long-thread', 1, 'Earlier question'), row('answer', 'long-thread', 2, 'Earlier answer', true), ...noisyTail],
      cursor: { lastEventId: 'thinking-219', lastSeqId: 222 },
    })
    const cached = await store.readMessages('long-thread')
    expect(toLensMessages(cached.rows).map((message) => message.text)).toEqual(['Earlier question', 'Earlier answer'])
    expect(cached.cursor).toEqual({ lastEventId: 'thinking-219', lastSeqId: 222 })
  })

  it('rebuilds the old lossy message cache without discarding the thread list', async () => {
    const kv = memoryStore()
    const store = new ChatStore(kv, identity)
    await store.writeThreadList({ threads: [thread('old-thread')], seqId: 10 })
    await kv.write('okou/v1/user-test/org-test/thread/old-thread/rows', JSON.stringify({
      rows: [{ ...row('thinking', 'old-thread', 200, ''), eventType: 'output.thinking' }],
      cursor: { lastEventId: 'thinking', lastSeqId: 200 },
    }))
    expect(await store.readMessages('old-thread')).toEqual({ rows: [], cursor: { lastEventId: null, lastSeqId: 0 } })
    expect((await store.readThreadList()).threads[0]!.id).toBe('old-thread')
  })

  it('loads an uncached conversation from its snapshot and then appends the event tail', async () => {
    const app = setupApi()
    const first = row('event-1', 'history-thread', 1, 'Earlier question')
    const reply = row('event-2', 'history-thread', 2, '**Earlier answer**', true)
    app.fetcher.mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/event-snapshot')) {
        return json({ url: 'https://archive.example/history.ndjson', lastEventId: first.id, lastSeqId: 1, expiresInSeconds: 300 })
      }
      if (url.host === 'archive.example') return new Response(`${JSON.stringify(first)}\n`)
      if (url.pathname.endsWith('/event-rows')) {
        expect(url.searchParams.get('sinceEventId')).toBe(first.id)
        return json({ rows: [reply], cursor: { lastEventId: reply.id, lastSeqId: 2 }, hasMore: false })
      }
      throw new Error(`Unexpected history request: ${url}`)
    })
    expect(await app.engine.readMessages('history-thread')).toEqual([])
    await app.engine.syncMessages('history-thread')
    expect(toLensMessages(await app.engine.readMessages('history-thread')).map((message) => message.text))
      .toEqual(['Earlier question', 'Earlier answer'])
    const reopened = new ChatStore(app.kv, identity)
    expect((await reopened.readMessages('history-thread')).rows).toHaveLength(2)
  })

  it('keeps every thread in the index when message writes run concurrently', async () => {
    const store = new ChatStore(memoryStore(), identity)
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.writeMessages(id, {
      rows: [row(`event-${id}`, id, 1, id)], cursor: { lastEventId: `event-${id}`, lastSeqId: 1 },
    })))
    expect([...(await store.readIndex())].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})
