import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { RemoteMessage } from '@playpex/protocol';
import { desktop, RemoteInput } from '../desktop';
import { MediaKeys } from '../media-keys.service';
import { ServerService } from '../server.service';
import { SettingsService } from '../settings.service';
import { RemoteRtc } from './remote-rtc';

export interface RemotePointer {
  x:number;
  y:number;
  visible:boolean;
  pressed:boolean;
}

/** A text field the controller can fill (the on-screen keyboard while it's open) */
export interface RemoteTextField {
  readonly value:string;
  readonly title:string;
  readonly placeholder:string;
  readonly maxLength:number;
  readonly kind:'text' | 'search' | 'address';
  /** the controller's text, the whole field (never sent back); submit: its Done */
  remoteValue(value:string, submit:boolean):void;
}

const POINTER_IDLE_MS = 3000;
// the field's text sent to the controller at most this often while it's typed on the TV
const FIELD_EVERY_MS = 150;
const CURSOR_EVERY_MS = 33;

// Remote control from the server (docs/remote-control-plan.md §2.6): this
// device is a **target** of the server's remote socket (`<api>/remote`, the
// shell adds the device's headers like to any request). The admin's keys,
// text and pointer arrive here and go to the main process
// (`window.playpex.remote.input`, apps/tv/electron/remote.js), which injects
// them into this window as real input: every page reacts as to a local
// keyboard and mouse. Not in a browser (`ng serve`: nothing can inject).
//
// Off when the device setting `remote.allowed` is off. While a controller is
// connected, `controller$` names it (the <remote-overlay> badge); the remote
// pointer is drawn by the overlay (`pointer$`), since injected mouse events
// don't move the system cursor.
//
// The pointer may also come straight from the dashboard over WebRTC
// (`RemoteRtc`, set up through `signal` messages on this socket): on a lossy
// Wi-Fi a lost packet then holds nothing up behind it. This socket stays the
// fallback, and carries keys and text.
//
// Text fields: while an on-screen keyboard is open (`openField`, from
// <text-keyboard>) the controller gets a `field` message (its text, title,
// kind) and again when the text changes here; it answers with the whole text
// (its phone's own keyboard), applied to that field only (`id`), never echoed.
@Injectable({
  providedIn: 'root'
})
export class RemoteControl implements OnDestroy {

  /** who controls this device now, null when nobody */
  readonly controller$ = new BehaviorSubject<string | null>(null);
  readonly pointer$ = new BehaviorSubject<RemotePointer>({ x: 0, y: 0, visible: false, pressed: false });

  private socket:WebSocket | null = null;
  private wanted = false;
  private retryMs = 2000;
  private retryTimer:any = null;
  private idleTimer:any = null;
  private cursorTimer:any = null;
  private moveFrame = 0;
  private x = -1;
  private y = -1;
  private onResize = () => this.hello();
  private field:RemoteTextField | null = null;
  private fieldId = '';
  private fieldCount = 0;
  private fieldTimer:any = null;
  private rtc = new RemoteRtc(data => this.send({ type: 'signal', data }), msg => this.pointer(msg));

  constructor(private server:ServerService, private settings:SettingsService, private mediaKeys:MediaKeys, private zone:NgZone) { }

  // AppComponent, once
  start() {
    if (!this.server.connected || !desktop()?.remote || typeof WebSocket == 'undefined') return;
    this.settings.changes('remote.allowed').subscribe(allowed => {
      this.wanted = allowed !== false;
      if (this.wanted) this.open();
      else this.close();
    });
    window.addEventListener('resize', this.onResize);
  }

  ngOnDestroy(): void {
    this.wanted = false;
    this.close();
    window.removeEventListener('resize', this.onResize);
  }

  private open() {
    if (this.socket || !this.wanted) return;
    let url = new URL(`${this.server.api}/remote`);
    url.protocol = url.protocol == 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('device', this.server.deviceId);
    this.zone.runOutsideAngular(() => {
      let socket = this.socket = new WebSocket(url.toString());
      socket.onopen = () => {
        this.retryMs = 2000;
        this.hello();
        // a keyboard already open: the server keeps it for the controller
        if (this.field) this.sendField();
      };
      socket.onmessage = message => {
        let msg:RemoteMessage;
        try { msg = JSON.parse(message.data); } catch (e) { return; }
        if (msg && typeof msg.type == 'string') this.receive(msg);
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.rtc.close();
        this.zone.run(() => this.controlledBy(null));
        if (this.wanted) {
          this.retryTimer = setTimeout(() => this.open(), this.retryMs);
          this.retryMs = Math.min(30000, this.retryMs * 2);
        }
      };
    });
  }

  private close() {
    clearTimeout(this.retryTimer);
    cancelAnimationFrame(this.moveFrame);
    this.moveFrame = 0;
    let socket = this.socket;
    this.socket = null;
    socket?.close();
    this.rtc.close();
    this.controlledBy(null);
  }

