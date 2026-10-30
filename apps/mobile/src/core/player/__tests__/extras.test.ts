import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { FakeServer, settle } from '../../__tests__/fakeServer'
import { SessionRegistry } from '../../playback/registry'
import { PlaybackSession } from '../../playback/session'
import { nextEpisode, type PlaySource, type PlayTitle } from '../../services/playback'
import { Emitter } from '../../util/emitter'
import { DEFAULT_TUNING, PlayerController, tuningProperties } from '../controller'
import { Markers, UP_NEXT_S } from '../markers'
import type { PlayerEvents, PlayerPort } from '../port'
import { UpNext } from '../upNext'

class FakePlayer implements PlayerPort {
  events = new Emitter<PlayerEvents>()
  properties: [string, string][] = []
  audio: number[] = []
  subtitles: (number | null)[] = []
  added: string[] = []
  load() {}
  play() {}
  pause() {}
  seekTo() {}
  setSpeed() {}
  tracks = async () => []
  selectAudio(id: number) {
    this.audio.push(id)
  }
  selectSubtitle(id: number | null) {
    this.subtitles.push(id)
  }
  addSubtitle(url: string) {
    this.added.push(url)
  }
  addAudio(url: string) {
    this.added.push(url)
  }
  setProperty(name: string, value: string) {
    this.properties.push([name, value])
  }
  info = async () => ({ decoder: 'hardware' as const, videoCodec: '', audioCodec: '', width: 0, height: 0, fps: 0, videoBitrate: 0, audioBitrate: 0, hdr: false })
}

const SHOW: PlayTitle = { mediaType: 'tv', tmdbId: 1396, imdbId: 'tt0903747', title: 'Breaking Bad', year: 2008, season: 1, episode: 7, posterPath: null, backdropPath: null }
const FILE = { id: 'f_7', ref: 'f_7', type: 'file', provider: 'library', label: 'Breaking Bad S01E07', playable: 'yes', badges: [], notes: [] } as unknown as PlaySource
const ep = (n: number, airDate = '2008-03-09') => ({ seasonNumber: 1, episodeNumber: n, name: `Episode ${n}`, overview: '', airDate, runtime: 47, stillPath: null, voteAverage: 8, voteCount: 1, crew: [], guestStars: [] })

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] })
})
afterEach(() => {
  jest.useRealTimers()
})

describe('tuningProperties', () => {
  it('sends only what changed, as mpv properties', () => {
    expect(tuningProperties({ subtitleDelay: 0.5 }, { ...DEFAULT_TUNING, subtitleDelay: 0.5 })).toEqual([['sub-delay', '0.5']])
    expect(tuningProperties({ picture: 'fill' }, { ...DEFAULT_TUNING, picture: 'fill' })).toEqual([
      ['panscan', '1.0'],
      ['keepaspect', 'yes'],
    ])
    expect(tuningProperties({ subtitleBackground: true }, { ...DEFAULT_TUNING, subtitleBackground: true })[0]).toEqual(['sub-border-style', 'background-box'])
  })
})

describe('PlayerController extras', () => {
  it('restores the tracks saved with the resume point once the file opens, and keeps adjustments across files', async () => {
    const server = new FakeServer().on('DELETE /media/f_7', { body: { ok: true } })
    const session = new PlaybackSession({ client: server.client, profileId: 'p1', title: SHOW, source: FILE, startAt: 60, tracks: { audio: 'a:1', subtitle: 's:0' } })
    const player = new FakePlayer()
    const controller = new PlayerController(session, player)
    controller.start()
    await settle()
    controller.tune({ subtitleDelay: -1.5 })
    player.events.emit('loaded', { duration: 2800 })
    expect(player.audio).toEqual([2])
    expect(player.subtitles).toEqual([1])
    expect(player.properties).toContainEqual(['sub-delay', '-1.5'])
    controller.stop()
  })

  it('adds a torrent’s separate subtitle file from the server’s route, with what was chosen saved', async () => {
    const server = new FakeServer().on('DELETE /media/f_7', { body: { ok: true } })
    const session = new PlaybackSession({ client: server.client, profileId: 'p1', title: SHOW, source: FILE, startAt: 0 })
    const player = new FakePlayer()
    const controller = new PlayerController(session, player)
    controller.start()
    await settle()
    controller.addFileTrack({ id: 's:f3', source: 'file', ref: 't_x', name: 'Subs/English.srt', language: 'en', languageName: 'English' }, 'subtitle')
    expect(player.added).toEqual(['http://10.0.0.2:28470/api/v1/media/f_7/subtitles/file/f3'])
    controller.stop()
  })
})

