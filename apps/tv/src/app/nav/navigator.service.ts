import { Inject, Injectable, Injector, NgZone } from '@angular/core';
import {
  ActivatedRoute, GuardsCheckEnd, NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router,
} from '@angular/router';
import { BehaviorSubject, distinctUntilChanged, filter, map, Observable, Subject, take } from 'rxjs';
import * as spatialNavigation from '../../plugins/spacialNavigation.js';
import { FocusEngine } from '../movement/focus-engine.service';
import { PositionStore } from '../movement/position-store.service';
import { Entry, FocusSnapshot, Intent, LeaveContext, LeaveReason, NavEvent, ScreenDef } from './screen';
import { FRAME_KEY, SCREEN_KEY, SCREEN_REGISTRY, ScreenRegistry } from './screen-registry';
import { ScreenRef, ScreenRefKind } from './screen-ref';

const ENTRY_STATE = 'pxEntry';      // navigation state: which entry a navigation renders
const MAX_DEPTH = 50;               // entries; past it the oldest above the root is dropped
const LEAVE_TIMEOUT = 2000;         // ms a beforeLeave may take
const RESTORE_DELAY = 80;           // ms a screen shown again has to focus something itself

export const POWER_SCREEN = 'core.power';

interface Plan {
  stack:Entry[];
  entry:Entry;
}

// Owns the history (docs/navigation-system-plan.md §5.2): a stack of entries,
// one per visit of a screen. Every navigation goes through it; it drives the
// router with `replaceUrl` (the router only renders, the browser history never
// grows) and commits the new stack once the router has rendered it.
//
// Navigations it didn't start (a guard redirecting, code still calling the
// router) are adopted: resolved back to a screen and committed as a reset
// (roots, sections), a replace (`replaceUrl`, a redirect of ours) or a push.
@Injectable({
  providedIn: 'root'
})
export class Navigator {

  readonly stack$ = new BehaviorSubject<readonly Entry[]>([]);
  readonly events$ = new Subject<NavEvent>();

  // the entry being rendered (from the guards passing to NavigationEnd):
  // what a component constructed meanwhile attaches to
  activating:Entry | null = null;
  // a navigation of ours is running (input waits)
  busy = false;

  private entries:Entry[] = [];
  private nextId = 1;
  private queue:Promise<unknown> = Promise.resolve();
  private pending:Plan & { cancelled:boolean } | null = null;
  private routing:{ ours:boolean, plan:Plan | null, trigger:string, replaceUrl:boolean, redirect:Plan | null } | null = null;
  private refs:ScreenRef[] = [];
  // the stack before a reload (session-restore.ts), taken by the first
  // navigation when it lands on its top's URL
  private primed:Entry[] | null = null;

  constructor(
    private router:Router,
    private zone:NgZone,
    private positions:PositionStore,
    private engine:FocusEngine,
    readonly injector:Injector,
    @Inject(SCREEN_REGISTRY) readonly registry:ScreenRegistry,
  ) {
    this.router.events.subscribe(e => {
      if (e instanceof NavigationStart) this.onStart(e);
      else if (e instanceof GuardsCheckEnd) this.onGuardsPassed(e);
      else if (e instanceof NavigationEnd) this.onEnd();
      else if (e instanceof NavigationCancel || e instanceof NavigationError) this.onCancel();
    });
  }

  // ── state ─────────────────────────────────────────────────────────────────

  get stack():readonly Entry[] {
    return this.entries;
  }

  get current():Entry | null {
    return this.entries[this.entries.length - 1] || null;
  }

  get current$():Observable<Entry | null> {
    return this.stack$.pipe(map(stack => stack[stack.length - 1] || null), distinctUntilChanged());
  }

  // Emits once `entry` (the one shown now) no longer is: what a screen started
  // (a lookup before Play, a plugin's answer) ends there and never opens
  // something over the screen the user went to (takeUntil(navigator.left()))
  left(entry:Entry | null = this.current):Observable<unknown> {
    return this.current$.pipe(filter(e => e !== entry), take(1));
  }

  // Still showing `entry` (no screen opened, popped or replaced since)
  showing(entry:Entry | null):boolean {
    return !!entry && this.current === entry;
  }

  // the root of the stack: a section, the picker, /connect
  get root():Entry | null {
    return this.entries[0] || null;
  }

  canGoBack():boolean {
    return this.entries.length > 1;
  }

  urlFor(intent:Intent):string {
    return this.registry.urlFor(intent);
  }

  // ── operations (queued: one navigation at a time) ─────────────────────────

  // Push: the usual way forward
  open(intent:Intent):Promise<boolean> {
    return this.run('open', () => {
      let entry = this.entry(intent);
      return { stack: [...this.entries, entry], entry };
    });
  }

