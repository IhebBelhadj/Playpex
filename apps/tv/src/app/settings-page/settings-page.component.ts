import { AfterViewInit, Component, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import type { SettingValues } from '@playpex/protocol/settings';
import { FocusEngine } from '../movement/movement';
import { NavigationService } from '../navigation.service';
import { useScreen } from '../nav/public-api';
import { ProfilesService } from '../profiles.service';
import { SettingsService } from '../settings.service';
import { SubtitleProvider, SubtitlesService } from '../subtitles.service';
import { TabModel } from '../ui/public-api';

type Group = 'display' | 'playback';

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
@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss']
})
export class SettingsPageComponent implements AfterViewInit, OnDestroy {

  private screen = useScreen();

  group:Group = 'display';
  groups:TabModel[] = [];
  profileName = '';
  edgesOpen = false;
  subtitleProviders:SubtitleProvider[] = [];
  readonly subtitleSizes = SUBTITLE_SIZES;
  readonly volumeText = (v:number) => v + ' %';
  readonly edgesText = (f:number) => f ? (Math.round(f * 1000) / 10) + ' %' : 'None';

  private subs:Subscription[] = [];

  constructor(
    private navigation:NavigationService,
    private engine:FocusEngine,
    public settings:SettingsService,
    profiles:ProfilesService,
    subtitles:SubtitlesService,
  ) {
    let profile = profiles.current.value;
    this.profileName = profile?.name || 'this profile';
    this.groups = [
      { key: 'display', label: 'Display' },
      { key: 'playback', label: 'Playback' },
    ];
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
