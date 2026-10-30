import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { ServerFinder } from '../finder'
import { PairingController } from '../pairing'
import { SessionController } from '../session'
import { FakeDiscovery, FakeStore, HOME, fakeFetch, found, settle } from './fakes'

const device = () => ({ name: 'Phone', platform: 'android', capabilities: { containers: [], video: [], audio: [], maxHeight: 1080 } })

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] })
})
afterEach(() => {
  jest.useRealTimers()
})

describe('SessionController', () => {
  it('connects to the last server where it answers', async () => {
    fakeFetch((url) => (url === HOME.url + '/api/v1/server' ? { status: 200, body: { id: 'home' } } : undefined))
    const session = new SessionController(new FakeStore([HOME]), new FakeDiscovery())
    await session.start()
    const state = session.state.get()
    expect(state.kind).toBe('connected')
    if (state.kind !== 'connected') return
    expect(state.profile).toBeNull()
    expect(state.client.headers().Authorization).toBe('Bearer tok')
  })

  it('finds the server again by id at its new address, and remembers it', async () => {
    const moved = 'http://10.0.0.9:28470'
    fakeFetch(() => undefined)
    const store = new FakeStore([HOME])
    const discovery = new FakeDiscovery([found({ id: 'other', url: 'http://x' }), found({ id: 'home', url: moved })])
    const session = new SessionController(store, discovery)
    const booting = session.start()
    await settle(4000)
    await booting
    const state = session.state.get()
    expect(state.kind === 'connected' && state.server.url).toBe(moved)
    expect((await store.last())?.url).toBe(moved)
    expect(discovery.running).toBe(0)
  })

  it('is unreachable when the server answers nowhere, and retries on demand', async () => {
    fakeFetch(() => undefined)
    const discovery = new FakeDiscovery()
    const session = new SessionController(new FakeStore([HOME]), discovery)
    const booting = session.start()
    await settle(10_000)
    await booting
    expect(session.state.get().kind).toBe('unreachable')
    expect(discovery.running).toBe(0)
    fakeFetch(() => ({ status: 200, body: { id: 'home' } }))
    await session.retry()
    expect(session.state.get().kind).toBe('connected')
  })

  it('without a known server, waits on the server list', async () => {
    const session = new SessionController(new FakeStore(), new FakeDiscovery())
    await session.start()
    expect(session.state.get()).toEqual({ kind: 'noServer', lost: null })
  })

  it('a revoked device forgets the server and says so', async () => {
    fakeFetch((url) => (url.endsWith('/server') ? { status: 200, body: { id: 'home' } } : { status: 401, body: { error: 'Pair again', code: 'PAIRING_REQUIRED' } }))
    const store = new FakeStore([HOME])
    const session = new SessionController(store, new FakeDiscovery())
    const changes: (string | null)[] = []
    session.events.on('serverChanged', (e) => changes.push(e.serverId))
    await session.start()
    const state = session.state.get()
    if (state.kind !== 'connected') throw new Error('not connected')
    await state.client.api.GET('/profiles')
    expect(session.state.get()).toEqual({ kind: 'noServer', lost: { code: 'PAIRING_REQUIRED', message: 'Pair again', serverName: 'Home' } })
    expect(store.servers).toEqual([])
    // booting into it was no change (nothing cached yet); losing it is
    expect(changes).toEqual([null])
  })

  it('keeps the profile chosen until left', async () => {
    fakeFetch(() => ({ status: 200, body: { id: 'home' } }))
    const session = new SessionController(new FakeStore([HOME]), new FakeDiscovery())
    await session.start()
    const profile = { id: 'p1', name: 'Iheb' } as never
    session.chooseProfile(profile)
    expect(session.state.get()).toMatchObject({ kind: 'connected', profile })
    session.leaveProfile()
    expect(session.state.get()).toMatchObject({ kind: 'connected', profile: null })
  })
})

