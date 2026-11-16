import { useCallback, useState, type ReactNode } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { useOwned } from '../../state/hooks'
import { PlayerFrameContext } from './frameContext'

// In a browser (docs/mobile-web-plan.md §7) nothing turns the screen for the player, and a page
// held upright gets the picture as a strip with narrow panels. "Turn" (the player's top right,
// shown while the window is higher than wide) asks the browser first (full screen, then
// screen.orientation.lock('landscape'): Chrome on Android), and where it refuses (Safari, a
// computer) draws the player turned a quarter clockwise across the whole window: the phone is then
// held on its side as for any video. Kept for the next video (localStorage: this browser only).

const KEY = 'playpex.mobile.playerTurned'

function remembered(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

type Orientation = ScreenOrientation & { lock?: (o: 'landscape') => Promise<void> }

/** Full screen in landscape where the browser does it; false where it doesn't (nothing left changed) */
async function lockLandscape(): Promise<boolean> {
  const orientation = screen.orientation as Orientation | undefined
  if (!orientation?.lock || !document.documentElement.requestFullscreen) return false
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    await orientation.lock('landscape')
    return true
  } catch {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    return false
  }
}

function unlock() {
  try {
    screen.orientation?.unlock()
  } catch {}
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
}

export function PlayerFrameView({ children }: { children: ReactNode }) {
  const window = useWindowDimensions()
  const upright = window.height > window.width
  // drawn turned (the browser didn't turn the screen)
  const [drawn, setDrawn] = useState(remembered)
  // the screen turned by the browser, until the player closes
  const [locked, setLocked] = useState(false)

  // the screen given back when the player closes
  useOwned(() => ({ start() {}, stop: unlock }))

  const toggle = useCallback(() => {
    if (locked) {
      setLocked(false)
      unlock()
      return
    }
    if (drawn) {
      setDrawn(false)
      try {
        localStorage.removeItem(KEY)
      } catch {}
      return
    }
    void lockLandscape().then((ok) => {
      if (ok) return setLocked(true)
      setDrawn(true)
      try {
        localStorage.setItem(KEY, '1')
      } catch {}
    })
  }, [drawn, locked])

  const turned = drawn && upright
  const width = turned ? window.height : window.width
  const height = turned ? window.width : window.height
  // the button while it can do something: an upright window, or the screen it turned
  const value = { width, height, turned, toggle: upright || locked ? toggle : null }
  return (
    <PlayerFrameContext.Provider value={value}>
      {/* one box either way: swapping it for the bare player would mount the player again (and end the playback) */}
      <View style={turned ? [styles.turned, { width, height, left: (window.width - width) / 2, top: (window.height - height) / 2 }] : styles.plain}>{children}</View>
    </PlayerFrameContext.Provider>
  )
}

const styles = StyleSheet.create({
  plain: { flex: 1 },
  turned: { position: 'absolute', overflow: 'hidden', transform: [{ rotate: '90deg' }] },
})
