import { Easing, SharedTransition } from 'react-native-reanimated'

// The morph between screens (a poster into its title page, the avatar into
// Settings): quick off the mark, settling gently, short enough that the finger
// never waits for it.
export const morph = SharedTransition.duration(280).easing(Easing.bezier(0.2, 0.8, 0.2, 1))


/**
 * The screen a morph opens fades in under it, quickly: Back needs a screen transition too, or the
 * morph has nothing to run back in and the poster it left flickers on the screen below
 */
export const MORPH_SCREEN_FADE = 220
