import { Component } from '@angular/core';
import { ConnectionService } from '../connection.service';

// Modal "Lost connection to <server>": Retry / Choose server
// (ConnectionService). On the <px-dialog> frame, at the system level: a
// global layer above every other one (src/app/nav); Back closes it. A page
// behind that grabs the focus (its own reaction to the failure) loses it
// again (PxOverlay).
@Component({
  selector: 'connection-lost',
  templateUrl: './connection-lost.component.html',
})
export class ConnectionLostComponent {

  constructor(public connection:ConnectionService) { }

  onClosed() {
    if (this.connection.isOpen) this.connection.close();
  }
}
