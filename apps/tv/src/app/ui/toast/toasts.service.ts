import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  text:string;
  detail?:string;
  tone?:ToastTone;
  /** assets/icons/<icon>.svg or a URL */
  icon?:string;
  /** a toast with the same key replaces the shown / queued one (rapid toggles show one) */
  key?:string;
  /** default 4 s, errors 6 s */
  durationMs?:number;
}

export interface Toast extends ToastOptions {
  id:number;
  tone:ToastTone;
  durationMs:number;
}

export interface ToastHandle {
  dismiss():void;
}

const QUEUE = 3;

// Short messages that need no answer (docs/ui-system-plan.md §13.3): "Added to
// your watch list", "Couldn't save the setting". Never focusable, never take an
// input; anything that needs an answer is a Dialogs call. One shown at a time,
// at most 3 waiting (the oldest waiting ones are dropped). Rendered by the
// shell's <px-toast-host>.
//
//   toasts.show({ text: 'Added to your watch list', tone: 'success', key: 'watchlist' })
@Injectable({
  providedIn: 'root'
})
export class Toasts {

  /** the shown toast */
  readonly current$ = new BehaviorSubject<Toast | null>(null);
  private queue:Toast[] = [];
  private timer:any = null;
  private count = 0;

  constructor(private zone:NgZone) { }

  show(options:ToastOptions):ToastHandle {
    let tone = options.tone || 'info';
    let toast:Toast = { ...options, id: ++this.count, tone, durationMs: options.durationMs ?? (tone == 'error' ? 6000 : 4000) };
    let shown = this.current$.value;
    if (options.key && shown?.key == options.key) {
      this.current$.next(toast);
      this.arm(toast);
    } else {
      if (options.key) this.queue = this.queue.filter(t => t.key != options.key);
      this.queue.push(toast);
      if (this.queue.length > QUEUE) this.queue.splice(0, this.queue.length - QUEUE);
      if (!shown) this.next();
    }
    return { dismiss: () => this.dismiss(toast.id) };
  }

  dismiss(id:number) {
    this.queue = this.queue.filter(t => t.id != id);
    if (this.current$.value?.id == id) this.next();
  }

  /** for specs and the gallery */
  get waiting():readonly Toast[] {
    return this.queue;
  }

  private next() {
    clearTimeout(this.timer);
    this.timer = null;
    let toast = this.queue.shift() || null;
    this.current$.next(toast);
    if (toast) this.arm(toast);
  }

  private arm(toast:Toast) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.zone.run(() => {
      if (this.current$.value?.id == toast.id) this.next();
    }), toast.durationMs);
  }
}
