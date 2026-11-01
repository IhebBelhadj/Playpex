import type { RemoteMessage, RemoteRtcMessage, RemoteSignal } from '@playpex/protocol';

type PointerMessage = Extract<RemoteMessage, { type:'pointer' }>;

const MOVES = 'moves';
const INPUT = 'input';
const STEP_MAX = 4000;

// The pointer straight from the controller (docs/api/remote.md, "Over
// WebRTC"): the dashboard offers, this answers, through `signal` messages the
// server relays on the remote socket. Two data channels the controller opens:
// `moves` (unordered, never resent: running totals of its moves, so a lost
// one costs nothing, the next carries the sum) and `input` (ordered and
// reliable: buttons and wheel, with the totals so they land where the pointer
// is). The cursor goes back on `moves`. Over Wi-Fi a lost packet then delays
// nothing after it, unlike the socket's TCP. Everything arrives as the
// socket's pointer messages (`onPointer`); the server never sees them, so
// they're checked here like it checks the socket's.
export class RemoteRtc {
  private pc:RTCPeerConnection | null = null;
  private moves:RTCDataChannel | null = null;
  private chain:Promise<unknown> = Promise.resolve();
  // the controller's totals applied so far
  private seq = 0;
  private sumX = 0;
  private sumY = 0;

  constructor(private signal:(data:RemoteSignal) => void, private onPointer:(msg:PointerMessage) => void) { }

  static get supported() {
    return typeof RTCPeerConnection != 'undefined';
  }

  /** the moves channel is open: the cursor goes back on it */
  get open() {
    return this.moves?.readyState == 'open';
  }

  handle(data:RemoteSignal) {
    if ('description' in data) {
      if (data.description.type != 'offer') return;
      // a new offer: the controller started again
      this.close();
      // the controller's totals start again with each connection
      this.seq = this.sumX = this.sumY = 0;
      let pc = this.pc = new RTCPeerConnection({ iceServers: [] });
      pc.onicecandidate = e => this.signal({ candidate: e.candidate ? e.candidate.toJSON() as any : null });
      pc.ondatachannel = e => this.channel(e.channel);
      pc.onconnectionstatechange = () => {
        if (this.pc === pc && (pc.connectionState == 'failed' || pc.connectionState == 'closed')) this.close();
      };
      let offer = data.description;
      this.chain = this.chain
        .then(() => pc.setRemoteDescription(offer))
        .then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => {
          let local = pc.localDescription;
          if (this.pc === pc && local) this.signal({ description: { type: 'answer', sdp: local.sdp } });
        })
        .catch(() => { if (this.pc === pc) this.close(); });
    } else if ('candidate' in data && this.pc) {
      let pc = this.pc, candidate = data.candidate;
      this.chain = this.chain
        .then(() => pc.addIceCandidate(candidate || undefined))
        .catch(() => undefined);
    }
  }

  sendCursor(x:number, y:number) {
    if (!this.open) return false;
    this.moves.send(JSON.stringify({ t: 'cursor', x, y } as RemoteRtcMessage));
    return true;
  }

  close() {
    let pc = this.pc;
    this.pc = null;
    this.moves = null;
    if (pc) {
      pc.onicecandidate = pc.ondatachannel = pc.onconnectionstatechange = null;
      pc.close();
    }
  }

  private channel(channel:RTCDataChannel) {
    let pc = this.pc;
    if (channel.label == MOVES) {
      channel.onopen = () => {
        if (this.pc !== pc) return;
        this.moves = channel;
      };
      channel.onclose = () => { if (this.moves === channel) this.moves = null; };
    } else if (channel.label != INPUT) {
      channel.close();
      return;
    }
    channel.onmessage = e => {
      if (this.pc !== pc || typeof e.data != 'string' || e.data.length > 512) return;
      let msg:RemoteRtcMessage;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg || !num(msg['s']) || !num(msg['x']) || !num(msg['y'])) return;
      if (channel.label == MOVES && msg.t == 'move') {
        this.catchUp(msg.s, msg.x, msg.y);
      } else if (channel.label == INPUT && msg.t == 'pointer') {
        this.catchUp(msg.s, msg.x, msg.y);
        if (msg.phase == 'wheel') {
          if (num(msg.dx) && num(msg.dy)) this.onPointer({ type: 'pointer', phase: 'wheel', dx: clamp(msg.dx), dy: clamp(msg.dy) });
        } else if ((msg.phase == 'down' || msg.phase == 'up') && ['left', 'right', 'middle', 'back'].includes(msg.button)) {
          this.onPointer({ type: 'pointer', phase: msg.phase, button: msg.button });
        }
      }
    };
  }

  // Moves the pointer by what the controller moved since the totals last
  // applied; older totals (a late packet) are ignored
  private catchUp(s:number, x:number, y:number) {
    if (s <= this.seq) return;
    let dx = clamp(x - this.sumX), dy = clamp(y - this.sumY);
    this.seq = s;
    this.sumX = x;
    this.sumY = y;
    if (dx || dy) this.onPointer({ type: 'pointer', phase: 'move', dx, dy });
  }
}

function num(v:unknown):v is number {
  return typeof v == 'number' && isFinite(v);
}

function clamp(v:number) {
  return Math.max(-STEP_MAX, Math.min(STEP_MAX, v));
}
