# okou-g2

Okou app for the [Even Realities G2](https://hub.evenrealities.com/) glasses.

Live at **https://g2.okou.ai** — a Cloudflare Worker that serves the SPA and
verifies Clerk sessions.

## Status: Phase 1 — authentication probe

The goal of this phase is to prove that a Clerk email-code session created
inside the Even App WebView survives real-world conditions, before any chat
code is written. The app signs you in, then calls `/api/auth/me` and shows the
Clerk user ID the Worker independently verified.

Chat against a fixed Okou thread comes in Phase 2.

## Architecture

```
Even G2  ──BLE──  Even App WebView  ──HTTPS──  g2.okou.ai (Cloudflare Worker)
                         │                             │
                         │                             └── verifies Clerk JWT
                         └── clerk.okou.ai (email code sign-in)
```

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

## Phase 1 acceptance checklist

- [ ] Email code arrives and verifies on iOS
- [ ] Email code arrives and verifies on Android
- [ ] `/api/auth/me` returns the expected Clerk user ID
- [ ] Session survives force-quitting and reopening the Even App
- [ ] Token still refreshes after 5 minutes backgrounded or screen-locked
- [ ] Session still restores after 24 hours
- [ ] Signing out invalidates the old token
