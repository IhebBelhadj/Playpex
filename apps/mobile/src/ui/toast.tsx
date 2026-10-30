import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import { color, radius, space, text } from './theme'

// Short messages at the bottom of the screen: a plugin's toast, a failure that
// needs no screen of its own. One at a time; each stays 3.5 s.

type Toast = { id: number; text: string; source?: string; tone?: string }
const ToastContext = createContext<(text: string, opts?: { source?: string; tone?: string }) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const insets = useSafeAreaInsets()
  const show = useCallback((t: string, opts?: { source?: string; tone?: string }) => {
    if (timer.current) clearTimeout(timer.current)
    setToast({ id: Date.now(), text: t, ...opts })
    timer.current = setTimeout(() => setToast(null), 3500)
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <Animated.View
          key={toast.id}
          entering={FadeInDown.duration(220)}
          exiting={FadeOutDown.duration(180)}
          style={[styles.toast, { bottom: insets.bottom + 72 }, toast.tone === 'error' && styles.error]}
          pointerEvents="none"
          accessibilityLiveRegion="polite"
        >
          {toast.source ? <Text style={text.tiny}>{toast.source}</Text> : null}
          <Text style={[text.label, { fontSize: 15 }]}>{toast.text}</Text>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: space.l,
    right: space.l,
    paddingHorizontal: space.l,
    paddingVertical: space.m,
    borderRadius: radius.l,
    backgroundColor: color.surface3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  error: { borderColor: color.danger },
})
