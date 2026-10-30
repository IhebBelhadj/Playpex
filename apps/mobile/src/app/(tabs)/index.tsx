import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { unwrap } from '../../lib/api'
import { useCatalogList } from '../../lib/catalog'
import { favouriteGenres, titlesOf, unseen, useDiscover, useGenres, useHistory, useSimilar, watchedTitles } from '../../lib/recommend'
import { useApi, useProfile } from '../../lib/session'
import { Row } from '../../ui/components'
import { ContinueRow, Hero, TopTenRow, type Pick } from '../../ui/home'
import { CatalogRow, TabPage } from '../../ui/rows'

// Home: picks for this profile in the hero (from what it watches most, else the
// week's trending), where it stopped, "because you watched…" from its last
// titles, the Top 10, then the catalog's rows.

export default function HomeScreen() {
  const api = useApi()
  const profile = useProfile()
  const library = useQuery({
    queryKey: ['library', profile.id],
    queryFn: () => unwrap(api.GET('/profiles/{profileId}/library', { params: { path: { profileId: profile.id } } })),
  })
  const history = useHistory()
  const genres = useGenres('movie')
  const tvGenres = useGenres('tv')
  const allGenres = useMemo(() => new Map([...(tvGenres.data ?? []), ...(genres.data ?? [])]), [genres.data, tvGenres.data])

  const watched = watchedTitles(history.data)
  const lastMovie = watched.find((h) => h.mediaType === 'movie')
  const lastShow = watched.find((h) => h.mediaType === 'tv')
  const likedMovieGenres = favouriteGenres(history.data, 'movie')
  const likedShowGenres = favouriteGenres(history.data, 'tv')

  const trending = useCatalogList('movie', 'trending')
  const trendingShows = useCatalogList('tv', 'trending')
  const forYou = useDiscover('movie', likedMovieGenres, 'rating')
  const showsForYou = useDiscover('tv', likedShowGenres, 'rating')
  const moreLikeMovie = useSimilar('movie', lastMovie?.tmdbId)
  const moreLikeShow = useSimilar('tv', lastShow?.tmdbId)

  // The hero: two picks from the profile's genres, then the week's trending, never what it watched
  const picks = useMemo<Pick[]>(() => {
    const genreName = likedMovieGenres.length ? allGenres.get(likedMovieGenres[0]) : undefined
    const mine = unseen(forYou.data, history.data)
      .slice(0, 2)
      .map((title) => ({ title, why: genreName ? `For you, because you watch ${genreName.toLowerCase()}` : 'For you' }))
    const hot = unseen(titlesOf(trending.data?.results), history.data)
      .filter((t) => !mine.some((m) => m.title.tmdbId === t.tmdbId))
      .slice(0, 5 - mine.length)
      .map((title) => ({ title, why: 'Trending this week' }))
    return [...mine, ...hot]
  }, [forYou.data, trending.data, history.data, likedMovieGenres, allGenres])

  const showGenre = likedShowGenres.length ? allGenres.get(likedShowGenres[0]) : undefined

  return (
    <TabPage overHero>
      <Hero picks={picks} genres={allGenres} />
      <ContinueRow items={library.data?.continueWatching ?? []} />
      {lastMovie ? (
        <Row label={`Because you watched ${lastMovie.title ?? 'a movie'}`} titles={unseen(moreLikeMovie.data, history.data)} loading={moreLikeMovie.isPending} scope="like-movie" />
      ) : null}
      <TopTenRow label="Top 10 movies this week" titles={titlesOf(trending.data?.results)} loading={trending.isPending} scope="top-movies" />
      {lastShow ? (
        <Row label={`Because you watched ${lastShow.title ?? 'a show'}`} titles={unseen(moreLikeShow.data, history.data)} loading={moreLikeShow.isPending} scope="like-show" />
      ) : null}
      {likedShowGenres.length ? (
        <Row label="Shows for you" why={showGenre ? `The best-rated ${showGenre.toLowerCase()}` : undefined} titles={unseen(showsForYou.data, history.data)} loading={showsForYou.isPending} scope="shows-for-you" />
      ) : null}
      <TopTenRow label="Top 10 shows this week" titles={titlesOf(trendingShows.data?.results)} loading={trendingShows.isPending} scope="top-shows" />
      <CatalogRow mediaType="movie" list="now_playing" label="New in cinemas" />
      <CatalogRow mediaType="tv" list="top_rated" label="Shows everyone rates highly" />
      <CatalogRow mediaType="movie" list="upcoming" label="Coming soon" />
    </TabPage>
  )
}
