// Types of plugins.js and of the two plugin schemas: the manifest
// (plugin.schema.json) and what crosses the sandbox (plugin-api.schema.json).
// docs/plugins-plan.md; author guide docs/plugins/.

export declare const SERVER_PLUGIN_API: number;
export declare const ID: RegExp;

// ── Manifest (playpex-plugin.json) ──────────────────────────────────────────

export type HookName = 'play.collect' | 'play.rank' | 'play.before' | 'play.resolve' | 'releases.providers'
  | 'subtitles.providers' | 'metadata.title' | 'metadata.details' | 'player.markers' | 'library.match';
export type EventFamily = 'playback' | 'downloads' | 'library' | 'watchlist';
export type WriteScope = 'watchlist' | 'watched' | 'ratings' | 'downloads';
export type SourceKind = 'magnet' | 'http';
export type TemplateName = 'catalog' | 'title' | 'releases' | 'list';
export type ListingCategory = 'catalog' | 'sources' | 'resolvers' | 'subtitles' | 'metadata' | 'library' | 'tracking'
  | 'notifications' | 'tools';
/** 1.2.3, ^1 / ^1.2 / ^1.2.3, ~1.2 / ~1.2.3, 1.x, >=1.2.0, >=1.2.0 <2.0.0, * */
export type VersionRange = string;
/** plain text, or @<key> of i18n/<locale>.json */
export type Label = string;
export type PluginSlot = 'core.movie.actions' | 'core.show.actions' | 'core.episode.actions' | 'core.movie.rows'
  | 'core.show.rows' | 'core.movies.rows' | 'core.shows.rows' | 'core.title.meta' | 'core.watchlist.rows'
  | 'core.search.filters';
/** N, ^N, N.x, >=N, >=N <M, * */
export type ApiRange = string;
/** assets/<path>.(svg|png|jpg|jpeg|webp) */
export type AssetPath = string;

export interface PluginPermissions {
  network?: string[];
  rateLimit?: { perSecond?: number; burst?: number; inFlight?: number };
  /** <n>KB | <n>MB */
  storage?: string;
  secrets?: string[];
  play?: boolean;
  sources?: SourceKind[];
  hooks?: HookName[];
  events?: EventFamily[];
  schedule?: boolean;
  write?: WriteScope[];
  link?: string[];
  library?: boolean;
  files?: boolean;
  notify?: boolean;
}

export interface PluginLink {
  name: string;
  label: Label;
  scope: 'profile' | 'server';
  /** a data handler answering a LinkStart: exactly one of custom / deviceCode */
  custom?: string;
  deviceCode?: {
    codeUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    scope?: string;
    /** form (RFC 8628, default) or json (Trakt) */
    body?: 'form' | 'json';
    clientIdSecret: string;
    clientSecretSecret?: string;
  };
}

interface SettingCondition {
  key: string;
  equals: string | number | boolean;
}
interface SettingBase {
  key: string;
  scope: 'profile' | 'server';
  label: Label;
  description?: string;
  group?: Label;
  level?: 'basic' | 'advanced';
  visibleIf?: SettingCondition;
  enabledIf?: SettingCondition;
}
export type PluginSetting =
  | SettingBase & { type: 'switch'; default: boolean }
  | SettingBase & { type: 'choice'; options: [value: string, label: string][]; default: string }
  | SettingBase & { type: 'slider'; min: number; max: number; step?: number; unit?: string; default: number }
  | SettingBase & { type: 'number'; min?: number; max?: number; step?: number; integer?: boolean; unit?: string; default: number }
  | SettingBase & { type: 'text' | 'secret'; maxLength?: number; placeholder?: string; pattern?: string; default?: string }
  /** a button in the dashboard calling a data handler */
  | SettingBase & { type: 'action'; data: string; confirm?: string };

export interface PluginContributes {
  sections?: { screen: string; menu: { label: string; icon: AssetPath; order?: number } }[];
  screens?: { name: string; template: TemplateName; data?: string; title?: string; params?: string[] }[];
  slots?: { slot: PluginSlot; data: string; order?: number }[];
  settings?: PluginSetting[];
  chrome?: { accent?: 'adult' };   // plugins-check: allow (the accent token's name)
}

export interface PluginListing {
  summary?: string;
  description?: string;
  disclaimer?: string;
  license?: string;
  source?: string;
  categories?: ListingCategory[];
  screenshots?: AssetPath[];
  fanart?: AssetPath;
}

interface ManifestBase {
  $schema?: string;
  id: string;
  name: string;
  description?: string;
  version: string;
  publisher: { name: string; url?: string; key?: string };
  icon?: AssetPath;
  homepage?: string;
  listing?: PluginListing;
}

