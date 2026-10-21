import { AfterContentInit, Component, ContentChild, ElementRef, NgZone, OnDestroy, ViewEncapsulation } from '@angular/core';
import { Subscription } from 'rxjs';
import { PxRowDirective } from '../movement/movement';
import { dp } from '../ui/public-api';

// Chevrons on a horizontal pxRow whose items don't all fit: one at each side
// the row is cut off, hidden at its ends (the row's `edges`). Put it on the
// row's wrapper (the chevrons stay put while the row scrolls or translates):
//
//   <div class="slider" rowArrows>
//     <div class="sliderSection" pxRow="popular" align="start">…</div>
//   </div>
//
// With the keyboard they only say "there's more this way" (no clicks; one
// steps aside while the focused item is under it, e.g. a poster lined up at
// the start); with the cursor shown they page the row (`page(±1)`). Centred
// on the items' artwork (`.imgContainer`, an `img`, else the item), measured.
@Component({
  selector: '[rowArrows]',
  templateUrl: './row-arrows.component.html',
  styleUrls: ['./row-arrows.component.scss'],
  // the state classes go on the host and the projected wrapper's own styles
  encapsulation: ViewEncapsulation.None,
  host: { class: 'rowArrows' },
})
export class RowArrowsComponent implements AfterContentInit, OnDestroy {

  @ContentChild(PxRowDirective, { descendants: true }) row:PxRowDirective;

  private subs:Subscription[] = [];
  private resizeObserver:ResizeObserver;
  private nudged = false;
  private coverFrame = 0;

  constructor(private elRef:ElementRef<HTMLElement>, private zone:NgZone) { }

  get host():HTMLElement {
    return this.elRef.nativeElement;
  }

  ngAfterContentInit(): void {
    let row = this.row;
    if (!row) return;
    let host = this.host;
    this.zone.runOutsideAngular(() => {
      this.subs.push(row.edges.subscribe(edges => {
        host.classList.toggle('canBack', !edges.start);
        host.classList.toggle('canForward', !edges.end);
        this.place();
        this.checkCover();
      }));
      this.subs.push(row.items.changes.subscribe(() => this.place()));
      this.resizeObserver = new ResizeObserver(() => this.place());
      this.resizeObserver.observe(host);
      host.addEventListener('focusin', this.onFocusIn);
      host.addEventListener('focusout', this.onFocusOut);
      // artwork sized once loaded; the row moved (scroll / translated track)
      host.addEventListener('load', this.onLoad, true);
      host.addEventListener('scroll', this.onMoved, true);
      host.addEventListener('transitionend', this.onMoved, true);
    });
  }

  ngOnDestroy(): void {
    this.subs.forEach(sub => sub.unsubscribe());
    this.resizeObserver?.disconnect();
    this.host.removeEventListener('focusin', this.onFocusIn);
    this.host.removeEventListener('focusout', this.onFocusOut);
    this.host.removeEventListener('load', this.onLoad, true);
    this.host.removeEventListener('scroll', this.onMoved, true);
    this.host.removeEventListener('transitionend', this.onMoved, true);
    cancelAnimationFrame(this.coverFrame);
  }

  page(direction:number) {
    this.row?.page(direction);
  }

  // Vertical centre and height of the artwork band, for the capsules
  private place() {
    let item = this.host.querySelector('[data-px-item]') as HTMLElement;
    if (!item) return;
    let art = (item.querySelector('.imgContainer, img') as HTMLElement) || item;
    let box = art.getBoundingClientRect();
    if (!box.height) return;
    let centre = box.top + box.height / 2 - this.host.getBoundingClientRect().top;
    this.host.style.setProperty('--rowArrowsY', `${Math.round(centre)}px`);
    // untransformed (a focused item is scaled up)
    this.host.style.setProperty('--rowArrowsH', `${art.offsetHeight || box.height}px`);
  }

  // `covers` on a chevron whose edge strip the focused item is under
  private checkCover() {
    let focused = this.host.contains(document.activeElement) ? document.activeElement : null;
    let box = focused?.getBoundingClientRect();
    this.host.querySelectorAll(':scope > .rowArrow').forEach(arrow => {
      let strip = arrow.getBoundingClientRect();
      arrow.classList.toggle('covers', !!box && box.right > strip.left && box.left < strip.right);
    });
  }

  private onLoad = (e:Event) => {
    if ((e.target as Element).tagName == 'IMG') this.place();
  }

  private onMoved = () => {
    cancelAnimationFrame(this.coverFrame);
    this.coverFrame = requestAnimationFrame(() => this.checkCover());
  }

  private onFocusIn = (e:FocusEvent) => {
    let host = this.host;
    this.onMoved();
    // focus arriving from outside the row, with the keyboard: the forward
    // chevron nudges once, pointing the way on
    let from = e.relatedTarget as Node | null;
    if (this.nudged || (from && host.contains(from))) return;
    if (!host.classList.contains('canForward') || !document.body.classList.contains('pointer-hidden')) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.nudged = true;
    host.querySelector('.rowArrow.forward svg')?.animate(
      [{ translate: '0' }, { translate: dp(6), offset: .35 }, { translate: '0' }],
      { duration: 560, easing: 'cubic-bezier(.3, .7, .4, 1)' },
    );
  }

  private onFocusOut = (e:FocusEvent) => {
    let to = e.relatedTarget as Node | null;
    if (!to || !this.host.contains(to)) this.onMoved();
  }
}
