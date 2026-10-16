import { Subject, Observable, BehaviorSubject } from 'rxjs';
import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class YoutubeService {

  private subject = new Subject();
  ytUrl = new BehaviorSubject({});


  constructor() { }

  updateYtUrl(video_id){
    return this.ytUrl.next({id :video_id});
  }

  getYtUrl() : Observable<Object>{
    return this.ytUrl.asObservable();
  }

  ytInstruction(instruction){
    return this.subject.next({instruction :instruction});
  }

  executeYtInstruction() : Observable<Object>{
    return this.subject.asObservable();
  }



}
