import { NotificationService } from './../notification.service';
import { Location } from '@angular/common';
import { Subtitle, SubtitleProvider, SubtitlesService } from './../subtitles.service';
import { PlaybackRequest, PlaybackService } from './../playback.service';
import { NavigationService } from './../navigation.service';
import { TorrentService } from './../torrent.service';
import { MenuServiceService } from './../menu-service.service';
import { Component, OnInit, OnDestroy } from '@angular/core';
import {  repeat, switchMap , takeWhile } from "rxjs/operators";
import { gsap } from 'gsap'
import { Subscription } from 'rxjs';
import { Router } from '@angular/router';
import { STREAMING_SERVER } from '../server-config';


@Component({
  selector: 'app-player-page',
  templateUrl: './player-page.component.html',
  styleUrls: ['./player-page.component.scss']
})
export class PlayerPageComponent implements OnInit ,OnDestroy{

  magnetUrl;
  torrentHash;
  playback:PlaybackRequest;
  playerReady = false;
  controlsVisible = false;
  sidePannelVisible = false;
  moviePlayer:HTMLVideoElement;
  link:string;
  runtime;
  year;
  playerSub:Subscription;
  controlsSub:Subscription;
  controlsEvent;
  lastSubFocused;
  arrowKeyEvents;
  subFocusListener;
  serverUrl = STREAMING_SERVER
  subtitles:Subtitle[];
  subtitleProviders:SubtitleProvider[] = [];
  subtitleProvider:string;
  subtitlesError:string;
  audioWarning = false;
  audioCheckDone = false;

  constructor(
    private playbackService:PlaybackService,
    private menuService:MenuServiceService,
    private torrentService:TorrentService,
    private navigation:NavigationService,
    private router:Router,
    private subtitlesService:SubtitlesService,
    private location:Location,
    private notificationService:NotificationService
  ) { }

  ngOnInit(): void {
    this.menuService.sendInstruction('hide' , this);
    document.querySelector('.playerPageContainer .loading').classList.remove('hidden');

    this.playback = this.playbackService.current;
    if (!this.playback) {
      this.location.back();
      return;
    }

    this.runtime = this.timeObject((this.playback.runtimeMinutes || 0)*60);

    let escClicked = false;

    //Moving through time on arrow presses

    this.controlsEvent = (e)=>{
      if(this.router.url != "/player") return;

      if (
        e.key == "ArrowRight" &&
        document.activeElement.classList.contains('progress') &&
        this.controlsVisible &&
        this.playerReady
      ) {
        this.seek("forward")
      }
      else if (
        e.key == "ArrowLeft" &&
        document.activeElement.classList.contains('progress') &&
        this.controlsVisible &&
        this.playerReady

      ){
        this.seek("backward")
      }

      // Leaving before playback starts: same cleanup as a normal exit
      if(e.key == "Escape" && !this.playerReady && !escClicked){
        escClicked = true;
        this.leavePlayer();
      }

    }
    document.addEventListener('keydown' , this.controlsEvent);

    this.subFocusListener = (e)=>{

      if(e.target['classList'].contains('subtitle')){
        let active = document.activeElement as HTMLElement;
        this.lastSubFocused = active.dataset['index'];
      }

    }
    window.addEventListener('sn:focused', this.subFocusListener);

    this.year = this.playback.year;
    this.magnetUrl = this.playback.magnet;
    let reps = 0;
    this.playerSub = this.torrentService.registerTorrent(this.magnetUrl)
    .pipe(
      switchMap(data => {
        this.torrentHash = data['infoHash'];
        return this.torrentService.getTorrent(data['infoHash']);
      }),
      repeat({delay : 4000})
    )
    .subscribe(data => {
      reps += 1;
      console.log(reps);

      if (data['files']) {
        this.playerSub.unsubscribe();
        let file = this.playback.season
          ? this.pickEpisodeFile(data['files'] , this.playback.season , this.playback.episode)
          : this.pickVideoFile(data['files']);
        if (!file) {
          this.leavePlayer();
          let what = this.playback.season ? `${this.playback.subtitle?.split(' ')[0]} in this torrent` : "in this torrent";
          this.notificationService.sendNotification("error" , `No playable video file found ${what}`);
          return;
        }
        this.link = this.serverUrl + file['link'];
        console.log(this.link);
        this.setupPlayer();
        return;
      }


      if (reps > 4) {
        this.playerSub.unsubscribe();
        this.leavePlayer();
        this.notificationService.sendNotification("error" , "Couldn't fetch the torrent's metadata (no peers?). Try again later");
      }
    })



  }

