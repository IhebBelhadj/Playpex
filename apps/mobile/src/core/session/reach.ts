import { API_PREFIX, API_VERSION } from '../http/api'
import type { Disposer } from '../util/disposer'
import { once } from '../util/once'
import type { Discovery } from './ports'

// Is a known server still where we left it (docs/api/discovery.md): GET /server
// at its URL answering with its id; else found again by id on the network.

export const REACH_TIMEOUT_MS = 3000
export const FIND_AGAIN_MS = 6000

/** GET /server at `url` answers with this id within the timeout */
export async function answers(url: string, id: string, timeoutMs = REACH_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url + API_PREFIX + '/server', { signal: controller.signal })
    const json = (await res.json()) as { id?: string }
    return res.ok && json?.id === id
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** The server's new URL, when discovery finds it within `ms`; null otherwise (or once `owner` is disposed) */
export function findAgain(discovery: Discovery, id: string, ms: number, owner: Disposer): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let stopTimer = () => {}
    let stopDiscovery = () => {}
    const finish = (url: string | null) => {
      if (settled) return
      settled = true
      stopTimer()
      stopDiscovery()
      resolve(url)
    }
    stopTimer = owner.timeout(ms, () => finish(null))
    stopDiscovery = owner.add(once(discovery.start((found) => found.id === id && finish(found.url))))
    if (settled) stopDiscovery() // found before start() returned
    owner.add(() => finish(null))
  })
}

/** Why a server can't be used by this version of the app, or null */
export function incompatibility(server: { apiVersion: number; minApiVersion?: number }): string | null {
  if (server.apiVersion < API_VERSION) return 'Update Playpex Media Server to use it from this app.'
  if ((server.minApiVersion ?? 1) > API_VERSION) return 'Update this app to use this server.'
  return null
}
