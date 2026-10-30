import type { ApiClient } from '../http/client'
import { Disposer } from '../util/disposer'
import { Emitter } from '../util/emitter'

// The server's events (docs/api/events.md): one WebSocket for what changes on
// the server, so screens refetch instead of polling. Only the topics this app
// acts on are asked for. The socket reconnects with back-off (1 s, 2 s, 5 s,
// 10 s, 30 s) while started; a revoked device's upgrade fails, and the next
// API request ends the session (its 401).

export type ServerEventMap = {
  'library.changed': { folderId: string | null }
  'plugin.changed': { id: string; state: string; reason?: string }
  'plugin.notification': { profileId: string; plugin: string }
  'settings.changed': { scope: 'device' | 'profile'; ownerId: string; keys: string[] }
  'download.updated': { infoHash: string; state: string }
  'session.ended': { id: string; deviceId: string; infoHash: string | null; ref: string | null }
}

const TOPICS = ['library', 'plugin', 'settings', 'download', 'session.ended']
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]

/** What the socket needs: React Native's WebSocket takes headers in a third argument */
type SocketFactory = (url: string, headers: Record<string, string>) => WebSocket

const nativeSocket: SocketFactory = (url, headers) =>
  new (WebSocket as unknown as new (url: string, protocols: string[] | null, options: { headers: Record<string, string> }) => WebSocket)(url, null, { headers })

export class ServerEvents {
  readonly events = new Emitter<ServerEventMap>()
  private run: Disposer | null = null
  private failures = 0

  constructor(
    private readonly client: ApiClient,
    private readonly openSocket: SocketFactory = nativeSocket,
  ) {}

  start(): void {
    if (this.run && !this.run.disposed) return
    this.run = new Disposer()
    this.failures = 0
    this.connect(this.run)
  }

  stop(): void {
    this.run?.dispose()
  }

  private connect(run: Disposer): void {
    if (run.disposed) return
    const url = this.client.url('/events').replace(/^http/, 'ws') + '?topics=' + TOPICS.join(',')
    const socket = this.openSocket(url, this.client.headers())
    const close = run.add(() => {
      socket.onclose = null
      socket.close()
    })
    socket.onopen = () => {
      this.failures = 0
    }
    socket.onmessage = (message) => {
      try {
        const { topic, data } = JSON.parse(String(message.data)) as { topic: string; data: unknown }
        if (topic in EVENT_TOPICS) this.events.emit(topic as keyof ServerEventMap, data as never)
      } catch {
        // a frame that isn't JSON is ignored
      }
    }
    socket.onclose = () => {
      close()
      if (run.disposed) return
      const wait = BACKOFF_MS[Math.min(this.failures++, BACKOFF_MS.length - 1)]
      run.timeout(wait, () => this.connect(run))
    }
  }
}

const EVENT_TOPICS: Record<keyof ServerEventMap, true> = {
  'library.changed': true,
  'plugin.changed': true,
  'plugin.notification': true,
  'settings.changed': true,
  'download.updated': true,
  'session.ended': true,
}
