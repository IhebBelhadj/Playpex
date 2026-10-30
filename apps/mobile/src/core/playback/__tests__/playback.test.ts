import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { FakeServer, settle } from '../../__tests__/fakeServer'
import type { PlaySource, PlayTitle } from '../../services/playback'
import { SessionRegistry } from '../registry'
import { PlayRequest } from '../request'
import { KEEPALIVE_MS, PROGRESS_MS, PlaybackSession } from '../session'

const MOVIE: PlayTitle = { mediaType: 'movie', tmdbId: 45745, imdbId: 'tt1727587', title: 'Sintel', year: 2010, posterPath: null, backdropPath: null }

function source(fields: Partial<PlaySource>): PlaySource {
  return { id: 'x', type: 'file', provider: 'library', label: 'Sintel.mkv', playable: 'yes', badges: [], notes: [], ...fields } as PlaySource
}

const FILE = source({ id: 'f_7', ref: 'f_7', type: 'file' })
const TORRENT = source({ id: 'torrent:abc', type: 'torrent', magnet: 'magnet:?xt=urn:btih:abc', infoHash: 'abc', label: 'Sintel 1080p' })

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] })
})
afterEach(() => {
  jest.useRealTimers()
})

describe('PlayRequest', () => {
  function server() {
    return new FakeServer()
      .on('POST /play/sources', { body: { request: 'r1', sources: [FILE, TORRENT], groups: [], hidden: [], policy: { autoplay: 'f_7' }, errors: [] } })
      .on('POST /play/start', (call) => ({ body: { action: 'play', source: (call.body as { source: string }).source === 'f_7' ? FILE : TORRENT } }))
  }

  it('never starts anything by itself, even with the server’s autoplay or a resume point', async () => {
    const s = server()
    const registry = new SessionRegistry()
    const request = new PlayRequest({ client: s.client, profileId: 'p1', title: MOVIE, resume: { positionS: 600, fileId: '7' }, registry })
    request.start()
    await settle(5000)
    expect(request.state.get().sources).toMatchObject({ kind: 'loaded' })
    expect(s.sent('POST', '/play/start')).toHaveLength(0)
    expect(registry.size).toBe(0)
    expect(request.resumedSource()?.id).toBe('f_7')
  })

  it('a tap starts the source: the resumed release from its second, another one from the start', async () => {
    const s = server()
    const registry = new SessionRegistry()
    const request = new PlayRequest({ client: s.client, profileId: 'p1', title: MOVIE, resume: { positionS: 600, fileId: '7' }, registry })
    request.start()
    await settle()
    const resumed = await request.choose(FILE, { resume: true })
    expect(registry.take(resumed!.sessionId)?.startAt).toBe(600)
    const other = await request.choose(TORRENT, { resume: true })
    expect(registry.take(other!.sessionId)?.startAt).toBe(0)
    const fromStart = await request.choose(FILE)
    expect(registry.take(fromStart!.sessionId)?.startAt).toBe(0)
  })

  it('shows a plugin’s question, and plays once confirmed', async () => {
    const s = new FakeServer()
      .on('POST /play/sources', { body: { request: 'r1', sources: [TORRENT], groups: [], hidden: [], policy: { autoplay: null }, errors: [] } })
      .on('POST /play/start', (call) =>
        (call.body as { confirmed?: boolean }).confirmed
          ? { body: { action: 'play', source: TORRENT } }
          : { body: { action: 'ask', question: 'Use Real-Debrid?', yes: 'Yes', no: 'No', by: 'The Crew' } },
      )
    const registry = new SessionRegistry()
    const request = new PlayRequest({ client: s.client, profileId: 'p1', title: MOVIE, resume: null, registry })
    request.start()
    await settle()
    expect(await request.choose(TORRENT)).toBeNull()
    expect(request.state.get().question?.question).toBe('Use Real-Debrid?')
    expect(await request.choose(TORRENT, { confirmed: true })).not.toBeNull()
    expect(registry.size).toBe(1)
  })

  it('finds the resumed torrent again once it became a file on the server', async () => {
    const FINISHED = source({ id: 'f_9', ref: 'f_9', type: 'file', label: 'Sintel.2010.720p.mp4' })
    const s = new FakeServer().on('POST /play/sources', { body: { request: 'r1', sources: [TORRENT, FINISHED], groups: [], hidden: [], policy: { autoplay: null }, errors: [] } })
    const request = new PlayRequest({
      client: s.client,
      profileId: 'p1',
      title: MOVIE,
      resume: { positionS: 120, infoHash: 'gone', filePath: 'Sintel (2010)/Sintel.2010.720p.mp4' },
      registry: new SessionRegistry(),
    })
    request.start()
    await settle()
    expect(request.resumedSource()?.id).toBe('f_9')
  })

  it('completes a title opened without its IMDb id before asking for sources', async () => {
    const s = new FakeServer()
      .on('GET /catalog/titles/movie/45745', { body: { mediaType: 'movie', tmdbId: 45745, imdbId: 'tt1727587', title: 'Sintel', originalTitle: 'Sintel', originalLanguage: 'en', year: '2010', posterPath: null, backdropPath: null } })
      .on('POST /play/sources', { body: { request: 'r1', sources: [], groups: [], hidden: [], policy: { autoplay: null }, errors: [] } })
    const request = new PlayRequest({ client: s.client, profileId: 'p1', title: { ...MOVIE, imdbId: null }, resume: null, registry: new SessionRegistry() })
    request.start()
    await settle()
    expect(s.sent('POST', '/play/sources')[0].body).toMatchObject({ imdbId: 'tt1727587' })
    expect(request.title.imdbId).toBe('tt1727587')
  })

  it('shows a refusal and plays nothing', async () => {
    const s = server().on('POST /play/start', { body: { action: 'refuse', reason: 'Not on a kids profile', by: 'Velvet' } })
    const registry = new SessionRegistry()
    const request = new PlayRequest({ client: s.client, profileId: 'p1', title: MOVIE, resume: null, registry })
    request.start()
    await settle()
    expect(await request.choose(FILE)).toBeNull()
    expect(request.state.get().refusal).toEqual({ reason: 'Not on a kids profile', by: 'Velvet' })
    expect(registry.size).toBe(0)
  })
})

