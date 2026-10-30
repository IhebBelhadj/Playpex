import { API_PREFIX, ApiError, CLIENT_HEADER_VALUE, CLIENT_ID, authHeaders, type Schemas } from '../http/api'
import { Disposer } from '../util/disposer'
import { Store } from '../util/store'
import type { DeviceDescription } from './ports'
import type { SessionController } from './session'

// Pairing once with a server (docs/api/auth.md): the RFC 8628 device flow,
// then PUT /devices/me with this phone's name and what it decodes. The
// controller asks for a code, shows it, polls until the admin answers, and on
// approval hands the server to the session; stop() ends the polling.

export type DeviceCode = Schemas['DeviceAuthorization']

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Playpex-Client': CLIENT_HEADER_VALUE, ...headers },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, retryAfter: Number(res.headers.get('X-Retry-After')) || 0 }
}

export async function requestCode(serverUrl: string): Promise<DeviceCode> {
  const { status, json, retryAfter } = await post(serverUrl + API_PREFIX + '/auth/device/code', { client_id: CLIENT_ID })
  if (status === 429) throw new ApiError(429, { error: `Too many pairing requests. Try again in ${retryAfter || 60} s.` })
  if (status !== 200) throw new ApiError(status, json)
  return json as DeviceCode
}

export type PollResult = { state: 'approved'; token: string } | { state: 'pending'; interval: number } | { state: 'expired' } | { state: 'denied' }

/** One poll of the token route; `interval` is the next wait (5 s more after slow_down) */
export async function pollToken(serverUrl: string, deviceCode: string, interval: number): Promise<PollResult> {
  const { status, json } = await post(serverUrl + API_PREFIX + '/auth/device/token', { grant_type: GRANT_TYPE, device_code: deviceCode, client_id: CLIENT_ID })
  if (status === 200 && json.access_token) return { state: 'approved', token: json.access_token }
  switch (json.error) {
    case 'authorization_pending':
      return { state: 'pending', interval }
    case 'slow_down':
      return { state: 'pending', interval: interval + 5 }
    case 'expired_token':
    case 'invalid_grant':
      return { state: 'expired' }
    case 'access_denied':
      return { state: 'denied' }
    default:
      if (status === 429) return { state: 'pending', interval: interval + 5 }
      throw new ApiError(status, json)
  }
}

/** PUT /devices/me: its name and codecs, so the admin knows it and the server can choose how files play */
export async function describeDevice(serverUrl: string, token: string, deviceId: string, device: DeviceDescription): Promise<void> {
  await fetch(serverUrl + API_PREFIX + '/devices/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token, deviceId) },
    body: JSON.stringify({ ...device, deviceId }),
  }).catch(() => undefined)
}

/** ZETWHGRK → ZETW-HGRK */
export function splitCode(code: string): string {
  return code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code
}

export type PairingState =
  | { step: 'asking' }
  | { step: 'waiting'; code: DeviceCode; expiresAt: number }
  | { step: 'approved' }
  | { step: 'expired' }
  | { step: 'denied' }
  | { step: 'failed'; message: string }

export type PairingTarget = { id: string; name: string; url: string }

export class PairingController {
  readonly state = new Store<PairingState>({ step: 'asking' })
  private run: Disposer | null = null

  constructor(
    private readonly target: PairingTarget,
    private readonly session: SessionController,
    private readonly device: () => DeviceDescription,
  ) {}

  /** Asks for a code and waits for the admin; again after stop() or a failure */
  start(): void {
    if (this.run && !this.run.disposed) return
    const run = (this.run = new Disposer())
    void this.flow(run)
  }

  stop(): void {
    this.run?.dispose()
  }

  /** A new code after an expiry, a refusal or a failure */
  restart(): void {
    this.stop()
    this.start()
  }

  private async flow(run: Disposer): Promise<void> {
    const { url } = this.target
    this.state.set({ step: 'asking' })
    try {
      const code = await requestCode(url)
      if (run.disposed) return
      this.state.set({ step: 'waiting', code, expiresAt: Date.now() + code.expires_in * 1000 })
      let interval = code.interval || 5
      for (;;) {
        await run.sleep(interval * 1000)
        if (run.disposed) return
        const result = await pollToken(url, code.device_code, interval)
        if (run.disposed) return
        if (result.state === 'pending') {
          interval = result.interval
          continue
        }
        if (result.state !== 'approved') {
          this.state.set({ step: result.state })
          return
        }
        await describeDevice(url, result.token, this.session.deviceId, this.device())
        if (run.disposed) return
        this.state.set({ step: 'approved' })
        await this.session.connect({ ...this.target, token: result.token, pairedAt: new Date().toISOString() })
        return
      }
    } catch (e) {
      if (!run.disposed) this.state.set({ step: 'failed', message: e instanceof Error ? e.message : String(e) })
    } finally {
      run.dispose()
    }
  }
}
