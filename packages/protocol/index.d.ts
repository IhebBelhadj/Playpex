// Types of index.js, plus the API types generated from openapi.yaml
// (`npm run generate -w packages/protocol` → types/api.d.ts, committed).

import type { components, paths, operations } from './types/api';

export type { components, paths, operations };
export type { SettingKey, SettingValues, SettingScope, SettingDefinition, ClientSettingKey } from './settings';
import type { SettingKey, SettingDefinition } from './settings';
/** The user settings registry (settings.js) */
export declare const SETTINGS: { readonly [K in SettingKey]: SettingDefinition };
/** Shortcut: Schema<'Profile'> = components['schemas']['Profile'] */
export type Schema<Name extends keyof components['schemas']> = components['schemas'][Name];

/** The plugin host API's version (plugins.js; the rest: '@playpex/protocol/plugins') */
export declare const SERVER_PLUGIN_API: string;
export declare const API_VERSION: number;
export declare const MIN_API_VERSION: number;
export declare const API_PREFIX: '/api/v1';
export declare const CLIENT_HEADER: 'X-Playpex-Client';
export declare const DEVICE_HEADER: 'X-Playpex-Device';
export declare const DEVICE_PARAM: 'device';
export declare const AUTH: {
  readonly DEVICE_CODE_PATH: '/auth/device/code';
  readonly DEVICE_TOKEN_PATH: '/auth/device/token';
  readonly DEVICE_GRANT_TYPE: 'urn:ietf:params:oauth:grant-type:device_code';
  readonly TOKEN_PARAM: 'access_token';
};
export type SessionCommandAction = 'pause' | 'resume' | 'toggle' | 'seek' | 'seekBy' | 'stop';
export declare const REMOTE: {
  readonly PATH: '/api/v1/remote';
  readonly SESSION_COMMANDS: ReadonlyArray<SessionCommandAction>;
  readonly MESSAGES: ReadonlyArray<RemoteMessage['type']>;
  readonly POINTER_PHASES: ReadonlyArray<'move' | 'down' | 'up' | 'wheel'>;
  readonly POINTER_BUTTONS: ReadonlyArray<RemotePointerButton>;
  readonly KEY_MODIFIERS: ReadonlyArray<RemoteKeyModifier>;
  readonly TEXT_MAX: number;
  readonly RTC: { readonly MOVES: 'moves'; readonly INPUT: 'input'; readonly SIGNAL_MAX: number };
  readonly FIELD_KINDS: ReadonlyArray<'text' | 'search' | 'address'>;
};
/** session.command (events socket, to one device) */
export interface SessionCommandEvent {
  sessionId: string;
  infoHash: string | null;
  ref: string | null;
  action: SessionCommandAction;
  positionS?: number;
  deltaS?: number;
  by: string | null;
}
export type RemotePointerButton = 'left' | 'right' | 'middle' | 'back';
export type RemoteKeyModifier = 'shift' | 'control' | 'alt' | 'meta';
export interface RemoteCapabilities { keyboard: boolean; pointer: boolean; text: boolean;
  /** the pointer may come over WebRTC data channels (REMOTE.RTC) */
  rtc?: boolean;
  /** says when one of its text fields is open (`field` messages): the controller's own keyboard can fill it */
  field?: boolean }
/** A text field open on the target (its on-screen keyboard), as the controller sees it */
export interface RemoteField {
  /** changes with every field opened: a controller's value for another one is dropped */
  id: string;
  value: string;
  title?: string;
  placeholder?: string;
  maxLength?: number;
  /** what it's for: the controller picks its keyboard (search: a search key; address: a URL keyboard) */
  kind?: 'text' | 'search' | 'address';
}
/** WebRTC set-up, relayed by the server between the controller (offers) and the target (answers) */
export type RemoteSignal =
  | { description: { type: 'offer' | 'answer'; sdp: string } }
  | { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null };
/** The data channels' messages (JSON). x, y of the controller: running totals of its moves in CSS px since the
 *  channel opened, s the number of moves so far; the target applies the difference from the last it applied */
export type RemoteRtcMessage =
  | { t: 'move'; s: number; x: number; y: number }                                                 // MOVES, controller → target
  | { t: 'cursor'; x: number; y: number }                                                          // MOVES, target → controller
  | { t: 'pointer'; s: number; x: number; y: number; phase: 'down' | 'up'; button: RemotePointerButton } // INPUT
  | { t: 'pointer'; s: number; x: number; y: number; phase: 'wheel'; dx: number; dy: number };     // INPUT
/** Messages of the remote socket (REMOTE.PATH) */
export type RemoteMessage =
  | { type: 'hello'; role: 'target'; capabilities: RemoteCapabilities; screen?: { width: number; height: number } }
  | { type: 'hello'; role: 'controller' }
  | { type: 'state'; connected: boolean; reason?: 'offline' | 'taken' | 'refused' | 'unsupported' | 'ended';
      controller?: { name: string } | null; device?: { id: string; name: string | null } | null;
      capabilities?: RemoteCapabilities | null; screen?: { width: number; height: number } | null }
  | { type: 'key'; phase: 'down' | 'up'; key: string; code?: string; modifiers?: RemoteKeyModifier[]; repeat?: boolean }
  | { type: 'text'; text: string }
  | { type: 'pointer'; phase: 'move'; dx: number; dy: number }
  | { type: 'pointer'; phase: 'move'; x: number; y: number }
  | { type: 'pointer'; phase: 'down' | 'up'; button: RemotePointerButton }
  | { type: 'pointer'; phase: 'wheel'; dx: number; dy: number }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'signal'; data: RemoteSignal }
  /** target → controller (relayed, and sent to a controller that connects while one is open): a field opened, its text
   *  changed on the target, or (open false) it closed */
  | ({ type: 'field'; open: true } & RemoteField)
  | { type: 'field'; open: false; id?: string }
  /** controller → target: the field's whole text (not keystrokes); submit: then its Done */
  | { type: 'field'; id: string; value: string; submit?: boolean }
  | { type: 'bye' };
export declare const DEFAULT_PORT: number;
export declare const DISCOVERY_PORT: number;
export declare const DISCOVERY: {
  readonly MDNS_TYPE: 'playpex';
  readonly MDNS_SERVICE: '_playpex._tcp.local';
  readonly UDP_PORT: number;
  readonly QUERY: 'PLAYPEX_DISCOVER 1';
  readonly INTERVAL_MS: number;
};
/** The UDP discovery answer (one JSON datagram) */
export interface DiscoveryReply {
  id: string;
  name: string;
  port: number;
  apiVersion: number;
  minApiVersion: number;
  version: string;
}
/** What a media ref looks like (opaque to clients: they get refs from the server) */
export declare const MEDIA_REF_PATTERN: string;
export type ErrorCode =components['schemas']['Error']['code'];
export declare const ERROR_CODES: { readonly [code in ErrorCode]: number };
export declare function parseClientHeader(value: string | null | undefined):
  { name: string; version: string; api: number | null } | null;
export declare function clientHeader(name: string, version: string): string;
