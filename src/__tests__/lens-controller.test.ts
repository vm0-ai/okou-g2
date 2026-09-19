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

import { LensController } from '../lens/controller'
import { STATUS_CONTAINER_ID, THREADS_CONTAINER_ID } from '../lens/screens'

function setup() {
  const listeners = new Set<(event: EvenHubEvent) => void>()
  const pageWaiters = new Set<{ text: string; resolve: () => void }>()
  const transcribe = vi.fn(async (_audio: Blob) => 'Hello from the glasses')
  const send = vi.fn(async (_prompt: string, _threadId?: string) => 'new-thread')
  const bridge = {
    createStartUpPageContainer: vi.fn(async () => 0),
    rebuildPageContainer: vi.fn(async (page: RebuildPageContainer) => {
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
    transcribe,
    send,
  })
  return {
    bridge,
    controller,
    transcribe,
    send,
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
      expect(app.send).toHaveBeenCalledExactlyOnceWith('Hello from the glasses', undefined)
      expect(app.bridge.audioControl).toHaveBeenCalledTimes(2)
      expect(app.bridge.audioControl).toHaveBeenLastCalledWith(false)
    } finally {
      app.controller.close()
    }
  })
})
