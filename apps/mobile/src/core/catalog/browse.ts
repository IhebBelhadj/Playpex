import { languageName } from '../util/languages'

// What the See all page shows, as one value: the list it was opened from (as
// the server ranks it), or the catalogue narrowed by genres, an era, a
// minimum score and an original language, in an order. Pure functions turn it
// into the server's query (GET /catalog/discover), into the sentence the page
// is titled with ("Best rated comedy movies from the 2010s"), and into the
// filters shown as removable tokens.

export type ListName = 'popular' | 'top_rated' | 'now_playing' | 'upcoming' | 'airing_today' | 'on_the_air' | 'trending'
export type DiscoverSort = 'popularity' | 'rating' | 'newest'
export type Era = 'thisYear' | '2020s' | '2010s' | '2000s' | '1990s' | '1980s' | 'older'

export type BrowseQuery = {
  /** The list the page was opened from */
  list: ListName | null
  /** 'list': as the list ranks its titles, while nothing narrows it (a list can't be filtered) */
  sort: DiscoverSort | 'list'
  genres: number[]
  /** Titles of every chosen genre, or of any of them */
  matchAll: boolean
  era: Era | null
  /** Minimum score, 0–10 */
  minRating: number | null
  /** Original language (ISO 639-1) */
  language: string | null
}

export const LIST_NAMES: Record<ListName, string> = {
  popular: 'Popular',
  top_rated: 'Top rated',
  now_playing: 'Now playing',
  upcoming: 'Coming soon',
  airing_today: 'Airing today',
  on_the_air: 'On the air',
  trending: 'Trending',
}

export const SORTS: { value: DiscoverSort; label: string; word: string }[] = [
  { value: 'popularity', label: 'Most popular', word: 'Popular' },
  { value: 'rating', label: 'Best rated', word: 'Best rated' },
  { value: 'newest', label: 'Newest', word: 'Newest' },
]

export const ERAS: { value: Era; label: string; phrase: string }[] = [
  { value: 'thisYear', label: 'This year', phrase: 'from this year' },
  { value: '2020s', label: '2020s', phrase: 'from the 2020s' },
  { value: '2010s', label: '2010s', phrase: 'from the 2010s' },
  { value: '2000s', label: '2000s', phrase: 'from the 2000s' },
  { value: '1990s', label: '1990s', phrase: 'from the 90s' },
  { value: '1980s', label: '1980s', phrase: 'from the 80s' },
  { value: 'older', label: 'Before 1980', phrase: 'from before 1980' },
]

export const RATINGS = [6, 7, 8] as const

export function isListName(value: string | null | undefined): value is ListName {
  return value != null && value in LIST_NAMES
}

export function emptyQuery(list: ListName | null = null): BrowseQuery {
  return { list, sort: list ? 'list' : 'popularity', genres: [], matchAll: false, era: null, minRating: null, language: null }
}

/** The page shows the list it was opened from as the server ranks it */
export function showsList(q: BrowseQuery): q is BrowseQuery & { list: ListName } {
  return q.list != null && q.sort === 'list' && !narrowed(q)
}

/** The order the catalogue is in: a list's order stands for "popular" once something narrows it */
export function effectiveSort(q: BrowseQuery): DiscoverSort {
  return q.sort === 'list' ? 'popularity' : q.sort
}

/** How many filters are on (the order isn't one) */
export function filterCount(q: BrowseQuery): number {
  return (q.genres.length ? 1 : 0) + (q.era ? 1 : 0) + (q.minRating != null ? 1 : 0) + (q.language ? 1 : 0)
}

function narrowed(q: BrowseQuery): boolean {
  return filterCount(q) > 0
}

export type DiscoverParams = {
  sort: DiscoverSort
  genres?: string
  minVotes: number
  minRating?: number
  from?: string
  to?: string
  language?: string
}

