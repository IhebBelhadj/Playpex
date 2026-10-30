import type { Found } from './search-sources.service';

// The search page's videos and torrents narrowed and ranked on the TV (every
// provider's answer is already here): by quality, what it is (a film, an
// episode, a season pack), size, video codec, where it came from, names
// holding every word; in an order. `facets` counts each option among the
// results, so the panel offers only what is there and says how many each
// leaves. A port of Playpex Mobile's src/core/search/refine.ts (tested there):
// keep the two alike.

export type Sort = 'best' | 'seeds' | 'largest' | 'smallest';
export type Quality = '2160p' | '1080p' | '720p' | 'SD' | 'other';
export type What = 'film' | 'episode' | 'pack';
export type Size = 'small' | 'medium' | 'large' | 'huge';
export type Codec = 'h264' | 'hevc' | 'av1' | 'other';

export type Refine = {
  sort: Sort;
  /** Empty: any */
  qualities: Quality[];
  what: What[];
  sizes: Size[];
  codecs: Codec[];
  sources: string[];
  /** Only names that hold every word */
  exact: boolean;
};

export const NO_REFINE: Refine = { sort: 'best', qualities: [], what: [], sizes: [], codecs: [], sources: [], exact: false };

export const SORTS: { value: Sort; label: string }[] = [
  { value: 'best', label: 'Best match' },
  { value: 'seeds', label: 'Most seeded' },
  { value: 'largest', label: 'Largest' },
  { value: 'smallest', label: 'Smallest' },
];
export const QUALITIES: { value: Quality; label: string }[] = [
  { value: '2160p', label: '4K' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: 'SD', label: 'SD' },
  { value: 'other', label: 'Unknown' },
];
export const WHATS: { value: What; label: string }[] = [
  { value: 'film', label: 'Films and others' },
  { value: 'episode', label: 'Episodes' },
  { value: 'pack', label: 'Season packs' },
];
export const SIZES: { value: Size; label: string }[] = [
  { value: 'small', label: 'Under 1 GB' },
  { value: 'medium', label: '1 to 4 GB' },
  { value: 'large', label: '4 to 10 GB' },
  { value: 'huge', label: 'Over 10 GB' },
];
export const CODECS: { value: Codec; label: string }[] = [
  { value: 'h264', label: 'H.264' },
  { value: 'hevc', label: 'HEVC (x265)' },
  { value: 'av1', label: 'AV1' },
  { value: 'other', label: 'Other' },
];

const GB = 1e9;

export function qualityOf(f: Found): Quality {
  const q = (f.quality ?? '').toLowerCase();
  if (/2160|4k|uhd/.test(q)) return '2160p';
  if (q.includes('1080')) return '1080p';
  if (q.includes('720')) return '720p';
  if (/sd|480|576|360/.test(q)) return 'SD';
  return 'other';
}

export function whatOf(f: Found): What {
  if (f.pack || (f.season != null && f.episode == null)) return 'pack';
  if (f.season != null && f.episode != null) return 'episode';
  return 'film';
}

/** null: its size isn't known (it passes no size filter) */
export function sizeOf(f: Found): Size | null {
  if (!f.size) return null;
  return f.size < GB ? 'small' : f.size < 4 * GB ? 'medium' : f.size < 10 * GB ? 'large' : 'huge';
}

export function codecOf(f: Found): Codec {
  const c = `${f.codec ?? ''} ${f.name}`.toLowerCase();
  if (/x265|h\.?265|hevc/.test(c)) return 'hevc';
  if (/\bav1\b/.test(c)) return 'av1';
  if (/x264|h\.?264|avc/.test(c)) return 'h264';
  return 'other';
}

/** Whether a result passes every filter but `skip` (facets count each group as if it were off) */
function passes(f: Found, r: Refine, skip?: keyof Refine): boolean {
  if (skip !== 'exact' && r.exact && !f.matches) return false;
  if (skip !== 'qualities' && r.qualities.length && !r.qualities.includes(qualityOf(f))) return false;
  if (skip !== 'what' && r.what.length && !r.what.includes(whatOf(f))) return false;
  if (skip !== 'sizes' && r.sizes.length) {
    const size = sizeOf(f);
    if (!size || !r.sizes.includes(size)) return false;
  }
  if (skip !== 'codecs' && r.codecs.length && !r.codecs.includes(codecOf(f))) return false;
  if (skip !== 'sources' && r.sources.length && !r.sources.includes(f.finder)) return false;
  return true;
}

export function refine(items: Found[], r: Refine): Found[] {
  const kept = items.filter((f) => passes(f, r));
  const seeds = (f: Found) => f.seeds ?? 0;
  const size = (f: Found) => f.size ?? 0;
  const order: Record<Sort, (a: Found, b: Found) => number> = {
    // names holding every word first, then the most seeded (a stream: by its place in its provider's answer)
    best: (a, b) => Number(b.matches) - Number(a.matches) || seeds(b) - seeds(a),
    seeds: (a, b) => seeds(b) - seeds(a),
    largest: (a, b) => size(b) - size(a),
    smallest: (a, b) => (size(a) || Infinity) - (size(b) || Infinity),
  };
  return kept.sort(order[r.sort]);
}

export type Facets = {
  qualities: Map<Quality, number>;
  what: Map<What, number>;
  sizes: Map<Size, number>;
  codecs: Map<Codec, number>;
  sources: Map<string, number>;
  exact: number;
};

/** How many results each option leaves, the other filters applied */
export function facets(items: Found[], r: Refine): Facets {
  const count = <K>(skip: keyof Refine, key: (f: Found) => K | null) => {
    const m = new Map<K, number>();
    for (const f of items) {
      if (!passes(f, r, skip)) continue;
      const k = key(f);
      if (k != null) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  return {
    qualities: count('qualities', qualityOf),
    what: count('what', whatOf),
    sizes: count('sizes', sizeOf),
    codecs: count('codecs', codecOf),
    sources: count('sources', (f) => f.finder),
    exact: items.filter((f) => f.matches && passes(f, r, 'exact')).length,
  };
}

/** How many filters are on (the sort isn't one) */
export function refineCount(r: Refine): number {
  return r.qualities.length + r.what.length + r.sizes.length + r.codecs.length + r.sources.length + (r.exact ? 1 : 0);
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