  private send(msg:RemoteMessage) {
    if (this.socket?.readyState == WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private hello() {
    this.send({ type: 'hello', role: 'target', capabilities: { keyboard: true, pointer: true, text: true, rtc: RemoteRtc.supported, field: true },
      screen: { width: window.innerWidth, height: window.innerHeight } });
  }

  private input(input:RemoteInput) {
    desktop()?.remote?.input(input);
  }

  private receive(msg:RemoteMessage) {
    switch (msg.type) {
      case 'state':
        // the controller left: its connection goes with it
        if (!msg.connected) this.rtc.close();
        this.zone.run(() => this.controlledBy(msg.connected ? msg.controller?.name || 'the dashboard' : null));
        break;
      case 'signal':
        if (msg.data && typeof msg.data == 'object') this.rtc.handle(msg.data);
        break;
      case 'key':
        // keys Chromium has no key code for: straight to the media keys
        if (msg.key == 'MediaFastForward' || msg.key == 'MediaRewind') {
          if (msg.phase == 'down') this.mediaKeys.emit(msg.key == 'MediaFastForward' ? 'forward' : 'rewind');
          return;
        }
        this.input({ kind: 'key', phase: msg.phase, key: msg.key, modifiers: msg.modifiers, repeat: msg.repeat });
        break;
      case 'text':
        this.input({ kind: 'text', text: msg.text });
        break;
      case 'pointer':
        this.pointer(msg);
        break;
      case 'field':
        // the controller's text for the field open now (another one's was dropped by the server; checked again)
        if ('value' in msg && !('open' in msg) && this.field && msg.id == this.fieldId && typeof msg.value == 'string') {
          let field = this.field;
          this.zone.run(() => field.remoteValue(msg.value, msg.submit === true));
        }
        break;
    }
  }

  // ── text fields ───────────────────────────────────────────────────────────

  /** an on-screen keyboard opened: the controller may type into it */
  openField(field:RemoteTextField) {
    this.field = field;
    this.fieldId = 'f' + (++this.fieldCount);
    this.sendField();
  }

  /** its text changed here (keys on the TV): the controller's copy follows */
  fieldChanged(field:RemoteTextField) {
    if (field !== this.field || this.fieldTimer) return;
    this.fieldTimer = setTimeout(() => {
      this.fieldTimer = null;
      if (field === this.field) this.sendField();
    }, FIELD_EVERY_MS);
  }

  closeField(field:RemoteTextField) {
    if (field !== this.field) return;
    clearTimeout(this.fieldTimer);
    this.fieldTimer = null;
    this.send({ type: 'field', open: false, id: this.fieldId });
    this.field = null;
  }

  private sendField() {
    let f = this.field;
    if (!f) return;
    this.send({ type: 'field', open: true, id: this.fieldId, value: f.value, title: f.title || undefined,
      placeholder: f.placeholder || undefined, maxLength: f.maxLength, kind: f.kind });
  }

  private pointer(msg:Extract<RemoteMessage, { type:'pointer' }>) {
    let w = window.innerWidth, h = window.innerHeight;
    if (this.x < 0) {
      this.x = w / 2;
      this.y = h / 2;
    }
    if (msg.phase == 'move') {
      if ('x' in msg) {
        this.x = msg.x * w;
        this.y = msg.y * h;
      } else {
        this.x = Math.max(0, Math.min(w - 1, this.x + msg.dx));
        this.y = Math.max(0, Math.min(h - 1, this.y + msg.dy));
      }
      // moves arrive up to 60 a second: one injected (and drawn) per frame, at
      // the latest position, so a busy renderer never builds a queue of them
      if (!this.moveFrame) this.moveFrame = requestAnimationFrame(() => this.flushMove());
      return;
    }
    // a button or the wheel acts where the pointer is now
    this.flushMove();
    if (msg.phase == 'wheel') {
      this.input({ kind: 'mouse', phase: 'wheel', x: this.x, y: this.y, dx: msg.dx, dy: msg.dy });
    } else if (msg.button == 'back') {
      // the mouse's back button: the app's Back (PointerService does the same for a real one)
      this.input({ kind: 'key', phase: msg.phase, key: 'Escape' });
    } else {
      this.input({ kind: 'mouse', phase: msg.phase, x: this.x, y: this.y, button: msg.button });
    }
    this.showPointer(msg.phase == 'down' ? true : msg.phase == 'up' ? false : this.pointer$.value.pressed);
  }

  private flushMove() {
    if (!this.moveFrame) return;
    cancelAnimationFrame(this.moveFrame);
    this.moveFrame = 0;
    this.input({ kind: 'mouse', phase: 'move', x: this.x, y: this.y });
    this.reportCursor();
    this.showPointer(this.pointer$.value.pressed);
  }

  // Outside Angular's zone (the socket was opened there): the overlay draws the
  // pointer itself, so a move never runs the whole app's change detection
  private showPointer(pressed:boolean) {
    this.pointer$.next({ x: this.x, y: this.y, visible: true, pressed });
    document.body.classList.add('remote-pointer');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.hidePointer(), POINTER_IDLE_MS);
  }

  private hidePointer() {
    clearTimeout(this.idleTimer);
    document.body.classList.remove('remote-pointer');
    if (this.pointer$.value.visible) this.pointer$.next({ ...this.pointer$.value, visible: false, pressed: false });
  }

  // where the pointer is, for the controller's touchpad dot (≤ 30 a second)
  private reportCursor() {
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      let x = this.x / window.innerWidth, y = this.y / window.innerHeight;
      if (!this.rtc.sendCursor(x, y)) this.send({ type: 'cursor', x, y });
    }, CURSOR_EVERY_MS);
  }

  private controlledBy(name:string | null) {
    if (this.controller$.value !== name) this.controller$.next(name);
    if (!name) this.hidePointer();
  }
}
