import { StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import Ionicons from '@expo/vector-icons/Ionicons'
import { openIntent, pluginImage, usePlugins } from '../../lib/plugins'
import { useSession } from '../../lib/session'
import { Loading, Message } from '../../ui/components'
import { Press } from '../../ui/press'
import { TabPage } from '../../ui/rows'
import { color, font, radius, space, text } from '../../ui/theme'

// Plugins: the sections the server's plugins add for this profile (Live TV, a
// catalogue of public-domain films…), each opening the plugin's own screen. The
// admin installs and sets plugins up on the server's dashboard; a kids profile
// never gets an adults plugin (the server leaves it out).

export default function PluginsScreen() {
  const plugins = usePlugins()
  const session = useSession()
  const { width } = useWindowDimensions()
  const tile = (width - space.l * 2 - space.m) / 2
  const sections = (plugins.data?.plugins ?? [])
    .flatMap((p) => p.sections.map((s) => ({ plugin: p, ...s })))
    .sort((a, b) => (a.menu.order ?? 0) - (b.menu.order ?? 0) || a.menu.label.localeCompare(b.menu.label))

  return (
    <TabPage title="Plugins">
      {plugins.isPending ? <Loading /> : null}
      {plugins.isError ? (
        <View style={styles.empty}>
          <Message title="The plugins didn’t load" body={plugins.error.message} action={{ label: 'Try again', onPress: () => plugins.refetch() }} />
        </View>
      ) : null}
      {plugins.isSuccess && !sections.length ? (
        <View style={styles.empty}>
          <Message
            icon="extension-puzzle-outline"
            title="Nothing from plugins yet"
            body="Plugins add sections like Live TV to Playpex. Your server’s admin installs them on its dashboard, under Plugins."
          />
        </View>
      ) : null}
      <View style={styles.grid}>
        {sections.map((item) => {
          const icon = pluginImage(session, item.plugin.id, item.plugin.icon)
          const screen = item.screen.replace(/^plugin\.[^.]+\./, '')
          return (
            <Press
              key={item.plugin.id + item.screen}
              scale={0.96}
              style={[styles.tile, { width: tile }]}
              accessibilityLabel={`${item.menu.label}, from ${item.plugin.name}`}
              onPress={() => openIntent(item.plugin.id, { screen: `plugin.${item.plugin.id}.${screen}` })}
            >
              <View style={styles.icon}>
                {/* Plugins' icons are monochrome drawings (as on the TV): shown in the mark's gold */}
                {icon ? <Image source={icon} style={styles.iconImage} contentFit="contain" tintColor={color.accent} /> : <Ionicons name="extension-puzzle-outline" size={26} color={color.accent} />}
              </View>
              <Text style={styles.label} numberOfLines={2}>
                {item.menu.label}
              </Text>
              <Text style={text.small} numberOfLines={1}>
                {item.plugin.name}
              </Text>
            </Press>
          )
        })}
      </View>
    </TabPage>
  )
}

const styles = StyleSheet.create({
  empty: { height: 380 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m, paddingHorizontal: space.l },
  tile: {
    minHeight: 168,
    padding: space.l,
    borderRadius: radius.l,
    backgroundColor: color.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    justifyContent: 'flex-end',
    gap: space.xxs,
  },
  icon: {
    position: 'absolute',
    top: space.l,
    left: space.l,
    width: 48,
    height: 48,
    borderRadius: radius.m,
    backgroundColor: color.surface1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconImage: { width: 30, height: 30 },
  label: { fontFamily: font.display, fontSize: 20, lineHeight: 24, color: color.text },
})
