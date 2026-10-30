import { describe, expect, it } from '@jest/globals'
import type { Found } from '../../services/releases'
import { NO_REFINE, codecOf, facets, qualityOf, refine, refineCount, whatOf } from '../refine'

const found = (over: Partial<Found>): Found => ({
  key: over.name ?? 'x',
  finder: 'yts',
  kind: 'torrent',
  title: over.name ?? 'x',
  name: 'x',
  year: null,
  season: null,
  episode: null,
  pack: false,
  seeds: 0,
  peers: null,
  size: null,
  quality: null,
  codec: null,
  audio: null,
  matches: true,
  ...over,
})

const A = found({ name: 'Night.2020.1080p.x265', quality: '1080p', seeds: 50, size: 2e9, finder: 'yts' })
const B = found({ name: 'Night S01E02 720p x264', quality: '720p', seeds: 900, size: 0.4e9, season: 1, episode: 2, finder: 'eztv' })
const C = found({ name: 'Night Season 1 2160p', quality: '2160p', seeds: 10, size: 40e9, season: 1, pack: true, finder: 'eztv', matches: false })
const ALL = [A, B, C]

describe('refine', () => {
  it('reads what a release is', () => {
    expect([qualityOf(A), qualityOf(B), qualityOf(C)]).toEqual(['1080p', '720p', '2160p'])
    expect([whatOf(A), whatOf(B), whatOf(C)]).toEqual(['film', 'episode', 'pack'])
    expect([codecOf(A), codecOf(B), codecOf(C)]).toEqual(['hevc', 'h264', 'other'])
  })

  it('ranks best matches first, then by seeds; or by size', () => {
    expect(refine(ALL, NO_REFINE).map((f) => f.name)).toEqual([B.name, A.name, C.name])
    expect(refine(ALL, { ...NO_REFINE, sort: 'largest' })[0]).toBe(C)
    expect(refine(ALL, { ...NO_REFINE, sort: 'smallest' })[0]).toBe(B)
  })

  it('filters by every group at once, and counts each option with the others on', () => {
    const r = { ...NO_REFINE, sources: ['eztv'], qualities: ['720p' as const] }
    expect(refine(ALL, r)).toEqual([B])
    expect(refineCount(r)).toBe(2)
    const f = facets(ALL, r)
    // quality counted among eztv's releases only, sources among 720p ones only
    expect(f.qualities.get('2160p')).toBe(1)
    expect(f.sources.get('yts')).toBeUndefined()
    expect(refine(ALL, { ...NO_REFINE, exact: true, sizes: ['huge'] })).toEqual([])
  })
})
