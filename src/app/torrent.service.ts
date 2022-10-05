import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class TorrentService {

  constructor(private http:HttpClient) { }

  registerTorrent(magnet:string){
    return this.http.post('http://localhost:9000/torrents/' , {
      link : magnet
    })
  }

  getTorrent(hash:string){
    return this.http.get("http://localhost:9000/torrents/"+hash);
  }

  deselectTorrent(hash){
    return this.http.get("http://localhost:9000/torrents/"+hash+'/deselect')
  }
}
