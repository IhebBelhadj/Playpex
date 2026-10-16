import { Subject, Observable } from 'rxjs';
import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private subject = new Subject()  ;

  sendNotification(type:string , data:string){
    this.subject.next({type , data})
  }

  getNotification() :Observable<{type:string , data:string}>{
    return this.subject.asObservable() as Observable<{type:string , data:string}>;
  }
  constructor() { }
}
