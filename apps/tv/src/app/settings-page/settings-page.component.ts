import { AfterViewInit, Component, OnDestroy, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import type { SettingValues } from '@playpex/protocol/settings';
import { FocusEngine } from '../movement/movement';
import { NavigationService } from '../navigation.service';
import { useScreen } from '../nav/public-api';
import { RemotePlugins } from '../plugins/remote';
import { ProfilesService } from '../profiles.service';
import { SettingsService } from '../settings.service';
import { SubtitleProvider, SubtitlesService } from '../subtitles.service';
import { Dialogs, TabModel } from '../ui/public-api';
import { ServerService } from '../server.service';
import { SectionId } from '../catalog';
import { SectionRowsService } from '../sections.service';
import { SECTION_NAMES } from '../rows-editor/rows-editor.component';

type Group = 'display' | 'playback' | 'rows' | 'about';

// what opens Settings on a group (a row's menu: Edit rows… → Rows, on that section and row)
export interface SettingsTarget {
  group?:Group;
  section?:SectionId;
  row?:string | null;
}

const SUBTITLE_SIZES:{ key:SettingValues['subtitles.size'], label:string }[] = [
  { key: 'small', label: 'Small' }, { key: 'medium', label: 'Medium' }, { key: 'large', label: 'Large' }, { key: 'largest', label: 'Largest' },
];

// Settings (core.settings, docs/settings-plan.md §7), a section beside the
// menu on the rail layout: the groups on the left (moving onto one shows it),
// its settings on the right. Display (size, screen edges) and the volume /
// subtitle size are this device's; the subtitle source and autoplay are the
// profile's. Plugins' options are set on the server's dashboard. Every change is saved
// at once (SettingsService; sliders once they stop).
// Back: settings → groups → the menu, then out (the section's back policy).
// The languages offered for tracks (ISO 639-1)
const LANGUAGES = [
  { key: 'en', label: 'English' }, { key: 'fr', label: 'French' }, { key: 'ar', label: 'Arabic' },
  { key: 'es', label: 'Spanish' }, { key: 'de', label: 'German' }, { key: 'it', label: 'Italian' },
  { key: 'pt', label: 'Portuguese' }, { key: 'ja', label: 'Japanese' },
];

const AUTOPLAY_KINDS = [
  { key: 'ask', label: 'Show the choices' },
  { key: 'server', label: 'Play from this server' },
  { key: 'stream', label: 'Play a stream' },
];

import { desktop } from '../desktop';
import { connection } from '../server-config';
@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss']
})
export class SettingsPageComponent implements AfterViewInit, OnDestroy {

  private screen = useScreen<Record<string, string>, SettingsTarget>();

  group:Group = 'display';
  groups:TabModel[] = [];
  profileName = '';
  edgesOpen = false;
  subtitleProviders:SubtitleProvider[] = [];
  readonly subtitleSizes = SUBTITLE_SIZES;
  // player.autoplayKind: the Play chooser, or the best way of one kind at once
  // "Play a stream" only once some plugin finds sources (GET /plugins capabilities.sources)
  autoplayKinds = AUTOPLAY_KINDS;
  // player.audioLanguage / player.subtitleLanguage: the tracks a video starts with
  // the Electron shell can inject the admin's input (remote/remote-control.service.ts); a browser can't
  readonly remoteCapable = !!desktop()?.remote;
  // About: this app's version (the Electron shell's; none in a browser)
  readonly version = connection?.version || '';
  readonly audioLanguages = [{ key: 'original', label: 'As released' }, ...LANGUAGES];
  readonly subtitleLanguages = [{ key: 'off', label: 'Off' }, ...LANGUAGES];
  readonly volumeText = (v:number) => v + ' %';
  readonly edgesText = (f:number) => f ? (Math.round(f * 1000) / 10) + ' %' : 'None';

  private subs:Subscription[] = [];
  private http = inject(HttpClient);
  private server = inject(ServerService);
  private dialogs = inject(Dialogs);
  youtubeCodeBusy = false;

