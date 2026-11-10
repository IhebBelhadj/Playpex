import { describe, expect, it } from '@jest/globals'
import type { LinkItem } from '../search'
import { linkSource } from '../search'
import { castRequest } from '../../cast/caster'
import { embedRequest, itemLine, playsHere, sharedLink } from '../share'

const YOUTUBE: LinkItem = {
  kind: 'youtube',
  label: 'Never Gonna Give You Up',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  embed: { provider: 'youtube', id: 'dQw4w9WgXcQ' },
  startS: 42,
  image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  author: 'Rick Astley',
  size: null,
  contentType: null,
}

describe('sharedLink', () => {
  it('finds the link in what an app shares', () => {
    expect(sharedLink('Watch "Never Gonna Give You Up" on YouTube https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('https://youtu.be/dQw4w9WgXcQ?si=abc')
    expect(sharedLink('https://example.com/film.mp4')).toBe('https://example.com/film.mp4')
    expect(sharedLink('Look (https://example.com/page).')).toBe('https://example.com/page')
    expect(sharedLink('magnet:?xt=urn:btih:abcdef&dn=x')).toBe('magnet:?xt=urn:btih:abcdef&dn=x')
    expect(sharedLink('hash D3ADBEEFD3ADBEEFD3ADBEEFD3ADBEEFD3ADBEEF')).toBe('d3adbeefd3adbeefd3adbeefd3adbeefd3adbeef')
  })

  it('has none in plain words', () => {
    expect(sharedLink('just some words')).toBeNull()
    expect(sharedLink('')).toBeNull()
  })
})

describe('what a found item does', () => {
  it('a YouTube video plays on a screen only, as the core embed, from the link’s start, nothing saved', () => {
    expect(playsHere(YOUTUBE)).toBe(false)
    expect(itemLine(YOUTUBE)).toBe('YouTube · Rick Astley')
    expect(embedRequest(YOUTUBE, 'p1')).toEqual({
      title: 'Never Gonna Give You Up',
      subtitle: 'Rick Astley',
      image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      source: { embed: { provider: 'youtube', id: 'dQw4w9WgXcQ' } },
      positionS: 42,
      profileId: 'p1',
      tracking: 'none',
    })
  })

  it('a .torrent from a page casts by its info hash, not its URL', () => {
    const torrent: LinkItem = { kind: 'torrent', label: 'Film', url: 'https://example.com/film.torrent', infoHash: 'a'.repeat(40), size: null, contentType: null }
    expect(playsHere(torrent)).toBe(true)
    expect(embedRequest(torrent, null)).toBeNull()
    const title = { mediaType: 'movie' as const, tmdbId: 0, imdbId: null, title: 'Film', year: null, posterPath: null, backdropPath: null }
    expect(castRequest(title, linkSource(torrent))?.source).toEqual({ magnet: 'a'.repeat(40) })
  })
})
