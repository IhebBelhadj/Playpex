import { API_PREFIX } from '../core/http/api'
import type { DeviceDescription, Discovery, FoundServer, PairingMode } from '../core/session/ports'
import { WEB_CLIENT_ID, browserCapabilities, browserName, pageOrigin, platformName } from '../web/browser'

// In a browser (docs/mobile-web-plan.md): the one server is the page's own.
// "Finding" it is asking it; another address can't be used from here (its
// device cookie would be another origin's): open its own /m/ instead.

async function serverAt(url: string): Promise<FoundServer> {
  const res = await fetch(url + API_PREFIX + '/server', { headers: { Accept: 'application/json' } })
  const info = res.ok ? await res.json().catch(() => null) : null
  if (!info?.id) throw new Error('This server didn’t answer. Reload the page to try again.')
  return {
    id: info.id,
    name: info.name ?? window.location.host,
    version: info.version ?? '',
    apiVersion: info.apiVersion ?? 1,
    minApiVersion: info.minApiVersion ?? 1,
    url,
    host: info.host ?? null,
    via: 'manual',
  }
}

export const discovery: Discovery = {
  available: true,
  start(onServer) {
    let stopped = false
    serverAt(pageOrigin()).then(
      (server) => !stopped && onServer(server),
      () => {},
    )
    return () => {
      stopped = true
    }
  },
  async probe(address) {
    const here = pageOrigin()
    const typed = address.trim().replace(/\/+$/, '')
    const same = typed === window.location.host || typed === here || ('http://' + typed) === here || ('https://' + typed) === here
    if (!same) throw new Error(`In a browser, Playpex uses the server this page came from. Open ${typed}/m/ to use that one.`)
    return serverAt(here)
  },
}

/** A browser pairs for an httpOnly cookie: the page never holds the token */
export const pairingMode: PairingMode = { clientId: WEB_CLIENT_ID, cookie: true }

/** What this browser decodes natively (the rest the server converts: GET /media/{ref}/playback) */
export function decoders(): { video: string[]; maxHeight: number } {
  const c = browserCapabilities()
  return { video: c.video, maxHeight: c.maxHeight }
}

export function describeThisDevice(): DeviceDescription {
  const { containers, video, audio, hls, maxHeight } = browserCapabilities()
  return { name: browserName(), platform: platformName(), capabilities: { containers, video, audio, hls, maxHeight } }
}
