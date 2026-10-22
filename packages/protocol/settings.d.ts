// Types of settings.js: the user settings registry (docs/settings-plan.md §4).

export type SettingScope = 'device' | 'profile';

/** Value type of every registered key */
export interface SettingValues {
  'display.uiScale': 0.7 | 0.8 | 0.9 | 1 | 1.15;
  'display.safeArea': number;
  'player.volume': number;
  'subtitles.size': 'small' | 'medium' | 'large' | 'largest';
  'subtitles.provider': string | null;
  'player.autoplayNext': boolean;
  'adult.layout': 'posters' | 'compact';
  'adult.metadataProvider': string | null;
}

export type SettingKey = keyof SettingValues;
/** `client.<clientId>.<name>`: a client's private value (free JSON, ≤ 4 KB) */
export type ClientSettingKey = `client.${string}.${string}`;

export interface SettingDefinition {
  scope: SettingScope;
  type: 'number' | 'string' | 'boolean';
  default: unknown;
  enum?: ReadonlyArray<number | string>;
  min?: number;
  max?: number;
  step?: number;
  nullable?: boolean;
  /** refused for kids profiles */
  adult?: boolean;
}

export declare const SETTINGS: { readonly [K in SettingKey]: SettingDefinition };
export declare const SCOPES: readonly SettingScope[];
export declare const CLIENT_VALUE_MAX: number;
export declare function isClientKey(key: string): key is ClientSettingKey;
export declare function definition(key: string): SettingDefinition | null;
export declare function keys(scope?: SettingScope): SettingKey[];
export declare function defaults(scope?: SettingScope): Partial<SettingValues>;
/** A message for people, or null when the value is valid (null = reset is valid) */
export declare function validate(key: string, value: unknown, scope?: SettingScope): string | null;
