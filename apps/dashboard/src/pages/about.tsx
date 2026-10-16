import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/common'
import { useOverview } from '@/components/layout'

const CREDITS = [
  { name: 'torrent-stream', what: 'BitTorrent streaming engine', licence: 'MIT' },
  { name: 'Better Auth', what: 'Admin sign-in and device pairing', licence: 'MIT' },
  { name: 'Express, ws, Drizzle ORM', what: 'HTTP API, events, database', licence: 'MIT / Apache-2.0' },
  { name: 'FFmpeg', what: 'Audio transcoding (when installed or bundled)', licence: 'LGPL-2.1+' },
  { name: 'React, Vite, Tailwind CSS, shadcn/ui, Radix UI, Lucide', what: 'This dashboard', licence: 'MIT / ISC' },
  { name: 'js-spatial-navigation (TV app)', what: 'Remote-control navigation', licence: 'MPL-2.0' },
]

export function AboutPage() {
  const overview = useOverview()
  const s = overview.data
  return (
    <>
      <PageHeader title="About" />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <img src="/logo.svg" alt="" className="size-7" /> Playpex Media Server
          </CardTitle>
          <CardDescription>
            {s ? `Version ${s.server.version} · server id ${s.server.id} · Node ${s.process.node}` : 'Version …'} · dashboard{' '}
            {import.meta.env.VITE_APP_VERSION ?? '0.1.0'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Playpex is an <strong className="text-foreground">educational project</strong>. It streams torrents found by third-party
            providers; streaming copyrighted content may be illegal where you live. You are responsible for what you watch.
          </p>
          <p>IMDb ratings come from IMDb’s API, which allows limited non-commercial use only. Catalog data from TMDB.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Open-source software</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm">
            {CREDITS.map((c) => (
              <li key={c.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
                <span>
                  <span className="font-medium">{c.name}</span> <span className="text-muted-foreground">· {c.what}</span>
                </span>
                <span className="font-mono text-xs text-muted-foreground">{c.licence}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  )
}
