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
export declare const SERVER_PLUGIN_API: number;
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
