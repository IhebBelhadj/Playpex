import createClient, { type Client, type Middleware } from 'openapi-fetch'
import type { components, paths } from '@playpex/protocol/types/api'

// The server's API, typed from packages/protocol/openapi.yaml (as the dashboard's
// lib/api.ts), one client per server: its URL, the device token in the
// Authorization header and this app's name and API version on every request.

export const APP_VERSION = '0.1.0'
export const API_VERSION = 2
export const CLIENT_ID = 'playpex-mobile'
export const CLIENT_HEADER_VALUE = `${CLIENT_ID}/${APP_VERSION}; api=${API_VERSION}`
export const API_PREFIX = '/api/v1'

export type Schemas = components['schemas']
export type Api = Client<paths>

export type ApiOptions = {
  url: string
  token: string | null
  deviceId: string
  /** 401 PAIRING_REQUIRED (device revoked) or 426 (versions don't overlap): the session ends */
  onLost: (reason: LostReason) => void
}

export type LostReason = { code: 'PAIRING_REQUIRED' | 'CLIENT_TOO_OLD' | 'SERVER_TOO_OLD'; message: string }

export function authHeaders(token: string | null, deviceId: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Playpex-Client': CLIENT_HEADER_VALUE, 'X-Playpex-Device': deviceId }
  if (token) headers.Authorization = 'Bearer ' + token
  return headers
}

export function createApi({ url, token, deviceId, onLost }: ApiOptions): Api {
  const client = createClient<paths>({ baseUrl: url + API_PREFIX, headers: authHeaders(token, deviceId) })
  const watch: Middleware = {
    async onResponse({ response }) {
      if (response.status !== 401 && response.status !== 426) return undefined
      const body = await response
        .clone()
        .json()
        .catch(() => ({}))
      const code = body?.code
      if (code === 'PAIRING_REQUIRED' || code === 'CLIENT_TOO_OLD' || code === 'SERVER_TOO_OLD') {
        onLost({ code, message: body.error ?? '' })
      }
      return undefined
    },
  }
  client.use(watch)
  return client
}

/** An error answer of the API: `{ error, code }`, or the device flow's `{ error, error_description }` */
export class ApiError extends Error {
  status: number
  code: string | null
  body: Record<string, unknown>
  constructor(status: number, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>
    const message = b.error_description ?? b.error ?? b.message ?? `Request failed (${status})`
    super(typeof message === 'string' ? message : `Request failed (${status})`)
    this.status = status
    this.body = b
    this.code = typeof b.code === 'string' ? b.code : null
  }
}

/** Data of an openapi-fetch answer, or throws an ApiError (React Query shows it) */
export async function unwrap<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  let answer: { data?: T; error?: unknown; response: Response }
  try {
    answer = await call
  } catch {
    throw new ApiError(0, { error: 'The server didn’t answer. Is the phone on the same network?' })
  }
  const { data, error, response } = answer
  if (!response.ok || error !== undefined) throw new ApiError(response.status, error)
  return data as T
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
