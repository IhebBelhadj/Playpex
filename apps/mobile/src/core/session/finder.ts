import { API_VERSION } from '../http/api'
import { Disposer } from '../util/disposer'
import { Store } from '../util/store'
import type { Discovery, FoundServer, KnownServer, ServerStore } from './ports'
import { incompatibility } from './reach'
import type { SessionController } from './session'

// "Find your server" (docs/api/discovery.md): servers found on this network
// and those paired before, merged by id, or an address typed. Choosing a paired
// one connects at once; another one needs pairing first (the screen opens Pair).

export type ServerEntry = FoundServer & { paired: boolean; seen: boolean }

export type FinderState = {
  entries: ServerEntry[]
  /** Nothing found after a while: the screen explains what to check */
  quiet: boolean
  probing: boolean
  error: string | null
}

/** What choosing a server leads to */
export type Choice = { kind: 'connected' } | { kind: 'pair'; server: { id: string; name: string; url: string } } | { kind: 'refused' }

const QUIET_AFTER_MS = 8000

export class ServerFinder {
  readonly state = new Store<FinderState>({ entries: [], quiet: false, probing: false, error: null })
  private run: Disposer | null = null
  private found: Record<string, FoundServer> = {}
  private known: KnownServer[] = []

  constructor(
    private readonly servers: ServerStore,
    private readonly discovery: Discovery,
    private readonly session: SessionController,
  ) {}

  get discoveryAvailable(): boolean {
    return this.discovery.available
  }

  start(): void {
    if (this.run && !this.run.disposed) return
    const run = (this.run = new Disposer())
    this.found = {}
    this.state.patch({ quiet: false, error: null })
    void this.servers.list().then((known) => {
      if (run.disposed) return
      this.known = known
      this.publish()
    })
    run.add(
      this.discovery.start((server) => {
        this.found = { ...this.found, [server.id]: server }
        this.publish()
      }),
    )
    run.timeout(QUIET_AFTER_MS, () => this.state.patch({ quiet: true }))
  }

  stop(): void {
    this.run?.dispose()
  }

  async choose(server: FoundServer): Promise<Choice> {
    this.state.patch({ error: null })
    const problem = incompatibility(server)
    if (problem) {
      this.state.patch({ error: problem })
      return { kind: 'refused' }
    }
    const saved = this.known.find((k) => k.id === server.id)
    if (saved?.token) {
      await this.session.connect({ ...saved, url: server.url, name: server.name || saved.name })
      return { kind: 'connected' }
    }
    return { kind: 'pair', server: { id: server.id, name: server.name, url: server.url } }
  }

  /** An address people typed */
  async chooseAddress(address: string): Promise<Choice> {
    if (!address.trim()) return { kind: 'refused' }
    this.state.patch({ probing: true, error: null })
    try {
      const server = await this.discovery.probe(address.trim())
      this.state.patch({ probing: false })
      return await this.choose(server)
    } catch (e) {
      this.state.patch({ probing: false, error: e instanceof Error ? e.message : 'It didn’t answer.' })
      return { kind: 'refused' }
    }
  }

  private publish(): void {
    const found = Object.values(this.found).map((f) => ({ ...f, paired: this.known.some((k) => k.id === f.id && !!k.token), seen: true }))
    const notSeen = this.known
      .filter((k) => !this.found[k.id])
      .map((k) => ({ id: k.id, name: k.name, url: k.url, version: '', apiVersion: API_VERSION, minApiVersion: 1, host: null, via: 'manual' as const, paired: !!k.token, seen: false }))
    this.state.patch({ entries: [...found, ...notSeen] })
  }
}