export interface PluginManifest extends ManifestBase {
  type?: 'plugin';
  api: { server: ApiRange; nav?: ApiRange; ui?: ApiRange };
  audience: 'everyone' | 'adults';
  permissions: PluginPermissions;
  link?: PluginLink[];
  contributes?: PluginContributes;
  requires?: { id: string; version: VersionRange; optional?: boolean }[];
  /** data handlers plugins requiring this one may call */
  exports?: string[];
  migratesFrom?: string[];
}

/** A package that only adds a repository (§6.1) */
export interface RepositoryManifest extends ManifestBase {
  type: 'repository';
  repository: { url: string; key: string };
}

export interface ManifestProblem {
  /** JSON pointer into the manifest */
  path: string;
  message: string;
}

export interface PermissionText {
  key: string;
  text: string;
  /** each profile opts in (events.playback, write.*) */
  personal: boolean;
}

// ── What crosses the sandbox (plugin-api.schema.json) ───────────────────────

export interface PluginContext {
  profile: { id: string; kids: boolean } | null;
  device: { id: string; name: string } | null;
  locale: string;
}

export interface PluginTitleRef {
  kind: 'movie' | 'show' | 'episode' | 'video';
  /** an episode: the show's */
  tmdbId?: number;
  imdbId?: string;
  season?: number;
  episode?: number;
  title?: string;
  year?: number;
}

export type Quality = '2160p' | '1080p' | '720p' | '480p' | 'SD';

interface SourceBase {
  label: string;
  quality?: Quality;
  size?: number;
  codec?: string;
  audio?: string;
  notes?: string[];
}
export type PluginSource =
  | SourceBase & { kind: 'magnet'; magnet?: string; infoHash?: string; fileIndex?: number; fileName?: string; seeds?: number; peers?: number }
  | SourceBase & { kind: 'http'; url: string; headers?: Record<string, string>; container?: string };

/** What play.rank / play.before see of a source: no magnet, path, URL or ref */
export interface RankedSource {
  id: string;
  type: 'file' | 'download' | 'torrent' | 'plugin';
  provider: string;
  label: string;
  quality?: Quality | null;
  size?: number | null;
  codec?: string | null;
  audio?: string | null;
  seeds?: number | null;
  playable: 'yes' | 'audio-converted' | 'maybe' | 'no';
}

export interface Release {
  title: string;
  magnet?: string;
  infoHash?: string;
  size?: number;
  seeds: number;
  peers?: number;
  quality?: Quality;
  uploadedAt?: string;
  notes?: string[];
}

export interface PluginSubtitle {
  id: string;
  language: string;
  label: string;
  url: string;
  format?: 'srt' | 'vtt' | 'ass' | 'ssa' | 'sub';
  hearingImpaired?: boolean;
  downloads?: number;
}

export interface Marker {
  kind: 'intro' | 'recap' | 'credits' | 'chapter';
  /** seconds */
  start: number;
  end?: number;
  label?: string;
}

export type PluginMetaItem =
  | { kind: 'text'; text: string; small?: boolean }
  | { kind: 'chip'; text: string; icon?: string }
  | { kind: 'score'; source?: 'provider'; value: number; votes?: number | string | null; label?: string }
  | { kind: 'seal'; text: string };

/** plugin.<own id>.<name>, or core.movie | core.show | core.episode | core.search */
export interface PluginIntent {
  screen: string;
  params?: Record<string, string | number>;
  /** In place of the current screen (a section switching its layout) */
  replace?: boolean;
}

/** A data handler of the same plugin */
export interface PluginCall {
  data: string;
  args?: Record<string, unknown>;
}

export interface PluginTitleInfo {
  title: string;
  eyebrow?: string;
  meta?: PluginMetaItem[];
  genres?: string[];
  overview?: string;
  overviewFallback?: string;
  credits?: { label: string; names: string[] }[];
  notes?: string[];
  backdrop?: string | null;
}

export interface PluginCard {
  key: string | number;
  title: string;
  variant?: 'poster' | 'still' | 'portrait' | 'compact';
  image?: string | null;
  subtitle?: string;
  badges?: ('watched' | 'upcoming' | 'tv' | { text: string })[];
  progress?: number | null;
  rating?: { source?: 'provider'; value: number } | null;
  intent?: PluginIntent;
  call?: PluginCall;
  info?: PluginTitleInfo;
}

export type PluginRow = {
  key: string;
  title: string;
  variant?: PluginCard['variant'];
} & ({ items: PluginCard[] } | { page: PluginCall });

export interface PluginRowPage {
  items: PluginCard[];
  last: boolean;
}

export interface PluginAction {
  key: string;
  label: string;
  icon: string;
  on?: boolean;
  progress?: number | null;
  disabled?: boolean;
  intent?: PluginIntent;
  call?: PluginCall;
}

