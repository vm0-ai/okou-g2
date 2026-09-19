/**
 * Glasses screen state machine.
 *
 * Three screens, driven entirely from the temple or ring touchpad:
 *
 *   threads ──click item──▶ messages ──click──▶ compose ──send──▶ messages
 *      ▲                        │                   │
 *      └──── 2x-tap ────────────┴─── 2x-tap ────────┘
 *
 * `threads` is the root page, so a double tap there exits through the system
 * confirmation dialog, which Even requires of a root page.
 *
 * The controller owns the lens only. It reads chat state through the callbacks
 * it is given, so the same sync engine drives the phone UI and the glasses
 * without either one knowing about the other.
 */
import { OsEventTypeList, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

import { startRecording, type Recorder } from './audio'
import { toLensMessages, isRunInProgress, type LensMessage } from './messages'
import {
  composePage,
  messagesPage,
  startupPage,
  threadListPage,
  THREADS_CONTAINER_ID,
} from './screens'
import type { ChatEventRow, ChatThread } from '../types'

export type LensScreen = 'threads' | 'messages' | 'compose'

export interface ControllerHooks {
  /** Threads to list, newest first. */
  listThreads(): readonly ChatThread[]
  /** Persisted rows for one thread. */
  readMessages(threadId: string): Promise<readonly ChatEventRow[]>
  /** Transcribe captured audio. Returns null when nothing was recognised. */
  transcribe(audio: Blob): Promise<string | null>
  /** Send a prompt; resolves with the thread it landed in. */
  send(prompt: string, threadId?: string): Promise<string>
  /** Surface the current screen to the phone UI. */
  onScreen?(screen: LensScreen, threadId: string | null): void
}

type ComposeStage = 'idle' | 'recording' | 'transcribing' | 'sending' | 'failed'

export class LensController {
  private screen: LensScreen = 'threads'
  private threadId: string | null = null
  private compose: ComposeStage = 'idle'
  private composeNote = ''
  private recorder: Recorder | null = null
  private unsubscribe: (() => void) | null = null
  private closed = false
  /** Guards against two renders racing a `rebuildPageContainer`. */
  private rendering: Promise<void> = Promise.resolve()

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly hooks: ControllerHooks,
  ) {}

  async start(): Promise<boolean> {
    // The startup page must exist before any rebuild, and the glasses
    // microphone refuses to start without it.
    const created = await this.bridge.createStartUpPageContainer(startupPage('Okou\nLoading...'))
    if (created !== 0) return false
    this.unsubscribe = this.bridge.onEvenHubEvent((event) => this.handle(event))
    await this.render()
    return true
  }

  close(): void {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    void this.recorder?.cancel()
    this.recorder = null
  }

  /** Re-render after chat state changed elsewhere. */
  refresh(): void {
    if (this.screen === 'compose') return
    void this.render()
  }

  private setScreen(screen: LensScreen, threadId: string | null): void {
    this.screen = screen
    this.threadId = threadId
    this.hooks.onScreen?.(screen, threadId)
  }

  private handle(event: EvenHubEvent): void {
    if (this.closed) return
    const list = event.listEvent
    const text = event.textEvent
    const sys = event.sysEvent
    const type = list?.eventType ?? text?.eventType ?? sys?.eventType

    // The SDK normalizes a zero event type to undefined on some hosts, and
    // zero is CLICK_EVENT.
    const isClick = type === OsEventTypeList.CLICK_EVENT || type === undefined
    const isDoubleClick = type === OsEventTypeList.DOUBLE_CLICK_EVENT

    if (isDoubleClick) {
      void this.onDoubleClick()
      return
    }
    if (!isClick) return

    if (this.screen === 'threads' && list?.containerID === THREADS_CONTAINER_ID) {
      void this.onThreadSelected(list.currentSelectItemIndex ?? 0)
      return
    }
    void this.onClick()
  }

  private async onDoubleClick(): Promise<void> {
    switch (this.screen) {
      case 'threads':
        // Root page: mode 1 raises the system exit confirmation.
        await this.bridge.shutDownPageContainer(1)
        return
      case 'messages':
        this.setScreen('threads', null)
        await this.render()
        return
      case 'compose':
        await this.recorder?.cancel()
        this.recorder = null
        this.compose = 'idle'
        this.composeNote = ''
        // Back to the thread it was started from, or the list for a new chat.
        this.setScreen(this.threadId ? 'messages' : 'threads', this.threadId)
        await this.render()
    }
  }

  private async onClick(): Promise<void> {
    if (this.screen === 'messages') {
      // A tap in a thread starts a new message in that same thread.
      this.setScreen('compose', this.threadId)
      await this.render()
      return
    }
    if (this.screen === 'compose') {
      await this.toggleRecording()
    }
  }

  private async onThreadSelected(index: number): Promise<void> {
    if (index === 0) {
      // Item 0 is "+ New chat", so a new thread has no id yet.
      this.setScreen('compose', null)
      this.compose = 'idle'
      this.composeNote = ''
      await this.render()
      return
    }
    const thread = this.hooks.listThreads()[index - 1]
    if (!thread) return
    this.setScreen('messages', thread.id)
    await this.render()
  }

  private async toggleRecording(): Promise<void> {
    if (this.compose === 'transcribing' || this.compose === 'sending') return

    if (this.compose !== 'recording') {
      try {
        this.recorder = await startRecording(this.bridge)
        this.compose = 'recording'
        this.composeNote = ''
      } catch (error) {
        this.compose = 'failed'
        this.composeNote = error instanceof Error ? error.message : 'Microphone failed'
      }
      await this.render()
      return
    }

    const recorder = this.recorder
    this.recorder = null
    this.compose = 'transcribing'
    await this.render()

    try {
      const audio = await recorder?.stop()
      if (!audio) {
        this.compose = 'failed'
        this.composeNote = 'Nothing recorded'
        await this.render()
        return
      }
      const transcript = await this.hooks.transcribe(audio)
      if (!transcript) {
        this.compose = 'failed'
        this.composeNote = 'Could not hear that'
        await this.render()
        return
      }

      this.compose = 'sending'
      this.composeNote = transcript
      await this.render()

      const threadId = await this.hooks.send(transcript, this.threadId ?? undefined)
      this.compose = 'idle'
      this.composeNote = ''
      this.setScreen('messages', threadId)
    } catch (error) {
      this.compose = 'failed'
      this.composeNote = error instanceof Error ? error.message : 'Send failed'
    }
    await this.render()
  }

  private composeLines(): readonly string[] {
    switch (this.compose) {
      case 'recording':
        return ['Listening...', 'Tap to send']
      case 'transcribing':
        return ['Transcribing...']
      case 'sending':
        return ['Sending...', this.composeNote]
      case 'failed':
        return [this.composeNote, 'Tap to try again']
      default:
        return [this.threadId ? 'Reply by voice' : 'New chat', 'Tap to speak']
    }
  }

  private async messageState(): Promise<{
    messages: readonly LensMessage[]
    status: string
  }> {
    if (!this.threadId) return { messages: [], status: '' }
    const rows = await this.hooks.readMessages(this.threadId)
    const messages = toLensMessages(rows)
    const status = isRunInProgress(rows)
      ? 'Thinking...'
      : messages.length === 0
        ? 'No messages yet · tap to speak'
        : 'Tap to reply · 2x-tap back'
    return { messages, status }
  }

  /** Serialized so two triggers cannot rebuild the page concurrently. */
  private render(): Promise<void> {
    this.rendering = this.rendering.then(async () => {
      if (this.closed) return
      if (this.screen === 'threads') {
        const titles = this.hooks.listThreads().map((thread) => thread.title ?? 'Untitled')
        await this.bridge.rebuildPageContainer(threadListPage(titles))
        return
      }
      if (this.screen === 'compose') {
        await this.bridge.rebuildPageContainer(composePage(this.composeLines()))
        return
      }
      const { messages, status } = await this.messageState()
      await this.bridge.rebuildPageContainer(messagesPage(messages, status))
    })
    return this.rendering
  }
}
