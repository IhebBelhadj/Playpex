import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class SplashService {
  private subject = new Subject<any>();
  splashAddCommand(instruction){
    this.subject.next(instruction);
  }

  splashExecuteCommand(){
    return this.subject.asObservable();
  }
  constructor() { }
}