export interface FilterGroup {
  key: string;
  label: string;
  multiple?: boolean;
  options: { value: string; label: string; on?: boolean }[];
}

export interface PlayRequest {
  title: string;
  subtitle?: string;
  ref?: PluginTitleRef;
  artwork?: { poster?: string; backdrop?: string };
  /** one plays at once, several open the source picker */
  sources: PluginSource[];
  /** none: nothing remembered (forced for audience adults) */
  tracking?: 'full' | 'none';
}

export type Effect =
  | { type: 'open'; intent: PluginIntent }
  | { type: 'play'; request: PlayRequest }
  | { type: 'toast'; text: string; tone?: 'info' | 'success' | 'error' }
  | { type: 'refresh'; target: string }
  | { type: 'confirm'; question: string; yes?: string; no?: string; then: Effect | { type: 'call'; call: PluginCall } }
  | { type: 'download'; request: { title: string; ref?: PluginTitleRef; source: PluginSource } };

export interface DataAnswer<T = unknown> {
  data?: T;
  effects?: Effect[];
}

/** The data each screen template expects */
export interface TemplateData {
  catalog: { title?: string; rows: PluginRow[]; search?: boolean; filters?: FilterGroup[]; empty?: string };
  title: { info: PluginTitleInfo; actions?: PluginAction[]; rows?: PluginRow[] };
  releases: { title?: string; releases: Release[]; last: boolean; filters?: FilterGroup[]; empty?: string };
  list: { title?: string; items: { key: string; label: string; meta?: string; icon?: string; intent?: PluginIntent; call?: PluginCall }[]; empty?: string };
}

export type PlaybackEventName = 'playback.started' | 'playback.progress' | 'playback.paused' | 'playback.ended' | 'playback.finished';
export type DownloadEventName = 'download.added' | 'download.completed' | 'download.removed';
export type WatchlistEventName = 'watchlist.added' | 'watchlist.removed' | 'watched.set' | 'watched.cleared' | 'rating.set';

export interface EventData {
  playback: { title: PluginTitleRef; position: number; duration: number | null; source: 'file' | 'download' | 'torrent' | 'plugin' };
  download: { title?: PluginTitleRef | null; name: string; size?: number | null; state: string };
  library: { added: PluginTitleRef[]; removed: PluginTitleRef[] };
  watchlist: { title: PluginTitleRef; rating?: number };
}

interface EventBase {
  time: string;
  context: PluginContext;
  /** user, or plugin:<id> */
  by?: string;
  /** events lost to a full queue before this one */
  dropped?: number;
}
export type PluginEvent =
  | EventBase & { name: PlaybackEventName; data: EventData['playback'] }
  | EventBase & { name: DownloadEventName; data: EventData['download'] }
  | EventBase & { name: 'library.changed'; data: EventData['library'] }
  | EventBase & { name: WatchlistEventName; data: EventData['watchlist'] };

/** Input → output of every hook */
export interface HookIO {
  'play.collect': { input: { title: PluginTitleRef }; output: PluginSource[] };
  'play.rank': { input: { title: PluginTitleRef; sources: RankedSource[] }; output: { order?: string[]; hide?: { id: string; reason: string }[] } };
  'play.resolve': {
    input: { mode: 'check'; hashes: string[] } | { mode: 'resolve'; title: PluginTitleRef; source: PluginSource };
    output: { hashes: Record<string, { cached: boolean; label?: string }> } | { source: PluginSource | null };
  };
  'play.before': {
    input: { title: PluginTitleRef; source: RankedSource };
    output: { action: 'continue' } | { action: 'ask'; question: string; yes?: string; no?: string } | { action: 'refuse'; reason: string };
  };
  'releases.providers': {
    input: { kind: string; title?: PluginTitleRef; query?: string; filters?: Record<string, unknown>; page: number };
    output: { releases: Release[]; last: boolean };
  };
  'subtitles.providers': { input: { title: PluginTitleRef; languages: string[]; fileName?: string; size?: number }; output: PluginSubtitle[] };
  'metadata.title': { input: { title: PluginTitleRef }; output: { meta?: PluginMetaItem[] } };
  'metadata.details': { input: { title: PluginTitleRef; details: TitleDetails }; output: MetadataAdditions };
  'player.markers': { input: { title: PluginTitleRef; duration: number; fileName?: string; size?: number }; output: Marker[] };
  'library.match': { input: { file: LibraryFile }; output: { identity: Identity | null } };
}

/** The core's details of a title, as metadata.details gets them */
export interface TitleDetails {
  title: string;
  originalTitle?: string;
  year?: number;
  imdbId?: string;
  genres: string[];
  runtime?: number;
}

