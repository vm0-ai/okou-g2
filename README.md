# okou-g2

Okou app for the [Even Realities G2](https://hub.evenrealities.com/) glasses.

Live at **https://g2.okou.ai** — a Cloudflare Worker that serves the SPA and
verifies Clerk sessions.

## What it does

Signs you in with a Clerk email code, then keeps your Okou chat list on the
device and on the glasses:

- **Thread list** — full snapshot plus the lifecycle event tail.
- **Chat events** — durable rows for the most recently active threads.
- **Push updates** — an Ably subscription invalidates either sync as soon as
  the server publishes.

Streaming output is deliberately not handled. Partial assistant text travels on
a separate `run-output` channel; this client only stores committed rows, so a
turn appears once it is durable.

Sending messages from the glasses is not implemented yet.

## Architecture

```
Even G2  ──BLE──  Even App WebView  ──HTTPS──  g2.okou.ai (Cloudflare Worker)
                         │                             └── verifies Clerk JWT
                         ├── clerk.okou.ai    (email code sign-in)
                         ├── api.okou.ai      (threads, chat events, Ably token)
                         ├── *.ably.net       (push invalidation)
                         └── Even App storage (durable cache)
```

### Sync protocol

Both loops mirror the platform SharedWorker:

| | Cold start | Tail | Cursor expired |
| --- | --- | --- | --- |
| Threads | `GET /api/chat-threads/snapshot` | `GET /api/chat-threads/events?sinceSeqId=` | `410` → snapshot |
| Messages | `GET /api/chat-threads/:id/event-snapshot` | `GET /api/chat-threads/:id/event-rows?sinceSeqId=` | `410` → snapshot |

Push topics on `user-org:<userId>:<orgId>`:

- `threadListChanged` → resync the list
- `chatThreadMessageCreated:<threadId>` → resync that thread

Payloads are notifications, not data. Every delivery triggers a fetch, because
the server stays authoritative.

### Storage

The Even App's `setLocalStorage` / `getLocalStorage` is a flat string store
with **no key enumeration, no delete, and no documented size limit**. So:

- Keys are namespaced `okou/v1/<clerkUserId>/<orgId>/…`, which is also what
  keeps two identities from mixing.
- Values are chunked into `<key>#<n>` with a header recording the count.
- Removal writes a tombstone; the key stays allocated but reads as absent.
- The namespace keeps its own thread index, since nothing can list keys.

Bounds live in `src/config.ts`: 200 threads listed, messages kept for the 20
most recently active, 200 rows each.

### Chat event snapshot archive

Message snapshots are presigned R2 objects, not API responses, so they need
their own CORS grant and their own `app.json` whitelist entry.

The production bucket `vm0-s3-user-storages-prod` allows `https://*.okou.ai`
for `GET`/`HEAD`, which covers this origin — verified by preflight, and an
unrelated origin is rejected. The API builds S3 clients with
`forcePathStyle` off unless `S3_FORCE_PATH_STYLE=true`, so the presigned host
is virtual-hosted style (`<bucket>.<account>.r2.cloudflarestorage.com`). Both
that host and the path-style one are whitelisted, because the flag is not
visible from this repo.

`syncThreadMessages` still falls back to a bounded cold start from
`sinceSeqId=0` if the archive fetch fails for any reason.

### Organization

Every Okou chat API resolves its organization from the session token's
`org_id`. A sign-in does not set one by itself, so `OrganizationGate` selects
the only membership automatically and shows a picker when there are several.

- The app code runs on the phone, not on the glasses. G2 renders text and
  forwards touch/IMU input.
- Sign-in happens on the phone screen with a custom Clerk email-code flow. No
  redirect leaves the WebView, because the Even App has no reliable way back
  from a system browser.
- The Worker holds **no Clerk secret**. Session tokens are verified locally
  against the public JWKS at `https://clerk.okou.ai/.well-known/jwks.json`.

### What is allowed to ship in the bundle

| Value | In the bundle |
| --- | --- |
| Clerk publishable key (`pk_live_…`) | yes — it is public by design |
| Clerk secret key | never |
| Okou / OpenAI API tokens | never |
| The fixed thread ID | never — resolved server-side from the Clerk user |

## Local development

```bash
npm install
cp .env.example .env
npm run dev          # Vite on :5173, bound to the LAN
```

For the Worker and the API together:

```bash
npm run build
npx wrangler dev     # serves dist/ plus /api/*
```

To load the dev server on real glasses, put the phone and the computer on the
same network and generate a QR code:

```bash
npx @evenrealities/evenhub-cli qr --url "http://192.168.x.x:5173"
```

`http://localhost:5173` is already an accepted `azp` value, so the backend check
works in local development too.

## Deployment

```bash
npm run deploy       # vite build && wrangler deploy
```

Configuration lives in `wrangler.jsonc`:

| Var | Meaning |
| --- | --- |
| `CLERK_ISSUER` | Clerk production instance issuer (`https://clerk.okou.ai`) |
| `ALLOWED_ORIGINS` | Accepted `azp` claim values on the session token |

Any signed-in Okou account can use the app; there is no per-user allowlist.

The build reads `VITE_CLERK_PUBLISHABLE_KEY` from the environment. It is the
same public key the `vm0-ai/okou` repository stores as
`CLERK_PUBLISHABLE_KEY_PROD`.

## Packaging for Even Hub

`app.json` declares the network whitelist (`g2.okou.ai` and `clerk.okou.ai`) for
a future `.ehpk` submission:

```bash
npm run build
npx @evenrealities/evenhub-cli pack app.json dist -o okou-g2.ehpk
```

Note that a packaged build runs from a WebView origin Even Realities does not
publish, which Clerk has not been verified to accept. Loading `https://g2.okou.ai`
by URL keeps the origin stable and is the supported path until that is tested.

## Tests

```bash
npm test
```

Covers the storage layer's chunking, tombstone and torn-write behaviour, and
the thread sync state machine including cursor expiry and pagination.

## Acceptance checklist

- [ ] Email code arrives and verifies on iOS
- [ ] Email code arrives and verifies on Android
- [ ] `/api/auth/me` returns the expected Clerk user ID
- [ ] Session survives force-quitting and reopening the Even App
- [ ] Token still refreshes after 5 minutes backgrounded or screen-locked
- [ ] Session still restores after 24 hours
- [ ] Signing out invalidates the old token
- [ ] Chat list appears on the lens after sign-in
- [ ] A new message in app.okou.ai reaches the glasses without a manual sync
- [ ] The list survives force-quitting and reopening the Even App
- [ ] The list survives an Android background suspend, and the Ably connection
      recovers on resume
