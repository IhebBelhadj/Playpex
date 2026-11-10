import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { SettingsService } from './settings.service';

export interface VolumeHud {
  percent: number;
  muted: boolean;
}

const STEP = 5;
const HUD_MS = 1600;

// This device's playback volume from anywhere: the remote control's volume
// keys (a phone's volume buttons in Server Manager, the dashboard's − / +)
// change it whatever screen is shown. The volume is the device setting
// `player.volume` (0–100 %, the player's Settings › Audio slider), so it
// lasts; sound off is for this run only. The player follows both
// (`settings.changes('player.volume')`, `muted$`); `hud$` is what the remote
// overlay shows for a moment after a change (null: nothing).
@Injectable({
  providedIn: 'root'
})
export class VolumeControl {

  readonly muted$ = new BehaviorSubject<boolean>(false);
  readonly hud$ = new BehaviorSubject<VolumeHud | null>(null);
  private hudTimer:any = null;

  constructor(private settings:SettingsService) { }

  get percent():number {
    let v = Number(this.settings.value('player.volume'));
    return isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
  }

  /** One step up (+1) or down (−1); a step up turns the sound back on */
  step(direction:1 | -1) {
    let next = Math.max(0, Math.min(100, Math.round(this.percent / STEP) * STEP + direction * STEP));
    if (direction > 0) this.setMuted(false);
    if (next != this.percent) this.settings.set('player.volume', next, { debounceMs: 500 });
    this.show();
  }

  toggleMute() {
    this.setMuted(!this.muted$.value);
    this.show();
  }

  setMuted(muted:boolean) {
    if (this.muted$.value != muted) this.muted$.next(muted);
  }

  private show() {
    this.hud$.next({ percent: this.percent, muted: this.muted$.value });
    clearTimeout(this.hudTimer);
    this.hudTimer = setTimeout(() => this.hud$.next(null), HUD_MS);
  }
}
