/**
 * Sync orchestrator.
 *
 * Owns the persisted namespace for one Clerk user + organization, runs the two
 * sync loops, and keeps an Ably connection that invalidates them. Work is
 * serialized through a single queue so a push arriving mid-sync cannot
 * interleave two writers over the same stored value.
 *
 * Lifetime note: this runs in the Even App's WebView on the phone, not on the
 * glasses. iOS keeps a backgrounded WebView alive; Android may suspend it and
 * drop the socket. Everything needed to resume is therefore persisted, and a
 * full resync runs whenever the connection comes back.
 */
import { ApiError, OkouApiClient, type TokenProvider } from '../api/client'
import {
  ChatStore,
  selectSyncedThreads,
  type Identity,
  type ThreadListState,
} from '../store/chat-store'
import type { KeyValueStore } from '../store/even-kv'
import { syncThreadMessages, ThreadGoneError } from './messages'
import { syncThreadList } from './threads'
import { connectRealtime, type RealtimeConnection, type RealtimeStatus } from './realtime'
import type { ChatEventRow, ChatThread } from '../types'

export interface SyncState {
  readonly threads: readonly ChatThread[]
  readonly messageCounts: Readonly<Record<string, number>>
  readonly realtime: RealtimeStatus | 'idle'
  readonly syncing: boolean
  readonly lastSyncedAt: number | null
  readonly error: string | null
}

export const initialSyncState: SyncState = {
  threads: [],
  messageCounts: {},
  realtime: 'idle',
  syncing: false,
  lastSyncedAt: null,
  error: null,
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Session expired'
    if (error.status === 403) return 'No access to this organization'
    if (error.status === 409) return 'Server chat-event schema mismatch'
    if (error.status === 426) return 'This app build is too old'
    return `API error ${error.status}`
  }
  return error instanceof Error ? error.message : 'Sync failed'
}

export class SyncEngine {
  private readonly client: OkouApiClient
  private readonly store: ChatStore
  private readonly controller = new AbortController()
  private realtime: RealtimeConnection | null = null
  /** Serializes every store mutation; see the class comment. */
  private queue: Promise<void> = Promise.resolve()
  private state: SyncState = initialSyncState
  private closed = false

  constructor(
    kv: KeyValueStore,
    private readonly identity: Identity,
    private readonly getToken: TokenProvider,
    private readonly onState: (state: SyncState) => void,
  ) {
    this.client = new OkouApiClient(getToken)
    this.store = new ChatStore(kv, identity)
  }

  private patch(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch }
    this.onState(this.state)
  }

  /** Run `task` after any in-flight work, swallowing nothing. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.closed) return
      try {
        await task()
      } catch (error) {
        if (this.controller.signal.aborted) return
        this.patch({ error: describeError(error), syncing: false })
      }
    })
    return this.queue
  }

  async start(): Promise<void> {
    // Render the persisted view before any network call, so a cold launch on
    // the glasses shows the last known list immediately.
    await this.enqueue(async () => {
      const cached = await this.store.readThreadList()
      this.patch({ threads: cached.threads })
      await this.loadCachedCounts()
    })

    this.realtime = connectRealtime(this.identity, this.getToken, {
      onStatus: (status) => {
        this.patch({ realtime: status })
        // A recovered connection may have missed invalidations while down.
        if (status === 'connected') void this.syncAll()
      },
      onSignal: (signal) => {
        if (signal.kind === 'thread-list') {
          void this.syncAll()
          return
        }
        void this.enqueue(() => this.syncOneThread(signal.threadId))
      },
    })

    await this.syncAll()
  }

  private async loadCachedCounts(): Promise<void> {
    const counts: Record<string, number> = {}
    for (const threadId of await this.store.readIndex()) {
      counts[threadId] = (await this.store.readMessages(threadId)).rows.length
    }
    this.patch({ messageCounts: counts })
  }

  syncAll(): Promise<void> {
    return this.enqueue(async () => {
      this.patch({ syncing: true, error: null })
      const signal = this.controller.signal

      const cached = await this.store.readThreadList()
      const next: ThreadListState = await syncThreadList(this.client, cached, signal)
      await this.store.writeThreadList(next)
      this.patch({ threads: next.threads })

      const synced = selectSyncedThreads(next.threads)
      await this.store.evictMessages(synced)
      for (const threadId of synced) {
        await this.syncOneThread(threadId)
      }

      await this.loadCachedCounts()
      this.patch({ syncing: false, lastSyncedAt: Date.now() })
    })
  }

  private async syncOneThread(threadId: string): Promise<void> {
    const signal = this.controller.signal
    const cached = await this.store.readMessages(threadId)
    try {
      const next = await syncThreadMessages(this.client, threadId, cached, signal)
      if (next.rows.length === cached.rows.length && next.cursor.lastEventId === cached.cursor.lastEventId) {
        return
      }
      await this.store.writeMessages(threadId, next)
      this.patch({
        messageCounts: { ...this.state.messageCounts, [threadId]: next.rows.length },
      })
    } catch (error) {
      if (error instanceof ThreadGoneError) {
        // The thread was deleted between the list sync and this read. Drop it
        // locally; the next list sync confirms the removal.
        await this.store.evictMessages(
          (await this.store.readIndex()).filter((entry) => entry !== threadId),
        )
        return
      }
      throw error
    }
  }

  /** Persisted rows for one thread, for rendering. */
  readMessages(threadId: string): Promise<readonly ChatEventRow[]> {
    return this.store.readMessages(threadId).then((messages) => messages.rows)
  }

  async close(options: { readonly clearStorage?: boolean } = {}): Promise<void> {
    this.closed = true
    this.controller.abort()
    this.realtime?.close()
    this.realtime = null
    if (options.clearStorage) {
      await this.store.clear()
    }
  }
}
