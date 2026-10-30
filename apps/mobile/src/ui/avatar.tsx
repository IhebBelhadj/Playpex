import { StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import Animated from 'react-native-reanimated'
import { morph } from './morph'
import { avatarColor, color } from './theme'

// Profile avatars: the TV app's images (apps/tv/src/assets/avatars), by the ids
// every client shares (docs/api/profiles.md); another id shows the initial.

const AVATARS: Record<string, number> = {
  'avatar-01': require('../../assets/avatars/avatar-01.svg'),
  'avatar-02': require('../../assets/avatars/avatar-02.svg'),
  'avatar-03': require('../../assets/avatars/avatar-03.svg'),
  'avatar-04': require('../../assets/avatars/avatar-04.svg'),
  'avatar-05': require('../../assets/avatars/avatar-05.svg'),
  'avatar-06': require('../../assets/avatars/avatar-06.svg'),
  'avatar-07': require('../../assets/avatars/avatar-07.svg'),
  'avatar-08': require('../../assets/avatars/avatar-08.svg'),
  'avatar-09': require('../../assets/avatars/avatar-09.svg'),
  'avatar-10': require('../../assets/avatars/avatar-10.svg'),
  'avatar-11': require('../../assets/avatars/avatar-11.svg'),
  'avatar-12': require('../../assets/avatars/avatar-12.svg'),
}

// The face itself carries the morph's tag: a shared transition moves the tagged view alone, not its children
const MorphingImage = Animated.createAnimatedComponent(Image)

/** `tag`: the avatar morphs between the screens that draw it with the same tag (the top bar's into Settings) */
export function Avatar({ id, name, size, round, tag }: { id: string | null | undefined; name: string; size: number; round?: boolean; tag?: string }) {
  const source = id ? AVATARS[id] : undefined
  const corner = round ? size / 2 : size * 0.08
  return (
    <View style={[styles.box, { width: size, height: size, borderRadius: corner }, id && avatarColor[id] ? { backgroundColor: avatarColor[id] } : null]}>
      {source ? (
        <MorphingImage
          source={source}
          style={[StyleSheet.absoluteFill, { borderRadius: corner }]}
          contentFit="cover"
          cachePolicy="memory-disk"
          sharedTransitionTag={tag}
          sharedTransitionStyle={tag ? morph : undefined}
        />
      ) : (
        <Text style={{ color: color.text, fontSize: size * 0.45, fontWeight: '800' }}>{name.charAt(0).toUpperCase()}</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: color.surface3, alignItems: 'center', justifyContent: 'center' },
})
