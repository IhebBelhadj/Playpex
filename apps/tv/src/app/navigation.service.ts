import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

// Spatial-navigation instructions (sections added / removed in code) and two
// page-to-page channels. Despite the name, navigation (screens, history,
// Back, who gets select / back) is the nav system's: src/app/nav.
@Injectable({
  providedIn: 'root'
})
export class NavigationService {

  private subject = new Subject<any>();
  private movieSliderSubject = new Subject<any>();
  private description = new Subject();


  updateNavigation(type:string , query:Object){

    this.subject.next({
      type : type ,
      query : query
    });
  }

  updatedNavigation(): Observable<any> {
    return this.subject.asObservable();
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
    return this.movieSliderSubject.next(event)
  }

  getMovieSliderEvent(){
    return this.movieSliderSubject.asObservable();
  }
}
