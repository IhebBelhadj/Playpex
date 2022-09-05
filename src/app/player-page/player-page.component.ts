import { Location } from '@angular/common';
import { SubtitlesService } from './../subtitles.service';
import { NavigationService } from './../navigation.service';
import { TorrentService } from './../torrent.service';
import { MenuServiceService } from './../menu-service.service';
import { MoviesService } from './../movies.service';
import { Component, OnInit, OnDestroy } from '@angular/core';
import {  repeat, switchMap , takeWhile } from "rxjs/operators";
import { gsap } from 'gsap'
import { Subscription } from 'rxjs';
import { Router } from '@angular/router';


@Component({
  selector: 'app-player-page',
  templateUrl: './player-page.component.html',
  styleUrls: ['./player-page.component.scss']
})
export class PlayerPageComponent implements OnInit ,OnDestroy{

  magnetUrl;
  movie;
  playerReady = false;
  controlsVisible = false;
  sidePannelVisible = false;
  moviePlayer:HTMLVideoElement;
  link:string;
  runtime;
  year;
  playerSub:Subscription;
  controlsSub:Subscription;
  serverUrl = "http://localhost:9000"
  trackers = [
    "udp://glotorrents.pw:6969/announce",
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://torrent.gresille.org:80/announce",
    "udp://tracker.openbittorrent.com:80",
    "udp://tracker.coppersurfer.tk:6969",
  ]
  subtitles = {
    "en" : [],
    "fr" : [],
    "ar" : [],
    "it" : [],
    "de" : [],
    "es" : [],
  }

  constructor(
    private movieService:MoviesService,
    private menuService:MenuServiceService,
    private torrentService:TorrentService,
    private navigation:NavigationService,
    private router:Router,
    private subtitlesService:SubtitlesService,
    private location:Location,
  ) { }

  ngOnInit(): void {
    this.menuService.sendInstruction('hide');
    document.querySelector('.playerPageContainer .loading').classList.remove('hidden');

    this.movie = this.movieService.selectedmovie.value;

    this.runtime = this.timeObject(this.movie['runtime']*60);

    //Moving through time on arrow presses

    document.addEventListener('keydown' , (e)=>{
      if (
        e.key == "ArrowRight" &&
        document.activeElement.classList.contains('progress') &&
        this.controlsVisible &&
        this.playerReady &&
        this.router.url == "/player"
      ) {
        this.seek("forward")
      }
      else if (
        e.key == "ArrowLeft" &&
        document.activeElement.classList.contains('progress') &&
        this.controlsVisible &&
        this.playerReady &&
        this.router.url == "/player"

      ){
        this.seek("backward")
      }

    })


    this.year = this.movie.release_date.slice(0,4)

    // get the magnet link
    this.magnetUrl = this.buildMagnet()

    this.playerSub = this.torrentService.registerTorrent(this.magnetUrl)
    .pipe(
      switchMap(data => this.torrentService.getTorrent(data['infoHash'] )),
      repeat({delay : 2000})
    )
    .subscribe(data => {

      if (data['files']) {
        this.playerSub.unsubscribe();
        data['files'].forEach(file => {
          console.log();
          switch (this.getExtension(file['name'])) {
            case "mp4" || "mkv" || "avi":
                this.link = this.serverUrl + file['link']
                this.setupPlayer();
                console.log(this.link);

              break;

            default:
              break;
          }
        });
      }

    })

  }

  ngOnDestroy(): void {

    this.menuService.sendInstruction('show');
    this.controlsVisible = false;
    this.controlsSub.unsubscribe();
    if (this.playerSub) this.playerSub.unsubscribe();

    this.moviePlayer.src = "";

    this.navigation.updateNavigation('remove' , {sectionId : 'timeSlider'})
    this.navigation.updateNavigation('remove' , {sectionId : 'optionPannel'})

  }

  buildMagnet(){

    let torrentHash = this.movie['torrents'][0].hash;
    let torrentName = this.movie['original_title'] + this.movie['torrents'][0].quality;
    let urlEncodedName = encodeURIComponent(torrentName)
    let magnetUrl = `magnet:?xt=urn:btih:${torrentHash}&dn=${urlEncodedName}`
    this.trackers.forEach(tracker=>{
      magnetUrl = magnetUrl.concat("&tr="+tracker);
    })

    return magnetUrl;
  }

  getExtension(filename) {
    var parts = filename.split('.');
    return parts[parts.length - 1];
  }

  setupPlayer(){

    this.setupNavigation();
    this.controlsSub = this.navigation.executeCommand().subscribe(instruction=>{

      if (instruction == "click" && this.router.url == "/player" ) {

        if (!this.controlsVisible) {
          this.showControls();
        }
        else {
          if (
            !document.activeElement.classList.contains('controlsElem') ||
            document.activeElement.classList.contains('playBtn') ||
            document.activeElement.classList.contains('progress')
          ) {
            if (this.moviePlayer.paused) {
              this.resumePlayer()

            }
            else {
              this.pausePlayer()
            }
          }

        }

      }

      if (instruction == "back") {
        console.log('back');

        if (!this.sidePannelVisible) {
          this.location.back();
        }
      }
    })


    document.addEventListener('keydown' , (e)=>{

      if (e.key == "ArrowDown" && !this.controlsVisible) {
        this.showControls();
        /*let timeSlider = document.querySelector('.progress') as HTMLElement
        setTimeout(()=>{
          timeSlider.focus({preventScroll : true})
        } , 10)*/
      }

      if (e.key == "ArrowUp" && this.controlsVisible && document.activeElement.classList.contains('progress')) {

        this.hideControls();
      }
    })


    this.moviePlayer = document.querySelector('.moviePlayer');
    this.moviePlayer.src = this.link;
    this.setupTimeSlider()
    this.moviePlayer.play();
    this.moviePlayer.addEventListener('canplay', () => {
      setTimeout(()=>{
        this.playerReady = true;
        document.querySelector('.playerPageContainer .loading').classList.add('hidden');
      } , 1500)
    });



  }

