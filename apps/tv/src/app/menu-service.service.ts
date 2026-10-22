import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class MenuServiceService {

  private subject = new Subject<any>();
  menuState = "expanded";
  constructor() { }

  // `source` (the calling component) isn't logged: the console would keep
  // every page that ever sent one alive (docs/ui-system-plan.md §13.5)
  sendInstruction(instruction: string , source?) {
    this.subject.next({ instruction: instruction });
  }

  getInstruction(): Observable<any> {
    return this.subject.asObservable();
  }
}
