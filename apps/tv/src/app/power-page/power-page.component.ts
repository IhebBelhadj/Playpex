import { PowerService } from './../power.service';
import { Component, AfterViewInit } from '@angular/core';
import { Profile, ProfilesService } from '../profiles.service';
import { Navigator } from '../nav/public-api';
import { isWeb } from '../web/web-client';
import { desktop } from '../desktop';
import { phoneViewAvailable, placeOf, switchToPhoneView } from '../web/switch-view';

interface PowerOption {
  key:'quit' | 'sleep' | 'restart' | 'shutdown' | 'profiles' | 'fullscreen' | 'phone';
  label:string;
  does:string;
}

// The ways out, in order of how far they go: Playpex, then this computer
const OPTIONS:PowerOption[] = [
  { key: 'quit', label: 'Close Playpex', does: 'Back to the desktop' },
  { key: 'sleep', label: 'Sleep', does: 'Playpex is here when the computer wakes' },
  { key: 'restart', label: 'Restart', does: 'Turns the computer off and on again' },
  { key: 'shutdown', label: 'Shut down', does: 'Turns the computer off' },
];

// In a browser (docs/web-client-plan.md §5.3): nothing to quit or turn off
// from a page; the profile picker and the browser's full screen instead
const WEB_OPTIONS:PowerOption[] = [
  { key: 'profiles', label: 'Switch profile', does: 'Back to Who\'s watching?' },
  { key: 'fullscreen', label: 'Full screen', does: 'Use the whole screen' },
];
// while the server serves Playpex Mobile (docs/web-unified-plan.md §5): the same place there
const PHONE_VIEW:PowerOption = { key: 'phone', label: 'Phone view', does: 'Playpex Mobile in this browser, at the same place' };

// Close Playpex / Sleep / Restart / Shut down (core.power, src/app/nav): the
// last step back out of a section. Who's watching and that their places are
// kept, then the options (a one-column pxGrid in section `powerControls`; the
// focused one says what it does). Back closes it (the nav system's pop); the
// menu is hidden here by the screen's chrome
@Component({
  selector: 'power-page',
  templateUrl: './power-page.component.html',
  styleUrls: ['./power-page.component.scss']
})
export class PowerPageComponent implements AfterViewInit {

  options = isWeb && !desktop() ? WEB_OPTIONS : OPTIONS;
  readonly profile:Profile | null;
  readonly avatarUrl:string;

  constructor(private power:PowerService, profiles:ProfilesService, private navigator:Navigator) {
    this.profile = profiles.current.value;
    this.avatarUrl = ProfilesService.avatarUrl(this.profile?.avatar ?? null);
    if (this.options == WEB_OPTIONS) {
      phoneViewAvailable().then(ok => { if (ok) this.options = [...WEB_OPTIONS, PHONE_VIEW]; });
    }
  }

  ngAfterViewInit(): void {
    let first = document.querySelector('.powerPage [data-px-key]') as HTMLElement;
    document.querySelectorAll('.menuItem').forEach(item => item.classList.remove('focused'));
    first?.focus({ preventScroll: true });
    first?.classList.add('focused');
  }

  send(instruction:PowerOption['key']) {
    if (instruction == 'profiles') {
      this.navigator.reset({ screen: 'core.profiles' });
      return;
    }
    if (instruction == 'phone') {
      // where Back from here goes: the section (or title) the power menu opened over
      let stack = this.navigator.stack, below = stack[stack.length - 2];
      switchToPhoneView(below ? placeOf(this.navigator.urlFor({ screen: below.screen.id, params: below.params })) : 'home');
      return;
    }
    if (instruction == 'fullscreen') {
      let request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      request?.catch?.(() => { });
      return;
    }
    this.power.sendPowerInstruction(instruction).subscribe();
  }

  label(o:PowerOption):string {
    return o.key == 'fullscreen' && document.fullscreenElement ? 'Exit full screen' : o.label;
  }

  byKey = (i:number, o:PowerOption) => o.key;
}
