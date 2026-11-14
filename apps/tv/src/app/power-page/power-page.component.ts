import { PowerService } from './../power.service';
import { Component, AfterViewInit } from '@angular/core';
import { Profile, ProfilesService } from '../profiles.service';

interface PowerOption {
  key:'quit' | 'sleep' | 'restart' | 'shutdown';
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

  readonly options = OPTIONS;
  readonly profile:Profile | null;
  readonly avatarUrl:string;

  constructor(private power:PowerService, profiles:ProfilesService) {
    this.profile = profiles.current.value;
    this.avatarUrl = ProfilesService.avatarUrl(this.profile?.avatar ?? null);
  }

  ngAfterViewInit(): void {
    let first = document.querySelector('.powerPage [data-px-key]') as HTMLElement;
    document.querySelectorAll('.menuItem').forEach(item => item.classList.remove('focused'));
    first?.focus({ preventScroll: true });
    first?.classList.add('focused');
  }

  send(instruction:PowerOption['key']) {
    this.power.sendPowerInstruction(instruction).subscribe();
  }

  byKey = (i:number, o:PowerOption) => o.key;
}
