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

  ngAfterViewInit(): void {
    var splashVideo = document.querySelector('.splashAnimation') as HTMLVideoElement;
    splashVideo.addEventListener('canplaythrough' , ()=>{
      setTimeout(()=>{
        splashVideo.play();
      } , 1000);
    })

    splashVideo.addEventListener('ended' , ()=>{
      setTimeout(()=>{
        this.closeSplash()
      } , 800)

    })
  }

  closeSplash(){
      let splashTl = gsap.timeline();
      splashTl.fromTo('.splashContainer' ,{opacity : 1} , {opacity : 0 , duration : .5 , ease : Power1.easeOut , onComplete : ()=>{
        (document.querySelector('.splashContainer') as HTMLElement).style.display = "none"
        this.splashService.splashAddCommand('clearSplash');
      }})
  }

}
