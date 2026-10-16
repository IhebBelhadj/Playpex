import { Category } from './categories';
import { MediaType } from './catalog';

// Filters of a section's list page (movies or TV shows), picked in the filter
// panel next to the search bar. Alone they become three TMDB `discover` rows
// (popular, top rated, newest); with a search they narrow its results (TMDB's
// search endpoint can't filter, so results are checked here).

export interface CatalogFilters {
  genre: number | null;      // TMDB genre id
  period: string;            // '' or an id of PERIODS
  rating: number;            // minimum TMDB score, 0 = any
  language: string;          // original language (ISO 639-1), '' = any
}

export const NO_FILTERS: CatalogFilters = { genre: null, period: '', rating: 0, language: '' };

export interface Genre { id: number; name: string; }

interface Period { id: string; label: string; phrase: string; from?: string; to?: string; }

const year = new Date().getFullYear();

export const PERIODS: Period[] = [
  { id: '', label: 'Any time', phrase: '' },
  { id: 'recent', label: 'Last 2 years', phrase: 'from the last 2 years', from: `${year - 1}-01-01` },
  { id: '2020s', label: '2020s', phrase: 'from the 2020s', from: '2020-01-01', to: '2029-12-31' },
  { id: '2010s', label: '2010s', phrase: 'from the 2010s', from: '2010-01-01', to: '2019-12-31' },
  { id: '2000s', label: '2000s', phrase: 'from the 2000s', from: '2000-01-01', to: '2009-12-31' },
  { id: '1990s', label: '1990s', phrase: 'from the 1990s', from: '1990-01-01', to: '1999-12-31' },
  { id: '1980s', label: '1980s', phrase: 'from the 1980s', from: '1980-01-01', to: '1989-12-31' },
  { id: 'older', label: 'Before 1980', phrase: 'from before 1980', to: '1979-12-31' },
];

export const RATINGS = [
  { value: 0, label: 'Any score' },
  { value: 6, label: '6 and up' },
  { value: 7, label: '7 and up' },
  { value: 8, label: '8 and up' },
];

export const LANGUAGES = [
  { id: '', label: 'Any language', name: '' },
  { id: 'en', label: 'English', name: 'English' },
  { id: 'ko', label: 'Korean', name: 'Korean' },
  { id: 'ja', label: 'Japanese', name: 'Japanese' },
  { id: 'es', label: 'Spanish', name: 'Spanish' },
  { id: 'fr', label: 'French', name: 'French' },
  { id: 'hi', label: 'Hindi', name: 'Hindi' },
  { id: 'tr', label: 'Turkish', name: 'Turkish' },
];

export function hasFilters(f: CatalogFilters | null): boolean {
  return !!f && (f.genre !== null || !!f.period || !!f.rating || !!f.language);
}

export function sameFilters(a: CatalogFilters, b: CatalogFilters): boolean {
  return a.genre === b.genre && a.period === b.period && a.rating === b.rating && a.language === b.language;
}

// What the filter button says: "Comedy, 1990s, 7 and up"
export function filtersLabel(f: CatalogFilters, genres: Genre[]): string {
  if (!hasFilters(f)) return 'Filters';
  return [
    genres.find(g => g.id === f.genre)?.name,
    PERIODS.find(p => p.id === f.period && p.id)?.label,
    f.rating ? `${f.rating} and up` : '',
    LANGUAGES.find(l => l.id === f.language && l.id)?.label,
  ].filter(Boolean).join(', ');
}

// The rows of a filtered section, named after what they hold ("Top rated
// comedy from the 1990s"), so they never share a name (and a remembered
// position) with the section's own rows
export function filterCategories(media: MediaType, f: CatalogFilters, genres: Genre[]): Category[] {
  let genre = genres.find(g => g.id === f.genre)?.name;
  let noun = genre ? genre.toLowerCase().replace(/\btv\b/, 'TV') : media == 'tv' ? 'TV shows' : 'movies';
  let language = LANGUAGES.find(l => l.id === f.language && l.id);
  let tail = [
    PERIODS.find(p => p.id === f.period && p.id)?.phrase,
    language ? `in ${language.name}` : '',
    f.rating ? `scoring ${f.rating}+` : '',
  ].filter(Boolean).join(' ');
  let title = (base: string) => [base, noun, tail].filter(Boolean).join(' ');

  let date = media == 'tv' ? 'first_air_date' : 'primary_release_date';
  let today = new Date().toISOString().slice(0, 10);
  let rows = [
    { name: title('Popular'), sort: 'popularity.desc', votes: 50 },
    { name: title('Top rated'), sort: 'vote_average.desc', votes: 300 },
    { name: title('Newest'), sort: `${date}.desc`, votes: 10 },
  ];
  return rows.map(row => new Category(row.name, {
    url: `https://api.themoviedb.org/3/discover/${media}?api_key=<<api_key>>&language=en-US&include_adult=false` +
      (media == 'tv' ? '&without_genres=10763,10764,10767' : ''),
    params: discoverParams(media, f, { sort_by: row.sort, 'vote_count.gte': row.votes, [`${date}.lte`]: today }),
  }));
}

function discoverParams(media: MediaType, f: CatalogFilters, base: { [key: string]: any }) {
  let params: { [key: string]: any } = { ...base, page: 1 };
  let date = media == 'tv' ? 'first_air_date' : 'primary_release_date';
  let period = PERIODS.find(p => p.id === f.period);
  if (f.genre !== null) params['with_genres'] = f.genre;
  if (period?.from) params[`${date}.gte`] = period.from;
  if (period?.to && period.to < params[`${date}.lte`]) params[`${date}.lte`] = period.to;
  if (f.rating) params['vote_average.gte'] = f.rating;
  if (f.language) params['with_original_language'] = f.language;
  return params;
}

// A search result (TMDB list item) kept by the filters
export function matchesFilters(item: any, f: CatalogFilters): boolean {
  let date = item['release_date'] || item['first_air_date'] || '';
  let period = PERIODS.find(p => p.id === f.period);
  return (f.genre === null || (item['genre_ids'] || []).includes(f.genre)) &&
    (!period?.from || (!!date && date >= period.from)) &&
    (!period?.to || (!!date && date <= period.to)) &&
    (!f.rating || (item['vote_average'] || 0) >= f.rating) &&
    (!f.language || item['original_language'] === f.language);
}
