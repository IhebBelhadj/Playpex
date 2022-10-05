import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class NavigationService {

  private subject = new Subject<any>();
  private movieSliderSubject = new Subject<any>();
  private command = new Subject();
  private description = new Subject();
  routerCurrentMovieId;

  updateNavigation(type:string , query:Object){

    this.subject.next({
      type : type ,
      query : query
    });
  }

  updatedNavigation(): Observable<any> {
    return this.subject.asObservable();
  }

  // Add commands to execute on keypress
      addCommand(type){
        this.command.next(type);
      }

      executeCommand() : Observable<any>{
        return this.command.asObservable();
      }


  // Update description on route change

      descriptionUpdateQuery(movie){
        return this.description.next(movie)
      }

      onDescriptionUpdate():Observable<any> {
        return this.description.asObservable();
      }


  // send events to control movie slider remotely

  sendMovieSliderEvent(event){
    console.log('in navigation event');

    return this.movieSliderSubject.next(event)
  }

  getMovieSliderEvent(){
    return this.movieSliderSubject.asObservable();
  }

  constructor() { }
}
