import type { ProfileMemory } from '../core/session/ports'

// In a browser (docs/mobile-web-plan.md) a reload (the refresh button, a pull down) comes back on
// the profile it was on: kept for this tab only (sessionStorage: a new tab, or the next visit, asks
// "Who's watching?"), and opened again by the server only (POST /profiles/{id}/resume: a profile
// with a PIN only if this browser unlocked it lately). The key is Playpex TV's on the web too
// (docs/web-unified-plan.md §5): switching view in this tab keeps the profile.

const KEY = 'playpex.web.profile'

export const profileMemory: ProfileMemory = {
  last(serverId) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null') as { server?: string; profile?: string } | null
      return saved?.server === serverId && saved.profile ? saved.profile : null
    } catch {
      return null
    }
  },
  remember(serverId, profileId) {
    try {
      if (profileId) sessionStorage.setItem(KEY, JSON.stringify({ server: serverId, profile: profileId }))
      else sessionStorage.removeItem(KEY)
    } catch {}
  },
}
