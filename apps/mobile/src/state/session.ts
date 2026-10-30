import { ServerFinder } from '../core/session/finder'
import { PairingController, type PairingTarget } from '../core/session/pairing'
import { describeThisDevice, discovery } from '../native/discovery'
import { serverStore } from '../native/serverStore'
import { useSession } from './app'
import { useOwned } from './hooks'

// The session's screen controllers, made with the native ports

/** Connect's servers: discovery runs while the screen is shown */
export function useServerFinder(): ServerFinder {
  const session = useSession()
  return useOwned(() => new ServerFinder(serverStore, discovery, session))
}

/** Pair's device flow with `target`: polls while the screen is shown */
export function usePairing(target: PairingTarget): PairingController {
  const session = useSession()
  return useOwned(() => new PairingController(target, session, describeThisDevice))
}
