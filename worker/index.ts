/**
 * Okou G2 Worker.
 *
 * Serves the built SPA from the ASSETS binding and exposes the authentication
 * probe used to validate Clerk sessions created inside the Even App WebView.
 *
 * The Worker holds no Clerk secret: session tokens are verified locally against
 * the production instance's public JWKS.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

export interface Env {
  ASSETS: Fetcher
  CLERK_ISSUER: string
  ALLOWED_ORIGINS: string
}

interface ClerkSessionClaims extends JWTPayload {
  sid?: string
  azp?: string
  org_id?: string
  org_role?: string
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getJwks(issuer: string) {
  let jwks = jwksCache.get(issuer)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      cacheMaxAge: 10 * 60 * 1000,
    })
    jwksCache.set(issuer, jwks)
  }
  return jwks
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin')
  if (!origin || !splitList(env.ALLOWED_ORIGINS).includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

function json(body: unknown, init: ResponseInit = {}, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

type AuthResult =
  | { ok: true; claims: ClerkSessionClaims; userId: string }
  | { ok: false; status: number; error: string }

async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return { ok: false, status: 401, error: 'missing_bearer_token' }

  let claims: ClerkSessionClaims
  try {
    const verified = await jwtVerify(token, getJwks(env.CLERK_ISSUER), {
      issuer: env.CLERK_ISSUER,
      clockTolerance: 5,
    })
    claims = verified.payload as ClerkSessionClaims
  } catch {
    return { ok: false, status: 401, error: 'invalid_session_token' }
  }

  // `azp` carries the origin that created the session. Clerk omits it for some
  // token templates, so only enforce it when present.
  const allowedOrigins = splitList(env.ALLOWED_ORIGINS)
  if (claims.azp && allowedOrigins.length > 0 && !allowedOrigins.includes(claims.azp)) {
    return { ok: false, status: 401, error: 'unauthorized_party' }
  }

  const userId = typeof claims.sub === 'string' ? claims.sub : ''
  if (!userId) return { ok: false, status: 401, error: 'missing_subject' }

  return { ok: true, claims, userId }
}

async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const cors = corsHeaders(request, env)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }

  if (pathname === '/api/health') {
    return json({ ok: true, issuer: env.CLERK_ISSUER }, {}, cors)
  }

  if (pathname === '/api/auth/me') {
    const auth = await authenticate(request, env)
    if (!auth.ok) {
      return json({ error: auth.error }, { status: auth.status }, cors)
    }
    return json(
      {
        userId: auth.userId,
        sessionId: auth.claims.sid ?? null,
        orgId: auth.claims.org_id ?? null,
        expiresAt: auth.claims.exp ?? null,
        // Phase 1 is an auth probe. The fixed thread is resolved server-side
        // from the Clerk user and is intentionally not accepted from the client.
        threadBound: false,
      },
      {},
      cors,
    )
  }

  return json({ error: 'not_found' }, { status: 404 }, cors)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url.pathname)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
