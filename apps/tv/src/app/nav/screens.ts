import { AdultBrowseComponent } from '../adult-browse/adult-browse.component';
import { AdultTitleComponent } from '../adult-title/adult-title.component';
import { AdultService } from '../adult.service';
import { ConnectPageComponent } from '../connect-page/connect-page.component';
import { DisplaySetupComponent } from '../display-setup/display-setup.component';
import { EpisodePageComponent } from '../episode-page/episode-page.component';
import { MovieOptionsComponent } from '../movie-options/movie-options.component';
import { MoviesPageComponent } from '../movies-page/movies-page.component';
import { MoviesSliderComponent } from '../movies-slider/movies-slider.component';
import { PlayerPageComponent } from '../player-page/player-page.component';
import { PowerPageComponent } from '../power-page/power-page.component';
import { ProfileEditorComponent } from '../profile-editor/profile-editor.component';
import { ProfilePickerComponent } from '../profile-picker/profile-picker.component';
import { ReleasesPageComponent } from '../releases-page/releases-page.component';
import { SearchPageComponent } from '../search-page/search-page.component';
import { SettingsPageComponent } from '../settings-page/settings-page.component';
import { ShowOptionsComponent } from '../show-options/show-options.component';
import { WatchlistPageComponent } from '../watchlist-page/watchlist-page.component';
import { LibraryPageComponent } from '../library-page/library-page.component';
import { LibraryFolderComponent } from '../library-folder/library-folder.component';
import { YoutubeComponent } from '../youtube/youtube.component';
import { environment } from '../../environments/environment';
import { GalleryComponent } from '../ui/public-api';
import { defineScreen } from './screen-registry';

// Every core screen (docs/navigation-system-plan.md §7), declared the way a
// plugin declares its own. The router's table is generated from these
// (app-routing.module.ts); code opens them by id: navigator.open({ screen:
// 'core.movie', params: { id }, payload: movie }).

const MOVIES_FRAME = { path: 'movies', component: MoviesPageComponent, data: { media: 'movie' } };
const SHOWS_FRAME = { path: 'shows', component: MoviesPageComponent, data: { media: 'tv' } };
const FULL_SCREEN = { menu: 'hidden' as const };
const ADULT = { accent: 'adult' as const };

// ── roots ────────────────────────────────────────────────────────────────────

// How big the UI is on this screen: the first start on a device
// (DisplayGuard), before the server and the profiles; Settings changes it later
defineScreen({
  id: 'core.display',
  path: 'display',
  component: DisplaySetupComponent,
  kind: 'root',
  chrome: { ...FULL_SCREEN, backButton: false },
});

// Which server: shown when there is none (ServerGuard), and from the menu.
// Payload: { reason, code } when the server refused this device
defineScreen({
  id: 'core.connect',
  path: 'connect',
  component: ConnectPageComponent,
  kind: 'root',
  requires: ['display'],
  chrome: { ...FULL_SCREEN, backButton: false },
});

// "Who's watching?": the start page; everything else needs a profile, so
// `display` and `server` here cover the app
defineScreen({
  id: 'core.profiles',
  path: 'profiles',
  component: ProfilePickerComponent,
  kind: 'root',
  requires: ['display', 'server'],
  chrome: { ...FULL_SCREEN, backButton: false },
});

defineScreen({
  id: 'core.profiles.new',
  path: 'profiles/new',
  component: ProfileEditorComponent,
  kind: 'detail',
  requires: ['server'],
  chrome: { ...FULL_SCREEN, backButton: false },
  back: { open: { screen: 'core.profiles' } },
});

defineScreen({
  id: 'core.profiles.edit',
  path: 'profiles/:id/edit',
  component: ProfileEditorComponent,
  kind: 'detail',
  requires: ['server'],
  chrome: { ...FULL_SCREEN, backButton: false },
  back: { open: { screen: 'core.profiles' } },
});

// ── sections (menu order) and their titles ───────────────────────────────────

defineScreen({
  id: 'core.search',
  path: 'search',
  component: SearchPageComponent,
  kind: 'section',
  requires: ['profile'],
  // no menu on the page: the Back button is the mouse's way out
  chrome: { ...FULL_SCREEN, backButton: true },
  // opened over the page it's chosen from: Back returns there
  menu: { label: 'Search', icon: 'search', order: 10, push: true },
});

// The home page and slider serve both sections; the frame's `media` picks
// the catalog (MoviesService.catalogs)
defineScreen({
  id: 'core.movies',
  path: 'movies/list',
  component: MoviesSliderComponent,
  frame: MOVIES_FRAME,
  data: { media: 'movie' },
  kind: 'section',
  requires: ['profile'],
  menu: { label: 'Movies', icon: 'film', order: 20 },
});

// Params { id } (TMDB id); payload: the TMDB movie (fetched when missing)
defineScreen({
  id: 'core.movie',
  path: 'movies/movie/:id',
  component: MovieOptionsComponent,
  frame: MOVIES_FRAME,
  kind: 'detail',
  requires: ['profile'],
});

