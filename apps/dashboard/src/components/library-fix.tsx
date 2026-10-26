import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Film, Play, Search, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Empty, Loading, QueryError } from '@/components/common'
import { fileName, MatchCell, quality, type FileState, type LibraryFolder } from '@/components/library-common'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, unwrap } from '@/lib/api'
import { bytes } from '@/lib/format'
import { placeOf, usePlayer } from '@/lib/player'

// The Library's "To fix" view: files the scanner couldn't match, files gone
// from the disk, ignored ones (and every file, filtered), to open and fix.

const FILTERS: { id: FileState | 'all'; label: string }[] = [
  { id: 'unmatched', label: 'Unmatched' },
  { id: 'missing', label: 'Missing' },
  { id: 'ignored', label: 'Ignored' },
  { id: 'all', label: 'All files' },
]

const PAGE = 100

export function FileList({
  folders,
  totals,
  onOpen,
  onRetry,
  retrying,
}: {
  folders: LibraryFolder[]
  totals: Record<FileState, number>
  onOpen: (id: string) => void
  onRetry: () => void
  retrying: boolean
}) {
  const player = usePlayer()
  const [state, setStateRaw] = useState<FileState | 'all'>(totals.unmatched ? 'unmatched' : 'all')
  const [folderId, setFolderIdRaw] = useState('all')
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  // a new filter starts on the first page
  const setState = (value: FileState | 'all') => {
    setStateRaw(value)
    setOffset(0)
  }
  const setFolderId = (value: string) => {
    setFolderIdRaw(value)
    setOffset(0)
  }
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(typed.trim())
      setOffset(0)
    }, 300)
    return () => clearTimeout(t)
  }, [typed])

  const files = useQuery({
    queryKey: ['library-files', state, folderId, q, offset],
    queryFn: () =>
      unwrap(
        api.GET('/admin/library/files', {
          params: {
            query: {
              ...(state !== 'all' && { state }),
              ...(folderId !== 'all' && { folder: folderId }),
              ...(q && { q }),
              limit: PAGE,
              offset,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  })
  const folderPath = useMemo(() => new Map(folders.map((f) => [f.id, f.path])), [folders])
  const count = (id: FileState | 'all') => (id === 'all' ? totals.ok + totals.unmatched + totals.missing + totals.ignored : totals[id])
  const list = files.data?.files ?? []
  const total = files.data?.total ?? 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-base font-semibold">Files</h2>
        {state === 'unmatched' && totals.unmatched > 0 && (
          <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry} title="Scan every folder and try to match these files again">
            <Wand2 /> Match again
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={state} onValueChange={(v) => setState(v as FileState | 'all')} className="max-w-full overflow-x-auto [scrollbar-width:none]">
          <TabsList>
            {FILTERS.map((f) => (
              <TabsTrigger key={f.id} value={f.id}>
                {f.label}
                <span className="ml-1 text-muted-foreground tabular-nums">{count(f.id)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {folders.length > 1 && (
          <Select value={folderId} onValueChange={setFolderId}>
            <SelectTrigger className="w-full sm:w-56" aria-label="Folder">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every folder</SelectItem>
              {folders.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="relative w-full sm:ml-auto sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={typed} placeholder="Path or title" className="pl-9" aria-label="Search files" onChange={(e) => setTyped(e.target.value)} />
        </div>
      </div>
      {files.error ? (
        <QueryError error={files.error} title="Could not load the files" />
      ) : files.isPending ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty icon={<Film />} title={q ? 'No file matches this search' : state === 'unmatched' ? 'Every file is matched' : 'No files here'}>
          {state === 'unmatched' && !q ? 'Files the scanner could not match to TMDB show up here, to be matched by hand.' : null}
        </Empty>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead className="hidden md:table-cell">Match</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Quality</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Size</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody className={files.isPlaceholderData ? 'opacity-60' : undefined}>
                {list.map((file) => (
                  <TableRow key={file.id} className="cursor-pointer" onClick={() => onOpen(file.id)}>
                    <TableCell className="w-full max-w-0">
                      <div className="truncate font-medium" title={file.relPath}>
                        {fileName(file.relPath)}
                      </div>
                      <div className="truncate text-xs text-muted-foreground" title={`${folderPath.get(file.folderId)}/${file.relPath}`}>
                        {file.relPath.includes('/') ? file.relPath.slice(0, file.relPath.lastIndexOf('/')) : folderPath.get(file.folderId)}
                      </div>
                      {/* the match, on phones */}
                      <div className="mt-1 md:hidden">
                        <MatchCell file={file} />
                      </div>
                    </TableCell>
                    <TableCell className="hidden max-w-64 md:table-cell">
                      <MatchCell file={file} />
                    </TableCell>
                    <TableCell className="hidden text-right text-xs whitespace-nowrap text-muted-foreground lg:table-cell">
                      {quality(file) ?? '—'}
                    </TableCell>
                    <TableCell className="hidden text-right text-xs whitespace-nowrap tabular-nums sm:table-cell">{bytes(file.size)}</TableCell>
                    <TableCell className="pr-2" onClick={(e) => e.stopPropagation()}>
                      {file.state !== 'missing' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Play ${fileName(file.relPath)}`}
                          title="Play"
                          onClick={() => player.play({ ref: file.ref, title: fileName(file.relPath), detail: folderPath.get(file.folderId), ...placeOf(file.folderId, file.relPath) })}
                        >
                          <Play />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {total > PAGE && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground tabular-nums">
          <span>
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  )
}
