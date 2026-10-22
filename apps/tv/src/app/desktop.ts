// window.playpex: the Electron shell's bridge (apps/tv/electron/preload.js).
// Absent in a browser (`ng serve`): use `desktop()` and handle null.

export type ConnectionReason = 'none' | 'unreachable' | 'pairing' | 'revoked' | 'incompatible';

export interface ConnectedServer {
  id:string;
  name:string;
  url:string;
  local:boolean;
  paired?:boolean;
}

export interface ConnectionState {
  server:ConnectedServer | null;
  /** why there is no server; null when connected */
  reason:ConnectionReason | null;
  /** unreachable / revoked: the server's name; incompatible: CLIENT_TOO_OLD | SERVER_TOO_OLD */
  detail:string | null;
  /** the server it was about (pairing, revoked, incompatible, unreachable) */
  candidate:ConnectedServer | null;
  deviceId:string;
  deviceIdIsNew:boolean;
  /** 'plain': no keyring, device tokens are stored unencrypted */
  tokenStorage:'encrypted' | 'plain';
  version:string;
  platform:string;
}

/** A server found on the network (apps/tv/electron/discovery.js) */
export interface DiscoveredServer {
  id:string;
  name:string;
  version:string;
  apiVersion:number;
  minApiVersion:number;
  compatible:boolean;
  url:string;
  port:number;
  addresses:string[];
  local:boolean;
  via:string[];
  paired:boolean;
  current:boolean;
  needsPairing:boolean;
}

export interface PairingCode {
  userCode:string;
  verificationUri:string;
  verificationUriComplete:string | null;
  expiresIn:number;
  /** QR code of the verification URI, as a data: URL */
  qr:string | null;
}

export interface PairingUpdate {
  state:'waiting' | 'approved' | 'denied' | 'expired' | 'error';
  message:string | null;
  serverId:string;
}

export interface UpdaterState {
  state:'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'error';
  version:string | null;
  percent:number | null;
  error:string | null;
}

export interface LocalServerStatus {
  installed:boolean;
  kind:'desktop' | 'development' | null;
  port:number;
}

type Unsubscribe = () => void;

export interface PlaypexBridge {
  connection:{
    current():Promise<ConnectionState>;
    adoptDeviceId(id:string | null):Promise<string>;
    /** stores the choice and reloads the app (resolves only on failure) */
    choose(server:{ id:string, name:string, url:string }):Promise<ConnectionState>;
    /** finds the current server again (by id); reloads the app when found */
    reconnect():Promise<ConnectionState>;
    /** the server refused this device: 'revoked' (401) or 'incompatible' (426, detail = code); reloads */
    drop(reason:'revoked' | 'incompatible', detail?:string):Promise<ConnectionState>;
    forget(id:string):Promise<boolean>;
  };
  discovery:{
    start():Promise<DiscoveredServer[]>;
    stop():Promise<void>;
    rescan():Promise<void>;
    probe(address:string):Promise<DiscoveredServer>;
    onChange(listener:(servers:DiscoveredServer[]) => void):Unsubscribe;
  };
  pairing:{
    start(server:{ id:string, name:string, url:string }):Promise<PairingCode>;
    cancel():Promise<void>;
    onUpdate(listener:(update:PairingUpdate) => void):Unsubscribe;
  };
  localServer:{
    status():Promise<LocalServerStatus>;
    /** starts the installed server and resolves once it answers */
    start():Promise<DiscoveredServer>;
  };
  updater:{
    state():Promise<UpdaterState>;
    check():Promise<UpdaterState>;
    install():Promise<boolean>;
    onChange(listener:(state:UpdaterState) => void):Unsubscribe;
  };
  display:{
    /** scale: how big the UI is on this screen (--px-ui-scale); null until chosen */
    get():Promise<{ scale:number | null }>;
    /** stores it in client.json; resolves with the stored value */
    set(scale:number):Promise<number>;
  };
  power(action:string):Promise<void>;
}

export function desktop():PlaypexBridge | null {
  return (window as any).playpex || null;
}
