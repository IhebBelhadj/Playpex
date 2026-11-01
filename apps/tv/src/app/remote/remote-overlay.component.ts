import { ChangeDetectionStrategy, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { RemoteControl, RemotePointer } from './remote-control.service';

const POINTER = 'assets/cursor/pointer.svg';
const POINTER_PRESSED = 'assets/cursor/pointer-pressed.svg';

// Remote control from the server, on screen (docs/remote-control-plan.md
// §2.6): a badge while the admin controls this device (the person in front of
// the TV must know), and the remote pointer: injected mouse events don't move
// the system cursor, so it's drawn here. Never focusable, never catches the
// mouse. The pointer is moved by hand outside Angular's zone (`pointer$` emits
// up to once a frame there): no change detection per move.
@Component({
  selector: 'remote-overlay',
  template: `
    <div class="badge" *ngIf="remote.controller$ | async as name" role="status" aria-live="polite">
      <span class="dot"></span>
      <span class="text">Controlled from the dashboard</span>
      <span class="who">{{ name }}</span>
    </div>
    <img #pointer class="pointer" alt="" [src]="pointerImage" hidden>`,
  styleUrls: ['./remote-overlay.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteOverlayComponent implements OnInit, OnDestroy {
  @ViewChild('pointer', { static: true }) private pointer:ElementRef<HTMLImageElement>;
  readonly pointerImage = POINTER;
  private subscription:Subscription;
  private pressed = false;

  constructor(public remote:RemoteControl, private zone:NgZone) { }

  ngOnInit(): void {
    this.zone.runOutsideAngular(() => {
      this.subscription = this.remote.pointer$.subscribe(p => this.draw(p));
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  private draw(p:RemotePointer) {
    let img = this.pointer.nativeElement;
    img.hidden = !p.visible;
    if (!p.visible) return;
    img.style.transform = `translate(${p.x}px, ${p.y}px)`;
    if (p.pressed !== this.pressed) {
      this.pressed = p.pressed;
      img.src = p.pressed ? POINTER_PRESSED : POINTER;
    }
  }
}
