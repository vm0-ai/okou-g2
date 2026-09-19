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
  listStatus?(): string | null
  /** Persisted rows for one thread. */
  readMessages(threadId: string): Promise<readonly ChatEventRow[]>
  /** Fetch history when a thread is opened, including an uncached thread. */
  syncMessages(threadId: string): Promise<void>
  /** Transcribe captured audio. Returns null when nothing was recognised. */
  transcribe(audio: Blob): Promise<string | null>
  /** Send a prompt; resolves with the thread it landed in. */
  send(prompt: string, threadId?: string, onOptimistic?: (threadId: string) => void): Promise<string>
  /** Surface the current screen to the phone UI. */
  onScreen?(screen: LensScreen, threadId: string | null): void
  onError?(message: string | null): void
}

type ComposeStage = 'idle' | 'recording' | 'transcribing' | 'sending' | 'failed'

export class LensController {
  private screen: LensScreen = 'threads'
  private threadId: string | null = null
  private compose: ComposeStage = 'idle'
  private composeNote = ''
  private transcript = ''
  private messageLoading = false
  private messageError: string | null = null
  private sending = false
  private operationVersion = 0
  private historyVersion = 0
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
    this.operationVersion += 1
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
    // Audio frames share this callback but have no gesture payload. Only a
    // gesture payload may use the missing-eventType fallback for a tap.
    if (!list && !text && !sys) return
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
    this.operationVersion += 1
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
        this.transcript = ''
        // Back to the thread it was started from, or the list for a new chat.
        this.setScreen(this.threadId ? 'messages' : 'threads', this.threadId)
        await this.render()
    }
  }

  private async onClick(): Promise<void> {
    if (this.screen === 'messages') {
      if (this.sending) return
      if (this.messageError && this.threadId) {
        await this.openThread(this.threadId)
        return
      }
      // A tap in a thread starts a new message in that same thread.
      this.setScreen('compose', this.threadId)
      this.compose = 'idle'
      this.composeNote = ''
      this.transcript = ''
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
      this.transcript = ''
      await this.render()
      return
    }
    const thread = this.hooks.listThreads()[index - 1]
    if (!thread) return
    await this.openThread(thread.id)
  }

  private async openThread(threadId: string): Promise<void> {
    const version = ++this.historyVersion
    this.messageLoading = true
    this.messageError = null
    this.hooks.onError?.(null)
    this.setScreen('messages', threadId)
    await this.render()
    try {
      await this.hooks.syncMessages(threadId)
    } catch (error) {
      if (this.closed || version !== this.historyVersion || this.threadId !== threadId) return
      this.messageError = error instanceof Error ? error.message : 'Could not load messages'
      this.hooks.onError?.(this.messageError)
    }
    if (this.closed || version !== this.historyVersion || this.threadId !== threadId) return
    this.messageLoading = false
    await this.render()
  }

  private async toggleRecording(): Promise<void> {
    if (this.compose === 'transcribing' || this.compose === 'sending') return
    if (this.compose === 'failed' && this.transcript) {
      await this.sendTranscript(this.transcript)
      return
    }

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
    const version = this.operationVersion
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
      if (this.closed || version !== this.operationVersion) return
      if (!transcript) {
        this.compose = 'failed'
        this.composeNote = 'Could not hear that'
        await this.render()
        return
      }

      await this.sendTranscript(transcript)
    } catch (error) {
      if (this.closed || version !== this.operationVersion) return
      this.compose = 'failed'
      this.composeNote = error instanceof Error ? error.message : 'Send failed'
      this.hooks.onError?.(this.composeNote)
    }
    await this.render()
  }

  private async sendTranscript(transcript: string): Promise<void> {
    const version = this.operationVersion
    const target = this.threadId
    this.transcript = transcript
    this.compose = 'sending'
    this.composeNote = transcript
    this.sending = true
    this.hooks.onError?.(null)
    await this.render()
    try {
      const threadId = await this.hooks.send(transcript, target ?? undefined, (id) => {
        if (this.closed || version !== this.operationVersion) return
        this.messageLoading = false
        this.messageError = null
        this.setScreen('messages', id)
        void this.render()
      })
      if (this.closed || version !== this.operationVersion) return
      this.compose = 'idle'
      this.composeNote = ''
      this.transcript = ''
      this.setScreen('messages', threadId)
    } catch (error) {
      if (this.closed || version !== this.operationVersion) return
      this.compose = 'failed'
      this.composeNote = error instanceof Error ? error.message : 'Send failed'
      this.setScreen('compose', target)
      this.hooks.onError?.(this.composeNote)
    } finally {
      this.sending = false
    }
    if (!this.closed && version === this.operationVersion) await this.render()
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
        return [this.composeNote, this.transcript ? 'Tap to retry sending' : 'Tap to try again']
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
    let status = messages.length === 0 ? 'No messages yet · tap to speak' : 'Tap to reply · 2x-tap back'
    if (isRunInProgress(rows)) status = 'Thinking...'
    if (this.sending) status = 'Sending...'
    if (this.messageLoading) status = 'Loading messages...'
    if (this.messageError) status = 'Could not load messages · tap to retry'
    return { messages, status }
  }

  /** Serialized so two triggers cannot rebuild the page concurrently. */
  private render(): Promise<void> {
    const operation = this.rendering.then(async () => {
      if (this.closed) return
      let page
      if (this.screen === 'threads') {
        const titles = this.hooks.listThreads().map((thread) => thread.title ?? 'Untitled')
        page = threadListPage(titles, this.hooks.listStatus?.())
      } else if (this.screen === 'compose') {
        page = composePage(this.composeLines())
      } else {
        const threadId = this.threadId
        const { messages, status } = await this.messageState()
        if (this.closed || this.screen !== 'messages' || this.threadId !== threadId) return
        page = messagesPage(messages, status)
      }
      const ok = await this.bridge.rebuildPageContainer(page)
      if (!ok) throw new Error('The glasses could not display this page')
    })
    // One failed storage read or native rebuild must not poison every future
    // render, including returning to the list or retrying a send.
    this.rendering = operation.catch((error: unknown) => {
      this.hooks.onError?.(error instanceof Error ? error.message : 'Display failed')
    })
    return this.rendering
  }
}
