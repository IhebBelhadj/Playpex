import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class BackgroundService {
  previousUrl;
  private subject = new Subject<any>();

  constructor() { }

  // url: a TMDB image path ("/abc.jpg") or a full image URL
  sendImage(url: string) {
    if(!this.previousUrl){
      this.previousUrl = url;
      this.subject.next({ img_url: url });
      return
    }

    if (url != this.previousUrl) {
      this.previousUrl = url;
      this.subject.next({ img_url: url });
    }
  }

  getImage(): Observable<any> {
    return this.subject.asObservable();
  }
}
