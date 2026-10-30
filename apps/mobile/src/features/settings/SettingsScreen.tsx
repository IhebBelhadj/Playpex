import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { SUBTITLE_SCALE } from '../../core/player/preferences'
import type { Settings, SettingValues } from '../../core/services/settings'
import { LANGUAGES } from '../../core/util/languages'
import { useHasSourcePlugins } from '../../lib/plugins'
import { useClient, useProfile, useSession, useSessionState } from '../../state/app'
import { useThisDevice } from '../../state/device'
import { useLeave } from '../../state/hooks'
import { useArrivingTag } from '../../state/boundary'
import { queries } from '../../state/queries'
import { useChangeSetting, useSettings, type SettingChange } from '../../state/settings'
import { Avatar } from '../../ui/avatar'
import { Button, IconButton, Message } from '../../ui/components'
import { SkeletonSection } from '../../ui/loading'
import { ChoiceRow, Segmented, SettingRow, SettingsGroup, SubtitlePreview, ToggleRow, type Choice } from '../../ui/settings'
import { color, space, text } from '../../ui/theme'

// Settings: what the profile watching prefers (its tracks, what Play does),
// how subtitles look on this phone, the server, this phone, and the app. Every
// value lives on the server (GET /settings), so the TV and other phones of
// the profile follow; a change shows at once (state/settings.ts).

const AUDIO: Choice<string>[] = [{ value: 'original', label: 'The film’s own', detail: 'Whatever the release plays first' }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.name }))]
const SUBTITLES: Choice<string>[] = [{ value: 'off', label: 'Off' }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.name }))]
const PLAY: Choice<SettingValues['player.autoplayKind']>[] = [
  { value: 'ask', label: 'Show me the sources', detail: 'Choose every time' },
  { value: 'server', label: 'Play this server’s file', detail: 'When it has one; else the sources' },
  { value: 'stream', label: 'Play the best stream', detail: 'When one plays here; else the sources' },
]
const SIZES: Choice<SettingValues['subtitles.size']>[] = [
  { value: 'small', label: 'S', detail: 'Small' },
  { value: 'medium', label: 'M', detail: 'Medium' },
  { value: 'large', label: 'L', detail: 'Large' },
  { value: 'largest', label: 'XL', detail: 'Largest' },
]
const CODECS: Record<string, string> = { h264: 'H.264', avc: 'H.264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg2: 'MPEG-2', mpeg4: 'MPEG-4' }

export default function SettingsScreen() {
  const { tag } = useLocalSearchParams<{ tag?: string }>()
  const { leaving, leave } = useLeave()
  const arriving = useArrivingTag(tag || undefined)
  const insets = useSafeAreaInsets()
  const profile = useProfile()
  const session = useSession()
  const state = useSessionState()
  const server = state.kind === 'connected' ? state.server : null

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <IconButton icon="chevron-back" label="Back" glass onPress={leave} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xxxl }}>
        <View style={styles.who}>
          <View style={styles.ring}>
            <Avatar id={profile.avatar} name={profile.name} size={76} round tag={(!leaving && arriving) || undefined} />
          </View>
          <View style={{ flex: 1, gap: space.xs }}>
            <Text style={text.title} numberOfLines={1}>
              {profile.name}
            </Text>
            <Text style={text.small} numberOfLines={1}>
              Watching from {server?.name ?? 'your server'}
            </Text>
          </View>
        </View>
        <Button kind="secondary" icon="people-outline" label="Switch profile" onPress={() => session.leaveProfile()} style={styles.switch} />
        {/* The groups draw once the settings are here: nothing moves under the finger as they arrive */}
        <Groups server={server} onChangeServer={() => session.disconnect()} />
      </ScrollView>
    </View>
  )
}

function Groups({ server, onChangeServer }: { server: { name: string; url: string } | null; onChangeServer: () => void }) {
  const settings = useSettings()
  if (settings.isPending) {
    return (
      <View style={{ paddingHorizontal: space.l, gap: space.l }}>
        <SkeletonSection width={320} ratio={0.5} />
      </View>
    )
  }
  if (settings.isError) return <Message title="Settings didn’t load" body={settings.error.message} action={{ label: 'Try again', onPress: () => settings.refetch() }} />
  return (
    <>
      <Preferences settings={settings.data} />
      <ServerGroup name={server?.name ?? ''} url={server?.url ?? ''} onChange={onChangeServer} />
      <PhoneGroup />
      <SettingsGroup title="About">
        <SettingRow first label="Playpex Mobile" value="0.1.0" />
        <SettingRow label="Video player" value="mpv, GPL-3.0" />
        <Text style={[text.tiny, styles.note]}>
          Playpex is an educational project. Playpex comes with no content: play only what you have the right to. Streaming copyrighted content through torrents may be illegal where you live.
        </Text>
      </SettingsGroup>
    </>
  )
}

