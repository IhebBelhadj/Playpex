import { User } from 'lucide-react'
import { Link } from 'react-router'
import { tmdbImage } from '@/lib/media'
import type { CatalogPerson } from '@/lib/search'
import { cn } from '@/lib/utils'

// Search › People (docs/people-plan.md §5): faces, names and what each is known
// for (two people with one name told apart); one opens their page, /people/:id.

/** What a person result is known for: their titles, else their department */
function knownForLine(p: CatalogPerson) {
  const titles = (p.knownFor ?? []).map((k) => k.title).filter(Boolean)
  return titles.length ? titles.join(', ') : (p.knownForDepartment ?? '')
}

/** Faces: a grid, or one row of them (`strip`: Top results) */
export function PeopleFaces({ people, limit, strip }: { people: CatalogPerson[]; limit?: number; strip?: boolean }) {
  return (
    <ul
      className={cn(
        strip
          ? 'grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 [&>li:nth-child(n+4)]:hidden sm:[&>li:nth-child(n+4)]:block sm:[&>li:nth-child(n+5)]:hidden lg:[&>li:nth-child(n+5)]:block lg:[&>li:nth-child(n+7)]:hidden xl:[&>li:nth-child(n+7)]:block'
          : 'grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-4 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]',
      )}
    >
      {people.slice(0, limit ?? people.length).map((p) => {
        const face = tmdbImage(p.profilePath, 'w185')
        return (
          <li key={p.personId}>
            <Link to={`/people/${p.personId}`} className="group block rounded-md outline-none" title={p.name}>
              <span className="relative block aspect-2/3 overflow-hidden rounded-md bg-muted ring-1 ring-border transition-shadow group-hover:ring-2 group-hover:ring-foreground/60 group-focus-visible:ring-2 group-focus-visible:ring-foreground">
                {face ? (
                  <img src={face} alt="" loading="lazy" className="size-full object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center">
                    <User className="size-8 text-muted-foreground" />
                  </span>
                )}
              </span>
              <span className="mt-2 block truncate text-sm leading-tight font-medium">{p.name}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{knownForLine(p)}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
