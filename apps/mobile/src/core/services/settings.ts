import { definition, type SettingKey, type SettingValues } from '@playpex/protocol/settings'
import { unwrap } from '../http/api'
import type { ApiClient } from '../http/client'

// Settings (docs/settings-plan.md): every value lives on the server, this
// phone's under its device id (the token names it), the profile's under the
// profile. GET /settings answers both with their defaults filled in, so the app
// never hard-codes one; a change goes to the route of the key's scope.

export type { SettingKey, SettingValues } from '@playpex/protocol/settings'

export type Settings = { device: Partial<SettingValues> & Record<string, unknown>; profile: (Partial<SettingValues> & Record<string, unknown>) | null }

export async function getSettings(client: ApiClient, profileId: string): Promise<Settings> {
  const answer = await unwrap(client.api.GET('/settings', { params: { query: { profile: profileId } } }))
  return { device: answer.device, profile: answer.profile ?? null } as Settings
}

/** Changes one setting where it belongs (`null` = back to its default); answers that scope's values */
export function changeSetting<K extends SettingKey>(client: ApiClient, profileId: string, key: K, value: SettingValues[K] | null): Promise<Record<string, unknown>> {
  const body = { [key]: value }
  if (scopeOf(key) === 'profile') return unwrap(client.api.PATCH('/profiles/{profileId}/settings', { params: { path: { profileId } }, body }))
  return unwrap(client.api.PATCH('/settings/device', { body }))
}

export function scopeOf(key: SettingKey): 'device' | 'profile' {
  return definition(key)?.scope ?? 'profile'
}
