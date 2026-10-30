import { useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { ROWS, type MediaType } from '../lib/catalog'
import { useSlotRows } from '../lib/plugins'
import { useDiscover, useGenres } from '../lib/recommend'
import { Row } from './components'
import { openBrowse } from '../state/navigation'
import { PluginRowView } from './plugin-rows'
import { Press } from './press'
import { CatalogRow, TabPage } from './rows'
import { color, font, radius, space } from './theme'

// The Movies and Shows tabs: genres to narrow the page, the catalog's rows,
// and what the server's plugins add to the section (slot core.movies.rows /
// core.shows.rows). A genre chosen: its most popular, best rated and newest.

export function SectionPage({ mediaType }: { mediaType: MediaType }) {
  const genres = useGenres(mediaType)
  const [genre, setGenre] = useState<number | null>(null)
  const slot = mediaType === 'movie' ? 'core.movies.rows' : 'core.shows.rows'
  const pluginRows = useSlotRows(slot, { section: mediaType === 'movie' ? 'movies' : 'shows', query: '', filters: {} }, mediaType)
  const list = [...(genres.data?.entries() ?? [])]

  return (
    <TabPage title={mediaType === 'movie' ? 'Movies' : 'Shows'}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={{ marginBottom: space.xl }}>
        <Chip label="All" on={genre == null} onPress={() => setGenre(null)} />
        {list.map(([id, name]) => (
          <Chip key={id} label={name} on={genre === id} onPress={() => setGenre(genre === id ? null : id)} />
        ))}
      </ScrollView>
      {genre != null ? (
        <GenreRows mediaType={mediaType} genre={genre} name={genres.data?.get(genre) ?? ''} />
      ) : (
        <>
          {(pluginRows.data ?? []).map((row) => (
            <PluginRowView key={row.plugin + row.key} plugin={row.plugin} row={row} />
          ))}
          {ROWS[mediaType].map((row) => (
            <CatalogRow key={row.list} {...row} />
          ))}
        </>
      )}
    </TabPage>
  )
}

function GenreRows({ mediaType, genre, name }: { mediaType: MediaType; genre: number; name: string }) {
  const popular = useDiscover(mediaType, [genre], 'popularity')
  const rated = useDiscover(mediaType, [genre], 'rating')
  const newest = useDiscover(mediaType, [genre], 'newest')
  return (
    <View>
      <Row label={`Popular ${name.toLowerCase()}`} titles={popular.data} loading={popular.isPending} scope={`g${genre}-pop`} onSeeAll={() => openBrowse(mediaType, { genre })} />
      <Row label="Best rated" titles={rated.data} loading={rated.isPending} scope={`g${genre}-rated`} onSeeAll={() => openBrowse(mediaType, { genre })} />
      <Row label="Newest" titles={newest.data} loading={newest.isPending} scope={`g${genre}-new`} onSeeAll={() => openBrowse(mediaType, { genre })} />
    </View>
  )
}

export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Press onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[styles.chipLabel, on && { color: color.onAccent }]}>{label}</Text>
    </Press>
  )
}

const styles = StyleSheet.create({
  chips: { paddingHorizontal: space.l, gap: space.s },
  chip: {
    paddingHorizontal: space.l,
    height: 36,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: color.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  chipOn: { backgroundColor: color.accent, borderColor: color.accent },
  chipLabel: { fontFamily: font.medium, fontSize: 14, color: color.text },
})
