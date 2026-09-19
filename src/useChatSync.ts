import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'

import { createBrowserStore, createEvenStore, type KeyValueStore } from './store/even-kv'
import { connectBridge } from './glasses'
import { initialSyncState, SyncEngine, type SyncState } from './sync/engine'

/**
 * Pick the durable store once.
 *
 * Inside the Even App this is the host's own persistence, which is what
 * survives an Android WebView suspend. In a plain browser it falls back to
 * `localStorage` so the sync layer is exercisable without glasses.
 */
async function resolveStore(): Promise<KeyValueStore> {
  const bridge = await connectBridge()
  return bridge ? createEvenStore(bridge) : createBrowserStore()
}

export interface ChatSync {
  readonly state: SyncState
  readonly engine: SyncEngine | null
  resync(): void
}

/**
 * Run one sync engine for the current Clerk user and organization.
 *
 * The engine is recreated when either identity changes, because the persisted
 * namespace is keyed by both. `orgId` being absent is a real state: the Okou
 * chat APIs require an organization, so there is nothing to sync until Clerk
 * has an active one.
 */
export function useChatSync(orgId: string | null | undefined): ChatSync {
  const { isSignedIn, userId, getToken } = useAuth()
  const [state, setState] = useState<SyncState>(initialSyncState)
  const engineRef = useRef<SyncEngine | null>(null)
  // Keeps the engine's token provider current without restarting the engine.
  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken

  useEffect(() => {
    if (!isSignedIn || !userId || !orgId) {
      setState(initialSyncState)
      return
    }

    let disposed = false
    let engine: SyncEngine | null = null

    void (async () => {
      const kv = await resolveStore()
      if (disposed) return
      engine = new SyncEngine(
        kv,
        { userId, orgId },
        () => getTokenRef.current(),
        (next) => {
          if (!disposed) setState(next)
        },
      )
      engineRef.current = engine
      await engine.start()
    })()

    return () => {
      disposed = true
      engineRef.current = null
      void engine?.close()
    }
  }, [isSignedIn, userId, orgId])

  return {
    state,
    engine: engineRef.current,
    resync: () => void engineRef.current?.syncAll(),
  }
}
