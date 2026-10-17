import { Injectable } from '@angular/core';
import { from, Observable, of } from 'rxjs';
import { desktop } from './desktop';

// Quit / Sleep / Shutdown / Restart: the Electron shell does it
// (apps/tv/electron/power.js); nothing in a browser
@Injectable({
  providedIn: 'root'
})
export class PowerService {

  sendPowerInstruction(instruction:string):Observable<void> {
    const bridge = desktop();
    return bridge ? from(bridge.power(instruction)) : of(undefined);
  }
}
