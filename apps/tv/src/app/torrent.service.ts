import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type { Schema } from '@playpex/protocol';
import { ServerService } from './server.service';

@Injectable({
  providedIn: 'root'
})
export class TorrentService {

  constructor(private http:HttpClient, private server:ServerService) { }

  // Adds the torrent and holds it for this device (server lease) until
  // removeTorrent; a player keeps it with keepTorrent. 503 BUSY past the
  // server's torrent limit.
  registerTorrent(magnet:string){
    return this.http.post(`${this.server.api}/torrents/` , {
      link : magnet
    } , { params : this.server.deviceParams() })
  }

  // Every minute while the player is open (a paused video makes no
  // requests), with what it plays: shown in the server's Activity, and
  // `media` (which TMDB title) kept with the server's download
  keepTorrent(hash:string , state:Schema<'KeepaliveRequest'>){
    return this.http.post(`${this.server.api}/torrents/${hash}/keepalive` , state , { params : this.server.deviceParams() })
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

  // Releases this device's lease: the server stops the torrent (and deletes
  // its data) once no device holds it any more
  removeTorrent(hash){
    return this.http.delete(`${this.server.api}/torrents/`+hash , { params : this.server.deviceParams() })
  }
}