describe('Markers', () => {
  it('offers Skip intro inside an intro, and Up next from the credits', async () => {
    const server = new FakeServer().on('POST /play/markers', {
      body: {
        markers: [
          { plugin: 'p', kind: 'intro', start: 30, end: 90 },
          { plugin: 'p', kind: 'credits', start: 2700 },
        ],
      },
    })
    const markers = new Markers(server.client, SHOW, true)
    markers.load('f_7', 2800, { name: 'a/b.mkv' })
    markers.load('f_7', 2800, { name: 'a/b.mkv' })
    await settle()
    expect(server.sent('POST', '/play/markers')).toHaveLength(1)
    expect(markers.skippable(45)?.kind).toBe('intro')
    expect(markers.skippable(89.5)).toBeNull()
    expect(markers.upNextWindow(2800)).toBe(100)
    markers.dismiss(markers.skippable(45)!)
    expect(markers.skippable(45)).toBeNull()
    expect(new Markers(server.client, SHOW, true).upNextWindow(2800)).toBe(UP_NEXT_S)
  })
})

describe('Up next', () => {
  it('finds the next episode of the season, else the first of the next season that aired', async () => {
    const server = new FakeServer()
      .on('GET /catalog/titles/tv/1396/seasons/1', { body: { tmdbId: 1396, seasonNumber: 1, name: '', overview: '', airDate: null, posterPath: null, episodes: [ep(6), ep(7)] } })
      .on('GET /catalog/titles/tv/1396', { body: { seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }] } })
      .on('GET /catalog/titles/tv/1396/seasons/2', { body: { episodes: [{ ...ep(1), seasonNumber: 2 }] } })
    const next = await nextEpisode(server.client, SHOW)
    expect(next?.title).toMatchObject({ season: 2, episode: 1, episodeName: 'Episode 1' })
    const unaired = new FakeServer().on('GET /catalog/titles/tv/1396/seasons/1', { body: { episodes: [ep(8, '2999-01-01')] } })
    expect(await nextEpisode(unaired.client, SHOW)).toBeNull()
  })

  it('plays the best source of the next episode from where the profile stopped in it', async () => {
    const source = { ...FILE, id: 's2', ref: 'f_8' }
    const server = new FakeServer()
      .on('GET /catalog/titles/tv/1396/seasons/1', { body: { episodes: [ep(7), ep(8)] } })
      .on('POST /play/sources', { body: { request: 'r1', sources: [source], groups: [], hidden: [], policy: { autoplay: 's2' }, errors: [] } })
      .on('POST /play/start', { body: { action: 'play', source } })
      .on('GET /profiles/p1/progress/tv/1396', { body: { resume: { positionS: 312 }, finished: false } })
    const registry = new SessionRegistry()
    const upNext = new UpNext(server.client, 'p1', SHOW, registry, true)
    upNext.start()
    await settle()
    expect(upNext.state.get().next?.code).toBe('S01 E08')
    const id = await upNext.play()
    const session = registry.take(id!)
    expect(session?.title).toMatchObject({ season: 1, episode: 8 })
    expect(session?.startAt).toBe(312)
    upNext.stop()
  })
})
