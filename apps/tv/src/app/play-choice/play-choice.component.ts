import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { PlayChoiceRequest, PlayChoiceService } from '../play-choice.service';

// Modal: Resume (from the saved position) or Play from the beginning.
// Own spatial-nav section; AppComponent forwards select/back here while open.
@Component({
  selector: 'play-choice',
  templateUrl: './play-choice.component.html',
  styleUrls: ['./play-choice.component.scss']
})
export class PlayChoiceComponent implements OnInit, OnDestroy {

  request:PlayChoiceRequest;
  private previousFocus:HTMLElement;
  private subscriptions:Subscription[] = [];

  constructor(
    private choices:PlayChoiceService,
    private navigation:NavigationService,
  ) { }

  get progress():number {
    return this.request && this.request.durationS ? Math.min(1, this.request.positionS / this.request.durationS) : 0;
  }

  get minutesLeft():number {
    return Math.max(1, Math.round((this.request.durationS - this.request.positionS) / 60));
  }

  ngOnInit(): void {
    this.subscriptions.push(
      this.choices.onRequest().subscribe(request => this.open(request)),
      this.choices.onCommand().subscribe(action => {
        if (action == 'select') this.pickFocused();
        if (action == 'back') this.close();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(s => s.unsubscribe());
  }

  open(request:PlayChoiceRequest) {
    if (this.request) this.request.cancel();
    this.request = request;
    this.choices.isOpen = true;
    this.previousFocus = document.activeElement as HTMLElement;

    // the trapping section is a pxSection in the template
    setTimeout(() => {
      (document.querySelector('.playChoice .choice[data-choice="resume"]') as HTMLElement)?.focus({ preventScroll: true });
    }, 0);
  }

  pickFocused() {
    let active = document.activeElement as HTMLElement;
    if (!this.request || !active.classList.contains('choice')) return;
    let choice = active.dataset['choice'] as 'resume' | 'restart';
    let request = this.request;
    this.close(() => request.pick(choice));
  }

  close(done = () => this.request?.cancel()) {
    if (!this.request) return;
    this.previousFocus?.focus({ preventScroll: true });
    done();
    this.request = undefined;
    this.choices.isOpen = false;
  }

  // 0:42:13 → "42:13", 1:02:05 → "1:02:05"
  time(seconds:number):string {
    let s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    let pad = (n:number) => (n < 10 ? '0' : '') + n;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }
}
