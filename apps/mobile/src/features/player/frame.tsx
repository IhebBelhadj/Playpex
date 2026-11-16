import type { ReactNode } from 'react'
import { useWindowDimensions } from 'react-native'
import { PlayerFrameContext } from './frameContext'

// On a phone the system turns the screen (the player route's `orientation: 'landscape'`): the frame
// is the window, nothing to turn (the web's own: frame.web.tsx)

export function PlayerFrameView({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions()
  return <PlayerFrameContext.Provider value={{ width, height, turned: false, toggle: null }}>{children}</PlayerFrameContext.Provider>
}
