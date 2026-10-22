import { AfterViewInit, Component, OnDestroy } from '@angular/core';
import { FocusEngine } from '../movement/movement';
import { NavigationService } from '../navigation.service';
import { useScreen } from '../nav/public-api';

// Settings (core.settings), a section beside the menu. For now one group:
// Display › size (DisplaySizeComponent, stored on this device). Later on the
// rail layout with more groups (docs/ui-system-plan.md, core.settings).
// Back: the menu, then out (the section's back policy: the power menu).
@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss']
})
export class SettingsPageComponent implements AfterViewInit, OnDestroy {

  private screen = useScreen();

  constructor(private navigation:NavigationService, private engine:FocusEngine) { }

  // Section `settings` is a pxSection in the template
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      // onto the stored size (a grid entered for the first time takes its first item)
      leaveFor: { right: this.engine.target(['.settingsPage .px-chip.selected', '@settings']) },
    });

    this.screen.onBack(() => {
      if (document.activeElement?.classList.contains('menuItem')) return false;
      // through the engine: the focus event also fires in a window without OS
      // focus (a size being previewed goes back to the stored one)
      let item = document.querySelector('.menuItem.active') as HTMLElement;
      if (item) this.engine.focus(item, 'restore');
      return true;
    });
  }

  ngOnDestroy(): void {
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }
}