  // Swap the top entry (another episode of the same season)
  replace(intent:Intent):Promise<boolean> {
    return this.run('replace', () => {
      let entry = this.entry(intent);
      return { stack: [...this.entries.slice(0, -1), entry], entry };
    });
  }

  // Swap an entry below the top for another without showing it (the player's
  // next episode: Back then lands on the episode playing, not the one the
  // player was opened from). Kept as covered (Back is a return) with its
  // focus; `state` seeds the new entry's. Null when `entry` isn't below the top
  swapBelow(entry:Entry, intent:Intent, state:Record<string, any> = {}):Entry | null {
    let i = this.entries.indexOf(entry);
    if (i < 0 || i == this.entries.length - 1) return null;
    let next:Entry = { ...this.entry(intent), left: true, focus: entry.focus };
    Object.assign(next.state, state);
    let stack = [...this.entries];
    stack[i] = next;
    this.commit(stack);
    return next;
  }

  // Pop n entries; at the root, the root screen's back policy
  back(n = 1):Promise<boolean> {
    return this.enqueue(async () => {
      if (this.entries.length > n) {
        let stack = this.entries.slice(0, -n);
        return this.go({ stack, entry: stack[stack.length - 1] }, 'back');
      }
      let policy = this.current?.screen.back || this.defaultPolicy(this.current?.screen);
      if (policy == 'power') return this.go(this.push({ screen: POWER_SCREEN }), 'open');
      if (typeof policy == 'object') return this.go(this.push(policy.open), 'open');
      return false;
    });
  }

  // Pop until an entry of `screen` (or matching `match`) is on top
  backTo(match:string | ((e:Entry) => boolean)):Promise<boolean> {
    let test = typeof match == 'string' ? (e:Entry) => e.screen.id == match : match;
    return this.run('back', () => {
      for (let i = this.entries.length - 2; i >= 0; i--) {
        if (test(this.entries[i])) return { stack: this.entries.slice(0, i + 1), entry: this.entries[i] };
      }
      return null;
    });
  }

  // stack = [intent] (a profile chosen, /connect)
  reset(intent:Intent):Promise<boolean> {
    return this.run('reset', () => {
      let entry = this.entry(intent);
      return { stack: [entry], entry };
    });
  }

  // The menu: stack = [section] (the same section's root entry is kept)
  switchSection(sectionId:string):Promise<boolean> {
    let def = this.registry.get(sectionId);
    let intent = def.menu?.resolve ? def.menu.resolve(this.injector) : { screen: def.id };
    if (def.menu?.push) {
      // already shown: stay
      if (this.current?.screen.id == intent.screen) return Promise.resolve(true);
      return this.open(intent);
    }
    return this.run('reset', () => {
      let root = this.root;
      if (root && root.screen.id == intent.screen && sameParams(root.params, intent.params)) {
        return { stack: [root], entry: root };
      }
      let entry = this.entry(intent);
      return { stack: [entry], entry };
    });
  }

  // ── what the rest of the nav system uses ──────────────────────────────────

  // The screen refs handling input for the shown entry: its screen, then its frame
  owners():ScreenRef[] {
    let top = this.current;
    if (!top) return [];
    return this.refs
      .filter(ref => ref.entry === top)
      .sort((a, b) => (a.kind == 'screen' ? 0 : 1) - (b.kind == 'screen' ? 0 : 1));
  }

  // useScreen() / useFrame()
  attach(route:ActivatedRoute, host:HTMLElement, kind:ScreenRefKind):ScreenRef {
    let ref = new ScreenRef(this, route, host, kind);
    let entry = this.activating || this.current;
    if (entry && this.belongs(ref, entry)) ref.bind(entry);
    this.refs.push(ref);
    return ref;
  }

  restoreFocus(entry:Entry):boolean {
    let snapshot = entry.focus;
    if (!snapshot) return false;
    let items = (spatialNavigation.navigableElements(snapshot.section) || []) as HTMLElement[];
    // by key when it had one (its row may not be there yet: nothing), else by index
    let el = snapshot.key !== undefined
      ? items.find(item => item.getAttribute('data-px-key') === snapshot.key)
      : items[Math.min(snapshot.index, items.length - 1)];
    return !!el && this.engine.focus(el, 'restore');
  }

  // ── reloads (session-restore.ts) ──────────────────────────────────────────

  // Entries built from a saved stack; ids are kept (positions are scoped by them)
  restoredEntry(saved:{ id:number, screen:string, params?:Record<string, any>, payload?:unknown,
    state?:Record<string, any>, focus?:FocusSnapshot }):Entry | null {
    if (!this.registry.has(saved.screen)) return null;
    let screen = this.registry.get(saved.screen);
    return {
      id: saved.id, screen, params: saved.params || {}, payload: saved.payload, state: saved.state || {},
      // with a focus to come back to: shown again, not opened (ScreenRef.ready())
      left: !!saved.focus, focus: saved.focus,
    };
  }

