import { createContext, useContext } from 'react'

// The player's frame: the box it draws in, normally the window. In a browser
// held upright, "Turn" (frame.web.tsx) draws the player turned a quarter
// clockwise in a box as long as the window is high, as a phone turned on its
// side would: what measures the window or reads where a finger is (the tap
// zones, the panels, the timeline) asks the frame instead.

export type PlayerFrame = {
  width: number
  height: number
  /** Drawn turned a quarter clockwise: the frame's x runs down the screen */
  turned: boolean
  /** Turn the player on its side or back (null: nothing to turn, as on a phone, or a wide window) */
  toggle: (() => void) | null
}

export const PlayerFrameContext = createContext<PlayerFrame | null>(null)

export function usePlayerFrame(fallback: { width: number; height: number }): PlayerFrame {
  return useContext(PlayerFrameContext) ?? { ...fallback, turned: false, toggle: null }
}
