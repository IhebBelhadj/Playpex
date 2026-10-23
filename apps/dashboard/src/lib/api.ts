import createClient from 'openapi-fetch'
import type { components, paths } from '@playpex/protocol/types/api'

// The server's API, typed from packages/protocol/openapi.yaml. The dashboard
// is served by the server (same origin), so the admin's session cookie goes
// along with every request.
export const API_PREFIX = '/api/v1'

export const api = createClient<paths>({ baseUrl: API_PREFIX, credentials: 'same-origin' })

export type Schemas = components['schemas']
export type Overview = Schemas['Overview']
export type Settings = Schemas['Settings']
export type SettingsView = Schemas['SettingsView']
export type Session = Schemas['Session']
export type Device = Schemas['Device']
export type PairingRequest = Schemas['PairingRequest']
export type LogEntry = Schemas['LogEntry']
export type Storage = Schemas['Storage']
export type Profile = Schemas['Profile']
export type Torrent = Schemas['Torrent']
export type HostInfo = Schemas['HostInfo']
export type DesktopState = Schemas['DesktopState']

/** An error answer of the API: `{ error, code }`, Better Auth's `{ message, code }` or the RFC shape. */
export class ApiError extends Error {
  status: number
  code: string | null
  details: string[]
  /** `errors: [{ key, message }]` by key (a form's fields) */
  fields: Record<string, string>
  /** The whole answer, for routes that add fields to their errors (a plugin's `dependents`) */
  body: Record<string, unknown>
  constructor(status: number, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>
    const message = (b.error_description ?? b.error ?? b.message ?? `Request failed (${status})`) as string
    super(typeof message === 'string' ? message : `Request failed (${status})`)
    this.status = status
    this.body = b
    this.code = typeof b.code === 'string' ? b.code : null
    const errors: unknown[] = Array.isArray(b.errors) ? b.errors : []
    this.fields = {}
    this.details = errors.map((e) => {
      if (typeof e === 'string') return e
      const { key, message } = (e ?? {}) as { key?: string; message?: string }
      if (key && message) this.fields[key] = message
      return [key, message].filter(Boolean).join(' ')
    })
  }
}

/** Data of an openapi-fetch answer, or throws an ApiError (React Query shows it). */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call
  if (!response.ok || error !== undefined) {
    throw new ApiError(response.status, error)
  }
  return data as T
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.details.length) return err.details.join('; ')
  if (err instanceof Error) return err.message
  return String(err)
}

/** True when the error means "sign in again". */
export function isSignedOut(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401
}
