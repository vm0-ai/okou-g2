import { describe, expect, it } from 'vitest'

import { markdownToPlainText, truncate } from '../lens/markdown'
import { isRunInProgress, toLensMessages } from '../lens/messages'
import { prepareSend } from '../sync/send'
import type { ChatEventRow } from '../types'

function row(overrides: Partial<ChatEventRow> & Pick<ChatEventRow, 'id' | 'seqId'>): ChatEventRow {
  return {
    chatThreadId: 'thread',
    runId: null,
    revokesEventId: null,
    eventType: 'output.message',
    createdAt: '2026-01-01T00:00:00Z',
    payload: null,
    ...overrides,
  }
}

describe('markdownToPlainText', () => {
  it('keeps link text and drops the URL', () => {
    expect(markdownToPlainText('See [the docs](https://example.com) now')).toBe(
      'See the docs now',
    )
  })

  it('strips emphasis, headings and list markers', () => {
    expect(markdownToPlainText('# Title\n\n- **bold** and _italic_')).toBe(
      'Title • bold and italic',
    )
  })

  it('replaces fenced code with a marker instead of leaking the body', () => {
    const text = markdownToPlainText('Run this:\n```ts\nconst x = 1\n```\ndone')
    expect(text).toBe('Run this: [code] done')
    expect(text).not.toContain('const')
  })

  it('collapses blank lines so nothing wastes a lens row', () => {
    expect(markdownToPlainText('one\n\n\ntwo')).toBe('one two')
  })
})

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 10)).toBe('short')
  })

  it('breaks on a word boundary when one is close enough', () => {
    expect(truncate('alpha beta gamma delta', 16)).toBe('alpha beta…')
  })

  it('hard-cuts a single long token rather than returning almost nothing', () => {
    expect(truncate(`a ${'x'.repeat(40)}`, 12)).toBe('a xxxxxxxxx…')
  })
})

describe('toLensMessages', () => {
  it('keeps user and assistant text in sequence order', () => {
    const messages = toLensMessages([
      row({
        id: 'b',
        seqId: 2,
        eventType: 'output.message',
        payload: { content: '**Hi** there' },
      }),
      row({
        id: 'a',
        seqId: 1,
        eventType: 'input.prompt',
        payload: { userMessage: { version: 1, parts: [{ type: 'text', text: 'Hello' }] } },
      }),
    ])

    expect(messages).toEqual([
      { id: 'a', role: 'user', text: 'Hello', seqId: 1 },
      { id: 'b', role: 'assistant', text: 'Hi there', seqId: 2 },
    ])
  })

  it('drops an event that a later event revoked', () => {
    const messages = toLensMessages([
      row({
        id: 'old',
        seqId: 1,
        eventType: 'input.prompt',
        payload: { userMessage: { version: 1, parts: [{ type: 'text', text: 'typo' }] } },
      }),
      row({
        id: 'new',
        seqId: 2,
        eventType: 'input.prompt',
        revokesEventId: 'old',
        payload: { userMessage: { version: 1, parts: [{ type: 'text', text: 'fixed' }] } },
      }),
    ])

    expect(messages.map((message) => message.text)).toEqual(['fixed'])
  })

  it('ignores events that carry no readable text', () => {
    expect(toLensMessages([row({ id: 'u', seqId: 1, eventType: 'usage.recorded' })])).toEqual([])
  })

  it('shows the error for a failed run instead of leaving an empty conversation', () => {
    const messages = toLensMessages([row({ id: 'failed', seqId: 1, eventType: 'run.failed', runId: 'run-1', payload: { error: 'Model is unavailable' } })])
    expect(messages[0]).toMatchObject({ role: 'assistant', text: 'Model is unavailable' })
  })
})

describe('isRunInProgress', () => {
  it('shows thinking for a direct send that has a run but never entered the queue', () => {
    expect(isRunInProgress([row({ id: 'input', seqId: 1, runId: 'run-1', eventType: 'input.prompt' })])).toBe(true)
  })

  it('is true while a run has started but not finished', () => {
    expect(
      isRunInProgress([row({ id: 'q', seqId: 1, runId: 'run-1', eventType: 'run.queued' })]),
    ).toBe(true)
  })

  it('is false once the run reaches a terminal event', () => {
    expect(
      isRunInProgress([
        row({ id: 'q', seqId: 1, runId: 'run-1', eventType: 'run.queued' }),
        row({ id: 'c', seqId: 2, runId: 'run-1', eventType: 'run.completed' }),
      ]),
    ).toBe(false)
  })

  it('stays false when trailing events are appended after completion', () => {
    expect(
      isRunInProgress([
        row({ id: 'q', seqId: 1, runId: 'run-1', eventType: 'run.queued' }),
        row({ id: 'c', seqId: 2, runId: 'run-1', eventType: 'run.completed' }),
        row({ id: 'u', seqId: 3, runId: 'run-1', eventType: 'usage.recorded' }),
      ]),
    ).toBe(false)
  })

  it('tracks the newest run, not an older finished one', () => {
    expect(
      isRunInProgress([
        row({ id: 'a', seqId: 1, runId: 'run-1', eventType: 'run.queued' }),
        row({ id: 'b', seqId: 2, runId: 'run-1', eventType: 'run.completed' }),
        row({ id: 'c', seqId: 3, runId: 'run-2', eventType: 'run.queued' }),
      ]),
    ).toBe(true)
  })
})

describe('prepareSend', () => {
  it('uses one client thread id in both the request and the optimistic rows', () => {
    const send = prepareSend({ agentId: 'agent-1', selection: { model: 'gpt-6-astra' } }, 'Hello there')

    expect(send.body.clientThreadId).toBe(send.threadId)
    expect(send.thread?.id).toBe(send.threadId)
    expect(send.row.chatThreadId).toBe(send.threadId)
    expect(send.row.id).toBe(send.body.clientEventId)
    expect(send.body.threadId).toBeUndefined()
    expect(send.body.chatThreadEventId).toEqual(expect.any(String))
  })

  it('targets an existing thread without inventing a new one', () => {
    const send = prepareSend({ agentId: 'agent-1', threadId: 'thread-9' }, 'Follow up')

    expect(send.threadId).toBe('thread-9')
    expect(send.thread).toBeNull()
    expect(send.body.threadId).toBe('thread-9')
    expect(send.body.clientThreadId).toBeUndefined()
  })

  it('carries the prompt as a text part the API accepts', () => {
    const send = prepareSend({ agentId: 'agent-1', selection: { model: 'gpt-6-astra' } }, 'Ship it')

    expect(send.body.userMessage).toEqual({
      version: 1,
      parts: [{ type: 'text', text: 'Ship it' }],
    })
    expect(send.body.hasTextContent).toBe(true)
  })
})
