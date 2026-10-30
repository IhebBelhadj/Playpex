import { useEffect } from 'react'
import * as SplashScreen from 'expo-splash-screen'

// The native splash (the mark on the auditorium's black) stays up until the
// session knows where it is; then it goes at once and LightsDown takes over.

SplashScreen.preventAutoHideAsync().catch(() => {})
SplashScreen.setOptions({ duration: 0, fade: false })

export function useHideSplashWhen(ready: boolean): void {
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {})
  }, [ready])
}
