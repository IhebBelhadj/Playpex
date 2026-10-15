import { Injectable } from '@angular/core';

// Real scrolling for the movement system: one requestAnimationFrame tween per
// container and axis. A new target re-targets the running tween (it keeps
// moving from where it is, no queue, no restart from a standstill), which is
// what makes a held arrow key glide. `scrollTo({behavior:'smooth'})` is not
// used: Chromium restarts it on every call and stutters under key repeat.
//
// The alignment helpers are pure functions (scroller.spec.ts).

export type Align = 'start' | 'third' | 'center' | 'nearest';
export type Axis = 'left' | 'top';

export const SCROLL_DURATION = 250;     // ms, as the app's CSS transitions (.25s)
// Scroll snapping (pxStack `snap`) is off while a tween moves the container:
// every frame would otherwise snap to the nearest point
const SNAP_PAUSED = 'px-snap-paused';

export interface Box {
  start: number;          // item offset inside the container's content (px)
  size: number;           // item size along the axis
}

export interface Viewport {
  scroll: number;         // current scrollLeft / scrollTop
  size: number;           // clientWidth / clientHeight
  content: number;        // scrollWidth / scrollHeight
  padStart: number;       // the container's padding (or scroll-padding) before the items
  padEnd: number;
}

export function clamp(value:number, min:number, max:number):number {
  return Math.min(max, Math.max(min, value));
}

export function maxScroll(view:Viewport):number {
  return Math.max(0, view.content - view.size);
}

// Scroll position that shows `item` as `align` asks, clamped to what the
// container can scroll
export function alignedScroll(view:Viewport, item:Box, align:Align):number {
  let wanted:number;
  switch (align) {
    case 'start':
      wanted = item.start - view.padStart;
      break;
    case 'third':
      wanted = item.start - (view.size - item.size) / 3;
      break;
    case 'center':
      wanted = item.start - (view.size - item.size) / 2;
      break;
    default: {
      let from = item.start - view.padStart;
      let to = item.start + item.size + view.padEnd - view.size;
      wanted = from < view.scroll ? from : to > view.scroll ? Math.min(to, from) : view.scroll;
    }
  }
  return Math.round(clamp(wanted, 0, maxScroll(view)));
}

export function easeOutCubic(t:number):number {
  return 1 - Math.pow(1 - t, 3);
}

// Offset of `el` inside `container`'s scrolled content, transforms ignored (a
// focused card's zoom must not shift the alignment). Walks the offsetParent
// chain: containers are positioned (the directives make them so)
export function offsetWithin(el:HTMLElement, container:HTMLElement, axis:Axis):number {
  let total = 0;
  let node:HTMLElement | null = el;
  while (node && node !== container) {
    total += axis == 'left' ? node.offsetLeft : node.offsetTop;
    let parent = node.offsetParent as HTMLElement | null;
    if (parent && parent !== container && !container.contains(parent)) {
      // the container isn't positioned: fall back to the layout boxes
      let a = el.getBoundingClientRect(), b = container.getBoundingClientRect();
      return axis == 'left'
        ? a.left - b.left - container.clientLeft + container.scrollLeft
        : a.top - b.top - container.clientTop + container.scrollTop;
    }
    if (parent && parent !== container) {
      total += axis == 'left' ? parent.clientLeft : parent.clientTop;
    }
    node = parent;
  }
  return total;
}

export function viewportOf(container:HTMLElement, axis:Axis):Viewport {
  let style = getComputedStyle(container);
  let px = (v:string) => parseFloat(v) || 0;
  if (axis == 'left') {
    return {
      scroll: container.scrollLeft,
      size: container.clientWidth,
      content: container.scrollWidth,
      padStart: px(style.scrollPaddingLeft) || px(style.paddingLeft),
      padEnd: px(style.scrollPaddingRight) || px(style.paddingRight),
    };
  }
  return {
    scroll: container.scrollTop,
    size: container.clientHeight,
    content: container.scrollHeight,
    padStart: px(style.scrollPaddingTop) || px(style.paddingTop),
    padEnd: px(style.scrollPaddingBottom) || px(style.paddingBottom),
  };
}

export function boxOf(el:HTMLElement, container:HTMLElement, axis:Axis):Box {
  return {
    start: offsetWithin(el, container, axis),
    size: axis == 'left' ? el.offsetWidth : el.offsetHeight,
  };
}

// ── tween ───────────────────────────────────────────────────────────────────

export interface Clock {
  now():number;
  frame(cb:(time:number) => void):number;
  cancel(id:number):void;
}

const browserClock:Clock = {
  now: () => performance.now(),
  frame: cb => requestAnimationFrame(cb),
  cancel: id => cancelAnimationFrame(id),
};

interface Tween {
  from: number;
  to: number;
  startedAt: number;
  frame: number;
  written: number;        // the last value written (scroll events from it aren't the user's)
}

