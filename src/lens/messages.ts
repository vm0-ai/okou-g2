/**
 * Projects raw chat event rows into what the lens shows.
 *
 * The rows are the same append-only events the platform renders, so the
 * projection has to decide which of them are worth a line on a 576×288 display
 * and whether a run is still working.
 */
import { markdownToPlainText } from './markdown'
import type { ChatEventRow } from '../types'

export type LensRole = 'user' | 'assistant'

export interface LensMessage {
  readonly id: string
  readonly role: LensRole
  readonly text: string
  readonly seqId: number
}

/** Event types that carry text a person actually wants to read. */
const USER_TYPES = new Set(['input.prompt', 'input.rejected'])
const ASSISTANT_TYPES = new Set(['output.message', 'output.error'])

/** A run is working between these and its terminal event. */
const RUN_STARTED = new Set(['run.queued', 'run.dequeued'])
const RUN_FINISHED = new Set(['run.completed', 'run.failed', 'run.cancelled'])

/**
 * Pull readable text out of a row.
 *
 * `input.prompt` rows carry a structured `userMessage` document; assistant rows
 * carry `content`. Both are reduced to plain text because the lens cannot
 * render Markdown.
 */
function rowText(row: ChatEventRow): string | null {
  const payload = row.payload
  if (!payload) return null

  if (typeof payload.content === 'string' && payload.content.length > 0) {
    return markdownToPlainText(payload.content)
  }

  const document = payload.userMessage as
    | { parts?: readonly { type?: string; text?: string }[] }
    | undefined
  const parts = document?.parts
  if (!Array.isArray(parts)) return null
  const text = parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join(' ')
  return text.length > 0 ? markdownToPlainText(text) : null
}

/**
 * Oldest first, newest last — the reading order on screen.
 *
 * Revoked events are dropped: an `input.prompt` the user replaced should not
 * linger on the lens next to its replacement.
 */
export function toLensMessages(rows: readonly ChatEventRow[]): readonly LensMessage[] {
  const revoked = new Set(
    rows.map((row) => row.revokesEventId).filter((id): id is string => id !== null),
  )

  const messages: LensMessage[] = []
  for (const row of [...rows].sort((left, right) => left.seqId - right.seqId)) {
    if (revoked.has(row.id)) continue
    const role: LensRole | null = USER_TYPES.has(row.eventType)
      ? 'user'
      : ASSISTANT_TYPES.has(row.eventType)
        ? 'assistant'
        : null
    if (!role) continue
    const text = rowText(row)
    if (!text) continue
    messages.push({ id: row.id, role, text, seqId: row.seqId })
  }
  return messages
}

/**
 * Whether the newest run is still working.
 *
 * Decided per run rather than from the last row alone, because usage and
 * followup events are appended after a run has already finished.
 */
export function isRunInProgress(rows: readonly ChatEventRow[]): boolean {
  const latestByRun = new Map<string, { started: boolean; finished: boolean; seqId: number }>()

  for (const row of rows) {
    if (row.runId === null) continue
    const entry = latestByRun.get(row.runId) ?? {
      started: false,
      finished: false,
      seqId: row.seqId,
    }
    if (RUN_STARTED.has(row.eventType)) entry.started = true
    if (RUN_FINISHED.has(row.eventType)) entry.finished = true
    entry.seqId = Math.max(entry.seqId, row.seqId)
    latestByRun.set(row.runId, entry)
  }

  let newest: { started: boolean; finished: boolean; seqId: number } | null = null
  for (const entry of latestByRun.values()) {
    if (!newest || entry.seqId > newest.seqId) newest = entry
  }
  return newest !== null && newest.started && !newest.finished
}
