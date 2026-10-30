import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { PICTURES, type PlayerController } from '../../core/player/controller'
import type { PlayerExtras } from '../../core/player/extras'
import type { PlaybackSession } from '../../core/playback/session'
import { useStore } from '../../state/hooks'
import { color, font, radius, space } from '../../ui/theme'
import { Chip, Chips, Choice, Facts, Note, Panel, PanelScroll, Section, Stepper, Tabs } from './Panel'
import { audioDetail, trackName } from './TracksPanel'
import { formatBytes } from './format'

// The player's settings, as on the TV: Subtitles (the online sources),
// Style (size, position, background, timing), Audio, Video (speed, the
// picture, a torrent's other videos) and Stats. Changes apply at once and last
// until the player closes.

export type SettingsTab = 'subtitles' | 'style' | 'audio' | 'video' | 'stats'

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'subtitles', label: 'Subtitles' },
  { key: 'style', label: 'Style' },
  { key: 'audio', label: 'Audio' },
  { key: 'video', label: 'Video' },
  { key: 'stats', label: 'Stats' },
]

const SIZES = [
  { label: 'Small', scale: 0.8 },
  { label: 'Medium', scale: 1 },
  { label: 'Large', scale: 1.25 },
  { label: 'Largest', scale: 1.5 },
]
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

type Props = { controller: PlayerController; extras: PlayerExtras; session: PlaybackSession; tab: SettingsTab; onTab: (tab: SettingsTab) => void; onClose: () => void }

