// A plugin's embed source (provider youtube): YouTube's IFrame player, in the
// server's page /embed/youtube framed by the player (YouTube's embeds need a
// referring page; this app is a file:// document, which sends none). The page
// has no controls of YouTube's: this class stands in for the player's <video>
// (the little of HTMLVideoElement the player uses: time, duration, paused,
// buffered, volume, rate, play / pause and its events), so the player's own
// controls, timeline, scrubbing, media keys and remote commands drive it.
//
// It talks to the page with postMessage (docs/api/plugins.md, "Embedded
// videos"): commands out, the page's state in (every 250 ms and on every
// change). Only messages of that frame are read. The frame never has the
// keyboard focus (tabindex -1, no pointer events): keys stay the app's. Its
// requests to the server carry no token (the shell sends it only from the
// app's top frame, electron/auth.js).

/** YouTube's error codes, in the player's words */
export function embedErrorText(code:number):string {
  switch (code) {
    case 2: return "This video's address isn't right";
    case 5: return "YouTube's player can't play this video here";
    case 100: return 'This video was removed or is private';
    case 101: case 150: return "The video's owner doesn't allow it to play outside YouTube";
    case 153: return "YouTube's player refused to start (no referring page)";
    default: return "YouTube's player couldn't play this video";
  }
}

type EmbedState = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'cued';

export class EmbedVideo extends EventTarget {
  paused = true;
  duration = NaN;
  readyState = 0;
  defaultPlaybackRate = 1;
  readonly textTracks:any = [];
  readonly audioTracks:any = undefined;
  private time = 0;
  private loaded = 0;
  private state:EmbedState = 'unstarted';
  private rate = 1;
  private vol = 1;
  private mute = false;
  private ready = false;
  private wantPlay = true;           // autoplay: the page starts it
  private seekingTo:number | null = null;
  private volumeTimer:any = null;
  private stopped = false;
  private readonly onMessage = (e:MessageEvent) => this.message(e);

  /** `onError(code)`: YouTube refused or failed (the player leaves with embedErrorText) */
  constructor(private frame:HTMLIFrameElement, private onError:(code:number) => void) {
    super();
    window.addEventListener('message', this.onMessage);
  }

  // ── HTMLVideoElement's part the player uses ──────────────────────────────

  get currentTime():number { return this.seekingTo ?? this.time; }
  set currentTime(t:number) {
    if (!isFinite(t)) return;
    this.seekingTo = Math.max(0, t);
    this.time = this.seekingTo;
    this.send({ cmd: 'seek', t: this.seekingTo });
    this.fire('seeking');
    this.fire('timeupdate');
  }

  get playbackRate():number { return this.rate; }
  set playbackRate(r:number) {
    if (!isFinite(r) || r <= 0) return;
    this.rate = r;
    this.send({ cmd: 'rate', rate: r });
  }

  get volume():number { return this.vol; }
  set volume(v:number) { this.vol = Math.max(0, Math.min(1, v)); this.sendVolume(); }
  get muted():boolean { return this.mute; }
  set muted(m:boolean) { this.mute = !!m; this.sendVolume(); }

  /** what's loaded, from the start (YouTube tells a fraction) */
  get buffered():TimeRanges {
    let end = isFinite(this.duration) ? this.loaded * this.duration : 0;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end } as TimeRanges;
  }

  play():Promise<void> {
    this.wantPlay = true;
    this.send({ cmd: 'play' });
    return Promise.resolve();
  }

  pause() {
    this.wantPlay = false;
    this.send({ cmd: 'pause' });
  }

  // the player's teardown (stopVideo): no tracks here; removing src ends it
  querySelectorAll(_selector:string):Element[] { return []; }
  appendChild(node:any) { return node; }
  getAttribute(name:string):string | null { return name == 'src' && !this.stopped ? 'embed' : null; }
  removeAttribute(name:string) { if (name == 'src') this.stop(); }
  set src(_value:string) { /* the frame's page is the source */ }
  load() { }

  /** The frame stops: its page unloaded, no more messages read */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.volumeTimer);
    window.removeEventListener('message', this.onMessage);
    try { this.frame.src = 'about:blank'; } catch (e) { }
  }

  // ── the page ──────────────────────────────────────────────────────────────

  private send(msg:object) {
    if (!this.ready || this.stopped) return;
    this.frame.contentWindow?.postMessage({ playpex: 'embed', ...msg }, '*');
  }

  // volume and mute together, at most every 100 ms (a held slider)
  private sendVolume() {
    clearTimeout(this.volumeTimer);
    this.volumeTimer = setTimeout(() => this.send({ cmd: 'volume', volume: Math.round(this.vol * 100), muted: this.mute }), 100);
  }

  private fire(name:string) {
    this.dispatchEvent(new Event(name));
  }

  private message(e:MessageEvent) {
    let m = e.data;
    if (this.stopped || e.source !== this.frame.contentWindow || !m || m.playpex !== 'embed') return;
    if (m.type == 'ready') {
      this.ready = true;
      // what the player set before the page was there
      this.send({ cmd: 'volume', volume: Math.round(this.vol * 100), muted: this.mute });
      if (this.rate != 1) this.send({ cmd: 'rate', rate: this.rate });
      if (!this.wantPlay) this.send({ cmd: 'pause' });
      return;
    }
    if (m.type == 'error') return this.onError(Number(m.code) || 0);
    if (m.type == 'state') this.update(m);
  }

  private update(m:{ state:EmbedState, time:number, duration:number, loaded:number, rate:number }) {
    let previous = this.state;
    let duration = Number(m.duration) || 0;
    if (duration > 0 && duration !== this.duration) {
      let first = !isFinite(this.duration);
      this.duration = duration;
      this.fire('durationchange');
      if (first) {
        this.readyState = 1;
        this.fire('loadedmetadata');
      }
    }
    let loaded = Math.max(0, Math.min(1, Number(m.loaded) || 0));
    if (loaded != this.loaded) {
      this.loaded = loaded;
      this.fire('progress');
    }
    let time = Number(m.time) || 0;
    // a seek is done when YouTube's time got there
    if (this.seekingTo !== null && (Math.abs(time - this.seekingTo) < 1.5 || m.state == 'playing' && previous == 'buffering')) {
      this.seekingTo = null;
      this.fire('seeked');
    }
    if (this.seekingTo === null && time != this.time) {
      this.time = time;
      this.fire('timeupdate');
    }
    if (m.rate && m.rate != this.rate) this.rate = m.rate;
    this.state = m.state;
    if (m.state == previous) return;
    switch (m.state) {
      case 'playing':
        if (this.readyState < 4) {
          this.readyState = 4;
          this.fire('canplay');
        }
        if (this.paused) {
          this.paused = false;
          this.fire('play');
        }
        this.fire('playing');
        break;
      case 'paused':
      case 'cued':
        if (!this.paused) {
          this.paused = true;
          this.fire('pause');
        }
        break;
      case 'buffering':
        this.fire('waiting');
        break;
      case 'ended':
        if (!this.paused) {
          this.paused = true;
          this.fire('pause');
        }
        this.fire('ended');
        break;
    }
  }
}
