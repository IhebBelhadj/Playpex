import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { filter, map, Observable, share, Subject } from 'rxjs';
import { ServerService } from './server.service';

export interface ServerEvent<T = any> {
  topic:string;
  time:string;
  data:T;
}

// The server's events WebSocket (`<api>/events`, docs/api/events.md): one
// socket for the app, opened on the first subscriber, closed with the last;
// reconnects with a growing delay (2 s … 30 s) while someone listens. The
// shell adds the device token to the upgrade request like to any request
// (apps/tv/electron/auth.js).
//
//   events.on<{ keys:string[] }>('settings.changed').subscribe(e => …)
@Injectable({
  providedIn: 'root'
})
export class ServerEvents implements OnDestroy {

  private socket:WebSocket | null = null;
  private retryMs = 2000;
  private retryTimer:any = null;
  private listeners = 0;
  private incoming = new Subject<ServerEvent>();
  private all$:Observable<ServerEvent>;

  constructor(private server:ServerService, private zone:NgZone) {
    this.all$ = new Observable<ServerEvent>(subscriber => {
      this.listeners++;
      this.open();
      let sub = this.incoming.subscribe(subscriber);
      return () => {
        sub.unsubscribe();
        if (--this.listeners == 0) this.close();
      };
    }).pipe(share());
  }

  /** Events whose topic starts with `prefix` */
  on<T = any>(prefix:string):Observable<ServerEvent<T>> {
    return this.all$.pipe(filter(e => e.topic.indexOf(prefix) === 0), map(e => e as ServerEvent<T>));
  }

  ngOnDestroy(): void {
    this.close();
  }

  private open() {
    if (this.socket || !this.server.connected || typeof WebSocket == 'undefined') return;
    let url = new URL(`${this.server.api}/events`);
    url.protocol = url.protocol == 'https:' ? 'wss:' : 'ws:';
    // a browser (ng serve) has no shell to add the device header
    url.searchParams.set('device', this.server.deviceId);
    this.zone.runOutsideAngular(() => {
      let socket = this.socket = new WebSocket(url.toString());
      socket.onopen = () => this.retryMs = 2000;
      socket.onmessage = message => {
        let event:ServerEvent;
        try { event = JSON.parse(message.data); } catch (e) { return; }
        if (event && typeof event.topic == 'string') this.zone.run(() => this.incoming.next(event));
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.listeners > 0) {
          this.retryTimer = setTimeout(() => this.open(), this.retryMs);
          this.retryMs = Math.min(30000, this.retryMs * 2);
        }
      };
    });
  }

  private close() {
    clearTimeout(this.retryTimer);
    let socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
