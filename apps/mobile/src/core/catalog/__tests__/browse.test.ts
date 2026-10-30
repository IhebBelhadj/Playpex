import { describe, expect, it } from '@jest/globals'
import { cleared, describe as sentence, discoverParams, emptyQuery, showsList, toggleGenre, tokens, type BrowseQuery } from '../browse'

const names: Record<number, string> = { 35: 'Comedy', 18: 'Drama', 80: 'Crime' }
const genreName = (id: number) => names[id]
const text = (q: BrowseQuery, mt: 'movie' | 'tv' = 'movie') => sentence(q, mt, genreName).map((p) => p.text).join('')
const today = new Date('2026-10-29T12:00:00Z')

describe('the See all query', () => {
  it('shows a list as it is until something narrows it', () => {
    const q = emptyQuery('now_playing')
    expect(showsList(q)).toBe(true)
    expect(text(q)).toBe('Now playing')
    const narrowed = toggleGenre(q, 35)
    expect(showsList(narrowed)).toBe(false)
    expect(text(narrowed)).toBe('Popular comedy movies')
    expect(discoverParams(narrowed, today).sort).toBe('popularity')
  })

  it('says what the page shows in a sentence', () => {
    const q: BrowseQuery = { ...emptyQuery(), sort: 'rating', genres: [35, 18], matchAll: true, era: '2010s', minRating: 7, language: 'ko' }
    expect(text(q, 'tv')).toBe('Best rated comedy and drama shows from the 2010s, rated 7+, in Korean')
    expect(text({ ...q, matchAll: false, genres: [35, 18, 80] })).toBe('Best rated comedy, drama or crime movies from the 2010s, rated 7+, in Korean')
  })

  it('asks the server for genres, an era, a score and a language', () => {
    const q: BrowseQuery = { ...emptyQuery(), genres: [35, 18], era: '1990s', minRating: 8, language: 'fr' }
    expect(discoverParams(q, today)).toEqual({ sort: 'popularity', genres: '35|18', minRating: 8, minVotes: 10, language: 'fr', from: '1990-01-01', to: '1999-12-31' })
    expect(discoverParams({ ...q, matchAll: true }, today).genres).toBe('35,18')
  })

  it('keeps unreleased titles out of Newest', () => {
    expect(discoverParams({ ...emptyQuery(), sort: 'newest' }, today).to).toBe('2026-10-29')
    expect(discoverParams({ ...emptyQuery(), sort: 'newest', era: 'older' }, today).to).toBe('1979-12-31')
  })

  it('lists the filters on as tokens that remove themselves', () => {
    const q: BrowseQuery = { ...emptyQuery(), genres: [35], era: 'thisYear', minRating: 6 }
    const list = tokens(q, genreName)
    expect(list.map((t) => t.label)).toEqual(['Comedy', 'This year', '6+'])
    expect(list[0].without.genres).toEqual([])
    expect(cleared({ ...q, sort: 'rating' })).toEqual({ ...emptyQuery(), sort: 'rating' })
  })
})
