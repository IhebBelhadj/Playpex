import { AfterViewInit, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { SplashService } from '../splash.service';
import { ServerService } from '../server.service';
import { connection, useBrowserServer } from '../server-config';
import {
  ConnectedServer, ConnectionState, desktop, DiscoveredServer, LocalServerStatus, PairingCode, PairingUpdate, UpdaterState
} from '../desktop';
import { LayerRef, LayerStack, Navigator, useScreen } from '../nav/public-api';

const DOWNLOAD_URL = 'github.com/IhebBelhadj/Playpex/releases';
const API_VERSION = 1;   // @playpex/protocol API_VERSION
const SCAN_MS = 6000;

type Detail = {
  title:string;
  facts:string[];
  text:string[];
  action:string | null;
};

type PairingView = {
  server:ConnectedServer;
  code:PairingCode | null;
  state:'requesting' | PairingUpdate['state'];
  message:string | null;
  secondsLeft:number;
};

// /connect — which Playpex server this app uses (docs/server-separation-plan.md §10.2).
// Shown when there is none (ServerGuard: none found, not paired, removed,
// incompatible…) and from the menu's "Server" item. Lists the servers found on
// the network (the shell's discovery: mDNS + UDP + this machine), "Enter
// address" (on-screen keyboard), "Rescan". A server on this machine needs no
// pairing; one on another machine starts the device flow: the code, the
// /link address and a QR code, until the admin approves it. Choosing a server
// makes the shell store it and reload the app. An installed Playpex Media
// Server that isn't running is started for the user.
// A root screen (core.connect, src/app/nav). Back: the pairing panel (a layer)
// closes; opened from the menu → where it came from; else the power menu.
// Payload (browser dev): { reason, code } when the server refused this device.
@Component({
  selector: 'app-connect-page',
  templateUrl: './connect-page.component.html',
  styleUrls: ['./connect-page.component.scss']
})
export class ConnectPageComponent implements OnInit, AfterViewInit, OnDestroy {

  readonly downloadUrl = DOWNLOAD_URL;
  readonly bridge = desktop();
  readonly state:ConnectionState = connection;

  servers:DiscoveredServer[] = [];
  scanning = true;
  local:LocalServerStatus | null = null;
  startingLocal = false;
  message = '';
  typing = false;
  address = '';
  probing = false;
  pairing:PairingView | null = null;
  updater:UpdaterState | null = null;
  focusedKey:string | null = null;   // what the detail panel describes

  private splashSub:Subscription;
  private pairingLayer:LayerRef | null = null;
  private screen = useScreen<{}, { reason:string, code?:string }>();
  private unsubscribes:Array<() => void> = [];
  private timers:any[] = [];
  private countdown:any;
  private autoStarted = false;
  private leaving = false;
  private touched = false;      // the user moved: list updates don't move the focus
  private keyListener = () => this.touched = true;

  constructor(
    private navigator:Navigator,
    private layers:LayerStack,
    private splashService:SplashService,
    private server:ServerService,
    private zone:NgZone,
  ) {
    // browser dev: a refused server navigates here with the reason
    const nav = this.screen.payload;
    if (nav && !this.bridge && this.state) {
      this.state = Object.assign({}, this.state, { reason: nav['reason'], detail: nav['code'] || this.state.server?.name });
    }
  }

  // ── what the page says ──────────────────────────────────────────────────

  get heading():string {
    const s = this.state;
    switch (s?.reason) {
      case 'unreachable': return `Can't reach ${s.detail}`;
      case 'revoked': return `This device was removed from ${s.detail}`;
      case 'pairing': return `Pair with ${s.candidate?.name || 'the server'}`;
      case 'incompatible':
        return s.detail == 'SERVER_TOO_OLD' ? `Update ${s.candidate?.name || 'the server'}` : 'Update Playpex TV';
    }
    return 'Choose a Playpex server';
  }

  get hint():string {
    const s = this.state;
    switch (s?.reason) {
      case 'unreachable': return 'It may be off, or on another network. Choose it again once it\'s back, or pick another server.';
      case 'revoked': return 'Its admin removed it from the server\'s devices. Pair it again to keep watching.';
      case 'pairing': return 'This device needs the server admin\'s approval once.';
      case 'incompatible':
        return s.detail == 'SERVER_TOO_OLD'
          ? 'This app needs a newer Playpex Media Server. Update it from its tray icon or its dashboard, then choose it again.'
          : `${s.candidate?.name || 'This server'} needs a newer version of this app.`;
    }
    return this.server.connected
      ? `Watching from ${this.server.name}. Pick another server, or go back.`
      : 'Pick the Playpex Media Server this TV plays from.';
  }

  get needsAppUpdate():boolean {
    return this.state?.reason == 'incompatible' && this.state.detail != 'SERVER_TOO_OLD';
  }

  get showStartLocal():boolean {
    return !!this.local?.installed && !this.servers.some(s => s.local);
  }

  get nothingFound():boolean {
    return !this.scanning && !this.servers.length && !this.local?.installed;
  }

  get updateLabel():string {
    const u = this.updater;
    switch (u?.state) {
      case 'checking': return 'Checking for updates…';
      case 'available':
      case 'downloading': return `Downloading ${u.version || 'the update'}… ${u.percent || 0}%`;
      case 'downloaded': return `Restart to install ${u.version}`;
      case 'none': return 'No update yet: check again';
      case 'error': return 'Update failed: try again';
      case 'unsupported': return 'Updates: install the new version by hand';
    }
    return 'Check for updates';
  }

  status(server:DiscoveredServer):string {
    if (!server.compatible) return 'Update needed';
    if (server.current && this.server.connected) return 'Watching now';
    if (server.local) return 'This computer';
    if (server.paired) return 'Paired';
    return 'Needs pairing';
  }

  // the status mark's style
  mark(server:DiscoveredServer):string {
    if (!server.compatible) return 'warn';
    if (server.current && this.server.connected) return 'live';
    if (server.local || server.paired) return 'ready';
    return 'locked';
  }

  get scanLabel():string {
    if (this.scanning) return 'Looking for servers on this network…';
    if (!this.servers.length && !this.showStartLocal) return 'No server found on this network';
    return '';
  }

  // The panel beside the list: what the focused row is, and what OK does
  get detail():Detail | null {
    const key = this.focusedKey;
    const found = key && this.servers.find(s => s.id == key);
    if (found) return this.serverDetail(found);
    switch (key) {
      case 'startLocal': return {
        title: 'Playpex Media Server',
        facts: ['On this computer' + (this.local?.kind == 'development' ? ' (development)' : '')],
        text: ['It\'s installed here but not running. Start it to watch from this computer. No pairing needed.'],
        action: this.startingLocal ? null : 'Start it',
      };
      case 'address': return {
        title: 'Enter address',
        facts: [],
        text: ['For a server this TV can\'t find by itself, such as one on another network.', 'Type its IP address or name, for example 192.168.1.20 or nas.local:28470.'],
        action: 'Type the address',
      };
      case 'rescan': return {
        title: 'Search again',
        facts: [],
        text: ['Looks for Playpex Media Servers on this network again. A server that was just turned on can take a few seconds to show up.'],
        action: 'Search',
      };
      case 'update': return {
        title: 'Update Playpex TV',
        facts: this.state?.version ? ['This TV has Playpex TV ' + this.state.version] : [],
        text: [`${this.state?.candidate?.name || 'This server'} needs a newer version of this app.`],
        action: this.updateLabel,
      };
    }
    return null;
  }

  private serverDetail(s:DiscoveredServer):Detail {
    const facts = [this.address0(s), 'Playpex Media Server ' + s.version];
    if (!s.compatible) {
      const appTooOld = (s.minApiVersion || s.apiVersion) > API_VERSION;
      return {
        title: s.name, facts,
        text: [appTooOld
          ? 'This server needs a newer version of Playpex TV. Update this app to use it.'
          : 'This server is too old for this app. Update it from its tray icon or its dashboard, then search again.'],
        action: null,
      };
    }
    if (s.current && this.server.connected) return {
      title: s.name, facts,
      text: ['You\'re watching from this server now.'],
      action: 'Back to profiles',
    };
    if (s.local) return {
      title: s.name, facts,
      text: ['Runs on this computer, so no pairing is needed.'],
      action: 'Watch from this server',
    };
    if (s.paired) return {
      title: s.name, facts,
      text: ['This TV is already paired with it.'],
      action: 'Watch from this server',
    };
    return {
      title: s.name, facts,
      text: ['The first time, the server\'s admin approves this TV. It only takes a code and a minute.'],
      action: 'Pair this TV',
    };
  }

  address0(server:DiscoveredServer):string {
    return server.local ? 'On this computer' : (server.addresses[0] || '') + (server.port != 28470 ? ':' + server.port : '');
  }

  splitCode(code:string):string {
    return code && code.length == 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
  }

  codeChars(code:string):string[] {
    return (code || '').split('');
  }

  timeLeft(seconds:number):string {
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // ── life cycle ──────────────────────────────────────────────────────────

  ngOnInit(): void {
    if (!this.bridge) {
      this.scanning = false;
      return;
    }
    const inZone = <T>(fn:(value:T) => void) => (value:T) => this.zone.run(() => fn(value));
    this.unsubscribes.push(
      this.bridge.discovery.onChange(inZone(servers => this.setServers(servers))),
      this.bridge.pairing.onUpdate(inZone(update => this.onPairingUpdate(update))),
      this.bridge.updater.onChange(inZone(state => this.updater = state)),
    );
    this.bridge.discovery.start().then(inZone(servers => this.setServers(servers)));
    this.timers.push(setTimeout(() => this.zone.run(() => {
      this.scanning = false;
      this.focusDefault();
    }), SCAN_MS));
    this.bridge.localServer.status().then(inZone(status => {
      this.local = status;
      this.maybeStartLocal();
    }));
    this.bridge.updater.state().then(inZone(state => this.updater = state));

    // Asked to pair (a server on another machine with no token yet, or
    // loopback pairing turned on): start right away
    if (this.state?.reason == 'pairing' && this.state.candidate) {
      this.startPairing(this.state.candidate);
    }
  }

  ngAfterViewInit(): void {
    // (the keyboard and the pairing panel are layers: their own keys)
    this.screen.onSelect(active => {
      if (this.leaving || !this.splashService.cleared) return;
      const action = active?.dataset['action'];
      if (action == 'server') this.choose(this.servers.find(s => s.id == active.dataset['id']));
      if (action == 'startLocal') this.startLocal();
      if (action == 'address') this.typing = true;
      if (action == 'rescan') this.rescan();
      if (action == 'update') this.update();
    });
    // connecting, or under the splash: stay
    const busy = () => this.leaving || !this.splashService.cleared;
    this.screen.onBack(busy);
    this.screen.onLeave(busy);

    document.addEventListener('keydown', this.keyListener);
    if (!this.splashService.cleared) {
      this.splashSub = this.splashService.splashExecuteCommand().subscribe(instruction => {
        if (instruction == 'clearSplash') this.focusDefault();
      });
    }
    this.focusDefault();
  }

  ngOnDestroy(): void {
    this.pairingLayer?.close(undefined, false);
    this.splashSub?.unsubscribe();
    this.unsubscribes.forEach(off => off());
    this.timers.forEach(t => clearTimeout(t));
    document.removeEventListener('keydown', this.keyListener);
    clearInterval(this.countdown);
    if (this.bridge) {
      this.bridge.discovery.stop();
      if (this.pairing) this.bridge.pairing.cancel();
    }
  }

  // ── servers ─────────────────────────────────────────────────────────────

  private setServers(servers:DiscoveredServer[]) {
    const first = !this.servers.length && servers.length;
    this.servers = servers;
    if (first && !this.touched) this.focusDefault(undefined, true);
  }

  rescan() {
    this.message = '';
    this.scanning = true;
    this.bridge?.discovery.rescan();
    this.timers.push(setTimeout(() => this.zone.run(() => this.scanning = false), SCAN_MS));
  }

  choose(server:DiscoveredServer | ConnectedServer | undefined) {
    if (!server) return;
    this.message = '';
    const found = server as DiscoveredServer;
    if (found.compatible === false) {
      this.message = this.serverDetail(found).text[0];
      return;
    }
    // the server in use, at the address in use (a typed address of the same
    // server is a choice of that address)
    if (found.current && this.server.connected && sameOrigin(server.url, this.server.url)) {
      this.navigator.reset({ screen: 'core.profiles' });
      return;
    }
    if (found.needsPairing) {
      this.startPairing(server);
      return;
    }
    this.connect(server);
  }

  // The shell stores the choice and reloads the app on success
  private connect(server:ConnectedServer) {
    this.leaving = true;
    this.message = `Connecting to ${server.name}…`;
    this.bridge.connection.choose({ id: server.id, name: server.name, url: server.url }).then(state => this.zone.run(() => {
      // still here: it couldn't be used after all
      this.leaving = false;
      this.message = state.server ? '' : `Couldn't use ${server.name}.`;
    }), err => this.zone.run(() => {
      this.leaving = false;
      this.message = err?.message || `Couldn't connect to ${server.name}.`;
    }));
  }

  // An installed server that isn't running: start it when nothing else is in
  // use (first run, or the last server was this machine's)
  private maybeStartLocal() {
    const reason = this.state?.reason;
    const wanted = reason == 'none' || (reason == 'unreachable' && this.state.candidate?.local);
    if (this.autoStarted || !wanted || !this.local?.installed) return;
    this.autoStarted = true;
    // give discovery a moment: it may be running after all
    this.timers.push(setTimeout(() => this.zone.run(() => {
      if (!this.servers.some(s => s.local)) this.startLocal();
    }), 1500));
  }

  startLocal() {
    if (this.startingLocal || !this.bridge) return;
    this.startingLocal = true;
    this.message = '';
    this.bridge.localServer.start().then(server => this.zone.run(() => {
      this.startingLocal = false;
      this.connect(server);
    }), err => this.zone.run(() => {
      this.startingLocal = false;
      this.message = cleanError(err) || 'Playpex Media Server didn\'t start.';
    }));
  }

  onAddressDone(text:string) {
    this.typing = false;
    this.address = text.trim();
    if (!this.address) return this.focusDefault();
    if (!this.bridge) {
      useBrowserServer(/^https?:\/\//.test(this.address) ? this.address : 'http://' + this.address);
      return;
    }
    this.probing = true;
    this.message = `Looking for a server at ${this.address}…`;
    this.bridge.discovery.probe(this.address).then(server => this.zone.run(() => {
      this.probing = false;
      this.message = '';
      if (!this.servers.some(s => s.id == server.id)) this.servers = [...this.servers, server];
      this.choose(server);
      if (!this.pairing && !this.leaving) this.focusServer(server.id);
    }), () => this.zone.run(() => {
      this.probing = false;
      this.message = `No Playpex server answered at ${this.address}.`;
      this.focusDefault('[data-action="address"]');
    }));
  }

  onAddressCancelled() {
    this.typing = false;
    this.focusDefault('[data-action="address"]');
  }

  update() {
    if (!this.bridge) return;
    if (this.updater?.state == 'downloaded') this.bridge.updater.install();
    else this.bridge.updater.check().then(state => this.zone.run(() => this.updater = state));
  }

  // ── pairing ─────────────────────────────────────────────────────────────

  startPairing(server:ConnectedServer) {
    if (!this.bridge) return;
    clearInterval(this.countdown);
    this.pairing = { server, code: null, state: 'requesting', message: null, secondsLeft: 0 };
    this.openPairingLayer();
    this.focusPairing('cancel');
    this.bridge.pairing.start({ id: server.id, name: server.name, url: server.url }).then(code => this.zone.run(() => {
      if (!this.pairing || this.pairing.server.id != server.id) return;
      this.pairing = Object.assign({}, this.pairing, { code, state: 'waiting', secondsLeft: code.expiresIn });
      this.countdown = setInterval(() => this.zone.run(() => {
        if (this.pairing && this.pairing.state == 'waiting' && this.pairing.secondsLeft > 0) this.pairing.secondsLeft--;
      }), 1000);
    }), err => this.zone.run(() => {
      if (!this.pairing) return;
      this.pairing = Object.assign({}, this.pairing, { state: 'error', message: cleanError(err) || `${server.name} didn't answer.` });
      this.focusPairing('again');
    }));
  }

  private onPairingUpdate(update:PairingUpdate) {
    if (!this.pairing || this.pairing.server.id != update.serverId) return;
    this.pairing = Object.assign({}, this.pairing, { state: update.state, message: update.message });
    if (update.state == 'approved') {
      clearInterval(this.countdown);
      this.connect(this.pairing.server);
    } else if (update.state != 'waiting') {
      clearInterval(this.countdown);
      this.focusPairing('again');
    }
  }

  cancelPairing() {
    if (!this.pairing) return;
    const id = this.pairing.server.id;
    this.pairing = null;
    clearInterval(this.countdown);
    this.bridge?.pairing.cancel();
    this.pairingLayer?.close(undefined, false);
    this.pairingLayer = null;
    this.focusServer(id);
  }

  // The panel is a layer of the nav system: its own select / back (Back cancels)
  private openPairingLayer() {
    if (this.pairingLayer) return;
    const layer = this.pairingLayer = this.layers.open({ id: 'pairing', element: () => document.querySelector('.pairingPanel') });
    layer.onSelect(active => {
      if (!this.pairing || this.leaving) return;
      if (active?.dataset['pair'] == 'cancel') this.cancelPairing();
      if (active?.dataset['pair'] == 'again') this.startPairing(this.pairing.server);
    });
    layer.onBack(() => {
      if (!this.leaving) this.cancelPairing();
      return true;
    });
  }

  // ── focus ───────────────────────────────────────────────────────────────

  // selector: that element; else the server in use, the first server, the
  // first button. Without selector or force, a focus already on the page stays.
  private focusDefault(selector?:string, force = false) {
    if (!this.splashService.cleared || this.pairing || this.typing) return;
    setTimeout(() => {
      const page = document.querySelector('.connectPage');
      if (!page) return;
      const active = document.activeElement as HTMLElement;
      if (!selector && !force && active && page.contains(active) && active.matches('.focusable')) return;
      const target = (selector && page.querySelector(selector))
        || page.querySelector('.sourceRow.current')
        || page.querySelector('.sourceRow')
        || page.querySelector('.focusable');
      (target as HTMLElement)?.focus({ preventScroll: true });
    }, 0);
  }

  private focusServer(id:string) {
    this.focusDefault(`.sourceRow[data-id="${id}"]`);
  }

  private focusPairing(button:'cancel' | 'again') {
    setTimeout(() => {
      const el = (document.querySelector(`.pairingPanel [data-pair="${button}"]`)
        || document.querySelector('.pairingPanel [data-pair="cancel"]')) as HTMLElement;
      el?.focus({ preventScroll: true });
    }, 0);
  }
}

function sameOrigin(a:string, b:string):boolean {
  try {
    return new URL(a).origin == new URL(b).origin;
  } catch (e) {
    return a == b;
  }
}

// "Error invoking remote method 'local:start': Error: …" → "…"
function cleanError(err:any):string {
  const text = String(err?.message || err || '');
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
