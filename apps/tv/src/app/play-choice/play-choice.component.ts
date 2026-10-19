import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { PlayChoice, PlayChoiceRequest, PlayChoiceService } from '../play-choice.service';
import { LayerRef, LayerStack, LAYER_PRIORITY } from '../nav/public-api';

// Modal: Resume (from the saved position) or Play from the beginning.
// Own spatial-nav section; a layer of the nav system while open (like the
// torrent picker): Back cancels, the focus goes back where it was.
@Component({
  selector: 'play-choice',
  templateUrl: './play-choice.component.html',
  styleUrls: ['./play-choice.component.scss']
})
export class PlayChoiceComponent implements OnInit, OnDestroy {

  request:PlayChoiceRequest;
  private layer:LayerRef<PlayChoice> | null = null;
  private subscription:Subscription;

  constructor(
    private choices:PlayChoiceService,
    private layers:LayerStack,
  ) { }

  get progress():number {
    return this.request && this.request.durationS ? Math.min(1, this.request.positionS / this.request.durationS) : 0;
  }

  get minutesLeft():number {
    return Math.max(1, Math.round((this.request.durationS - this.request.positionS) / 60));
  }

  ngOnInit(): void {
    this.subscription = this.choices.onRequest().subscribe(request => this.open(request));
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.layer?.close();
  }

  open(request:PlayChoiceRequest) {
    this.layer?.close(undefined, false);
    this.request = request;
    let layer = this.layer = this.layers.open<PlayChoice>({
      id: 'playChoice',
      priority: LAYER_PRIORITY.modal,
      element: () => document.querySelector('.playChoice'),
    });
    layer.result$.subscribe({
      next: choice => request.pick(choice),
      complete: () => {
        request.cancel();
        if (this.layer !== layer) return;
        this.layer = null;
        this.request = undefined;
      },
    });

    // the trapping section is a pxSection in the template
    setTimeout(() => {
      (document.querySelector('.playChoice .choice[data-choice="resume"]') as HTMLElement)?.focus({ preventScroll: true });
    }, 0);
  }

  pick(choice:PlayChoice) {
    this.layer?.close(choice);
  }

  // 0:42:13 → "42:13", 1:02:05 → "1:02:05"
  time(seconds:number):string {
    let s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    let pad = (n:number) => (n < 10 ? '0' : '') + n;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }
}
