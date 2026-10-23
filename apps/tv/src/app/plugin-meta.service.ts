import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, map, merge, Observable, of, shareReplay } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { ProfilesService } from './profiles.service';
import { ServerEvents } from './server-events.service';
import { ServerService } from './server.service';
import { defineContribution, CONTRIBUTIONS, MetaItem } from './ui/public-api';

type PluginMeta = Schema<'PluginTitleMeta'>;

// What the server's plugins add to a title's meta line (their
// `metadata.title` hook, docs/plugins-plan.md §4.3, through POST
// /plugins/meta): another score, a tag. A contribution to `core.title.meta`
// like the core's "On this server". One request per title and profile, kept
// until a plugin or the profile changes; a failure shows nothing.
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
      meta: ctx => ctx.kind == 'episode' || !ctx.tmdbId ? [] : this.items(ctx.kind == 'tv' ? 'show' : 'movie', ctx.tmdbId, ctx.imdbId),
    });
  }

  private items(kind:'movie' | 'show', tmdbId:number, imdbId:string | null):Observable<MetaItem[]> {
    let profile = this.profiles.current.value?.id || null;
    let key = `${profile}:${kind}:${tmdbId}`;
    let cached = this.cache.get(key);
    if (!cached) {
      let title = { kind, tmdbId, ...(imdbId ? { imdbId } : {}) };
      cached = this.http.post<PluginMeta>(`${this.server.api}/plugins/meta`, { title }, { params: profile ? { profile } : {} }).pipe(
        map(answer => answer.meta.flatMap(m => m.items.map(item => this.item(m.plugin, item as any)).filter(Boolean))),
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
