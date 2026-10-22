import { NotificationService } from './../notification.service';
import { Subtitle, SubtitleProvider, SubtitlesService } from './../subtitles.service';
import { PlaybackRequest } from './../playback.service';
import { TorrentService } from './../torrent.service';
import { Component, OnInit, OnDestroy, ElementRef, NgZone } from '@angular/core';
import { repeat, switchMap, filter, catchError } from "rxjs/operators";
import { gsap } from 'gsap'
import { EMPTY, Subscription, timer } from 'rxjs';
import { ServerService } from '../server.service';
import { actionForKey } from '../keymap';
import { EpisodeKey, LibraryService } from '../library.service';
import { PointerService } from '../pointer.service';
import { ProfilesService } from '../profiles.service';
import { LayerStack, Navigator, useScreen } from '../nav/public-api';
import { FocusEngine } from '../movement/movement';
import { tmdbImageBase } from '../ui/public-api';
import { EpisodePlaybackService, NextEpisode } from '../episode-playback.service';
import { environment } from '../../environments/environment';

const SAVE_EVERY_MS = 15000;
// Keeps this device's lease on the torrent while the player is open (the
// server drops leases idle for 10 min; a paused video makes no requests)
const KEEPALIVE_EVERY_MS = 60000;
// Mouse: the controls and the cursor hide after this long without movement
const POINTER_IDLE_MS = 3000;
// Keys: the controls hide after this long without a key while playing
const CONTROLS_IDLE_MS = 6000;
// Scrubbing: the seek happens this long after the last arrow (one seek for a
// run of presses: each one restarts a transcoded stream)
const SCRUB_COMMIT_MS = 700;
// Up next shows this long before the end (episodes)
const UP_NEXT_S = 40;

// What a held arrow jumps by: 10 s, then 30 s, then a minute (presses in a row)
function scrubStep(presses:number):number {
  return presses <= 5 ? 10 : presses <= 15 ? 30 : 60;
}

export const SUBTITLE_SIZES = [
  { key: 'small', label: 'Small', token: '--px-text-heading' },
  { key: 'medium', label: 'Medium', token: '--px-text-headline' },
  { key: 'large', label: 'Large', token: '--px-text-title' },
  { key: 'largest', label: 'Largest', token: '--px-text-large' },
];
const SUBTITLE_SIZE_KEY = 'playpex.subtitleSize';

