import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { STREAMING_SERVER } from './server-config';

@Injectable({
  providedIn: 'root'
})
export class TorrentService {

  constructor(private http:HttpClient) { }

  registerTorrent(magnet:string){
    return this.http.post(`${STREAMING_SERVER}/torrents/` , {
      link : magnet
    })
  }

  getTorrent(hash:string){
    return this.http.get(`${STREAMING_SERVER}/torrents/`+hash);
  }

  deselectTorrent(hash){
    return this.http.get(`${STREAMING_SERVER}/torrents/`+hash+'/deselect')
  }

  // TV episode torrents from EZTV + TheRARBG, best streaming candidate first.
  // Results may include season packs (`pack: true`).
  findEpisodeTorrents(imdbId:string , title:string , season:number , episode:number){
    return this.http.get<{torrents:any[], providerErrors:number}>(`${STREAMING_SERVER}/api/shows/${imdbId}/torrents` , {
      params : { title, season, episode }
    })
  }

  removeTorrent(hash){
    return this.http.delete(`${STREAMING_SERVER}/torrents/`+hash)
  }
}