describe('ServerFinder', () => {
  it('lists found and known servers once each, and stops discovery when stopped', async () => {
    const discovery = new FakeDiscovery([found({ id: 'home', url: HOME.url }), found({ id: 'office', url: 'http://10.0.0.7:28470' })])
    const session = new SessionController(new FakeStore([HOME]), discovery)
    const finder = new ServerFinder(new FakeStore([HOME, { ...HOME, id: 'old', name: 'Old', url: 'http://10.0.0.50:28470' }]), discovery, session)
    finder.start()
    await settle(100)
    const entries = finder.state.get().entries
    expect(entries.map((e) => [e.id, e.seen, e.paired])).toEqual([
      ['home', true, true],
      ['office', true, false],
      ['old', false, true],
    ])
    finder.stop()
    expect(discovery.running).toBe(0)
  })

  it('connects a paired server at once and sends another one to pairing', async () => {
    fakeFetch(() => ({ status: 200, body: { id: 'home' } }))
    const store = new FakeStore([HOME])
    const discovery = new FakeDiscovery()
    const session = new SessionController(store, discovery)
    const finder = new ServerFinder(store, discovery, session)
    finder.start()
    await settle()
    expect(await finder.choose(found({ id: 'home', url: 'http://10.0.0.3:28470' }))).toEqual({ kind: 'connected' })
    expect(session.state.get()).toMatchObject({ kind: 'connected', server: { url: 'http://10.0.0.3:28470' } })
    expect(await finder.choose(found({ id: 'new', name: 'New', url: 'http://n' }))).toEqual({ kind: 'pair', server: { id: 'new', name: 'New', url: 'http://n' } })
    expect(await finder.choose(found({ id: 'old', url: 'http://o', apiVersion: 1 }))).toEqual({ kind: 'refused' })
    expect(finder.state.get().error).toMatch(/Update Playpex Media Server/)
    finder.stop()
  })
})

describe('PairingController', () => {
  it('shows the code, polls until approved, describes the device and connects', async () => {
    let polls = 0
    const calls = fakeFetch((url) => {
      if (url.endsWith('/auth/device/code')) return { status: 200, body: { device_code: 'dc', user_code: 'ABCDEFGH', verification_uri: 'http://x/link', expires_in: 600, interval: 5 } }
      if (url.endsWith('/auth/device/token')) return ++polls < 2 ? { status: 400, body: { error: 'authorization_pending' } } : { status: 200, body: { access_token: 'new-token' } }
      if (url.endsWith('/devices/me')) return { status: 200, body: {} }
      return undefined
    })
    const store = new FakeStore()
    const session = new SessionController(store, new FakeDiscovery())
    await session.start()
    const pairing = new PairingController({ id: 'new', name: 'New', url: 'http://n' }, session, device)
    pairing.start()
    await settle()
    expect(pairing.state.get()).toMatchObject({ step: 'waiting', code: { user_code: 'ABCDEFGH' } })
    await settle(12_000)
    expect(session.state.get()).toMatchObject({ kind: 'connected', server: { id: 'new', token: 'new-token' } })
    expect(calls.mock.calls.some(([u]) => String(u).endsWith('/devices/me'))).toBe(true)
    expect(store.lastId).toBe('new')
  })

  it('stops polling when stopped, and asks for a new code on restart', async () => {
    let polls = 0
    fakeFetch((url) => {
      if (url.endsWith('/code')) return { status: 200, body: { device_code: 'dc', user_code: 'ABCDEFGH', verification_uri: 'u', expires_in: 600, interval: 5 } }
      polls++
      return { status: 400, body: { error: 'authorization_pending' } }
    })
    const session = new SessionController(new FakeStore(), new FakeDiscovery())
    const pairing = new PairingController({ id: 'n', name: 'N', url: 'http://n' }, session, device)
    pairing.start()
    await settle(6000)
    pairing.stop()
    const before = polls
    await settle(30_000)
    expect(polls).toBe(before)
    pairing.restart()
    await settle()
    expect(pairing.state.get().step).toBe('waiting')
    pairing.stop()
  })
})
