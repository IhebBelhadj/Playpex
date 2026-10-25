import type { ColumnDef } from '@tanstack/react-table'
import { Check, Copy, Download as DownloadIcon, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { DataTable, type RowAction } from '@/components/data-table'
import { qualityOf, Seeds, useSearchActions } from '@/components/search/parts'
import { Button } from '@/components/ui/button'
import { ago, bytes } from '@/lib/format'
import { episodeCode } from '@/lib/media'
import type { Release } from '@/lib/search'

// Search › Torrents: the release providers' torrents as a DataTable (sorted by
// seeds; name and what Playpex reads in it, quality, size, seeds as signal
// bars, peers, source, uploaded; Add opens the Add dialog with the magnet),
// and as rows on a phone.

export function TorrentTable({
  releases,
  kept,
  sourceName,
  onAdd,
}: {
  releases: Release[]
  /** info hashes the server already keeps */
  kept: Set<string>
  sourceName: (t: Release) => string
  onAdd: (t: Release) => void
}) {
  const [selection, setSelection] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const navigate = useNavigate()
  const act = useSearchActions()
  const byHash = useMemo(() => new Map(releases.map((t) => [t.hash, t])), [releases])

  const open = (t: Release) => (kept.has(t.hash) ? navigate(`/downloads?hash=${t.hash}`) : onAdd(t))
  const actions = (t: Release): RowAction[] => [
    kept.has(t.hash)
      ? { label: 'Show in Downloads', icon: <DownloadIcon />, shortcut: 'Enter', onSelect: () => navigate(`/downloads?hash=${t.hash}`) }
      : { label: 'Add…', icon: <Plus />, shortcut: 'Enter', onSelect: () => onAdd(t) },
    { label: 'Add and start', icon: <DownloadIcon />, disabled: kept.has(t.hash), onSelect: () => act.startTorrent(t.magnet, t.name) },
    'separator',
    { label: 'Copy magnet link', icon: <Copy />, onSelect: () => act.copy(t.magnet, 'Magnet link') },
  ]

  const columns = useMemo<ColumnDef<Release, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (t) => t.name.toLowerCase(),
        header: 'Name',
        meta: { label: 'Name', fixed: true, className: 'w-full max-w-0 min-w-56' },
        cell: ({ row: { original: t } }) => <ReleaseName release={t} kept={kept.has(t.hash)} />,
      },
      {
        id: 'quality',
        accessorFn: (t) => ['unknown', 'SD', '720p', '1080p', '2160p'].indexOf(qualityOf(t)),
        header: 'Quality',
        meta: { label: 'Quality' },
        cell: ({ row: { original: t } }) => (qualityOf(t) === 'unknown' ? <span className="text-muted-foreground">—</span> : qualityOf(t)),
      },
      {
        id: 'size',
        accessorFn: (t) => t.size ?? -1,
        header: 'Size',
        meta: { label: 'Size', numeric: true },
        cell: ({ row: { original: t } }) => (t.size ? bytes(t.size) : <span className="text-muted-foreground">—</span>),
      },
      {
        id: 'seeds',
        accessorFn: (t) => t.seeds,
        header: 'Seeds',
        meta: { label: 'Seeds', numeric: true },
        cell: ({ row: { original: t } }) => <Seeds seeds={t.seeds} />,
      },
      {
        id: 'peers',
        accessorFn: (t) => t.peers ?? -1,
        header: 'Peers',
        meta: { label: 'Peers', numeric: true, from: '3xl' },
        cell: ({ row: { original: t } }) => (t.peers == null ? <span className="text-muted-foreground">—</span> : t.peers),
      },
      {
        id: 'source',
        accessorFn: (t) => sourceName(t),
        header: 'Source',
        meta: { label: 'Source', from: '4xl' },
        cell: ({ row: { original: t } }) => <span className="whitespace-nowrap text-muted-foreground">{sourceName(t)}</span>,
      },
      {
        id: 'added',
        accessorFn: (t) => t.added ?? 0,
        header: 'Uploaded',
        meta: { label: 'Uploaded', from: '5xl' },
        cell: ({ row: { original: t } }) => (
          <span className="whitespace-nowrap text-muted-foreground">{t.added ? ago(new Date(t.added * 1000).toISOString()) : '—'}</span>
        ),
      },
      {
        id: 'add',
        header: () => <span className="sr-only">Add</span>,
        enableSorting: false,
        meta: { label: 'Add', fixed: true },
        cell: ({ row: { original: t } }) =>
          kept.has(t.hash) ? (
            <span className="flex items-center justify-end gap-1 pr-1 text-xs whitespace-nowrap text-up">
              <Check className="size-3.5" /> Kept
            </span>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              onClick={(e) => {
                e.stopPropagation()
                onAdd(t)
              }}
            >
              <Plus /> Add
            </Button>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kept, sourceName],
  )

  return (
    <DataTable
      label="Torrents found"
      data={releases}
      columns={columns}
      getRowId={(t) => t.hash}
      storageKey="playpex.search.columns"
      defaultSorting={[{ id: 'seeds', desc: true }]}
      selection={selection}
      onSelectionChange={setSelection}
      active={active}
      onActiveChange={setActive}
      onOpen={(id) => byHash.get(id) && open(byHash.get(id)!)}
      actions={actions}
      rowClassName={(t) => (t.matches === false ? 'opacity-70' : undefined)}
      className="flex-1 rounded-lg border"
    />
  )
}

/** A release's name, and under it what Playpex reads in it */
export function ReleaseName({ release: t, kept }: { release: Release; kept: boolean }) {
  const reading = [
    t.title ? `${t.title}${t.year ? ` (${t.year})` : ''}` : null,
    t.pack && t.season != null ? `Season ${t.season}, whole` : null,
    !t.pack && t.season != null && t.episode != null ? episodeCode(t.season, t.episode) : null,
    t.codec,
    t.audio === 'unsupported' ? 'Dolby or DTS sound' : null,
  ].filter(Boolean)
  return (
    <div className="min-w-0">
      <div className="truncate font-medium" title={t.name}>
        {t.name}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {kept && (
          <span className="inline-flex shrink-0 items-center gap-1 text-up">
            <DownloadIcon className="size-3" /> In Downloads
          </span>
        )}
        <span className="truncate">{reading.join(', ')}</span>
        {t.matches === false && <span className="shrink-0">not every word</span>}
      </div>
    </div>
  )
}
