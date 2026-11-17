import { Platform } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { switchToTvView, tvViewAvailable } from '../native/viewSwitch'

/**
 * In a browser: Playpex TV on the web, when the server serves it (docs/web-unified-plan.md §5);
 * `open(at)` goes there through /app/ at a place both clients know. Null on a phone, or when it
 * isn't there.
 */
export function useTvView(): { open: (at: string) => void } | null {
  const available = useQuery({ queryKey: ['web-clients', 'tv'], queryFn: tvViewAvailable, enabled: Platform.OS === 'web', staleTime: 60_000 })
  return available.data ? { open: switchToTvView } : null
}
