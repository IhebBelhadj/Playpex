import { Component, isDevMode, NgZone, OnDestroy, OnInit } from '@angular/core';
import { combineLatest, Subscription } from 'rxjs';
import { LayerStack } from './layer-stack.service';
import { Navigator } from './navigator.service';

const TOGGLE_KEY = 'F9';

// Development builds only: F9 shows the navigator's stack (top first), the
// open layers and who gets select / back now
@Component({
  selector: 'nav-debug',
  template: `
    <div class="navDebug" *ngIf="shown">
      <b>stack</b>
      <div *ngFor="let line of stack" [class.top]="line.top">{{ line.text }}</div>
      <b>layers</b>
      <div *ngFor="let line of layers">{{ line }}</div>
      <div *ngIf="!layers.length">—</div>
      <b>owner</b>
      <div>{{ owner }}</div>
    </div>
  `,
  styles: [`
    .navDebug {
      position: fixed; right: 12px; bottom: 12px; z-index: 1000; max-width: 420px;
      padding: 10px 14px; border-radius: 8px; background: rgba(0, 0, 0, .85); color: #ddd;
      font: 12px/1.5 monospace; pointer-events: none; white-space: pre-wrap;
    }
    b { display: block; margin-top: 4px; color: #888; font-weight: normal; }
    .top { color: #ffc107; }
  `],
})
export class NavDebugComponent implements OnInit, OnDestroy {

  shown = false;
  stack:{ text:string, top:boolean }[] = [];
  layers:string[] = [];
  owner = '';

  private sub:Subscription;
  private onKey = (e:KeyboardEvent) => {
    if (e.key != TOGGLE_KEY) return;
    this.zone.run(() => this.shown = !this.shown);
  };

  constructor(private navigator:Navigator, private layerStack:LayerStack, private zone:NgZone) { }

  ngOnInit(): void {
    if (!isDevMode()) return;
    window.addEventListener('keydown', this.onKey);
    this.sub = combineLatest([this.navigator.stack$, this.layerStack.layers$]).subscribe(([stack, layers]) => {
      this.stack = stack.map((entry, i) => ({
        text: `#${entry.id} ${entry.screen.id} ${JSON.stringify(entry.params)}${entry.payload ? ' +payload' : ''}`,
        top: i == stack.length - 1,
      })).reverse();
      this.layers = layers.map(layer => `${layer.def.id} (${layer.priority}${layer.owner ? ', #' + layer.owner.id : ', global'})`).reverse();
      let top = layers[layers.length - 1];
      this.owner = top ? `layer ${top.def.id}` : this.navigator.owners().map(ref => ref.kind).join(' → ') || 'navigator';
    });
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.onKey);
    this.sub?.unsubscribe();
  }
}