export function SettingsPanel({ controller, extras, session, tab: first, onTab, onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>(first)
  const show = (next: SettingsTab) => {
    setTab(next)
    onTab(next)
    extras.stats.watch(next === 'stats')
    if (next === 'subtitles') extras.subtitles.open()
  }
  const close = () => {
    extras.stats.watch(false)
    onClose()
  }
  return (
    <Panel title="Settings" onClose={close}>
      <Tabs tabs={TABS} active={tab} onChange={show} />
      <PanelScroll>
        {tab === 'subtitles' ? <SubtitlesTab controller={controller} extras={extras} /> : null}
        {tab === 'style' ? <StyleTab controller={controller} /> : null}
        {tab === 'audio' ? <AudioTab controller={controller} /> : null}
        {tab === 'video' ? <VideoTab controller={controller} session={session} onSwitched={close} /> : null}
        {tab === 'stats' ? <StatsTab controller={controller} extras={extras} session={session} /> : null}
      </PanelScroll>
    </Panel>
  )
}

function SubtitlesTab({ controller, extras }: { controller: PlayerController; extras: PlayerExtras }) {
  const { providers, provider, results, error, chosen } = useStore(extras.subtitles.state)
  const { online } = useStore(controller.state)
  return (
    <>
      {providers && providers.length > 1 ? (
        <Chips>
          {providers.map((p) => (
            <Chip key={p.id} label={p.name} selected={p.id === provider} onPress={() => extras.subtitles.switchTo(p.id)} />
          ))}
        </Chips>
      ) : null}
      <View>
        <Choice
          label="Off"
          chosen={!online}
          onPress={() => {
            extras.subtitles.choose(null)
            controller.selectSubtitle(null)
          }}
        />
        {(results ?? []).map((s) => (
          <Choice
            key={s.provider + s.ref}
            label={s.name || s.languageName || s.language}
            detail={s.languageName ?? s.language}
            chosen={!!online && s === chosen}
            onPress={() => {
              const file = extras.subtitles.choose(s)
              if (file) controller.addOnlineSubtitle(file)
            }}
          />
        ))}
        {!results ? <Note>Looking for subtitles…</Note> : null}
        {results && !results.length && error ? <Note>{error}</Note> : null}
      </View>
    </>
  )
}

function StyleTab({ controller }: { controller: PlayerController }) {
  const { tuning } = useStore(controller.state)
  return (
    <>
      <View style={styles.sample} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text
          style={[
            styles.cue,
            { fontSize: 15 * tuning.subtitleScale, marginBottom: 8 + (100 - tuning.subtitlePosition) * 0.6 },
            tuning.subtitleBackground && styles.cueBox,
          ]}
        >
          Subtitles will look like this.
        </Text>
      </View>
      <Section title="Size">
        <Chips>
          {SIZES.map((s) => (
            <Chip key={s.label} label={s.label} selected={Math.abs(tuning.subtitleScale - s.scale) < 0.01} onPress={() => controller.tune({ subtitleScale: s.scale })} />
          ))}
        </Chips>
      </Section>
      <Section title="Background">
        <Chips>
          <Chip label="Outline" selected={!tuning.subtitleBackground} onPress={() => controller.tune({ subtitleBackground: false })} />
          <Chip label="Dark box" selected={tuning.subtitleBackground} onPress={() => controller.tune({ subtitleBackground: true })} />
        </Chips>
      </Section>
      <Stepper label="Position" value={tuning.subtitlePosition} min={50} max={100} step={5} origin={100} format={(v) => (v === 100 ? 'Bottom' : `${100 - v} higher`)} onChange={(v) => controller.tune({ subtitlePosition: v })} />
      <Section help="For subtitles made for another release: add time if they show before the line is spoken.">
        <Stepper label="Timing" value={tuning.subtitleDelay} min={-10} max={10} step={0.1} origin={0} format={secondsText} onChange={(v) => controller.tune({ subtitleDelay: v })} />
      </Section>
    </>
  )
}

function AudioTab({ controller }: { controller: PlayerController }) {
  const { tuning, tracks } = useStore(controller.state)
  const playing = tracks.find((t) => t.kind === 'audio' && t.selected)
  return (
    <>
      <Section help="When the sound comes before or after the picture: add time if it comes early.">
        <Stepper label="Sync" value={tuning.audioDelay} min={-5} max={5} step={0.05} origin={0} format={secondsText} onChange={(v) => controller.tune({ audioDelay: v })} />
      </Section>
      {playing ? (
        <Note>
          Playing: {trackName(playing)}
          {audioDetail(playing) ? ` (${audioDetail(playing)})` : ''}. Other tracks are under Audio & subtitles.
        </Note>
      ) : null}
      <Note>The sound plays as it is in the release, decoded on this phone. Its volume is the phone’s.</Note>
    </>
  )
}

function VideoTab({ controller, session, onSwitched }: { controller: PlayerController; session: PlaybackSession; onSwitched: () => void }) {
  const { tuning, files } = useStore(controller.state)
  const others = (files?.video ?? []).filter((v) => !v.current)
  return (
    <>
      <Section title="Speed">
        <Chips>
          {SPEEDS.map((s) => (
            <Chip key={s} label={s === 1 ? 'Normal' : `${s}×`} selected={tuning.speed === s} onPress={() => controller.tune({ speed: s })} />
          ))}
        </Chips>
      </Section>
      <Section title="Picture" help={PICTURES.find((p) => p.key === tuning.picture)?.help}>
        <Chips>
          {PICTURES.map((p) => (
            <Chip key={p.key} label={p.label} selected={tuning.picture === p.key} onPress={() => controller.tune({ picture: p.key })} />
          ))}
        </Chips>
      </Section>
      <Stepper label="Brightness" value={tuning.brightness} min={-50} max={50} step={5} origin={0} format={(v) => `${100 + v} %`} onChange={(v) => controller.tune({ brightness: v })} />
      {others.length ? (
        <Section title="Other videos in this torrent">
          {others.map((v) => (
            <Choice
              key={v.id}
              label={v.name?.split('/').pop() ?? v.id}
              detail={[v.kind === 'extra' ? 'Extra' : v.kind === 'episode' ? 'Episode' : 'Video', v.size ? formatBytes(v.size) : ''].filter(Boolean).join(' · ')}
              onPress={() => {
                session.switchVideo(v)
                onSwitched()
              }}
            />
          ))}
        </Section>
      ) : null}
    </>
  )
}

function StatsTab({ controller, extras, session }: { controller: PlayerController; extras: PlayerExtras; session: PlaybackSession }) {
  const { onScreen } = useStore(extras.stats.state)
  return (
    <>
      <StatsFacts controller={controller} extras={extras} session={session} />
      <Chips>
        <Chip label={onScreen ? 'Shown on screen while watching' : 'Show on screen while watching'} selected={onScreen} onPress={() => extras.stats.toggleOnScreen()} />
      </Chips>
    </>
  )
}

/** The numbers: the decoder, the picture and sound, the cache, a torrent's swarm */
export function StatsFacts({ controller, extras, session }: { controller: PlayerController; extras: PlayerExtras; session: PlaybackSession }) {
  const { info, swarm } = useStore(extras.stats.state)
  const { position, bufferedTo } = useStore(controller.state)
  const wait = '…'
  const rows: [string, string][] = [
    ['Decoder', info ? (info.decoder === 'hardware' ? 'This phone’s hardware' : 'Software (FFmpeg)') : wait],
    ['Video', info ? [info.videoCodec.toUpperCase(), info.width ? `${info.width} × ${info.height}` : '', info.fps ? `${Math.round(info.fps * 100) / 100} fps` : '', info.hdr ? 'HDR' : ''].filter(Boolean).join(' · ') || '—' : wait],
    ['Video bitrate', info?.videoBitrate ? `${(info.videoBitrate / 1e6).toFixed(1)} Mb/s` : '—'],
    ['Audio', info ? [info.audioCodec.toUpperCase(), info.audioBitrate ? `${Math.round(info.audioBitrate / 1000)} kb/s` : ''].filter(Boolean).join(' · ') || '—' : wait],
    ['Buffered ahead', bufferedTo > position ? `${Math.round(bufferedTo - position)} s` : '—'],
  ]
  if (swarm) {
    rows.push(
      ['Peers', `${swarm.peers.total ?? 0} (${swarm.peers.unchocked ?? 0} sending)`],
      ['Download', `${formatBytes(swarm.speed.down ?? 0)}/s`],
      ['Downloaded', formatBytes(swarm.traffic.down ?? 0)],
      ['Upload', `${formatBytes(swarm.speed.up ?? 0)}/s, ${formatBytes(swarm.traffic.up ?? 0)}`],
    )
  }
  rows.push(['Source', session.source.label])
  return <Facts rows={rows} />
}

function secondsText(v: number): string {
  if (!v) return 'In sync'
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(Math.round(Math.abs(v) * 100) % 10 ? 2 : 1)} s`
}

const styles = StyleSheet.create({
  sample: { height: 110, borderRadius: radius.m, overflow: 'hidden', justifyContent: 'flex-end', alignItems: 'center', backgroundColor: color.stillSea, borderTopWidth: 40, borderTopColor: color.stillSky },
  cue: {
    fontFamily: font.semibold,
    color: color.subtitle,
    textAlign: 'center',
    paddingHorizontal: space.xs,
    textShadowColor: color.black,
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 1 },
  },
  cueBox: { backgroundColor: color.dark86, textShadowRadius: 0 },
})
