// Pure "which item is next" logic of the movement containers (moves.spec.ts).
// Containers pass their navigable entries in DOM order; movement inside a
// container is by index, not by what happens to be on screen.

export type Direction = 'left' | 'right' | 'up' | 'down';

export const AXIS_OF:Record<Direction, 'x' | 'y'> = { left: 'x', right: 'x', up: 'y', down: 'y' };
export const STEP_OF:Record<Direction, number> = { left: -1, right: 1, up: -1, down: 1 };

// Index `step` away from `from` in a list of `count`, or -1 past the ends
// (`wrap` goes around instead)
export function stepIndex(count:number, from:number, step:number, wrap = false):number {
  if (count <= 0 || from < 0) return -1;
  let next = from + step;
  if (next >= 0 && next < count) return next;
  if (!wrap) return -1;
  return ((next % count) + count) % count;
}

// Layout box of an entry (offsets inside its container, transforms ignored)
export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Entries grouped into visual lines (same top, a few px of tolerance), in order
export function gridLines(slots:Slot[], tolerance = 4):number[][] {
  let lines:number[][] = [];
  let lineTop:number | null = null;
  slots.forEach((slot, i) => {
    if (lineTop === null || Math.abs(slot.y - lineTop) > tolerance) {
      lines.push([]);
      lineTop = slot.y;
    }
    lines[lines.length - 1].push(i);
  });
  return lines;
}

// Fixed column count: lines of `columns` entries
export function columnLines(count:number, columns:number):number[][] {
  let lines:number[][] = [];
  for (let i = 0; i < count; i += Math.max(1, columns)) {
    lines.push(Array.from({ length: Math.min(columns, count - i) }, (_, k) => i + k));
  }
  return lines;
}

// Next entry in a 2D grid: sideways within the line (stops at its ends), up /
// down to the neighbour line's entry nearest horizontally. -1 at the edges
export function gridStep(slots:Slot[], lines:number[][], from:number, direction:Direction, wrap = false):number {
  let lineIndex = lines.findIndex(line => line.includes(from));
  if (lineIndex < 0) return -1;
  let line = lines[lineIndex];

  if (AXIS_OF[direction] == 'x') {
    let i = stepIndex(line.length, line.indexOf(from), STEP_OF[direction], wrap);
    return i < 0 ? -1 : line[i];
  }

  let target = lines[lineIndex + STEP_OF[direction]];
  if (!target) return -1;
  return nearestOnAxis(slots, target, center(slots[from]).x, 'x');
}

export function center(slot:Slot):{ x:number, y:number } {
  return { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 };
}

// Among `candidates` (indexes into slots), the one whose centre is nearest to
// `point` on `axis`; the first one wins ties
export function nearestOnAxis(slots:Slot[], candidates:number[], point:number, axis:'x' | 'y'):number {
  let best = -1, bestDistance = Infinity;
  candidates.forEach(i => {
    let d = Math.abs(center(slots[i])[axis] - point);
    if (d < bestDistance - .5) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

// The part of [start, start + size] inside [viewStart, viewStart + viewSize], 0..1
export function visibleFraction(start:number, size:number, viewStart:number, viewSize:number):number {
  if (size <= 0) return 0;
  let from = Math.max(start, viewStart);
  let to = Math.min(start + size, viewStart + viewSize);
  return Math.max(0, to - from) / size;
}
