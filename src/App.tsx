import { useCallback, useEffect, useRef, useState } from 'react'
import { SignedIn, SignedOut, useAuth, useUser } from '@clerk/clerk-react'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

import SignInCard from './SignInCard'
import {
  connectBridge,
  createStatusPage,
  describeConnection,
  initialGlassesState,
  onDeviceStatus,
  updateStatusText,
  type GlassesState,
} from './glasses'

interface AuthProbe {
  userId: string
  sessionId: string | null
  orgId: string | null
  expiresAt: number | null
  threadBound: boolean
}

type ProbeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: AuthProbe; at: number }
  | { status: 'error'; message: string; at: number }

function GlassesPanel({ state }: { state: GlassesState }) {
  return (
    <section className="card">
      <h2>Glasses</h2>
      <dl>
        <dt>Bridge</dt>
        <dd>{state.available ? 'connected' : 'not detected'}</dd>
        <dt>Device</dt>
        <dd>{describeConnection(state)}</dd>
        <dt>Display</dt>
        <dd>{state.pageReady ? 'status page active' : 'idle'}</dd>
      </dl>
      {state.error ? <p className="error">{state.error}</p> : null}
      {!state.available ? (
        <p className="hint">
          Open this page from the Even App to drive the G2 display. Sign-in works in any browser.
        </p>
      ) : null}
    </section>
  )
}

function AccountPanel() {
  const { getToken, signOut } = useAuth()
  const { user } = useUser()
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })

  const runProbe = useCallback(async () => {
    setProbe({ status: 'loading' })
    try {
      // Clerk session tokens are short-lived; always mint a fresh one per call
      // instead of caching it in the app.
      const token = await getToken()
      if (!token) throw new Error('No active Clerk session token.')
      const response = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = (await response.json()) as AuthProbe & { error?: string }
      if (!response.ok) {
        throw new Error(`${response.status} ${body.error ?? 'request failed'}`)
      }
      setProbe({ status: 'ok', data: body, at: Date.now() })
    } catch (caught) {
      setProbe({
        status: 'error',
        message: caught instanceof Error ? caught.message : 'Probe failed',
        at: Date.now(),
      })
    }
  }, [getToken])

  useEffect(() => {
    void runProbe()
  }, [runProbe])

  return (
    <section className="card">
      <h2>Account</h2>
      <dl>
        <dt>Email</dt>
        <dd>{user?.primaryEmailAddress?.emailAddress ?? '—'}</dd>
        <dt>Clerk user</dt>
        <dd className="mono">{user?.id ?? '—'}</dd>
      </dl>

      <h3>Backend check</h3>
      {probe.status === 'loading' ? <p className="hint">Verifying…</p> : null}
      {probe.status === 'error' ? <p className="error">{probe.message}</p> : null}
      {probe.status === 'ok' ? (
        <dl>
          <dt>Verified user</dt>
          <dd className="mono">{probe.data.userId}</dd>
          <dt>Session</dt>
          <dd className="mono">{probe.data.sessionId ?? '—'}</dd>
          <dt>Fixed thread</dt>
          <dd>{probe.data.threadBound ? 'bound' : 'not bound yet'}</dd>
        </dl>
      ) : null}

      <button type="button" onClick={() => void runProbe()} disabled={probe.status === 'loading'}>
        Re-check
      </button>
      <button type="button" className="link" onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  )
}

export default function App() {
  const { isLoaded, isSignedIn } = useAuth()
  const { user } = useUser()
  const [glasses, setGlasses] = useState<GlassesState>(initialGlassesState)
  const bridgeRef = useRef<EvenAppBridge | null>(null)

  // Attach to the Even App bridge once and mirror device status into React.
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined

    void (async () => {
      const bridge = await connectBridge()
      if (disposed || !bridge) return
      bridgeRef.current = bridge
      setGlasses((previous) => ({ ...previous, available: true }))
      unsubscribe = onDeviceStatus(bridge, (status) => {
        setGlasses((previous) => ({
          ...previous,
          connectType: status.connectType,
          batteryLevel: status.batteryLevel,
          isWearing: status.isWearing,
        }))
      })
    })()

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  // Keep the lens showing the current auth state. The startup page is created
  // once, then updated in place.
  const lensText = !isLoaded
    ? 'Okou\nStarting…'
    : isSignedIn
      ? `Okou\nSigned in\n${user?.primaryEmailAddress?.emailAddress ?? ''}`
      : 'Okou\nSign in on your phone'

  useEffect(() => {
    const bridge = bridgeRef.current
    if (!glasses.available || !bridge) return
    let disposed = false

    void (async () => {
      try {
        if (!glasses.pageReady) {
          const created = await createStatusPage(bridge, lensText)
          if (disposed) return
          setGlasses((previous) => ({ ...previous, pageReady: created, error: undefined }))
          if (!created) {
            setGlasses((previous) => ({ ...previous, error: 'Could not create the G2 page.' }))
          }
          return
        }
        await updateStatusText(bridge, lensText)
      } catch (caught) {
        if (disposed) return
        setGlasses((previous) => ({
          ...previous,
          error: caught instanceof Error ? caught.message : 'Glasses update failed',
        }))
      }
    })()

    return () => {
      disposed = true
    }
  }, [glasses.available, glasses.pageReady, lensText])

  return (
    <main>
      <header>
        <h1>Okou for Even G2</h1>
        <p className="hint">Phase 1 — authentication probe</p>
      </header>

      {!isLoaded ? (
        <section className="card">
          <p className="hint">Loading…</p>
        </section>
      ) : (
        <>
          <SignedOut>
            <SignInCard />
          </SignedOut>
          <SignedIn>
            <AccountPanel />
          </SignedIn>
        </>
      )}

      <GlassesPanel state={glasses} />
    </main>
  )
}
