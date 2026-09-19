import { describe, expect, it } from 'vitest'

import type { OkouApiClient } from '../api/client'
import { syncThreadList } from '../sync/threads'
import type { ChatThread, ChatThreadEvent, ChatThreadEventKind } from '../types'

const signal = new AbortController().signal

function thread(id: string, sortAt = '2026-01-01T00:00:00Z'): ChatThread {
  return {
    id,
    agentId: 'agent',
    title: `title-${id}`,
    sortAt,
    createdAt: sortAt,
    updatedAt: sortAt,
    pinnedAt: null,
  }
}

function event(
  seqId: number,
  kind: ChatThreadEventKind,
  chatThreadId: string,
  title: string | null,
  createdAt: string,
): ChatThreadEvent {
  return { id: `e${seqId}`, seqId, kind, chatThreadId, agentId: 'agent', title, createdAt }
}

/** Replays a fixed script of responses in call order. */
function scriptedClient(responses: readonly { status: number; body: unknown }[]): OkouApiClient {
  let call = 0
  return {
    request() {
      const response = responses[Math.min(call, responses.length - 1)]
      call += 1
      return Promise.resolve(response)
    },
  } as unknown as OkouApiClient
}

const emptyTail = { status: 200, body: { events: [], hasMore: false } }

describe('syncThreadList', () => {
  it('cold-starts from the snapshot when no cursor is cached', async () => {
    const client = scriptedClient([
      {
        status: 200,
        body: { chatThreads: [thread('1')], latestEventId: 'e', latestSeqId: 5 },
      },
      emptyTail,
    ])

    const result = await syncThreadList(client, { threads: [], seqId: null }, signal)

    expect(result.threads.map((entry) => entry.id)).toEqual(['1'])
    expect(result.seqId).toBe(5)
  })

  it('applies renames, creations and deletions from the tail', async () => {
    const client = scriptedClient([
      {
        status: 200,
        body: {
          events: [
            event(6, 'renamed', '1', 'renamed', '2026-02-01T00:00:00Z'),
            event(7, 'created', '2', 'new', '2026-03-01T00:00:00Z'),
            event(8, 'deleted', '1', null, '2026-04-01T00:00:00Z'),
          ],
          hasMore: false,
        },
      },
    ])

    const result = await syncThreadList(client, { threads: [thread('1')], seqId: 5 }, signal)

    expect(result.threads.map((entry) => entry.id)).toEqual(['2'])
    expect(result.seqId).toBe(8)
  })

  it('rebuilds from a snapshot when the cursor has expired', async () => {
    let calls = 0
    const client = {
      request({ path }: { path: string }) {
        if (path.startsWith('/api/chat-threads/snapshot')) {
          return Promise.resolve({
            status: 200,
            body: { chatThreads: [thread('9')], latestEventId: 'e', latestSeqId: 99 },
          })
        }
        calls += 1
        return Promise.resolve(
          calls === 1 ? { status: 410, body: { error: { code: 'GONE' } } } : emptyTail,
        )
      },
    } as unknown as OkouApiClient

    const result = await syncThreadList(client, { threads: [thread('1')], seqId: 5 }, signal)

    expect(result.threads.map((entry) => entry.id)).toEqual(['9'])
    expect(result.seqId).toBe(99)
  })

  it('follows pagination until the server is caught up', async () => {
    const client = scriptedClient([
      {
        status: 200,
        body: {
          events: [event(6, 'created', '2', 'p1', '2026-02-01T00:00:00Z')],
          hasMore: true,
        },
      },
      {
        status: 200,
        body: {
          events: [event(7, 'created', '3', 'p2', '2026-03-01T00:00:00Z')],
          hasMore: false,
        },
      },
    ])

    const result = await syncThreadList(client, { threads: [], seqId: 5 }, signal)

    expect(result.threads.map((entry) => entry.id)).toEqual(['2', '3'])
    expect(result.seqId).toBe(7)
  })

  it('ignores a patch for a thread it has never seen', async () => {
    const client = scriptedClient([
      {
        status: 200,
        body: {
          events: [event(6, 'renamed', 'unknown', 'ghost', '2026-02-01T00:00:00Z')],
          hasMore: false,
        },
      },
    ])

    const result = await syncThreadList(client, { threads: [thread('1')], seqId: 5 }, signal)

    expect(result.threads.map((entry) => entry.id)).toEqual(['1'])
  })
})
