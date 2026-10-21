import { Type } from '@angular/core';
import type { Injector } from '@angular/core';

// The navigation system's vocabulary (docs/navigation-system-plan.md §3, §5).
// Plain types, no Angular services: the registry, the screens and a plugin's
// declarations only need these.

export type ScreenKind = 'section' | 'detail' | 'fullscreen' | 'system' | 'root';
export type Requirement = 'server' | 'profile' | 'adult';

// "Open screen X with params P and payload D", as data: what code hands to the
// Navigator, what a menu entry or a plugin's link holds
export interface Intent<P = any, D = any> {
  screen: string;
  params?: P;
  payload?: D;              // in-memory data for the opened screen (never in the URL)
}

// What Back does when the ladder reaches the navigator at the bottom of the
// stack (with entries below, Back always pops)
export type BackPolicy =
  | 'pop'                   // nothing below the root: stays
  | 'power'                 // the power menu (sections, the picker, /connect)
  | 'none'                  // the screen handles Back itself
  | { open: Intent };       // e.g. the profile editor → the picker

export interface Chrome {
  menu?: 'shown' | 'hidden';        // default shown
  backButton?: boolean;             // default: not on sections and roots
  // a theme of the UI system (src/styles/_tokens.scss, data-px-accent on the
  // shell): 'adult' = the 18+ wine instead of white for --px-color-accent
  accent?: 'adult';
}

export interface MenuEntry {
  label: string;
  icon: string;                     // assets/icons/<icon>.svg
  order: number;
  // shown to this profile (default: always)
  visible?: (ctx:{ profile:any | null }) => boolean;
  // the screen the entry opens, when not the section's own (18+: the profile's layout)
  resolve?: (injector:Injector) => Intent;
  // opened over the current screen instead of starting the history over:
  // Back returns to where it was opened from (search)
  push?: boolean;
}

// Why an entry is being left (beforeLeave hooks)
export type LeaveReason = 'open' | 'replace' | 'back' | 'reset';

export interface LeaveContext {
  reason: LeaveReason;
  removed: boolean;                 // out of the stack (false: covered by another screen)
  entry: Entry;
}

export interface ScreenDef<P = any, D = any> {
  id: string;                       // 'core.movie', 'plugin.<pluginId>.<name>'
  path: string;                     // full path, params by name: 'movies/movie/:id'
  component: Type<unknown>;
  // a routed component hosting several screens (path = the parent route's)
  frame?: { path: string; component: Type<unknown>; data?: Record<string, any> };
  data?: Record<string, any>;       // Angular route data (e.g. { media: 'movie' })
  kind: ScreenKind;
  // the menu section this screen belongs to (sections: their own id; the
  // two 18+ layouts share 'core.adult')
  section?: string;
  requires?: Requirement[];
  chrome?: Chrome;
  back?: BackPolicy;
  menu?: MenuEntry;
  // another visit with other params keeps the component (ScreenRef.entry$
  // emits) instead of re-creating it (nav/reuse-strategy.ts)
  reuse?: boolean;
  title?: (params:P, payload:D) => string;
  beforeLeave?: (ctx:LeaveContext) => void | Promise<void>;
}

// One visit of a screen in the history
export interface Entry {
  readonly id: number;
  readonly screen: ScreenDef;
  readonly params: Record<string, any>;
  readonly payload: unknown;
  // the screen's own state, kept while the entry is in the stack
  readonly state: Record<string, any>;
  // left once (covered by another screen): shown again = returning
  left: boolean;
  // what had the focus when it was covered (restored by ScreenRef.ready())
  focus?: FocusSnapshot;
}

export interface FocusSnapshot {
  section: string;                  // pxSection id
  key?: string;                     // pxItemKey of the item
  index: number;                    // among the section's items
}

export type NavEvent =
  | { type: 'navigated'; entry: Entry; stack: readonly Entry[] }
  | { type: 'blocked'; intent: Intent | null }
  | { type: 'dropped'; entry: Entry };
