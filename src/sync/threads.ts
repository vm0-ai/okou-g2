/**
 * Chat thread list sync.
 *
 * Mirrors the platform SharedWorker's state machine:
 *
 *   cached cursor? ──no──▶ GET /api/chat-threads/snapshot
 *         │ yes                        │
 *         ▼                            ▼
 *   GET /api/chat-threads/events?sinceSeqId=<cursor>  ──410──▶ rebuild from snapshot
 *
 * A 410 means the server can no longer continue that cursor, so the only
 * correct response is a fresh snapshot rather than a gap-filled local list.
 */
import type { OkouApiClient } from '../api/client'
import type { ThreadListState } from '../store/chat-store'
import type { ChatThread, ChatThreadEvent } from '../types'

interface ThreadSnapshotResponse {
  readonly chatThreads: readonly ChatThread[]
  readonly latestEventId: string | null
  readonly latestSeqId: number | null
}

interface ThreadEventsResponse {
  readonly events: readonly ChatThreadEvent[]
  readonly hasMore: boolean
}

async function fetchSnapshot(
  client: OkouApiClient,
  signal: AbortSignal,
): Promise<ThreadListState> {
  const response = await client.request<ThreadSnapshotResponse>({
    path: '/api/chat-threads/snapshot',
    signal,
  })
  return {
    threads: response.body.chatThreads,
    seqId: response.body.latestSeqId,
  }
}

/**
 * Fold one lifecycle event into the list.
 *
 * `deleted` removes; `created` inserts. Everything else patches an existing
 * row and is ignored when the thread is unknown, because the snapshot that
 * would introduce it is already newer than this event.
 */
function applyEvent(
  threads: readonly ChatThread[],
  event: ChatThreadEvent,
): readonly ChatThread[] {
  if (event.kind === 'deleted') {
    return threads.filter((thread) => thread.id !== event.chatThreadId)
  }

  const existing = threads.find((thread) => thread.id === event.chatThreadId)
  if (!existing) {
    if (event.kind !== 'created') return threads
    return [
      ...threads,
      {
        id: event.chatThreadId,
        agentId: event.agentId,
        title: event.title,
        sortAt: event.createdAt,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        pinnedAt: null,
        selectedModel: event.selectedModel ?? null,
      },
    ]
  }

  const patched: ChatThread = {
    ...existing,
    updatedAt: event.createdAt,
    // Every kind except an explicit pin change also moves activity recency.
    sortAt: event.createdAt,
    ...(event.kind === 'renamed' ? { title: event.title } : {}),
    ...(event.kind === 'pinned' ? { pinnedAt: event.createdAt } : {}),
    ...(event.kind === 'unpinned' ? { pinnedAt: null } : {}),
    ...(event.kind === 'model_selection_updated'
      ? { selectedModel: event.selectedModel ?? null }
      : {}),
  }
  return threads.map((thread) => (thread.id === event.chatThreadId ? patched : thread))
}

/** Read the event tail, following pagination until the server is caught up. */
async function drainEvents(
  client: OkouApiClient,
  initial: ThreadListState,
  signal: AbortSignal,
): Promise<ThreadListState | 'cursor-expired'> {
  let state = initial
  let hasMore = true

  while (hasMore) {
    const query = state.seqId === null ? '' : `?sinceSeqId=${state.seqId}`
    const response = await client.request<ThreadEventsResponse>({
      path: `/api/chat-threads/events${query}`,
      signal,
      expect: [410],
    })
    if (response.status === 410) return 'cursor-expired'

    let threads = state.threads
    let seqId = state.seqId
    for (const event of response.body.events) {
      threads = applyEvent(threads, event)
      seqId = event.seqId
    }
    state = { threads, seqId }
    hasMore = response.body.hasMore
  }

  return state
}

export async function syncThreadList(
  client: OkouApiClient,
  cached: ThreadListState,
  signal: AbortSignal,
): Promise<ThreadListState> {
  // No cursor means nothing usable is cached: start from the server snapshot.
  let state = cached.seqId === null ? await fetchSnapshot(client, signal) : cached

  const drained = await drainEvents(client, state, signal)
  if (drained !== 'cursor-expired') return drained

  // The cursor aged out. Rebuild, then drain again so events created between
  // the snapshot and now are still applied.
  state = await fetchSnapshot(client, signal)
  const rebuilt = await drainEvents(client, state, signal)
  if (rebuilt === 'cursor-expired') {
    throw new Error('Chat thread cursor expired immediately after a snapshot')
  }
  return rebuilt
}
