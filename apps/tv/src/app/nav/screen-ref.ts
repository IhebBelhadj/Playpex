import { ActivatedRoute } from '@angular/router';
import { BehaviorSubject, filter, map, Observable } from 'rxjs';
import { Entry, LeaveContext } from './screen';
import type { Navigator } from './navigator.service';

// What a screen component gets from the navigator (docs/navigation-system-plan.md
// §5.3): its entry (params, payload, per-entry state) and the handlers the
// InputDispatcher calls while that entry is on top. Handlers belong to the
// component, the entry may change under it: a component Angular reuses for
// another visit of the same screen (similar movie → similar movie, Back to
// the previous one) is rebound and `entry$` emits.
//
//   private screen = useScreen<{ id:string }, Movie>();
//   constructor() { this.screen.onBack(() => this.closePanel()); }
export type ScreenRefKind = 'screen' | 'frame';

export class ScreenRef<P = Record<string, string>, D = any> {

  readonly entry$ = new BehaviorSubject<Entry | null>(null);
  // shown again after a screen above it was closed (restore, don't reset)
  returning = false;

  private selectHandlers:((el:HTMLElement) => boolean | void)[] = [];
  private backHandlers:(() => boolean)[] = [];
  private leaveHandlers:(() => boolean | void)[] = [];
  private leavingHandlers:((ctx:LeaveContext) => void | Promise<void>)[] = [];

  constructor(
    private navigator:Navigator,
    readonly route:ActivatedRoute,
    readonly host:HTMLElement,
    readonly kind:ScreenRefKind,
  ) { }

  get entry():Entry | null {
    return this.entry$.value;
  }

  get params():P {
    return (this.entry?.params || {}) as P;
  }

  get params$():Observable<P> {
    return this.entry$.pipe(filter(Boolean), map(entry => entry.params as P));
  }

  get payload():D | undefined {
    return this.entry?.payload as D | undefined;
  }

  // its entry is the one shown
  get active():boolean {
    return !!this.entry && this.navigator.current === this.entry;
  }

  // Per-entry state: kept while the entry is in the stack (Back to it finds it)
  state<T>(key:string, init:() => T):T {
    let state = this.entry?.state;
    if (!state) return init();
    if (!(key in state)) state[key] = init();
    return state[key];
  }

  setState(key:string, value:any) {
    if (this.entry) this.entry.state[key] = value;
  }

  // Select on something without a (pxSelect) of its own
  onSelect(fn:(el:HTMLElement) => boolean | void) {
    this.selectHandlers.push(fn);
  }

  // An in-page step back (results → search bar, poster → menu): true when it
  // consumed the back; else the navigator leaves the screen
  onBack(fn:() => boolean) {
    this.backHandlers.push(fn);
  }

  // The shell's Back button: out at once, close what must be closed first
  // (true = consumed, stay)
  onLeave(fn:() => boolean | void) {
    this.leaveHandlers.push(fn);
  }

  // Every way out of the entry (pop, reset, a screen opened over it, an
  // error path); `ctx.removed` = out of the stack for good. Awaited (2 s cap)
  beforeLeave(fn:(ctx:LeaveContext) => void | Promise<void>) {
    this.leavingHandlers.push(fn);
  }

  // The screen's data is on screen: back to what was focused when it was
  // covered (returning only). False when there was nothing to restore
  ready():boolean {
    if (!this.returning || !this.entry?.focus) return false;
    return this.navigator.restoreFocus(this.entry);
  }

  // ── navigator side ────────────────────────────────────────────────────────

  bind(entry:Entry | null) {
    if (entry === this.entry) return;
    this.returning = !!entry?.left;
    this.entry$.next(entry);
  }

  detach() {
    this.entry$.next(null);
    this.entry$.complete();
  }

  handleSelect(el:HTMLElement):boolean {
    return this.selectHandlers.some(fn => fn(el) !== false);
  }

  handleBack():boolean {
    for (let i = this.backHandlers.length - 1; i >= 0; i--) if (this.backHandlers[i]()) return true;
    return false;
  }

  handleLeave():boolean {
    return this.leaveHandlers.some(fn => fn() === true);
  }

  leaving(ctx:LeaveContext):Promise<unknown>[] {
    return this.leavingHandlers.map(fn => Promise.resolve().then(() => fn(ctx)));
  }
}
