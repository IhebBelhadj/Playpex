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

  // Swarm stats: {metadata, peers: {total, unchocked}, traffic: {down, up}, speed: {down, up}, eta}
  // (bytes and bytes/s); works before the metadata has arrived
  getStats(hash:string){
    return this.http.get(`${STREAMING_SERVER}/torrents/`+hash+'/stats');
  }

  deselectTorrent(hash){
    return this.http.post(`${STREAMING_SERVER}/torrents/`+hash+'/deselect', null)
  }

  // TV episode torrents from EZTV + TheRARBG, best streaming candidate first.
  // Results may include season packs (`pack: true`).
  findEpisodeTorrents(imdbId:string , title:string , season:number , episode:number){
    return this.http.get<{torrents:any[], providerErrors:number}>(`${STREAMING_SERVER}/api/shows/${imdbId}/torrents` , {
      params : { title, season, episode }
    })
  }

  // 18+ movie torrents (TheRARBG XXX + The Pirate Bay), matched by title and
  // year, best streaming candidate first; same shape as the episode results
  findAdultTorrents(title:string , year?:string){
    return this.http.get<{torrents:any[], providerErrors:number}>(`${STREAMING_SERVER}/api/adult/torrents` , {
      params : year ? { title, year } : { title }
    })
  }

  removeTorrent(hash){
    return this.http.delete(`${STREAMING_SERVER}/torrents/`+hash)
  }
}
