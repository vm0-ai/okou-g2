/**
 * Optimistic send.
 *
 * `POST /api/chat/events` accepts client-generated ids so an event-sourced
 * client can show its own row immediately and reconcile later by id rather
 * than by guessing. This mirrors how the platform sends:
 *
 * - `clientThreadId` — the new thread's id, chosen by the client.
 * - `clientEventId`  — the user event's primary key.
 * - `chatThreadEventId` / `chatThreadSortEventId` — the lifecycle events that
 *   create the thread and move it to the top of the list.
 *
 * Because the ids are ours, the optimistic rows written here are the same rows
 * the server later returns; a resync overwrites them by id instead of
 * duplicating them.
 */
import type { OkouApiClient } from '../api/client'
import type { ChatEventRow, ChatThread } from '../types'
import type { SendModel } from './model'

/** `crypto.randomUUID` is available in both the WebView and the simulator. */
function uuid(): string {
  return crypto.randomUUID()
}

export interface SendTarget {
  readonly agentId: string
  /** Omitted for a new thread. */
  readonly threadId?: string
  /** Required for a new thread; replies retain the thread's saved model. */
  readonly selection?: SendModel
}

export interface OptimisticSend {
  readonly threadId: string
  readonly thread: ChatThread | null
  readonly row: ChatEventRow
  readonly body: Record<string, unknown>
}

/**
 * Build the request and the rows to show before it completes.
 *
 * Returning them together keeps the ids in the request and in the optimistic
 * state identical by construction.
 */
export function prepareSend(target: SendTarget, prompt: string): OptimisticSend {
  const isNewThread = target.threadId === undefined
  if (isNewThread && !target.selection) throw new Error('A model selection is required')
  const threadId = target.threadId ?? uuid()
  const clientEventId = uuid()
  const now = new Date().toISOString()

  const userMessage = {
    version: 1,
    parts: [{ type: 'text', text: prompt }],
  }

  const body: Record<string, unknown> = {
    agentId: target.agentId,
    prompt,
    userMessage,
    hasTextContent: true,
    clientEventId,
    ...(isNewThread ? target.selection : {}),
    ...(isNewThread
      ? {
          clientThreadId: threadId,
          chatThreadEventId: uuid(),
          chatThreadSortEventId: uuid(),
        }
      : { threadId, chatThreadSortEventId: uuid() }),
  }

  const thread: ChatThread | null = isNewThread
    ? {
        id: threadId,
        agentId: target.agentId,
        // The server generates a title later; until then the prompt is a
        // better label than "Untitled".
        title: prompt.slice(0, 60),
        sortAt: now,
        createdAt: now,
        updatedAt: now,
        pinnedAt: null,
        selectedModel: target.selection!.model,
      }
    : null

  const row: ChatEventRow = {
    id: clientEventId,
    chatThreadId: threadId,
    runId: null,
    revokesEventId: null,
    eventType: 'input.prompt',
    // Sentinel: the server assigns the real sequence. Anything positive would
    // risk colliding with a real row, and the merge is by id, so this row is
    // replaced rather than ordered against real ones.
    seqId: Number.MAX_SAFE_INTEGER,
    createdAt: now,
    payload: { userMessage },
  }

  return { threadId, thread, row, body }
}

export interface SendResult {
  readonly runId: string | null
  readonly threadId: string
}

export async function sendChatEvent(
  client: OkouApiClient,
  send: OptimisticSend,
  signal: AbortSignal,
): Promise<SendResult> {
  const response = await client.request<SendResult>({
    path: '/api/chat/events',
    method: 'POST',
    body: send.body,
    signal,
  })
  return response.body
}