describe('PlaybackSession', () => {
  it('a file: ready at once, keepalive every minute, progress only once it plays, released on stop', async () => {
    const s = new FakeServer().on('POST /media/f_7/keepalive', { body: { ok: true } }).on('PUT /profiles/p1/progress/movie/45745', { body: {} }).on('DELETE /media/f_7', { body: { ok: true } })
    const session = new PlaybackSession({ client: s.client, profileId: 'p1', title: MOVIE, source: FILE, startAt: 0 })
    session.start()
    await settle()
    const status = session.state.get().status
    expect(status.phase === 'ready' && status.stream.uri).toBe('http://10.0.0.2:28470/api/v1/media/f_7')
    expect(status.phase === 'ready' && status.stream.headers).toContain('Authorization: Bearer tok')
    await settle(PROGRESS_MS + 100)
    expect(s.sent('PUT', '/profiles/p1/progress/movie/45745')).toHaveLength(0) // not playing yet
    session.report({ position: 30, duration: 888, paused: false })
    await settle(PROGRESS_MS)
    expect(s.sent('PUT', '/profiles/p1/progress/movie/45745').at(-1)?.body).toMatchObject({ positionS: 30, durationS: 888, fileId: '7' })
    await settle(KEEPALIVE_MS)
    expect(s.sent('POST', '/media/f_7/keepalive').length).toBeGreaterThanOrEqual(1)
    session.report({ position: 31, duration: 888, paused: true })
    await settle()
    const saves = s.sent('PUT', '/profiles/p1/progress/movie/45745').length
    session.stop()
    session.stop()
    await settle()
    expect(s.sent('PUT', '/profiles/p1/progress/movie/45745').length).toBe(saves + 1)
    expect(s.sent('DELETE', '/media/f_7')).toHaveLength(1)
    const after = s.calls.length
    await settle(KEEPALIVE_MS * 2)
    expect(s.calls.length).toBe(after) // nothing runs after stop
  })

  it('a torrent left before its file is known releases the torrent', async () => {
    const s = new FakeServer()
      .on('POST /torrents', { body: { infoHash: 'abc' } })
      .on('GET /torrents/abc', { body: { infoHash: 'abc' } })
      .on('GET /torrents/abc/stats', { body: { peers: { total: 3 } } })
      .on('DELETE /torrents/abc', { body: { ok: true } })
    const session = new PlaybackSession({ client: s.client, profileId: 'p1', title: MOVIE, source: TORRENT, startAt: 0 })
    session.start()
    await settle(4000)
    expect(session.state.get().status).toMatchObject({ phase: 'preparing', message: 'Connecting to 3 peers…' })
    session.stop()
    await settle(10_000)
    expect(s.sent('DELETE', '/torrents/abc')).toHaveLength(1)
    expect(s.sent('GET', '/torrents/abc').length).toBeLessThanOrEqual(3) // the wait stopped
  })

  it('a torrent plays the file the server chose, and switches files on the same lease', async () => {
    const files = [
      { name: 'S01E01.mkv', path: 'BB/S01E01.mkv', ref: 't_abc_1', link: '', length: 100, offset: 0, selected: true },
      { name: 'S01E02.mkv', path: 'BB/S01E02.mkv', ref: 't_abc_2', link: '', length: 100, offset: 100, selected: false },
    ]
    const s = new FakeServer()
      .on('POST /torrents', { body: { infoHash: 'abc' } })
      .on('GET /torrents/abc', { body: { infoHash: 'abc', files, chosen: 'BB/S01E01.mkv', progress: [0, 90, 10] } })
      .on('DELETE /media/t_abc_2', { body: { ok: true } })
    const session = new PlaybackSession({ client: s.client, profileId: 'p1', title: { ...MOVIE, mediaType: 'tv', season: 1, episode: 1 }, source: TORRENT, startAt: 0 })
    session.start()
    await settle()
    expect(s.sent('GET', '/torrents/abc')[0].query).toBe('?season=1&episode=1')
    const ready = session.state.get()
    expect(ready.status.phase === 'ready' && ready.status.target.ref).toBe('t_abc_1')
    expect(ready.downloaded).toEqual([0, 90, 10])
    session.switchFile(files[1] as never)
    const switched = session.state.get().status
    expect(switched.phase === 'ready' && switched.target.ref).toBe('t_abc_2')
    expect(s.sent('DELETE', '/media/t_abc_1')).toHaveLength(0)
    session.stop()
    await settle()
    expect(s.sent('DELETE', '/media/t_abc_2')).toHaveLength(1)
  })

  it('a keepalive answering 404 ends it with words', async () => {
    const s = new FakeServer().on('POST /media/f_7/keepalive', { status: 404, body: { error: 'gone', code: 'NOT_FOUND' } })
    const session = new PlaybackSession({ client: s.client, profileId: 'p1', title: MOVIE, source: FILE, startAt: 0 })
    session.start()
    await settle(KEEPALIVE_MS + 200)
    expect(session.state.get().status).toEqual({ phase: 'failed', message: 'The server no longer has this file.' })
    session.stop()
  })
})
