import { MoviesService } from './movies.service';
import { NgModule } from '@angular/core';
import { HttpClientModule ,HttpClientJsonpModule} from '@angular/common/http';
import { BrowserModule } from '@angular/platform-browser';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { MenuComponent } from './menu/menu.component';
import { MovieDescriptionComponent } from './movie-description/movie-description.component';
import { MoviesSliderComponent } from './movies-slider/movies-slider.component';
import { MoviesPageComponent } from './movies-page/movies-page.component';
import { MovieOptionsComponent } from './movie-options/movie-options.component';
import { ClockComponent } from './clock/clock.component';
import { PlayerPageComponent } from './player-page/player-page.component';
import { SearchPageComponent } from './search-page/search-page.component';
import { YoutubeComponent } from './youtube/youtube.component';
import { NotificationHandlerComponent } from './notification-handler/notification-handler.component';
import { SplashComponent } from './splash/splash.component';
import { DescritionViewerComponent } from './descrition-viewer/descrition-viewer.component';
import { PowerPageComponent } from './power-page/power-page.component';
import { RouterModule } from "@angular/router";

@NgModule({
  declarations: [
    AppComponent,
    MenuComponent,
    MovieDescriptionComponent,
    MoviesSliderComponent,
    MoviesPageComponent,
    MovieOptionsComponent,
    ClockComponent,
    PlayerPageComponent,
    SearchPageComponent,
    YoutubeComponent,
    NotificationHandlerComponent,
    SplashComponent,
    DescritionViewerComponent,
    PowerPageComponent,
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    HttpClientModule,
    HttpClientJsonpModule,
    RouterModule,
  ],
  providers: [
    MoviesService,
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
