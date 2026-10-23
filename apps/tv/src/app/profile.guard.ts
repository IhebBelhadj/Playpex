import { Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { ProfilesService } from './profiles.service';

// Pages that need someone watching: without a current profile → "Who's watching?"
@Injectable({
  providedIn: 'root'
})
export class ProfileGuard implements CanActivate {

  constructor(private profiles:ProfilesService, private router:Router) { }

  canActivate():boolean | UrlTree {
    return this.profiles.current.value ? true : this.router.parseUrl('/profiles');
  }
}

// The screens of an `audience: adults` plugin: someone watching, and not a kids profile
@Injectable({
  providedIn: 'root'
})
export class AdultsGuard implements CanActivate {

  constructor(private profiles:ProfilesService, private router:Router) { }

  canActivate():boolean | UrlTree {
    let profile = this.profiles.current.value;
    if (!profile) return this.router.parseUrl('/profiles');
    return profile.isKid ? this.router.parseUrl('/movies/list') : true;
  }
}
