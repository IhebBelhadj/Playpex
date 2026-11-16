import type { ProfileMemory } from '../core/session/ports'

// A phone keeps no profile: "Who's watching?" at every start (the app doesn't reload). In a
// browser a tab keeps it across a reload (profileMemory.web.ts).
export const profileMemory: ProfileMemory | null = null