  // The stack the boot's navigation adopts (it renders the top's URL)
  prime(stack:Entry[]) {
    this.primed = stack.length ? stack : null;
    // the ones below the top were covered: Back to them is a return
    stack.slice(0, -1).forEach(e => e.left = true);
    stack.forEach(e => this.nextId = Math.max(this.nextId, e.id + 1));
  }

  // What the top entry has focused now (before the page goes away)
  saveFocus() {
    let top = this.current;
    if (top) top.focus = this.snapshotFocus() || top.focus;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private entry(intent:Intent):Entry {
    let screen = this.registry.get(intent.screen);
    let params:Record<string, string> = {};
    Object.keys(intent.params || {}).forEach(key => params[key] = String(intent.params[key]));
    return { id: this.nextId++, screen, params, payload: intent.payload, state: {}, left: false };
  }

  private entryUrl(entry:Entry):string {
    return this.urlFor({ screen: entry.screen.id, params: entry.params });
  }

  private push(intent:Intent):Plan {
    let entry = this.entry(intent);
    return { stack: [...this.entries, entry], entry };
  }

  private defaultPolicy(screen:ScreenDef | undefined) {
    return screen && (screen.kind == 'section' || screen.kind == 'root') ? 'power' : 'pop';
  }

  private run(reason:LeaveReason, plan:() => Plan | null):Promise<boolean> {
    return this.enqueue(() => {
      let next = plan();
      return next ? this.go(next, reason) : Promise.resolve(false);
    });
  }

  private enqueue(task:() => Promise<boolean>):Promise<boolean> {
    let result = this.queue.then(() => this.zone.run(task), () => this.zone.run(task));
    this.queue = result.catch(() => false);
    return result;
  }

  private async go(plan:Plan, reason:LeaveReason):Promise<boolean> {
    let from = this.current;
    if (from === plan.entry && plan.stack.length == this.entries.length) return true;

    this.busy = true;
    try {
      if (from) {
        let removed = !plan.stack.includes(from);
        from.focus = this.snapshotFocus() || from.focus;
        await this.beforeLeave({ reason, removed, entry: from });
        if (!removed) from.left = true;
      }

      let url = this.entryUrl(plan.entry);
      // same URL: nothing for the router to do (Angular ignores it)
      if (url == this.router.url && this.current) {
        this.commit(plan.stack);
        return true;
      }

      this.pending = { ...plan, cancelled: false };
      let ok = await this.router.navigateByUrl(url, { replaceUrl: true, state: { [ENTRY_STATE]: plan.entry.id } })
        .catch(() => false);
      if (!ok && !this.pending?.cancelled) this.events$.next({ type: 'blocked', intent: null });
      return !!ok;
    } finally {
      this.pending = null;
      this.busy = false;
    }
  }

  private beforeLeave(ctx:LeaveContext):Promise<unknown> {
    let hooks:Promise<unknown>[] = [];
    if (ctx.entry.screen.beforeLeave) hooks.push(Promise.resolve().then(() => ctx.entry.screen.beforeLeave(ctx)));
    this.refs.filter(ref => ref.entry === ctx.entry).forEach(ref => hooks.push(...ref.leaving(ctx)));
    if (!hooks.length) return Promise.resolve();
    let timeout = new Promise(resolve => setTimeout(resolve, LEAVE_TIMEOUT));
    return Promise.race([Promise.all(hooks.map(h => h.catch(() => undefined))), timeout]);
  }

  // What has the focus, to come back to it (ScreenRef.ready())
  private snapshotFocus():FocusSnapshot | undefined {
    let el = document.activeElement as HTMLElement;
    if (!el || el === document.body) return undefined;
    let section = spatialNavigation.sectionOf(el);
    if (!section) return undefined;
    let items = (spatialNavigation.navigableElements(section) || []) as HTMLElement[];
    let key = el.getAttribute('data-px-key');
    return { section, key: key === null ? undefined : key, index: Math.max(0, items.indexOf(el)) };
  }

  // ── router events ─────────────────────────────────────────────────────────

  private onStart(e:NavigationStart) {
    let state = this.router.getCurrentNavigation()?.extras?.state;
    let ours = !!this.pending && !this.pending.cancelled && state?.[ENTRY_STATE] === this.pending.entry.id;
    this.routing = {
      ours,
      plan: ours ? this.pending : null,
      trigger: e.navigationTrigger,
      replaceUrl: !!this.router.getCurrentNavigation()?.extras?.replaceUrl,
      // a guard redirected a navigation of ours: this one stands in for it
      redirect: !ours && this.pending?.cancelled ? this.pending : null,
    };
  }

  private onGuardsPassed(e:GuardsCheckEnd) {
    if (!e.shouldActivate || !this.routing) return;
    if (!this.routing.ours) this.routing.plan = this.adopt(e.urlAfterRedirects);
    this.activating = this.routing.plan?.entry || null;
    this.positions.setScope(scopeOf(this.activating));
  }

  private onEnd() {
    let plan = this.routing?.plan;
    this.routing = null;
    this.activating = null;
    if (plan) this.commit(plan.stack);
    else this.positions.setScope(scopeOf(this.current));
  }

  private onCancel() {
    if (this.routing?.ours && this.pending) this.pending.cancelled = true;
    this.routing = null;
    this.activating = null;
    this.positions.setScope(scopeOf(this.current));
  }

  // A navigation the navigator didn't start, as a stack
  private adopt(url:string):Plan | null {
    let match = this.registry.match(url);
    if (!match) return null;
    let routing = this.routing;

    // the first navigation after a reload: the stack it had
    let primed = this.primed;
    this.primed = null;
    if (primed && !this.entries.length && this.entryUrl(primed[primed.length - 1]) == url.split(/[?#]/)[0]) {
      return { stack: primed, entry: primed[primed.length - 1] };
    }

    // the browser went back (devtools, a mouse button Chromium handled): to
    // that entry if it's below
    if (routing.trigger == 'popstate') {
      for (let i = this.entries.length - 2; i >= 0; i--) {
        if (this.entryUrl(this.entries[i]) == url.split(/[?#]/)[0]) return { stack: this.entries.slice(0, i + 1), entry: this.entries[i] };
      }
    }

    let entry = this.entry({ screen: match.screen.id, params: match.params, payload: routing.redirect?.entry.payload });
    let base = routing.redirect ? routing.redirect.stack.slice(0, -1) : this.entries;
    if (match.screen.kind == 'root' || match.screen.kind == 'section') return { stack: [entry], entry };
    if (routing.replaceUrl && !routing.redirect) return { stack: [...base.slice(0, -1), entry], entry };
    return { stack: [...base, entry], entry };
  }

  private commit(stack:Entry[]) {
    while (stack.length > MAX_DEPTH) stack = [stack[0], ...stack.slice(2)];
    let dropped = this.entries.filter(e => !stack.includes(e));
    this.entries = stack;
    let top = this.current;
    dropped.forEach(entry => {
      this.positions.clearScope(scopeOf(entry));
      this.events$.next({ type: 'dropped', entry });
    });
    this.positions.setScope(scopeOf(top));
    this.bindRefs();
    this.stack$.next(stack);
    if (top) this.events$.next({ type: 'navigated', entry: top, stack });
    // shown again and the screen focused nothing itself: what it had
    if (top?.left) setTimeout(() => {
      if (this.current === top && !hasFocus()) this.restoreFocus(top);
    }, RESTORE_DELAY);
  }

  // Screen refs follow the rendered routes: dropped with their route, bound to
  // the top entry when they render its screen (or its frame)
  private bindRefs() {
    let live = new Set<ActivatedRoute>();
    let walk = (route:ActivatedRoute) => {
      live.add(route);
      route.children.forEach(walk);
    };
    walk(this.router.routerState.root);

    this.refs = this.refs.filter(ref => {
      if (live.has(ref.route)) return true;
      ref.detach();
      return false;
    });
    let top = this.current;
    this.refs.forEach(ref => ref.bind(top && this.belongs(ref, top) ? top : null));
  }

  private belongs(ref:ScreenRef, entry:Entry):boolean {
    let data = ref.route.snapshot?.data || {};
    if (ref.kind == 'screen') return data[SCREEN_KEY] == entry.screen.id;
    return !!entry.screen.frame && data[FRAME_KEY] == entry.screen.frame.path.replace(/^\/+|\/+$/g, '');
  }
}

// PositionStore keys of an entry: sections keep theirs across visits
// (unscoped), everything else per entry (docs/navigation-system-plan.md §5.9)
export function scopeOf(entry:Entry | null):string {
  return !entry || entry.screen.kind == 'section' ? '' : `e${entry.id}:`;
}

function hasFocus():boolean {
  let el = document.activeElement;
  return !!el && el !== document.body && el.isConnected && !!spatialNavigation.sectionOf(el);
}

function sameParams(a:Record<string, any> = {}, b:Record<string, any> = {}):boolean {
  let keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  return keys.every(key => String(a[key]) == String(b[key]));
}
