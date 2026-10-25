import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileUp, FolderTree, Info } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Spinner } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { bytes } from '@/lib/format'
import { cn } from '@/lib/utils'

// "Add torrent" (docs/dashboard-plan.md §4.1): a magnet, a link or a .torrent
// file; before adding, what it is (POST /downloads/preview: its files when
// they are known without the swarm, the download the server already keeps),
// which files, a label, start now or later.

type Preview = Schemas['DownloadPreview']

function asForm(file: File, fields: Record<string, string>) {
  const form = new FormData()
  form.append('file', file)
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return form
}

const multipart = { bodySerializer: (b: unknown) => b as FormData }

export function AddDownloadDialog({
  open,
  onOpenChange,
  file: dropped,
  labels,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** a .torrent dropped on the page */
  file?: File | null
  /** labels in use, offered as suggestions */
  labels: string[]
}) {
  const client = useQueryClient()
  // mounted again for every opening (its key): a dropped file is where it starts
  const [link, setLink] = useState('')
  const [file, setFile] = useState<File | null>(dropped ?? null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [label, setLabel] = useState('')
  const [startNow, setStartNow] = useState(true)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)


  // what it is, as soon as there's something to read (a link: once typing stops)
  useEffect(() => {
    if (!open) return
    const value = link.trim()
    if (!file && !value) return
    let cancelled = false
    const timer = setTimeout(
      () => {
        setChecking(true)
        const request = file
          ? unwrap(api.POST('/downloads/preview', { body: asForm(file, {}) as never, ...multipart }))
          : unwrap(api.POST('/downloads/preview', { body: { link: value } }))
        request
          .then((p) => {
            if (cancelled) return
            setPreview(p)
            setPreviewError(null)
            setChosen(new Set(p.files?.map((f) => f.path) ?? []))
          })
          .catch((err) => {
            if (cancelled) return
            setPreview(null)
            setPreviewError(errorMessage(err))
          })
          .finally(() => !cancelled && setChecking(false))
      },
      file ? 0 : 400,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, link, file])

  const hasInput = !!file || !!link.trim()
  const shownPreview = hasInput ? preview : null
  const shownError = hasInput ? previewError : null
  const files = shownPreview?.files ?? null
  const all = files !== null && chosen.size === files.length
  const size = useMemo(() => (files ?? []).filter((f) => chosen.has(f.path)).reduce((s, f) => s + f.size, 0), [files, chosen])

  const add = useMutation({
    mutationFn: () => {
      const paths = files && !all ? [...chosen] : undefined
      const name = shownPreview?.name
      if (file) {
        const fields: Record<string, string> = {}
        if (paths) fields.files = JSON.stringify(paths)
        if (label.trim()) fields.label = label.trim()
        if (!startNow) fields.paused = 'true'
        return unwrap(api.POST('/downloads', { body: asForm(file, fields) as never, ...multipart })).then((d) => ({ d, name }))
      }
      return unwrap(
        api.POST('/downloads', {
          body: { link: link.trim(), files: paths, label: label.trim() || undefined, paused: startNow ? undefined : true },
        }),
      ).then((d) => ({ d, name }))
    },
    onSuccess: ({ d, name }) => {
      toast.success(`Added ${d.name ?? name ?? 'the torrent'}`, {
        description: startNow ? (d.state === 'queued' ? `Queued #${d.queuePosition ?? 1}: it starts when a slot is free.` : undefined) : 'Paused until you start it.',
      })
      client.invalidateQueries({ queryKey: ['downloads'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (hasInput && !shownError && (files === null || chosen.size > 0)) add.mutate()
  }

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) {
      setFile(f)
      setLink('')
    }
  }

  const known = shownPreview?.known
  const shown = (path: string) => (shownPreview?.name && path.startsWith(shownPreview.name + '/') ? path.slice(shownPreview.name.length + 1) : path)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="min-w-0 space-y-5">
          <DialogHeader>
            <DialogTitle>Add a torrent</DialogTitle>
            <DialogDescription>It downloads to the end without a player, then seeds as Settings › Downloads says.</DialogDescription>
          </DialogHeader>

          {file ? (
            <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5">
              <FileUp className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setFile(null)}>
                Use a link instead
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="add-link">Magnet link, info hash or .torrent link</Label>
              <Input
                id="add-link"
                autoFocus
                value={link}
                placeholder="magnet:?xt=urn:btih:…"
                onChange={(e) => setLink(e.target.value)}
                className="font-mono text-xs"
              />
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(true)
                }}
                onDragLeave={() => setOver(false)}
                onDrop={drop}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground transition-colors',
                  over && 'border-primary bg-primary/5 text-foreground',
                )}
              >
                <FileUp className="size-4" />
                <span>
                  Or drop a .torrent file here, or{' '}
                  <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => input.current?.click()}>
                    choose one
                  </button>
                </span>
                <input
                  ref={input}
                  type="file"
                  className="sr-only"
                  accept=".torrent,application/x-bittorrent"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) setFile(f)
                    e.target.value = ''
                  }}
                />
              </div>
            </div>
          )}

          {checking && hasInput && !shownPreview && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Reading the torrent…
            </p>
          )}
          {shownError && <p className="text-sm text-destructive">{shownError}</p>}

          {shownPreview && (
            <div className="min-w-0 space-y-3">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <p className="min-w-0 truncate font-medium" title={shownPreview.name ?? shownPreview.infoHash}>
                  {shownPreview.name ?? 'Unnamed torrent'}
                </p>
                {files && (
                  <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                    {chosen.size} of {files.length} files · {bytes(size)}
                  </span>
                )}
              </div>
              {known && (
                <p className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
                  <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    The server already keeps this torrent ({known.state}). Adding it makes it a download that runs to the end
                    {files ? ', with the files chosen here.' : '.'}
                  </span>
                </p>
              )}
              {files === null ? (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <FolderTree className="mt-0.5 size-4 shrink-0" />
                  A magnet link's files arrive from the swarm with its metadata. Add it, then choose its files in its Files tab
                  {startNow ? ' (everything downloads until you do).' : ' before you start it.'}
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded-lg border">
                  <label className="sticky top-0 flex items-center gap-3 border-b bg-background px-3 py-2 text-sm font-medium">
                    <Checkbox
                      checked={all ? true : chosen.size ? 'indeterminate' : false}
                      onCheckedChange={(v) => setChosen(new Set(v ? files.map((f) => f.path) : []))}
                    />
                    <span className="flex-1">Every file</span>
                  </label>
                  <ul className="divide-y">
                    {files.map((f) => (
                      <li key={f.path}>
                        <label className="flex items-center gap-3 px-3 py-1.5 text-sm hover:bg-muted/50">
                          <Checkbox
                            checked={chosen.has(f.path)}
                            onCheckedChange={(v) => {
                              const next = new Set(chosen)
                              if (v) next.add(f.path)
                              else next.delete(f.path)
                              setChosen(next)
                            }}
                          />
                          <span className="min-w-0 flex-1 truncate" title={f.path}>
                            {shown(f.path)}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{bytes(f.size)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="add-label">Label</Label>
              <Input id="add-label" list="add-labels" value={label} maxLength={40} placeholder="None" onChange={(e) => setLabel(e.target.value)} />
              <datalist id="add-labels">
                {labels.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </div>
            <label className="flex items-center justify-between gap-3 self-end rounded-lg border px-3 py-2">
              <span className="text-sm">Start now</span>
              <Switch checked={startNow} onCheckedChange={setStartNow} />
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending || checking || !!shownError || !hasInput || (files !== null && chosen.size === 0)}>
              {add.isPending && <Spinner />} {startNow ? 'Add and start' : 'Add paused'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
