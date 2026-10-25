import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Empty, Loading, QueryError } from '@/components/common'
import { PluginIcon, PluginStateBadge, type AdminPlugin } from '@/components/plugin-common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { API_PREFIX, api, errorMessage, unwrap } from '@/lib/api'

// Settings › Metadata, below TMDB's settings: the installed metadata providers
// (plugins with `metadata.details`, or the older `metadata.title`), in the order
// their ratings show on title pages, each switchable (settings
// `metadata.order` / `metadata.disabled`, saved at once; apps/server/lib/catalog.js
// orders them the same way: listed ones first, the others by id).

const HOOKS = ['metadata.details', 'metadata.title']

function ordered(plugins: AdminPlugin[], order: string[]) {
  return plugins.slice().sort((a, b) => {
    const i = order.indexOf(a.id)
    const j = order.indexOf(b.id)
    if (i === -1 && j === -1) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    return i === -1 ? 1 : j === -1 ? -1 : i - j
  })
}

export function MetadataProviders() {
  const client = useQueryClient()
  const plugins = useQuery({ queryKey: ['admin-plugins'], queryFn: () => unwrap(api.GET('/admin/plugins')) })
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => unwrap(api.GET('/admin/settings')) })
  const save = useMutation({
    mutationFn: (metadata: { order?: string[]; disabled?: string[] }) => unwrap(api.PUT('/admin/settings', { body: { metadata } })),
    onSuccess: (r) => {
      client.setQueryData(['settings'], r.settings)
      toast.success('Metadata providers saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  if (plugins.isPending || settings.isPending) return <Loading rows={2} />
  if (plugins.error || settings.error) return <QueryError error={(plugins.error ?? settings.error)!} title="Could not load the metadata providers" />
  const { order, disabled } = settings.data.settings.metadata
  const list = ordered(plugins.data.plugins.filter((p) => p.hooks.some((h) => HOOKS.includes(h))), order)
  const move = (index: number, by: number) => {
    const ids = list.map((p) => p.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + by, 0, id)
    save.mutate({ order: ids })
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Metadata providers</CardTitle>
        <CardDescription>
          Plugins that add ratings, tags and links to title pages, after TMDB’s. The first one’s rating shows first. They add, never replace.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {list.length === 0 ? (
          <Empty title="No metadata provider installed">
            <p className="text-sm text-muted-foreground">
              Trakt, for one, adds its ratings. <Link className="underline underline-offset-2" to="/plugins?tab=browse">Browse plugins</Link>
            </p>
          </Empty>
        ) : (
          <ul className="divide-y">
            {list.map((p, i) => {
              const on = !disabled.includes(p.id)
              return (
                <li key={p.id} className="flex items-center gap-3 py-3">
                  <PluginIcon src={p.icon ? API_PREFIX + p.icon : null} className="size-8" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/plugins/${p.id}`} className="truncate font-medium hover:underline">
                        {p.name}
                      </Link>
                      {p.state !== 'enabled' && <PluginStateBadge plugin={p} />}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {p.hooks.includes('metadata.details') ? 'Ratings, tags and links' : 'Information on title pages (older plugin)'}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move ${p.name} up`} disabled={i === 0 || save.isPending} onClick={() => move(i, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${p.name} down`}
                    disabled={i === list.length - 1 || save.isPending}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Switch
                    aria-label={`${p.name} on title pages`}
                    checked={on}
                    disabled={save.isPending}
                    onCheckedChange={(v) => save.mutate({ disabled: v ? disabled.filter((id) => id !== p.id) : [...disabled, p.id] })}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
