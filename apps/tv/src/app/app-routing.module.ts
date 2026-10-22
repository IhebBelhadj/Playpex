import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { AdultGuard, ProfileGuard } from './profile.guard';
import { DisplayGuard } from './display.guard';
import { ServerGuard } from './server.guard';
import { SCREENS } from './nav/screen-registry';
import './nav/screens';
// the example plugin's screens (development builds; docs/tv-plugins.md)
import './plugins-dev/hello/hello-plugin';

// The routes are generated from the screens (src/app/nav/screens.ts): frames
// become parent routes, `requires` become guards. Nothing navigates with the
// router directly: the Navigator does (src/app/nav).
const routes = SCREENS.buildRoutes(
  { display: DisplayGuard, server: ServerGuard, profile: ProfileGuard, adult: AdultGuard },
  [{ path: '', redirectTo: '/profiles', pathMatch: 'full' }],
);

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