defineScreen({
  id: 'core.shows',
  path: 'shows/list',
  component: MoviesSliderComponent,
  frame: SHOWS_FRAME,
  data: { media: 'tv' },
  kind: 'section',
  requires: ['profile'],
  menu: { label: 'Tv shows', icon: 'tv', order: 30 },
});

// Params { id } (TMDB TV id); state: the season last shown
defineScreen({
  id: 'core.show',
  path: 'shows/show/:id',
  component: ShowOptionsComponent,
  frame: SHOWS_FRAME,
  kind: 'detail',
  requires: ['profile'],
});

// Params { id, season, episode }; another episode of the season replaces it
defineScreen({
  id: 'core.episode',
  path: 'shows/show/:id/season/:season/episode/:episode',
  component: EpisodePageComponent,
  frame: SHOWS_FRAME,
  kind: 'detail',
  reuse: true,
  requires: ['profile'],
});

// What is on the Playpex server (its media library): movies, shows, recently
// added, folders of other videos
defineScreen({
  id: 'core.library',
  path: 'library',
  component: LibraryPageComponent,
  kind: 'section',
  requires: ['profile'],
  menu: { label: 'Library', icon: 'library', order: 35 },
});

// Params { id } (a library folder); payload: { name }; the level shown is the entry's state
defineScreen({
  id: 'core.library.folder',
  path: 'library/folder/:id',
  component: LibraryFolderComponent,
  kind: 'detail',
  requires: ['profile'],
});

defineScreen({
  id: 'core.watchlist',
  path: 'watchlist',
  component: WatchlistPageComponent,
  kind: 'section',
  requires: ['profile'],
  menu: { label: 'Watch list', icon: 'list', order: 40 },
});

// 18+: not for kids profiles. Two layouts of one section, the profile's
// preference opens one (the menu entry resolves it)
defineScreen({
  id: 'core.adult.browse',
  path: 'adult/browse',
  component: AdultBrowseComponent,
  kind: 'section',
  requires: ['adult'],
  chrome: ADULT,
  menu: {
    label: '18+',
    icon: 'adult',
    order: 50,
    visible: ({ profile }) => !!profile && !profile.isKid,
    resolve: injector => ({ screen: injector.get(AdultService).layoutScreen() }),
  },
});

defineScreen({
  id: 'core.adult.releases',
  path: 'adult/releases',
  component: ReleasesPageComponent,
  data: { kind: 'adult' },
  kind: 'section',
  section: 'core.adult.browse',
  requires: ['adult'],
  chrome: ADULT,
});

// Params { provider, id }; payload: the title (renders before the details arrive)
defineScreen({
  id: 'core.adult.title',
  path: 'adult/title/:provider/:id',
  component: AdultTitleComponent,
  kind: 'detail',
  requires: ['adult'],
  chrome: ADULT,
});

// Settings: this device's (size, screen edges, volume, subtitle size) and the
// profile's (subtitle source, autoplay, 18+), SettingsService
defineScreen({
  id: 'core.settings',
  path: 'settings',
  component: SettingsPageComponent,
  kind: 'section',
  requires: ['profile'],
  menu: { label: 'Settings', icon: 'settings', order: 60 },
});

// "Find releases" of a movie / show; payload: the ReleasesOrigin
defineScreen({
  id: 'core.releases.movies',
  path: 'releases/movies',
  component: ReleasesPageComponent,
  data: { kind: 'movie' },
  kind: 'detail',
  requires: ['profile'],
  chrome: { backButton: false },
});

defineScreen({
  id: 'core.releases.shows',
  path: 'releases/shows',
  component: ReleasesPageComponent,
  data: { kind: 'tv' },
  kind: 'detail',
  requires: ['profile'],
  chrome: { backButton: false },
});

// ── full screen ──────────────────────────────────────────────────────────────

// Params { session } (one per playback: the next episode replaces the entry
// with a new component); payload: the PlaybackRequest
defineScreen({
  id: 'core.player',
  path: 'player/:session',
  component: PlayerPageComponent,
  kind: 'fullscreen',
  requires: ['profile'],
  chrome: FULL_SCREEN,
});

// Params { id } (YouTube video id)
defineScreen({
  id: 'core.trailer',
  path: 'ytplayer/:id',
  component: YoutubeComponent,
  kind: 'fullscreen',
  requires: ['profile'],
  chrome: FULL_SCREEN,
});

// Quit / Sleep / Shutdown / Restart: the last step back out of a section
defineScreen({
  id: 'core.power',
  path: 'power',
  component: PowerPageComponent,
  kind: 'system',
  chrome: FULL_SCREEN,
});

// ── development ──────────────────────────────────────────────────────────────

// Every token and primitive of the UI system (docs/ui-system-plan.md §5.7); not
// in the menu, opened with window.playpexDev.open({ screen: 'core.dev.gallery' })
if (!environment.production) {
  defineScreen({
    id: 'core.dev.gallery',
    path: 'dev/gallery',
    component: GalleryComponent,
    kind: 'fullscreen',
    chrome: FULL_SCREEN,
  });
}
