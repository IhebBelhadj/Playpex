import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export type PlayChoice = 'resume' | 'restart';

export interface PlayChoiceRequest {
  title: string;                 // movie title, or "Show S01E03"
  positionS: number;             // where it stopped
  durationS: number;
  pick: (choice:PlayChoice) => void;
  cancel: () => void;
}

// "Resume or play from the beginning?" modal, shown before playing something
// that has a saved position. choose() emits the choice once, or completes
// without a value when the user backs out. Same pattern as TorrentPickerService.
@Injectable({
  providedIn: 'root'
})
export class PlayChoiceService {

  private requests = new Subject<PlayChoiceRequest>();

  choose(title:string, resume:{ positionS:number, durationS:number }):Observable<PlayChoice> {
    return new Observable(subscriber => {
      this.requests.next({
        title,
        positionS: resume.positionS,
        durationS: resume.durationS,
        pick: choice => { subscriber.next(choice); subscriber.complete(); },
        cancel: () => subscriber.complete(),
      });
    });
  }

  onRequest():Observable<PlayChoiceRequest> {
    return this.requests.asObservable();
  }

}
