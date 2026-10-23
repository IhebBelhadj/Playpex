import { isObservable, Observable, of } from 'rxjs';
import { ActionModel, MetaItem, RowModel, SearchFilterModel } from '../models';
import { SLOTS, SlotContexts, SlotName } from './slots';

type Out<T> = T[] | null | undefined | Observable<T[] | null | undefined>;

// What a slot shows from one contributor. Exactly one of actions / rows /
// meta, matching the slot's kind; a function of the slot's context, returning
// the models (null / [] = nothing here) or an Observable of them (it waits for
// data, or updates: a toggle's `on`, `busy` while working).
export interface ContributionDef<N extends SlotName = SlotName> {
  // plugin.<pluginId>.<name> (core.<name> for the core's own)
  id:string;
  slot:N;
  // core contributions use 10, 20, 30…; ties are broken by id
  order?:number;
  // adult content: never offered to kids profiles
  adult?:boolean;
  actions?:(ctx:SlotContexts[N]) => Out<ActionModel>;
  rows?:(ctx:SlotContexts[N]) => Out<RowModel>;
  meta?:(ctx:SlotContexts[N]) => Out<MetaItem>;
  searchFilter?:(ctx:SlotContexts[N]) => Out<SearchFilterModel>;
}

// a plugin may add this many contributions to one slot
export const MAX_PER_SLOT = 3;

// Contributions per slot (docs/ui-system-plan.md §5.6), checked when defined
// (like defineScreen's rules): ids, keys prefixed with the plugin's id, the
// per-slot limit, the slot's kind. <px-slot> asks it what to render.
export class ContributionRegistry {

  private bySlot = new Map<SlotName, ContributionDef[]>();

  define<N extends SlotName>(def:ContributionDef<N>):ContributionDef<N> {
    let slot = SLOTS[def.slot];
    if (!slot) throw new Error(`Contribution ${def.id}: unknown slot ${def.slot}`);
    let plugin = pluginOf(def.id);
    if (!plugin && !/^core\.[a-z0-9.-]+$/.test(def.id)) {
      throw new Error(`Contribution ids are plugin.<pluginId>.<name> (or core.<name>): ${def.id}`);
    }
    let kinds = (['actions', 'rows', 'meta', 'searchFilter'] as const).filter(k => typeof def[k] == 'function');
    if (kinds.length != 1 || kinds[0] != slot.kind) {
      throw new Error(`Contribution ${def.id}: slot ${def.slot} takes ${slot.kind}`);
    }
    let list = this.bySlot.get(def.slot) || [];
    if (list.some(c => c.id == def.id)) throw new Error(`Contribution ${def.id} is already defined`);
    if (plugin && list.filter(c => pluginOf(c.id) == plugin).length >= MAX_PER_SLOT) {
      throw new Error(`Plugin ${plugin}: at most ${MAX_PER_SLOT} contributions to ${def.slot}`);
    }
    list.push(def as ContributionDef);
    list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.bySlot.set(def.slot, list);
    return def;
  }

  remove(id:string) {
    this.bySlot.forEach((list, slot) => this.bySlot.set(slot, list.filter(c => c.id != id)));
  }

  /** The contributions shown for this context: kids never get adult ones */
  for<N extends SlotName>(slot:N, ctx:SlotContexts[N]):ContributionDef<N>[] {
    let kids = !!(ctx as any)?.profile?.kids;
    if (kids && SLOTS[slot].adult) return [];
    return (this.bySlot.get(slot) || []).filter(c => !(kids && c.adult)) as ContributionDef<N>[];
  }

  /**
   * One contribution's models for a context, as an Observable. A throwing
   * contribution, or one breaking the key rule, shows nothing (logged): it
   * never takes the screen down.
   */
  models<N extends SlotName>(def:ContributionDef<N>, ctx:SlotContexts[N]):Observable<any[]> {
    let kind = SLOTS[def.slot].kind;
    let out:Out<any>;
    try {
      out = (def[kind] as (c:SlotContexts[N]) => Out<any>)(ctx);
    } catch (e) {
      console.error(`Contribution ${def.id} failed`, e);
      return of([]);
    }
    let check = (items:any[] | null | undefined):any[] => {
      let list = (items || []).filter(Boolean);
      let plugin = pluginOf(def.id);
      if (plugin && kind != 'meta') {
        let bad = list.find(m => !String(m.key ?? '').startsWith(plugin + ':'));
        if (bad) {
          console.error(`Contribution ${def.id}: ${kind} keys start with "${plugin}:" (got "${bad.key}")`);
          return [];
        }
      }
      return list;
    };
    return new Observable<any[]>(subscriber => {
      if (!isObservable(out)) {
        subscriber.next(check(out as any[]));
        subscriber.complete();
        return () => { };
      }
      let sub = (out as Observable<any[]>).subscribe({
        next: items => subscriber.next(check(items)),
        error: e => {
          console.error(`Contribution ${def.id} failed`, e);
          subscriber.next([]);
        },
      });
      return () => sub.unsubscribe();
    });
  }
}

export function pluginOf(id:string):string | null {
  let match = /^plugin\.([a-z0-9-]+)\.[A-Za-z0-9.-]+$/.exec(id);
  return match ? match[1] : null;
}

// The app's registry (like SCREENS): contributions are defined at load time
export const CONTRIBUTIONS = new ContributionRegistry();

export function defineContribution<N extends SlotName>(def:ContributionDef<N>):ContributionDef<N> {
  return CONTRIBUTIONS.define(def);
}
