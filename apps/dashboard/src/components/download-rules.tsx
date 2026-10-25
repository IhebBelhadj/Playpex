import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, unwrap } from '@/lib/api'
import type { Download, Rules } from '@/lib/downloads'

// Its own seeding goal and speed limits (several at once: the same values for all)
export function RulesDialog({
  downloads,
  canLimit,
  engine,
  onClose,
  onSave,
}: {
  downloads: Download[]
  canLimit: boolean
  engine: string | null
  onClose: () => void
  onSave: (body: Rules) => void
}) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => unwrap(api.GET('/admin/settings')) })
  const server = settings.data?.settings.downloads
  const first = downloads[0]
  const same = <K extends keyof Download>(k: K) => (first && downloads.every((d) => d[k] === first[k]) ? first[k] : null)
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  const [ratio, setRatio] = useState('')
  const [minutes, setMinutes] = useState('')
  const [down, setDown] = useState('')
  const [up, setUp] = useState('')
  const opened = useRef(false)
  useEffect(() => {
    if (downloads.length && !opened.current) {
      setRatio(text(same('seedRatio')))
      setMinutes(text(same('seedMinutes')))
      setDown(text(same('downLimitKBps')))
      setUp(text(same('upLimitKBps')))
    }
    opened.current = downloads.length > 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloads.length])
  const number = (s: string, decimals: boolean) => {
    if (s.trim() === '') return null
    const n = Number(s)
    return Number.isFinite(n) && n >= 0 ? (decimals ? Math.round(n * 100) / 100 : Math.floor(n)) : null
  }
  const serverGoal = server
    ? server.seedRatio || server.seedMinutes
      ? [server.seedRatio ? `ratio ${server.seedRatio}` : null, server.seedMinutes ? `${server.seedMinutes} min` : null].filter(Boolean).join(' or ')
      : 'no seeding'
    : '…'
  return (
    <Dialog open={downloads.length > 0} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            const body: Rules = { seedRatio: number(ratio, true), seedMinutes: number(minutes, false) }
            if (canLimit) {
              body.downLimitKBps = number(down, false)
              body.upLimitKBps = number(up, false)
            }
            onSave(body)
          }}
        >
          <DialogHeader>
            <DialogTitle>{downloads.length === 1 ? 'Seeding goal and speed limits' : `Seeding goal and speed limits of ${downloads.length} downloads`}</DialogTitle>
            <DialogDescription className="break-all">{downloads.length === 1 ? (first?.name ?? first?.infoHash) : 'The same values for each of them.'}</DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Seed until</legend>
            <p className="text-xs text-muted-foreground">Whichever comes first. Empty uses the server’s goal ({serverGoal}); 0 stops once it’s downloaded.</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-ratio">Ratio</Label>
                <Input id="rule-ratio" inputMode="decimal" placeholder={server?.seedRatio ? String(server.seedRatio) : 'Server’s'} value={ratio} onChange={(e) => setRatio(e.target.value.replace(/[^\d.]/g, ''))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-minutes">Minutes</Label>
                <Input id="rule-minutes" inputMode="numeric" placeholder={server?.seedMinutes ? String(server.seedMinutes) : 'Server’s'} value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />
              </div>
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Speed limits, KB/s</legend>
            {canLimit ? (
              <p className="text-xs text-muted-foreground">This download only, under the limits of every torrent together. Empty means no limit.</p>
            ) : (
              <p className="rounded-md bg-muted px-2.5 py-2 text-xs">
                The {engine ?? 'running'} engine can't limit one torrent's speed. Choose torrentd in Settings › Downloads to use these.
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-down">Download</Label>
                <Input id="rule-down" inputMode="numeric" placeholder="No limit" disabled={!canLimit} value={down} onChange={(e) => setDown(e.target.value.replace(/\D/g, ''))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-up">Upload</Label>
                <Input id="rule-up" inputMode="numeric" placeholder="No limit" disabled={!canLimit} value={up} onChange={(e) => setUp(e.target.value.replace(/\D/g, ''))} />
              </div>
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
