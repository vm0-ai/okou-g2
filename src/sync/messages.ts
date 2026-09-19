/**
 * Per-thread chat event sync.
 *
 *   cached cursor? ──no──▶ GET /api/chat-threads/:id/event-snapshot
 *         │ yes                        │
 *         ▼                            ▼
 *   GET /api/chat-threads/:id/event-rows?sinceSeqId=… ──410──▶ rebuild from snapshot
 *
 * Only durable rows are handled. Streaming output travels on a separate
 * `run-output` Ably channel that this client never subscribes to, so a
 * half-written assistant turn simply appears once its row is committed.
 */
import { ApiError, type OkouApiClient } from '../api/client'
import { MAX_COLD_START_PAGES, THREAD_START_SEQ_ID } from '../config'
import { EMPTY_THREAD_MESSAGES, type ThreadMessages } from '../store/chat-store'
import type { ChatEventCursor, ChatEventRow } from '../types'

interface SnapshotResponse {
  readonly url: string
  readonly lastEventId: string | null
  readonly lastSeqId: number
}

interface RowsResponse {
  readonly rows: readonly ChatEventRow[]
  readonly cursor: ChatEventCursor
  readonly hasMore: boolean
}

/** Thrown when the thread itself is gone, so the caller can drop it locally. */
export class ThreadGoneError extends Error {
  constructor(readonly threadId: string) {
    super(`Chat thread ${threadId} is no longer available`)
    this.name = 'ThreadGoneError'
  }
}

function mergeRows(
  existing: readonly ChatEventRow[],
  incoming: readonly ChatEventRow[],
): readonly ChatEventRow[] {
  if (incoming.length === 0) return existing
  const byId = new Map(existing.map((row) => [row.id, row]))
  for (const row of incoming) byId.set(row.id, row)
  return [...byId.values()].sort((left, right) => left.seqId - right.seqId)
}

function rowsQuery(cursor: ChatEventCursor): string {
  return cursor.lastEventId === null
    ? `?sinceSeqId=${THREAD_START_SEQ_ID}&limit=50`
    : `?sinceSeqId=${cursor.lastSeqId}&sinceEventId=${cursor.lastEventId}&limit=50`
}

/**
 * Download and parse a thread's snapshot archive.
 *
 * The body is gzip NDJSON served with `Content-Encoding: gzip`, so `fetch`
 * decompresses it. The object lives on R2 rather than the API, which means it
 * needs its own entry in the Even network whitelist and its own CORS grant;
 * `syncThreadMessages` falls back to a bounded cold start when it fails.
 */
async function fetchSnapshot(
  client: OkouApiClient,
  threadId: string,
  signal: AbortSignal,
): Promise<ThreadMessages> {
  const response = await client.request<SnapshotResponse>({
    path: `/api/chat-threads/${threadId}/event-snapshot`,
    chatEventSchema: true,
    signal,
    expect: [404],
  })

  if (response.status === 404) {
    // The archiver has not reached this thread yet. That is a normal cold
    // start, not a missing thread — those surface as a different error code.
    const code = (response.body as unknown as { error?: { code?: string } })?.error?.code
    if (code !== undefined && code !== 'CHAT_EVENT_SNAPSHOT_NOT_FOUND') {
      throw new ThreadGoneError(threadId)
    }
    return EMPTY_THREAD_MESSAGES
  }

  const archive = await fetch(response.body.url, { signal })
  if (!archive.ok) throw new ApiError(archive.status)
  const text = await archive.text()
  if (text.length > 0 && !text.endsWith('\n')) {
    throw new Error('Chat event snapshot must be newline-delimited JSON')
  }

  const rows =
    text.length === 0
      ? []
      : text
          .slice(0, -1)
          .split('\n')
          .map((line) => JSON.parse(line) as ChatEventRow)

  return {
    rows,
    cursor:
      response.body.lastEventId === null
        ? { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID }
        : { lastEventId: response.body.lastEventId, lastSeqId: response.body.lastSeqId },
  }
}

/** Walk `event-rows` forward from a cursor. Returns null if the cursor expired. */
async function drainRows(
  client: OkouApiClient,
  threadId: string,
  initial: ThreadMessages,
  maxPages: number,
  signal: AbortSignal,
): Promise<ThreadMessages | null> {
  let state = initial
  let hasMore = true
  let pages = 0

  while (hasMore && pages < maxPages) {
    const response = await client.request<RowsResponse>({
      path: `/api/chat-threads/${threadId}/event-rows${rowsQuery(state.cursor)}`,
      chatEventSchema: true,
      signal,
      expect: [404, 410],
    })
    if (response.status === 410) return null
    if (response.status === 404) throw new ThreadGoneError(threadId)

    state = {
      rows: mergeRows(state.rows, response.body.rows),
      cursor: response.body.cursor,
    }
    hasMore = response.body.hasMore
    pages += 1
  }

  return state
}

export async function syncThreadMessages(
  client: OkouApiClient,
  threadId: string,
  cached: ThreadMessages,
  signal: AbortSignal,
): Promise<ThreadMessages> {
  const isColdStart = cached.cursor.lastEventId === null && cached.rows.length === 0

  let state = cached
  if (isColdStart) {
    try {
      state = await fetchSnapshot(client, threadId, signal)
    } catch (error) {
      if (error instanceof ThreadGoneError) throw error
      // The snapshot archive is on a different origin with its own CORS and
      // network-whitelist requirements. Reading the thread from its beginning
      // is slower but needs nothing beyond the API, so it is the fallback
      // rather than a hard failure.
      state = EMPTY_THREAD_MESSAGES
    }
  }

  // A cold start walks a bounded number of pages so one very long thread
  // cannot stall the sync; a warm tail is short and always drains fully.
  const maxPages = isColdStart ? MAX_COLD_START_PAGES : Number.POSITIVE_INFINITY
  const drained = await drainRows(client, threadId, state, maxPages, signal)
  if (drained) return drained

  // Cursor expired: rebuild from a fresh snapshot, then drain once more.
  const rebuilt = await fetchSnapshot(client, threadId, signal)
  const tail = await drainRows(client, threadId, rebuilt, MAX_COLD_START_PAGES, signal)
  if (!tail) throw new Error('Chat event cursor expired immediately after a snapshot')
  return tail
}
