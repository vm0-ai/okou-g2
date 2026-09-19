import { useCallback, useEffect, useRef, useState } from 'react'
import { SignedIn, SignedOut, useAuth, useUser } from '@clerk/clerk-react'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

import SignInCard from './SignInCard'
import {
  connectBridge,
  createStatusPage,
  describeConnection,
  exitApp,
  initialGlassesState,
  onDeviceStatus,
  onStatusPageInput,
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
  | { status: 'ok'; data: AuthProbe }
  | { status: 'error'; message: string }

function GlassesPanel({ state }: { state: GlassesState }) {
  return (
    <section className="card">
      <h2>Glasses</h2>
      <dl>
        <dt>Bridge</dt>
        <dd>{state.phase}</dd>
        <dt>Device</dt>
        <dd>{describeConnection(state)}</dd>
        <dt>Display</dt>
        <dd>{state.pageReady ? 'status page active' : 'idle'}</dd>
      </dl>
      {state.error ? <p className="error">{state.error}</p> : null}
      {state.phase === 'ready' ? (
        <p className="hint">Tap a temple to re-check. Double-tap to exit.</p>
      ) : null}
      {state.phase === 'unavailable' ? (
        <p className="hint">
          Open this page from the Even App to drive the G2 display. Sign-in works in any browser.
        </p>
      ) : null}
    </section>
  )
}

function AccountPanel({ probe, onRecheck }: { probe: ProbeState; onRecheck: () => void }) {
  const { signOut } = useAuth()
  const { user } = useUser()

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

      <button type="button" onClick={onRecheck} disabled={probe.status === 'loading'}>
        Re-check
      </button>
      <button type="button" className="link" onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  )
}

/** What the lens shows, at most four short lines. */
function lensText(
  isLoaded: boolean,
  isSignedIn: boolean | undefined,
  email: string | undefined,
  probe: ProbeState,
): string {
  if (!isLoaded) return 'Okou\nStarting...'
  if (!isSignedIn) return 'Okou\nSign in on your phone'

  const who = email ?? 'signed in'
  switch (probe.status) {
    case 'ok':
      return `Okou\n${who}\nBackend verified\nTap re-check / 2x-tap exit`
    case 'loading':
      return `Okou\n${who}\nChecking...`
    case 'error':
      return `Okou\n${who}\nCheck failed\n${probe.message}`
    default:
      return `Okou\n${who}`
  }
}

export default function App() {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const { user } = useUser()
  const [glasses, setGlasses] = useState<GlassesState>(initialGlassesState)
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  const bridgeRef = useRef<EvenAppBridge | null>(null)

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
      setProbe({ status: 'ok', data: body })
    } catch (caught) {
      setProbe({
        status: 'error',
        message: caught instanceof Error ? caught.message : 'Probe failed',
      })
    }
  }, [getToken])

  useEffect(() => {
    if (!isLoaded) return
    if (!isSignedIn) {
      setProbe({ status: 'idle' })
      return
    }
    void runProbe()
  }, [isLoaded, isSignedIn, runProbe])

  // Attach to the Even App bridge once, then mirror device status and temple
  // input into React. `runProbeRef` keeps the input subscription stable while
  // still calling the current probe.
  const runProbeRef = useRef(runProbe)
  runProbeRef.current = runProbe

  useEffect(() => {
    let disposed = false
    const cleanups: (() => void)[] = []

    void (async () => {
      const bridge = await connectBridge()
      if (disposed) return
      if (!bridge) {
        setGlasses((previous) => ({ ...previous, phase: 'unavailable' }))
        return
      }
      bridgeRef.current = bridge
      setGlasses((previous) => ({ ...previous, phase: 'ready' }))

      cleanups.push(
        onDeviceStatus(bridge, (status) => {
          setGlasses((previous) => ({
            ...previous,
            connectType: status.connectType,
            batteryLevel: status.batteryLevel,
            isWearing: status.isWearing,
          }))
        }),
      )
      cleanups.push(
        onStatusPageInput(bridge, {
          onTap: () => void runProbeRef.current(),
          onDoubleTap: () => void exitApp(bridge),
        }),
      )
    })()

    return () => {
      disposed = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [])

  // Keep the lens showing the current auth state. The startup page is created
  // once, then updated in place.
  const text = lensText(isLoaded, isSignedIn, user?.primaryEmailAddress?.emailAddress, probe)

  useEffect(() => {
    const bridge = bridgeRef.current
    if (glasses.phase !== 'ready' || !bridge) return
    let disposed = false

    void (async () => {
      try {
        if (!glasses.pageReady) {
          const created = await createStatusPage(bridge, text)
          if (disposed) return
          setGlasses((previous) => ({
            ...previous,
            pageReady: created,
            error: created ? undefined : 'Could not create the G2 page.',
          }))
          return
        }
        await updateStatusText(bridge, text)
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
  }, [glasses.phase, glasses.pageReady, text])

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
            <AccountPanel probe={probe} onRecheck={() => void runProbe()} />
          </SignedIn>
        </>
      )}

      <GlassesPanel state={glasses} />
    </main>
  )
}
