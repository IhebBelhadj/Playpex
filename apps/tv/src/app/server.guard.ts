import { Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { ServerService } from './server.service';

// No usable server (none found, not paired, refused…) → /connect. On the
// profile pages: everything else needs a profile, so it goes through them.
@Injectable({
  providedIn: 'root'
})
export class ServerGuard implements CanActivate {

  constructor(private server:ServerService, private router:Router) { }

  canActivate():boolean | UrlTree {
    return this.server.connected || this.router.parseUrl('/connect');
  }
}
