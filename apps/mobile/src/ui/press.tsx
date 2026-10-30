import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { motion } from './theme'

// A pressable that gives a little under the finger: it shrinks while held and
// springs back. With reduced motion it only dims.

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

type Props = Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle>; scale?: number }

export function Press({ style, scale = motion.pressScale, onPressIn, onPressOut, children, ...rest }: Props) {
  const reduced = useReducedMotion()
  const pressed = useSharedValue(0)
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: reduced ? 1 : 1 - (1 - scale) * pressed.value }],
    opacity: reduced ? 1 - 0.3 * pressed.value : 1,
  }))
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        pressed.value = withTiming(1, { duration: motion.fast })
        onPressIn?.(e)
      }}
      onPressOut={(e) => {
        pressed.value = withSpring(0, { damping: 14, stiffness: 220 })
        onPressOut?.(e)
      }}
      style={[style, animated]}
    >
      {children}
    </AnimatedPressable>
  )
}
