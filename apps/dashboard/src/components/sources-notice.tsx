import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Puzzle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Spinner } from '@/components/common'
import { AddRepositoryDialog } from '@/components/plugin-repositories'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { api, errorMessage, unwrap } from '@/lib/api'

/**
 * The Overview's notice while no source plugin is installed (docs/providers-plan.md §4.4): the server
 * reads no torrent site of its own, so Play finds only files on this server until the admin adds a
 * source. Shown until a source plugin is installed or the admin dismisses it (`plugins.sourcesNotice`).
 */
export function SourcesNotice() {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const dismiss = useMutation({
    mutationFn: () => unwrap(api.PUT('/admin/settings', { body: { plugins: { sourcesNotice: false } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['overview'] }),
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <Alert>
      <Puzzle />
      <AlertTitle>Torrents now come from plugins</AlertTitle>
      <AlertDescription>
        <p>
          Playpex Media Server doesn&apos;t read any torrent site by itself. Until you add a source, Play only finds files on this server and its
          downloads. Add the repository of the source plugins you want (its publisher gives the address of its index), then install them from
          Browse. Your downloads, library and watch history stay as they are.
        </p>
        <p className="mt-1 text-xs">Educational project: streaming copyrighted content via torrents may be illegal where you live.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAdding(true)}>
            Add a repository
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/plugins?tab=browse">Browse plugins</Link>
          </Button>
          <Button size="sm" variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
            {dismiss.isPending && <Spinner />} Don&apos;t show again
          </Button>
        </div>
      </AlertDescription>
      <AddRepositoryDialog open={adding} onOpenChange={setAdding} />
    </Alert>
  )
}