// The player (core.player, src/app/nav): plays its entry's payload, a
// PlaybackRequest (PlaybackService.play). However it's left (Back, the Back
// button, an error, "Choose server" when the connection is lost), the
// torrent's lease is released (the screen's beforeLeave).
//
// Input (movement system): the controls are pxSection "playerControls", a
// pxStack of the timeline (one item) and the buttons (a pxGrid). The player
// takes the arrows itself (a window capture listener, before the library)
// only where they mean time: Left / Right with the controls hidden or on the
// timeline scrub (held: faster), and any arrow with the controls hidden shows
// them. Subtitles are a px-panel layer docked at the right edge.
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
  moviePlayer:HTMLVideoElement;
  link:string;                // the file's stream path (TorrentFile.link); URLs: server.media()
  paused = false;
  playerSub:Subscription;
  audioWarning = false;
  audioCheckDone = false;
  buffering = false;          // playback stalled waiting for data
  stats;                      // latest swarm stats while loading / buffering / stats panel open
  statsVisible = false;
  videoInfo;                  // <video>-side numbers for the stats panel
  statsSub:Subscription;

  readonly stages = ['Starting the torrent', 'Finding peers', 'Reading the torrent', 'Downloading the start'];

  // timeline (fractions of the duration)
  playedPct = 0;
  loadedStart = 0;
  loadedEnd = 0;
  hoverAt:number | null = null;
  scrub:{ target:number, direction:number, presses:number } | null = null;
  private scrubTimer;

  // subtitles
  subtitlesOpen = false;
  subtitles:Subtitle[];
  subtitleProviders:SubtitleProvider[] = [];
  subtitleProvider:string;
  subtitlesError:string;
  selectedSubtitle:Subtitle | null = null;
  readonly subtitleSizes = SUBTITLE_SIZES;
  subtitleSize = 'medium';
  subtitleDelay = 0;          // seconds, positive = later
  private appliedCueShift = 0; // seconds taken off the cues' file times so far

  // up next (episodes)
  upNext:NextEpisode | null = null;
  upNextLooking = false;
  upNextDismissed = false;
  readonly stillBase = tmdbImageBase('still', 150);

  // Resume point and progress saving for the current profile
  filePath:string;
  // Audio Chromium can't decode (Dolby/DTS): the server re-encodes it
  // (/transcode). That stream restarts at `offset` on seeks, so <video> times
  // are relative to it; position() / mediaDuration() give the real ones.
  transcoding = false;
  offset = 0;
  knownDuration = 0;
  pendingSeek:number | null = null;   // transcoded seek waiting for its stream
  seekTimer:any;
  resumeAt:number | null = null;
  resumeDecided = false;      // the saved state arrived (or there is none to ask for)
  resumeApplied = false;
  resumeNotice = '';
  lastSave = 0;
  stateSub:Subscription;
  nextSub:Subscription;

  pointerSub:Subscription;
  pointerIdle;
  controlsIdle;
  keepaliveTimer;
  private screen = useScreen<{ session:string }, PlaybackRequest>();
  private keyDown = (e:KeyboardEvent) => this.onKeyDown(e);
  private keyUp = (e:KeyboardEvent) => this.onKeyUp(e);

  constructor(
    private host:ElementRef<HTMLElement>,
    private zone:NgZone,
    private server:ServerService,
    private torrentService:TorrentService,
    private navigator:Navigator,
    private layers:LayerStack,
    private engine:FocusEngine,
    private pointer:PointerService,
    private subtitlesService:SubtitlesService,
    private notificationService:NotificationService,
    private library:LibraryService,
    private profiles:ProfilesService,
    private episodes:EpisodePlaybackService,
  ) { }

  ngOnInit(): void {
    this.playback = this.screen.payload;
    if (!this.playback) {
      this.navigator.back();
      return;
    }

    // every way out: release this device's lease on the torrent
    this.screen.beforeLeave(() => this.releaseTorrent());
    this.screen.onSelect(() => this.select());
    this.screen.onBack(() => this.back());

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
    else this.resumeDecided = true;

    try { this.subtitleSize = localStorage.getItem(SUBTITLE_SIZE_KEY) || 'medium'; } catch (e) { }
    this.applySubtitleSize();

    // capture: before the spatial-navigation library moves the focus
    window.addEventListener('keydown', this.keyDown, true);
    window.addEventListener('keyup', this.keyUp, true);

    this.pollStats();
    this.updateClock();
    this.findNextEpisode();

    // Mouse: moving it shows the controls; the wheel scrolls panels natively
    this.pointer.wheelNavigation = false;
    this.pointerSub = this.pointer.moved.subscribe(() => this.onPointerMove());
    this.pointerIdle = setTimeout(() => this.onPointerIdle() , POINTER_IDLE_MS);

    // development: a video file, no torrent (window.playpexDev.player())
    if (this.playback.devSrc && !environment.production) {
      this.link = this.playback.devSrc;
      setTimeout(() => this.setupPlayer());
      return;
    }

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
    clearTimeout(this.scrubTimer);
    clearTimeout(this.controlsIdle);
    this.stateSub?.unsubscribe();
    this.nextSub?.unsubscribe();

    this.pointer.wheelNavigation = true;
    this.pointerSub?.unsubscribe();
    clearTimeout(this.pointerIdle);

    this.playerSub?.unsubscribe();
    this.statsSub?.unsubscribe();
    clearInterval(this.keepaliveTimer);
    gsap.killTweensOf('.clock');
    gsap.set('.clock' , { clearProps : 'opacity' });

    if (this.moviePlayer) this.moviePlayer.src = "";
    window.removeEventListener('keydown', this.keyDown, true);
    window.removeEventListener('keyup', this.keyUp, true);
  }

  // ── what's shown ──────────────────────────────────────────────────────────

  get duration():number {
    let d = this.mediaDuration();
    return isFinite(d) && d > 0 ? d : 0;
  }

  get remaining():number {
    return Math.max(0, this.duration - this.position());
  }

  get metaLine():string {
    if (this.playback?.subtitle) return this.playback.subtitle;
    let minutes = this.playback?.runtimeMinutes || 0;
    let length = minutes ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : '';
    return [this.playback?.year, length].filter(Boolean).join(', ');
  }

  // what the torrent is doing before the first frame (index into `stages`)
  get stage():number {
    if (!this.stats) return 0;
    if (!this.stats.peers?.total) return 1;
    if (!this.stats.metadata) return 2;
    return 3;
  }

  get endsAt():string {
    if (!this.duration || !this.playerReady) return '';
    let end = new Date(Date.now() + this.remaining * 1000 / (this.moviePlayer?.playbackRate || 1));
    return end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  get scrubPct():number {
    return this.scrub && this.duration ? this.scrub.target * 100 / this.duration : 0;
  }

  get scrubDelta():string {
    if (!this.scrub) return '';
    let delta = this.scrub.target - this.position();
    return (delta < 0 ? '−' : '+') + this.clock(Math.abs(delta));
  }

  get scrubHint():string {
    if (!this.scrub) return '';
    let step = scrubStep(this.scrub.presses);
    let jumps = step >= 60 ? '1 min' : step + ' s';
    return this.scrubOutsideLoaded ? `${jumps} jumps, not downloaded yet: it loads first` : `${jumps} jumps, hold to go faster`;
  }

  // the preview lands where nothing is downloaded yet: the jump will wait for it
  get scrubOutsideLoaded():boolean {
    if (!this.scrub || !this.duration) return false;
    let at = this.scrub.target / this.duration;
    return at < this.loadedStart - .001 || at > this.loadedEnd + .001;
  }

  get upNextShown():boolean {
    return !!this.upNext && !this.upNextDismissed && this.playerReady && this.duration > 0 && this.remaining <= UP_NEXT_S;
  }

  get countdownPct():number {
    return Math.min(100, Math.max(0, (1 - this.remaining / UP_NEXT_S) * 100));
  }

  get timingLabel():string {
    if (!this.subtitleDelay) return 'In sync with the video';
    let s = Math.abs(this.subtitleDelay).toFixed(1).replace(/\.0$/, '');
    return this.subtitleDelay > 0 ? `${s} s later` : `${s} s earlier`;
  }

  // ── the file ──────────────────────────────────────────────────────────────

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
    this.resumeNotice = `Resuming from ${this.clock(this.resumeAt)}`;
    setTimeout(() => this.resumeNotice = '', 5000);
  }

  saveProgress() {
    let player = this.moviePlayer;
    // 18+ titles stay out of the library (Continue watching, Watched)
    if (!this.playback?.tmdbId || this.playback.adult || this.playback.devSrc || !player || !this.playerReady || !this.resumeDecided) return;
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

  // ── input ─────────────────────────────────────────────────────────────────

  // The arrows that mean time, before the library moves the focus. Everything
  // else (moving between buttons, the subtitles panel) is the movement system's
  private onKeyDown(e:KeyboardEvent) {
    if (!this.screen.active || this.layers.top || !this.playerReady || !this.moviePlayer) return;
    let action = actionForKey(e);
    let onTimeline = document.activeElement?.classList.contains('scrubber');
    let take = () => { e.preventDefault(); e.stopImmediatePropagation(); };

    // the controls are hidden: any key brings them, Left / Right scrub, OK
    // plays the next episode while Up next shows, else pauses / plays
    if (!this.controlsVisible) {
      if (action == 'left' || action == 'right') {
        take();
        this.zone.run(() => this.scrubBy(action == 'right' ? 1 : -1));
      }
      else if (action == 'up' || action == 'down') {
        take();
        this.zone.run(() => this.showControls(action == 'up' ? '.scrubber' : '.ctl.play'));
      }
      else if (action == 'select') {
        take();
        this.zone.run(() => {
          if (this.upNextShown && this.upNext.torrent) this.playNext();
          else {
            this.togglePlay();
            this.showControls('.ctl.play');
          }
        });
      }
      return;
    }

    if (onTimeline && (action == 'left' || action == 'right')) {
      take();
      this.zone.run(() => this.scrubBy(action == 'right' ? 1 : -1));
    }
    else if (onTimeline && action == 'up') {
      take();
      this.zone.run(() => this.hideControls());
    }
    if (action) this.zone.run(() => this.poke());
  }

  // letting go of the arrow: the jump happens a moment later
  private onKeyUp(e:KeyboardEvent) {
    let action = actionForKey(e);
    if (!this.scrub || (action != 'left' && action != 'right')) return;
    clearTimeout(this.scrubTimer);
    this.scrubTimer = setTimeout(() => this.zone.run(() => this.commitScrub()), SCRUB_COMMIT_MS / 2);
  }

  // Enter that no button took: on the timeline, the scrub now (or play / pause)
  private select() {
    if (!this.moviePlayer) return;
    if (this.scrub) {
      this.commitScrub();
      return;
    }
    if (!this.controlsVisible) this.showControls();
    else this.togglePlay();
  }

  // In-page steps once playing: a scrub → Up next → controls → stats; then
  // out (before playback is ready: out at once). The subtitles panel is a
  // layer: it closes itself
  private back():boolean {
    if (!this.playerReady) return false;
    if (this.scrub) this.cancelScrub();
    else if (this.upNextShown && !this.controlsVisible) this.upNextDismissed = true;
    else if (this.controlsVisible) this.hideControls();
    else if (this.statsVisible) this.statsVisible = false;
    else return false;
    return true;
  }

  // ── playback ──────────────────────────────────────────────────────────────

  setupPlayer(){
    this.moviePlayer = this.host.nativeElement.querySelector('.moviePlayer');

    this.moviePlayer.src = this.playback.devSrc && !environment.production ? this.link
      : this.transcoding ? this.streamUrl(0) : this.server.media(this.link);
    this.moviePlayer.play()?.catch(() => {});
    // e.g. HEVC/x265 or AVI that Chromium can't decode
    this.moviePlayer.addEventListener('error', () => {
      if (!this.screen.active || !this.moviePlayer.getAttribute('src')) return;
      this.leavePlayer();
      this.notificationService.sendNotification("error" , "This video's format can't be played. Try another release");
    });
    this.moviePlayer.addEventListener('canplay', () => {
      this.applyResume();
      if (this.playerReady) return;
      setTimeout(() => {
        this.playerReady = true;
        this.updateClock();
      } , 1500)
    });

    // Stalls mid-playback: spinner + swarm stats until data flows again
    this.moviePlayer.addEventListener('waiting', () => {
      if (this.playerReady) this.buffering = true;
    });
    this.moviePlayer.addEventListener('playing', () => this.buffering = false);

    this.moviePlayer.addEventListener('play', () => { this.paused = false; this.updateClock(); this.poke(); });
    this.moviePlayer.addEventListener('pause', () => { this.paused = true; this.updateClock(); this.saveProgress(); });

    // fires again each time the transcoded stream restarts
    this.moviePlayer.addEventListener('loadedmetadata', () => this.updateTimeline());
    this.moviePlayer.addEventListener('timeupdate', () => {
      this.checkAudio();
      this.updateTimeline();
      // Progress for Continue watching / history: periodically, on pause and at the end
      if (!this.moviePlayer.paused && Date.now() - this.lastSave > SAVE_EVERY_MS) this.saveProgress();
      if (this.upNext && !this.upNext.torrent && !this.upNextLooking && this.remaining <= UP_NEXT_S + 60) this.lookUpNextRelease();
    });
    this.moviePlayer.addEventListener('progress', () => this.updateTimeline());
    this.moviePlayer.addEventListener('ended', () => {
      this.saveProgress();
      if (this.upNext?.torrent && !this.upNextDismissed) this.playNext();
    });
  }

  togglePlay() {
    if (!this.moviePlayer) return;
    if (this.moviePlayer.paused) this.moviePlayer.play()?.catch(() => {});
    else this.moviePlayer.pause();
  }

  jump(seconds:number) {
    if (!this.playerReady) return;
    this.seekTo(Math.min(this.duration || Infinity, this.position() + seconds));
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
      if (this.playerReady) this.buffering = true;
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => {
        let target = time;
        fetch(this.server.media(this.link.replace('/files/' , '/keyframe/') , { t: target }))
          .then(r => r.json()).catch(() => ({time: target}))
          .then(data => this.zone.run(() => {
            if (this.pendingSeek !== target || !this.screen.active) return; // a newer seek won
            this.offset = data['time'];
            this.pendingSeek = null;
            this.moviePlayer.src = this.streamUrl(this.offset);
            this.moviePlayer.play()?.catch(() => {});
            this.applyCueShift();
          }));
      } , 500);
    }
    this.updateTimeline();
  }

  // played, and the downloaded range around the playhead (it shows how far
  // playback can go without waiting; past it, the timeline is hatched)
  updateTimeline(){
    let duration = this.duration;
    if (!duration || !this.moviePlayer) return;
    this.playedPct = Math.min(100, this.position() * 100 / duration);

    let offset = this.transcoding ? this.offset : 0;
    let ranges = this.moviePlayer.buffered;
    let current = this.moviePlayer.currentTime;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= current + 0.5 && ranges.end(i) >= current) {
        this.loadedStart = (ranges.start(i) + offset) / duration;
        this.loadedEnd = Math.min(1, (ranges.end(i) + offset) / duration);
        return;
      }
    }
    this.loadedStart = this.loadedEnd = this.position() / duration;
  }

  // ── scrubbing ─────────────────────────────────────────────────────────────

  // One press: a preview mark moves by the step (faster while held); the seek
  // waits until the arrow has been let go a moment
  scrubBy(direction:number) {
    if (!this.duration) return;
    if (!this.scrub || this.scrub.direction != direction) {
      this.scrub = { target: this.scrub?.target ?? this.position(), direction, presses: 0 };
    }
    this.scrub.presses++;
    this.scrub.target = Math.min(this.duration - 1, Math.max(0, this.scrub.target + direction * scrubStep(this.scrub.presses)));
    this.showControls('.scrubber');
    clearTimeout(this.scrubTimer);
    this.scrubTimer = setTimeout(() => this.zone.run(() => this.commitScrub()), SCRUB_COMMIT_MS * 2);
  }

  commitScrub() {
    clearTimeout(this.scrubTimer);
    if (!this.scrub) return;
    let target = this.scrub.target;
    this.scrub = null;
    this.seekTo(target);
    this.poke();
  }

  cancelScrub() {
    clearTimeout(this.scrubTimer);
    this.scrub = null;
  }

  // ── controls ──────────────────────────────────────────────────────────────

  // `focus`: what to focus in them (CSS selector), default the play button
  showControls(focus = '.ctl.play') {
    if (!this.controlsVisible) {
      this.controlsVisible = true;
      this.updateClock();
    }
    let el = this.host.nativeElement.querySelector('.controls ' + focus) as HTMLElement;
    if (el && document.activeElement !== el) setTimeout(() => this.engine.focus(el, 'restore'));
    this.poke();
  }

  hideControls() {
    if (!this.controlsVisible) return;
    this.cancelScrub();
    this.controlsVisible = false;
    clearTimeout(this.controlsIdle);
    this.updateClock();
  }

  // A key (or the focus moving) keeps the controls up; while playing they go
  // after a while without one
  poke() {
    clearTimeout(this.controlsIdle);
    if (!this.controlsVisible) return;
    this.controlsIdle = setTimeout(() => this.zone.run(() => {
      if (this.moviePlayer?.paused || this.scrub || this.subtitlesOpen || this.pointer.visible) return;
      this.hideControls();
    }), CONTROLS_IDLE_MS);
  }

  // ── mouse ─────────────────────────────────────────────────────────────────

  onPointerMove(){
    if (this.playerReady && !this.controlsVisible) {
      this.controlsVisible = true;
      this.updateClock();
    }
    clearTimeout(this.pointerIdle);
    this.pointerIdle = setTimeout(() => this.onPointerIdle() , POINTER_IDLE_MS);
  }

  // Still mouse: clear the picture, unless the user switched to the keys
  // (they hid the cursor already) or is resting on the controls
  onPointerIdle(){
    if (!this.pointer.visible) return;
    if (this.host.nativeElement.querySelector(':is(.controls, .statsPanel, .upNext):hover')) return;

    this.pointer.hide();
    if (this.playerReady && !this.subtitlesOpen && !this.moviePlayer.paused) this.hideControls();
  }

  onVideoClick(){
    if (this.playerReady) this.togglePlay();
  }

  // The timeline seeks where it's clicked (data-pointer="own": no select key)
  onTimelineClick(e:MouseEvent){
    if (!this.playerReady || !this.duration) return;
    this.cancelScrub();
    this.seekTo(this.timelineFraction(e) * this.duration);
  }

  onTimelineHover(e:MouseEvent){
    this.hoverAt = this.duration ? this.timelineFraction(e) : null;
  }

  timelineFraction(e:MouseEvent){
    let rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.min(1 , Math.max(0 , (e.clientX - rect.left) / rect.width));
  }

  // ── stats ─────────────────────────────────────────────────────────────────

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
      droppedFrames : quality ? quality.droppedVideoFrames + ' of ' + quality.totalVideoFrames : '…',
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

  // 1:02:05 past an hour, 4:05 under
  clock(seconds:number):string {
    seconds = Math.max(0, Math.floor(seconds || 0));
    let h = Math.floor(seconds / 3600);
    let m = Math.floor(seconds % 3600 / 60);
    let s = seconds % 60;
    let pad = (n:number) => (n < 10 ? '0' : '') + n;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // ── up next ───────────────────────────────────────────────────────────────

  // Episodes: the one after this, from TMDB (its release is looked up later)
  findNextEpisode() {
    let p = this.playback;
    if (!p.season || !p.episode || !p.tmdbId || p.adult) return;
    this.nextSub = this.episodes.next(p.tmdbId, p.season, p.episode, p.imdbId).subscribe(next => this.upNext = next);
  }

  lookUpNextRelease(then?:() => void) {
    if (!this.upNext || this.upNextLooking) return;
    this.upNextLooking = true;
    let next = this.upNext;
    this.episodes.bestTorrent(next).subscribe(torrent => {
      this.upNextLooking = false;
      next.torrent = torrent;
      if (torrent) then?.();
    });
  }

  playNext() {
    if (!this.upNext) return;
    if (!this.upNext.torrent) {
      if (!this.upNextLooking) this.lookUpNextRelease(() => this.playNext());
      return;
    }
    this.saveProgress();
    this.episodes.playNext(this.upNext);
  }

  // ── subtitles ─────────────────────────────────────────────────────────────

  openSubtitles() {
    this.subtitlesOpen = true;
    if (!this.subtitleProviders.length && this.subtitles === undefined) this.fetchSubs();
  }

  fetchSubs(){
    this.subtitlesService.getProviders().subscribe(providers => {
      let kind = this.playback.season ? 'episode' : 'movie';
      this.subtitleProviders = providers.filter(p => p.enabled && p.supports[kind]);
      let preferred = this.subtitleProviders.find(p => p.id == this.subtitlesService.preferredProvider);
      this.loadSubtitles((preferred || this.subtitleProviders[0])?.id);
    } , () => {
      this.subtitles = [];
      this.subtitlesError = "The subtitle service isn't answering. Try again in a moment.";
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

    if (!provider || !this.playback.imdbId) {
      this.subtitles = [];
      this.subtitlesError = provider ? "This title has no IMDb id, so subtitles can't be looked up." : "No subtitle source is turned on. Turn one on in the server's dashboard.";
      return;
    }

    let query = { imdbId: this.playback.imdbId, season: this.playback.season, episode: this.playback.episode };
    this.subtitlesService.search(provider , query).subscribe(result => {
      if (provider != this.subtitleProvider) return;
      this.subtitles = result.subtitles;
    } , () => {
      if (provider != this.subtitleProvider) return;
      this.subtitles = [];
      this.subtitlesError = "This source isn't answering. Try another one.";
    })
  }

  showSubtitle(subtitle:Subtitle){
    if (!subtitle || !this.moviePlayer) return;
    this.selectedSubtitle = subtitle;
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
      this.appliedCueShift = 0;
      this.applyCueShift();
    });
  }

  hideSubtitles() {
    this.selectedSubtitle = null;
    this.moviePlayer?.querySelectorAll('track').forEach(track => track.remove());
  }

  setSubtitleSize(key:string) {
    this.subtitleSize = key;
    try { localStorage.setItem(SUBTITLE_SIZE_KEY, key); } catch (e) { }
    this.applySubtitleSize();
  }

  private applySubtitleSize() {
    let size = SUBTITLE_SIZES.find(s => s.key == this.subtitleSize) || SUBTITLE_SIZES[1];
    this.host.nativeElement.style.setProperty('--px-subtitle-size', `var(${size.token})`);
  }

  shiftSubtitles(seconds:number) {
    this.subtitleDelay = Math.round((this.subtitleDelay + seconds) * 10) / 10;
    this.applyCueShift();
  }

  // Cues are in file time. Shown at file time − the transcoded stream's
  // offset + the user's delay: only the difference with what was already
  // applied moves them
  applyCueShift(){
    let cues = this.moviePlayer?.textTracks[0]?.cues;
    let target = (this.transcoding ? this.offset : 0) - this.subtitleDelay;
    let delta = target - this.appliedCueShift;
    if (!cues || !delta) return;
    this.appliedCueShift = target;
    for (let i = 0; i < cues.length; i++) {
      cues[i].startTime -= delta;
      cues[i].endTime -= delta;
    }
  }
}
