import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'

import { transcribeAudio } from './api/stt'
import { connectBridge, onDeviceStatus } from './glasses'
import { LensController, type LensScreen } from './lens/controller'
import type { SyncEngine, SyncState } from './sync/engine'
import type { GlassesState } from './glasses'
import { initialGlassesState } from './glasses'

export interface LensStatus {
  readonly glasses: GlassesState
  readonly screen: LensScreen
  readonly threadId: string | null
}

/**
 * Drive the glasses from the sync engine.
 *
 * The controller is created once the bridge and the engine are both available,
 * and torn down when either goes away. Chat state is read through callbacks so
 * the controller never holds a stale snapshot: every render asks for current
 * data.
 */
export function useLens(engine: SyncEngine | null, sync: SyncState): LensStatus {
  const { getToken, isSignedIn } = useAuth()
  const [glasses, setGlasses] = useState<GlassesState>(initialGlassesState)
  const [screen, setScreen] = useState<LensScreen>('threads')
  const [threadId, setThreadId] = useState<string | null>(null)
  const controllerRef = useRef<LensController | null>(null)

  // Refs keep the controller's callbacks pointing at current values without
  // rebuilding the controller on every render.
  const engineRef = useRef(engine)
  engineRef.current = engine
  const threadsRef = useRef(sync.threads)
  threadsRef.current = sync.threads
  const listStatusRef = useRef<string | null>(null)
  listStatusRef.current = !isSignedIn
    ? 'Sign in on your phone'
    : !engine
      ? 'Choose an organization on your phone'
      : sync.error
        ? 'Chat sync failed · check phone'
        : sync.syncing
          ? 'Syncing chats...'
          : `${sync.threads.length} chats · tap to open`
  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken

  useEffect(() => {
    let disposed = false
    let statusCleanup: (() => void) | undefined
    let controller: LensController | null = null

    void (async () => {
      const bridge = await connectBridge()
      if (disposed) return
      if (!bridge) {
        setGlasses((previous) => ({ ...previous, phase: 'unavailable' }))
        return
      }
      setGlasses((previous) => ({ ...previous, phase: 'ready' }))
      statusCleanup = onDeviceStatus(bridge, (status) => {
        setGlasses((previous) => ({
          ...previous,
          connectType: status.connectType,
          batteryLevel: status.batteryLevel,
          isWearing: status.isWearing,
        }))
      })

      controller = new LensController(bridge, {
        listThreads: () => threadsRef.current,
        listStatus: () => listStatusRef.current,
        readMessages: (id) => engineRef.current?.readMessages(id) ?? Promise.resolve([]),
        syncMessages: (id) => {
          const active = engineRef.current
          if (!active) throw new Error('Chat sync is not ready')
          return active.syncMessages(id)
        },
        transcribe: (audio) => transcribeAudio(() => getTokenRef.current(), audio),
        send: (prompt, id, onOptimistic) => {
          const active = engineRef.current
          if (!active) throw new Error('Chat sync is not ready')
          return active.send(prompt, id, onOptimistic)
        },
        onScreen: (next, id) => {
          if (disposed) return
          setScreen(next)
          setThreadId(id)
        },
        onError: (message) => {
          if (!disposed) setGlasses((previous) => ({ ...previous, error: message ?? undefined }))
        },
      })

      const started = await controller.start()
      if (disposed) {
        controller.close()
        return
      }
      if (!started) {
        setGlasses((previous) => ({ ...previous, error: 'Could not create the G2 page.' }))
        return
      }
      controllerRef.current = controller
      // Sync can finish while the startup page is awaiting its native ack.
      // Replay the latest state after installing the controller ref.
      controller.refresh()
      setGlasses((previous) => ({ ...previous, pageReady: true }))
    })()

    return () => {
      disposed = true
      statusCleanup?.()
      controller?.close()
      controllerRef.current = null
    }
  }, [])

  // Any change to the synced data redraws whichever screen is showing.
  useEffect(() => {
    controllerRef.current?.refresh()
  }, [sync.threads, sync.messageCounts, sync.syncing, sync.error, engine, isSignedIn])

  return { glasses, screen, threadId }
}
