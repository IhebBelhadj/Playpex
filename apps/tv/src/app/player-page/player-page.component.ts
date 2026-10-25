import type { SettingValues } from '@playpex/protocol/settings';
import { SettingsService } from '../settings.service';
import { NotificationService } from './../notification.service';
import { Subtitle, SubtitleProvider, SubtitlesService } from './../subtitles.service';
import { PlaybackRequest, PlaybackService } from './../playback.service';
import { TorrentService } from './../torrent.service';
import { Component, OnInit, OnDestroy, ElementRef, NgZone, inject } from '@angular/core';
import { repeat, switchMap, filter, catchError } from "rxjs/operators";
import { gsap } from 'gsap'
import { EMPTY, Subscription, timer } from 'rxjs';
import { ServerService } from '../server.service';
import { API_PREFIX } from '../server-config';
import { actionForKey, MediaAction } from '../keymap';
import { MediaKeys } from '../media-keys.service';
import { EpisodeKey, LibraryService } from '../library.service';
import { PointerService } from '../pointer.service';
import { ProfilesService } from '../profiles.service';
import { LayerStack, Navigator, useScreen } from '../nav/public-api';
import { FocusEngine } from '../movement/movement';
import { tmdbImageBase } from '../ui/public-api';
import { EpisodePlaybackService, NextEpisode } from '../episode-playback.service';
import { Marker, PlaySourcesService } from '../play-sources.service';
import { MediaTrack, MediaTracks, MediaTracksService } from '../media-tracks.service';
import { environment } from '../../environments/environment';
import { HlsPlayer, loadHls } from './hls';

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

export type SettingsTab = 'subtitles' | 'style' | 'audio' | 'video' | 'stats';
const TABS:{ key:SettingsTab, label:string }[] = [
  { key: 'subtitles', label: 'Subtitles' },
  { key: 'style', label: 'Size & timing' },
  { key: 'audio', label: 'Audio' },
  { key: 'video', label: 'Video' },
  { key: 'stats', label: 'Stats' },
];

// How the picture fills the screen (object-fit), and what each one does
type PictureMode = 'fit' | 'fill' | 'stretch' | 'original';
const PICTURE_MODES:{ key:PictureMode, label:string, fit:string, help:string }[] = [
  { key: 'fit', label: 'Fit', fit: 'contain', help: 'The whole picture, with bars where it doesn\'t match the screen.' },
  { key: 'fill', label: 'Fill', fit: 'cover', help: 'No bars: the edges that don\'t fit are cut off.' },
  { key: 'stretch', label: 'Stretch', fit: 'fill', help: 'No bars and nothing cut: the picture is stretched to the screen.' },
  { key: 'original', label: 'Original size', fit: 'none', help: 'Pixel for pixel, as large as the video is.' },
];

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
// them. Settings (subtitles, their size and timing, audio, video, stats) are
// a px-panel layer docked at the right edge, with tabs; "Audio & subtitles"
// another (the file's tracks, docs/providers-plan.md §6, §10.3): two columns.
//
// A plugin's stream (docs/providers-plan.md §8.3): format hls plays the
// server's proxied playlist with hls.js (loaded on first use; Chromium plays
// no HLS), its audio renditions and subtitles in the tracks panel; format
// live is one continuous stream on <video src>. Live ones (a live playlist,
// or a continuous stream) have no timeline but a Live mark, no seeking, and
// are remembered nowhere.
const PLAY_BUTTON = '.buttons [data-px-key="play"]';

@Component({
  selector: 'app-player-page',
  templateUrl: './player-page.component.html',
  styleUrls: ['./player-page.component.scss']
})
export class PlayerPageComponent implements OnInit ,OnDestroy{

  magnetUrl;
  torrentHash;
  private released = false;     // a source's lease was let go
  playback:PlaybackRequest;
  playerReady = false;
  controlsVisible = false;
  moviePlayer:HTMLVideoElement;
  link:string;                // the file's stream path: /media/{ref} (TorrentFile.ref); URLs: server.media()
  ref:string | null = null;   // its media ref (null: a server without refs, the torrent routes)
  format:'file' | 'hls' | 'live' = 'file';   // how it plays (a plugin's stream: hls / live)
  live = false;               // no end: a live playlist or a continuous stream
  private hls:HlsPlayer | null = null;
  paused = false;
  playerSub:Subscription;
  audioWarning = false;
  audioCheckDone = false;
  buffering = false;          // playback stalled waiting for data
  stats;                      // latest swarm stats while loading / buffering / stats panel open
  statsVisible = false;
  videoInfo;                  // <video>-side numbers for the stats panel
  statsSub:Subscription;

  stages = ['Starting the torrent', 'Finding peers', 'Reading the torrent', 'Downloading the start'];

  // timeline (fractions of the duration)
  playedPct = 0;
  loadedStart = 0;
  loadedEnd = 0;
  hoverAt:number | null = null;
  scrub:{ target:number, direction:number, presses:number } | null = null;
  private scrubTimer;

  // the settings panel (a layer: subtitles, their size and timing, audio,
  // video, stats); moving onto a tab shows it
  settingsOpen = false;
  readonly tabs = TABS;
  tab:SettingsTab = 'subtitles';

  // audio / video
  volume = 100;               // %
  muted = false;
  speed = 1;
  readonly pictureModes = PICTURE_MODES;
  pictureMode:PictureMode = 'fit';
  zoom = 100;                 // %
  brightness = 100;           // %

