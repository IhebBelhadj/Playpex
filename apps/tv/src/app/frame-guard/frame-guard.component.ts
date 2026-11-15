import { Component, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { desktop } from '../desktop';
import { isWeb } from '../web/web-client';
import { PxDialogComponent, Toasts } from '../ui/public-api';

// The UI scales evenly with the screen area (styles.scss, no floor): under
// this root size at full scale (an area of about 630 × 354) its text is too
// small to read
const READABLE_PX = 7;
const DESIGN_W = 90, DESIGN_H = 50.625;   // the 1440 × 810 design in rem at 16px
const SETTLE_MS = 150;
// a browser: offered once per device (docs/web-client-plan.md §5.4)
const FULLSCREEN_TIP_KEY = 'playpex.fullscreenTip';

// "Too small" (docs/web-client-plan.md §3.3): the UI scales down evenly with
// the screen area (the window inside the screen edges and the shape,
// --px-screen-w / -h), like YouTube's TV app, so nothing is ever cut off; only
// when it gets too small to read (an area under about 630 × 354 CSS pixels) a
// system dialog says so, with Full screen (browsers) and Continue anyway. Shown
// again only after the window was big enough once. A portrait window (taller
// than wide) gets a toast instead: the area fits any shape, it's only a waste
// of the screen.
//
// Measured with a probe sized by the tokens, so it follows applyFrame() too
// (which sends a resize event).
//
// In a browser it also owns full screen (browsers want a key press or a click
// for it): F toggles it (not while typing), and the first key press or click
// on a device says so once.
@Component({
  selector: 'frame-guard',
  template: `
    <px-dialog *ngIf="tooSmall && !dismissed" id="frameGuard" level="system" [global]="true" [width]="520"
      title="Make the window bigger" [subtitle]="subtitle" (closed)="dismissed = true">
      <px-option *ngIf="canFullscreen" key="fullscreen" label="Full screen" detail="Use the whole screen"
        (pxSelect)="fullscreen()"></px-option>
      <px-option key="continue" label="Continue anyway" detail="Everything stays this small"
        (pxSelect)="dismiss()"></px-option>
    </px-dialog>`,
})
export class FrameGuardComponent implements OnInit, OnDestroy {

  @ViewChild(PxDialogComponent) dialog:PxDialogComponent;
  tooSmall = false;
  dismissed = false;
  private portrait = false;
  private probe:HTMLElement;
  private timer:any;
  private tipChecked = false;

  constructor(private zone:NgZone, private toasts:Toasts) { }

  get canFullscreen():boolean {
    // the shell's window is full screen already; a browser's page may ask
    return !desktop() && !!document.documentElement.requestFullscreen && !document.fullscreenElement;
  }

  get subtitle():string {
    let zoom = desktop() ? '' : ', or zoom the page out (Ctrl and −)';
    return `At this size Playpex is too small to read. Make the window bigger${this.canFullscreen ? ', use full screen' : ''}${zoom}.`;
  }

  ngOnInit(): void {
    let probe = this.probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:var(--px-screen-w);height:var(--px-screen-h);visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    this.zone.runOutsideAngular(() => {
      window.addEventListener('resize', this.onResize);
      document.addEventListener('fullscreenchange', this.onResize);
      if (this.web) {
        window.addEventListener('keydown', this.onKey);
        window.addEventListener('pointerdown', this.onGesture);
      }
    });
    this.check();
  }

  private get web():boolean {
    return isWeb && !desktop();
  }

  // F: full screen on and off (a browser), unless text is being typed
  private onKey = (e:KeyboardEvent) => {
    this.onGesture();
    if (e.key != 'f' && e.key != 'F' || e.ctrlKey || e.metaKey || e.altKey) return;
    let target = e.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, [contenteditable="true"]') || document.querySelector('text-keyboard, pin-pad')) return;
    e.preventDefault();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    else this.fullscreen();
  }

  // the first gesture on this device: how to get full screen, once
  private onGesture = () => {
    window.removeEventListener('pointerdown', this.onGesture);
    if (this.tipChecked) return;
    this.tipChecked = true;
    let seen = true;
    try { seen = !!localStorage.getItem(FULLSCREEN_TIP_KEY); } catch (e) { }
    if (seen || document.fullscreenElement) return;
    try { localStorage.setItem(FULLSCREEN_TIP_KEY, '1'); } catch (e) { }
    this.zone.run(() => this.toasts.show({ text: 'Press F for full screen', detail: 'Or from the power menu.', key: 'fullscreen', durationMs: 6000 }));
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('fullscreenchange', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointerdown', this.onGesture);
    clearTimeout(this.timer);
    this.probe?.remove();
  }

  // the focus goes back where it was first (px-overlay finish())
  dismiss() {
    this.dialog?.finish();
    this.dismissed = true;
  }

  fullscreen() {
    document.documentElement.requestFullscreen().then(() => this.check()).catch(() => {
      this.toasts.show({ text: "Couldn't go full screen", detail: 'Use the browser’s own full screen (F11).', tone: 'error', key: 'frame' });
    });
  }

  private onResize = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), SETTLE_MS);
  }

  private check() {
    let w = this.probe.offsetWidth, h = this.probe.offsetHeight;
    if (!w || !h) return;
    let small = Math.min(w / DESIGN_W, h / DESIGN_H) < READABLE_PX;
    let portrait = window.innerHeight > window.innerWidth * 1.05;
    if (small != this.tooSmall) {
      this.zone.run(() => {
        this.tooSmall = small;
        // big enough once: the next time it's too small, it's said again
        if (!small) this.dismissed = false;
      });
    }
    if (portrait && !this.portrait && !small) {
      this.zone.run(() => this.toasts.show({
        text: 'Playpex TV is made for wide screens',
        detail: 'On a phone, use Playpex Mobile.',
        key: 'frame',
        durationMs: 6000,
      }));
    }
    this.portrait = portrait;
  }
}
