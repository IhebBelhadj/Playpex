import { Injectable, NgZone } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';
import { ConnectionService } from './connection.service';
import { InputDispatcher, Intent, LayerStack, NavAction, Navigator } from './nav/public-api';
import { NotificationService } from './notification.service';
import { PlaybackService } from './playback.service';
import { PlayChoiceService } from './play-choice.service';
import { ProfilesService } from './profiles.service';
import { ReleasesKind, ReleasesService } from './releases.service';
import { ServerService } from './server.service';
import { installHelloPlugin } from './plugins-dev/hello/hello-plugin';
import { TorrentPickerService } from './torrent-picker.service';

// the overlays overlay() opens with fixture data (their screenshots)
export type DevOverlay = 'torrents' | 'playChoice' | 'error' | 'connectionLost';

// Development builds only: window.playpexDev, what scripts/screens.js (the UI
// screenshots, docs/ui-system-plan.md step 0) drives the app with. Never a URL
// query: a query on the boot URL leaves the app blank (root CLAUDE.md).
export interface PlaypexDev {
  open(intent:Intent):Promise<boolean>;
  reset(intent:Intent):Promise<boolean>;
  // enters a profile without a PIN (the one named, else the first adult one)
  profile(name?:string):Promise<string>;
  releases(kind:ReleasesKind, query:string, label:string, imdb?:string):void;
  // the screen on top of the history
  screen():string | null;
  // opens one of the shell's overlays with fixture data (over the screen shown)
  overlay(kind:DevOverlay):void;
  // select / back / leave, as the keys would send them
  input(action:NavAction):boolean;
  // the open layers' ids, bottom to top
  layers():string[];
  // the player on a plain video file (no torrent): a movie, or Breaking Bad
  // S01E01 (its Up next is S01E02)
  player(src:string, kind?:'movie' | 'episode'):void;
  // the server's API base and this client's device id (scenarios read the settings with them)
  api:string;
  deviceId:string;
  // the example plugin's contributions on / off (src/app/plugins-dev/hello)
  plugin(name:'hello', on:boolean):void;
}

@Injectable({ providedIn: 'root' })
export class DevHook {

  constructor(
    private navigator:Navigator,
    private profiles:ProfilesService,
    private releases:ReleasesService,
    private torrents:TorrentPickerService,
    private playChoice:PlayChoiceService,
    private notifications:NotificationService,
    private connection:ConnectionService,
    private dispatcher:InputDispatcher,
    private playback:PlaybackService,
    private layerStack:LayerStack,
    private server:ServerService,
    private zone:NgZone,
  ) { }

  install() {
    if (environment.production) return;
    let run = <T>(fn:() => T):T => this.zone.run(fn);
    let hook:PlaypexDev = {
      open: intent => run(() => this.navigator.open(intent)),
      reset: intent => run(() => this.navigator.reset(intent)),
      profile: name => run(() => this.enterProfile(name)),
      releases: (kind, query, label, imdb) => run(() => this.releases.open(kind, query, { label }, imdb ?? null)),
      screen: () => {
        let stack = this.navigator.stack$.value;
        return stack.length ? stack[stack.length - 1].screen.id : null;
      },
      overlay: kind => run(() => this.overlay(kind)),
      input: action => run(() => this.dispatcher.dispatch(action)),
      layers: () => this.layerStack.layers.map(layer => layer.def.id),
      player: (src, kind = 'movie') => run(() => this.playback.play(kind == 'episode'
        ? { title: 'Breaking Bad', subtitle: 'S01E01 · Pilot', magnet: '', devSrc: src, imdbId: 'tt0903747',
            season: 1, episode: 1, mediaType: 'tv', tmdbId: 1396, startAt: 0 }
        : { title: 'Heat', year: '1995', runtimeMinutes: 170, magnet: '', devSrc: src, imdbId: 'tt0113277',
            mediaType: 'movie', tmdbId: 949, startAt: 0 })),
      api: this.server.api,
      deviceId: this.server.deviceId,
      plugin: (name, on) => run(() => installHelloPlugin(on)),
    };
    window['playpexDev'] = hook;
  }

  private overlay(kind:DevOverlay) {
    switch (kind) {
      case 'torrents':
        this.torrents.choose('Heat', [
          { quality: '1080p', tags: ['BluRay', 'x264', '6 ch'], size: '2.6 GB', seeds: 412, peers: 37, warnings: [], recommended: true, torrent: null },
          { quality: '720p', tags: ['BluRay', 'x264'], size: '1.3 GB', seeds: 198, peers: 12, warnings: [], torrent: null },
          { quality: '2160p', tags: ['BluRay', 'x265', '10-bit'], size: '7.9 GB', seeds: 54, peers: 9,
            name: 'Heat.1995.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.5.1', warnings: ['May not play (x265 / 10-bit / 4K)'], torrent: null },
        ]).subscribe();
        break;
      case 'playChoice':
        this.playChoice.choose('Heat', { positionS: 2533, durationS: 10200 }).subscribe();
        break;
      case 'error':
        this.notifications.sendNotification('error', 'The server is busy: 4 torrents are already streaming.');
        break;
      case 'connectionLost':
        this.connection.isOpen = true;
        this.connection.stillLost = false;
        break;
    }
  }

  private async enterProfile(name?:string):Promise<string> {
    let { profiles } = await firstValueFrom(this.profiles.list());
    let open = profiles.filter(p => !p.hasPin);
    let profile = name ? open.find(p => p.name == name) : open.find(p => !p.isKid) || open[0];
    if (!profile) throw new Error(name ? `No profile ${name} without a PIN` : 'No profile without a PIN');
    await firstValueFrom(this.profiles.unlock(profile.id));
    return profile.name;
  }
}
