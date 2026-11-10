import type { Schema } from '@playpex/protocol';

// What the server's plugins hand the TV (packages/protocol/plugin-api.schema.json,
// docs/plugins/templates.md): plain data the core renders with its own
// templates and primitives. No plugin code runs here (docs/plugins-plan.md §5.1).

export type ClientPlugin = Schema<'ClientPlugin'>;
/** GET /plugins `capabilities`: what the profile's plugins provide */
export interface PluginCapabilities { releases:boolean; sources:boolean; live?:boolean; }
export type PluginScreenDecl = ClientPlugin['screens'][number];

export interface PluginIntent {
  screen:string;
  params?:Record<string, string | number>;
  replace?:boolean;
}

export interface PluginCall {
  data:string;
  args?:Record<string, unknown>;
}

export type PluginMetaItem =
  | { kind:'text', text:string, small?:boolean }
  | { kind:'chip', text:string, icon?:string }
  | { kind:'score', source?:'provider', value:number, votes?:number | string | null, label?:string }
  | { kind:'seal', text:string };

export interface PluginTitleInfo {
  title:string;
  eyebrow?:string;
  meta?:PluginMetaItem[];
  genres?:string[];
  overview?:string;
  overviewFallback?:string;
  credits?:{ label:string, names:string[] }[];
  notes?:string[];
  backdrop?:string | null;
}

export interface PluginCard {
  key:string | number;
  title:string;
  variant?:'poster' | 'still' | 'portrait' | 'compact';
  image?:string | null;
  subtitle?:string;
  badges?:('watched' | 'upcoming' | 'tv' | { text:string })[];
  progress?:number | null;
  rating?:{ source?:'provider', value:number } | null;
  intent?:PluginIntent;
  call?:PluginCall;
  info?:PluginTitleInfo;
}

export interface PluginRow {
  key:string;
  title:string;
  variant?:PluginCard['variant'];
  items?:PluginCard[];
  page?:PluginCall;
}

export interface PluginRowPage {
  items:PluginCard[];
  last:boolean;
}

export interface PluginAction {
  key:string;
  label:string;
  icon:string;
  on?:boolean;
  progress?:number | null;
  disabled?:boolean;
  intent?:PluginIntent;
  call?:PluginCall;
}

export interface PluginFilterGroup {
  key:string;
  label:string;
  multiple?:boolean;
  /** in the toolbar, applied at once (a view, a mode), not in the filters panel */
  toolbar?:boolean;
  /** its own toolbar button ("View: For you") opening a panel of this group only; a single choice applies at once */
  button?:boolean;
  options:{ value:string, label:string, on?:boolean }[];
}

/** A torrent (magnet / infoHash, seeds), or a direct link: `call` asks the plugin, which answers a play effect */
export interface PluginRelease {
  title:string;
  magnet?:string;
  infoHash?:string;
  call?:PluginCall;
  /** a direct link: where it plays from, in place of the seeders */
  via?:string;
  /** a direct link's picture (https), shown in place of `via`; its shape: portrait poster or landscape still */
  image?:string;
  imageVariant?:'poster' | 'still';
  size?:number;
  seeds?:number;
  peers?:number;
  quality?:string;
  uploadedAt?:string;
  notes?:string[];
}

export interface PluginListItem {
  key:string;
  label:string;
  meta?:string;
  icon?:string;
  intent?:PluginIntent;
  call?:PluginCall;
}

/** The data of each screen template (`$defs/templates`) */
export interface CatalogData {
  title?:string;
  rows:PluginRow[];
  search?:boolean;
  filters?:PluginFilterGroup[];
  empty?:string;
}

export interface TitleData {
  info:PluginTitleInfo;
  actions?:PluginAction[];
  rows?:PluginRow[];
}

export interface ReleasesData {
  title?:string;
  releases:PluginRelease[];
  last:boolean;
  filters?:PluginFilterGroup[];
  empty?:string;
}

export interface ListData {
  title?:string;
  items:PluginListItem[];
  empty?:string;
}

export interface PluginTitleRef {
  kind:'movie' | 'show' | 'episode' | 'video';
  tmdbId?:number;
  imdbId?:string;
  season?:number;
  episode?:number;
  title?:string;
  year?:number;
}

// A play effect's source as the server sends it: an http, HLS or live stream
// already turned into a media ref (`media`, with its `format`), never its URL
export type PluginSource =
  | { kind:'magnet', magnet?:string, infoHash?:string, fileIndex?:number, fileName?:string, label:string, quality?:string, size?:number, seeds?:number, peers?:number, codec?:string, notes?:string[] }
  | { kind:'media', ref:string, format?:'file' | 'hls' | 'live', label:string, quality?:string, size?:number, codec?:string, notes?:string[] }
  // a video in its site's own player (YouTube's IFrame player, from the server's /embed/youtube page)
  | { kind:'embed', provider:'youtube', id:string, label:string, duration?:number, quality?:string, size?:number, codec?:string, notes?:string[] };

export interface PluginPlayRequest {
  title:string;
  subtitle?:string;
  ref?:PluginTitleRef;
  artwork?:{ poster?:string, backdrop?:string };
  sources:PluginSource[];
  tracking?:'full' | 'none';
}

export type PluginEffect =
  | { type:'open', intent:PluginIntent }
  | { type:'play', request:PluginPlayRequest }
  | { type:'toast', text:string, tone?:'info' | 'success' | 'error' }
  | { type:'refresh', target:string }
  | { type:'confirm', question:string, yes?:string, no?:string, then:PluginEffect | { type:'call', call:PluginCall } }
  | { type:'download', request:{ title:string, ref?:PluginTitleRef, source:PluginSource } };

export interface PluginAnswer<T = unknown> {
  data:T | null;
  effects:PluginEffect[];
}

/** Which plugin a screen or call belongs to: its id, audience and asset base */
export interface PluginScope {
  id:string;
  name:string;
  adults:boolean;
  play:boolean;
}

/** Route data keys of a plugin's screen: its scope and its manifest entry (the templates read them) */
export const PLUGIN_SCOPE = 'pxPlugin';
export const PLUGIN_SCREEN = 'pxPluginScreen';
