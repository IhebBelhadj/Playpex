import { Observable } from 'rxjs';
import type { Intent } from '../nav/public-api';

// View models (docs/ui-system-plan.md §5.5): plain data the primitives render
// without a template. What a plugin hands to a slot, and what the core's own
// contributions return. Functions only for `run` / `page`, so a contribution's
// output could later cross a worker or iframe boundary.

export type ScoreSource = 'imdb' | 'tmdb' | 'provider';

export type CardVariant = 'poster' | 'still' | 'portrait' | 'compact';

/** A small mark on a card: built-in kinds ('current': "On this page", white; 'server': a file of it is on
 * the Playpex server), or any short text */
export type Badge = 'tv' | 'watched' | 'upcoming' | 'current' | 'server' | { text:string };

export interface CardModel {
  key:string | number;
  title:string;
  variant?:CardVariant;
  /** full URL (a plugin doesn't know TMDB's image base) */
  image?:string | null;
  subtitle?:string;
  badges?:Badge[];
  /** 0–1, amber */
  progress?:number | null;
  rating?:{ source:ScoreSource, value:number } | null;
  /** what Enter opens (the row / slot opens it) */
  intent?:Intent;
  /** called on Enter instead of opening `intent` (a plugin's card calling its handler) */
  run?:() => void;
  /** the title info a section shows while the card has the focus (a plugin's catalog) */
  info?:TitleInfoModel;
}

export interface RowPage {
  items:CardModel[];
  last:boolean;
}

export type RowSource =
  | { items:CardModel[] }
  | { page:(n:number) => Observable<RowPage> };

export interface RowModel {
  /** position memory key (scoped like any pxRow); plugins prefix it `<pluginId>:` */
  key:string;
  title:string;
  variant?:CardVariant;
  source:RowSource;
}

/** A chip of the search page's filters with what it shows for the query (core.search.filters) */
export interface SearchFilterModel {
  /** plugins prefix it `<pluginId>:` */
  key:string;
  label:string;
  rows:RowModel[];
}

export interface ActionModel {
  /** plugins prefix it `<pluginId>:` */
  key:string;
  label:string;
  /** assets/icons/<icon>.svg, or a URL */
  icon:string;
  on?:boolean;
  progress?:number | null;
  busy?:boolean;
  disabled?:boolean;
  run?:() => void | Promise<void>;
  intent?:Intent;
}

export type MetaItem =
  // `small`: a body-sized line ("Aired 20 January 2008"), not the year's size
  | { kind:'text', text:string, small?:boolean }
  // `icon`: assets/icons/<icon>.svg before the text (a tick on "Watched")
  | { kind:'chip', text:string, icon?:string }
  // `label`: a provider's name before its score (plugins' catalogs)
  | { kind:'score', source:ScoreSource, value:number, votes?:number | string | null, label?:string }
  | { kind:'seal', text:string };

export interface TitleInfoModel {
  title:string;
  /** above the title: the show's name on an episode */
  eyebrow?:string;
  meta?:MetaItem[];
  genres?:string[];
  overview?:string;
  /** the profile's state (watch list): "Resume from 42:13", with an amber line */
  status?:string;
  progress?:number | null;
  credits?:{ label:string, names:string[] }[];
  /** extra lines under the meta line (performers, "Directed by …") */
  notes?:string[];
  /** shown dimmed when there's no overview ("No description for this episode yet.") */
  overviewFallback?:string;
  /** a full URL for the shell's backdrop while it's shown (pages send it to BackgroundService) */
  backdrop?:string | null;
}

/** assets/icons/<name>.svg for a bare name, the string itself for a path or URL */
export function iconUrl(icon:string):string {
  return /[/.:]/.test(icon) ? icon : `assets/icons/${icon}.svg`;
}
