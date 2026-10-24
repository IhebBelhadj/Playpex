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

  // The same for a file played by its media ref (a file on the server, a
  // download's file: PlaybackRequest.source); the lease was taken by its
  // first GET /media/{ref}
  keepMedia(ref:string , state:Schema<'KeepaliveRequest'>){
    return this.http.post(`${this.server.api}/media/${ref}/keepalive` , state , { params : this.server.deviceParams() })
  }

  releaseMedia(ref:string){
    return this.http.delete(`${this.server.api}/media/${ref}` , { params : this.server.deviceParams() })
  }

  // `hint`: what to play of it (an episode, a plugin's file): the answer's `chosen`
  getTorrent(hash:string , hint?:{ season?:number, episode?:number, fileIndex?:number | null, fileName?:string | null }){
    let params = {};
    Object.entries(hint || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') params[k] = String(v); });
    return this.http.get(`${this.server.api}/torrents/`+hash , { params });
  }

  // Swarm stats: {metadata, peers: {total, unchocked}, traffic: {down, up}, speed: {down, up}, eta}
  // (bytes and bytes/s); works before the metadata has arrived
  getStats(hash:string){
    return this.http.get(`${this.server.api}/torrents/`+hash+'/stats');
  }

  deselectTorrent(hash){
    return this.http.post(`${this.server.api}/torrents/`+hash+'/deselect', null)
  }

  // Releases this device's lease: the server stops the torrent (and deletes
  // its data) once no device holds it any more
  removeTorrent(hash){
    return this.http.delete(`${this.server.api}/torrents/`+hash , { params : this.server.deviceParams() })
  }
}
