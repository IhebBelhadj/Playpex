import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, shareReplay } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { API_PREFIX, connection } from './server-config';

export type ServerInfo = Schema<'ServerInfo'>;

const DEVICE_PARAM = 'device';   // @playpex/protocol DEVICE_PARAM

// The Playpex server this client uses (resolved before boot in
// server-config.ts; none → the /connect page, ServerGuard). Every service
// builds its URLs from `api`; the API is described in
// packages/protocol/openapi.yaml. In the Electron app the shell adds the
// device token and client headers to every request (apps/tv/electron/auth.js).
@Injectable({
  providedIn: 'root'
})
export class ServerService {

  /** false → no usable server: the app shows /connect */
  readonly connected = !!connection?.server;

  /** Origin of the server, e.g. http://192.168.1.20:28470 ('' when not connected) */
  readonly url = connection?.server?.url || '';

  /** Its name, for the menu and messages */
  readonly name = connection?.server?.name || '';

  /** On this machine (loopback: no pairing) */
  readonly local = !!connection?.server?.local;

  /** Base of every API call: <url>/api/v1 */
  readonly api = `${this.url}${API_PREFIX}`;

  /** This install's id (client.json in Electron): `?device=` on torrent calls and media URLs (leases) */
  readonly deviceId = connection?.deviceId || '';

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
