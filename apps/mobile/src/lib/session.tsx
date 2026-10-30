import type { ReactNode } from 'react'
import type { Api, LostReason } from '../core/http/api'
import type { KnownServer } from '../core/session/ports'
import type { Profile } from '../core/session/session'
import { useSession as useController, useSessionState } from '../state/app'

// Temporary: the old session hooks over core/session's SessionController, for
// the screens not moved to src/features yet (plan step 6 deletes this file).

export type { Profile }

type Status =
  | { state: 'starting' }
  | { state: 'none'; lost?: LostReason & { serverName: string } }
  | { state: 'unreachable'; server: KnownServer }
  | { state: 'ready' }

type Session = {
  status: Status
  server: KnownServer | null
  api: Api | null
  deviceId: string
  profile: Profile | null
  connect(server: KnownServer): Promise<void>
  disconnect(): void
  retry(): Promise<void>
  setProfile(profile: Profile | null): void
}

export function SessionProvider({ children }: { children: ReactNode }) {
  return children
}

export function useSession(): Session {
  const controller = useController()
  const state = useSessionState()
  const status: Status =
    state.kind === 'booting' || state.kind === 'reaching'
      ? { state: 'starting' }
      : state.kind === 'noServer'
        ? { state: 'none', lost: state.lost ?? undefined }
        : state.kind === 'unreachable'
          ? { state: 'unreachable', server: state.server }
          : { state: 'ready' }
  const connected = state.kind === 'connected' ? state : null
  return {
    status,
    server: state.kind === 'booting' || state.kind === 'noServer' ? null : state.server,
    api: connected?.client.api ?? null,
    deviceId: controller.deviceId,
    profile: connected?.profile ?? null,
    connect: (server) => controller.connect(server),
    disconnect: () => controller.disconnect(),
    retry: () => controller.retry(),
    setProfile: (profile) => (profile ? controller.chooseProfile(profile) : controller.leaveProfile()),
  }
}

export function useApi(): Api {
  const { api } = useSession()
  if (!api) throw new Error('No server')
  return api
}

export function useProfile(): Profile {
  const { profile } = useSession()
  if (!profile) throw new Error('No profile')
  return profile
}
