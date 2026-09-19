/**
 * Okou API client for the glasses app.
 *
 * Deliberately omits `X-Client-Type: App`. That header opts a request into the
 * web bundle's minimum-version gate, which would start returning 426 to this
 * app whenever the platform raises its floor.
 */
import {
  API_BASE_URL,
  CHAT_EVENT_SCHEMA_VERSION,
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
} from '../config'

/** A non-2xx response the caller is expected to branch on (404, 409, 410, 426…). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`Okou API responded ${status}${code ? ` (${code})` : ''}`)
    this.name = 'ApiError'
  }
}

export type TokenProvider = () => Promise<string | null>

export interface ApiRequest {
  readonly path: string
  readonly method?: 'GET' | 'POST'
  readonly body?: unknown
  /** Send the chat-event schema version. Required by the chat event routes. */
  readonly chatEventSchema?: boolean
  readonly signal?: AbortSignal
  /** Statuses to return rather than throw, so callers can branch on them. */
  readonly expect?: readonly number[]
}

export interface ApiResponse<T> {
  readonly status: number
  readonly body: T
}

function errorCode(body: unknown): string | undefined {
  const error = (body as { error?: { code?: unknown } } | null)?.error
  return typeof error?.code === 'string' ? error.code : undefined
}

export class OkouApiClient {
  constructor(private readonly getToken: TokenProvider) {}

  async request<T>(request: ApiRequest): Promise<ApiResponse<T>> {
    const token = await this.getToken()
    if (!token) throw new ApiError(401)

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    }
    if (request.chatEventSchema) {
      headers[CHAT_EVENT_SCHEMA_VERSION_HEADER] = String(CHAT_EVENT_SCHEMA_VERSION)
    }
    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const response = await fetch(`${API_BASE_URL}${request.path}`, {
      method: request.method ?? 'GET',
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(request.signal ? { signal: request.signal } : {}),
    })

    // 204 and other empty bodies must not go through json().
    const text = await response.text()
    const body = (text.length === 0 ? null : JSON.parse(text)) as T

    if (response.ok || request.expect?.includes(response.status)) {
      return { status: response.status, body }
    }
    throw new ApiError(response.status, errorCode(body))
  }
}
