import { View, useWindowDimensions } from 'react-native'
import { router } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { unwrap } from '../../lib/api'
import { useSlotRows } from '../../lib/plugins'
import { useApi, useProfile } from '../../lib/session'
import { Loading, Message, Poster, RowHeading, openTitle, posterTag } from '../../ui/components'
import { ContinueRow } from '../../ui/home'
import { PluginRowView } from '../../ui/plugin-rows'
import { TabPage } from '../../ui/rows'
import { space } from '../../ui/theme'

// The profile's watch list (docs/api/profiles.md#the-library), then what
// plugins add to it (slot core.watchlist.rows: a Trakt list…)

export default function MyListScreen() {
  const api = useApi()
  const profile = useProfile()
  const { width } = useWindowDimensions()
  const library = useQuery({
    queryKey: ['library', profile.id],
    queryFn: () => unwrap(api.GET('/profiles/{profileId}/library', { params: { path: { profileId: profile.id } } })),
  })
  const pluginRows = useSlotRows('core.watchlist.rows', {}, 'watchlist')
  const columns = Math.max(3, Math.floor((width - space.l * 2) / 120))
  const tile = (width - space.l * 2 - space.s * (columns - 1)) / columns
  const items = library.data?.watchlist ?? []

  return (
    <TabPage title="My list">
      {library.isPending ? <Loading /> : null}
      <ContinueRow items={library.data?.continueWatching ?? []} />
      {items.length ? <RowHeading title="Saved" /> : null}
      {library.isSuccess && !items.length && !library.data.continueWatching.length ? (
        <View style={{ height: 360 }}>
          <Message
            icon="bookmark-outline"
            title="Nothing saved yet"
            body="Tap My list on a movie or a show to keep it here. Your list is the same on every device of this server."
            action={{ label: 'Browse movies', onPress: () => router.navigate('/movies') }}
          />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s, paddingHorizontal: space.l, marginBottom: space.xxl }}>
        {items.map((item) => {
          const tag = posterTag('mylist', item.mediaType, item.tmdbId)
          return (
            <Poster
              key={item.mediaType + item.tmdbId}
              title={item.title ?? ''}
              path={item.posterPath}
              width={tile}
              tag={tag}
              onPress={() => openTitle(item.mediaType, item.tmdbId, { tag, posterPath: item.posterPath, backdropPath: item.backdropPath, title: item.title ?? '' })}
            />
          )
        })}
      </View>
      {(pluginRows.data ?? []).map((row) => (
        <PluginRowView key={row.plugin + row.key} plugin={row.plugin} row={row} />
      ))}
    </TabPage>
  )
}
