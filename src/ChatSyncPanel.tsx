import type { SyncState } from './sync/engine'
import type { ChatThread } from './types'

function threadLabel(thread: ChatThread): string {
  return thread.title ?? 'Untitled'
}

export default function ChatSyncPanel({
  orgId,
  state,
  onResync,
}: {
  orgId: string
  state: SyncState
  onResync: () => void
}) {
  const visible = [...state.threads]
    .sort((left, right) => right.sortAt.localeCompare(left.sortAt))
    .slice(0, 10)

  return (
    <section className="card">
      <h2>Chats</h2>
      <dl>
        <dt>Organization</dt>
        <dd className="mono">{orgId}</dd>
        <dt>Realtime</dt>
        <dd>{state.realtime}</dd>
        <dt>Threads</dt>
        <dd>{state.threads.length}</dd>
        <dt>Cached messages</dt>
        <dd>{Object.values(state.messageCounts).reduce((total, count) => total + count, 0)}</dd>
        <dt>Last sync</dt>
        <dd>
          {state.lastSyncedAt === null
            ? '—'
            : new Date(state.lastSyncedAt).toLocaleTimeString()}
        </dd>
      </dl>

      {state.error ? <p className="error">{state.error}</p> : null}

      {visible.length > 0 ? (
        <ol className="threads">
          {visible.map((thread) => (
            <li key={thread.id}>
              <span className="thread-title">{threadLabel(thread)}</span>
              <span className="thread-meta">{state.messageCounts[thread.id] ?? 0}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="hint">{state.syncing ? 'Syncing…' : 'No chats yet.'}</p>
      )}

      <button type="button" onClick={onResync} disabled={state.syncing}>
        {state.syncing ? 'Syncing…' : 'Sync now'}
      </button>
    </section>
  )
}
