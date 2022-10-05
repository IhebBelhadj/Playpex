import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class BackgroundService {
  previousUrl;
  private subject = new Subject<any>();

  constructor() { }

  sendImage(url: string) {
    if(!this.previousUrl){
      this.previousUrl = url;
      this.subject.next({ img_url: url });
      return
    }

    if (url != this.previousUrl) {
      console.log(url + ' vs ' + this.previousUrl);
      this.previousUrl = url;
      this.subject.next({ img_url: url });
    }
  }

  getImage(): Observable<any> {
    return this.subject.asObservable();
  }
}
