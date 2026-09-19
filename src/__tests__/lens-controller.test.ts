import { describe, expect, it, vi } from 'vitest'
import {
  AudioEvent,
  List_ItemEvent,
  OsEventTypeList,
  Text_ItemEvent,
  type EvenAppBridge,
  type EvenHubEvent,
  type RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'

import { LensController, type ControllerHooks } from '../lens/controller'
import { STATUS_CONTAINER_ID, THREADS_CONTAINER_ID } from '../lens/screens'
import type { ChatEventRow, ChatThread } from '../types'

function setup(hooks: Partial<ControllerHooks> = {}) {
  const listeners = new Set<(event: EvenHubEvent) => void>()
  const pageWaiters = new Set<{ text: string; resolve: () => void }>()
  const transcribe = vi.fn(async (_audio: Blob) => 'Hello from the glasses')
  const send = vi.fn(async (_prompt: string, _threadId?: string) => 'new-thread')
  const onError = vi.fn()
  const onScreen = vi.fn()
  const pages: RebuildPageContainer[] = []
  const bridge = {
    createStartUpPageContainer: vi.fn(async () => 0),
    rebuildPageContainer: vi.fn(async (page: RebuildPageContainer) => {
      pages.push(page)
      const content = page.textObject?.map((item) => item.content).join('\n') ?? ''
      for (const waiter of pageWaiters) {
        if (content.includes(waiter.text)) {
          pageWaiters.delete(waiter)
          waiter.resolve()
        }
      }
      return true
    }),
    audioControl: vi.fn(async () => true),
    shutDownPageContainer: vi.fn(async () => true),
    onEvenHubEvent: (callback: (event: EvenHubEvent) => void) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
  }
  const controller = new LensController(bridge as unknown as EvenAppBridge, {
    listThreads: () => [],
    readMessages: async () => [],
    syncMessages: async () => undefined,
    transcribe,
    send,
    onError,
    onScreen,
    ...hooks,
  })
  return {
    bridge,
    controller,
    transcribe,
    send,
    onError,
    onScreen,
    pages,
    emit(event: EvenHubEvent) {
      for (const callback of [...listeners]) callback(event)
    },
    pageContaining(text: string) {
      return new Promise<void>((resolve) => { pageWaiters.add({ text, resolve }) })
    },
  }
}

const newChat = {
  listEvent: new List_ItemEvent({
    containerID: THREADS_CONTAINER_ID,
    currentSelectItemIndex: 0,
    eventType: OsEventTypeList.CLICK_EVENT,
  }),
}

describe('LensController event routing', () => {
  it.each([
    ['audio frame', { audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1, 0]) }) }],
    ['empty SDK event', {}],
  ] as const)('does not treat an %s as a tap to record', async (_name, event) => {
    const app = setup()
    try {
      await app.controller.start()
      const compose = app.pageContaining('New chat')
      app.emit(newChat)
      await compose

      app.emit(event)

      expect(app.bridge.audioControl).not.toHaveBeenCalled()
      expect(app.transcribe).not.toHaveBeenCalled()
      expect(app.send).not.toHaveBeenCalled()
    } finally {
      app.controller.close()
    }
  })

  it('accepts a tap without eventType and sends the captured PCM on the next tap', async () => {
    const app = setup()
    try {
      await app.controller.start()
      const compose = app.pageContaining('New chat')
      app.emit(newChat)
      await compose

      const listening = app.pageContaining('Listening...')
      app.emit({ textEvent: new Text_ItemEvent({ containerID: STATUS_CONTAINER_ID }) })
      await listening
      app.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1, 0, 2, 0]) }) })
      app.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([3, 0, 4, 0]) }) })

      const messages = app.pageContaining('No messages yet')
      app.emit({
        textEvent: new Text_ItemEvent({
          containerID: STATUS_CONTAINER_ID,
          eventType: OsEventTypeList.CLICK_EVENT,
        }),
      })
      await messages

      expect(app.transcribe).toHaveBeenCalledTimes(1)
      const audio = app.transcribe.mock.calls[0]![0]
      expect(audio.type).toBe('audio/wav')
      expect(new Uint8Array(await audio.arrayBuffer()).slice(44)).toEqual(
        new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]),
      )
      expect(app.send).toHaveBeenCalledExactlyOnceWith('Hello from the glasses', undefined, expect.any(Function))
      expect(app.bridge.audioControl).toHaveBeenCalledTimes(2)
      expect(app.bridge.audioControl).toHaveBeenLastCalledWith(false)
    } finally {
      app.controller.close()
    }
  })
})

