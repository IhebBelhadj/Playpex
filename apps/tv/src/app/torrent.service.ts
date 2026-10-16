import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { ServerService } from './server.service';

@Injectable({
  providedIn: 'root'
})
export class TorrentService {

  constructor(private http:HttpClient, private server:ServerService) { }

  registerTorrent(magnet:string){
    return this.http.post(`${this.server.api}/torrents/` , {
      link : magnet
    })
  }

  getTorrent(hash:string){
    return this.http.get(`${this.server.api}/torrents/`+hash);
  }

  // Swarm stats: {metadata, peers: {total, unchocked}, traffic: {down, up}, speed: {down, up}, eta}
  // (bytes and bytes/s); works before the metadata has arrived
  getStats(hash:string){
    return this.http.get(`${this.server.api}/torrents/`+hash+'/stats');
  }

  deselectTorrent(hash){
    return this.http.post(`${this.server.api}/torrents/`+hash+'/deselect', null)
  }

  // TV episode torrents from EZTV + TheRARBG, best streaming candidate first.
  // Results may include season packs (`pack: true`).
  findEpisodeTorrents(imdbId:string , title:string , season:number , episode:number){
    return this.http.get<{torrents:any[], providerErrors:number}>(`${this.server.api}/shows/${imdbId}/torrents` , {
      params : { title, season, episode }
    })
  }

  // 18+ movie torrents (TheRARBG XXX + The Pirate Bay), matched by title and
  // year, best streaming candidate first; same shape as the episode results
  findAdultTorrents(title:string , year?:string){
    return this.http.get<{torrents:any[], providerErrors:number}>(`${this.server.api}/adult/torrents` , {
      params : year ? { title, year } : { title }
    })
  }

  removeTorrent(hash){
    return this.http.delete(`${this.server.api}/torrents/`+hash)
  }
}
