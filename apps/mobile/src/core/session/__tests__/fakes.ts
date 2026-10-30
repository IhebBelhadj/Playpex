import { jest } from '@jest/globals'
import type { Discovery, FoundServer, KnownServer, ServerStore } from '../ports'

export const HOME: KnownServer = { id: 'home', name: 'Home', url: 'http://10.0.0.2:28470', token: 'tok', pairedAt: '2026-10-01T00:00:00Z' }

export function found(server: Partial<FoundServer> & { id: string; url: string }): FoundServer {
  return { name: server.id, version: '0.9.0', apiVersion: 2, minApiVersion: 1, host: null, via: 'mdns', ...server }
}

export class FakeStore implements ServerStore {
  servers: KnownServer[]
  lastId: string | null
  constructor(servers: KnownServer[] = [], lastId: string | null = servers[0]?.id ?? null) {
    this.servers = servers
    this.lastId = lastId
  }
  deviceId = async () => 'm-test'
  list = async () => this.servers
  save = async (s: KnownServer) => {
    this.servers = [...this.servers.filter((x) => x.id !== s.id), s]
    this.lastId = s.id
  }
  move = async (id: string, url: string) => {
    this.servers = this.servers.map((s) => (s.id === id ? { ...s, url } : s))
  }
  forget = async (id: string) => {
    this.servers = this.servers.filter((s) => s.id !== id)
    if (this.lastId === id) this.lastId = null
  }
  last = async () => this.servers.find((s) => s.id === this.lastId) ?? null
}

/** Discovery that reports `servers` shortly after it starts, and counts how often it was stopped */
export class FakeDiscovery implements Discovery {
  available = true
  running = 0
  constructor(public servers: FoundServer[] = []) {}
  start(onServer: (s: FoundServer) => void) {
    this.running++
    const timers = this.servers.map((s) => setTimeout(() => onServer(s), 10))
    return () => {
      this.running--
      timers.forEach(clearTimeout)
    }
  }
  probe = async (address: string) => {
    const s = this.servers.find((x) => x.url.includes(address))
    if (!s) throw new Error('It didn’t answer.')
    return s
  }
}

type Route = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined

/** fetch answering from `route` (undefined: the network fails) */
export function fakeFetch(route: Route) {
  const fn = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const answer = route(url, init)
    if (!answer) throw new TypeError('Network request failed')
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  })
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

/** Moves the fake clock `ms` forward in 100 ms steps, letting the promises of each step settle */
export async function settle(ms = 0) {
  const steps = Math.max(1, Math.ceil(ms / 100))
  for (let i = 0; i < steps; i++) {
    await turn()
    if (ms) jest.advanceTimersByTime(Math.min(100, ms))
  }
  await turn()
}

/** A few rounds of real I/O and promises (fetch answers are read on setImmediate turns) */
async function turn() {
  for (let j = 0; j < 5; j++) {
    await new Promise<void>((resolve) => setImmediate(() => resolve()))
    await Promise.resolve()
  }
}
