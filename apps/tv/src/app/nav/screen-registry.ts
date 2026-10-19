import { InjectionToken, Type } from '@angular/core';
import { Route, Routes } from '@angular/router';
import { Intent, Requirement, ScreenDef } from './screen';

// Route data keys the navigator reads back from the activated routes
export const SCREEN_KEY = 'pxScreen';
export const FRAME_KEY = 'pxFrame';

export interface ScreenMatch {
  screen: ScreenDef;
  params: Record<string, string>;
}

// Every screen of the app, declared once (`defineScreen`). Generates the
// Angular routes (`buildRoutes`), resolves a URL back to its screen and
// builds a screen's URL from its params, so nothing else writes URLs.
export class ScreenRegistry {

  private screens = new Map<string, ScreenDef>();

  define<P, D>(def:ScreenDef<P, D>):ScreenDef<P, D> {
    if (this.screens.has(def.id)) throw new Error(`Screen ${def.id} is already defined`);
    let path = normalize(def.path);
    let clash = this.all().find(s => normalize(s.path) == path);
    if (clash) throw new Error(`Screens ${clash.id} and ${def.id} have the same path ${path}`);
    if (def.frame && !path.startsWith(normalize(def.frame.path) + '/')) {
      throw new Error(`Screen ${def.id}: path ${path} isn't under its frame ${def.frame.path}`);
    }
    if (def.id.startsWith('plugin.')) checkPlugin(def);
    this.screens.set(def.id, def as ScreenDef);
    return def;
  }

  get(id:string):ScreenDef {
    let def = this.screens.get(id);
    if (!def) throw new Error(`Unknown screen ${id}`);
    return def;
  }

  has(id:string):boolean {
    return this.screens.has(id);
  }

  all():ScreenDef[] {
    return Array.from(this.screens.values());
  }

  // Screens with a menu entry, in menu order
  sections():ScreenDef[] {
    return this.all().filter(s => s.menu).sort((a, b) => a.menu.order - b.menu.order);
  }

  // '/movies/movie/603?x=1' → core.movie, { id: '603' }
  match(url:string):ScreenMatch | null {
    let segments = splitPath(url);
    for (let screen of Array.from(this.screens.values())) {
      let pattern = splitPath(screen.path);
      if (pattern.length != segments.length) continue;
      let params:Record<string, string> = {};
      let ok = pattern.every((part, i) => {
        if (part.startsWith(':')) {
          params[part.slice(1)] = safeDecode(segments[i]);
          return true;
        }
        return part == segments[i];
      });
      if (ok) return { screen, params };
    }
    return null;
  }

  urlFor(intent:Intent):string {
    let params = intent.params || {};
    return '/' + splitPath(this.get(intent.screen).path).map(part => {
      if (!part.startsWith(':')) return part;
      let value = params[part.slice(1)];
      if (value === undefined || value === null) throw new Error(`${intent.screen}: missing param ${part.slice(1)}`);
      return encodeURIComponent(String(value));
    }).join('/');
  }

  // The Angular route table: screens under a frame become children of one
  // parent route per frame; `requires` become guards (`guards` maps them)
  buildRoutes(guards:Record<Requirement, Type<unknown>>, extra:Routes = []):Routes {
    let routes:Routes = [];
    let frames = new Map<string, Route>();
    let guardsFor = (def:ScreenDef) => def.requires?.length ? { canActivate: def.requires.map(r => guards[r]) } : {};

    this.all().forEach(def => {
      let data = { ...def.data, [SCREEN_KEY]: def.id };
      if (!def.frame) {
        routes.push({ path: normalize(def.path), component: def.component, data, ...guardsFor(def) });
        return;
      }
      let framePath = normalize(def.frame.path);
      let frame = frames.get(framePath);
      if (!frame) {
        frame = {
          path: framePath,
          component: def.frame.component,
          data: { ...def.frame.data, [FRAME_KEY]: framePath },
          children: [],
          ...guardsFor(def),
        };
        frames.set(framePath, frame);
        routes.push(frame);
      }
      frame.children.push({ path: normalize(def.path).slice(framePath.length + 1), component: def.component, data });
    });

    return [...extra, ...routes];
  }
}

// The app's registry: core screens (nav/screens.ts) and, later, plugins'
export const SCREENS = new ScreenRegistry();

// What the navigator and the reuse strategy read (tests provide their own)
export const SCREEN_REGISTRY = new InjectionToken<ScreenRegistry>('SCREEN_REGISTRY', {
  providedIn: 'root',
  factory: () => SCREENS,
});

export function defineScreen<P = any, D = any>(def:ScreenDef<P, D>):ScreenDef<P, D> {
  return SCREENS.define(def);
}

// Plugin rules (docs/navigation-system-plan.md §8, decision G)
function checkPlugin(def:ScreenDef) {
  let match = /^plugin\.([a-z0-9-]+)\.[a-z0-9.-]+$/.exec(def.id);
  if (!match) throw new Error(`Plugin screen ids are plugin.<pluginId>.<name>: ${def.id}`);
  if (!normalize(def.path).startsWith(`p/${match[1]}/`)) throw new Error(`Plugin screen ${def.id}: paths go under p/${match[1]}/`);
  if (def.kind == 'root' || def.kind == 'system') throw new Error(`Plugin screen ${def.id}: kind ${def.kind} is the core's`);
}

function normalize(path:string):string {
  return path.replace(/^\/+|\/+$/g, '');
}

function splitPath(url:string):string[] {
  return normalize(url.split(/[?#]/)[0]).split('/').filter(Boolean);
}

function safeDecode(part:string):string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
