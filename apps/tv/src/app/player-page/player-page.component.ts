import { NotificationService } from './../notification.service';
import { Subtitle, SubtitleProvider, SubtitlesService } from './../subtitles.service';
import { PlaybackRequest } from './../playback.service';
import { NavigationService } from './../navigation.service';
import { TorrentService } from './../torrent.service';
import { Component, OnInit, OnDestroy } from '@angular/core';
import {  repeat, switchMap , takeWhile, filter, catchError } from "rxjs/operators";
import { gsap } from 'gsap'
import { EMPTY, Subscription, timer } from 'rxjs';
import { ServerService } from '../server.service';
import { actionForKey } from '../keymap';
import { EpisodeKey, LibraryService } from '../library.service';
import { PointerService } from '../pointer.service';
import { ProfilesService } from '../profiles.service';
import { Navigator, useScreen } from '../nav/public-api';
import { dp } from '../ui/public-api';

const SAVE_EVERY_MS = 15000;
// Keeps this device's lease on the torrent while the player is open (the
// server drops leases idle for 10 min; a paused video makes no requests)
const KEEPALIVE_EVERY_MS = 60000;
// Mouse: the controls and the cursor hide after this long without movement
const POINTER_IDLE_MS = 3000;

// The player (core.player, src/app/nav): plays its entry's payload, a
// PlaybackRequest (PlaybackService.play). However it's left (Back, the Back
// button, an error, "Choose server" when the connection is lost), the
// torrent's lease is released (the screen's beforeLeave).

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
  link:string;                // the file's stream path (TorrentFile.link); URLs: server.media()
  runtime;
  year;
  playerSub:Subscription;
  controlsEvent;
  lastSubFocused;
  arrowKeyEvents;
  subFocusListener;
  subtitles:Subtitle[];
  subtitleProviders:SubtitleProvider[] = [];
  subtitleProvider:string;
  subtitlesError:string;
  audioWarning = false;
  audioCheckDone = false;
  buffering = false;          // playback stalled waiting for data
  stats;                      // latest swarm stats while loading / buffering / stats panel open
  statsVisible = false;
  videoInfo;                  // <video>-side numbers for the stats panel
  statsSub:Subscription;

  // Resume point and progress saving for the current profile
  filePath:string;
  // Audio Chromium can't decode (Dolby/DTS): the server re-encodes it
  // (/transcode). That stream restarts at `offset` on seeks, so <video> times
  // are relative to it; position() / mediaDuration() give the real ones.
  transcoding = false;
  offset = 0;
  knownDuration = 0;
  cueShift = 0;
  pendingSeek:number | null = null;   // transcoded seek waiting for its stream
  seekTimer:any;               // seconds already taken off the subtitle cues
  resumeAt:number | null = null;
  resumeDecided = false;      // the saved state arrived (or there is none to ask for)
  resumeApplied = false;
  resumeNotice = '';
  lastSave = 0;
  stateSub:Subscription;

  pointerSub:Subscription;
  pointerIdle;
  keepaliveTimer;
  private screen = useScreen<{}, PlaybackRequest>();

  constructor(
    private server:ServerService,
    private torrentService:TorrentService,
    private navigation:NavigationService,
    private navigator:Navigator,
    private pointer:PointerService,
    private subtitlesService:SubtitlesService,
    private notificationService:NotificationService,
    private library:LibraryService,
    private profiles:ProfilesService,
  ) { }

  ngOnInit(): void {
    document.querySelector('.playerPageContainer .loading').classList.remove('hidden');

    this.playback = this.screen.payload;
    if (!this.playback) {
      this.navigator.back();
      return;
    }

    // every way out: release this device's lease on the torrent
    this.screen.beforeLeave(() => this.releaseTorrent());
    this.screen.onSelect(() => this.select());
    this.screen.onBack(() => this.back());

    this.runtime = this.timeObject((this.playback.runtimeMinutes || 0)*60);

    if (this.playback.startAt !== undefined) {
      // chosen on the detail page: resume at this point, or 0 = from the beginning
      this.resumeAt = this.playback.startAt || null;
      this.resumeDecided = true;
    }
    else if (this.playback.tmdbId && !this.playback.adult) {
      this.stateSub = this.library.state(this.libraryKey()).subscribe({
        next: state => {
          this.resumeAt = state.resume ? state.resume.positionS : null;
          this.resumeDecided = true;
          this.applyResume();
        },
        error: () => this.resumeDecided = true,
      });
    }

    //Moving through time on arrow presses

    this.controlsEvent = (e)=>{
      if(!this.screen.active) return;

      if (
        actionForKey(e) == 'right' &&
        document.activeElement.classList.contains('progress') &&
        this.controlsVisible &&
        this.playerReady
      ) {
        this.seek("forward")
      }
      else if (
        actionForKey(e) == 'left' &&
        document.activeElement.classList.contains('progress') &&
        this.controlsVisible &&
        this.playerReady

      ){
        this.seek("backward")
      }

    }
    document.addEventListener('keydown' , this.controlsEvent);

    this.subFocusListener = (e)=>{

      if(e.target['classList'].contains('subtitle')){
        let active = document.activeElement as HTMLElement;
        this.lastSubFocused = active.dataset['index'];
        this.scrollSubtitleIntoView(e.target as HTMLElement);
      }

    }
    window.addEventListener('sn:focused', this.subFocusListener);

    this.pollStats();
    this.updateClock();

    // Mouse: moving it shows the controls; the wheel scrolls panels natively
    this.pointer.wheelNavigation = false;
    this.pointerSub = this.pointer.moved.subscribe(() => this.onPointerMove());
    this.pointerIdle = setTimeout(() => this.onPointerIdle() , POINTER_IDLE_MS);

    this.year = this.playback.year;
    this.magnetUrl = this.playback.magnet;
    let reps = 0;
    this.playerSub = this.torrentService.registerTorrent(this.magnetUrl)
    .pipe(
      switchMap(data => {
        if (!this.torrentHash) this.startKeepalive(data['infoHash']);
        this.torrentHash = data['infoHash'];
        return this.torrentService.getTorrent(data['infoHash']);
      }),
      repeat({delay : 4000})
    )
    .subscribe({ error: e => {
      // e.g. 503 BUSY: the server already streams as many torrents as it allows
      this.leavePlayer();
      this.notificationService.sendNotification("error" , e?.error?.error || "Couldn't start this torrent. Check that the Playpex server is running.");
    }, next: data => {
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
        this.filePath = file['path'];
        this.link = file['link'];
        this.probeFile().then(() => this.setupPlayer());
        return;
      }


      if (reps > 4) {
        this.playerSub.unsubscribe();
        this.leavePlayer();
        this.notificationService.sendNotification("error" , "Couldn't fetch the torrent's metadata (no peers?). Try again later");
      }
    }})



  }

  ngOnDestroy(): void {

    // last position, while the <video> still has it
    this.saveProgress();
    clearTimeout(this.seekTimer);
    this.stateSub?.unsubscribe();

    this.controlsVisible = false;
    this.pointer.wheelNavigation = true;
    this.pointerSub?.unsubscribe();
    clearTimeout(this.pointerIdle);

    if (this.playerSub) this.playerSub.unsubscribe();
    if (this.statsSub) this.statsSub.unsubscribe();
    clearInterval(this.keepaliveTimer);
    gsap.killTweensOf('.clock');
    gsap.set('.clock' , { clearProps : 'opacity' });

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

  // Codecs first: unplayable audio switches to the transcoded stream. If the
  // probe fails (no ffprobe), play the file directly as before.
  probeFile():Promise<void> {
    let url = this.server.media(this.link.replace('/files/' , '/probe/'));
    return fetch(url).then(r => r.ok ? r.json() : null).then(info => {
      if (!info?.transcode) return;
      this.transcoding = true;
      this.knownDuration = info.duration || 0;
    }).catch(() => {});
  }

  streamUrl(start:number){
    return this.server.media(this.link.replace('/files/' , '/transcode/') , { t: start });
  }

  position(){
    if (this.pendingSeek !== null) return this.pendingSeek;
    return (this.transcoding ? this.offset : 0) + (this.moviePlayer?.currentTime || 0);
  }

  mediaDuration(){
    return this.transcoding ? this.knownDuration : this.moviePlayer?.duration;
  }

  // Subtitle cues are in file time; the transcoded stream starts at `offset`
  shiftCues(){
    let cues = this.moviePlayer?.textTracks[0]?.cues;
    let delta = this.offset - this.cueShift;
    this.cueShift = this.offset;
    if (!cues || !delta) return;
    for (let i = 0; i < cues.length; i++) {
      cues[i].startTime -= delta;
      cues[i].endTime -= delta;
    }
  }

  // Chromium can't decode Dolby (AC-3/E-AC-3) or DTS audio: the video plays
  // silently. Say so once, a few seconds in, instead of leaving the user guessing.
  checkAudio() {
    let player = this.moviePlayer as any;
    if (this.audioCheckDone || this.transcoding || this.moviePlayer.currentTime < 5) return;
    this.audioCheckDone = true;
    if (player.webkitVideoDecodedByteCount > 0 && player.webkitAudioDecodedByteCount === 0) {
      this.audioWarning = true;
      setTimeout(() => this.audioWarning = false, 10000);
    }
  }

  libraryKey():EpisodeKey {
    return {
      mediaType: this.playback.mediaType,
      tmdbId: this.playback.tmdbId,
      season: this.playback.season,
      episode: this.playback.episode,
    };
  }

  // Jump to the saved position once both the video and the saved state are there
  applyResume() {
    if (this.resumeApplied || !this.resumeAt || !this.moviePlayer || this.moviePlayer.readyState < 1) return;
    this.resumeApplied = true;
    let duration = this.mediaDuration();
    if (!isFinite(duration) || this.resumeAt > duration - 30) return;
    this.seekTo(this.resumeAt);
    this.resumeNotice = `Resuming from ${this.timeDisplayString(this.resumeAt)}`;
    setTimeout(() => this.resumeNotice = '', 5000);
  }

  saveProgress() {
    let player = this.moviePlayer;
    // 18+ titles stay out of the library (Continue watching, Watched)
    if (!this.playback?.tmdbId || this.playback.adult || !player || !this.playerReady || !this.resumeDecided) return;
    // don't overwrite the saved position with 0:00 before jumping to it
    if (this.resumeAt && !this.resumeApplied) return;
    let duration = this.mediaDuration();
    if (!isFinite(duration) || duration <= 0 || this.position() < 1) return;

    this.lastSave = Date.now();
    this.library.saveProgress(this.libraryKey(), {
      ...this.playback.artwork,
      positionS: this.position(),
      durationS: duration,
      infoHash: this.torrentHash,
      filePath: this.filePath,
    }).subscribe({ error: () => {} });
  }

  // Every minute until the player closes: keeps the server's lease, and tells
  // it what plays (its Activity view)
  startKeepalive(hash:string) {
    this.keepaliveTimer = setInterval(() => {
      let player = this.moviePlayer;
      let duration = this.playerReady ? this.mediaDuration() : NaN;
      let code = this.playback.season ? this.playback.subtitle?.split(' ')[0] : '';
      let state = {
        title: [this.playback.title, code].filter(Boolean).join(' · '),
        profileId: this.profiles.current.value?.id,
        file: this.filePath,
        ...(this.playerReady && player ? { positionS: this.position(), paused: player.paused } : {}),
        ...(isFinite(duration) && duration > 0 ? { durationS: duration } : {}),
      };
      this.torrentService.keepTorrent(hash , state).subscribe({ error: () => {} });
    } , KEEPALIVE_EVERY_MS);
  }

  // Back to where the user came from (the lease goes in beforeLeave)
  leavePlayer() {
    this.navigator.back();
  }

  // The server drops the torrent (and its data) once no other device holds it
  private releaseTorrent() {
    if (!this.torrentHash) return;
    let hash = this.torrentHash;
    this.torrentHash = undefined;
    clearInterval(this.keepaliveTimer);
    this.torrentService.removeTorrent(hash).subscribe({ error: () => {} });
  }

  getExtension(filename) {
    var parts = filename.split('.');
    return parts[parts.length - 1];
  }

  // Enter: shows the controls, then plays / pauses or acts on the focused control
  private select() {
    if (!this.moviePlayer) return;
    let active = document.activeElement as HTMLElement;
    if (!this.controlsVisible) {
      this.showControls();
      return;
    }
    if (!active.classList.contains('controlsElem') || active.classList.contains('playBtn') || active.classList.contains('progress')) {
      if (this.moviePlayer.paused) this.resumePlayer();
      else this.pausePlayer();
    }
    if (active.classList.contains('statsBtn')) this.statsVisible = !this.statsVisible;
    if (active.classList.contains('ccBtn')) {
      this.showSidePanel();
      this.fetchSubs();
    }
    if (active.classList.contains('providerTab')) this.switchSubtitleProvider(active.dataset['provider']);
    if (active.classList.contains('subtitle')) {
      this.showSubtitle(this.subtitles[Number(active.dataset['index'])]);
      document.querySelectorAll('.sidePannel .subtitle').forEach(subtitle => subtitle.classList.remove('selected'));
      active.classList.add('selected');
    }
  }

  // In-page steps once playing: subtitles panel → controls → stats panel;
  // then out (before playback is ready: out at once)
  private back():boolean {
    if (!this.playerReady) return false;
    if (this.sidePannelVisible) this.hideSidePannel();
    else if (this.controlsVisible) this.hideControls();
    else if (this.statsVisible) this.statsVisible = false;
    else return false;
    return true;
  }

  setupPlayer(){
    this.moviePlayer = document.querySelector('.moviePlayer');
    this.setupNavigation();
    this.arrowKeyEvents = (e)=>{
      if(!this.screen.active) return;

      if (actionForKey(e) == 'down' && !this.controlsVisible) {
        this.showControls();
        /*let timeSlider = document.querySelector('.progress') as HTMLElement
        setTimeout(()=>{
          timeSlider.focus({preventScroll : true})
        } , 10)*/
      }

      if (actionForKey(e) == 'up' && this.controlsVisible && document.activeElement.classList.contains('progress')) {

        this.hideControls();
      }


    }
    document.addEventListener('keydown' , this.arrowKeyEvents);



    this.moviePlayer.src = this.transcoding ? this.streamUrl(0) : this.server.media(this.link);
    this.setupTimeSlider()
    this.moviePlayer.play();
    // e.g. HEVC/x265 or AVI that Chromium can't decode
    this.moviePlayer.addEventListener('error', () => {
      if (!this.screen.active || !this.moviePlayer.getAttribute('src')) return;
      this.leavePlayer();
      this.notificationService.sendNotification("error" , "This video's format can't be played. Try another release");
    });
    this.moviePlayer.addEventListener('canplay', () => {
      this.applyResume();
      setTimeout(()=>{
        this.playerReady = true;
        document.querySelector('.playerPageContainer .loading').classList.add('hidden');
        this.updateClock();
      } , 1500)
    });

    // Stalls mid-playback: spinner + swarm stats until data flows again
    this.moviePlayer.addEventListener('waiting', () => {
      if (!this.playerReady) return;
      this.buffering = true;
      document.querySelector('.playerPageContainer .loading').classList.remove('hidden');
    });
    this.moviePlayer.addEventListener('playing', () => {
      if (!this.buffering) return;
      this.buffering = false;
      document.querySelector('.playerPageContainer .loading').classList.add('hidden');
    });

    this.moviePlayer.addEventListener('play', () => this.updateClock());
    this.moviePlayer.addEventListener('pause', () => this.updateClock());

    // Progress for Continue watching / history: periodically, on pause and at the end
    this.moviePlayer.addEventListener('timeupdate', () => {
      if (!this.moviePlayer.paused && Date.now() - this.lastSave > SAVE_EVERY_MS) this.saveProgress();
    });
    this.moviePlayer.addEventListener('pause', () => this.saveProgress());
    this.moviePlayer.addEventListener('ended', () => this.saveProgress());



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
      this.updateClock();

      }

  }


  pausePlayer(){
    this.moviePlayer.pause();
    document.querySelector('.playBtn img')['src'] = "assets/icons/pause.svg";
    document.querySelector('.playBtn img')['style']['transform'] = `translateX(${dp(1)})`
  }

  resumePlayer(){
    this.moviePlayer.play();

    document.querySelector('.playBtn img')['src'] = "assets/icons/playSharp.svg";
    document.querySelector('.playBtn img')['style']['transform'] = `translateX(${dp(3)})`
  }

  hideControls(){
    let controlPannel = document.querySelector('.playerPageContainer .controls') as HTMLElement;

    if(this.controlsVisible){
      this.controlsVisible = false;
      this.updateClock();

      let contolsTl = gsap.timeline();
      contolsTl.to('.playerPageContainer .controls' , {y: dp(200) , duration : .2 })
      contolsTl.to('.playerPageContainer .controls' , {opacity : 0, duration : .2 , delay : -.15 , onComplete(){

        controlPannel['style']['display'] = "none";
      }})
    }

  }

  hideSidePannel(){
    let sidePannel = document.querySelector('.playerPageContainer .sidePannel') as HTMLElement;

    let sideTl = gsap.timeline();
    sideTl.to('.playerPageContainer .sidePannel' , {x: dp(-200) , duration : .2 })
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

    // flex, like the stylesheet: the subtitle list fills the rest and scrolls
    sidePannel['style']['display'] = "flex";
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



    // fires again each time the transcoded stream restarts: listen once
    let listening = false;
    this.moviePlayer.onloadedmetadata = () => {

      durationDisp.innerHTML = this.timeDisplayString(this.mediaDuration())
      if (listening) return;
      listening = true;

      this.moviePlayer.addEventListener('timeupdate' , ()=>{
        this.checkAudio();
        //update Time Slider here
        currentDisp.textContent = this.timeDisplayString(this.position())
        slider.style.width = Math.floor(this.position() *100 /this.mediaDuration())+"%"
        this.updateBuffered();

      })
      this.moviePlayer.addEventListener('progress' , () => this.updateBuffered());

    };


  }

  seek(direction){
    if (direction == 'forward') this.seekTo(this.position() + 30);
    else if(direction == 'backward') this.seekTo(this.position() - 30);
  }

  seekTo(time:number){
    time = Math.max(0 , time);
    if (!this.transcoding) this.moviePlayer.currentTime = time;
    else {
      // restart the stream on the keyframe before `time` (where both its
      // video and audio begin). Finding it downloads that part of the torrent,
      // so hold the old stream meanwhile, and let quick presses add up into
      // one lookup.
      this.pendingSeek = time;
      this.moviePlayer.pause();
      if (this.playerReady) {
        this.buffering = true;
        document.querySelector('.playerPageContainer .loading')?.classList.remove('hidden');
      }
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => {
        let target = time;
        fetch(this.server.media(this.link.replace('/files/' , '/keyframe/') , { t: target }))
          .then(r => r.json()).catch(() => ({time: target}))
          .then(data => {
            if (this.pendingSeek !== target || !this.screen.active) return; // a newer seek won
            this.offset = data['time'];
            this.pendingSeek = null;
            this.moviePlayer.src = this.streamUrl(this.offset);
            this.moviePlayer.play();
            this.shiftCues();
          });
      } , 500);
    }


    let currentDisp = document.querySelector('.currentTime') as HTMLElement;
    let slider = document.querySelector('.progress') as HTMLElement;
    let duration = this.mediaDuration();

    currentDisp.textContent = this.timeDisplayString(time)
    slider.style.width = Math.floor(time *100 /duration)+"%"
    this.updateBuffered();
  }

  // ── mouse ─────────────────────────────────────────────────────────────────

  onPointerMove(){
    if (this.playerReady) this.showControls();
    clearTimeout(this.pointerIdle);
    this.pointerIdle = setTimeout(() => this.onPointerIdle() , POINTER_IDLE_MS);
  }

  // Still mouse: clear the picture, unless the user switched to the keys
  // (they hid the cursor already) or is resting on the controls
  onPointerIdle(){
    if (!this.pointer.visible) return;
    if (document.querySelector('.playerPageContainer :is(.controls, .sidePannel, .statsPanel):hover')) return;

    this.pointer.hide();
    if (this.playerReady && !this.sidePannelVisible && !this.moviePlayer.paused) this.hideControls();
  }

  onVideoClick(){
    if (!this.playerReady) return;
    if (this.moviePlayer.paused) this.resumePlayer();
    else this.pausePlayer();
  }

  // The timeline seeks where it's clicked (data-pointer="own": no select key)
  onTimelineClick(e:MouseEvent){
    let duration = this.mediaDuration();
    if (!this.playerReady || !isFinite(duration)) return;
    this.seekTo(this.timelineFraction(e) * duration);
  }

  onTimelineHover(e:MouseEvent){
    let label = document.querySelector('.playerPageContainer .hoverTime') as HTMLElement;
    let duration = this.mediaDuration();
    if (!label || !isFinite(duration)) return;
    let fraction = this.timelineFraction(e);
    label.style.left = (fraction * 100) + '%';
    label.textContent = this.timeDisplayString(fraction * duration);
  }

  timelineFraction(e:MouseEvent){
    let rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.min(1 , Math.max(0 , (e.clientX - rect.left) / rect.width));
  }

  // Light bar for the buffered range around the playhead (it starts behind the
  // playhead, so it shows how far ahead playback can go without waiting)
  updateBuffered(){
    let bar = document.querySelector('.playerPageContainer .buffered') as HTMLElement;
    let duration = this.mediaDuration();
    let offset = this.transcoding ? this.offset : 0;
    if (!bar || !duration) return;

    let ranges = this.moviePlayer.buffered;
    let current = this.moviePlayer.currentTime;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= current + 0.5 && ranges.end(i) >= current) {
        bar.style.left = ((ranges.start(i) + offset) * 100 / duration) + "%";
        bar.style.width = ((ranges.end(i) - ranges.start(i)) * 100 / duration) + "%";
        return;
      }
    }
    bar.style.width = "0%";
  }

  // Peers / speed / downloaded under the spinner, polled while it's shown
  pollStats(){
    this.statsSub = timer(0 , 1000).pipe(
      filter(() => !!this.torrentHash && (!this.playerReady || this.buffering || this.statsVisible)),
      switchMap(() => this.torrentService.getStats(this.torrentHash).pipe(catchError(() => EMPTY))),
    ).subscribe(stats => {
      this.stats = stats;
      if (this.statsVisible) this.videoInfo = this.readVideoInfo();
    });
  }

  readVideoInfo(){
    let player = this.moviePlayer;
    if (!player) return undefined;

    let ahead = 0;
    for (let i = 0; i < player.buffered.length; i++) {
      if (player.buffered.start(i) <= player.currentTime + 0.5 && player.buffered.end(i) >= player.currentTime) {
        ahead = player.buffered.end(i) - player.currentTime;
      }
    }
    let quality = player.getVideoPlaybackQuality?.();

    return {
      bufferedAhead : Math.round(ahead) + ' s',
      resolution : player.videoWidth ? player.videoWidth + '×' + player.videoHeight : '…',
      droppedFrames : quality ? quality.droppedVideoFrames + ' / ' + quality.totalVideoFrames : '…',
    };
  }

  formatBytes(bytes:number){
    if (!bytes) return '0 MB';
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    return (bytes / 1e6).toFixed(1) + ' MB';
  }

  // The clock (app shell) is only shown while not actually watching:
  // loading, controls open, or paused
  updateClock(){
    let watching = this.playerReady && !this.controlsVisible && this.moviePlayer && !this.moviePlayer.paused;
    gsap.to('.clock' , { opacity : watching ? 0 : 1 , duration : .3 });
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
      // reopening the panel: jump straight to it, no animation
      if (target) this.scrollSubtitleIntoView(target as HTMLElement , 'auto');
    } , 100)
  }

  // Keep the focused subtitle inside the (natively scrolling) list
  scrollSubtitleIntoView(node:HTMLElement , behavior:ScrollBehavior = 'smooth'){
    let list = node.closest('.sidePannel .content') as HTMLElement;
    if (!list) return;
    let listRect = list.getBoundingClientRect();
    let rect = node.getBoundingClientRect();
    let top = list.scrollTop;
    if (rect.top < listRect.top) top -= listRect.top - rect.top;
    else if (rect.bottom > listRect.bottom) top += rect.bottom - listRect.bottom;
    else return;
    list.scrollTo({ top , behavior });
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
    track.addEventListener('load', () => {
      track.track.mode = 'showing';
      this.cueShift = 0;
      this.shiftCues();
    });
  }

}
