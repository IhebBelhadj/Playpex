import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Schema } from '@playpex/protocol';
import { Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ServerService } from './server.service';
import { ProfilesService } from './profiles.service';

export type MediaTrack = Schema<'MediaTrack'>;
export type MediaTracks = Schema<'MediaTracks'>;

// A file's tracks on the server (GET /media/{ref}/tracks, docs/providers-plan.md
// §6): its own audio and subtitle streams, the torrent's audio and subtitle
// files that go with it, its other videos. The player switches them.
@Injectable({
  providedIn: 'root'
})
export class MediaTracksService {

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
  ) { }

  // null: an older server, or the file isn't there any more
  tracks(ref:string):Observable<MediaTracks | null> {
    let profile = this.profiles.current.value?.id;
    return this.http.get<MediaTracks>(`${this.server.api}/media/${ref}/tracks`, {
      params: { ...this.server.deviceParams(), ...(profile ? { profile } : {}) },
    }).pipe(catchError(() => of(null)));
  }

  // A subtitle track as WebVTT, for a <track>: the file's own stream, or a file of the list
  subtitleUrl(link:string, track:MediaTrack):string {
    let route = track.source == 'embedded' ? `subtitles/embedded/${track.index}` : `subtitles/file/${track.id.slice(2)}`;
    return this.server.media(`${link}/${route}`);
  }

  // Whether a track is one the player can turn on now
  static usable(track:MediaTrack):boolean {
    if (track.id.startsWith('s:')) return track.play == 'text' && track.available !== false;
    return track.play == 'direct' || track.play == 'convert';
  }

  // "English · 5.1 · Atmos", "French", "Commentary · file"
  static label(track:MediaTrack):string {
    let channels = track.channels == 1 ? 'Mono' : track.channels == 2 ? 'Stereo' : track.channels == 6 ? '5.1' : track.channels == 8 ? '7.1' :
      track.channels ? `${track.channels} channels` : '';
    let language = track.languageName || (track.language ? track.language.toUpperCase() : '');
    let title = track.title && track.title != language ? track.title : '';
    let parts = [language, channels, title, track.sdh ? 'SDH' : '', track.forced ? 'Forced' : ''].filter(Boolean);
    if (!parts.length) parts.push(track.id.startsWith('a:') ? `Track ${(track.index ?? 0) + 1}` : (track.name?.split('/').pop() || 'Subtitles'));
    return parts.join(' · ');
  }

  // What's said under a track's name: how it plays here
  static detail(track:MediaTrack):string {
    if (track.id.startsWith('a:')) {
      let file = track.source == 'file' ? 'Separate file' : '';
      let how = track.play == 'convert' ? 'Converted by the server' : track.play == 'none' ? 'Needs ffmpeg on the server' : '';
      return [file, how].filter(Boolean).join(' · ');
    }
    if (track.play == 'image') return "Can't be shown yet";
    if (track.play == 'none') return 'Needs ffmpeg on the server';
    if (track.available === false) return track.note || 'Not ready yet';
    return track.source == 'file' ? 'Separate file' : '';
  }
}
