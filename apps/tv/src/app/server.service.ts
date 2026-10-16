import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, shareReplay } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { API_PREFIX, SERVER_URL } from './server-config';

export type ServerInfo = Schema<'ServerInfo'>;

const DEVICE_KEY = 'playpex.deviceId';
const DEVICE_PARAM = 'device';   // @playpex/protocol DEVICE_PARAM

// This client's id for the server's torrent leases, made once. Until pairing
// gives each device a token (plan step 4); the Electron shell will own it
// when the client is separated (step 9).
function deviceId():string {
  const fresh = 'tv-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = fresh;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (e) {
    return fresh;   // not remembered: a new device per start
  }
}

// The Playpex server this client uses (resolved in server-config.ts). Every
// service builds its URLs from `api`; the API is described in
// packages/protocol/openapi.yaml.
@Injectable({
  providedIn: 'root'
})
export class ServerService {

  /** Origin of the server, e.g. http://localhost:28470 */
  readonly url = SERVER_URL;

  /** Base of every API call: <url>/api/v1 */
  readonly api = `${SERVER_URL}${API_PREFIX}`;

  /** Sent as `?device=` with torrent calls and media URLs (leases: who holds which torrent) */
  readonly deviceId = deviceId();

  private info$:Observable<ServerInfo> | null = null;

  constructor(private http:HttpClient) { }

  /** Absolute URL of a path the server handed out (e.g. a TorrentFile `link`) */
  absolute(path:string):string {
    return this.url + path;
  }

  /** `{device}` query params for torrent calls */
  deviceParams():{ [param:string]:string } {
    return { [DEVICE_PARAM]: this.deviceId };
  }

  /** Absolute URL of a media path the server handed out (a file `link`, its
   *  /transcode or /probe twin) with this device and extra query params */
  media(path:string, params:{ [param:string]:string | number } = {}):string {
    const url = new URL(this.absolute(path));
    url.searchParams.set(DEVICE_PARAM, this.deviceId);
    Object.keys(params).forEach(k => url.searchParams.set(k, String(params[k])));
    return url.toString();
  }

  /** GET /server, once */
  info():Observable<ServerInfo> {
    if (!this.info$) {
      this.info$ = this.http.get<ServerInfo>(`${this.api}/server`).pipe(shareReplay(1));
    }
    return this.info$;
  }
}
