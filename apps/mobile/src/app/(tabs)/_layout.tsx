import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs'
import * as Haptics from 'expo-haptics'
import { screenBoundary } from '../../state/boundary'
import { TabBar, type TabItem } from '../../ui/chrome'
import { color } from '../../ui/theme'

// The sections and the bottom navigation (ui/chrome.tsx). Search is a section
// too, reached from the top bar's magnifier rather than a tab.

const ICONS: Record<string, TabItem['icon']> = {
  index: ['home-outline', 'home'],
  movies: ['film-outline', 'film'],
  shows: ['tv-outline', 'tv'],
  plugins: ['extension-puzzle-outline', 'extension-puzzle'],
  mylist: ['bookmark-outline', 'bookmark'],
}

function Navigation({ state, descriptors, navigateToTab }: BottomTabBarProps) {
  const routes = state.routes.filter((r) => ICONS[r.name])
  const active = state.routes[state.index].key
  return (
    <TabBar
      items={routes.map((r) => ({ key: r.key, label: descriptors[r.key].options.title ?? r.name, icon: ICONS[r.name] }))}
      active={active}
      onSelect={(key) => {
        if (key === active) return
        Haptics.selectionAsync()
        navigateToTab(key)
      }}
    />
  )
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <Navigation {...props} />}
      // Sections stay plain views in the stack's screen: a morph from one of them starts in that screen
      detachInactiveScreens={false}
      screenLayout={screenBoundary}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.bg }, animation: 'fade' }}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="movies" options={{ title: 'Movies' }} />
      <Tabs.Screen name="shows" options={{ title: 'Shows' }} />
      <Tabs.Screen name="plugins" options={{ title: 'Plugins' }} />
      <Tabs.Screen name="mylist" options={{ title: 'My list' }} />
      <Tabs.Screen name="search" options={{ title: 'Search' }} />
    </Tabs>
  )
}
