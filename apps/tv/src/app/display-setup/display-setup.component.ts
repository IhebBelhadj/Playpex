import { Component } from '@angular/core';
import { Navigator, useScreen } from '../nav/public-api';
import { SplashService } from '../splash.service';

// First start on this device (core.display, DisplayGuard): how big the UI is
// on this screen, before "Who's watching?". Moving over a size shows it on the
// whole screen; Enter keeps it and goes on. Settings changes it later.
@Component({
  selector: 'app-display-setup',
  templateUrl: './display-setup.component.html',
  styleUrls: ['./display-setup.component.scss']
})
export class DisplaySetupComponent {

  // poster-sized samples, to judge the size by
  samples = [0, 1, 2, 3, 4];

  private screen = useScreen();

  constructor(private navigator:Navigator, private splash:SplashService) {
    // nothing to go back to: the power menu stays reachable (the root's back policy)
    this.screen.onBack(() => !this.splash.cleared);
  }

  done() {
    // the profiles' guard sends a device without a server to /connect
    this.navigator.reset({ screen: 'core.profiles' });
  }
}