/** The query of GET /catalog/discover/{mediaType} */
export function discoverParams(q: BrowseQuery, today: Date = new Date()): DiscoverParams {
  const sort = effectiveSort(q)
  const params: DiscoverParams = { sort, minVotes: sort === 'rating' ? 300 : q.minRating != null ? 100 : 20 }
  if (q.genres.length) params.genres = q.genres.join(q.matchAll ? ',' : '|')
  if (q.minRating != null) params.minRating = q.minRating
  if (q.language) {
    params.language = q.language
    // Fewer people vote on titles outside the big markets
    params.minVotes = Math.min(params.minVotes, sort === 'rating' ? 50 : 10)
  }
  const range = q.era ? eraRange(q.era, today) : null
  if (range?.from) params.from = range.from
  if (range?.to) params.to = range.to
  // Newest first means what is out already, not what was announced for 2031
  if (sort === 'newest' && !params.to) params.to = isoDate(today)
  return params
}

function eraRange(era: Era, today: Date): { from?: string; to?: string } {
  const year = today.getFullYear()
  switch (era) {
    case 'thisYear':
      return { from: `${year}-01-01`, to: `${year}-12-31` }
    case 'older':
      return { to: '1979-12-31' }
    default: {
      const start = Number(era.slice(0, 4))
      return { from: `${start}-01-01`, to: `${start + 9}-12-31` }
    }
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** A piece of the page's sentence; `part` marks the words that open their filter */
export type Phrase = { text: string; part?: 'sort' | 'genres' | 'era' | 'rating' | 'language' }

/**
 * The page's title, as a sentence of what it shows: "Popular movies", "Best
 * rated comedy and drama shows from the 2010s, rated 7+, in Korean". `genreName`
 * names a genre id. Opened from a list and not narrowed: the list's name.
 */
export function describe(q: BrowseQuery, mediaType: 'movie' | 'tv', genreName: (id: number) => string | undefined): Phrase[] {
  if (showsList(q)) return [{ text: LIST_NAMES[q.list], part: 'sort' }]
  const noun = mediaType === 'movie' ? 'movies' : 'shows'
  const sort = effectiveSort(q)
  const phrases: Phrase[] = [{ text: SORTS.find((s) => s.value === sort)!.word, part: 'sort' }, { text: ' ' }]
  const names = q.genres.map((id) => genreName(id)?.toLowerCase()).filter((n): n is string => !!n)
  if (names.length) phrases.push({ text: joinWords(names, q.matchAll ? 'and' : 'or'), part: 'genres' }, { text: ' ' })
  phrases.push({ text: noun })
  if (q.era) phrases.push({ text: ' ' }, { text: ERAS.find((e) => e.value === q.era)!.phrase, part: 'era' })
  if (q.minRating != null) phrases.push({ text: ', ' }, { text: `rated ${q.minRating}+`, part: 'rating' })
  if (q.language) phrases.push({ text: ', ' }, { text: `in ${languageName(q.language)}`, part: 'language' })
  return phrases
}

function joinWords(words: string[], last: string): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} ${last} ${words[words.length - 1]}`
}

/** A filter that is on, as a token to remove with one tap */
export type Token = { key: string; label: string; without: BrowseQuery }

export function tokens(q: BrowseQuery, genreName: (id: number) => string | undefined): Token[] {
  const list: Token[] = q.genres.map((id) => ({ key: `g${id}`, label: genreName(id) ?? 'Genre', without: { ...q, genres: q.genres.filter((g) => g !== id) } }))
  if (q.era) list.push({ key: 'era', label: ERAS.find((e) => e.value === q.era)!.label, without: { ...q, era: null } })
  if (q.minRating != null) list.push({ key: 'rating', label: `${q.minRating}+`, without: { ...q, minRating: null } })
  if (q.language) list.push({ key: 'language', label: languageName(q.language), without: { ...q, language: null } })
  return list
}

/** Every filter off, the order kept */
export function cleared(q: BrowseQuery): BrowseQuery {
  return { ...emptyQuery(q.list), sort: q.sort }
}

export function toggleGenre(q: BrowseQuery, id: number): BrowseQuery {
  return { ...q, genres: q.genres.includes(id) ? q.genres.filter((g) => g !== id) : [...q.genres, id] }
}
