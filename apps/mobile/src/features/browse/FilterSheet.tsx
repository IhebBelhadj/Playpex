import { useRef, useState, type ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useInfiniteQuery } from '@tanstack/react-query'
import * as Haptics from 'expo-haptics'
import { ERAS, LIST_NAMES, RATINGS, SORTS, cleared, filterCount, toggleGenre, type BrowseQuery, type Phrase } from '../../core/catalog/browse'
import type { Schemas } from '../../core/http/api'
import { LANGUAGES } from '../../core/util/languages'
import { useClient } from '../../state/app'
import { useDebouncedValue } from '../../state/hooks'
import { queries } from '../../state/queries'
import { Button } from '../../ui/components'
import { Chip } from '../../ui/section'
import { Segmented } from '../../ui/settings'
import { Sheet } from '../../ui/sheet'
import { color, space, text } from '../../ui/theme'

// The See all page's filters, all in one panel: the order, genres (any or all
// of them), when it came out, a minimum score, the original language. What
// changes here is a draft until "Show 1,240 movies": the count is the server's
// for the draft, asked as it changes (its first page is then already loaded).

type Part = NonNullable<Phrase['part']>

export function FilterSheet({
  mediaType,
  query,
  genres,
  focus,
  onApply,
  onClose,
}: {
  mediaType: 'movie' | 'tv'
  query: BrowseQuery
  genres: Schemas['CatalogGenre'][]
  /** The section to open at (the words of the title tapped) */
  focus: Part | null
  onApply: (query: BrowseQuery) => void
  onClose: () => void
}) {
  const client = useClient()
  const [draft, setDraft] = useState(query)
  const settled = useDebouncedValue(draft, 350)
  const count = useInfiniteQuery(queries.browse(client, mediaType, settled))
  const total = settled === draft ? count.data?.pages[0]?.totalResults : undefined
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const scrolled = useRef(false)
  const noun = mediaType === 'movie' ? 'movies' : 'shows'
  const narrowed = filterCount(draft) > 0

  function change(next: BrowseQuery) {
    Haptics.selectionAsync()
    // A list can't be filtered: narrowing it means the catalogue, most popular first
    setDraft(next.sort === 'list' && filterCount(next) > 0 ? { ...next, sort: 'popularity' } : next)
  }

  /** The section the sheet was opened for, scrolled to once it has its place */
  function placed(part: Part, y: number) {
    if (part !== focus || scrolled.current || y < 40) return
    scrolled.current = true
    scroll.current?.scrollTo({ y: y - space.m, animated: false })
  }

  const label = total == null ? `Show ${noun}` : total === 0 ? `No ${noun}` : `Show ${total.toLocaleString()} ${total === 1 ? noun.slice(0, -1) : noun}`

  return (
    <Sheet
      label="Filters"
      onClose={onClose}
      footer={
        <>
          <Button kind="quiet" label="Clear" disabled={!narrowed} onPress={() => change(cleared(draft))} />
          <Button label={label} disabled={total === 0} onPress={() => onApply(draft)} style={{ flex: 1 }} />
        </>
      }
    >
      <ScrollView ref={scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Section title="Order" onPlaced={(y) => placed('sort', y)}>
          <View style={styles.wrap}>
            {draft.list ? (
              <Chip label={`As in ${LIST_NAMES[draft.list]}`} on={draft.sort === 'list'} onPress={() => change(narrowed ? draft : { ...draft, sort: 'list' })} />
            ) : null}
            {SORTS.map((s) => (
              <Chip key={s.value} label={s.label} on={draft.sort === s.value} onPress={() => change({ ...draft, sort: s.value })} />
            ))}
          </View>
          {draft.list && narrowed ? <Text style={[text.tiny, styles.hint]}>{LIST_NAMES[draft.list]} keeps its own order only without filters.</Text> : null}
        </Section>

        <Section title="Genres" onPlaced={(y) => placed('genres', y)}>
          <View style={styles.wrap}>
            {genres.map((g) => (
              <Chip key={g.id} label={g.name} on={draft.genres.includes(g.id)} onPress={() => change(toggleGenre(draft, g.id))} />
            ))}
          </View>
          {draft.genres.length > 1 ? (
            <View style={{ marginTop: space.s }}>
              <Segmented
                choices={[
                  { value: 'any', label: 'Any of them' },
                  { value: 'all', label: 'All of them' },
                ]}
                value={draft.matchAll ? 'all' : 'any'}
                onChoose={(v) => change({ ...draft, matchAll: v === 'all' })}
              />
            </View>
          ) : null}
        </Section>

        <Section title="Released" onPlaced={(y) => placed('era', y)}>
          <View style={styles.wrap}>
            <Chip label="Any time" on={draft.era == null} onPress={() => change({ ...draft, era: null })} />
            {ERAS.map((e) => (
              <Chip key={e.value} label={e.label} on={draft.era === e.value} onPress={() => change({ ...draft, era: draft.era === e.value ? null : e.value })} />
            ))}
          </View>
        </Section>

        <Section title="Score" why="TMDB’s, from people who rated it" onPlaced={(y) => placed('rating', y)}>
          <View style={styles.wrap}>
            <Chip label="Any score" on={draft.minRating == null} onPress={() => change({ ...draft, minRating: null })} />
            {RATINGS.map((r) => (
              <Chip key={r} label={`${r} and up`} on={draft.minRating === r} onPress={() => change({ ...draft, minRating: draft.minRating === r ? null : r })} />
            ))}
          </View>
        </Section>

        <Section title="Original language" onPlaced={(y) => placed('language', y)}>
          <View style={styles.wrap}>
            <Chip label="Any language" on={draft.language == null} onPress={() => change({ ...draft, language: null })} />
            {LANGUAGES.map((l) => (
              <Chip key={l.code} label={l.name} on={draft.language === l.code} onPress={() => change({ ...draft, language: draft.language === l.code ? null : l.code })} />
            ))}
          </View>
        </Section>
      </ScrollView>
    </Sheet>
  )
}

function Section({ title, why, onPlaced, children }: { title: string; why?: string; onPlaced: (y: number) => void; children: ReactNode }) {
  return (
    <View style={styles.section} onLayout={(e) => onPlaced(e.nativeEvent.layout.y)}>
      <Text style={text.heading}>{title}</Text>
      {why ? <Text style={[text.tiny, { marginTop: space.xxs }]}>{why}</Text> : null}
      <View style={{ marginTop: space.m }}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.l, paddingBottom: space.l },
  section: { paddingVertical: space.l, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  hint: { marginTop: space.s },
})