function Preferences({ settings }: { settings: Settings }) {
  const change = useChangeSetting()
  const p = settings.profile ?? {}
  const d = settings.device
  function set<K extends keyof SettingValues>(key: K, value: SettingValues[K]) {
    change.mutate({ key, value } as SettingChange)
  }
  const subtitles = p['player.subtitleLanguage'] ?? 'off'
  // "Play the best stream" only once some plugin finds sources
  const sources = useHasSourcePlugins()
  const play = sources ? PLAY : PLAY.filter((c) => c.value !== 'stream' || p['player.autoplayKind'] === 'stream')
  const size = d['subtitles.size'] ?? 'medium'
  return (
    <>
      <SettingsGroup title="Watching" why="For this profile, on every screen it watches on">
        <ChoiceRow first label="Audio" value={p['player.audioLanguage'] ?? 'original'} choices={AUDIO} onChoose={(v) => set('player.audioLanguage', v)} />
        <ChoiceRow label="Subtitles" value={subtitles} choices={SUBTITLES} onChoose={(v) => set('player.subtitleLanguage', v)} />
        {subtitles !== 'off' ? (
          <ToggleRow label="Only forced subtitles" detail="The lines in another language, nothing else" on={p['player.subtitleForcedOnly'] === true} onChange={(v) => set('player.subtitleForcedOnly', v)} />
        ) : null}
        <ToggleRow label="Play the next episode" detail="When an episode ends" on={p['player.autoplayNext'] !== false} onChange={(v) => set('player.autoplayNext', v)} />
        <ToggleRow label="Prefer files on the server" detail="Before any other source of the same release" on={p['player.preferLocalFiles'] !== false} onChange={(v) => set('player.preferLocalFiles', v)} />
        <ChoiceRow label="When you press Play" value={p['player.autoplayKind'] ?? 'ask'} choices={play} onChoose={(v) => set('player.autoplayKind', v)} />
      </SettingsGroup>
      <SettingsGroup title="Subtitles on this phone" why="How big they are here; the TV keeps its own">
        <SubtitlePreview scale={SUBTITLE_SCALE[size]} />
        <Segmented choices={SIZES} value={size} onChoose={(v) => set('subtitles.size', v)} />
      </SettingsGroup>
      {change.isError ? <Text style={[text.small, styles.error]}>{change.error.message}</Text> : null}
    </>
  )
}

function ServerGroup({ name, url, onChange }: { name: string; url: string; onChange: () => void }) {
  const client = useClient()
  const info = useQuery(queries.server(client))
  return (
    <SettingsGroup title="Server">
      <SettingRow first label="Name" value={name} />
      <SettingRow label="Address" value={info.data?.host ?? url.replace(/^https?:\/\//, '')} />
      <SettingRow label="Version" value={info.data?.version ?? '…'} />
      <SettingRow label="Choose another server" onPress={onChange} />
    </SettingsGroup>
  )
}

function PhoneGroup() {
  const device = useThisDevice()
  const hardware = [...new Set(device.hardware.map((c) => CODECS[c.toLowerCase()] ?? c.toUpperCase()))]
  return (
    <SettingsGroup title="This phone" why="It plays every format; these in hardware, the rest in software">
      <SettingRow first label="Name" value={device.name} />
      <SettingRow label="Hardware decoding" value={hardware.join(', ') || 'None'} />
      <SettingRow label="Sharpest picture" value={`${device.maxHeight}p`} />
    </SettingsGroup>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  bar: { paddingHorizontal: space.l, paddingVertical: space.s },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.l, paddingHorizontal: space.l, marginTop: space.s },
  ring: { padding: 3, borderRadius: 999, borderWidth: 1.5, borderColor: color.accent },
  switch: { alignSelf: 'flex-start', marginHorizontal: space.l, marginTop: space.l, marginBottom: space.xxl },
  note: { padding: space.l, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  error: { color: color.error, paddingHorizontal: space.l, marginTop: -space.l, marginBottom: space.xl },
})
