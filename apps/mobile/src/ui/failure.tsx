import { StyleSheet, Text, View } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { Button } from './components'
import { color, space, text } from './theme'

// What a screen shows when it fails while drawing (Expo Router's ErrorBoundary,
// app/_layout.tsx): the app stays open, the screen can be tried again.

export function ScreenFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.page}>
      <Ionicons name="alert-circle-outline" size={40} color={color.caution} />
      <Text style={[text.title, styles.centered, { marginTop: space.l }]}>This screen stopped</Text>
      <Text style={[text.body, styles.centered, { color: color.textMuted, marginTop: space.s }]}>{message}</Text>
      <Button label="Try again" onPress={onRetry} style={{ marginTop: space.xl }} />
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, backgroundColor: color.bg },
  centered: { textAlign: 'center' },
})
