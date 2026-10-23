// The slot catalog (docs/ui-system-plan.md §5.6): the named places in core
// screens where contributions (a plugin's, or the core's own) appear, each
// with what it renders and the context it hands over. Every slot is a promise
// to keep: add one only for a real need. Contexts are read-only snapshots,
// never a page or a service.

export type SlotKind = 'actions' | 'rows' | 'meta' | 'searchFilter';

export interface ProfileContext {
  id:string;
  name:string;
  kids:boolean;
}

export interface TitleRef {
  tmdbId:number;
  imdbId:string | null;
  title:string;
  year:string | null;
}

export interface MovieContext {
  movie:TitleRef;
  profile:ProfileContext;
}

export interface ShowContext {
  show:TitleRef;
  season:number | null;
  profile:ProfileContext;
}

export interface EpisodeContext {
  show:TitleRef;
  season:number;
  episode:number;
  profile:ProfileContext;
}

export interface SectionContext {
  section:'movie' | 'tv';
  profile:ProfileContext;
  // the section's search / filters in use (rows below them, or none)
  query:string;
  filters:Record<string, unknown>;
}

export interface TitleMetaContext {
  kind:'movie' | 'tv' | 'episode';
  tmdbId:number;
  imdbId:string | null;
  profile:ProfileContext;
}

export interface WatchlistContext {
  profile:ProfileContext;
}

export interface SearchContext {
  // what was typed (the search page asks again when it changes)
  query:string;
  profile:ProfileContext;
}

export interface SlotDef {
  kind:SlotKind;
  // contributions to it are refused for kids profiles
  adult?:boolean;
  description:string;
}

/** Slot names → their context types (type-checks defineContribution) */
export interface SlotContexts {
  'core.movie.actions':MovieContext;
  'core.show.actions':ShowContext;
  'core.episode.actions':EpisodeContext;
  'core.movie.rows':MovieContext;
  'core.show.rows':ShowContext;
  'core.movies.rows':SectionContext;
  'core.shows.rows':SectionContext;
  'core.title.meta':TitleMetaContext;
  'core.watchlist.rows':WatchlistContext;
  'core.search.filters':SearchContext;
}

export type SlotName = keyof SlotContexts;

export const SLOTS:{ readonly [name in SlotName]:SlotDef } = {
  'core.movie.actions': { kind: 'actions', description: 'Action tiles of a movie page, after the core ones' },
  'core.show.actions': { kind: 'actions', description: 'Action tiles of a show page, after the core ones' },
  'core.episode.actions': { kind: 'actions', description: 'Action tiles of an episode page, after the core ones' },
  'core.movie.rows': { kind: 'rows', description: 'Rows under a movie page\'s cast and similar titles' },
  'core.show.rows': { kind: 'rows', description: 'Rows under a show page\'s episodes' },
  'core.movies.rows': { kind: 'rows', description: 'Rows of the Movies section, after its categories' },
  'core.shows.rows': { kind: 'rows', description: 'Rows of the TV shows section, after its categories' },
  'core.title.meta': { kind: 'meta', description: 'More items on the meta line of a title (another score, a tag)' },
  'core.watchlist.rows': { kind: 'rows', description: 'Rows of the watch list, after the library\'s' },
  'core.search.filters': { kind: 'searchFilter', description: 'A chip after the search page\'s filters, showing its rows for the query' },
};
