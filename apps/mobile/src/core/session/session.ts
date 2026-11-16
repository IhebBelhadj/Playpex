import type { LostReason, Schemas } from '../http/api'
import { ApiClient } from '../http/client'
import { Disposer } from '../util/disposer'
import { Emitter } from '../util/emitter'
import { Store } from '../util/store'
import { resumeProfile } from '../services/profiles'
import type { Discovery, KnownServer, ProfileMemory, ServerStore } from './ports'
import { answers, FIND_AGAIN_MS, findAgain } from './reach'

// The session: which server this phone uses, its API client, and who is
// watching. One per app (state/app.tsx). The screens shown follow its state:
//
//   booting ──► reaching ──► connected ──► (profile chosen)
//      │           │  ▲          │
//      │           ▼  │ retry    │ lost (device revoked, versions) / disconnect
//      └──────► noServer ◄───────┘
//                  ▲
//             unreachable (the last server didn't answer, nor was it found again)
//
// The profile is kept in memory only: "Who's watching?" at every start, as on the TV. Where the
// app reloads (a browser tab) a ProfileMemory keeps it for that tab: the reload opens it again
// (POST /profiles/{id}/resume) while the server is still being reached.

export type Profile = Schemas['Profile']

/** Why the session ended without the user asking (shown on Connect) */
export type LostNotice = LostReason & { serverName: string }

export type SessionState =
  | { kind: 'booting' }
  | { kind: 'noServer'; lost: LostNotice | null }
  | { kind: 'reaching'; server: KnownServer }
  | { kind: 'unreachable'; server: KnownServer }
  | { kind: 'connected'; server: KnownServer; client: ApiClient; profile: Profile | null }

type Events = {
  /** Another server, or none: everything cached for the previous one is stale */
  serverChanged: { serverId: string | null }
}

export class SessionController {
  readonly state = new Store<SessionState>({ kind: 'booting' })
  readonly events = new Emitter<Events>()
  private deviceIdValue = ''
  private attempt: Disposer | null = null
  private booted = false

  constructor(
    private readonly servers: ServerStore,
    private readonly discovery: Discovery,
    private readonly profiles: ProfileMemory | null = null,
  ) {}

  /** This install's id: known once booted */
  get deviceId(): string {
    return this.deviceIdValue
  }

  /** Boots once: the last server at its URL, else found again by id, else the server list */
  async start(): Promise<void> {
    if (this.booted) return
    this.booted = true
    this.deviceIdValue = await this.servers.deviceId()
    const last = await this.servers.last()
    if (last) await this.reach(last)
    else this.state.set({ kind: 'noServer', lost: null })
  }

  /** Nothing runs between screens but a reach attempt; the app's end stops it */
  stop(): void {
    this.attempt?.dispose()
    this.attempt = null
  }

  /** Use this server from now on: just paired, or a paired one picked in the list */
  async connect(server: KnownServer): Promise<void> {
    this.stop()
    await this.servers.save(server)
    await this.enter(server)
  }

  /** Back to the server list ("Change server") */
  disconnect(): void {
    this.stop()
    const had = this.serverId()
    this.state.set({ kind: 'noServer', lost: null })
    if (had) this.events.emit('serverChanged', { serverId: null })
  }

  /** Try the unreachable server again */
  async retry(): Promise<void> {
    const current = this.state.get()
    if (current.kind !== 'unreachable') return
    await this.reach(current.server)
  }

  chooseProfile(profile: Profile): void {
    const current = this.state.get()
    if (current.kind !== 'connected') return
    this.profiles?.remember(current.server.id, profile.id)
    this.state.set({ ...current, profile })
  }

  /** "Who's watching?" again */
  leaveProfile(): void {
    const current = this.state.get()
    if (current.kind !== 'connected' || !current.profile) return
    this.profiles?.remember(current.server.id, null)
    this.state.set({ ...current, profile: null })
  }

  private async reach(server: KnownServer): Promise<void> {
    this.stop()
    const attempt = (this.attempt = new Disposer())
    this.state.set({ kind: 'reaching', server })
    if (await answers(server.url, server.id)) {
      if (!attempt.disposed) await this.enter(server, attempt)
      return
    }
    const url = await findAgain(this.discovery, server.id, FIND_AGAIN_MS, attempt)
    if (attempt.disposed) return
    if (url) {
      await this.servers.move(server.id, url)
      await this.enter({ ...server, url }, attempt)
    } else {
      this.state.set({ kind: 'unreachable', server })
    }
  }

  private async enter(server: KnownServer, attempt?: Disposer): Promise<void> {
    const changed = this.serverId() !== server.id
    const client = new ApiClient(server, this.deviceIdValue, (reason) => this.lose(server, reason))
    // After a reload: the profile it was on, while "Looking for your server…" still shows
    const kept = this.profiles?.last(server.id)
    const profile = kept ? await resumeProfile(client, kept) : null
    if (attempt?.disposed) return
    if (kept && !profile) this.profiles?.remember(server.id, null)
    this.state.set({ kind: 'connected', server, client, profile })
    if (changed) this.events.emit('serverChanged', { serverId: server.id })
  }

  /** The server refused this device (revoked: forget its token) or its version */
  private lose(server: KnownServer, reason: LostReason): void {
    const current = this.state.get()
    if (current.kind !== 'connected' || current.server.id !== server.id) return
    if (reason.code === 'PAIRING_REQUIRED') void this.servers.forget(server.id)
    this.state.set({ kind: 'noServer', lost: { ...reason, serverName: server.name } })
    this.events.emit('serverChanged', { serverId: null })
  }

  private serverId(): string | null {
    const s = this.state.get()
    return s.kind === 'connected' || s.kind === 'reaching' || s.kind === 'unreachable' ? s.server.id : null
  }
}
