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
import { ShowOptionsComponent } from './show-options/show-options.component';
import { EpisodePageComponent } from './episode-page/episode-page.component';
import { SeasonCurveComponent } from './season-curve/season-curve.component';
import { RouterModule } from "@angular/router";

import { TorrentPickerComponent } from './torrent-picker/torrent-picker.component';
import { ProfilePickerComponent } from './profile-picker/profile-picker.component';
import { ProfileEditorComponent } from './profile-editor/profile-editor.component';
import { PinPadComponent } from './pin-pad/pin-pad.component';
import { WatchlistPageComponent } from './watchlist-page/watchlist-page.component';
import { PlayChoiceComponent } from './play-choice/play-choice.component';
import { TextKeyboardComponent } from './text-keyboard/text-keyboard.component';
import { ReleasesPageComponent } from './releases-page/releases-page.component';
import { AdultBrowseComponent } from './adult-browse/adult-browse.component';
import { AdultTitleComponent } from './adult-title/adult-title.component';
import { BackButtonComponent } from './back-button/back-button.component';
import { MOVEMENT_DIRECTIVES } from './movement/movement';

@NgModule({
  declarations: [
    AppComponent,
    EpisodePageComponent,
    SeasonCurveComponent,
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
    ShowOptionsComponent,
    TorrentPickerComponent,
    ProfilePickerComponent,
    ProfileEditorComponent,
    PinPadComponent,
    WatchlistPageComponent,
    PlayChoiceComponent,
    TextKeyboardComponent,
    ReleasesPageComponent,
    AdultBrowseComponent,
    AdultTitleComponent,
    BackButtonComponent,
    ...MOVEMENT_DIRECTIVES,
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
