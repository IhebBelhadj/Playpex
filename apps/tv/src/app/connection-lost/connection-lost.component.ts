import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { ConnectionService } from '../connection.service';
import { LayerRef, LayerStack, LAYER_PRIORITY } from '../nav/public-api';

// Modal "Lost connection to <server>": Retry / Choose server
// (ConnectionService). Same frame as <play-choice>; a global layer of the
// nav system while open, above every other one (src/app/nav): Back closes it.
@Component({
  selector: 'connection-lost',
  templateUrl: './connection-lost.component.html',
  styleUrls: ['./connection-lost.component.scss']
})
export class ConnectionLostComponent implements OnInit, OnDestroy {

  private layer:LayerRef | null = null;
  private subscription:Subscription;

  constructor(public connection:ConnectionService, private layers:LayerStack) { }

  ngOnInit(): void {
    this.subscription = this.connection.onChange().subscribe(() => {
      if (this.connection.isOpen && !this.layer) this.open();
      else if (!this.connection.isOpen && this.layer) this.layer.close();
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.layer?.close();
  }

  private open() {
    let layer = this.layer = this.layers.open({
      id: 'connectionLost',
      priority: LAYER_PRIORITY.system,
      global: true,
      element: () => document.querySelector('.connectionLost'),
    });
    // a page behind may take the focus (its own reaction to the failure):
    // select brings it back here first
    layer.onSelect(() => {
      this.focus('retry');
      return true;
    });
    layer.result$.subscribe({
      complete: () => {
        this.layer = null;
        if (this.connection.isOpen) this.connection.close();
      },
    });
    this.focus('retry');
    setTimeout(() => {
      if (this.layer === layer && !document.activeElement?.closest('.connectionLost')) this.focus('retry');
    }, 400);
  }

  private focus(choice:string) {
    setTimeout(() => (document.querySelector(`.connectionLost [data-choice="${choice}"]`) as HTMLElement)?.focus({ preventScroll: true }), 0);
  }
}
