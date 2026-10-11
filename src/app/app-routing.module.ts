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

const routes: Routes = [
  {
    path:'',
    redirectTo : '/movies/list',
    pathMatch : 'full',
  },
  // The home page and slider serve both sections; `media` picks the catalog
  // (see MoviesService.catalogs)
  {
    path : 'movies' ,
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
    path : 'player',
    component : PlayerPageComponent
  },
  {
    path: 'search',
    component:SearchPageComponent
  },
  {
    path: 'ytplayer/:id',
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
