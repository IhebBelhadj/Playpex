import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, forkJoin, map, of, shareReplay } from 'rxjs';
import { ServerService } from './server.service';
import { ProfilesService } from './profiles.service';
import { PlaybackService } from './playback.service';

// The search page's reach beyond the catalog (docs/search-plan.md, as the
// dashboard's Search and Playpex Mobile's): the plugins' videos of any kind
// (GET /search/sources, kind any: films, clips, talks…), the release
// providers' torrents (GET /releases/browse, movies and shows both, one row
// per info hash), and a typed or pasted link read by the server
// (POST /links/inspect: a page's videos, playlists, magnets, .torrent files).
// What any of them plays is saved for no title (`tracking: 'none'`).

/** One result, whatever found it (a torrent provider or a stream plugin) */
export interface Found {
  key:string;
  /** the provider's id (`plugin:<id>`, or a release provider's) */
  finder:string;
  kind:'torrent' | 'file' | 'hls';
  /** what it is, when the provider says; else its name */
  title:string;
  /** the release's own name */
  name:string;
  year:number | null;
  season:number | null;
  episode:number | null;
  pack:boolean;
  seeds:number | null;
  peers:number | null;
  size:number | null;
  quality:string | null;
  codec:string | null;
  audio:string | null;
  /** every typed word is in its name (the server's names.searchMatches) */
  matches:boolean;
  magnet?:string;
  infoHash?:string;
  /** file, hls: the media ref the server proxies */
  ref?:string;
  poster?:string | null;
}

export interface Provider {
  id:string;
  name:string;
}

interface TorrentProvider extends Provider {
  kinds:('movie' | 'tv')[];
}

export interface LinkItem {
  kind:'magnet' | 'torrent' | 'video' | 'hls';
  label:string;
  url:string;
  ref?:string;
  infoHash?:string;
  size?:number | null;
}

export interface LinkInspection {
  url:string;
  kind:'magnet' | 'torrent' | 'video' | 'hls' | 'page';
  title?:string | null;
  items:LinkItem[];
  truncated?:boolean;
}

/** One provider's answer: its results, or why there are none */
export interface ProviderResults {
  provider:Provider;
  items:Found[];
  error:boolean;
}

/** Whether what was typed is a link to read, not words: a URL, a magnet or a bare info hash */
export function isLink(text:string):boolean {
  let t = (text || '').trim();
  return /^(https?:\/\/|magnet:\?)\S+$/i.test(t) || /^www\.\S+\.\S+$/i.test(t) || /^[a-f0-9]{40}$/i.test(t);
}

@Injectable({ providedIn: 'root' })
export class SearchSourcesService {