  ngOnDestroy(): void {

    this.menuService.sendInstruction('show' , this);
    this.controlsVisible = false;
    if (this.controlsSub) this.controlsSub.unsubscribe();

    if (this.playerSub) this.playerSub.unsubscribe();

    if (this.moviePlayer) this.moviePlayer.src = "";
    if (this.controlsEvent) document.removeEventListener('keydown' , this.controlsEvent);
    this.navigation.updateNavigation('remove' , {sectionId : 'timeSlider'})
    this.navigation.updateNavigation('remove' , {sectionId : 'optionPannel'})
    this.navigation.updateNavigation('remove' , {sectionId : 'subs'})
    if (this.arrowKeyEvents) document.removeEventListener('keydown' , this.arrowKeyEvents);
    window.removeEventListener('sn:focused', this.subFocusListener);

  }

  // Largest file with a container Chromium can play; mp4 wins over mkv/webm
  pickVideoFile(files) {
    let preference = ["mp4", "m4v", "mkv", "webm"];
    let candidates = files.filter(f => preference.includes(this.getExtension(f['name']).toLowerCase()));
    candidates.sort((a, b) =>
      preference.indexOf(this.getExtension(a['name']).toLowerCase()) - preference.indexOf(this.getExtension(b['name']).toLowerCase()) ||
      b['length'] - a['length']
    );
    return candidates[0];
  }

  // Season packs hold every episode: take the file named for this one
  // ("S02E05", "s2e5", "2x05"); a single-episode torrent just uses its video file
  pickEpisodeFile(files , season , episode) {
    let videos = files.filter(f => this.pickVideoFile([f]));
    let pattern = new RegExp(`(s0*${season}[ ._-]*e0*${episode}|\\b0*${season}x0*${episode})(?!\\d)` , 'i');
    let matching = videos.filter(f => pattern.test(f['path'] || f['name']));
    if (matching.length) return this.pickVideoFile(matching);
    return videos.length == 1 ? videos[0] : undefined;
  }

  // Chromium can't decode Dolby (AC-3/E-AC-3) or DTS audio: the video plays
  // silently. Say so once, a few seconds in, instead of leaving the user guessing.
  checkAudio() {
    let player = this.moviePlayer as any;
    if (this.audioCheckDone || this.moviePlayer.currentTime < 5) return;
    this.audioCheckDone = true;
    if (player.webkitVideoDecodedByteCount > 0 && player.webkitAudioDecodedByteCount === 0) {
      this.audioWarning = true;
      setTimeout(() => this.audioWarning = false, 10000);
    }
  }

  // Back to where the user came from, dropping the torrent and its data
  leavePlayer() {
    if (this.torrentHash) {
      let removeSub = this.torrentService.removeTorrent(this.torrentHash).subscribe(()=>{
        removeSub.unsubscribe();
      })
    }
    this.location.back();
  }

  getExtension(filename) {
    var parts = filename.split('.');
    return parts[parts.length - 1];
  }

