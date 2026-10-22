import { Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { display } from './ui/public-api';

// First start on this device: the display size (core.display) before anything
// else, so the screen reads comfortably from the start (ui/display.ts)
@Injectable({
  providedIn: 'root'
})
export class DisplayGuard implements CanActivate {

  constructor(private router:Router) { }

  canActivate():boolean | UrlTree {
    return display.chosen || this.router.parseUrl('/display');
  }
}
