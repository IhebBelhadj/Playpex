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
  {
    path : 'movies' ,
    component : MoviesPageComponent,
    children : [
      {
        path : 'movie/:id',
        component : MovieOptionsComponent
      },
      {
        path : 'list',
        component : MoviesSliderComponent
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
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
