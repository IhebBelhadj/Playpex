import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { FakeServer, settle } from '../../__tests__/fakeServer'
import { PlaybackSession } from '../../playback/session'
import type { PlaySource } from '../../services/playback'
import { Emitter } from '../../util/emitter'
import { CONTROLS_HIDE_MS, DOUBLE_TAP_MS, PlayerController, SKIP_SETTLE_MS } from '../controller'
import type { PlayerEvents, PlayerPort } from '../port'

class FakePlayer implements PlayerPort {
  events = new Emitter<PlayerEvents>()
  loads: { uri: string; startAt: number }[] = []
  seeks: number[] = []
  paused = false
  load(stream: { uri: string }, startAt: number) {
    this.loads.push({ uri: stream.uri, startAt })
  }
  play() {
    this.paused = false
  }
  pause() {
    this.paused = true
  }
  seekTo(s: number) {
    this.seeks.push(s)
  }
  setSpeed() {}
  tracks = async () => []
  selectAudio() {}
  selectSubtitle() {}
  addSubtitle() {}
  addAudio() {}
  setProperty() {}
  info = async () => ({ decoder: 'hardware' as const, videoCodec: '', audioCodec: '', width: 0, height: 0, fps: 0, videoBitrate: 0, audioBitrate: 0, hdr: false })
}

const FILE = { id: 'f_7', ref: 'f_7', type: 'file', provider: 'library', label: 'Sintel', playable: 'yes', badges: [], notes: [] } as unknown as PlaySource
const TITLE = { mediaType: 'movie' as const, tmdbId: 1, imdbId: null, title: 'Sintel', year: null, posterPath: null, backdropPath: null }

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] })
})
afterEach(() => {
  jest.useRealTimers()
})

function setup(startAt = 0) {
  const server = new FakeServer().on('DELETE /media/f_7', { body: { ok: true } })
  const session = new PlaybackSession({ client: server.client, profileId: 'p1', title: TITLE, source: FILE, startAt })
  const player = new FakePlayer()
  const controller = new PlayerController(session, player)
  return { server, session, player, controller }
}

describe('PlayerController', () => {
  it('loads the session’s stream once, at the resume point', async () => {
    const { player, controller } = setup(600)
    controller.start()
    await settle()
    expect(player.loads).toEqual([{ uri: 'http://10.0.0.2:28470/api/v1/media/f_7', startAt: 600 }])
    controller.stop()
  })

  it('gathers double taps into one seek: three taps forward = +30 s', async () => {
    const { player, controller } = setup()
    controller.start()
    await settle()
    player.events.emit('progress', { position: 100, duration: 900, bufferedTo: 160, cacheAhead: 60, networkRate: 0 })
    controller.skip(1)
    controller.skip(1)
    await settle(SKIP_SETTLE_MS - 100)
    controller.skip(1)
    expect(controller.state.get().skip).toBe(30)
    await settle(SKIP_SETTLE_MS + 100)
    expect(player.seeks).toEqual([130])
    expect(controller.state.get().skip).toBeNull()
    controller.skip(-1)
    controller.skip(1) // another direction starts again
    expect(controller.state.get().skip).toBe(10)
    controller.stop()
  })

  it('a double tap then single taps on the same side keep adding: 10, 20, 30', async () => {
    const { player, controller } = setup()
    controller.start()
    await settle()
    player.events.emit('progress', { position: 300, duration: 900, bufferedTo: 0, cacheAhead: 0, networkRate: 0 })
    controller.doubleTap(-1)
    controller.tap(-1)
    controller.tap(-1)
    expect(controller.state.get().skip).toBe(-30)
    await settle(SKIP_SETTLE_MS + 100)
    expect(player.seeks).toEqual([270])
    const controls = controller.state.get().controls
    controller.tap(1) // nothing gathering: the controls come or go
    expect(controller.state.get().controls).toBe(!controls)
    controller.doubleTap(0)
    expect(player.paused).toBe(true)
    controller.stop()
  })

  it('times presses on the video: one is a tap once the window passed, two a double tap', async () => {
    const { player, controller } = setup()
    controller.start()
    await settle()
    player.events.emit('progress', { position: 300, duration: 900, bufferedTo: 0, cacheAhead: 0, networkRate: 0 })
    const controls = controller.state.get().controls
    controller.press(0, 1000)
    expect(controller.state.get().controls).toBe(controls) // not yet: a second tap may follow
    await settle(DOUBLE_TAP_MS + 50)
    expect(controller.state.get().controls).toBe(!controls)
    controller.press(0, 5000)
    controller.press(0, 5100)
    expect(player.paused).toBe(true) // middle double tap: pause
    controller.press(1, 9000)
    controller.press(1, 9100)
    controller.press(1, 9500) // a further tap while gathering adds ten more at once
    expect(controller.state.get().skip).toBe(20)
    await settle(SKIP_SETTLE_MS + 100)
    expect(player.seeks).toEqual([320])
    controller.press(-1, 20000)
    controller.press(1, 20100) // two sides: not a double tap
    expect(controller.state.get().skip).toBe(null)
    controller.stop()
  })

  it('hides the controls while playing, keeps them while paused', async () => {
    const { player, controller } = setup()
    controller.start()
    await settle()
    player.events.emit('status', 'playing')
    await settle(CONTROLS_HIDE_MS + 100)
    expect(controller.state.get().controls).toBe(false)
    player.events.emit('status', 'paused')
    await settle(CONTROLS_HIDE_MS + 100)
    expect(controller.state.get().controls).toBe(true)
    controller.stop()
  })

  it('tells the screen when the video has finished, and stops the session with it', async () => {
    const { server, player, controller } = setup()
    const finished = jest.fn()
    controller.events.on('finished', finished)
    controller.start()
    await settle()
    player.events.emit('ended', { reason: 'ended' })
    expect(finished).toHaveBeenCalledTimes(1)
    controller.stop()
    await settle()
    expect(server.sent('DELETE', '/media/f_7')).toHaveLength(1)
  })
})

