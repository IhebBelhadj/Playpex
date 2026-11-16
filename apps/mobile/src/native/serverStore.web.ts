import { API_PREFIX, CLIENT_HEADER_VALUE } from '../core/http/api'
import type { KnownServer, ServerStore } from '../core/session/ports'
import { browserDeviceId, pageOrigin } from '../web/browser'

// In a browser (docs/mobile-web-plan.md): nothing to keep. The server is the
// page's own, and whether this browser may use it is the server's answer:
// GET /devices/me with its device cookie (200: paired; 404: a local client,
// the server's own machine, no pairing; 401: pair first). The token never
// reaches the page (httpOnly), so `token` is null and `cookie` says so.

async function here(): Promise<KnownServer | null> {
  const url = pageOrigin()
  try {
    const info = await fetch(url + API_PREFIX + '/server').then((r) => (r.ok ? r.json() : null))
    if (!info?.id) return null
    const me = await fetch(url + API_PREFIX + '/devices/me', {
      headers: { 'X-Playpex-Client': CLIENT_HEADER_VALUE, 'X-Playpex-Device': browserDeviceId() },
    })
    if (me.status !== 200 && me.status !== 404) return null
    return { id: info.id, name: info.name ?? window.location.host, url, token: null, cookie: true, pairedAt: '' }
  } catch {
    return null
  }
}

export const serverStore: ServerStore = {
  deviceId: async () => browserDeviceId(),
  list: async () => {
    const server = await here()
    return server ? [server] : []
  },
  save: async () => {},
  move: async () => {},
  forget: async () => {},
  last: here,
}