  // the sliders' value labels
  readonly percentText = (v:number) => v + ' %';
  readonly volumeText = (v:number) => this.muted ? 'Sound off' : v + ' %';
  readonly speedText = (v:number) => v == 1 ? 'Normal' : v + '×';
  readonly sizeName = (i:number) => SUBTITLE_SIZES[i]?.label || '';
  readonly sizeStops = SUBTITLE_SIZES.map((s, i) => ({ value: i, label: s.label }));
  readonly timingText = (v:number) => {
    if (!v) return 'In sync';
    let s = Math.abs(v).toFixed(1).replace(/\.0$/, '');
    return v > 0 ? `${s} s later` : `${s} s earlier`;
  };

  // subtitles
  subtitles:Subtitle[];
  subtitleProviders:SubtitleProvider[] = [];
  subtitleProvider:string;
  subtitlesError:string;
  selectedSubtitle:Subtitle | null = null;
  readonly subtitleSizes = SUBTITLE_SIZES;
  subtitleSize = 'medium';
  subtitleDelay = 0;          // seconds, positive = later
  private appliedCueShift = 0; // seconds taken off the cues' file times so far

  // the file's tracks (GET /media/{ref}/tracks): its audio and subtitle
  // streams, the torrent's files that go with it, its other videos. An audio
  // track Chromium decodes is switched natively (audioTracks, enabled by the
  // shell: only those it decodes are listed, in order), another one through
  // the server's /transcode (?audio= / ?audioRef=)
  tracks:MediaTracks | null = null;
  tracksOpen = false;
  audioTrack:MediaTrack | null = null;
  subtitleTrack:MediaTrack | null = null;
  readonly trackLabel = MediaTracksService.label;
  readonly trackDetail = MediaTracksService.detail;
  readonly trackUsable = MediaTracksService.usable;
  private nativeAudio = -1;               // the audioTracks position to enable, -1: the file's own choice
  private audioIndex = 0;                 // /transcode ?audio=
  private audioRef:string | null = null;  // /transcode ?audioRef= (a separate audio file)
  private probedDuration = 0;
  private seekAfterLoad:number | null = null;   // a switch back to direct play: where to continue
  // the tracks saved with the resume point (this release), and what the user chose here
  private savedTracks:{ audio:string | null, subtitle:string | null, fileId?:string | null, infoHash:string | null, filePath:string | null } | null = null;
  private chosenAudio:string | null = null;
  private chosenSubtitle:string | null = null;
  private stateKnown:Promise<void>;
  private markStateKnown:() => void;

