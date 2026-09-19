/**
 * Wire types mirrored from `@okouai/api-contracts`.
 *
 * Only the fields this client actually reads are declared. The API's Zod
 * schemas carry many more; copying all of them would create a second source of
 * truth that silently drifts. Unknown fields are preserved on the wire because
 * responses are stored as parsed JSON, not re-serialized from these types.
 */

/** `GET /api/chat-threads/snapshot` projection. */
export interface ChatThread {
  readonly id: string
  readonly agentId: string
  readonly title: string | null
  /** Activity recency, or pin rank for pinned threads. ISO-8601. */
  readonly sortAt: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly pinnedAt: string | null
  readonly selectedModel?: string | null
}

export type ChatThreadEventKind =
  | 'created'
  | 'renamed'
  | 'deleted'
  | 'pinned'
  | 'unpinned'
  | 'model_selection_updated'
  | 'service_tier_updated'
  | 'computer_use_host_updated'
  | 'video_model_updated'
  | 'image_model_updated'
  | 'sort_touched'

/** `GET /api/chat-threads/events` element. */
export interface ChatThreadEvent {
  readonly id: string
  /** Strictly increasing within the user-org stream. */
  readonly seqId: number
  readonly kind: ChatThreadEventKind
  readonly chatThreadId: string
  readonly agentId: string
  readonly title: string | null
  readonly selectedModel?: string | null
  readonly createdAt: string
}

export interface ChatEventRowPayload {
  readonly content?: string
  readonly userMessage?: unknown
  readonly thinking?: string
  readonly error?: string
  readonly usage?: unknown
}

/** One canonical `chat_events` row, as served by the snapshot and row APIs. */
export interface ChatEventRow {
  readonly id: string
  readonly chatThreadId: string
  readonly runId: string | null
  readonly revokesEventId: string | null
  readonly eventType: string
  /** Strictly increasing within a thread; may start above 1 and have gaps. */
  readonly seqId: number
  readonly createdAt: string
  readonly payload: ChatEventRowPayload | null
}

export type ChatEventCursor =
  | { readonly lastEventId: null; readonly lastSeqId: 0 }
  | { readonly lastEventId: string; readonly lastSeqId: number }
