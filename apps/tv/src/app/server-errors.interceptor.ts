import { Injectable } from '@angular/core';
import { HttpErrorResponse, HttpEvent, HttpHandler, HttpInterceptor, HttpRequest, HttpResponse } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { ServerService } from './server.service';
import { ConnectionService } from './connection.service';

// Watches the answers of the server (not TMDB's): network failures count
// towards "Lost connection"; 401 PAIRING_REQUIRED and 426 mean this device
// can't use the server any more (ConnectionService).
@Injectable()
export class ServerErrorsInterceptor implements HttpInterceptor {

  constructor(private server:ServerService, private connection:ConnectionService) { }

  intercept(request:HttpRequest<unknown>, next:HttpHandler):Observable<HttpEvent<unknown>> {
    if (!this.server.connected || !request.url.startsWith(this.server.url + '/')) {
      return next.handle(request);
    }
    return next.handle(request).pipe(tap({
      next: event => {
        if (event instanceof HttpResponse) this.connection.succeeded();
      },
      error: (err:HttpErrorResponse) => {
        const code = err.error && err.error['code'];
        if (err.status === 0) {
          this.connection.failed();
          return;
        }
        this.connection.succeeded();
        if (err.status === 401 && code === 'PAIRING_REQUIRED') {
          this.connection.refused('revoked');
        } else if (err.status === 426) {
          this.connection.refused('incompatible', code);
        }
      }
    }));
  }
}
