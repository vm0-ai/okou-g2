/**
 * Identity-scoped persistence of the chat list and per-thread chat events.
 *
 * Every key is prefixed with the Clerk user and organization, so switching
 * either one reads a different namespace instead of mixing data. The Even
 * storage API cannot enumerate or delete keys, so the namespace keeps its own
 * index of which threads it has persisted.
 */
import {
  MAX_ROWS_PER_THREAD,
  MAX_SYNCED_THREADS,
  MAX_THREADS_PERSISTED,
  STORE_VERSION,
  THREAD_START_SEQ_ID,
} from '../config'
import type { ChatEventCursor, ChatEventRow, ChatThread } from '../types'
import type { KeyValueStore } from './even-kv'

export interface Identity {
  readonly userId: string
  readonly orgId: string
}

/** Thread list plus the cursor into the user-org thread event stream. */
export interface ThreadListState {
  readonly threads: readonly ChatThread[]
  readonly seqId: number | null
}

export interface ThreadMessages {
  readonly cursor: ChatEventCursor
  readonly rows: readonly ChatEventRow[]
}

const EMPTY_THREAD_LIST: ThreadListState = { threads: [], seqId: null }

export const EMPTY_THREAD_MESSAGES: ThreadMessages = {
  cursor: { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID },
  rows: [],
}

function namespace(identity: Identity): string {
  return `okou/v${STORE_VERSION}/${identity.userId}/${identity.orgId}`
}

function parse<T>(raw: string | null): T | null {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    // A corrupt value is treated as a cold start. The server is authoritative,
    // so rebuilding costs a fetch rather than correctness.
    return null
  }
}

/** Newest activity first, matching how the list is rendered. */
function bySortAtDesc(left: ChatThread, right: ChatThread): number {
  return right.sortAt.localeCompare(left.sortAt)
}

export class ChatStore {
  private readonly prefix: string

  constructor(
    private readonly kv: KeyValueStore,
    readonly identity: Identity,
  ) {
    this.prefix = namespace(identity)
  }

  private threadListKey(): string {
    return `${this.prefix}/threads`
  }

  private threadIndexKey(): string {
    return `${this.prefix}/thread-index`
  }

  private messagesKey(threadId: string): string {
    return `${this.prefix}/thread/${threadId}/rows`
  }

  async readThreadList(): Promise<ThreadListState> {
    const stored = parse<ThreadListState>(await this.kv.read(this.threadListKey()))
    if (!stored || !Array.isArray(stored.threads)) return EMPTY_THREAD_LIST
    return stored
  }

  async writeThreadList(state: ThreadListState): Promise<void> {
    const threads = [...state.threads].sort(bySortAtDesc).slice(0, MAX_THREADS_PERSISTED)
    await this.kv.write(this.threadListKey(), JSON.stringify({ ...state, threads }))
  }

  async readMessages(threadId: string): Promise<ThreadMessages> {
    const stored = parse<ThreadMessages>(await this.kv.read(this.messagesKey(threadId)))
    if (!stored || !Array.isArray(stored.rows) || !stored.cursor) {
      return EMPTY_THREAD_MESSAGES
    }
    return stored
  }

  /**
   * Persist a thread's rows and record it in the index.
   *
   * Only the newest `MAX_ROWS_PER_THREAD` rows are kept. The cursor still
   * advances past dropped rows, so the next sync resumes from the true tail
   * rather than re-fetching trimmed history.
   */
  async writeMessages(threadId: string, messages: ThreadMessages): Promise<void> {
    const rows = messages.rows.slice(-MAX_ROWS_PER_THREAD)
    await this.kv.write(this.messagesKey(threadId), JSON.stringify({ ...messages, rows }))
    await this.addToIndex(threadId)
  }

  async readIndex(): Promise<readonly string[]> {
    return parse<string[]>(await this.kv.read(this.threadIndexKey())) ?? []
  }

  private async addToIndex(threadId: string): Promise<void> {
    const index = await this.readIndex()
    if (index[0] === threadId) return
    const next = [threadId, ...index.filter((entry) => entry !== threadId)]
    await this.kv.write(this.threadIndexKey(), JSON.stringify(next))
  }

  /**
   * Drop persisted messages for threads that are no longer in the synced set.
   *
   * Storage has no delete, so an evicted thread is overwritten with an empty
   * header. Its key stays allocated but reads as absent.
   */
  async evictMessages(keep: readonly string[]): Promise<readonly string[]> {
    const keepSet = new Set(keep.slice(0, MAX_SYNCED_THREADS))
    const index = await this.readIndex()
    const evicted = index.filter((threadId) => !keepSet.has(threadId))
    if (evicted.length === 0) return []
    for (const threadId of evicted) {
      await this.kv.remove(this.messagesKey(threadId))
    }
    await this.kv.write(
      this.threadIndexKey(),
      JSON.stringify(index.filter((threadId) => keepSet.has(threadId))),
    )
    return evicted
  }

  /** Forget this namespace. Used on sign-out and on schema mismatch. */
  async clear(): Promise<void> {
    for (const threadId of await this.readIndex()) {
      await this.kv.remove(this.messagesKey(threadId))
    }
    await this.kv.remove(this.threadIndexKey())
    await this.kv.remove(this.threadListKey())
  }
}

/** The threads whose messages are worth keeping on a glasses client. */
export function selectSyncedThreads(threads: readonly ChatThread[]): readonly string[] {
  return [...threads]
    .sort(bySortAtDesc)
    .slice(0, MAX_SYNCED_THREADS)
    .map((thread) => thread.id)
}
