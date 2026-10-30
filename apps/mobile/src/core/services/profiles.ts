import { ApiError, unwrap, type Schemas } from '../http/api'
import type { ApiClient } from '../http/client'

// Profiles (docs/api/profiles.md): "Who's watching?" lists them; created and
// edited on the TV or the dashboard, not here.

export type Profile = Schemas['Profile']
export type ProfileList = Schemas['ProfileList']

export function listProfiles(client: ApiClient): Promise<ProfileList> {
  return unwrap(client.api.GET('/profiles'))
}

/** The profile, unlocked (a PIN when it has one); records it as the last used */
export async function unlockProfile(client: ApiClient, profileId: string, pin?: string): Promise<Profile> {
  try {
    return await unwrap(client.api.POST('/profiles/{profileId}/unlock', { params: { path: { profileId } }, body: pin ? { pin } : {} }))
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) throw new ApiError(403, { error: 'Wrong PIN', code: 'FORBIDDEN' })
    if (e instanceof ApiError && e.status === 429) throw new ApiError(429, { error: 'Too many tries. Wait 30 seconds.', code: 'TOO_MANY_ATTEMPTS' })
    throw e
  }
}
