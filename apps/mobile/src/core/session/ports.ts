// What the session needs from the platform, as interfaces: src/native gives
// the real ones (expo-secure-store, the playpex-device module), tests fakes.

/** A server this phone paired with, remembered by id (never by address: docs/api/discovery.md) */
export type KnownServer = {
  id: string
  name: string
  /** http://<address>:<port>, where it answered last */
  url: string
  token: string | null
  /** In a browser: the page's own credentials (the httpOnly device cookie, or none on the server's machine), no token */
  cookie?: boolean
  pairedAt: string
}

/** Paired: it has a token, or (a browser) the page's own credentials */
export function isPaired(server: KnownServer): boolean {
  return !!server.token || !!server.cookie
}

/** How the device flow asks: a phone gets its token, a browser an httpOnly cookie (docs/api/auth.md) */
export type PairingMode = { clientId: string; cookie: boolean }

/** A server found on the network or at a typed address, confirmed with GET /api/v1/server */
export type FoundServer = {
  id: string
  name: string
  version: string
  apiVersion: number
  minApiVersion: number
  url: string
  /** Its .local name, for people (playpex.local) */
  host: string | null
  via: 'mdns' | 'udp' | 'manual'
}

export interface ServerStore {
  /** This install's own id (`X-Playpex-Device`), made once */
  deviceId(): Promise<string>
  list(): Promise<KnownServer[]>
  /** Saves it and makes it the last one used */
  save(server: KnownServer): Promise<void>
  /** It answered at another address: keep the token, change the URL */
  move(id: string, url: string): Promise<void>
  /** Its token was revoked: forget it */
  forget(id: string): Promise<void>
  last(): Promise<KnownServer | null>
}

export interface Discovery {
  /** False where the native module isn't written yet: typed addresses still work */
  readonly available: boolean
  /** Reports each server found until the returned function is called */
  start(onServer: (server: FoundServer) => void): () => void
  /** An address people typed (playpex.local, 192.168.1.20, with or without a port) */
  probe(address: string): Promise<FoundServer>
}

/** What PUT /devices/me tells the server about this phone */
export type DeviceDescription = {
  name: string
  platform: string
  capabilities: { containers: string[]; video: string[]; audio: string[]; maxHeight: number; hls?: boolean }
}

/** Who was watching, kept across a reload where the platform reloads (a browser tab); none on a phone */
export interface ProfileMemory {
  /** The profile chosen last, for this server */
  last(serverId: string): string | null
  remember(serverId: string, profileId: string | null): void
}
