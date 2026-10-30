import { ScrollView, StyleSheet, Text, View } from 'react-native'
import type { PlayerController } from '../../core/player/controller'
import type { PlayerTrack } from '../../core/player/port'
import type { MediaTrack } from '../../core/services/playback'
import { useStore } from '../../state/hooks'
import { color, font, space } from '../../ui/theme'
import { Choice, Note, Panel } from './Panel'

// Audio & subtitles, as on the TV: two columns, the current ones marked in
// gold, switched at once. mpv's own tracks (every one plays: decoded on the
// phone), then a torrent's separate audio / subtitle files and a library
// file's sidecars from the server's list (added to mpv when chosen), Off, and
// "Find subtitles…" (Settings › Subtitles: the online sources).

export function TracksPanel({ controller, onClose, onFindSubtitles }: { controller: PlayerController; onClose: () => void; onFindSubtitles: () => void }) {
  const { tracks, files, online } = useStore(controller.state)
  const audio = tracks.filter((t) => t.kind === 'audio')
  const subtitles = tracks.filter((t) => t.kind === 'subtitle')
  // The server's separate files, until mpv lists them (it names them as we did)
  const added = new Set(tracks.filter((t) => t.external).map((t) => t.title))
  const fileAudio = (files?.audio ?? []).filter((t) => t.source === 'file' && t.ref && !added.has(fileTrackName(t)))
  const fileSubtitles = (files?.subtitles ?? []).filter((t) => t.source === 'file' && t.available !== false && t.play !== 'image' && !added.has(fileTrackName(t)))
  const others = (files?.video ?? []).filter((v) => !v.current).length

  return (
    <Panel title="Audio & subtitles" onClose={onClose} width={680}>
      <View style={styles.columns}>
        <View style={styles.column}>
          <Text style={styles.columnName}>Audio</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            {audio.map((t) => (
              <Choice key={t.id} label={trackName(t)} detail={audioDetail(t)} chosen={t.selected} onPress={() => controller.selectAudio(t)} />
            ))}
            {fileAudio.map((t) => (
              <Choice key={t.id} label={fileTrackName(t)} detail={['Separate file', t.codec ? (CODEC_NAMES[t.codec] ?? t.codec) : ''].filter(Boolean).join(' · ')} onPress={() => controller.addFileTrack(t, 'audio')} />
            ))}
            {!audio.length && !fileAudio.length ? <Note>This video has no sound track.</Note> : null}
          </ScrollView>
        </View>
        <View style={styles.column}>
          <Text style={styles.columnName}>Subtitles</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Choice label="Off" chosen={!subtitles.some((t) => t.selected)} onPress={() => controller.selectSubtitle(null)} />
            {subtitles.map((t) => (
              <Choice
                key={t.id}
                label={trackName(t)}
                detail={t.external && t.title === online ? 'Found online' : [t.external ? 'Separate file' : '', SUBTITLE_FORMATS[t.codec] ?? t.codec].filter(Boolean).join(' · ')}
                chosen={t.selected}
                onPress={() => controller.selectSubtitle(t)}
              />
            ))}
            {fileSubtitles.map((t) => (
              <Choice key={t.id} label={fileTrackName(t)} detail={[t.forced ? 'Forced' : '', t.sdh ? 'SDH' : '', 'Separate file'].filter(Boolean).join(' · ')} onPress={() => controller.addFileTrack(t, 'subtitle')} />
            ))}
            <Choice label="Find subtitles…" detail="Online sources" onPress={onFindSubtitles} />
          </ScrollView>
        </View>
      </View>
      {others ? <Text style={styles.foot}>Other videos of this torrent: Settings › Video.</Text> : null}
    </Panel>
  )
}

/** The name mpv lists a separate file under, once added (controller.addFileTrack names it the same) */
export function fileTrackName(t: MediaTrack): string {
  return [t.languageName, t.title].filter(Boolean).join(', ') || t.name?.split('/').pop() || t.id
}

export function trackName(t: PlayerTrack): string {
  let language = t.language
  try {
    if (t.language) language = new Intl.DisplayNames(['en'], { type: 'language' }).of(t.language) ?? t.language
  } catch {
    // an unknown code: shown as it is
  }
  if (t.external) return t.title || language || `Track ${t.id}`
  return [language, t.title].filter(Boolean).join(', ') || `Track ${t.id}`
}

const CODEC_NAMES: Record<string, string> = { ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', truehd: 'Dolby TrueHD', dts: 'DTS', aac: 'AAC', opus: 'Opus', flac: 'FLAC', mp3: 'MP3', vorbis: 'Vorbis' }
const SUBTITLE_FORMATS: Record<string, string> = { subrip: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'WebVTT', hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'VobSub', mov_text: 'Text' }

export function audioDetail(t: PlayerTrack): string {
  const channels = t.channels ? (t.channels === 6 ? '5.1' : t.channels === 8 ? '7.1' : t.channels === 2 ? 'Stereo' : t.channels === 1 ? 'Mono' : `${t.channels} ch`) : ''
  return [CODEC_NAMES[t.codec] ?? t.codec, channels].filter(Boolean).join(' ')
}

const styles = StyleSheet.create({
  columns: { flex: 1, flexDirection: 'row', gap: space.xl },
  column: { flex: 1 },
  columnName: { fontFamily: font.semibold, fontSize: 14, color: color.textSecondary, marginBottom: space.s, paddingHorizontal: space.m },
  foot: { fontFamily: font.medium, fontSize: 12, color: color.textMuted, paddingVertical: space.m },
})
