import { useMemo, useState } from 'react'
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeInDown } from 'react-native-reanimated'
import { image, useImageBase, usePerson, type PersonCredit, type PersonDetails } from '../../lib/catalog'
import { useLeave } from '../../state/hooks'
import { IconButton, Message, POSTER_WIDTH, Poster, ROW_LIST, openTitle, posterTag } from '../../ui/components'
import { Press } from '../../ui/press'
import { color, font, motion, radius, space, text } from '../../ui/theme'

// A person's page (docs/people-plan.md §6): from a title's cast row or a
// search result. Their face, who they are, the biography (four lines, a tap
// shows it all), then rows by role as on the TV: Known for, Movies and Shows
// as cast (newest first, the ones not out yet first), one per crew department.
// A title opens its page.

type Params = { id: string; name?: string; face?: string }
type Row = { key: string; title: string; credits: PersonCredit[]; role: 'known' | 'cast' | string }

const today = () => new Date().toISOString().slice(0, 10)
const upcoming = (c: PersonCredit) => !c.releaseDate || c.releaseDate > today()

// newest first; not out yet before them; without a poster last
function newestFirst(list: PersonCredit[]) {
  const pictured = list.filter((c) => c.posterPath)
  return [
    ...pictured.filter(upcoming).sort((a, b) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999')),
    ...pictured.filter((c) => !upcoming(c)).sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '')),
    ...list.filter((c) => !c.posterPath),
  ]
}

function rowsOf(p: PersonDetails): Row[] {
  const rows: Row[] = []
  const known = p.knownFor.map((id) => p.credits.find((c) => c.tmdbId === id)).filter((c): c is PersonCredit => !!c)
  if (known.length) rows.push({ key: 'known', title: 'Known for', credits: known, role: 'known' })
  const cast = p.credits.filter((c) => c.roles.some((r) => !r.job))
  const movies = newestFirst(cast.filter((c) => c.mediaType === 'movie'))
  const shows = newestFirst(cast.filter((c) => c.mediaType === 'tv'))
  if (movies.length) rows.push({ key: 'movies', title: 'Movies', credits: movies, role: 'cast' })
  if (shows.length) rows.push({ key: 'shows', title: 'Shows', credits: shows, role: 'cast' })
  const departments = new Map<string, PersonCredit[]>()
  for (const c of p.credits) {
    for (const d of new Set(c.roles.filter((r) => r.job).map((r) => r.department || 'Crew'))) departments.set(d, [...(departments.get(d) ?? []), c])
  }
  ;[...departments.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([d, list]) => rows.push({ key: 'crew:' + d, title: d, credits: newestFirst(list), role: d }))
  return rows
}

function roleLine(c: PersonCredit, role: Row['role']) {
  if (upcoming(c)) return c.releaseDate ? `Coming ${c.releaseDate.slice(0, 4)}` : 'Coming soon'
  if (role === 'known') return c.year ?? ''
  if (role === 'cast') {
    const characters = c.roles.filter((r) => !r.job && r.character).map((r) => r.character)
    if (c.mediaType === 'tv' && c.episodeCount) return `${c.episodeCount} ${c.episodeCount === 1 ? 'episode' : 'episodes'}`
    return characters.length ? characters.join(', ') : (c.year ?? '')
  }
  return c.roles.filter((r) => r.job && (r.department || 'Crew') === role).map((r) => r.job).join(', ') || (c.year ?? '')
}

