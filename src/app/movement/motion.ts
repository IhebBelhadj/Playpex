import { Injectable } from '@angular/core';
import { Axis, clamp, maxScroll, offsetWithin, SCROLL_DURATION, Scroller, Viewport, viewportOf } from './scroller';

// How a movement container moves its content: the navigation strategy's
// "motion" half. Containers (and so the FocusEngine) only speak in offsets
// (how far the content is moved along an axis, like scrollLeft / scrollTop);
// the motion turns them into pixels on screen.
//
//   scroll     the container really scrolls (overflow, hidden scrollbars):
//              native wheel / trackpad / momentum, CSS snapping; glides are
//              JavaScript tweens (Scroller). The default.
//   transform  the container clips and its track is moved with translate3d
//              and a CSS transition, which runs on the compositor: it stays
//              smooth while the page is busy (category rows of posters). The
//              browser can't scroll it, so the FocusEngine turns the wheel into
//              steps (one row, one poster).
//
// Chosen per container (`motion="transform"`); rows take their stack's.

export type MotionKind = 'scroll' | 'transform';

export interface Motion {
  readonly kind:MotionKind;
  attach(host:HTMLElement, axes:Axis[]):void;
  // Where the content is going along `axis` (the target of a running glide)
  offset(host:HTMLElement, axis:Axis):number;
  viewport(host:HTMLElement, axis:Axis):Viewport;
  moveTo(host:HTMLElement, target:{ left?:number, top?:number }, options?:{ instant?:boolean }):void;
  moveBy(host:HTMLElement, delta:{ left?:number, top?:number }):void;
  // A point on screen in the container's content coordinates (offsets of its items)
  toContent(host:HTMLElement, clientX:number, clientY:number):{ x:number, y:number };
  // The element that holds the content (extra nodes such as a stack's end space go there)
  trackOf(host:HTMLElement):HTMLElement;
}

@Injectable({
  providedIn: 'root'
})
export class ScrollMotion implements Motion {

  readonly kind = 'scroll';

  constructor(private scroller:Scroller) { }

  attach(host:HTMLElement, axes:Axis[]) {
    axes.forEach(axis => host.classList.add(axis == 'left' ? 'px-scroll-x' : 'px-scroll-y'));
  }

  offset(host:HTMLElement, axis:Axis):number {
    return this.scroller.targetOf(host, axis);
  }

  viewport(host:HTMLElement, axis:Axis):Viewport {
    return { ...viewportOf(host, axis), scroll: this.offset(host, axis) };
  }

  moveTo(host:HTMLElement, target:{ left?:number, top?:number }, options:{ instant?:boolean } = {}) {
    this.scroller.scrollTo(host, target, options);
  }

  moveBy(host:HTMLElement, delta:{ left?:number, top?:number }) {
    this.scroller.scrollBy(host, delta);
  }

  toContent(host:HTMLElement, clientX:number, clientY:number) {
    let rect = host.getBoundingClientRect();
    return {
      x: clientX - rect.left - host.clientLeft + host.scrollLeft,
      y: clientY - rect.top - host.clientTop + host.scrollTop,
    };
  }

  trackOf(host:HTMLElement):HTMLElement {
    return host;
  }
}

const EASE_OUT_CUBIC = 'cubic-bezier(.215, .61, .355, 1)';

@Injectable({
  providedIn: 'root'
})
export class TransformMotion implements Motion {

  readonly kind = 'transform';

  private offsets = new WeakMap<HTMLElement, { left:number, top:number }>();

  // The track is the host's `pxTrack` child (the host clips: a stack with an
  // overlay next to its rows) or the host itself (a row: an ancestor clips,
  // usually its stack)
  trackOf(host:HTMLElement):HTMLElement {
    // the static attribute: the pxTrack directive initializes after its container
    return host.querySelector(':scope > [pxTrack]') as HTMLElement || host;
  }

  attach(host:HTMLElement, axes:Axis[]) {
    let track = this.trackOf(host);
    if (track !== host) host.classList.add('px-clip');
    track.classList.add('px-track');
    if (!this.offsets.has(host)) this.offsets.set(host, { left: 0, top: 0 });
  }

  offset(host:HTMLElement, axis:Axis):number {
    return this.offsets.get(host)?.[axis] || 0;
  }

  viewport(host:HTMLElement, axis:Axis):Viewport {
    let track = this.trackOf(host);
    let style = getComputedStyle(host);
    let px = (v:string) => parseFloat(v) || 0;
    let horizontal = axis == 'left';
    // the content's extent: the track's box plus whatever overflows it
    let content = track === host
      ? (horizontal ? host.scrollWidth : host.scrollHeight)
      : offsetWithin(track, host, axis) + (horizontal ? Math.max(track.offsetWidth, track.scrollWidth) : Math.max(track.offsetHeight, track.scrollHeight))
        + (horizontal ? px(style.paddingRight) : px(style.paddingBottom));
    return {
      scroll: this.offset(host, axis),
      size: horizontal ? host.clientWidth : host.clientHeight,
      content,
      padStart: horizontal ? px(style.scrollPaddingLeft) || px(style.paddingLeft) : px(style.scrollPaddingTop) || px(style.paddingTop),
      padEnd: horizontal ? px(style.scrollPaddingRight) || px(style.paddingRight) : px(style.scrollPaddingBottom) || px(style.paddingBottom),
    };
  }

  moveTo(host:HTMLElement, target:{ left?:number, top?:number }, options:{ instant?:boolean } = {}) {
    let current = this.offsets.get(host) || { left: 0, top: 0 };
    let next = {
      left: target.left === undefined || target.left === null || isNaN(target.left) ? current.left : Math.round(target.left),
      top: target.top === undefined || target.top === null || isNaN(target.top) ? current.top : Math.round(target.top),
    };
    this.offsets.set(host, next);
    let track = this.trackOf(host);
    let transform = `translate3d(${-next.left}px, ${-next.top}px, 0)`;
    let instant = options.instant || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (instant) {
      track.style.transition = 'none';
      track.style.transform = transform;
      track.getBoundingClientRect();        // apply it before the transition comes back
      track.style.transition = '';
      return;
    }
    // a transition re-targets from where the track is: held keys glide
    track.style.transition = `transform ${SCROLL_DURATION}ms ${EASE_OUT_CUBIC}`;
    track.style.transform = transform;
  }

  moveBy(host:HTMLElement, delta:{ left?:number, top?:number }) {
    let target:{ left?:number, top?:number } = {};
    (['left', 'top'] as Axis[]).forEach(axis => {
      if (!delta[axis]) return;
      target[axis] = clamp(this.offset(host, axis) + delta[axis], 0, maxScroll(this.viewport(host, axis)));
    });
    this.moveTo(host, target);
  }

  toContent(host:HTMLElement, clientX:number, clientY:number) {
    let track = this.trackOf(host);
    let rect = track.getBoundingClientRect();
    let x = clientX - rect.left, y = clientY - rect.top;
    if (track !== host) {
      x += offsetWithin(track, host, 'left');
      y += offsetWithin(track, host, 'top');
    }
    return { x, y };
  }
}
