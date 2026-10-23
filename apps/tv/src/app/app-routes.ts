import { Routes } from '@angular/router';
import { AdultGuard, ProfileGuard } from './profile.guard';
import { DisplayGuard } from './display.guard';
import { ServerGuard } from './server.guard';
import { SCREENS } from './nav/screen-registry';
import './nav/screens';

// The router's table, generated from the screens (src/app/nav/screens.ts):
// frames become parent routes, `requires` become guards. Built again when the
// server's plugins define or drop screens (plugins/remote.ts → resetConfig).
// Nothing navigates with the router directly: the Navigator does (src/app/nav).
export function appRoutes():Routes {
  return SCREENS.buildRoutes(
    { display: DisplayGuard, server: ServerGuard, profile: ProfileGuard, adult: AdultGuard },
    [{ path: '', redirectTo: '/profiles', pathMatch: 'full' }],
  );
}
