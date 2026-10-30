import { describe, expect, it } from '@jest/globals'
import { FakeServer } from '../../__tests__/fakeServer'
import { findPage, finders, playSourceOf } from '../releases'

describe('Find releases', () => {
  it('lists torrent and stream providers, the default torrent one marked', async () => {
    const s = new FakeServer()
      .on('GET /releases/providers', { body: [{ id: 'plugin:yts', name: 'YTS', paged: true, default: true }] })
      .on('GET /search/providers', { body: [{ id: 'plugin:archive', name: 'Internet Archive', kinds: ['http'] }] })
    expect(await finders(s.client, 'movie')).toEqual([
      { id: 'plugin:yts', name: 'YTS', kind: 'torrents', default: true },
      { id: 'plugin:archive', name: 'Internet Archive', kind: 'streams', default: false },
    ])
    expect(s.sent('GET', '/releases/providers')[0].query).toBe('?kind=movie')
  })

  it('turns a torrent release into a source the player plays, keywords and quality sent', async () => {
    const s = new FakeServer().on('GET /releases/browse', {
      body: { provider: 'plugin:yts', page: 1, hasMore: true, torrents: [{ provider: 'plugin:yts', name: 'Sintel.2010.720p', hash: 'abc', magnet: 'magnet:?xt=urn:btih:abc', seeds: 24, size: 143e6, quality: '720p', title: 'Sintel', year: 2010 }] },
    })
    const page = await findPage(s.client, { id: 'plugin:yts', name: 'YTS', kind: 'torrents', default: true }, { kind: 'movie', q: 'sintel', quality: '720p', page: 1 })
    expect(s.sent('GET', '/releases/browse')[0].query).toBe('?kind=movie&provider=plugin%3Ayts&page=1&q=sintel&quality=720p')
    expect(page).toMatchObject({ page: 1, hasMore: true, items: [{ key: 'abc', kind: 'torrent', title: 'Sintel', seeds: 24 }] })
    expect(playSourceOf(page.items[0])).toMatchObject({ id: 'torrent:abc', type: 'torrent', magnet: 'magnet:?xt=urn:btih:abc', infoHash: 'abc' })
  })

  it('a stream provider needs keywords, and its files play by ref', async () => {
    const s = new FakeServer().on('GET /search/sources', { body: { provider: 'plugin:archive', page: 1, hasMore: false, items: [{ provider: 'archive', kind: 'file', label: 'Night of the Living Dead.mp4', ref: 'r_1', matches: true }] } })
    const archive = { id: 'plugin:archive', name: 'Internet Archive', kind: 'streams' as const, default: false }
    expect((await findPage(s.client, archive, { kind: 'movie', q: '', quality: null, page: 1 })).items).toEqual([])
    expect(s.calls).toHaveLength(0)
    const page = await findPage(s.client, archive, { kind: 'movie', q: 'living dead', quality: null, page: 1 })
    expect(playSourceOf(page.items[0])).toMatchObject({ id: 'r_1', type: 'plugin', ref: 'r_1', format: 'file' })
  })
})
