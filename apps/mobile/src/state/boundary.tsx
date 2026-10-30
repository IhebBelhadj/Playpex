import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useIsFocused } from 'expo-router'
import { SharedTransitionBoundary } from 'react-native-reanimated'

// The morphs between screens (a poster into its title page, the avatar into
// Settings) are Reanimated's shared transitions: they look for their tags in
// the screen that is focused and the one it opens, each inside an active
// boundary. Navigators give every screen one (`screenLayout`).

function Boundary({ children }: { children: ReactNode }) {
  const focused = useIsFocused()
  return <SharedTransitionBoundary isActive={focused}>{children}</SharedTransitionBoundary>
}

/** A navigator's `screenLayout`: each screen in its own boundary */
export function screenBoundary({ children }: { children: ReactElement }): ReactElement {
  return <Boundary>{children}</Boundary>
}

/** How long a morph's tags stay on: its 280 ms flight and the screen's fade, with room to spare */
export const MORPH_SETTLE_MS = 600

/**
 * A picture's morph tag, put on only when it is tapped and only for the morph: `open(go)` tags it,
 * runs `go` (the navigation) once that render is committed so the morph finds it, and takes the tag
 * off again once the morph has settled (the picture drawn anew: give it `key`). Morphs run one way: with no tag left on either side, leaving
 * the opened screen (Back, a gesture, a pop from code) is a plain screen transition, never
 * Reanimated's reverse morph, which could leave the poster hidden. Untagged otherwise too: Reanimated
 * looks at every tagged view on each screen change (a tab switch too).
 */
export function useMorphTag(tag: string | undefined): { tag: string | undefined; key: number; open: (go: () => void) => void } {
  const [tagged, setTagged] = useState(false)
  // Reanimated hides the tapped picture while its copy flies, and shows it again only on a morph back:
  // there is none, so the picture is drawn anew (a new `key`) when its tag comes off
  const [drawn, setDrawn] = useState(0)
  const pending = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!tagged) return
    const go = pending.current
    pending.current = null
    go?.()
    const timer = setTimeout(() => {
      setTagged(false)
      setDrawn((n) => n + 1)
    }, MORPH_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [tagged])
  return {
    tag: tagged ? tag : undefined,
    key: drawn,
    open: (go) => {
      // no tag, or a second tap while the first morph runs: just go
      if (!tag || tagged) return go()
      pending.current = go
      setTagged(true)
    },
  }
}

/** The opened screen's side of a morph: the tag it arrived with, for the morph in only */
export function useArrivingTag(tag: string | undefined): string | undefined {
  const [arriving, setArriving] = useState(!!tag)
  useEffect(() => {
    if (!arriving) return
    const timer = setTimeout(() => setArriving(false), MORPH_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [arriving])
  return arriving ? tag : undefined
}
