import { NotificationService } from './../notification.service';
import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { PxDialogComponent } from '../ui/public-api';

// Error popup with an OK option, on the <px-dialog> frame at the alert level:
// a global layer of the nav system while shown (src/app/nav), so it survives
// the navigation that often follows an error (the player leaving); select on
// OK and back both close it. A new error while it's open replaces the text.
@Component({
  selector: 'notification-handler',
  templateUrl: './notification-handler.component.html',
})
export class NotificationHandlerComponent implements OnInit, OnDestroy {
  displayError = false;
  errorContent = "";
  @ViewChild(PxDialogComponent) dialog:PxDialogComponent;
  private subscription:Subscription;

  constructor(private notificationService:NotificationService) { }

  ngOnInit(): void {
    this.subscription = this.notificationService.getNotification().subscribe((notification)=>{
      if (notification.type != "error") return;
      this.errorContent = notification.data;
      this.displayError = true;
    })
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  close() {
    this.dialog?.finish();
    this.displayError = false;
  }

}
