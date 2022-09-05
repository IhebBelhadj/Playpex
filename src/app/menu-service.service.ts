import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class MenuServiceService {

  private subject = new Subject<any>();

  constructor() { }

  sendInstruction(instruction: string) {
    this.subject.next({ instruction: instruction });
  }

  getInstruction(): Observable<any> {
    return this.subject.asObservable();
  }
}