  // Rows: which section's rows, and the row to start on
  rowsSection:SectionId = 'home';
  rowsFocus:string | null = null;
  readonly rowSections = (['home', 'movies', 'shows'] as SectionId[]).map(key => ({ key, label: SECTION_NAMES[key] }));

  get rowSectionName():string {
    return SECTION_NAMES[this.rowsSection];
  }

  /** YouTube's "Link with TV code" for this screen (GET /cast/youtube/code), in a dialog */
  showYouTubeCode() {
    if (this.youtubeCodeBusy) return;
    this.youtubeCodeBusy = true;
    this.http.get<{ code:string | null }>(`${this.server.api}/cast/youtube/code`, { params: this.server.deviceParams() }).subscribe({
      next: answer => {
        this.youtubeCodeBusy = false;
        let code = answer?.code ? answer.code.replace(/(\d{3})(?=\d)/g, '$1 ') : null;
        this.subs.push(this.dialogs.alert(code
          ? { title: code, subtitle: 'Link with TV code', text: 'In the YouTube app: Settings › Watch on TV › Enter TV code. The code changes every 5 minutes.' }
          : { title: 'Not in the YouTube app yet', text: 'The server’s admin turns it on in the dashboard: Settings › Casting › Show Playpex screens in the YouTube app’s Cast list.' }).subscribe());
      },
      error: () => {
        this.youtubeCodeBusy = false;
        this.subs.push(this.dialogs.alert({ title: 'No code', text: 'The server couldn’t get a code from YouTube. Try again in a moment.' }).subscribe());
      },
    });
  }

  constructor(
    private navigation:NavigationService,
    private engine:FocusEngine,
    public settings:SettingsService,
    profiles:ProfilesService,
    subtitles:SubtitlesService,
    plugins:RemotePlugins,
    sections:SectionRowsService,
  ) {
    this.subs.push(plugins.capabilities$.subscribe(c => this.autoplayKinds = c.sources
      ? AUTOPLAY_KINDS : AUTOPLAY_KINDS.filter(k => k.key != 'stream' || this.settings.value('player.autoplayKind') == 'stream')));
    let profile = profiles.current.value;
    this.profileName = profile?.name || 'this profile';
    this.groups = [
      { key: 'display', label: 'Display' },
      { key: 'playback', label: 'Playback' },
      // a server with layouts, a profile that isn't a kids one (their rows are the admin's)
      ...(sections.canEditRows() ? [{ key: 'rows', label: 'Rows' }] : []),
      { key: 'about', label: 'About' },
    ];
    // opened on a group (Edit rows… on a row's menu), also when the page is shown again
    this.subs.push(this.screen.entry$.subscribe(entry => {
      let target = entry?.payload as SettingsTarget | undefined;
      if (!target?.group || !this.groups.some(g => g.key == target.group)) return;
      this.group = target.group;
      if (target.section) this.rowsSection = target.section;
      this.rowsFocus = target.row || null;
    }));
    this.subs.push(subtitles.getProviders().subscribe({ next: list => this.subtitleProviders = list.filter(p => p.enabled), error: () => { } }));
  }

  // Sections `settingsRail` and `settings` are pxSections in the template
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: '@settingsRail' },
    });

    this.screen.onBack(() => {
      let active = document.activeElement as HTMLElement | null;
      if (active?.classList.contains('menuItem')) return false;
      // through the engine: the focus event also fires in a window without OS
      // focus (a size being previewed goes back to the stored one)
      let target = active?.closest('.settingsMain')
        ? document.querySelector('.settingsRail .px-tab.active')
        : document.querySelector('.menuItem.active');
      if (target) this.engine.focus(target as HTMLElement, 'restore');
      return true;
    });
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  get subtitleProvider():string | null {
    return this.settings.value('subtitles.provider');
  }

  keepEdges(fraction:number) {
    this.settings.set('display.safeArea', fraction);
    this.closeEdges();
  }

  closeEdges() {
    this.edgesOpen = false;
    setTimeout(() => {
      let button = document.querySelector('.settingsMain [data-px-key="edges"]') as HTMLElement;
      if (button) this.engine.focus(button, 'restore');
    }, 0);
  }
}
