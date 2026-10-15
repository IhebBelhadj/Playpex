import { PowerPageComponent } from './power-page/power-page.component';
import { ShowOptionsComponent } from './show-options/show-options.component';
import { YoutubeComponent } from './youtube/youtube.component';
import { SearchPageComponent } from './search-page/search-page.component';
import { PlayerPageComponent } from './player-page/player-page.component';
import { MovieOptionsComponent } from './movie-options/movie-options.component';
import { MoviesSliderComponent } from './movies-slider/movies-slider.component';
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { MoviesPageComponent } from './movies-page/movies-page.component';
import { ProfilePickerComponent } from './profile-picker/profile-picker.component';
import { ProfileEditorComponent } from './profile-editor/profile-editor.component';
import { AdultGuard, AdultLayoutGuard, ProfileGuard } from './profile.guard';
import { AdultBrowseComponent } from './adult-browse/adult-browse.component';
import { AdultTitleComponent } from './adult-title/adult-title.component';
import { AdultPageComponent } from './adult-page/adult-page.component';
import { WatchlistPageComponent } from './watchlist-page/watchlist-page.component';

const routes: Routes = [
  {
    path:'',
    redirectTo : '/profiles',
    pathMatch : 'full',
  },
  // "Who's watching?" (start page) and the profile editor
  {
    path : 'profiles',
    component : ProfilePickerComponent
  },
  {
    path : 'profiles/new',
    component : ProfileEditorComponent
  },
  {
    path : 'profiles/:id/edit',
    component : ProfileEditorComponent
  },
  // The home page and slider serve both sections; `media` picks the catalog
  // (see MoviesService.catalogs)
  {
    path : 'movies' ,
    canActivate : [ProfileGuard],
    component : MoviesPageComponent,
    data : { media : 'movie' },
    children : [
      {
        path : 'movie/:id',
        component : MovieOptionsComponent
      },
      {
        path : 'list',
        component : MoviesSliderComponent,
        data : { media : 'movie' },
      },
    ]
  },
  {
    path : 'shows' ,
    canActivate : [ProfileGuard],
    component : MoviesPageComponent,
    data : { media : 'tv' },
    children : [
      {
        path : 'show/:id',
        component : ShowOptionsComponent
      },
      {
        path : 'list',
        component : MoviesSliderComponent,
        data : { media : 'tv' },
      },
    ]
  },
  {
    path : 'watchlist',
    canActivate : [ProfileGuard],
    component : WatchlistPageComponent
  },
  // 18+ section: not for kids profiles. /adult opens the profile's layout:
  // posters (metadata provider) or the compact list of releases
  {
    path : 'adult',
    pathMatch : 'full',
    canActivate : [AdultGuard, AdultLayoutGuard],
    children : [],
  },
  {
    path : 'adult/browse',
    canActivate : [AdultGuard],
    component : AdultBrowseComponent
  },
  {
    path : 'adult/title/:provider/:id',
    canActivate : [AdultGuard],
    component : AdultTitleComponent
  },
  {
    path : 'adult/releases',
    canActivate : [AdultGuard],
    component : AdultPageComponent
  },
  {
    path : 'player',
    canActivate : [ProfileGuard],
    component : PlayerPageComponent
  },
  {
    path: 'search',
    canActivate : [ProfileGuard],
    component:SearchPageComponent
  },
  {
    path: 'ytplayer/:id',
    canActivate : [ProfileGuard],
    component : YoutubeComponent
  },
  {
    path : 'power',
    component : PowerPageComponent
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
