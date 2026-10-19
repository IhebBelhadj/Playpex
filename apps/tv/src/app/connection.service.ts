import { Injectable, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';
import { ServerService } from './server.service';
import { desktop } from './desktop';
import { Navigator } from './nav/navigator.service';

// The server going away or refusing this device (docs/server-separation-plan.md §10.2):
//   - 3 network failures in a row → the "Lost connection" modal: Retry (the
//     shell finds the server again by id, also at a new address, and reloads)
//     or Choose server (/connect)
//   - 401 PAIRING_REQUIRED (device revoked, or loopback pairing turned on) →
//     the shell forgets the token and reloads into /connect, which explains
//   - 426 CLIENT_TOO_OLD / SERVER_TOO_OLD → the same, with an update screen
// Fed by ServerErrorsInterceptor. The modal is <connection-lost> (a layer of
// the nav system while open).
@Injectable({
  providedIn: 'root'
})
export class ConnectionService {

  static readonly FAILURES = 3;

  isOpen = false;
  retrying = false;
  stillLost = false;

  private failures = 0;
  private refusing = false;
  private changes = new Subject<void>();

  constructor(
    private server:ServerService,
    private http:HttpClient,
    private navigator:Navigator,
    private zone:NgZone,
  ) { }

  get serverName():string {
    return this.server.name;
  }

  succeeded() {
    this.failures = 0;
  }

  failed() {
    if (++this.failures >= ConnectionService.FAILURES && !this.isOpen && this.navigator.current?.screen.id != 'core.connect') {
      this.isOpen = true;
      this.stillLost = false;
      this.changes.next();
    }
  }

  refused(reason:'revoked' | 'incompatible', code?:string) {
    if (this.refusing) return;
    this.refusing = true;
    const bridge = desktop();
    if (bridge) {
      bridge.connection.drop(reason, code);   // reloads the app into /connect
    } else {
      this.zone.run(() => this.navigator.reset({ screen: 'core.connect', payload: { reason, code } }));
      this.refusing = false;
    }
  }

  retry() {
    if (this.retrying) return;
    this.retrying = true;
    this.stillLost = false;
    this.changes.next();
    const bridge = desktop();
    const done = (found:boolean) => this.zone.run(() => {
      this.retrying = false;
      if (found) {
        this.failures = 0;
        this.close();
      } else {
        this.stillLost = true;
      }
      this.changes.next();
    });
    if (bridge) {
      // found: the shell reloads the app (at the server's new address, if it moved)
      bridge.connection.reconnect().then(state => done(!!state.server), () => done(false));
    } else {
      this.http.get(`${this.server.api}/server`).subscribe({ next: () => done(true), error: () => done(false) });
    }
  }

  chooseServer() {
    this.close();
    this.navigator.reset({ screen: 'core.connect' });
  }

  close() {
    this.isOpen = false;
    this.changes.next();
  }

  onChange() {
    return this.changes.asObservable();
  }
}
