import { Component, OnInit, OnDestroy, AfterViewInit } from '@angular/core';
import { gsap } from 'gsap'
import { ServerService } from '../server.service';
import { actionForKey } from '../keymap';
import { useScreen } from '../nav/public-api';
import { dp } from '../ui/public-api';

// Trailer player (core.trailer, params { id }: the YouTube video id). Enter
// pauses / plays, ←/→ seek 5 s; Back leaves (the nav system's pop)


@Component({
  selector: 'youtube',
  templateUrl: './youtube.component.html',
  styleUrls: ['./youtube.component.scss']
})
export class YoutubeComponent implements OnInit , OnDestroy,AfterViewInit {

  baseUrl = this.server.api + "/youtube/";
  video_id;
  player:HTMLVideoElement;
  audioTrack:HTMLVideoElement;
  canplay:boolean = false;
  playerPaused:boolean = false;
  keydownListener;
  private screen = useScreen<{ id:string }>();

  constructor(private server:ServerService) { }

  ngOnInit(): void {
    this.video_id = this.screen.params.id;
    this.screen.onSelect(() => this.togglePause());
  }

  ngAfterViewInit(): void {
    this.player = document.querySelector(".ytPlayer");
    this.audioTrack = document.querySelector(".audioTrack");



    this.player.src=this.baseUrl+this.video_id+"?type=video&quality=136";
    this.audioTrack.src = this.baseUrl+this.video_id+"?type=audio";

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

    this.player.addEventListener('timeupdate' , (e)=>{
      var currentTime = this.player.currentTime;
      this.audioTrack.currentTime = currentTime;

      this.audioTrack.play();
    })

    this.player.addEventListener('pause' , (e)=>{
      this.audioTrack.pause();
    })

    this.keydownListener = (e)=>{
      if(!this.screen.active || !this.canplay) return;
      if (
        actionForKey(e) == 'right'
      ) {
        this.seek("forward")
      }
      else if (
        actionForKey(e) == 'left'

      ){
        this.seek("backward")
      }

    }
    document.addEventListener('keydown' , this.keydownListener);

    this.player.addEventListener('loadstart' , ()=>{

    })

  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown' , this.keydownListener);
    this.player.src = "";
    this.audioTrack.src = "";
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

  togglePause(){
    if (!this.canplay) return;
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

  animateIndicator(indicatorCssClass){
      let indicatorTl = gsap.timeline();
      let indicator = document.querySelector(indicatorCssClass);
      indicatorTl.to(indicatorCssClass , {opacity : 1 , duration: .1})
      indicatorTl.to(indicatorCssClass , {width : dp(150) , duration: .14 , delay : -.05})
      indicatorTl.to(indicatorCssClass , {width : dp(140) , opacity : 0 , duration: .2 , onComplete : ()=>{
        gsap.set(indicator, { clearProps: true });
      }})


  }



}
