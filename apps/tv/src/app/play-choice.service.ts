import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { Dialogs } from './ui/public-api';

export type PlayChoice = 'resume' | 'restart';

// "Resume or play from the beginning?", shown before playing something that
// has a saved position: a Dialogs choice (ui/overlay, rendered by the shell's
// <px-dialog-host>). choose() emits the choice once, or completes without a
// value when the user backs out.
@Injectable({
  providedIn: 'root'
})
export class PlayChoiceService {

  constructor(private dialogs:Dialogs) { }

  choose(title:string, resume:{ positionS:number, durationS:number }):Observable<PlayChoice> {
    let { positionS, durationS } = resume;
    let minutesLeft = Math.max(1, Math.round((durationS - positionS) / 60));
    return this.dialogs.choose<PlayChoice>({
      id: 'playChoice',
      title,
      subtitle: `You stopped at ${time(positionS)}.`,
      width: 480,
      choices: [
        {
          key: 'resume', label: 'Resume', value: 'resume',
          detail: `From ${time(positionS)}, ${minutesLeft} min left`,
          progress: durationS ? Math.min(1, positionS / durationS) : 0,
        },
        { key: 'restart', label: 'Play from the beginning', value: 'restart', detail: 'Choose a source and start at 0:00' },
      ],
    });
  }

}

// 0:42:13 → "42:13", 1:02:05 → "1:02:05"
function time(seconds:number):string {
  let s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  let pad = (n:number) => (n < 10 ? '0' : '') + n;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
