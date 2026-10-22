// The UI system's contract (docs/ui-system-plan.md §7): tokens, primitives,
// layouts, view models and slots, what core screens are built from and what a
// plugin will get. Import the UI system from here, never from its files (as
// nav/public-api.ts).
import { GalleryComponent } from './gallery/gallery.component';
import { PxChipComponent } from './overlay/px-chip.component';
import { PxDialogHostComponent } from './overlay/px-dialog-host.component';
import { PxDialogComponent } from './overlay/px-dialog.component';
import { PxOptionComponent } from './overlay/px-option.component';
import { PxPanelComponent } from './overlay/px-panel.component';

// Bumped on any breaking change of what's exported here (token names included).
// 0 until step 7 of the plan: nothing here is a promise yet
export const UI_API_VERSION = 0;

export { GalleryComponent };
export { dp, DESIGN_PX_PER_REM } from './units';
export { tmdbImageBase, TmdbImageKind } from './images';
export { display, UI_SCALES, DEFAULT_UI_SCALE, UiScaleOption, previewUiScale, saveUiScale } from './display';

// overlays (step 2)
export { PxDialogComponent, PxOptionComponent, PxPanelComponent, PxChipComponent, PxDialogHostComponent };
export { OverlayLevel, LEVEL_PRIORITY, PxOverlay } from './overlay/px-overlay';
export { Dialogs, DialogChoice, DialogOptions, DialogRequest } from './overlay/dialogs.service';

// Declared in AppModule
export const UI_COMPONENTS = [
  GalleryComponent,
  PxDialogComponent, PxOptionComponent, PxPanelComponent, PxChipComponent, PxDialogHostComponent,
];
