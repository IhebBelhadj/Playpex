import { HttpClient } from '@angular/common/http';
import { Injectable, OnDestroy } from '@angular/core';
import { firstValueFrom, Subscription } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { ServerEvents } from '../server-events.service';
import { ServerService } from '../server.service';
import { SettingsService } from '../settings.service';
import { Navigator } from '../nav/navigator.service';
import { PlaybackRequest, PlaybackService } from '../playback.service';
import { Profile, ProfilesService } from '../profiles.service';

type CastPlay = Schema<'CastPlayEvent'>;
type CastState = Schema<'CastState'>;

// This screen as a cast target (docs/cast-plan.md §4.2). While the device
// setting `cast.allowed` is on, the events socket says `control=cast` (the
// server lists this device in GET /cast/screens); a `cast.play` opens the
// player with the sender's request:
// - as the request's profile (the server checked it: a PIN, the sender's own);
//   none named: the profile picked here, and with none picked the cast fails;
// - an adults plugin's source is refused while a kids profile is picked here;
// - over what plays (the player is replaced), else over the screen shown;
//   the player says who cast it ("Cast from Pixel 8 · Anna").
// The player names the cast in its keepalives (`castId`) or, for what has no
// session (an embedded video), reports through `report()`.
@Injectable({
  providedIn: 'root'
})
export class CastReceiver implements OnDestroy {

  private subs:Subscription[] = [];

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private events:ServerEvents,
    private settings:SettingsService,
    private navigator:Navigator,
    private playback:PlaybackService,
    private profiles:ProfilesService,
  ) { }

  // AppComponent, once
  start() {
    if (!this.server.connected) return;
    this.subs.push(this.settings.changes('cast.allowed').subscribe(allowed => this.events.setControl('cast', allowed !== false)));
    this.subs.push(this.events.on<CastPlay>('cast.play').subscribe(e => this.play(e.data).catch(() => {})));
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }

  /** The player's word on its cast: { state, positionS?, durationS?, error? } */
  report(castId:string, state:CastState, extra:{ positionS?:number, durationS?:number, error?:string } = {}) {
    let body:any = { state };
    if (typeof extra.positionS == 'number' && isFinite(extra.positionS) && extra.positionS >= 0) body.positionS = extra.positionS;
    if (typeof extra.durationS == 'number' && isFinite(extra.durationS) && extra.durationS > 0) body.durationS = extra.durationS;
    if (extra.error) body.error = extra.error.slice(0, 300);
    this.http.post(`${this.server.api}/cast/${castId}/state`, body, { params: this.server.deviceParams() }).subscribe({ error: () => {} });
  }

  private async play(cast:CastPlay) {
    if (this.settings.value('cast.allowed') === false) return this.report(cast.castId, 'failed', { error: 'This screen doesn’t take casts' });
    let profile:Profile | null = this.profiles.current.value;
    if (profile?.isKid && cast.adults) {
      return this.report(cast.castId, 'failed', { error: 'This screen is showing a kids profile' });
    }
    if (cast.profileId && cast.profileId != profile?.id) {
      try {
        profile = await firstValueFrom(this.profiles.get(cast.profileId));
      }
      catch (e) {
        return this.report(cast.castId, 'failed', { error: 'That profile isn’t on this server any more' });
      }
      this.profiles.current.next(profile);
    }
    if (!profile) return this.report(cast.castId, 'failed', { error: 'Choose who’s watching on the screen first' });

    let request = CastReceiver.playbackRequest(cast);
    request.castFrom = [cast.from?.name || 'a device', profile.name].join(' · ');
    this.playback.play(request, { replace: this.navigator.current?.screen.id == 'core.player' });
  }

  /** What the player gets from a CastRequest */
  static playbackRequest(cast:CastPlay):PlaybackRequest {
    let r = cast.request, src:any = r.source, item = r.item || {} as any;
    let request:PlaybackRequest = {
      title: r.title,
      subtitle: r.subtitle,
      year: r.year,
      imdbId: item.imdbId,
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      season: item.season,
      episode: item.episode,
      artwork: r.artwork ? { title: r.artwork.title || r.title, posterPath: r.artwork.posterPath || null, backdropPath: r.artwork.backdropPath || null } as any : undefined,
      startAt: typeof r.positionS == 'number' ? r.positionS : undefined,
      tracking: r.tracking == 'none' ? 'none' : 'full',
      castId: cast.castId,
    };
    if (src.ref) request.source = { ref: src.ref, infoHash: src.infoHash, path: src.path, ...(src.format ? { format: src.format } : {}) };
    else if (src.magnet) {
      request.magnet = src.magnet;
      if (src.file) request.file = src.file;
    }
    else if (src.embed) request.embed = { provider: src.embed.provider, id: src.embed.id };
    // undefined fields out: the player tells "unset" from a value
    Object.keys(request).forEach(k => request[k] === undefined && delete request[k]);
    return request;
  }
}