  setupNavigation(){

    this.navigation.updateNavigation('add' , {
      id: 'timeSlider',
      selector: '.playerPageContainer .timeSlider .progress',
      straightOnly: true,
    })

    this.navigation.updateNavigation('add' , {
      id: 'optionPannel',
      selector: '.playerPageContainer .options .optBtn',

      straightOnly: true,
    })


  }

  showControls(){

    let controlPannel = document.querySelector('.playerPageContainer .controls') as HTMLElement;

    if(!this.controlsVisible){
      let contolsTl = gsap.timeline();

      controlPannel['style']['display'] = "block";

      this.navigation.updateNavigation('makeFocusable',{});

      controlPannel.classList.add("expended")
      contolsTl.to('.playerPageContainer .controls' , {opacity : 1 , duration : .2 })
      contolsTl.to('.playerPageContainer .controls' , {y:0 , duration : .2 ,delay : -.15})

      this.controlsVisible = true;

      }

  }


  pausePlayer(){
    this.moviePlayer.pause();
    document.querySelector('.playBtn img')['src'] = "../../assets/icons/pause.svg";
    document.querySelector('.playBtn img')['style']['transform'] = "translateX(1px)"
  }

  resumePlayer(){
    this.moviePlayer.play();

    document.querySelector('.playBtn img')['src'] = "../../assets/icons/playSharp.svg";
    document.querySelector('.playBtn img')['style']['transform'] = "translateX(3px)"
  }

  hideControls(){
    let controlPannel = document.querySelector('.playerPageContainer .controls') as HTMLElement;

    if(this.controlsVisible){
      this.controlsVisible = false;

      let contolsTl = gsap.timeline();
      contolsTl.to('.playerPageContainer .controls' , {y: 200 , duration : .2 })
      contolsTl.to('.playerPageContainer .controls' , {opacity : 0, duration : .2 , delay : -.15 , onComplete(){

        controlPannel['style']['display'] = "none";
      }})
    }

  }

  hideSidePannel(){
    let sidePannel = document.querySelector('.playerPageContainer .sidePannel') as HTMLElement;

    let sideTl = gsap.timeline();
    sideTl.to('.playerPageContainer .sidePannel' , {x: -200 , duration : .2 })
    sideTl.to('.playerPageContainer .sidePannel' , {opacity : 0, duration : .2 , delay : -.15 , onComplete(){
      this.sidePannelVisible = false;
      sidePannel['style']['display'] = "none";
    }})
  }

  showSidePaneel(){

    let sidePannel = document.querySelector('.playerPageContainer .controls') as HTMLElement;

    let sideTl = gsap.timeline();

    sidePannel['style']['display'] = "block";

    sideTl.to('.playerPageContainer .controls' , {opacity : 1 , duration : .2 })
    sideTl.to('.playerPageContainer .controls' , {x:0 , duration : .2 ,delay : -.15})

    this.sidePannelVisible = true;
  }

  setupTimeSlider(){


    let durationDisp = document.querySelector('.duration') as HTMLElement;
    let currentDisp = document.querySelector('.currentTime') as HTMLElement;
    let slider = document.querySelector('.progress') as HTMLElement;



    this.moviePlayer.onloadedmetadata = () => {

      let duration = this.moviePlayer.duration;
      durationDisp.innerHTML = this.timeDisplayString(duration)

      this.moviePlayer.addEventListener('timeupdate' , ()=>{
        //update Time Slider here
        currentDisp.textContent = this.timeDisplayString(this.moviePlayer.currentTime)
        slider.style.width = Math.floor(this.moviePlayer.currentTime *100 /duration)+"%"

      })

    };


  }

  seek(direction){
    if (direction == 'forward') this.moviePlayer.currentTime += 30;
    else if(direction == 'backward') this.moviePlayer.currentTime -= 30;
    else return;


    let currentDisp = document.querySelector('.currentTime') as HTMLElement;
    let slider = document.querySelector('.progress') as HTMLElement;
    let duration = this.moviePlayer.duration;

    currentDisp.textContent = this.timeDisplayString(this.moviePlayer.currentTime)
    slider.style.width = Math.floor(this.moviePlayer.currentTime *100 /duration)+"%"
  }



  //Time in seconds to display string
  timeDisplayString(duration){

    let hh = Math.floor(duration/3600);
    let min = Math.floor((duration - hh *3600)/60)
    let sec = Math.floor(duration - min * 60 - hh* 3600);

    let minDisp =  min < 10? "0" + String(min) : String(min);
    let secDisp = sec < 10 ? "0" + String(sec) : String(sec);


    return hh+":"+minDisp+":"+secDisp;

  }

  timeObject(duration){
    let hh = Math.floor(duration/3600);
    let min = Math.floor((duration - hh *3600)/60)
    let sec = Math.floor(duration - min * 60 - hh* 3600);

    let minDisp =  min < 10? "0" + String(min) : String(min);
    let secDisp = sec < 10 ? "0" + String(sec) : String(sec);

    return {
      hh : hh,
      min : minDisp,
      sec : secDisp
    }
  }


}