const existingThread: ChatThread = {
  id: 'existing-thread', agentId: 'agent', title: 'History', pinnedAt: null,
  sortAt: '2026-09-19T12:00:00Z', createdAt: '2026-09-19T12:00:00Z', updatedAt: '2026-09-19T12:00:00Z',
}

const historyRow: ChatEventRow = {
  id: 'old-answer', chatThreadId: existingThread.id, seqId: 2, runId: 'old-run',
  revokesEventId: null, createdAt: existingThread.createdAt,
  eventType: 'output.message', payload: { content: '**Earlier answer**' },
}

function selectExisting() {
  return { listEvent: new List_ItemEvent({
    containerID: THREADS_CONTAINER_ID, currentSelectItemIndex: 1,
    eventType: OsEventTypeList.CLICK_EVENT,
  }) }
}

function tap() {
  return { textEvent: new Text_ItemEvent({ containerID: STATUS_CONTAINER_ID, eventType: OsEventTypeList.CLICK_EVENT }) }
}

async function recordPrompt(app: ReturnType<typeof setup>) {
  const compose = app.pageContaining('New chat')
  app.emit(newChat)
  await compose
  const listening = app.pageContaining('Listening...')
  app.emit(tap())
  await listening
  app.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1, 0, 2, 0]) }) })
}

describe('LensController history and send results', () => {
  it('shows loading until an opened conversation has fetched its missing history', async () => {
    let release!: () => void
    const fetched = new Promise<void>((resolve) => { release = resolve })
    let rows: readonly ChatEventRow[] = []
    const syncMessages = vi.fn(async () => {
      await fetched
      rows = [historyRow]
    })
    const app = setup({ listThreads: () => [existingThread], readMessages: async () => rows, syncMessages })
    try {
      await app.controller.start()
      const loading = app.pageContaining('Loading messages...')
      app.emit(selectExisting())
      await loading
      expect(app.pages.flatMap((page) => page.textObject ?? []).map((item) => item.content).join('\n'))
        .not.toContain('No messages yet')

      const history = app.pageContaining('Earlier answer')
      release()
      await history
      expect(syncMessages).toHaveBeenCalledExactlyOnceWith(existingThread.id)
    } finally {
      app.controller.close()
    }
  })

  it('shows a history error and retries the read on a tap', async () => {
    let rows: readonly ChatEventRow[] = []
    const syncMessages = vi.fn(async () => { rows = [historyRow] })
      .mockRejectedValueOnce(new Error('History service unavailable'))
    const app = setup({ listThreads: () => [existingThread], readMessages: async () => rows, syncMessages })
    try {
      await app.controller.start()
      const failed = app.pageContaining('Could not load messages')
      app.emit(selectExisting())
      await failed
      expect(app.onError).toHaveBeenLastCalledWith('History service unavailable')

      const history = app.pageContaining('Earlier answer')
      app.emit(tap())
      await history
      expect(syncMessages).toHaveBeenCalledTimes(2)
      expect(app.bridge.audioControl).not.toHaveBeenCalled()
    } finally {
      app.controller.close()
    }
  })

  it('keeps a rejected voice send on the compose screen and retries the same transcript', async () => {
    const app = setup()
    app.send.mockRejectedValueOnce(new Error('A model selection is required'))
    try {
      await app.controller.start()
      await recordPrompt(app)
      const failed = app.pageContaining('Tap to retry sending')
      app.emit(tap())
      await failed
      expect(app.onScreen).toHaveBeenLastCalledWith('compose', null)
      expect(app.onError).toHaveBeenLastCalledWith('A model selection is required')

      const messages = app.pageContaining('No messages yet')
      app.emit(tap())
      await messages
      expect(app.send).toHaveBeenCalledTimes(2)
      expect(app.transcribe).toHaveBeenCalledTimes(1)
      expect(app.bridge.audioControl).toHaveBeenCalledTimes(2)
      expect(app.send.mock.calls.map(([prompt]) => prompt)).toEqual(['Hello from the glasses', 'Hello from the glasses'])
    } finally {
      app.controller.close()
    }
  })
})
