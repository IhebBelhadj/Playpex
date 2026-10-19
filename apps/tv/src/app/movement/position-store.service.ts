import { Injectable } from '@angular/core';
import { distinctUntilChanged, map } from 'rxjs';
import { ProfilesService } from '../profiles.service';

// Where each container was: the focused item (by key, index as a fallback:
// the data may have changed) and its scroll offsets. Keys are
// `<stack id>/<row key>` for rows in a stack and `<id>` for the rest.
// Lives in root, so positions survive trips to a title page or the player;
// cleared when another profile starts watching.
//
// Keys are scoped by the navigator (src/app/nav): `scope` is the shown
// history entry's prefix (`e<entry id>:`), empty for sections, whose
// positions outlive their entries (back in a section = where it was). Two
// movie pages in the history don't share their `cast` / `similar` rows; an
// entry's keys go when it leaves the history (`clearScope`).

export interface Position {
  key?: string;
  index?: number;
  scrollLeft?: number;
  scrollTop?: number;
}

@Injectable({
  providedIn: 'root'
})
export class PositionStore {

  private positions = new Map<string, Position>();
  // the shown entry's prefix (set by the navigator)
  scope = '';

  constructor(profiles:ProfilesService) {
    profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged()).subscribe(() => this.clear());
  }

  get(id:string, scope = this.scope):Position | undefined {
    return this.positions.get(scope + id);
  }

  save(id:string, patch:Position, scope = this.scope) {
    let key = scope + id;
    this.positions.set(key, { ...this.positions.get(key), ...patch });
  }

  // Everything, or one container and the ones nested under it (`<id>/…`)
  clear(id?:string, scope = this.scope) {
    if (id === undefined) {
      this.positions.clear();
      return;
    }
    let key = scope + id;
    Array.from(this.positions.keys())
      .filter(k => k == key || k.startsWith(key + '/'))
      .forEach(k => this.positions.delete(k));
  }

  setScope(scope:string) {
    this.scope = scope;
  }

  // An entry left the history: its positions go with it
  clearScope(scope:string) {
    if (!scope) return;
    Array.from(this.positions.keys())
      .filter(k => k.startsWith(scope))
      .forEach(k => this.positions.delete(k));
  }
}

// The item to come back to among `keys` (DOM order): the remembered key,
// else the remembered index (clamped), else none
export function rememberedIndex(position:Position | undefined, keys:(string | null)[]):number {
  if (!position || !keys.length) return -1;
  if (position.key) {
    let i = keys.indexOf(position.key);
    if (i >= 0) return i;
  }
  if (position.index !== undefined && position.index >= 0) return Math.min(position.index, keys.length - 1);
  return -1;
}
