import { NotificationService } from './../notification.service';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { LayerRef, LayerStack, LAYER_PRIORITY } from '../nav/public-api';

// Error popup with an "ok" button: a global layer of the nav system while
// shown (src/app/nav), so it survives the navigation that often follows an
// error (the player leaving) and takes select / back (both close it)
@Component({
  selector: 'notification-handler',
  templateUrl: './notification-handler.component.html',
  styleUrls: ['./notification-handler.component.scss']
})
export class NotificationHandlerComponent implements OnInit, OnDestroy {
  displayError = false;
  errorContent = "";
  private layer:LayerRef | null = null;
  private subscription:Subscription;

  constructor(
    private notificationService:NotificationService,
    private layers:LayerStack,
    ) { }

  ngOnInit(): void {
    this.subscription = this.notificationService.getNotification().subscribe((notification)=>{
      if (notification.type != "error") return;
      this.errorContent = notification.data;
      this.displayError = true;
      if (!this.layer) {
        let layer = this.layer = this.layers.open({
          id: 'notification',
          priority: LAYER_PRIORITY.alert,
          global: true,
          element: () => document.querySelector('.errorHandler'),
        });
        layer.result$.subscribe({ complete: () => {
          this.layer = null;
          this.displayError = false;
        } });
      }
      setTimeout(() => (document.querySelector('.errorWrapper .okBtn') as HTMLElement)?.focus({ preventScroll: true }), 100);
    })
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.layer?.close();
  }

  close() {
    this.layer?.close();
  }

}
