import { useCallback, useEffect, useState } from 'react'
import { SignedIn, SignedOut, useAuth, useOrganization, useUser } from '@clerk/clerk-react'

import ChatSyncPanel from './ChatSyncPanel'
import OrganizationGate from './OrganizationGate'
import SignInCard from './SignInCard'
import { useChatSync } from './useChatSync'
import { useLens } from './useLens'
import { describeConnection, type GlassesState } from './glasses'
import type { LensScreen } from './lens/controller'

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

const SCREEN_HELP: Record<LensScreen, string> = {
  threads: 'Scroll to a chat, tap to open. Double-tap exits.',
  messages: 'Tap to reply by voice. Double-tap goes back.',
  compose: 'Tap to start and stop speaking. Double-tap cancels.',
}

function GlassesPanel({
  state,
  screen,
  threadId,
}: {
  state: GlassesState
  screen: LensScreen
  threadId: string | null
}) {
  return (
    <section className="card">
      <h2>Glasses</h2>
      <dl>
        <dt>Bridge</dt>
        <dd>{state.phase}</dd>
        <dt>Device</dt>
        <dd>{describeConnection(state)}</dd>
        <dt>Screen</dt>
        <dd>{state.pageReady ? screen : 'idle'}</dd>
        {threadId ? (
          <>
            <dt>Open thread</dt>
            <dd className="mono">{threadId}</dd>
          </>
        ) : null}
      </dl>
      {state.error ? <p className="error">{state.error}</p> : null}
      {state.phase === 'ready' ? <p className="hint">{SCREEN_HELP[screen]}</p> : null}
      {state.phase === 'unavailable' ? (
        <p className="hint">
          Open this page from the Even App to drive the G2 display. Sign-in and sync work in any
          browser.
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

      {probe.status === 'loading' ? <p className="hint">Verifying…</p> : null}
      {probe.status === 'error' ? <p className="error">{probe.message}</p> : null}
      {probe.status === 'ok' ? (
        <p className="hint">
          Backend verified as <span className="mono">{probe.data.userId}</span>
        </p>
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

export default function App() {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const { organization } = useOrganization()
  const sync = useChatSync(organization?.id)
  const lens = useLens(sync.engine, sync.state)
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

  return (
    <main>
      <header>
        <h1>Okou for Even G2</h1>
        <p className="hint">Chat list synced to your glasses</p>
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
            <OrganizationGate>
              {(orgId) => (
                <ChatSyncPanel orgId={orgId} state={sync.state} onResync={sync.resync} />
              )}
            </OrganizationGate>
          </SignedIn>
        </>
      )}

      <GlassesPanel state={lens.glasses} screen={lens.screen} threadId={lens.threadId} />
    </main>
  )
}
