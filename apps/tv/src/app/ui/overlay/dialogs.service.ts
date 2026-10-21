import { Injectable } from '@angular/core';
import { BehaviorSubject, defaultIfEmpty, map, Observable } from 'rxjs';
import { OverlayLevel } from './px-overlay';

export interface DialogChoice<T = unknown> {
  key: string;
  label: string;
  detail?: string;
  progress?: number;         // 0–1, amber
  value: T;
}

export interface DialogOptions {
  id?: string;               // layer + section id (default: dialog-<n>)
  title?: string;
  subtitle?: string;
  level?: OverlayLevel;      // default modal
  global?: boolean;          // survives navigation (default: closed with its screen)
  width?: number;            // dp
  focus?: string;            // key of the choice focused first
}

// What <px-dialog-host> renders
export interface DialogRequest extends DialogOptions {
  id: string;
  choices: DialogChoice[];
  pick(choice:DialogChoice):void;
  cancel():void;
}

// Dialogs opened from code, for plugins and simple core cases (nobody has to
// put a component in the shell): rendered by the shell's <px-dialog-host> on
// the <px-dialog> frame. Each one is an Observable: subscribing opens it,
// unsubscribing closes it.
//
//   dialogs.choose({ title: 'Quality', choices: [{ key: 'hd', label: '1080p', value: 1080 }, …] })
//     .subscribe(height => …);       // emits once; completes empty on Back
//   dialogs.confirm({ title: 'Delete?', confirm: 'Delete' })   // true / false (Back: false)
//   dialogs.alert({ title: 'Done', text: '…' })                // emits once it's dismissed
@Injectable({
  providedIn: 'root'
})
export class Dialogs {

  readonly open$ = new BehaviorSubject<readonly DialogRequest[]>([]);
  private count = 0;

  choose<T>(options:DialogOptions & { choices:DialogChoice<T>[] }):Observable<T> {
    return new Observable<T>(subscriber => {
      let request:DialogRequest = {
        level: 'modal',
        ...options,
        id: options.id || `dialog-${++this.count}`,
        pick: choice => {
          subscriber.next(choice.value as T);
          subscriber.complete();
        },
        cancel: () => subscriber.complete(),
      };
      this.open$.next([...this.open$.value, request]);
      return () => this.open$.next(this.open$.value.filter(r => r !== request));
    });
  }

  confirm(options:DialogOptions & { text?:string, confirm?:string, cancel?:string }):Observable<boolean> {
    return this.choose<boolean>({
      ...options,
      subtitle: options.text ?? options.subtitle,
      choices: [
        { key: 'confirm', label: options.confirm || 'OK', value: true },
        { key: 'cancel', label: options.cancel || 'Cancel', value: false },
      ],
    }).pipe(defaultIfEmpty(false));
  }

  alert(options:DialogOptions & { text?:string, ok?:string }):Observable<void> {
    return this.choose<true>({
      ...options,
      subtitle: options.text ?? options.subtitle,
      choices: [{ key: 'ok', label: options.ok || 'OK', value: true }],
    }).pipe(defaultIfEmpty(true), map(() => undefined));
  }
}
