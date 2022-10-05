import { NavigationService } from './../navigation.service';
import { MenuServiceService } from './../menu-service.service';
import { ActivatedRoute, Router } from '@angular/router';
import { Component, OnInit, OnDestroy, AfterViewInit } from '@angular/core';
import { YoutubeService } from '../youtube.service';
import { Location } from "@angular/common";
import { Subscription } from 'rxjs';
import { gsap ,Power1} from 'gsap'


@Component({
  selector: 'youtube',
  templateUrl: './youtube.component.html',
  styleUrls: ['./youtube.component.scss']
})
export class YoutubeComponent implements OnInit , OnDestroy,AfterViewInit {

  baseUrl = "http://localhost:9500/youtube/";
  video_id;
  player:HTMLVideoElement;
  navigationSub:Subscription;
  canplay:boolean = false;
  playerPaused:boolean = false;
  constructor(
    private ytService:YoutubeService,
    private activeRoute:ActivatedRoute,
    private menuService:MenuServiceService,
    private navigation:NavigationService,
    private location:Location,
    private router:Router,
  ) {

    this.menuService.sendInstruction('hide');
  }

  ngOnInit(): void {
    this.video_id = this.activeRoute.snapshot.params['id'];

    this.navigationHandler();

  }

  ngAfterViewInit(): void {
    this.player = document.querySelector(".ytPlayer");

    this.player.src=this.baseUrl+this.video_id;
    let durationDisp = document.querySelector(".ytContainer .duration") as HTMLElement;
    let currentDisp = document.querySelector(".ytContainer .currentTime") as HTMLElement;
    let slider = document.querySelector(".ytContainer .current") as HTMLElement;
    let controls = document.querySelector(".ytContainer .controls") as HTMLElement;

    this.player.addEventListener('canplay' , ()=>{
      this.canplay = true;
      this.player.play();
      this.playerPaused = false;
      controls.style.display = "flex";
      let duration = this.player.duration;

      durationDisp.innerHTML = this.timeDisplayString(duration)

      this.player.addEventListener('timeupdate' , ()=>{
        //update Time Slider here
        currentDisp.textContent = this.timeDisplayString(this.player.currentTime)
        slider.style.width = Math.floor(this.player.currentTime *100 /duration)+"%"

      })
    })

    document.addEventListener('keydown' , (e)=>{
      if(!this.router.url.includes('/ytplayer')) return;
      if(!this.canplay) return;
      if (
        e.key == "ArrowRight"
      ) {
        this.seek("forward")
      }
      else if (
        e.key == "ArrowLeft"

      ){
        this.seek("backward")
      }

    })

    this.player.addEventListener('loadstart' , ()=>{

    })

  }

  ngOnDestroy(): void {
    this.menuService.sendInstruction('show');
    this.navigationSub.unsubscribe();
    this.player.src = "";
  }

  timeDisplayString(duration){

    let hh = Math.floor(duration/3600);
    let min = Math.floor((duration - hh *3600)/60)
    let sec = Math.floor(duration - min * 60 - hh* 3600);

    let minDisp =  min < 10? "0" + String(min) : String(min);
    let secDisp = sec < 10 ? "0" + String(sec) : String(sec);


    return minDisp+":"+secDisp;

  }

  seek(direction){
    if (direction == 'forward') this.player.currentTime += 5;
    else if(direction == 'backward') this.player.currentTime -= 5;
    else return;


    let currentDisp = document.querySelector('.currentTime') as HTMLElement;
    let slider = document.querySelector('.current') as HTMLElement;
    let duration = this.player.duration;

    currentDisp.textContent = this.timeDisplayString(this.player.currentTime)
    slider.style.width = Math.floor(this.player.currentTime *100 /duration)+"%"
  }

  navigationHandler(){
    this.navigationSub = this.navigation.executeCommand().subscribe(instruction =>{
      if(!this.router.url.includes('/ytplayer')) return;
      console.log('instruction');

      switch (instruction) {
        case 'back':
            this.location.back();
          break;
        case 'click':
          if (this.canplay) {
            if (!this.playerPaused) {
              this.player.pause();
              this.animateIndicator('.isPausingIndicator img')
              this.playerPaused = true;
            }else {
              this.player.play();
              this.animateIndicator('.isPlayingIndicator img')
              this.playerPaused = false;

            }
          }
          break;
        default:
          break;
      }

    })
  }

  animateIndicator(indicatorCssClass){
      let indicatorTl = gsap.timeline();
      let indicator = document.querySelector(indicatorCssClass);
      indicatorTl.to(indicatorCssClass , {opacity : 1 , duration: .1})
      indicatorTl.to(indicatorCssClass , {width : 150 , duration: .14 , delay : -.05})
      indicatorTl.to(indicatorCssClass , {width : 140 , opacity : 0 , duration: .2 , onComplete : ()=>{
        gsap.set(indicator, { clearProps: true });
      }})


  }



}
