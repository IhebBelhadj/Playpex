import type { Schema } from '@playpex/protocol';

// What the server's plugins hand the TV (packages/protocol/plugin-api.schema.json,
// docs/plugins/templates.md): plain data the core renders with its own
// templates and primitives. No plugin code runs here (docs/plugins-plan.md §5.1).

export type ClientPlugin = Schema<'ClientPlugin'>;
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
  options:{ value:string, label:string, on?:boolean }[];
}

export interface PluginRelease {
  title:string;
  magnet?:string;
  infoHash?:string;
  size?:number;
  seeds:number;
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

// A play effect's source as the server sends it: an http stream already
// turned into a media ref (`media`), never its URL
export type PluginSource =
  | { kind:'magnet', magnet?:string, infoHash?:string, fileIndex?:number, fileName?:string, label:string, quality?:string, size?:number, seeds?:number, peers?:number, codec?:string, notes?:string[] }
  | { kind:'media', ref:string, label:string, quality?:string, size?:number, codec?:string, notes?:string[] };

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
