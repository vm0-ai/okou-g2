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
import { SYNC_CONCURRENCY } from '../config'
import { prepareSend, sendChatEvent } from './send'
import { resolveSendModel } from './model'
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
  /** Default agent used for sends; resolved lazily on the first send. */
  readonly agentId: string | null
}

export const initialSyncState: SyncState = {
  threads: [],
  messageCounts: {},
  realtime: 'idle',
  syncing: false,
  lastSyncedAt: null,
  error: null,
  agentId: null,
}

interface AgentSummary {
  readonly agentId: string
  readonly isDefaultAgent: boolean
}

/** Run `tasks` with a bounded number in flight, preserving failures. */
async function withConcurrency(
  tasks: readonly (() => Promise<void>)[],
  limit: number,
): Promise<void> {
  let next = 0
  const failures: unknown[] = []
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next]
      next += 1
      try {
        await task?.()
      } catch (error) {
        failures.push(error)
      }
    }
  })
  await Promise.all(workers)
  if (failures.length > 0) throw failures[0]
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.detail) return error.detail
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
  private allSync: Promise<void> | null = null
  private resyncRequested = false
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
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      this.controller.signal.throwIfAborted()
      return task()
    })
    // Keep the queue usable after a failure, but return the original operation
    // to the caller. A rejected send must never look like a successful send.
    this.queue = result.then(
      () => undefined,
      (error: unknown) => {
        if (this.closed) return
        this.patch({ error: describeError(error) })
      },
    )
    return result
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
        if (this.state.threads.some((thread) => thread.id === signal.threadId)) {
          void this.enqueue(() => this.syncOneThread(signal.threadId))
        }
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
    if (this.allSync) {
      this.resyncRequested = true
      return this.allSync
    }
    this.resyncRequested = false
    const run = async () => {
      const synced = await this.enqueue(async () => {
        this.patch({ syncing: true, error: null })
        const cached = await this.store.readThreadList()
        const next: ThreadListState = await syncThreadList(this.client, cached, this.controller.signal)
        await this.store.writeThreadList(next)
        const persisted = await this.store.readThreadList()
        this.patch({ threads: persisted.threads })
        const ids = selectSyncedThreads(persisted.threads)
        await this.store.evictMessages(ids)
        return ids
      })

      const failures: unknown[] = []
      // Yield the mutation queue after each small batch. Opening a chat or
      // sending a message can then run without waiting for all 100 histories.
      for (let offset = 0; offset < synced.length; offset += SYNC_CONCURRENCY) {
        try {
          await this.enqueue(() => withConcurrency(
            synced.slice(offset, offset + SYNC_CONCURRENCY).map((id) => () => this.syncOneThread(id)),
            SYNC_CONCURRENCY,
          ))
        } catch (error) {
          this.controller.signal.throwIfAborted()
          failures.push(error)
        }
      }
      await this.enqueue(() => this.loadCachedCounts())
      if (failures.length > 0) throw failures[0]
      this.patch({ syncing: false, lastSyncedAt: Date.now(), error: null })
    }
    const result = run().catch((error: unknown) => {
      if (!this.closed) this.patch({ syncing: false, error: describeError(error) })
      throw error
    })
    this.allSync = result
    // Both branches own the background promise; interactive callers can still
    // await the original rejection and display a retry affordance.
    const settled = () => {
      this.allSync = null
      // A thread-list push arriving after the list read must not get lost
      // while this pass is still downloading message histories.
      if (this.resyncRequested && !this.closed) void this.syncAll()
    }
    void result.then(settled, settled)
    return result
  }

  private async syncOneThread(threadId: string): Promise<void> {
    const signal = this.controller.signal
    const cached = await this.store.readMessages(threadId)
    try {
      const next = await syncThreadMessages(this.client, threadId, cached, signal)
      if (next.rows.length === cached.rows.length && next.cursor.lastEventId === cached.cursor.lastEventId) {
        return
      }
      const count = await this.store.writeMessages(threadId, next)
      this.patch({
        messageCounts: { ...this.state.messageCounts, [threadId]: count },
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

  /** Opening a conversation must also fetch rows missing from its local cache. */
  syncMessages(threadId: string): Promise<void> {
    return this.enqueue(() => this.syncOneThread(threadId))
  }

  /**
   * The agent a send is attributed to.
   *
   * Resolved once and cached: the glasses have no agent picker, so the default
   * agent is the only sensible target.
   */
  private async resolveAgentId(signal: AbortSignal): Promise<string> {
    if (this.state.agentId) return this.state.agentId
    const response = await this.client.request<readonly AgentSummary[]>({
      path: '/api/agents',
      signal,
    })
    const agents = response.body
    const agent = agents.find((entry) => entry.isDefaultAgent) ?? agents[0]
    if (!agent) throw new Error('This organization has no agent to send to')
    this.patch({ agentId: agent.agentId })
    return agent.agentId
  }

  /**
   * Send a prompt, showing it before the server confirms.
   *
   * The optimistic rows carry the same client-generated ids as the request, so
   * the follow-up sync replaces them by id instead of duplicating them. A
   * failure rolls the optimistic rows back rather than leaving a message that
   * looks sent.
   */
  send(
    prompt: string,
    threadId?: string,
    onOptimistic?: (threadId: string) => void,
  ): Promise<string> {
    return this.enqueue(async () => {
      const signal = this.controller.signal
      this.patch({ error: null })
      const cachedThreads = await this.store.readThreadList()
      const existingThread = threadId === undefined
        ? undefined
        : cachedThreads.threads.find((thread) => thread.id === threadId)
      if (threadId !== undefined && !existingThread) {
        throw new Error('This chat is no longer available. Sync the chat list again.')
      }
      const agentId = existingThread?.agentId ?? await this.resolveAgentId(signal)
      const selection = threadId === undefined ? await resolveSendModel(this.client, signal) : undefined
      const optimistic = prepareSend(
        threadId === undefined ? { agentId, selection } : { agentId, threadId },
        prompt,
      )

      const cachedMessages = await this.store.readMessages(optimistic.threadId)

      // Show it first.
      const count = await this.store.writeMessages(optimistic.threadId, {
        cursor: cachedMessages.cursor,
        rows: [...cachedMessages.rows, optimistic.row],
      })
      if (optimistic.thread) {
        await this.store.writeThreadList({
          ...cachedThreads,
          threads: [optimistic.thread, ...cachedThreads.threads],
        })
        this.patch({ threads: (await this.store.readThreadList()).threads })
      }
      this.patch({
        messageCounts: {
          ...this.state.messageCounts,
          [optimistic.threadId]: count,
        },
      })
      onOptimistic?.(optimistic.threadId)

      let runId: string | null
      try {
        const result = await sendChatEvent(this.client, optimistic, signal)
        runId = result.runId
      } catch (error) {
        // Roll back to exactly what was stored before the attempt.
        await this.store.writeMessages(optimistic.threadId, cachedMessages)
        if (optimistic.thread) {
          await this.store.writeThreadList(cachedThreads)
          this.patch({ threads: cachedThreads.threads })
        }
        this.patch({
          messageCounts: {
            ...this.state.messageCounts,
            [optimistic.threadId]: cachedMessages.rows.length,
          },
        })
        throw error
      }

      // A confirmed send stays successful if the subsequent history read is
      // temporarily unavailable. The durable optimistic row remains visible.
      void this.enqueue(async () => {
        if (runId) {
          const latest = await this.store.readMessages(optimistic.threadId)
          await this.store.writeMessages(optimistic.threadId, {
            ...latest,
            rows: latest.rows.map((row) => row.id === optimistic.row.id && row.runId === null
              ? { ...row, runId }
              : row),
          })
          this.patch({ messageCounts: { ...this.state.messageCounts } })
        }
        await this.syncOneThread(optimistic.threadId)
      })
      return optimistic.threadId
    })
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
