import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { ConnectionService } from '../connection.service';

// Modal "Lost connection to <server>": Retry / Choose server
// (ConnectionService). Same frame and key handling as <play-choice>:
// AppComponent forwards select/back here while it is open.
@Component({
  selector: 'connection-lost',
  templateUrl: './connection-lost.component.html',
  styleUrls: ['./connection-lost.component.scss']
})
export class ConnectionLostComponent implements OnInit, OnDestroy {

  private previousFocus:HTMLElement;
  private subscriptions:Subscription[] = [];
  private wasOpen = false;

  constructor(public connection:ConnectionService) { }

  ngOnInit(): void {
    this.subscriptions.push(
      this.connection.onChange().subscribe(() => {
        if (this.connection.isOpen && !this.wasOpen) {
          this.previousFocus = document.activeElement as HTMLElement;
          this.focus('retry');
          // after the page's own reaction to the failure (it may focus a button)
          setTimeout(() => {
            if (this.connection.isOpen && !document.activeElement?.closest('.connectionLost')) this.focus('retry');
          }, 400);
        } else if (!this.connection.isOpen && this.wasOpen) {
          this.previousFocus?.focus({ preventScroll: true });
        }
        this.wasOpen = this.connection.isOpen;
      }),
      this.connection.onCommand().subscribe(action => {
        if (action == 'back') this.connection.close();
        if (action != 'select') return;
        const active = document.activeElement as HTMLElement;
        // a page behind may have taken the focus (e.g. its own error's button)
        if (!active?.closest('.connectionLost')) {
          this.focus('retry');
          return;
        }
        const choice = active.dataset['choice'];
        if (choice == 'retry') this.connection.retry();
        if (choice == 'servers') this.connection.chooseServer();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(s => s.unsubscribe());
  }

  private focus(choice:string) {
    setTimeout(() => (document.querySelector(`.connectionLost [data-choice="${choice}"]`) as HTMLElement)?.focus({ preventScroll: true }), 0);
  }
}