@Injectable({
  providedIn: 'root'
})
export class Scroller {

  duration = SCROLL_DURATION;
  clock:Clock = browserClock;

  private tweens = new Map<HTMLElement, { left?:Tween, top?:Tween }>();
  private watched = new WeakSet<HTMLElement>();

  // Scrolls `container` to `left` / `top`; instant when asked, when the user
  // prefers reduced motion or when the window can't animate (hidden)
  scrollTo(container:HTMLElement, target:{ left?:number, top?:number }, options:{ instant?:boolean } = {}) {
    let instant = options.instant || this.reducedMotion() || document.hidden;
    (['left', 'top'] as Axis[]).forEach(axis => {
      let to = target[axis];
      if (to === undefined || to === null || isNaN(to)) return;
      this.tween(container, axis, Math.round(to), instant);
    });
  }

  // Scroll by a delta (row paddles): from the running tween's target, so
  // quick clicks add up
  scrollBy(container:HTMLElement, delta:{ left?:number, top?:number }) {
    let running = this.tweens.get(container) || {};
    let target:{ left?:number, top?:number } = {};
    if (delta.left) target.left = (running.left ? running.left.to : container.scrollLeft) + delta.left;
    if (delta.top) target.top = (running.top ? running.top.to : container.scrollTop) + delta.top;
    let view = { left: viewportOf(container, 'left'), top: viewportOf(container, 'top') };
    if (target.left !== undefined) target.left = clamp(target.left, 0, maxScroll(view.left));
    if (target.top !== undefined) target.top = clamp(target.top, 0, maxScroll(view.top));
    this.scrollTo(container, target);
  }

  // Where the container is going (the running tween's target, else where it is)
  targetOf(container:HTMLElement, axis:Axis):number {
    let tween = this.tweens.get(container)?.[axis];
    return tween ? tween.to : axis == 'left' ? container.scrollLeft : container.scrollTop;
  }

  isAnimating(container:HTMLElement):boolean {
    let t = this.tweens.get(container);
    return !!(t && (t.left || t.top));
  }

  cancel(container:HTMLElement, axis?:Axis) {
    let t = this.tweens.get(container);
    if (!t) return;
    (axis ? [axis] : ['left', 'top'] as Axis[]).forEach(a => {
      if (t[a]) this.clock.cancel(t[a].frame);
      delete t[a];
    });
    if (!t.left && !t.top) {
      this.tweens.delete(container);
      container.classList.remove(SNAP_PAUSED);
    }
  }

  private tween(container:HTMLElement, axis:Axis, to:number, instant:boolean) {
    this.watch(container);
    let current = axis == 'left' ? container.scrollLeft : container.scrollTop;
    let running = this.tweens.get(container)?.[axis];

    if (instant || (to == current && !running)) {
      this.cancel(container, axis);
      // a snapping container would snap the write to its nearest point
      container.classList.add(SNAP_PAUSED);
      this.write(container, axis, to);
      if (!this.tweens.has(container)) container.classList.remove(SNAP_PAUSED);
      return;
    }
    container.classList.add(SNAP_PAUSED);
    if (running && running.to == to) return;
    if (running) this.clock.cancel(running.frame);

    let tween:Tween = { from: current, to, startedAt: this.clock.now(), frame: 0, written: current };
    let entry = this.tweens.get(container) || {};
    entry[axis] = tween;
    this.tweens.set(container, entry);

    let step = () => {
      let t = Math.min(1, (this.clock.now() - tween.startedAt) / this.duration);
      let value = tween.from + (tween.to - tween.from) * easeOutCubic(t);
      tween.written = this.write(container, axis, value);
      if (t < 1) tween.frame = this.clock.frame(step);
      else this.cancel(container, axis);
    };
    tween.frame = this.clock.frame(step);
  }

  private write(container:HTMLElement, axis:Axis, value:number):number {
    if (axis == 'left') {
      container.scrollLeft = value;
      return container.scrollLeft;
    }
    container.scrollTop = value;
    return container.scrollTop;
  }

  // The user takes over (wheel, trackpad, drag): stop fighting them
  private watch(container:HTMLElement) {
    if (this.watched.has(container)) return;
    this.watched.add(container);
    let stop = () => this.cancel(container);
    container.addEventListener('wheel', stop, { passive: true });
    container.addEventListener('pointerdown', stop, { passive: true });
    container.addEventListener('scroll', () => {
      let t = this.tweens.get(container);
      if (!t) return;
      if (t.left && Math.abs(container.scrollLeft - t.left.written) > 1) this.cancel(container, 'left');
      if (t.top && Math.abs(container.scrollTop - t.top.written) > 1) this.cancel(container, 'top');
    }, { passive: true });
  }

  private reducedMotion():boolean {
    return typeof matchMedia == 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
}
