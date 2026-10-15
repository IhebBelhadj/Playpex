import { Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { ProfilesService } from './profiles.service';
import { AdultService } from './adult.service';

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

// The 18+ section: someone watching, and not on a kids profile
@Injectable({
  providedIn: 'root'
})
export class AdultGuard implements CanActivate {

  constructor(private profiles:ProfilesService, private router:Router) { }

  canActivate():boolean | UrlTree {
    let profile = this.profiles.current.value;
    if (!profile) return this.router.parseUrl('/profiles');
    return profile.isKid ? this.router.parseUrl('/movies/list') : true;
  }
}

// /adult itself: the profile's layout (posters or the compact release list)
@Injectable({
  providedIn: 'root'
})
export class AdultLayoutGuard implements CanActivate {

  constructor(private adult:AdultService, private router:Router) { }

  canActivate():UrlTree {
    return this.router.parseUrl(this.adult.layoutUrl());
  }
}
