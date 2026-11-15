import { Injectable } from '@angular/core';
import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ServerService } from '../server.service';
import { isWeb, webClientHeaders } from './web-client';

// Playpex TV in a browser (docs/web-client-plan.md §5.2): what the Electron
// shell adds to every request to its server (electron/auth.js), the page adds
// itself: X-Playpex-Client (the server refuses cookie-authenticated writes
// without it, and tells this browser from the admin's dashboard by it) and
// X-Playpex-Device. The device cookie goes by itself (same origin).
@Injectable()
export class WebClientInterceptor implements HttpInterceptor {

  constructor(private server:ServerService) { }

  intercept(request:HttpRequest<unknown>, next:HttpHandler):Observable<HttpEvent<unknown>> {
    if (!isWeb || !request.url.startsWith(this.server.url + '/')) return next.handle(request);
    return next.handle(request.clone({ setHeaders: webClientHeaders() }));
  }
}
