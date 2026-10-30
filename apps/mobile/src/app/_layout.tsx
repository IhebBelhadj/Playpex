import '../lib/dev'
import { View } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { LightsDown } from '../features/launch/LightsDown'
import { AppProvider, useSessionState } from '../state/app'
import { screenBoundary } from '../state/boundary'
import { useHideSplashWhen } from '../state/launch'
import { Loading } from '../ui/components'
import { ScreenFailure } from '../ui/failure'
import { MORPH_SCREEN_FADE } from '../ui/morph'
import { ToastProvider } from '../ui/toast'
import { color } from '../ui/theme'

// Which screens exist follows the session (core/session/session.ts): no server
// → Connect and Pair; a server, nobody watching → Who's watching?; then the
// app. Expo Router guards the rest (Stack.Protected), so a screen never checks.

function Screens() {
  const state = useSessionState()
  const starting = state.kind === 'booting' || state.kind === 'reaching'
  useHideSplashWhen(!starting)
  if (starting) {
    return (
      <View style={{ flex: 1, backgroundColor: color.bg }}>
        <Loading label="Looking for your server…" />
      </View>
    )
  }
  const connected = state.kind === 'connected'
  const watching = connected && state.profile != null
  return (
    <Stack
      // The tabs' screens have their own boundaries (one per section, (tabs)/_layout.tsx)
      screenLayout={(props) => (props.route.name === '(tabs)' ? props.children : screenBoundary(props))}
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg }, animation: 'fade', animationDuration: 260, orientation: 'portrait_up' }}
    >
      <Stack.Protected guard={!connected}>
        <Stack.Screen name="connect" />
        <Stack.Screen name="pair" options={{ animation: 'slide_from_right' }} />
      </Stack.Protected>
      <Stack.Protected guard={connected && !watching}>
        <Stack.Screen name="profiles" />
      </Stack.Protected>
      <Stack.Protected guard={watching}>
        <Stack.Screen name="(tabs)" />
        {/* A fade, short: the poster's own morph carries the move */}
        <Stack.Screen name="title/[mediaType]/[id]" options={{ animation: 'fade', animationDuration: MORPH_SCREEN_FADE }} />
        <Stack.Screen name="plugin/[plugin]/[screen]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="browse/[mediaType]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="releases" options={{ animation: 'slide_from_right' }} />
        {/* A fade: the avatar's own morph from the top bar carries the move */}
        <Stack.Screen name="settings" options={{ animation: 'fade', animationDuration: MORPH_SCREEN_FADE }} />
        {/* A screen of its own, not a form sheet: the player replaces it in one transition (no dismissal racing a push) */}
        <Stack.Screen name="play" options={{ animation: 'slide_from_bottom', animationDuration: 260 }} />
        <Stack.Screen name="player" options={{ animation: 'fade', orientation: 'landscape', statusBarHidden: true, navigationBarHidden: true }} />
      </Stack.Protected>
    </Stack>
  )
}

/** A screen that fails while drawing shows what failed, with Try again, instead of closing the app */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return <ScreenFailure message={error.message} onRetry={() => void retry()} />
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <ToastProvider>
            <StatusBar style="light" />
            <Screens />
            <LightsDown />
          </ToastProvider>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
