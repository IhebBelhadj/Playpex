import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { ServerService } from '../server.service';
import { PlaybackRequest } from '../playback.service';

export type CastScreen = Schema<'CastScreen'>;
type CastRequest = Schema<'CastRequest'>;

// This screen as a sender (docs/cast-plan.md §4.2): the other screens
// (GET /cast/screens, without this one) and a cast to one of them; the player's
// "Play on another screen" hands what it plays over at its position.
@Injectable({
  providedIn: 'root'
})
export class CastSender {

  constructor(private http:HttpClient, private server:ServerService) { }

  /** The other screens on now (none: [], also when the server can't say) */
  async screens():Promise<CastScreen[]> {
    if (!this.server.connected) return [];
    try {
      let list = await firstValueFrom(this.http.get<CastScreen[]>(`${this.server.api}/cast/screens`, { params: this.server.deviceParams() }));
      return (list || []).filter(s => !s.self);
    }
    catch (e) {
      return [];
    }
  }

  /** Casts; rejects with the server's sentence for people */
  async play(screen:CastScreen, request:CastRequest):Promise<string> {
    try {
      let answer = await firstValueFrom(this.http.post<{ castId:string }>(
        `${this.server.api}/cast/screens/${encodeURIComponent(screen.deviceId)}/play`, request, { params: this.server.deviceParams() }));
      return answer.castId;
    }
    catch (e) {
      throw new Error(e?.error?.error || `Couldn’t play on ${screen.name}`);
    }
  }

  /**
   * What the player plays, for another screen: the stream it reads (a media ref is
   * the server's: it plays there as it is), else its embed or the torrent; at `positionS`
   */
  static request(playback:PlaybackRequest, now:{ ref:string | null, format:'file' | 'hls' | 'live' | 'embed', positionS?:number, profileId?:string | null }):CastRequest | null {
    let source:CastRequest['source'] | null =
      playback.embed ? { embed: { provider: playback.embed.provider, id: playback.embed.id } }
      : now.ref ? { ref: now.ref, format: now.format == 'embed' ? 'file' : now.format }
      : playback.source ? { ref: playback.source.ref, ...(playback.source.format ? { format: playback.source.format } : {}) } as any
      : playback.magnet ? { magnet: playback.magnet, ...(playback.file ? { file: compact(playback.file) } : {}) }
      : null;
    if (!source) return null;
    let request:CastRequest = {
      title: playback.title,
      subtitle: playback.subtitle,
      year: playback.year,
      source,
      tracking: playback.tracking == 'none' ? 'none' : 'full',
    };
    if (playback.artwork) request.artwork = compact({ title: playback.artwork.title, posterPath: playback.artwork.posterPath, backdropPath: playback.artwork.backdropPath });
    if (playback.tmdbId || playback.imdbId) {
      request.item = compact({ mediaType: playback.mediaType, tmdbId: playback.tmdbId, imdbId: playback.imdbId, season: playback.season, episode: playback.episode });
    }
    if (typeof now.positionS == 'number' && now.positionS > 5 && now.format != 'live') request.positionS = Math.floor(now.positionS);
    if (now.profileId) request.profileId = now.profileId;
    return compact(request);
  }
}

// null / undefined fields out: the schema has no nulls
function compact<T>(o:T):T {
  Object.keys(o).forEach(k => (o[k] === undefined || o[k] === null) && delete o[k]);
  return o;
}