describe('PlayerController and the server', () => {
  type Remote = ConstructorParameters<typeof PlayerController>[5]
  function remoteSetup() {
    const server = new FakeServer()
      .on('DELETE /media/f_7', { body: { ok: true } })
      .on('POST /media/f_7/keepalive', { body: { ok: true, sessionId: 'sess-1' } })
    const session = new PlaybackSession({ client: server.client, profileId: 'p1', title: TITLE, source: FILE, startAt: 0 })
    const player = new FakePlayer()
    const remote = new Emitter() as NonNullable<Remote>
    const controller = new PlayerController(session, player, () => {}, null, null, remote)
    return { server, session, player, remote, controller }
  }
  const command = (action: string, extra: Record<string, unknown> = {}) =>
    Object.assign({ sessionId: 'sess-1', infoHash: null, ref: 'f_7', action, by: 'admin' }, extra) as never

  it('obeys the admin’s commands for its own session only, and tells the server at once', async () => {
    const { server, player, remote, controller } = remoteSetup()
    controller.start()
    await settle()
    expect(server.sent('POST', '/media/f_7/keepalive')).toHaveLength(1) // the first one, at once: its session id
    player.events.emit('loaded', { duration: 600 })
    player.events.emit('status', 'playing')
    player.events.emit('progress', { position: 100, duration: 600, bufferedTo: 120, cacheAhead: 0, networkRate: 0 })

    remote.emit('session.command', command('pause', { sessionId: 'someone-else', ref: 'f_9' }))
    expect(player.paused).toBe(false)
    remote.emit('session.command', command('pause'))
    expect(player.paused).toBe(true)
    player.events.emit('status', 'paused')
    await settle(600)
    expect(server.sent('POST', '/media/f_7/keepalive').length).toBeGreaterThanOrEqual(2) // the pause, reported
    remote.emit('session.command', command('resume'))
    expect(player.paused).toBe(false)
    remote.emit('session.command', command('seek', { positionS: 30 }))
    remote.emit('session.command', command('seekBy', { deltaS: -10 }))
    expect(player.seeks).toEqual([30, 20]) // −10 s from where the seek put it
    controller.stop()
  })

  it('closes on stop, and when its session ends on the server', async () => {
    const { remote, controller } = remoteSetup()
    const stopped = jest.fn()
    controller.events.on('stoppedByServer', stopped)
    controller.start()
    await settle()
    remote.emit('session.ended', { id: 'another', deviceId: 'd', infoHash: null, ref: 'f_7' })
    expect(stopped).not.toHaveBeenCalled()
    remote.emit('session.ended', { id: 'sess-1', deviceId: 'd', infoHash: null, ref: 'f_7' })
    expect(stopped).toHaveBeenCalledTimes(1)
    remote.emit('session.command', command('stop'))
    expect(stopped).toHaveBeenCalledTimes(2)
    controller.stop()
  })
})
