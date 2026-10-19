// The navigation system's contract (docs/navigation-system-plan.md §8): what
// core screens use, and what a plugin will get. Import the nav system from
// here, never from its files, so a breaking change shows up in the core first.
import { PxSelectDirective } from './px-select.directive';
import { NavDebugComponent } from './nav-debug.component';

// Bumped on any breaking change of what's exported here (core screen ids included)
export const NAV_API_VERSION = 1;

export {
  BackPolicy, Chrome, Entry, FocusSnapshot, Intent, LeaveContext, LeaveReason, MenuEntry, NavEvent, Requirement, ScreenDef, ScreenKind,
} from './screen';
export { defineScreen, SCREENS, SCREEN_REGISTRY, ScreenRegistry } from './screen-registry';
export { Navigator, POWER_SCREEN } from './navigator.service';
export { ScreenRef } from './screen-ref';
export { useScreen, useFrame } from './use-screen';
export { LayerDef, LayerRef, LayerStack, LAYER_PRIORITY } from './layer-stack.service';
export { InputDispatcher, InputSource, NavAction } from './input-dispatcher.service';
export { PxSelectDirective };

// Declared in AppModule
export const NAV_DIRECTIVES = [PxSelectDirective, NavDebugComponent];
