import { jest } from '@jest/globals'
import { ApiClient } from '../http/client'

// A server for unit tests: answers `METHOD /path` (under /api/v1, no query) from
// `routes`, records every call, 404s the rest. Replaces global fetch.

export type Call = { method: string; path: string; query: string; body: unknown }
type Answer = { status?: number; body?: unknown }
type Route = (call: Call) => Answer | undefined

export class FakeServer {
  readonly calls: Call[] = []
  readonly client: ApiClient
  private readonly routes = new Map<string, Route>()

  constructor() {
    globalThis.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)
      const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text()
      const call: Call = { method: request.method, path: url.pathname.replace(/^\/api\/v1/, ''), query: url.search, body: text ? JSON.parse(text) : null }
      this.calls.push(call)
      const route = this.routes.get(`${call.method} ${call.path}`)
      const answer = route?.(call) ?? { status: 404, body: { error: 'not found', code: 'NOT_FOUND' } }
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    // after fetch is replaced: openapi-fetch keeps the fetch it finds when the client is made
    this.client = new ApiClient({ id: 's', name: 'Test', url: 'http://10.0.0.2:28470', token: 'tok' }, 'm-test', () => {})
  }

  on(route: string, answer: Route | Answer): this {
    this.routes.set(route, typeof answer === 'function' ? answer : () => answer)
    return this
  }

  sent(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path)
  }
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
