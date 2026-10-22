import { MoviesService } from './movies.service';
import { NgModule } from '@angular/core';
import { HttpClientModule ,HttpClientJsonpModule, HTTP_INTERCEPTORS } from '@angular/common/http';
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
import { DisplaySizeComponent } from './display-size/display-size.component';
import { DisplaySetupComponent } from './display-setup/display-setup.component';
import { SettingsPageComponent } from './settings-page/settings-page.component';
import { ShowOptionsComponent } from './show-options/show-options.component';
import { EpisodePageComponent } from './episode-page/episode-page.component';
import { SeasonCurveComponent } from './season-curve/season-curve.component';
import { RowArrowsComponent } from './row-arrows/row-arrows.component';
import { CatalogFilterPanelComponent } from './catalog-filter-panel/catalog-filter-panel.component';
import { RouteReuseStrategy, RouterModule } from "@angular/router";

import { TorrentPickerComponent } from './torrent-picker/torrent-picker.component';
import { ProfilePickerComponent } from './profile-picker/profile-picker.component';
import { ProfileEditorComponent } from './profile-editor/profile-editor.component';
import { PinPadComponent } from './pin-pad/pin-pad.component';
import { WatchlistPageComponent } from './watchlist-page/watchlist-page.component';
import { TextKeyboardComponent } from './text-keyboard/text-keyboard.component';
import { ReleasesPageComponent } from './releases-page/releases-page.component';
import { AdultBrowseComponent } from './adult-browse/adult-browse.component';
import { AdultTitleComponent } from './adult-title/adult-title.component';
import { BackButtonComponent } from './back-button/back-button.component';
import { MOVEMENT_DIRECTIVES } from './movement/movement';
import { NAV_DIRECTIVES } from './nav/public-api';
import { UI_COMPONENTS } from './ui/public-api';
import { NavReuseStrategy } from './nav/reuse-strategy';
import { ConnectPageComponent } from './connect-page/connect-page.component';
import { ConnectionLostComponent } from './connection-lost/connection-lost.component';
import { ServerErrorsInterceptor } from './server-errors.interceptor';

@NgModule({
  declarations: [
    AppComponent,
    EpisodePageComponent,
    SeasonCurveComponent,
    RowArrowsComponent,
    CatalogFilterPanelComponent,
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
    DisplaySizeComponent,
    DisplaySetupComponent,
    SettingsPageComponent,
    ShowOptionsComponent,
    TorrentPickerComponent,
    ProfilePickerComponent,
    ProfileEditorComponent,
    PinPadComponent,
    WatchlistPageComponent,
    TextKeyboardComponent,
    ReleasesPageComponent,
    AdultBrowseComponent,
    AdultTitleComponent,
    BackButtonComponent,
    ConnectPageComponent,
    ConnectionLostComponent,
    ...MOVEMENT_DIRECTIVES,
    ...NAV_DIRECTIVES,
    ...UI_COMPONENTS,
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
    { provide: HTTP_INTERCEPTORS, useClass: ServerErrorsInterceptor, multi: true },
    { provide: RouteReuseStrategy, useClass: NavReuseStrategy },
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
