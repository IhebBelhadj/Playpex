import { SplashService } from './../splash.service';
import { Component, OnInit, AfterViewInit } from '@angular/core';
import { gsap , Power1 } from 'gsap';

@Component({
  selector: 'splash',
  templateUrl: './splash.component.html',
  styleUrls: ['./splash.component.scss']
})
export class SplashComponent implements AfterViewInit {

  constructor(private splashService:SplashService) { }

  private closed = false;
  private fallback:any;

  ngAfterViewInit(): void {
    var splashVideo = document.querySelector('.splashAnimation') as HTMLVideoElement;
    splashVideo.addEventListener('canplaythrough' , ()=>{
      setTimeout(()=> this.start(splashVideo) , 1000);
    }, { once: true })

    splashVideo.addEventListener('ended' , ()=>{
      setTimeout(()=>{
        this.closeSplash()
      } , 800)

    })
    // a browser that never gets it ready (no preload, an error): the app
    // must not wait behind it
    splashVideo.addEventListener('error', () => this.closeSplash());
    this.fallback = setTimeout(() => {
      if (splashVideo.paused) this.closeSplash();
    }, 8000);
  }

  // With its sound where it may (Playpex TV's Electron). A browser refuses
  // sound before the first click or key press (autoplay policy,
  // docs/web-client-plan.md §5.4): then muted, which is always allowed; and
  // if even that fails, no splash
  private start(video:HTMLVideoElement) {
    video.play()?.catch(() => {
      video.muted = true;
      return video.play();
    }).catch(() => this.closeSplash());
  }

  closeSplash(){
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.fallback);
      let splashTl = gsap.timeline();
      splashTl.fromTo('.splashContainer' ,{opacity : 1} , {opacity : 0 , duration : .5 , ease : Power1.easeOut , onComplete : ()=>{
        (document.querySelector('.splashContainer') as HTMLElement).style.display = "none"
        this.splashService.splashAddCommand('clearSplash');
      }})
  }

}
