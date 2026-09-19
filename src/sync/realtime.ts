/**
 * Ably connection for push invalidation.
 *
 * Subscribes to exactly one channel, `user-org:<userId>:<orgId>`, and only to
 * the two topics that drive this client:
 *
 * - `threadListChanged`                  → the thread list changed shape
 * - `chatThreadMessageCreated:<threadId>` → that thread has new rows
 *
 * Payloads are treated as notifications, not data: the server stays
 * authoritative and every delivery triggers a fetch. `run-output` is
 * deliberately not subscribed — this client does not render streaming output.
 */
import * as Ably from 'ably'

import { API_BASE_URL } from '../config'
import type { TokenProvider } from '../api/client'
import type { Identity } from '../store/chat-store'

export type RealtimeSignal =
  | { readonly kind: 'thread-list' }
  | { readonly kind: 'thread-messages'; readonly threadId: string }

export type RealtimeStatus =
  | 'initialized'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'suspended'
  | 'closing'
  | 'closed'
  | 'failed'

const MESSAGE_TOPIC_PREFIX = 'chatThreadMessageCreated:'

/**
 * Every host the Ably SDK may contact, for the `app.json` network whitelist.
 *
 * Even Hub's whitelist has no wildcard support, so the manifest has to name
 * each host. These are the SDK defaults for the `main` endpoint: overriding
 * them would only add a second place to keep in sync.
 */
export const ABLY_HOSTS = [
  'main.realtime.ably.net',
  'main.a.fallback.ably-realtime.com',
  'main.b.fallback.ably-realtime.com',
  'main.c.fallback.ably-realtime.com',
  'main.d.fallback.ably-realtime.com',
  'main.e.fallback.ably-realtime.com',
] as const

export interface RealtimeHandlers {
  readonly onSignal: (signal: RealtimeSignal) => void
  readonly onStatus: (status: RealtimeStatus) => void
}

/**
 * Ably needs a freshly signed TokenRequest on every call: it is single-use, so
 * caching one makes renewal fail rather than merely go stale.
 */
function createAuthCallback(getToken: TokenProvider): Ably.AuthOptions['authCallback'] {
  return (_params, callback) => {
    void (async () => {
      try {
        const token = await getToken()
        if (!token) throw new Error('No Clerk session token for Ably auth')
        const response = await fetch(`${API_BASE_URL}/api/realtime/token`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
        if (!response.ok) {
          throw new Error(`Realtime token request failed with ${response.status}`)
        }
        callback(null, (await response.json()) as Ably.TokenRequest)
      } catch (error) {
        callback(error as Ably.ErrorInfo, null)
      }
    })()
  }
}

export interface RealtimeConnection {
  close(): void
}

export function connectRealtime(
  identity: Identity,
  getToken: TokenProvider,
  handlers: RealtimeHandlers,
): RealtimeConnection {
  const ably = new Ably.Realtime({
    authCallback: createAuthCallback(getToken),
    // The WebView can be suspended on Android; recovering the connection on
    // resume is cheaper than a full re-auth handshake.
    disconnectedRetryTimeout: 5_000,
  })

  ably.connection.on((change) => {
    handlers.onStatus(change.current as RealtimeStatus)
  })

  const channel = ably.channels.get(`user-org:${identity.userId}:${identity.orgId}`)

  void channel.subscribe('threadListChanged', () => {
    handlers.onSignal({ kind: 'thread-list' })
  })

  // Per-thread topics are dynamic, so one unfiltered listener routes by name
  // instead of subscribing and unsubscribing as the thread set changes.
  void channel.subscribe((message) => {
    const name = message.name ?? ''
    if (!name.startsWith(MESSAGE_TOPIC_PREFIX)) return
    const threadId = name.slice(MESSAGE_TOPIC_PREFIX.length)
    if (threadId.length === 0) return
    handlers.onSignal({ kind: 'thread-messages', threadId })
  })

  return {
    close() {
      channel.unsubscribe()
      ably.close()
    },
  }
}
