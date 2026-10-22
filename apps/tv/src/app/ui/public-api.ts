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
import { PxSliderComponent } from './controls/px-slider.component';
import { PxTabsComponent } from './controls/px-tabs.component';
import { PxActionComponent } from './atoms/px-action.component';
import { PxActionBarComponent } from './atoms/px-action-bar.component';
import { PxButtonComponent } from './atoms/px-button.component';
import { PxSearchFieldComponent } from './atoms/px-search-field.component';
import { PxSwitchComponent } from './atoms/px-switch.component';
import { PxScoreComponent } from './atoms/px-score.component';
import { PxMetaComponent } from './atoms/px-meta.component';
import { PxProgressComponent } from './atoms/px-progress.component';
import { PxSpinnerComponent } from './atoms/px-spinner.component';
import { PxEmptyComponent } from './atoms/px-empty.component';
import { PxSkeletonComponent } from './atoms/px-skeleton.component';
import { PxToastHostComponent } from './toast/px-toast-host.component';
import { PxRailLayoutComponent } from './layouts/px-rail-layout.component';
import { PxFullscreenLayoutComponent } from './layouts/px-fullscreen-layout.component';
import { PxSectionLayoutComponent } from './layouts/px-section-layout.component';
import { PxDetailLayoutComponent } from './layouts/px-detail-layout.component';
import { PxShellComponent } from './layouts/px-shell.component';
import { PxSlotComponent } from './slots/px-slot.component';
import { PxCardComponent } from './cards/px-card.component';
import { PxTitleInfoComponent } from './title/px-title-info.component';
import { PxCardRowComponent } from './cards/px-card-row.component';

// Bumped on any breaking change of what's exported here or of the stable
// tokens (`// stable` in src/styles/_tokens.scss); docs/tv-plugins.md
export const UI_API_VERSION = 1;

export { GalleryComponent };
export { dp, dur, DurationToken, DESIGN_PX_PER_REM } from './units';
export { tmdbImageBase, TmdbImageKind } from './images';
export { display, UI_SCALES, DEFAULT_UI_SCALE, UiScaleOption, previewUiScale, saveUiScale, applySafeArea, saveSafeArea } from './display';

// view models (§5.5)
export {
  ActionModel, Badge, CardModel, CardVariant, MetaItem, RowModel, RowPage, RowSource, ScoreSource, TitleInfoModel, iconUrl,
} from './models';

// overlays (step 2)
export { PxDialogComponent, PxOptionComponent, PxPanelComponent, PxChipComponent, PxDialogHostComponent };
export { OverlayLevel, LEVEL_PRIORITY, PxOverlay } from './overlay/px-overlay';
export { Dialogs, DialogChoice, DialogOptions, DialogRequest } from './overlay/dialogs.service';

// atoms and controls (step 3)
export {
  PxActionComponent, PxActionBarComponent, PxButtonComponent, PxSearchFieldComponent, PxSwitchComponent, PxScoreComponent,
  PxMetaComponent, PxProgressComponent, PxSpinnerComponent, PxEmptyComponent, PxSkeletonComponent, PxSliderComponent, PxTabsComponent,
};
export { ButtonVariant } from './atoms/px-button.component';
export { SkeletonVariant } from './atoms/px-skeleton.component';
export { TabModel } from './controls/px-tabs.component';

// cards and rows (step 4)
export { PxCardComponent, PxCardRowComponent };

// title info and layouts (step 5)
export { PxTitleInfoComponent, PxRailLayoutComponent, PxFullscreenLayoutComponent, PxSectionLayoutComponent, PxDetailLayoutComponent, PxShellComponent };

// models and slots (step 6)
export { PxSlotComponent };
export { CONTRIBUTION_REGISTRY } from './slots/px-slot.component';
export {
  ContributionDef, ContributionRegistry, CONTRIBUTIONS, defineContribution, MAX_PER_SLOT, pluginOf,
} from './slots/contribution-registry';
export {
  EpisodeContext, MovieContext, ProfileContext, SectionContext, ShowContext, SlotContexts, SlotDef, SlotKind, SlotName, SLOTS,
  TitleMetaContext, TitleRef, WatchlistContext,
} from './slots/slots';

// toasts (§13.3)
export { PxToastHostComponent };
export { Toasts, Toast, ToastHandle, ToastOptions, ToastTone } from './toast/toasts.service';

// Declared in AppModule
export const UI_COMPONENTS = [
  GalleryComponent,
  PxDialogComponent, PxOptionComponent, PxPanelComponent, PxChipComponent, PxDialogHostComponent,
  PxActionComponent, PxActionBarComponent, PxButtonComponent, PxSearchFieldComponent, PxSwitchComponent, PxScoreComponent,
  PxMetaComponent, PxProgressComponent, PxSpinnerComponent, PxEmptyComponent, PxSkeletonComponent, PxSliderComponent, PxTabsComponent,
  PxToastHostComponent,
  PxRailLayoutComponent,
  PxCardComponent, PxCardRowComponent,
  PxTitleInfoComponent, PxFullscreenLayoutComponent, PxSectionLayoutComponent, PxDetailLayoutComponent,
  PxShellComponent, PxSlotComponent,
];