  setupPlayer(){
    this.moviePlayer = document.querySelector('.moviePlayer');
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


          if (document.activeElement.classList.contains('ccBtn')) {
            this.showSidePanel();
            this.fetchSubs();
          }

          if (document.activeElement.classList.contains('providerTab')) {
            this.switchSubtitleProvider((document.activeElement as HTMLElement).dataset['provider']);
          }

          if (document.activeElement.classList.contains('subtitle')) {
            let active = document.activeElement as HTMLElement;
            this.showSubtitle(this.subtitles[Number(active.dataset['index'])]);

            document.querySelectorAll('.sidePannel .subtitle').forEach(subtitle => {
              subtitle.classList.remove('selected')
            });
            active.classList.add('selected');
          }
        }

      }

      if (instruction == "back" && this.playerReady) {
        console.log('back');
        console.log(this.sidePannelVisible);
        if (!this.sidePannelVisible && !this.controlsVisible) {
          this.leavePlayer();
        }else {
          if(this.sidePannelVisible) this.hideSidePannel();
          else if(this.controlsVisible) this.hideControls();
        }
      }
    })


    this.arrowKeyEvents = (e)=>{
      if(this.router.url != "/player") return;

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


    }
    document.addEventListener('keydown' , this.arrowKeyEvents);



    this.moviePlayer.src = this.link;
    this.setupTimeSlider()
    this.moviePlayer.play();
    // e.g. HEVC/x265 or AVI that Chromium can't decode
    this.moviePlayer.addEventListener('error', () => {
      if (this.router.url != "/player" || !this.moviePlayer.getAttribute('src')) return;
      this.leavePlayer();
      this.notificationService.sendNotification("error" , "This video's format can't be played. Try another release");
    });
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
    document.querySelector('.playBtn img')['src'] = "assets/icons/pause.svg";
    document.querySelector('.playBtn img')['style']['transform'] = "translateX(1px)"
  }

  resumePlayer(){
    this.moviePlayer.play();

    document.querySelector('.playBtn img')['src'] = "assets/icons/playSharp.svg";
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

      sidePannel['style']['display'] = "none";
    }})

    this.sidePannelVisible = false;
    let subBtn = document.querySelector('.ccBtn') as HTMLElement;
    subBtn.focus({preventScroll : true});
    this.navigation.updateNavigation('remove',{sectionId : 'subs'})

  }

  showSidePanel(){

    let sidePannel = document.querySelector('.playerPageContainer .sidePannel') as HTMLElement;

    let sideTl = gsap.timeline();

    sidePannel['style']['display'] = "block";
    sidePannel['style']['transform'] = 'translate(0% , 0%)';

    sideTl.to('.playerPageContainer .sidePannel' , {opacity : 1 , duration : .2 })
    sideTl.to('.playerPageContainer .sidePannel' , {x:0 , duration : .2 ,delay : -.15})


    this.sidePannelVisible = true;

    this.navigation.updateNavigation('add' , {
      id: 'subs',
      selector: '.playerPageContainer .sidePannel .controlsElem',
      straightOnly: true,
    })
  }

  setupTimeSlider(){


    let durationDisp = document.querySelector('.duration') as HTMLElement;
    let currentDisp = document.querySelector('.currentTime') as HTMLElement;
    let slider = document.querySelector('.progress') as HTMLElement;



    this.moviePlayer.onloadedmetadata = () => {

      let duration = this.moviePlayer.duration;
      durationDisp.innerHTML = this.timeDisplayString(duration)

      this.moviePlayer.addEventListener('timeupdate' , ()=>{
        this.checkAudio();
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


  fetchSubs(){
    if (this.subtitleProviders.length) {
      this.focusSubtitles();
      return;
    }

    this.subtitlesService.getProviders().subscribe(providers => {
      let kind = this.playback.season ? 'episode' : 'movie';
      this.subtitleProviders = providers.filter(p => p.enabled && p.supports[kind]);
      let preferred = this.subtitleProviders.find(p => p.id == this.subtitlesService.preferredProvider);
      this.loadSubtitles((preferred || this.subtitleProviders[0])?.id);
    } , () => {
      this.subtitles = [];
      this.subtitlesError = "Subtitle service unavailable";
    })
  }

  switchSubtitleProvider(id:string){
    if (!id || id == this.subtitleProvider) return;
    this.subtitlesService.preferredProvider = id;
    this.loadSubtitles(id);
  }

  loadSubtitles(provider:string){
    this.subtitleProvider = provider;
    this.subtitles = undefined;
    this.subtitlesError = undefined;
    this.lastSubFocused = undefined;

    if (!provider || !this.playback.imdbId) {
      this.subtitles = [];
      this.subtitlesError = provider ? "No IMDb id for this title" : "No subtitle provider available";
      return;
    }

    let query = { imdbId: this.playback.imdbId, season: this.playback.season, episode: this.playback.episode };
    this.subtitlesService.search(provider , query).subscribe(result => {
      if (provider != this.subtitleProvider) return;
      this.subtitles = result.subtitles;
      this.focusSubtitles();
    } , () => {
      if (provider != this.subtitleProvider) return;
      this.subtitles = [];
      this.subtitlesError = "This provider is unavailable right now";
    })
  }

  // Focus the last chosen subtitle, else the first one, else the provider tab
  focusSubtitles(){
    setTimeout(()=>{
      let target =
        document.querySelector(`.sidePannel .subtitle[data-index="${this.lastSubFocused}"]`) ||
        document.querySelector('.sidePannel .subtitle') ||
        document.querySelector('.sidePannel .providerTab.selected');
      (target as HTMLElement)?.focus({preventScroll : true});
    } , 100)
  }

  showSubtitle(subtitle:Subtitle){
    if (!subtitle) return;
    this.moviePlayer.querySelectorAll('track').forEach(track => track.remove());
    let track = document.createElement('track');
    track.kind = 'subtitles';
    track.srclang = subtitle.language;
    track.label = subtitle.languageName;
    track.src = this.subtitlesService.fileUrl(subtitle);
    track.default = true;
    this.moviePlayer.appendChild(track);
    track.addEventListener('load', () => track.track.mode = 'showing');
  }

}
