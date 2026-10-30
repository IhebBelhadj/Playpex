import * as SecureStore from 'expo-secure-store'
import type { KnownServer, ServerStore } from '../core/session/ports'

// The servers this phone knows, by id (never by address: docs/api/discovery.md),
// with their device tokens, in the platform's secret storage (Keystore /
// Keychain): one entry per server plus an index of ids, the last one used and
// this install's device id. The ServerStore port of core/session.

type Index = { ids: string[]; lastServerId: string | null; deviceId: string }

const INDEX_KEY = 'playpex.servers'
const serverKey = (id: string) => 'playpex.server.' + id

let index: Index | null = null

async function loadIndex(): Promise<Index> {
  if (index) return index
  const raw = await SecureStore.getItemAsync(INDEX_KEY)
  let parsed: Partial<Index> = {}
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    parsed = {}
  }
  index = {
    ids: Array.isArray(parsed.ids) ? parsed.ids : [],
    lastServerId: parsed.lastServerId ?? null,
    deviceId: parsed.deviceId || newDeviceId(),
  }
  if (!raw || !parsed.deviceId) await saveIndex()
  return index
}

async function saveIndex() {
  if (index) await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(index))
}

/** This install's own id: `?device=` and `deviceId` of PUT /devices/me (letters, digits, `-`) */
function newDeviceId(): string {
  let id = 'm-'
  for (let i = 0; i < 24; i++) id += Math.floor(Math.random() * 16).toString(16)
  return id
}

async function deviceId(): Promise<string> {
  return (await loadIndex()).deviceId
}

async function listServers(): Promise<KnownServer[]> {
  const { ids } = await loadIndex()
  const servers = await Promise.all(ids.map(getServer))
  return servers.filter((s): s is KnownServer => s != null)
}

async function getServer(id: string): Promise<KnownServer | null> {
  const raw = await SecureStore.getItemAsync(serverKey(id))
  try {
    return raw ? (JSON.parse(raw) as KnownServer) : null
  } catch {
    return null
  }
}

async function saveServer(server: KnownServer): Promise<void> {
  const idx = await loadIndex()
  await SecureStore.setItemAsync(serverKey(server.id), JSON.stringify(server))
  if (!idx.ids.includes(server.id)) idx.ids.push(server.id)
  idx.lastServerId = server.id
  await saveIndex()
}

/** A server answered at another address (found again by id): keep the token, update the URL */
async function moveServer(id: string, url: string): Promise<void> {
  const server = await getServer(id)
  if (server && server.url !== url) await SecureStore.setItemAsync(serverKey(id), JSON.stringify({ ...server, url }))
}

/** Drops its token (revoked: 401 PAIRING_REQUIRED) and forgets it */
async function forgetServer(id: string): Promise<void> {
  const idx = await loadIndex()
  await SecureStore.deleteItemAsync(serverKey(id))
  idx.ids = idx.ids.filter((i) => i !== id)
  if (idx.lastServerId === id) idx.lastServerId = null
  await saveIndex()
}

async function lastServer(): Promise<KnownServer | null> {
  const { lastServerId } = await loadIndex()
  return lastServerId ? getServer(lastServerId) : null
}

export const serverStore: ServerStore = {
  deviceId,
  list: listServers,
  save: saveServer,
  move: moveServer,
  forget: forgetServer,
  last: lastServer,
}
