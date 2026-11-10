import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { FakeServer } from '../../__tests__/fakeServer'
import type { PlaySource, PlayTitle } from '../../services/playback'
import { Caster, castRequest } from '../caster'

const EPISODE: PlayTitle = { mediaType: 'tv', tmdbId: 1396, imdbId: 'tt0903747', title: 'Breaking Bad', year: 2008, season: 1, episode: 3, episodeName: 'And the Bag’s in the River', posterPath: '/p.jpg', backdropPath: null }
const FILE: PlaySource = { id: 'f_1', type: 'file', provider: 'library', label: 'Breaking Bad S01E03.mkv', ref: 'f_1' } as PlaySource
const TORRENT: PlaySource = { id: 'torrent:abc', type: 'torrent', provider: 'yts', label: 'Movie 1080p', infoHash: 'abc', magnet: 'magnet:?xt=urn:btih:abc', plugin: 'yts' } as PlaySource
const SCREEN = { deviceId: 'tv-1', name: 'Living room', kind: 'tv', self: false, online: true, accepts: { media: true, magnet: true, embed: true }, playing: null }

describe('castRequest', () => {
  it('sends a library file by its ref, the episode, the artwork, the position and the profile', () => {
    expect(castRequest(EPISODE, FILE, { positionS: 812.6, profileId: 'p1' })).toEqual({
      title: 'Breaking Bad',
      subtitle: 'S01E03 · And the Bag’s in the River',
      year: '2008',
      source: { ref: 'f_1' },
      item: { mediaType: 'tv', tmdbId: 1396, imdbId: 'tt0903747', season: 1, episode: 3 },
      artwork: { title: 'Breaking Bad', posterPath: '/p.jpg' },
      positionS: 812,
      profileId: 'p1',
      tracking: 'full',
    })
  })

  it('sends a torrent by its magnet, names its plugin, starts at the beginning', () => {
    const movie: PlayTitle = { mediaType: 'movie', tmdbId: 0, imdbId: null, title: 'Movie', year: null, posterPath: null, backdropPath: null }
    expect(castRequest(movie, TORRENT, { positionS: 3, tracking: 'none' })).toEqual({
      title: 'Movie',
      source: { magnet: 'magnet:?xt=urn:btih:abc' },
      pluginId: 'yts',
      tracking: 'none',
    })
  })

  it('has nothing to send for a source without a ref or a torrent', () => {
    expect(castRequest(EPISODE, { id: 'x', type: 'plugin', provider: 'p', label: 'x' } as PlaySource)).toBeNull()
  })
})

describe('Caster', () => {
  let server: FakeServer
  beforeEach(() => {
    jest.useFakeTimers()
    server = new FakeServer()
      .on('GET /cast/screens', { body: [SCREEN, { ...SCREEN, deviceId: 'm-test', name: 'This phone', self: true }] })
      .on('POST /cast/screens/tv-1/play', { status: 202, body: { castId: 'c1', delivered: 1 } })
      .on('POST /cast/c1/commands', { status: 202, body: { delivered: 1 } })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('lists the other screens, and a chosen one only while it is on', async () => {
    const caster = new Caster(server.client)
    caster.choose({ deviceId: 'tv-1', name: 'Living room' })
    expect(caster.targetOnline()).toBeNull()
    await caster.refresh()
    expect(caster.state.get().screens.map((s) => s.deviceId)).toEqual(['tv-1'])
    expect(caster.targetOnline()).toEqual({ deviceId: 'tv-1', name: 'Living room' })
  })

  it('casts to the chosen screen and follows its cast until it ends', async () => {
    const caster = new Caster(server.client)
    caster.choose(SCREEN)
    await caster.play({ title: EPISODE, source: FILE, tracking: 'full' }, { positionS: 60, profileId: 'p1' })
    expect(server.sent('POST', '/cast/screens/tv-1/play')[0].body).toMatchObject({ source: { ref: 'f_1' }, positionS: 60, profileId: 'p1' })
    expect(caster.state.get().cast?.castId).toBe('c1')

    const update = { ...caster.state.get().cast!, state: 'playing' as const, positionS: 75, durationS: 2800, sessionId: 's1' }
    caster.onCast('cast.updated', { ...update, castId: 'other' })
    expect(caster.state.get().cast?.state).toBe('opening')
    caster.onCast('cast.updated', update)
    expect(caster.state.get().cast).toMatchObject({ state: 'playing', positionS: 75, durationS: 2800 })
    caster.onCast('cast.ended', { ...update, state: 'ended' })
    expect(caster.state.get().cast).toBeNull()
  })

  it('drives the cast; Continue on phone stops it and hands back where it was', async () => {
    const caster = new Caster(server.client)
    caster.choose(SCREEN)
    await caster.play({ title: EPISODE, source: FILE, tracking: 'full' })
    caster.onCast('cast.updated', { ...caster.state.get().cast!, state: 'playing', positionS: 100 })
    await caster.command('toggle')
    expect(caster.state.get().cast?.state).toBe('paused')
    await caster.command('seekBy', { deltaS: 30 })
    expect(caster.state.get().cast?.positionS).toBe(130)
    expect(server.sent('POST', '/cast/c1/commands').map((c) => c.body)).toEqual([{ action: 'toggle' }, { action: 'seekBy', deltaS: 30 }])

    const back = await caster.takeBack()
    expect(back).toEqual({ casted: { title: EPISODE, source: FILE, tracking: 'full' }, positionS: 130 })
    expect(server.sent('POST', '/cast/c1/commands').at(-1)?.body).toEqual({ action: 'stop' })
    expect(caster.state.get().cast).toBeNull()
  })

  it('says why a cast was refused', async () => {
    server.on('POST /cast/screens/tv-1/play', { status: 403, body: { error: 'This profile is locked', code: 'CAST_REFUSED' } })
    const caster = new Caster(server.client)
    caster.choose(SCREEN)
    await expect(caster.play({ title: EPISODE, source: FILE, tracking: 'full' })).rejects.toThrow('This profile is locked')
    expect(caster.state.get()).toMatchObject({ cast: null, sending: false })
  })
})
