import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Film, Tv, User } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { AddDownloadDialog } from '@/components/add-download'
import { Loading, QueryError } from '@/components/common'
import { TitleSourcesSheet } from '@/components/search/titles'
import { Button } from '@/components/ui/button'
import { api, unwrap, type Schemas } from '@/lib/api'
import { useDownloads } from '@/lib/downloads'
import { tmdbImage } from '@/lib/media'
import type { CatalogTitle } from '@/lib/search'

// /people/:id (docs/people-plan.md §5): a person's page from Search. Who they
// are (portrait, department, birth, biography), then their titles as poster
// grids by role: Known for, Movies, Shows (as cast), one per crew department.
// A title opens what Search opens for one: its sources (play, download).

type Person = Schemas['CatalogPersonDetails']
type Credit = Schemas['CatalogPersonCredit']
type Group = { key: string; title: string; credits: Credit[]; role: 'known' | 'cast' | string }

const today = () => new Date().toISOString().slice(0, 10)

function day(value: string | null | undefined) {
  if (!value) return ''
  const d = new Date(value + 'T00:00:00')
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

// newest first; not out yet before them; without a poster last
function newestFirst(list: Credit[]) {
  const now = today()
  const upcoming = (c: Credit) => !c.releaseDate || c.releaseDate > now
  const pictured = list.filter((c) => c.posterPath)
  return [
    ...pictured.filter(upcoming).sort((a, b) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999')),
    ...pictured.filter((c) => !upcoming(c)).sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '')),
    ...list.filter((c) => !c.posterPath),
  ]
}

function groupsOf(person: Person): Group[] {
  const groups: Group[] = []
  const known = person.knownFor.map((id) => person.credits.find((c) => c.tmdbId === id)).filter((c): c is Credit => !!c)
  if (known.length) groups.push({ key: 'known', title: 'Known for', credits: known, role: 'known' })
  const cast = person.credits.filter((c) => c.roles.some((r) => !r.job))
  const movies = newestFirst(cast.filter((c) => c.mediaType === 'movie'))
  const shows = newestFirst(cast.filter((c) => c.mediaType === 'tv'))
  if (movies.length) groups.push({ key: 'movies', title: 'Movies', credits: movies, role: 'cast' })
  if (shows.length) groups.push({ key: 'shows', title: 'Shows', credits: shows, role: 'cast' })
  const departments = new Map<string, Credit[]>()
  for (const c of person.credits) {
    for (const d of new Set(c.roles.filter((r) => r.job).map((r) => r.department || 'Crew'))) {
      departments.set(d, [...(departments.get(d) ?? []), c])
    }
  }
  ;[...departments.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([d, list]) => groups.push({ key: 'crew:' + d, title: d, credits: newestFirst(list), role: d }))
  return groups
}

function roleLine(c: Credit, role: Group['role']) {
  if (!c.releaseDate || c.releaseDate > today()) return c.releaseDate ? `Coming ${c.releaseDate.slice(0, 4)}` : 'Coming soon'
  if (role === 'known') return [c.year, c.mediaType === 'tv' ? 'Show' : 'Movie'].filter(Boolean).join(', ')
  if (role === 'cast') {
    const characters = c.roles.filter((r) => !r.job && r.character).map((r) => r.character)
    const episodes = c.mediaType === 'tv' && c.episodeCount ? `${c.episodeCount} ${c.episodeCount === 1 ? 'episode' : 'episodes'}` : ''
    return [characters.length ? 'as ' + characters.join(', ') : c.year, episodes].filter(Boolean).join(' · ')
  }
  return c.roles.filter((r) => r.job && (r.department || 'Crew') === role).map((r) => r.job).join(', ') || c.year || ''
}

