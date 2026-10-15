import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class SplashService {
  private subject = new Subject<any>();

  // true once the intro video has faded out (for pages that open after it)
  cleared = false;

  splashAddCommand(instruction){
    if (instruction == 'clearSplash') this.cleared = true;
    this.subject.next(instruction);
  }

  splashExecuteCommand(){
    return this.subject.asObservable();
  }
  constructor() { }
}
