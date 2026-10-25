// hls.js (MIT, pinned in apps/tv/package.json), loaded on first use: the
// player's HLS streams (docs/providers-plan.md §8.3). Its own typings need
// TypeScript 5.7 and this app builds with 4.7, so its prebuilt module is
// imported untyped and the little the player uses is described here.

export interface HlsTrack { lang?:string; name?:string; default?:boolean; forced?:boolean }

export interface HlsPlayer {
  audioTracks:HlsTrack[];
  subtitleTracks:HlsTrack[];
  audioTrack:number;
  subtitleTrack:number;
  subtitleDisplay:boolean;
  on(event:string, listener:(event:string, data:any) => void):void;
  loadSource(url:string):void;
  attachMedia(media:HTMLMediaElement):void;
  recoverMediaError():void;
  destroy():void;
}

export interface HlsClass {
  new (config?:object):HlsPlayer;
  isSupported():boolean;
  Events:{ LEVEL_LOADED:string, AUDIO_TRACKS_UPDATED:string, SUBTITLE_TRACKS_UPDATED:string, AUDIO_TRACK_SWITCHED:string, ERROR:string };
  ErrorTypes:{ NETWORK_ERROR:string, MEDIA_ERROR:string };
}

export function loadHls():Promise<HlsClass> {
  return import('hls.js/dist/hls.min.mjs').then(m => m.default);
}
