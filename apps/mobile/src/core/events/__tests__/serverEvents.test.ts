import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { ApiClient } from '../../http/client'
import { ServerEvents } from '../serverEvents'

class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor(
    public url: string,
    public headers: Record<string, string>,
  ) {}
  close() {
    this.closed = true
  }
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] })
})
afterEach(() => {
  jest.useRealTimers()
})

describe('ServerEvents', () => {
  const client = new ApiClient({ id: 's', name: 'S', url: 'http://10.0.0.2:28470', token: 'tok' }, 'm-1', () => {})

  it('opens the socket with the credentials and delivers the topics it knows', () => {
    const sockets: FakeSocket[] = []
    const events = new ServerEvents(client, (url, headers) => {
      const s = new FakeSocket(url, headers)
      sockets.push(s)
      return s as unknown as WebSocket
    })
    const changed: unknown[] = []
    events.events.on('library.changed', (d) => changed.push(d))
    events.start()
    expect(sockets[0].url).toBe('ws://10.0.0.2:28470/api/v1/events?topics=library,plugin,settings,download,session.ended')
    expect(sockets[0].headers.Authorization).toBe('Bearer tok')
    sockets[0].onmessage?.({ data: JSON.stringify({ topic: 'library.changed', data: { folderId: null } }) })
    sockets[0].onmessage?.({ data: JSON.stringify({ topic: 'log', data: {} }) })
    sockets[0].onmessage?.({ data: 'not json' })
    expect(changed).toEqual([{ folderId: null }])
    events.stop()
  })

  it('reconnects with back-off, and never after stop', () => {
    const sockets: FakeSocket[] = []
    const events = new ServerEvents(client, (url, headers) => {
      const s = new FakeSocket(url, headers)
      sockets.push(s)
      return s as unknown as WebSocket
    })
    events.start()
    sockets[0].onclose?.()
    jest.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    jest.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    sockets[1].onclose?.()
    jest.advanceTimersByTime(2000)
    expect(sockets).toHaveLength(3)
    events.stop()
    expect(sockets[2].closed).toBe(true)
    jest.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(3)
  })
})
