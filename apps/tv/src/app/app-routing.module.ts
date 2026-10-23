import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { appRoutes } from './app-routes';

// The routes are the screens' (app-routes.ts); plugins' screens are added
// at run time (plugins/remote.ts)
@NgModule({
  imports: [RouterModule.forRoot(appRoutes())],
  exports: [RouterModule]
})
export class AppRoutingModule { }