  private streamList:Observable<Provider[]> | null = null;
  private torrentList:Observable<TorrentProvider[]> | null = null;

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
    private playback:PlaybackService,
  ) { }

  // ── providers (asked once per app run) ────────────────────────────────

  /** The plugins that find streams and files by keywords (`sources.search`) */
  streamProviders():Observable<Provider[]> {
    return this.streamList ||= this.http.get<{ id:string, name:string }[]>(`${this.server.api}/search/providers`).pipe(
      map(list => (list || []).map(p => ({ id: p.id, name: p.name }))),
      catchError(() => of([])),
      shareReplay(1),
    );
  }

  /** The release providers, with the kinds each lists */
  torrentProviders():Observable<TorrentProvider[]> {
    let kind = (k:'movie' | 'tv') => this.http.get<{ id:string, name:string }[]>(`${this.server.api}/releases/providers`, { params: { kind: k } })
      .pipe(catchError(() => of([])));
    return this.torrentList ||= forkJoin([kind('movie'), kind('tv')]).pipe(
      map(([movies, shows]) => {
        let byId = new Map<string, TorrentProvider>();
        ([['movie', movies], ['tv', shows]] as const).forEach(([k, list]) => (list || []).forEach(p => {
          let known = byId.get(p.id) || { id: p.id, name: p.name, kinds: [] };
          known.kinds.push(k);
          byId.set(p.id, known);
        }));
        return [...byId.values()];
      }),
      shareReplay(1),
    );
  }

  // ── searching ─────────────────────────────────────────────────────────

  /** Every stream plugin's videos for the words, each provider on its own */
  streams(q:string):Observable<ProviderResults[]> {
    return this.streamProviders().pipe(
      mapEach(p => this.http.get<any>(`${this.server.api}/search/sources`, { params: { provider: p.id, q, kind: 'any', page: 1 } }).pipe(
        map(answer => ({ provider: p, items: (answer.items || []).map((s:any, i:number) => fromSource(p.id, s, i)), error: false })),
        catchError(() => of({ provider: p, items: [], error: true })),
      )),
    );
  }

  /** Every release provider's torrents for the words, in every kind it lists */
  torrents(q:string):Observable<ProviderResults[]> {
    return this.torrentProviders().pipe(
      mapEach(p => forkJoin(p.kinds.map(k => this.http.get<any>(`${this.server.api}/releases/browse`, { params: { kind: k, provider: p.id, q, page: 1 } }).pipe(
        map(answer => answer.torrents || []),
        catchError(() => of(null)),
      ))).pipe(
        map(pages => {
          let seen = new Set<string>();
          let items = pages.filter(Boolean).flat()
            .filter((t:any) => !seen.has(t.hash) && !!seen.add(t.hash))
            .map((t:any) => fromTorrent(p.id, t));
          return { provider: { id: p.id, name: p.name }, items, error: pages.every(x => x === null) };
        }),
      )),
    );
  }

  /** What a link is; a magnet or a bare info hash isn't fetched: it is one torrent */
  inspect(text:string):Observable<LinkInspection> {
    let url = text.trim().replace(/^www\./i, 'https://www.');
    if (/^[a-f0-9]{40}$/i.test(url)) {
      return of({ url, kind: 'magnet', items: [{ kind: 'magnet', label: url.toLowerCase(), url: `magnet:?xt=urn:btih:${url}`, infoHash: url.toLowerCase() }] });
    }
    return this.http.post<LinkInspection>(`${this.server.api}/links/inspect`, { url, profileId: this.profiles.current.value?.id });
  }

  // ── playing (saved for no title) ──────────────────────────────────────

  play(found:Found) {
    let title = found.title || found.name;
    if (found.kind == 'torrent') {
      this.playback.play({ title, subtitle: found.name != title ? found.name : undefined, magnet: found.magnet || found.infoHash, tracking: 'none' });
    } else if (found.ref) {
      this.playback.play({ title, source: { ref: found.ref, format: found.kind == 'hls' ? 'hls' : 'file' }, tracking: 'none' });
    }
  }

  playLink(item:LinkItem) {
    if ((item.kind == 'video' || item.kind == 'hls') && item.ref) {
      this.playback.play({ title: item.label, source: { ref: item.ref, format: item.kind == 'hls' ? 'hls' : 'file' }, tracking: 'none' });
    } else {
      // a magnet, or a .torrent's URL (the server fetches it)
      this.playback.play({ title: item.label, magnet: item.url, tracking: 'none' });
    }
  }
}

/** Each provider's request at once, answered together; none → [] */
function mapEach<P, R>(ask:(p:P) => Observable<R>) {
  return (source:Observable<P[]>) => new Observable<R[]>(subscriber => source.subscribe({
    next: list => {
      if (!list.length) {
        subscriber.next([]);
        subscriber.complete();
        return;
      }
      forkJoin(list.map(ask)).subscribe(subscriber);
    },
    error: e => subscriber.error(e),
  }));
}

function fromTorrent(finder:string, t:any):Found {
  return {
    key: t.hash, finder, kind: 'torrent', title: t.title || t.name, name: t.name,
    year: t.year ?? null, season: t.season ?? null, episode: t.episode ?? null, pack: !!t.pack,
    seeds: t.seeds ?? null, peers: t.peers ?? null, size: t.size ?? null, quality: t.quality ?? null,
    codec: t.codec ?? null, audio: t.audio ?? null, matches: t.matches ?? true, magnet: t.magnet, infoHash: t.hash,
  };
}

function fromSource(finder:string, s:any, i:number):Found {
  return {
    key: s.infoHash || s.ref || `${finder}:${i}`, finder, kind: s.kind, title: s.title || s.label, name: s.label,
    year: s.year ?? null, season: s.season ?? null, episode: s.episode ?? null, pack: false,
    seeds: s.seeds ?? null, peers: s.peers ?? null, size: s.size ?? null, quality: s.quality ?? null,
    codec: s.codec ?? null, audio: s.audio ?? null, matches: !!s.matches, magnet: s.magnet, infoHash: s.infoHash, ref: s.ref,
    poster: s.poster ?? null,
  };
}