function day(value: string | null | undefined) {
  if (!value) return ''
  const d = new Date(value + 'T00:00:00')
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function PersonScreen() {
  const params = useLocalSearchParams<Params>()
  const personId = Number(params.id)
  const person = usePerson(personId)
  const base = useImageBase()
  const insets = useSafeAreaInsets()
  const { leave } = useLeave()
  const [more, setMore] = useState(false)
  const rows = useMemo(() => (person.data ? rowsOf(person.data) : []), [person.data])

  const p = person.data
  const name = p?.name ?? params.name ?? ''
  const face = p?.profilePath ?? (params.face || null)
  const lifespan = p?.deathday ? `${p.birthday?.slice(0, 4) ?? '?'} – ${p.deathday.slice(0, 4)}` : ''
  const line = p
    ? [p.knownForDepartment, p.birthday && !p.deathday ? `Born ${day(p.birthday)}${p.placeOfBirth ? ' in ' + p.placeOfBirth : ''}` : p.birthday ? `${day(p.birthday)} – ${day(p.deathday)}` : ''].filter(Boolean).join(' · ')
    : ''

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 64, paddingBottom: space.xxxl + insets.bottom }}>
        <View style={styles.header}>
          <View style={styles.face}>
            {face ? (
              <Image source={image(base, face, 'w185')} style={StyleSheet.absoluteFill} contentFit="cover" transition={motion.base} />
            ) : (
              <Text style={styles.initials}>{name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={name.length > 22 ? text.title : text.hero} numberOfLines={3}>
              {name}
            </Text>
            {lifespan ? <Text style={[text.small, { marginTop: space.xs }]}>{lifespan}</Text> : null}
          </View>
        </View>

        {person.isError ? (
          <View style={{ height: 240 }}>
            <Message title={`${name || 'This person'}’s page didn’t load`} body={person.error.message} action={{ label: 'Try again', onPress: () => person.refetch() }} />
          </View>
        ) : p ? (
          <Animated.View entering={FadeInDown.duration(motion.slow)}>
            {line ? <Text style={[text.small, styles.line]}>{line}</Text> : null}
            {p.biography ? (
              <Press onPress={() => setMore((m) => !m)} accessibilityRole="button" accessibilityLabel={more ? 'Show less' : 'Show the whole biography'}>
                <Text style={[text.body, styles.bio]} numberOfLines={more ? undefined : 4}>
                  {p.biography}
                </Text>
              </Press>
            ) : null}
            {rows.length === 0 ? <Text style={[text.small, styles.line]}>No movies or shows for {p.name} yet.</Text> : null}
            {rows.map((row) => (
              <View key={row.key} style={{ marginTop: space.xl }}>
                <Text style={[text.heading, styles.rowTitle]}>{row.title}</Text>
                <FlatList
                  {...ROW_LIST}
                  horizontal
                  data={row.credits}
                  keyExtractor={(c) => c.mediaType + c.tmdbId}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: space.l, gap: space.s }}
                  renderItem={({ item }) => {
                    const tag = posterTag('person-' + row.key, item.mediaType, item.tmdbId)
                    return (
                      <View style={{ width: POSTER_WIDTH, opacity: upcoming(item) ? 0.6 : 1 }}>
                        <Poster
                          title={item.title}
                          path={item.posterPath}
                          tag={tag}
                          onPress={() => openTitle(item.mediaType, item.tmdbId, { tag, posterPath: item.posterPath, backdropPath: item.backdropPath, title: item.title })}
                        />
                        <Text style={styles.cardName} numberOfLines={1}>
                          {item.title}
                        </Text>
                        <Text style={text.tiny} numberOfLines={1}>
                          {roleLine(item, row.role)}
                        </Text>
                      </View>
                    )
                  }}
                />
              </View>
            ))}
          </Animated.View>
        ) : null}
      </ScrollView>
      <View style={[styles.back, { top: insets.top + space.s }]}>
        <IconButton icon="chevron-back" label="Back" glass onPress={leave} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-end', gap: space.l, paddingHorizontal: space.l },
  face: { width: 112, height: 150, borderRadius: radius.m, overflow: 'hidden', backgroundColor: color.surface2, alignItems: 'center', justifyContent: 'center' },
  initials: { fontFamily: font.display, fontSize: 28, color: color.textDim },
  line: { paddingHorizontal: space.l, marginTop: space.l },
  bio: { paddingHorizontal: space.l, marginTop: space.m },
  rowTitle: { paddingHorizontal: space.l, marginBottom: space.m },
  cardName: { fontFamily: font.semibold, fontSize: 13, lineHeight: 17, color: color.textSoft, marginTop: space.s },
  back: { position: 'absolute', left: space.m },
})