export function PersonPage() {
  const { personId = '' } = useParams()
  const navigate = useNavigate()
  const [open, setOpen] = useState<CatalogTitle | null>(null)
  const [adding, setAdding] = useState<{ link: string; name: string } | null>(null)
  const [more, setMore] = useState(false)
  const downloads = useDownloads()
  const labels = useMemo(() => [...new Set((downloads.data ?? []).map((d) => d.label).filter((l): l is string => !!l))].sort(), [downloads.data])
  const person = useQuery({
    queryKey: ['catalog-person', personId],
    queryFn: () => unwrap(api.GET('/catalog/people/{personId}', { params: { path: { personId: Number(personId) } } })),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const groups = useMemo(() => (person.data ? groupsOf(person.data) : []), [person.data])

  if (person.isPending) return <Loading rows={4} />
  if (person.error) return <QueryError error={person.error} title="Couldn’t load this person’s page" />
  const p = person.data
  const face = tmdbImage(p.profilePath, 'w342')
  const lifespan = p.deathday ? `${p.birthday?.slice(0, 4) ?? '?'} – ${p.deathday.slice(0, 4)}` : ''
  const born = p.birthday && !p.deathday ? `Born ${day(p.birthday)}${p.placeOfBirth ? ' in ' + p.placeOfBirth : ''}` : p.birthday ? `${day(p.birthday)} – ${day(p.deathday)}` : ''
  const paragraphs = p.biography.split(/\n+/).map((x) => x.trim()).filter(Boolean)
  const long = paragraphs.length > 1 || p.biography.length > 600

  return (
    <div className="space-y-10">
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => navigate(-1)}>
        <ArrowLeft /> Back
      </Button>

      <header className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="aspect-2/3 w-36 shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-border sm:w-44">
          {face ? <img src={face} alt="" className="size-full object-cover" /> : <User className="m-auto mt-16 size-10 text-muted-foreground" />}
        </div>
        <div className="min-w-0 max-w-3xl space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {p.name}
            {lifespan && <span className="ml-3 text-lg font-normal text-muted-foreground">{lifespan}</span>}
          </h1>
          <p className="text-sm text-muted-foreground">{[p.knownForDepartment, born].filter(Boolean).join(' · ')}</p>
          {paragraphs.length ? (
            <div className="space-y-3 text-sm leading-relaxed">
              {(more ? paragraphs : paragraphs.slice(0, 1)).map((x, i) => (
                <p key={i} className={!more && long ? 'line-clamp-5' : undefined}>
                  {x}
                </p>
              ))}
              {long && (
                <button type="button" className="font-medium underline underline-offset-2" onClick={() => setMore((m) => !m)}>
                  {more ? 'Less' : 'More'}
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No biography yet.</p>
          )}
          {p.imdbId && (
            <a href={`https://www.imdb.com/name/${p.imdbId}/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              IMDb <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </header>

      {groups.length === 0 && <p className="text-sm text-muted-foreground">No movies or shows for {p.name} yet.</p>}
      {groups.map((g) => (
        <section key={g.key} className="space-y-3">
          <h2 className="text-base font-semibold">
            {g.title} <span className="ml-1 text-sm font-normal text-muted-foreground">{g.credits.length}</span>
          </h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-4 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]">
            {g.credits.map((c) => {
              const poster = tmdbImage(c.posterPath, 'w342')
              const upcoming = !c.releaseDate || c.releaseDate > today()
              return (
                <li key={`${c.mediaType}:${c.tmdbId}`} className={upcoming ? 'opacity-60' : undefined}>
                  <button type="button" onClick={() => setOpen(c)} className="group block w-full rounded-md text-left outline-none" title={c.title}>
                    <span className="relative block aspect-2/3 overflow-hidden rounded-md bg-muted ring-1 ring-border transition-shadow group-hover:ring-2 group-hover:ring-foreground/60 group-focus-visible:ring-2 group-focus-visible:ring-foreground">
                      {poster ? (
                        <img src={poster} alt="" loading="lazy" className="size-full object-cover" />
                      ) : (
                        <span className="flex size-full flex-col justify-end gap-1 p-3">
                          {c.mediaType === 'tv' ? <Tv className="size-4 text-muted-foreground" /> : <Film className="size-4 text-muted-foreground" />}
                          <span className="line-clamp-4 text-sm leading-snug font-medium">{c.title}</span>
                        </span>
                      )}
                    </span>
                    <span className="mt-2 block truncate text-sm leading-tight font-medium">{c.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{roleLine(c, g.role)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      <p className="text-xs text-muted-foreground">
        From the catalog (TMDB). <Link to="/search" className="underline underline-offset-2">Search</Link> for someone else.
      </p>

      <TitleSourcesSheet title={open} onClose={() => setOpen(null)} onAdd={(magnet, name) => setAdding({ link: magnet, name })} />
      {adding && (
        <AddDownloadDialog
          key={adding.link}
          open
          link={adding.link}
          labels={labels}
          onOpenChange={(o) => {
            if (!o) setAdding(null)
          }}
        />
      )}
    </div>
  )
}
