import { Component } from '@angular/core';
import { FocusEngine } from '../movement/movement';
import { Navigator, useScreen } from '../nav/public-api';
import { SettingsService } from '../settings.service';
import { SplashService } from '../splash.service';
import { display, saveSafeArea } from '../ui/public-api';

// First start on this device (core.display, DisplayGuard): how big the UI is
// on this screen, before "Who's watching?". Moving over a size shows it on the
// whole screen; Enter keeps it and goes on. Then the screen edges are offered
// (decision K, docs/ui-system-plan.md §13.1): "It fits" goes on, "Adjust"
// opens the calibration. Settings changes both later.
@Component({
  selector: 'app-display-setup',
  templateUrl: './display-setup.component.html',
  styleUrls: ['./display-setup.component.scss']
})
export class DisplaySetupComponent {

  // poster-sized samples, to judge the size by
  samples = [0, 1, 2, 3, 4];

  step:'size' | 'edges' = 'size';
  adjusting = false;
  safeArea = display.safeArea;

  private screen = useScreen();

  constructor(private navigator:Navigator, private splash:SplashService, private engine:FocusEngine,
    private settings:SettingsService) {
    // nothing to go back to: the power menu stays reachable (the root's back policy);
    // on the edges step, Back is the size again
    this.screen.onBack(() => {
      if (!this.splash.cleared) return true;
      if (this.step == 'edges') {
        this.step = 'size';
        return true;
      }
      return false;
    });
  }

  sizeChosen() {
    this.step = 'edges';
    this.focusSoon('[data-px-key="fits"]');
  }

  // kept on this device until a server has it (SettingsService adopts it)
  edgesChosen(fraction:number) {
    this.adjusting = false;
    this.safeArea = fraction;
    saveSafeArea(fraction);
    this.settings.set('display.safeArea', fraction);
    this.done();
  }

  private focusSoon(selector:string) {
    setTimeout(() => {
      let el = document.querySelector('.displayPage ' + selector) as HTMLElement;
      if (el) this.engine.focus(el, 'restore');
    }, 0);
  }

  done() {
    // the profiles' guard sends a device without a server to /connect
    this.navigator.reset({ screen: 'core.profiles' });
  }
}
