import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ServerService } from './server.service';

export interface SubtitleProvider {
  id: string;
  name: string;
  description: string;
  supports: { movie: boolean, episode: boolean };
  enabled: boolean;              // false when the provider needs an API key that isn't set
}

export interface Subtitle {
  provider: string;
  ref: string;                   // provider-specific id, passed back to /file
  language: string;              // ISO 639-1
  languageName: string;
  name: string;
}

@Injectable({
  providedIn: 'root'
})
export class SubtitlesService {

  constructor(private http:HttpClient, private server:ServerService) { }

  getProviders():Observable<SubtitleProvider[]> {
    return this.http.get<SubtitleProvider[]>(`${this.server.api}/subtitles/providers`);
  }

  // query: movie or show IMDb id, plus season/episode for TV
  search(provider:string , query:{imdbId:string, season?:number, episode?:number} , languages = "en,ar,de,es,fr,it")
    :Observable<{provider:string, subtitles:Subtitle[], unsupported?:boolean}> {
    let params: any = { provider, imdb_id: query.imdbId, languages };
    if (query.season) {
      params.season = query.season;
      params.episode = query.episode;
    }
    return this.http.get<any>(`${this.server.api}/subtitles/search`, { params });
  }

  // WebVTT URL for <track src>
  fileUrl(subtitle:Subtitle):string {
    let params = new URLSearchParams({ provider: subtitle.provider, ref: subtitle.ref, lang: subtitle.language });
    return `${this.server.api}/subtitles/file?${params}`;
  }

  // The provider picked last time is the profile's setting `subtitles.provider` (SettingsService)

}
