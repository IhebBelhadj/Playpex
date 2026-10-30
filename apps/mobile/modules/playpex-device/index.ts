import { NativeModule, requireOptionalNativeModule } from 'expo'

// The app's native side (android/…/PlaypexDeviceModule.kt): finding servers on
// the network (docs/api/discovery.md) and what this phone decodes.

/** A server found and confirmed with GET /api/v1/server at `url` */
export type FoundServer = {
  id: string
  name: string
  version: string
  apiVersion: number
  minApiVersion: number
  /** http://<address>:<port> */
  url: string
  /** Its .local name, for people (playpex.local) */
  host: string | null
  via: 'mdns' | 'udp' | 'manual'
}

/** What the phone's decoders take, in ffprobe's names (docs/api/auth.md#4-describe-the-device) */
export type Codecs = { video: string[]; audio: string[]; maxHeight: number }

type Events = { server: (server: FoundServer) => void }

declare class PlaypexDeviceModule extends NativeModule<Events> {
  startDiscovery(): void
  stopDiscovery(): void
  probe(address: string): Promise<FoundServer>
  codecs(): Codecs
}

const native = requireOptionalNativeModule<PlaypexDeviceModule>('PlaypexDevice')

/** Without the native module (a platform it isn't written for yet) nothing is found; typed addresses still work through fetch */
export const hasDiscovery = native != null

export function startDiscovery(onServer: (server: FoundServer) => void): () => void {
  if (!native) return () => {}
  const subscription = native.addListener('server', onServer)
  native.startDiscovery()
  return () => {
    subscription.remove()
    native.stopDiscovery()
  }
}

export async function probe(address: string): Promise<FoundServer> {
  if (native) return native.probe(address)
  const url = toUrl(address)
  const res = await fetch(url + '/api/v1/server', { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('It isn’t a Playpex server, or it didn’t answer.')
  const info = await res.json()
  if (!info?.id) throw new Error('It isn’t a Playpex server.')
  return {
    id: info.id,
    name: info.name ?? 'Playpex',
    version: info.version ?? '',
    apiVersion: info.apiVersion ?? 1,
    minApiVersion: info.minApiVersion ?? 1,
    url,
    host: info.host ?? null,
    via: 'manual',
  }
}

export function codecs(): Codecs {
  return native ? native.codecs() : { video: ['h264'], audio: ['aac', 'mp3', 'opus'], maxHeight: 1080 }
}

/** What a person typed, as a base URL: no scheme = http, no port = 28470 (IPv6 literals in brackets) */
export function toUrl(address: string): string {
  let text = address.trim().replace(/\/+$/, '')
  if (!/^[a-z]+:\/\//i.test(text)) text = 'http://' + text
  const match = /^([a-z]+):\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/i.exec(text)
  if (!match) throw new Error('Not an address: ' + address)
  const host = match[2].includes(':') && !match[2].startsWith('[') ? `[${match[2]}]` : match[2]
  return `${match[1].toLowerCase()}://${host}:${match[3] ?? '28470'}`
}
