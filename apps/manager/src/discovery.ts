import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

// The native side (android/.../PlaypexDiscovery.java) does what Playpex TV's
// electron/discovery.js does (docs/api/discovery.md): browses mDNS for
// `_playpex._tcp`, asks UDP 28471 every 5 s, and confirms each address with
// GET /api/v1/server before reporting it. The checks are native because this
// page (https://localhost) may not read a LAN server's answers.

export type Server = {
  id: string
  name: string
  version: string
  apiVersion: number
  /** http://<address>:<port>, the address that answered */
  url: string
  address: string
  port: number
  /** the server's .local name when it advertises one (playpex.local) */
  host: string | null
  via: 'mdns' | 'udp' | 'manual'
}

interface DiscoveryPlugin {
  start(): Promise<void>
  stop(): Promise<void>
  /** "192.168.1.20", "playpex.local:28470", "http://nas.local:28470/": GET /api/v1/server there */
  probe(options: { address: string }): Promise<Server>
  addListener(event: 'server', listener: (server: Server) => void): Promise<PluginListenerHandle>
}

const native = registerPlugin<DiscoveryPlugin>('PlaypexDiscovery')

export const DEFAULT_PORT = 28470

/** In the Android app: the native plugin. In a browser (development): nothing to browse with. */
export const canDiscover = Capacitor.isNativePlatform()

export async function startDiscovery(onServer: (s: Server) => void): Promise<() => void> {
  if (!canDiscover) return () => {}
  const handle = await native.addListener('server', onServer)
  await native.start()
  return () => {
    void handle.remove()
    void native.stop()
  }
}

/** A typed address: the native probe in the app; in a browser, the address as a URL (unchecked) */
export async function probe(address: string): Promise<Server> {
  if (canDiscover) return native.probe({ address })
  const url = toUrl(address)
  const u = new URL(url)
  return { id: url, name: u.hostname, version: '', apiVersion: 1, url, address: u.hostname, port: Number(u.port) || DEFAULT_PORT, host: null, via: 'manual' }
}

/** What a person types, as the server's base URL: no scheme means http, no port means 28470 */
export function toUrl(address: string): string {
  const text = address.trim()
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `http://${text}`
  const u = new URL(withScheme)
  // a port typed as :80 is dropped by URL (the default): only add 28470 when none was typed
  // (an IPv6 literal's colons aren't a port: only a :digits after the host or its ])
  const typedPort = /^[a-z]+:\/\/(\[[^\]]+\]|[^/?#:[]+):\d+/i.test(withScheme)
  // URL.hostname keeps an IPv6 literal's brackets
  return typedPort ? `${u.protocol}//${u.host}` : `${u.protocol}//${u.hostname}:${DEFAULT_PORT}`
}
