import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { AdultGuard, ProfileGuard } from './profile.guard';
import { ServerGuard } from './server.guard';
import { SCREENS } from './nav/screen-registry';
import './nav/screens';

// The routes are generated from the screens (src/app/nav/screens.ts): frames
// become parent routes, `requires` become guards. Nothing navigates with the
// router directly: the Navigator does (src/app/nav).
const routes = SCREENS.buildRoutes(
  { server: ServerGuard, profile: ProfileGuard, adult: AdultGuard },
  [{ path: '', redirectTo: '/profiles', pathMatch: 'full' }],
);

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
