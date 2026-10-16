import { Injectable } from '@angular/core';
import { Location } from '@angular/common';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Observable, Subject } from 'rxjs';

// Where `goBack()` lands when there is no earlier page in the app's history
const HOME_URL = '/movies/list';

@Injectable({
  providedIn: 'root'
})
export class NavigationService {

  private subject = new Subject<any>();
  private movieSliderSubject = new Subject<any>();
  private command = new Subject();
  private description = new Subject();
  routerCurrentMovieId;

  // In-app pages below the current one in the browser history (the first
  // page, opened with replaceUrl, has none)
  private historyDepth = 0;
  private trigger:string;

  updateNavigation(type:string , query:Object){

    this.subject.next({
      type : type ,
      query : query
    });
  }

  updatedNavigation(): Observable<any> {
    return this.subject.asObservable();
  }

  // Leave a page opened from another one (a title, the player, the power menu)
  // for the one the user came from, like a browser's Back; with nothing before
  // it the movies list. Section pages end on `openPowerMenu()` instead.
  goBack(){
    if (this.historyDepth > 0) this.location.back();
    else this.router.navigateByUrl(HOME_URL);
  }

  // The last step back out of a section page (one the menu opens: movies, TV
  // shows, search, watch list, 18+): the power menu, whatever page came before
  openPowerMenu(){
    this.router.navigateByUrl('/power');
  }

  // Add commands to execute on keypress: 'click', 'back' (Escape: one step
  // back inside the page, then out of it) and 'leave' (the shell's Back button
  // for the mouse: out of the page at once, closing an open panel first)
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

  constructor(private router:Router, private location:Location) {
    this.router.events.subscribe(e => {
      if (e instanceof NavigationStart) this.trigger = e.navigationTrigger;
      if (!(e instanceof NavigationEnd)) return;
      let extras = this.router.getCurrentNavigation()?.extras || {};
      // the app never goes forward: a popstate is a step back
      if (this.trigger == 'popstate') this.historyDepth = Math.max(0, this.historyDepth - 1);
      else if (!extras.replaceUrl && !extras.skipLocationChange) this.historyDepth++;
    });
  }
}
