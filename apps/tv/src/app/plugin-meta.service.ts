import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, map, merge, Observable, of, shareReplay } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { ProfilesService } from './profiles.service';
import { ServerEvents } from './server-events.service';
import { ServerService } from './server.service';
import { defineContribution, CONTRIBUTIONS, MetaItem } from './ui/public-api';

type Extras = Schema<'CatalogExtras'>;

// What the server's metadata providers add to a title's meta line (plugins
// with `metadata.details`, or the older `metadata.title`; GET
// /catalog/titles/{mediaType}/{tmdbId}/extras, docs/providers-plan.md §7.2), in
// the admin's order: their ratings (on a 10 scale, after their name), up to two
// tags, their lines. Links aren't shown: a TV doesn't open them. A
// contribution to `core.title.meta` like the core's "On this server". One
// request per title and profile, kept until a plugin or the profile changes; a
// failure shows nothing.
@Injectable({
  providedIn: 'root'
})
export class PluginMetaService {

  private cache = new Map<string, Observable<MetaItem[]>>();

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
    events:ServerEvents,
  ) {
    merge(events.on('plugin.changed'), this.profiles.current).subscribe(() => this.cache.clear());
    CONTRIBUTIONS.remove('core.plugins.meta');
    defineContribution({
      id: 'core.plugins.meta',
      slot: 'core.title.meta',
      order: 50,
      meta: ctx => ctx.kind == 'episode' || !ctx.tmdbId ? [] : this.items(ctx.kind == 'tv' ? 'tv' : 'movie', ctx.tmdbId),
    });
  }

  private items(kind:'movie' | 'tv', tmdbId:number):Observable<MetaItem[]> {
    let profile = this.profiles.current.value?.id || null;
    let key = `${profile}:${kind}:${tmdbId}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = this.http.get<Extras>(`${this.server.api}/catalog/titles/${kind}/${tmdbId}/extras`, { params: profile ? { profile } : {} }).pipe(
        map(answer => answer.providers.flatMap(p => [
          ...p.ratings.map(r => ({ kind: 'score', source: 'provider', label: r.source, votes: r.votes ?? null,
            value: Math.round(r.value / r.max * 100) / 10 } as MetaItem)),
          ...p.tags.slice(0, 2).map(text => ({ kind: 'chip', text } as MetaItem)),
          ...p.lines.map(item => this.item(p.plugin, item)).filter(Boolean),
        ])),
        catchError(() => of([] as MetaItem[])),
        shareReplay(1),
      );
      this.cache.set(key, cached);
    }
    return cached;
  }

  // A plugin's item as the UI's: icons are the core's names or files of the plugin's assets/
  private item(plugin:string, item:any):MetaItem | null {
    switch (item?.kind) {
      case 'text': return { kind: 'text', text: item.text, small: !!item.small };
      case 'seal': return { kind: 'seal', text: item.text };
      case 'score': return { kind: 'score', source: 'provider', value: item.value, votes: item.votes ?? null, label: item.label };
      case 'chip': {
        let icon = typeof item.icon == 'string' ? item.icon : '';
        let url = /^assets\/[\w./-]+$/.test(icon) && !icon.includes('..') ? `${this.server.api}/plugins/${plugin}/${icon}`
          : /^[a-z][a-z0-9-]*$/.test(icon) ? icon : undefined;
        return { kind: 'chip', text: item.text, ...(url ? { icon: url } : {}) };
      }
      default: return null;
    }
  }
}
