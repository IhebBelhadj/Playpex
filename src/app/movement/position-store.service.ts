import { Injectable } from '@angular/core';
import { distinctUntilChanged, map } from 'rxjs';
import { ProfilesService } from '../profiles.service';

// Where each container was: the focused item (by key, index as a fallback:
// the data may have changed) and its scroll offsets. Keys are
// `<stack id>/<row key>` for rows in a stack and `<id>` for the rest.
// Lives in root, so positions survive trips to a title page or the player;
// cleared when another profile starts watching.

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

  constructor(profiles:ProfilesService) {
    profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged()).subscribe(() => this.clear());
  }

  get(id:string):Position | undefined {
    return this.positions.get(id);
  }

  save(id:string, patch:Position) {
    this.positions.set(id, { ...this.positions.get(id), ...patch });
  }

  // Everything, or one container and the ones nested under it (`<id>/…`)
  clear(id?:string) {
    if (id === undefined) {
      this.positions.clear();
      return;
    }
    Array.from(this.positions.keys())
      .filter(key => key == id || key.startsWith(id + '/'))
      .forEach(key => this.positions.delete(key));
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
