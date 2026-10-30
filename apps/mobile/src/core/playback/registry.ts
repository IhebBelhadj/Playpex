import type { PlaybackSession } from './session'

// The playbacks between the source sheet and the player: a route's params are
// strings, so the player gets its session by id. A session leaves the registry
// when the player takes it (take()); nothing stays behind.

export class SessionRegistry {
  private readonly sessions = new Map<string, PlaybackSession>()
  private next = 1

  add(session: PlaybackSession): string {
    const id = String(this.next++)
    this.sessions.set(id, session)
    return id
  }

  /** The session for this id, once: the player that takes it owns it from then on */
  take(id: string): PlaybackSession | null {
    const session = this.sessions.get(id) ?? null
    this.sessions.delete(id)
    return session
  }

  get size(): number {
    return this.sessions.size
  }
}