/** What a metadata provider adds to a title's page (never overrides: decision I) */
export interface MetadataAdditions {
  ratings?: { source: string; value: number; max: number; votes?: number; url?: string }[];
  tags?: string[];
  links?: { label: string; url: string }[];
  lines?: PluginMetaItem[];
}

/** What library.match sees of a file: never the folder's path or the content */
export interface LibraryFile {
  relPath: string;
  folderKind: 'movies' | 'shows' | 'mixed' | 'other';
  parse?: Record<string, unknown>;
  ids?: { tmdbId?: number; imdbId?: string };
  size?: number;
  duration?: number | null;
}

export type Identity =
  | { kind: 'movie'; tmdbId: number }
  | { kind: 'episode'; showTmdbId: number; season: number; episode: number; episodeEnd?: number };

export interface PluginNotification {
  text: string;
  tone?: 'info' | 'success' | 'error';
  /** one kept per key: the newest wins */
  key?: string;
}

/** A custom link handler's answer, shown by the dashboard */
export type LinkStart =
  | { code: string; url: string; qr?: boolean; poll: string; expiresIn?: number }
  | { form: { key: string; label: string; secret?: boolean; help?: string }[]; submit: string; help?: string };

export interface LinkPoll {
  state: 'pending' | 'done' | 'failed';
  message?: string;
}

// ── repository.schema.json ──────────────────────────────────────────────────

export interface RepositoryVersion {
  version: string;
  url: string;
  sha256: string;
  size: number;
  releasedAt: string;
  api?: PluginManifest['api'];
  audience?: PluginManifest['audience'];
  permissions?: PluginPermissions;
  requires?: PluginManifest['requires'];
  lifecycle?: 'stable' | 'deprecated' | 'broken';
  replacedBy?: string;
  reason?: string;
  changelog?: string;
}

export interface RepositoryIndex {
  $schema?: string;
  format: 1;
  repository: { id: string; name: string; key: string; homepage?: string };
  generatedAt: string;
  plugins: {
    id: string;
    name: string;
    type?: 'plugin' | 'repository';
    publisher: PluginManifest['publisher'];
    icon?: string;
    /** screenshots / fanart as full HTTPS URLs */
    listing?: Omit<PluginListing, 'screenshots' | 'fanart'> & { screenshots?: string[]; fanart?: string };
    /** newest first */
    versions: RepositoryVersion[];
  }[];
}

// ── plugins.js ──────────────────────────────────────────────────────────────

export declare const HOOKS: { readonly [K in HookName]: { timeoutMs: number; checkTimeoutMs?: number; describe: string } };
export declare const EVENTS: { readonly [F in EventFamily]: readonly string[] };
export declare const WRITE_SCOPES: readonly WriteScope[];
export declare const SOURCE_KINDS: readonly SourceKind[];
export declare const MARKER_KINDS: readonly Marker['kind'][];
export declare const EFFECTS: readonly Effect['type'][];
export declare const TEMPLATES: readonly TemplateName[];
export declare const SETTING_TYPES: readonly PluginSetting['type'][];
export declare const LISTING_CATEGORIES: readonly ListingCategory[];
export declare const SLOTS: { readonly [S in PluginSlot]: 'actions' | 'rows' | 'meta' | 'searchFilter' };
export declare const SLOT_MAX_PER_PLUGIN: number;
export declare const PERSONAL: readonly string[];
export declare const LIMITS: {
  memoryBytes: number;
  cpuMsPerCall: number;
  concurrentCalls: number;
  http: { timeoutMs: number; maxResponseBytes: number; perSecond: number; burst: number; inFlight: number; maxWaitMs: number; maxRedirects: number };
  storageBytes: number;
  dataBodyBytes: number;
  schedule: { minIntervalMs: number; jitter: number; maxRunMs: number };
  eventQueue: number;
  sourceRefTtlMs: number;
  notifications: { perHour: number; keepMs: number };
  core: { perSecond: number; burst: number; inFlight: number; maxWaitMs: number };
};
export declare const FORBIDDEN_HEADERS: readonly string[];
export declare function parseSize(value: string): number | null;
export declare function satisfies(range: ApiRange, version: number): boolean;
export declare function satisfiesVersion(range: VersionRange, version: string): boolean;
export declare function compareVersions(a: string, b: string): number;
export declare function hostAllowed(patterns: readonly string[] | undefined, host: string): boolean;
export declare function checkManifest(manifest: PluginManifest | RepositoryManifest,
  options?: { versions?: { server?: number; nav?: number; ui?: number }; files?: string[]; strings?: { [locale: string]: Record<string, string> } }): ManifestProblem[];
export declare function describePermissions(manifest: PluginManifest): PermissionText[];
