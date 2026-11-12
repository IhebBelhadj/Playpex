import { describe, expect, it } from '@jest/globals'
import type { LinkItem } from '../search'
import { linkSource } from '../search'
import { castRequest } from '../../cast/caster'
import { embedRequest, itemLine, pickFor, playsHere, screenOfShortcut, sharedLink, shortcutOf, takes } from '../share'

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

describe('straight to a screen', () => {
  const tv = { deviceId: 'tv-1', name: 'Living room', kind: 'tv' as const, self: false, online: true, accepts: { media: true, magnet: true, embed: true }, playing: null }
  const filesOnly = { ...tv, deviceId: 'web-1', accepts: { media: true, magnet: false, embed: false } }
  const video: LinkItem = { kind: 'video', label: 'film.mp4', url: 'https://example.com/film.mp4', ref: 'r_1', size: null, contentType: null }
  const magnet: LinkItem = { kind: 'magnet', label: 'Film', url: 'magnet:?xt=urn:btih:' + 'b'.repeat(40), infoHash: 'b'.repeat(40), size: null, contentType: null }

  it('a direct share target names its screen', () => {
    expect(shortcutOf('tv-1')).toBe('screen:tv-1')
    expect(screenOfShortcut('screen:tv-1')).toBe('tv-1')
    expect(screenOfShortcut('screen:')).toBeNull()
    expect(screenOfShortcut('other')).toBeNull()
    expect(screenOfShortcut(null)).toBeNull()
  })

  it('plays what the screen takes: the first of a page it can', () => {
    expect(takes(tv, YOUTUBE)).toBe(true)
    expect(takes(filesOnly, YOUTUBE)).toBe(false)
    expect(pickFor([YOUTUBE, video], filesOnly)).toBe(video)
    expect(pickFor([magnet, video], tv)).toBe(magnet)
    expect(pickFor([magnet, YOUTUBE], filesOnly)).toBeNull()
  })
})
