import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class BackgroundService {

  private subject = new Subject<any>();

  constructor() { }

  sendImage(url: string) {
    this.subject.next({ img_url: url });
  }

  getImage(): Observable<any> {
    return this.subject.asObservable();
  }
}
