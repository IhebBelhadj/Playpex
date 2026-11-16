import type { ReactElement } from 'react'

// In a browser (docs/mobile-web-plan.md) there are no morphs: Reanimated's
// shared transitions are native only (its SharedTransitionBoundary doesn't
// render on the web). Screens change with their navigator's own transition;
// the same API as state/boundary.tsx, doing nothing.

export function screenBoundary({ children }: { children: ReactElement }): ReactElement {
  return children
}

export const MORPH_SETTLE_MS = 600

export function useMorphTag(_tag: string | undefined): { tag: string | undefined; key: number; open: (go: () => void) => void } {
  return { tag: undefined, key: 0, open: (go) => go() }
}

export function useArrivingTag(_tag: string | undefined): string | undefined {
  return undefined
}