  // markers from the server's plugins (player.markers): Skip intro / recap, credits
  markers:Marker[] = [];
  private markersAsked = false;
  private markersSub:Subscription;
  private skipDismissed = new Set<Marker>();

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
  // media keys while the player is shown and no layer is open (§13.2)
  private mediaSub = inject(MediaKeys).for(this.screen).subscribe(action => this.onMedia(action));
  private lastMedia:{ action:MediaAction | null, at:number } = { action: null, at: 0 };
  // Set first in ngOnDestroy: work that finishes later (a probe, the torrent's
  // answer, a seek's keyframe, Up next) must not start a video nobody sees
  private destroyed = false;
  // the <video>'s listeners, removed together on destroy
  private videoListeners = new AbortController();
  private readyTimer:any;
  private registerSub:Subscription;
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
    private settings:SettingsService,
    private sources:PlaySourcesService,
    private mediaTracks:MediaTracksService,
    private playbackService:PlaybackService,
  ) {
    this.stateKnown = new Promise(resolve => this.markStateKnown = resolve);
  }

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

    let asked = this.playback.startAt !== undefined;
    if (asked) {
      // chosen on the detail page: resume at this point, or 0 = from the beginning
      this.resumeAt = this.playback.startAt || null;
      this.resumeDecided = true;
    }
    // the saved state: where to resume (unless asked), and the tracks chosen last time
    if (this.playback.tmdbId && this.playback.tracking != 'none') {
      this.stateSub = this.library.state(this.libraryKey()).subscribe({
        next: state => {
          let r = state.resume;
          if (r) this.savedTracks = { audio: r.audioTrack || null, subtitle: r.subtitleTrack || null, fileId: r.fileId, infoHash: r.infoHash, filePath: r.filePath };
          if (!asked) {
            this.resumeAt = r ? r.positionS : null;
            this.resumeDecided = true;
            this.applyResume();
          }
          this.markStateKnown();
        },
        error: () => {
          this.resumeDecided = true;
          this.markStateKnown();
        },
      });
    }
    else {
      this.resumeDecided = true;
      this.markStateKnown();
    }

    // this device's settings (SettingsService: the server's, the defaults until it answers)
    this.subtitleSize = this.settings.value('subtitles.size');
    this.volume = this.settings.value('player.volume');
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

    // a file on the server (library, a download's file): its media ref at
    // once, no torrent to add or wait for
    if (this.playback.source) {
      let source = this.playback.source;
      this.ref = source.ref;
      this.link = `${API_PREFIX}/media/${source.ref}`;
      this.filePath = source.path;
      this.torrentHash = source.infoHash;   // a download's: its stats
      if (!source.infoHash) this.stages = ['Opening the file on the server'];
      this.startKeepalive();
      // a plugin's stream: nothing to probe, its tracks come from the playlist
      if (source.format == 'hls' || source.format == 'live') {
        this.format = source.format;
        this.live = source.format == 'live';
        this.stages = ['Opening the stream'];
        setTimeout(() => this.setupPlayer());
        return;
      }
      this.probeFile().then(() => this.loadTracks()).then(() => this.setupPlayer());
      return;
    }

    this.magnetUrl = this.playback.magnet;
    // Not unsubscribed on destroy: when the answer comes after the player
    // closed, the server took a lease all the same, and it is let go here
    this.registerSub = this.torrentService.registerTorrent(this.magnetUrl).subscribe({
      next: data => {
        let hash = data['infoHash'];
        if (this.destroyed) {
          this.torrentService.removeTorrent(hash).subscribe({ error: () => {} });
          return;
        }
        this.torrentHash = hash;
        this.startKeepalive();
        this.waitForFiles(hash);
      },
      error: e => this.cantStart(e),
    });
  }

  // e.g. 503 BUSY: the server already streams as many torrents as it allows
  private cantStart(e) {
    if (this.destroyed) return;
    this.leavePlayer();
    this.notificationService.sendNotification("error" , e?.error?.error || "Couldn't start this torrent. Check that the Playpex server is running.");
  }

  // The torrent's files, polled every 4 s until its metadata is there
  private waitForFiles(hash:string) {
    let reps = 0;
    let p = this.playback;
    let hint = { season: p.season || undefined, episode: p.season ? p.episode : undefined, fileIndex: p.file?.index, fileName: p.file?.name };
    this.playerSub = this.torrentService.getTorrent(hash, hint).pipe(repeat({ delay: 4000 })).subscribe({
      error: e => this.cantStart(e),
      next: data => {
        reps += 1;

        if (data['files']) {
          this.playerSub.unsubscribe();
          // the server's choice (`chosen`); an older server: guessed from the names here
          let file = 'chosen' in data ? data['files'].find(f => f['path'] == data['chosen'])
            : this.playback.season
            ? this.pickEpisodeFile(data['files'] , this.playback.season , this.playback.episode)
            : this.pickVideoFile(data['files']);
          if (!file) {
            this.leavePlayer();
            let what = this.playback.season ? `${this.playback.subtitle?.split(' ')[0]} in this torrent` : "in this torrent";
            this.notificationService.sendNotification("error" , `No playable video file found ${what}`);
            return;
          }
          this.filePath = file['path'];
          this.ref = file['ref'] || null;
          this.link = this.ref ? `${API_PREFIX}/media/${this.ref}` : file['link'];
          this.probeFile().then(() => this.loadTracks()).then(() => this.setupPlayer());
          return;
        }

        if (reps > 4) {
          this.playerSub.unsubscribe();
          this.leavePlayer();
          this.notificationService.sendNotification("error" , "Couldn't fetch the torrent's metadata (no peers?). Try again later");
        }
      },
    });
  }

  ngOnDestroy(): void {
    // last position, while the <video> still has it
    this.saveProgress();
    this.destroyed = true;
    // every way out lets go of the lease (beforeLeave did already, but not
    // every exit runs it); does nothing the second time
    this.releaseTorrent();
    this.mediaSub?.unsubscribe();
    this.stopMediaSession();
    clearTimeout(this.seekTimer);
    clearTimeout(this.scrubTimer);
    clearTimeout(this.controlsIdle);
    clearTimeout(this.readyTimer);
    this.stateSub?.unsubscribe();
    this.nextSub?.unsubscribe();
    this.markersSub?.unsubscribe();

    this.pointer.wheelNavigation = true;
    this.pointerSub?.unsubscribe();
    clearTimeout(this.pointerIdle);

    this.playerSub?.unsubscribe();
    this.statsSub?.unsubscribe();
    clearInterval(this.keepaliveTimer);
    gsap.killTweensOf('.clock');
    gsap.set('.clock' , { clearProps : 'opacity' });

    this.stopVideo();
    window.removeEventListener('keydown', this.keyDown, true);
    window.removeEventListener('keyup', this.keyUp, true);
  }

  // ── what's shown ──────────────────────────────────────────────────────────

  get duration():number {
    if (this.live) return 0;
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

  // How long before the end Up next shows: from the credits when a plugin
  // marks them (at most 10 min), else the last 40 s
  get upNextWindow():number {
    let credits = this.markers.find(m => m.kind == 'credits'), d = this.mediaDuration();
    return credits && d > credits.start ? Math.min(600, Math.max(UP_NEXT_S / 4, d - credits.start)) : UP_NEXT_S;
  }

  get upNextShown():boolean {
    return !!this.upNext && !this.upNextDismissed && this.playerReady && this.duration > 0 && this.remaining <= this.upNextWindow;
  }

  get countdownPct():number {
    return Math.min(100, Math.max(0, (1 - this.remaining / this.upNextWindow) * 100));
  }

  // The intro / recap playing now, when a plugin marked it: "Skip intro"
  get skipMarker():Marker | null {
    if (!this.playerReady || this.scrub || !this.markers.length) return null;
    let t = this.position();
    return this.markers.find(m => (m.kind == 'intro' || m.kind == 'recap') && m.end != null &&
      t >= m.start && t < m.end - 1 && !this.skipDismissed.has(m)) || null;
  }

  skipLabel(m:Marker):string {
    return m.label || (m.kind == 'intro' ? 'Skip intro' : 'Skip recap');
  }

  skipNow() {
    let m = this.skipMarker;
    if (!m) return;
    this.skipDismissed.add(m);
    this.seekTo(m.end);
  }

  get subtitleSizeIndex():number {
    return Math.max(0, SUBTITLE_SIZES.findIndex(s => s.key == this.subtitleSize));
  }

  get pictureFit():string {
    return PICTURE_MODES.find(m => m.key == this.pictureMode)?.fit || 'contain';
  }

  get pictureHelp():string {
    return PICTURE_MODES.find(m => m.key == this.pictureMode)?.help || '';
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
    let url = this.server.media(this.mediaPath('probe'));
    return fetch(url).then(r => r.ok ? r.json() : null).then(info => {
      this.probedDuration = info?.duration || 0;
      if (!info?.transcode) return;
      this.transcoding = true;
      this.knownDuration = info.duration || 0;
    }).catch(() => {});
  }

  // /media/{ref}/<route>, or the torrent route's alias on a server without refs
  mediaPath(route:'probe' | 'keyframe' | 'transcode'):string {
    return this.ref ? `${this.link}/${route}` : this.link.replace('/files/' , `/${route}/`);
  }

  streamUrl(start:number){
    let audio = this.audioRef ? { audioRef: this.audioRef } : this.audioIndex ? { audio: this.audioIndex } : {};
    return this.server.media(this.mediaPath('transcode') , { t: start, ...audio });
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
    if (this.live) return;
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
    // tracking none stays out of the library (Continue watching, Watched)
    if (!this.playback?.tmdbId || this.playback.tracking == 'none' || this.playback.devSrc || this.live || !player || !this.playerReady || !this.resumeDecided) return;
    // don't overwrite the saved position with 0:00 before jumping to it
    if (this.resumeAt && !this.resumeApplied) return;
    let duration = this.mediaDuration();
    if (!isFinite(duration) || duration <= 0 || this.position() < 1) return;

    this.lastSave = Date.now();
    this.library.saveProgress(this.libraryKey(), {
      ...this.playback.artwork,
      positionS: this.position(),
      durationS: duration,
      // the release that played: a library file, else a torrent's file
      fileId: this.ref?.startsWith('f_') ? this.ref.slice(2) : null,
      infoHash: this.torrentHash || null,
      filePath: this.filePath || null,
      // the tracks the user chose here, else those of last time (this release)
      audioTrack: this.chosenAudio ?? this.savedTracksHere()?.audio ?? null,
      subtitleTrack: this.chosenSubtitle ?? this.savedTracksHere()?.subtitle ?? null,
    }).subscribe({ error: () => {} });
  }

  // Every minute until the player closes: keeps the server's lease, and tells
  // it what plays (its Activity view)
  startKeepalive() {
    if (this.destroyed) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      let player = this.moviePlayer;
      let duration = this.playerReady ? this.mediaDuration() : NaN;
      let code = this.playback.season ? this.playback.subtitle?.split(' ')[0] : '';
      let p = this.playback;
      let state = {
        title: [p.title, code].filter(Boolean).join(' · '),
        profileId: this.profiles.current.value?.id,
        file: this.filePath,
        // which title the server's download is (not with tracking none)
        ...(p.tmdbId && p.mediaType && p.tracking != 'none' ? {
          media: { mediaType: p.mediaType, tmdbId: p.tmdbId, ...(p.season ? { season: p.season, episode: p.episode } : {}) },
        } : {}),
        ...(this.playerReady && player ? { positionS: this.position(), paused: player.paused } : {}),
        ...(isFinite(duration) && duration > 0 ? { durationS: duration } : {}),
      };
      let sent = this.playback.source ? this.torrentService.keepMedia(this.playback.source.ref , state)
        : this.torrentService.keepTorrent(this.torrentHash , state);
      sent.subscribe({ error: () => {} });
    } , KEEPALIVE_EVERY_MS);
  }

  // Back to where the user came from (the lease goes in beforeLeave)
  leavePlayer() {
    this.navigator.back();
  }

  // Lets go of the torrent: the server pauses it 30 s after the last device
  // let go (its data stays, a later Play resumes it)
  private releaseTorrent() {
    // a file played by its ref: the lease is the ref's (a download's: its torrent's)
    if (this.playback?.source && !this.released) {
      this.released = true;
      clearInterval(this.keepaliveTimer);
      this.torrentService.releaseMedia(this.playback.source.ref).subscribe({ error: () => {} });
      return;
    }
    if (!this.torrentHash || this.playback?.source) return;
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
      // live: no time to move in, the arrows only bring the controls
      if (this.live && (action == 'left' || action == 'right' || action == 'up' || action == 'down')) {
        take();
        this.zone.run(() => this.showControls(PLAY_BUTTON));
      }
      else if (action == 'left' || action == 'right') {
        take();
        this.zone.run(() => this.scrubBy(action == 'right' ? 1 : -1));
      }
      else if (action == 'up' || action == 'down') {
        take();
        this.zone.run(() => this.showControls(action == 'up' ? '.scrubber' : PLAY_BUTTON));
      }
      else if (action == 'select') {
        take();
        this.zone.run(() => {
          if (this.skipMarker) this.skipNow();
          else if (this.upNextShown && this.upNext.source) this.playNext();
          else {
            this.togglePlay();
            this.showControls(PLAY_BUTTON);
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
    else if (this.skipMarker && !this.controlsVisible) this.skipDismissed.add(this.skipMarker);
    else if (this.upNextShown && !this.controlsVisible) this.upNextDismissed = true;
    else if (this.controlsVisible) this.hideControls();
    else if (this.statsVisible) this.statsVisible = false;
    else return false;
    return true;
  }

  // ── playback ──────────────────────────────────────────────────────────────

  setupPlayer(){
    // left while the file was being probed / the torrent opened
    if (this.destroyed) return;
    this.moviePlayer = this.host.nativeElement.querySelector('.moviePlayer');
    let player = this.moviePlayer;
    let on = (name:string, fn:() => void) => player.addEventListener(name, fn, { signal: this.videoListeners.signal });

    this.applyVolume();
    if (this.format == 'hls') this.attachHls();
    else {
      this.moviePlayer.src = this.playback.devSrc && !environment.production ? this.link
        : this.transcoding ? this.streamUrl(0) : this.server.media(this.link);
      this.moviePlayer.play()?.catch(() => {});
    }
    // e.g. HEVC/x265 or AVI that Chromium can't decode (hls.js says so itself)
    on('error', () => {
      if (this.hls || !this.screen.active || !this.moviePlayer.getAttribute('src')) return;
      this.leavePlayer();
      this.notificationService.sendNotification("error" , "This video's format can't be played. Try another release");
    });
    on('canplay', () => {
      this.applyResume();
      if (this.playerReady) return;
      clearTimeout(this.readyTimer);
      this.readyTimer = setTimeout(() => {
        if (this.destroyed) return;
        this.playerReady = true;
        this.updateClock();
        this.startMediaSession();
      } , 1500)
    });

    // Stalls mid-playback: spinner + swarm stats until data flows again
    on('waiting', () => {
      if (this.playerReady) this.buffering = true;
    });
    on('playing', () => this.buffering = false);

    on('play', () => { this.paused = false; this.updateClock(); this.poke(); this.mediaState(); });
    on('pause', () => { this.paused = true; this.updateClock(); this.saveProgress(); this.mediaState(); });

    // fires again each time the transcoded stream restarts
    on('loadedmetadata', () => {
      this.applyNativeAudio();
      if (this.seekAfterLoad !== null) {
        this.moviePlayer.currentTime = this.seekAfterLoad;
        this.seekAfterLoad = null;
      }
      this.updateTimeline();
      if (!this.live) this.askMarkers();
    });
    this.applyInitialSubtitles();
    on('timeupdate', () => {
      this.checkAudio();
      this.updateTimeline();
      // Progress for Continue watching / history: periodically, on pause and at the end
      if (!this.moviePlayer.paused && Date.now() - this.lastSave > SAVE_EVERY_MS) this.saveProgress();
      if (this.upNext && !this.upNext.source && !this.upNextLooking && this.remaining <= this.upNextWindow + 60) this.lookUpNextRelease();
    });
    on('progress', () => this.updateTimeline());
    on('ended', () => {
      this.saveProgress();
      // the profile's "Autoplay next episode" (on by default)
      if (this.upNext?.source && !this.upNextDismissed && this.settings.value('player.autoplayNext')) this.playNext();
    });
  }

  // Stops the <video> for good: its listeners first (no 'pause' / 'error'
  // handlers for a closed player), then the stream itself. Removing src and
  // calling load() aborts the request (the server's transcode ends with it)
  // and frees the decoder; `src = ""` alone would load the page's own URL
  private stopVideo() {
    this.videoListeners.abort();
    this.hls?.destroy();
    this.hls = null;
    let player = this.moviePlayer || this.host.nativeElement.querySelector<HTMLVideoElement>('.moviePlayer');
    if (!player) return;
    player.pause();
    player.querySelectorAll('track').forEach(track => track.remove());
    player.removeAttribute('src');
    player.load();
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
        fetch(this.server.media(this.mediaPath('keyframe') , { t: target }))
          .then(r => r.json()).catch(() => ({time: target}))
          .then(data => this.zone.run(() => {
            if (this.destroyed || this.pendingSeek !== target || !this.screen.active) return; // a newer seek won, or the player closed
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

  // ── media keys (§13.2) ───────────────────────────────────────────────────

  // A remote's / keyboard's media keys (MediaKeys) and the Media Session's
  // actions (hardware keys Chromium routes there, the OS media overlay): one
  // stream. Forward / rewind are the held scrub of the arrows (a preview, one
  // seek once they stop); next = the next episode; previous = from the start
  private onMedia(action:MediaAction) {
    if (!this.moviePlayer) return;
    if (action == 'stop') return this.leavePlayer();
    if (!this.playerReady) return;
    // a hardware key can arrive both ways: once
    let now = Date.now();
    if (action == this.lastMedia.action && now - this.lastMedia.at < 250) return;
    this.lastMedia = { action, at: now };
    switch (action) {
      case 'playPause':
        this.togglePlay();
        this.showControls(PLAY_BUTTON);
        break;
      case 'play':
        if (this.moviePlayer.paused) this.togglePlay();
        break;
      case 'pause':
        if (!this.moviePlayer.paused) this.togglePlay();
        this.showControls(PLAY_BUTTON);
        break;
      case 'forward':
      case 'rewind':
        if (this.live) break;
        this.scrubBy(action == 'forward' ? 1 : -1);
        clearTimeout(this.scrubTimer);
        this.scrubTimer = setTimeout(() => this.zone.run(() => this.commitScrub()), SCRUB_COMMIT_MS);
        break;
      case 'next':
        if (this.upNext) this.playNext();
        break;
      case 'previous':
        if (this.live) break;
        this.seekTo(0);
        this.showControls(PLAY_BUTTON);
        break;
    }
  }

  private startMediaSession() {
    let session = navigator.mediaSession;
    if (!session || typeof MediaMetadata == 'undefined') return;
    let poster = this.playback.artwork?.posterPath;
    // the OS overlay's thumbnail: its own fixed size, not the screen's (not tmdbImageBase)
    try {
      session.metadata = new MediaMetadata({
        title: this.playback.subtitle ? `${this.playback.title}: ${this.playback.subtitle}` : this.playback.title,
        artist: 'Playpex',
        artwork: poster ? [{ src: `https://image.tmdb.org/t/p/w342${poster}`, sizes: '342x513', type: 'image/jpeg' }] : [],
      });
    } catch (e) { }
    let on = (name:MediaSessionAction, action:MediaAction) => {
      try { session.setActionHandler(name, () => this.onMedia(action)); } catch (e) { }
    };
    on('play', 'play');
    on('pause', 'pause');
    on('stop', 'stop');
    on('seekforward', 'forward');
    on('seekbackward', 'rewind');
    on('previoustrack', 'previous');
    if (this.upNext) on('nexttrack', 'next');
    this.mediaState();
  }

  private mediaState() {
    if (navigator.mediaSession && this.playerReady) navigator.mediaSession.playbackState = this.paused ? 'paused' : 'playing';
  }

  private stopMediaSession() {
    let session = navigator.mediaSession;
    if (!session) return;
    for (let name of ['play', 'pause', 'stop', 'seekforward', 'seekbackward', 'previoustrack', 'nexttrack'] as MediaSessionAction[]) {
      try { session.setActionHandler(name, null); } catch (e) { }
    }
    session.metadata = null;
    session.playbackState = 'none';
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
  showControls(focus = PLAY_BUTTON) {
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
      if (this.moviePlayer?.paused || this.scrub || this.settingsOpen || this.tracksOpen || this.pointer.visible) return;
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
    if (this.playerReady && !this.settingsOpen && !this.tracksOpen && !this.moviePlayer.paused) this.hideControls();
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
      filter(() => !!this.torrentHash && (!this.playerReady || this.buffering || this.statsVisible || (this.settingsOpen && this.tab == 'stats'))),
      switchMap(() => this.torrentService.getStats(this.torrentHash).pipe(catchError(() => EMPTY))),
    ).subscribe(stats => {
      this.stats = stats;
      if (this.statsVisible || this.settingsOpen) this.videoInfo = this.readVideoInfo();
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

  // ── markers ───────────────────────────────────────────────────────────────

  // Once the length is known: what the server's plugins mark in this title
  // (not with tracking none, nor videos without a TMDB title)
  private askMarkers() {
    let p = this.playback, duration = this.mediaDuration();
    if (this.markersAsked || this.destroyed || p.tracking == 'none' || !p.tmdbId || !p.mediaType || !(duration > 0)) return;
    this.markersAsked = true;
    let episode = p.mediaType == 'tv' && p.season != null && !!p.episode;
    let fileName = (this.filePath || '').split('/').pop();
    this.markersSub = this.sources.markers({
      kind: episode ? 'episode' : 'movie',
      tmdbId: p.tmdbId,
      imdbId: p.imdbId,
      title: p.title,
      year: PlaySourcesService.year(p.year),
      ...(episode ? { season: p.season, episode: p.episode } : {}),
      duration: Math.round(duration),
      ...(fileName ? { fileName } : {}),
    }).subscribe(markers => this.markers = markers);
  }

  // ── up next ───────────────────────────────────────────────────────────────

  // Episodes: the one after this, from TMDB (its release is looked up later)
  findNextEpisode() {
    let p = this.playback;
    if (!p.season || !p.episode || !p.tmdbId || p.tracking == 'none') return;
    this.nextSub = this.episodes.next(p.tmdbId, p.season, p.episode, p.imdbId).subscribe(next => this.upNext = next);
  }

  lookUpNextRelease(then?:() => void) {
    if (!this.upNext || this.upNextLooking) return;
    this.upNextLooking = true;
    let next = this.upNext;
    this.episodes.bestSource(next).subscribe(source => {
      this.upNextLooking = false;
      next.source = source;
      if (source) then?.();
    });
  }

  playNext() {
    if (this.destroyed || !this.upNext) return;
    if (!this.upNext.source) {
      if (!this.upNextLooking) this.lookUpNextRelease(() => this.playNext());
      return;
    }
    this.saveProgress();
    this.episodes.playNext(this.upNext);
  }

  // ── tracks ────────────────────────────────────────────────────────────────

  // The tracks saved with the resume point, when they are this release's
  private savedTracksHere() {
    let saved = this.savedTracks;
    if (!saved || !this.ref) return null;
    let same = this.ref.startsWith('f_') ? saved.fileId == this.ref.slice(2)
      : !!saved.infoHash && saved.infoHash == this.torrentHash && saved.filePath == this.filePath;
    return same ? saved : null;
  }

  // Before the first frame: the file's tracks, and the audio to start with
  // (saved here last time, else the profile's language, else the file's
  // default). A track Chromium decodes plays directly; another one converted.
  loadTracks():Promise<void> {
    if (this.destroyed || !this.ref) return Promise.resolve();
    let state = Promise.race([this.stateKnown, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
    return Promise.all([this.mediaTracks.tracks(this.ref).toPromise(), state]).then(([tracks]) => {
      if (this.destroyed || !tracks) return;
      this.tracks = tracks;
      let audio = tracks.audio.filter(t => MediaTracksService.usable(t));
      let saved = this.savedTracksHere()?.audio;
      let language = this.settings.value('player.audioLanguage');
      let start = audio.find(t => t.id == saved)
        || (language != 'original' ? audio.find(t => t.language == language) : undefined)
        || audio.find(t => t.source == 'embedded' && t.default) || audio.find(t => t.source == 'embedded');
      if (start) this.useAudio(start);
    }).catch(() => {});
  }

  // How `track` will play: natively, or through /transcode (no stream restarted here)
  private useAudio(track:MediaTrack) {
    this.audioTrack = track;
    let direct = this.tracks.audio.filter(t => t.source == 'embedded' && t.play == 'direct');
    if (track.play == 'direct') {
      this.transcoding = false;
      this.offset = 0;
      this.nativeAudio = direct.indexOf(track);
      return;
    }
    this.transcoding = true;
    this.knownDuration = this.knownDuration || this.probedDuration || this.moviePlayer?.duration || 0;
    this.nativeAudio = -1;
    this.audioIndex = track.source == 'embedded' ? track.index : 0;
    this.audioRef = track.source == 'file' ? track.ref : null;
  }

  private applyNativeAudio() {
    let list = (this.moviePlayer as any)?.audioTracks;
    if (this.transcoding || this.nativeAudio < 0 || !list || list.length <= this.nativeAudio) return;
    for (let i = 0; i < list.length; i++) list[i].enabled = i == this.nativeAudio;
  }

  // The user picks an audio track: at once, from where the video is
  selectAudio(track:MediaTrack) {
    if (!MediaTracksService.usable(track) || track === this.audioTrack || !this.moviePlayer) return;
    if (this.hls) {
      this.audioTrack = track;
      this.hls.audioTrack = track.index;
      return;
    }
    let at = this.position(), wasTranscoding = this.transcoding;
    this.chosenAudio = track.id;
    this.useAudio(track);
    if (!this.transcoding && !wasTranscoding) {
      this.applyNativeAudio();
    }
    else if (!this.transcoding) {
      // back to the file itself, where it was
      this.seekAfterLoad = at;
      this.moviePlayer.src = this.server.media(this.link);
      this.moviePlayer.play()?.catch(() => {});
      this.applyCueShift();
    }
    else {
      // the converted stream from the keyframe before here (seekTo restarts it)
      if (!wasTranscoding) this.offset = 0;
      this.seekTo(at);
    }
    this.saveProgress();
  }

  // Subtitles to start with: saved here last time, else the profile's language
  private applyInitialSubtitles() {
    if (!this.tracks || this.selectedSubtitle || this.subtitleTrack) return;
    let saved = this.savedTracksHere()?.subtitle;
    let usable = this.tracks.subtitles.filter(t => MediaTracksService.usable(t));
    if (saved == 'off') return;
    let pick = usable.find(t => t.id == saved);
    let language = this.settings.value('player.subtitleLanguage');
    if (!pick && !saved && language != 'off') {
      let forcedOnly = this.settings.value('player.subtitleForcedOnly');
      let ofLanguage = usable.filter(t => t.language == language && (!forcedOnly || t.forced));
      pick = ofLanguage.find(t => !t.forced) || ofLanguage[0];
    }
    if (pick) this.showTrack(pick, false);
  }

  // A subtitle track of the file (its own stream, or a file of the torrent / folder)
  showTrack(track:MediaTrack, chosen = true) {
    if (!MediaTracksService.usable(track) || !this.moviePlayer) return;
    if (chosen) this.chosenSubtitle = track.id;
    this.subtitleTrack = track;
    this.selectedSubtitle = null;
    if (this.hls) {
      this.moviePlayer.querySelectorAll('track').forEach(t => t.remove());
      this.hls.subtitleTrack = track.index;
      this.hls.subtitleDisplay = true;
      return;
    }
    this.addTrack(this.mediaTracks.subtitleUrl(this.link, track), track.language || '', MediaTracksService.label(track));
  }

  // Another video of the torrent (an extra, another episode of the pack):
  // played over this one (Back returns here), remembered nowhere
  playVideo(track:MediaTrack) {
    if (!track.ref || track.current) return;
    this.saveProgress();
    let name = (track.name || '').split('/').pop();
    this.playbackService.play({
      title: this.playback.title,
      subtitle: name,
      source: { ref: track.ref, infoHash: this.torrentHash, path: track.name },
      imdbId: this.playback.imdbId,
      tracking: 'none',
    });
  }

  // ── HLS (a plugin's stream, format hls) ─────────────────────────────────

  // hls.js on the server's playlist (its parts come through the server too:
  // the shell sends this device's headers with every request)
  private attachHls() {
    loadHls().then(HlsPlayer => {
      if (this.destroyed) return;
      if (!HlsPlayer.isSupported()) return this.cantPlay("This stream can't be played here (no Media Source support)");
      let hls = this.hls = new HlsPlayer({ backBufferLength: 60, enableWorker: true });
      let recovered = false;
      hls.on(HlsPlayer.Events.LEVEL_LOADED, (_e, data) => this.zone.run(() => {
        if (data.details.live && !this.live) {
          this.live = true;
          this.updateTimeline();
        }
      }));
      hls.on(HlsPlayer.Events.AUDIO_TRACKS_UPDATED, () => this.zone.run(() => this.hlsTracks()));
      hls.on(HlsPlayer.Events.SUBTITLE_TRACKS_UPDATED, () => this.zone.run(() => this.hlsTracks()));
      hls.on(HlsPlayer.Events.AUDIO_TRACK_SWITCHED, () => this.zone.run(() => this.hlsTracks()));
      hls.on(HlsPlayer.Events.ERROR, (_e, data) => this.zone.run(() => {
        if (!data.fatal || this.destroyed) return;
        let status = (data.response as any)?.code;
        if (status == 503) return this.cantPlay('The server already plays as many live streams as it allows. Try again later');
        if (data.type == HlsPlayer.ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          return hls.recoverMediaError();
        }
        this.cantPlay(data.type == HlsPlayer.ErrorTypes.NETWORK_ERROR ? "The stream isn't answering. Try again later" :
          "This stream's format can't be played here");
      }));
      hls.loadSource(this.server.media(`${this.link}/index.m3u8`));
      hls.attachMedia(this.moviePlayer);
      this.moviePlayer.play()?.catch(() => {});
    }, () => this.cantPlay("The stream player couldn't be loaded"));
  }

  private cantPlay(message:string) {
    if (this.destroyed || !this.screen.active) return;
    this.leavePlayer();
    this.notificationService.sendNotification('error', message);
  }

  // The playlist's audio renditions and subtitles as the tracks panel's
  // (played natively: hls.js switches them)
  private hlsTracks() {
    let hls = this.hls;
    if (!hls) return;
    let languageName = (code:string) => {
      try { return code ? new Intl.DisplayNames(['en'], { type: 'language' }).of(code.split('-')[0]) : null; }
      catch (e) { return null; }
    };
    let track = (kind:'a' | 's', t:{ lang?:string, name?:string, default?:boolean, forced?:boolean }, i:number):MediaTrack => ({
      id: `${kind}:${i}`, source: 'embedded', index: i, language: t.lang ? t.lang.split('-')[0] : null, languageName: languageName(t.lang),
      title: t.name || null, default: !!t.default, forced: !!t.forced, play: kind == 'a' ? 'direct' : 'text',
    });
    let audio = hls.audioTracks.map((t, i) => track('a', t, i));
    let subtitles = hls.subtitleTracks.map((t, i) => track('s', t, i));
    this.tracks = { video: [], audio, subtitles, probed: true } as MediaTracks;
    this.audioTrack = audio[hls.audioTrack] || null;
    this.subtitleTrack = hls.subtitleTrack >= 0 ? subtitles[hls.subtitleTrack] || null : null;
  }

  openTracks() {
    if (!this.tracks) return this.openSettings('subtitles');
    this.tracksOpen = true;
  }

  // From the tracks panel: the subtitle sources' search (Settings › Subtitles)
  findSubtitles() {
    this.tracksOpen = false;
    setTimeout(() => this.openSettings('subtitles'));
  }

  get otherVideos():MediaTrack[] {
    return this.tracks ? this.tracks.video.filter(v => !v.current) : [];
  }

  // ── settings ──────────────────────────────────────────────────────────────

  // the CC button: on Subtitles; "•••": the tab used last
  openSettings(tab?:SettingsTab) {
    if (tab) this.tab = tab;
    this.settingsOpen = true;
    this.videoInfo = this.readVideoInfo();
    if (!this.subtitleProviders.length && this.subtitles === undefined) this.fetchSubs();
  }

  setVolume(percent:number) {
    this.muted = false;
    this.volume = percent;
    this.applyVolume();
    // a slider: stored once it stops moving
    this.settings.set('player.volume', percent, { debounceMs: 500 });
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolume();
  }

  private applyVolume() {
    if (!this.moviePlayer) return;
    this.moviePlayer.volume = this.volume / 100;
    this.moviePlayer.muted = this.muted;
  }

  setSpeed(rate:number) {
    this.speed = rate;
    if (!this.moviePlayer) return;
    // the default too: a new src (a transcoded seek) resets the rate to it
    this.moviePlayer.defaultPlaybackRate = rate;
    this.moviePlayer.playbackRate = rate;
  }

  // ── subtitles ─────────────────────────────────────────────────────────────

  fetchSubs(){
    this.subtitlesService.getProviders().subscribe(providers => {
      let kind = this.playback.season ? 'episode' : 'movie';
      this.subtitleProviders = providers.filter(p => p.enabled && p.supports[kind]);
      let preferred = this.subtitleProviders.find(p => p.id == this.settings.value('subtitles.provider'));
      this.loadSubtitles((preferred || this.subtitleProviders[0])?.id);
    } , () => {
      this.subtitles = [];
      this.subtitlesError = "The subtitle service isn't answering. Try again in a moment.";
    })
  }

  switchSubtitleProvider(id:string){
    if (!id || id == this.subtitleProvider) return;
    // the profile's subtitle source from now on
    this.settings.set('subtitles.provider', id);
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
    this.subtitleTrack = null;
    // a subtitle from a provider can't be found again later: nothing saved
    this.chosenSubtitle = null;
    this.addTrack(this.subtitlesService.fileUrl(subtitle), subtitle.language, subtitle.languageName);
  }

  // One <track> at a time, its cues shifted like the others
  private addTrack(src:string, language:string, label:string) {
    this.moviePlayer.querySelectorAll('track').forEach(track => track.remove());
    let track = document.createElement('track');
    track.kind = 'subtitles';
    track.srclang = language;
    track.label = label;
    track.src = src;
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
    this.subtitleTrack = null;
    this.chosenSubtitle = 'off';
    if (this.hls) this.hls.subtitleTrack = -1;
    this.moviePlayer?.querySelectorAll('track').forEach(track => track.remove());
  }

  setSubtitleSize(key:string) {
    this.subtitleSize = key;
    this.applySubtitleSize();
    this.settings.set('subtitles.size', key as SettingValues['subtitles.size'], { debounceMs: 500 });
  }

  private applySubtitleSize() {
    let size = SUBTITLE_SIZES.find(s => s.key == this.subtitleSize) || SUBTITLE_SIZES[1];
    this.host.nativeElement.style.setProperty('--px-subtitle-size', `var(${size.token})`);
  }

  setSubtitleDelay(seconds:number) {
    this.subtitleDelay = Math.round(seconds * 10) / 10;
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
