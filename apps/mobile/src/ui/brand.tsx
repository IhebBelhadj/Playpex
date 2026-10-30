import { StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { Image } from 'expo-image'
import { color, font } from './theme'

// The Playpex mark (apps/tv/app_icon.svg's folded play "P", its gold) and the
// wordmark. The mark's weight is on its left: centred alone, it goes ~5 % of
// its width right (MARK_OPTICAL_SHIFT) so it looks centred.

const MARK = require('../../assets/brand/mark.svg')
const MARK_RATIO = 17.58 / 19.79
export const MARK_OPTICAL_SHIFT = 0.05

export function Mark({ size, centred, style }: { size: number; centred?: boolean; style?: ViewStyle }) {
  return (
    <View style={[{ width: size, height: size * MARK_RATIO }, centred && { transform: [{ translateX: size * MARK_OPTICAL_SHIFT }] }, style]}>
      <Image source={MARK} style={StyleSheet.absoluteFill} contentFit="contain" />
    </View>
  )
}

/** The mark and "Playpex" in Futura, the brand's face */
export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <View style={styles.row} accessibilityRole="header" accessibilityLabel="Playpex">
      <Mark size={size * 0.95} />
      <Text style={[styles.word, { fontSize: size, lineHeight: size * 1.15 }]}>Playpex</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  word: { fontFamily: font.display, color: color.text, letterSpacing: -0.4 },
})
