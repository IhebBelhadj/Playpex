import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { useEvent } from '@/lib/events'

// Direct downloads (docs/search-plan.md decision C): files the server fetches
// over HTTP, beside torrents. The list is patched by `direct.updated` (≤ 1 per
// second per running one) and `direct.removed`, both the admin's events.

export type DirectDownload = Schemas['DirectDownload']

export function useDirectDownloads() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['direct-downloads'], queryFn: () => unwrap(api.GET('/downloads/direct')), refetchInterval: 60_000 })
  useEvent<DirectDownload>('direct.updated', (e) => {
    client.setQueryData<DirectDownload[]>(['direct-downloads'], (list) => {
      if (!list) return list
      return list.some((d) => d.id === e.data.id) ? list.map((d) => (d.id === e.data.id ? { ...e.data, ref: e.data.ref ?? d.ref } : d)) : [e.data, ...list]
    })
  })
  useEvent<{ id: string }>('direct.removed', (e) => {
    client.setQueryData<DirectDownload[]>(['direct-downloads'], (list) => list?.filter((d) => d.id !== e.data.id))
  })
  return query
}

export function useDirectActions() {
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: ['direct-downloads'] })
  const fail = (err: unknown) => toast.error(errorMessage(err))
  const id = (value: string) => ({ params: { path: { id: value } } })
  return {
    /** A media ref (r_ a file, h_ a stream) as a new direct download */
    add: useMutation({
      mutationFn: (v: { ref: string; name?: string }) => unwrap(api.POST('/downloads/direct', { body: { ref: v.ref, name: v.name } })),
      onSuccess: (d) => {
        toast.success(`Downloading ${d.name}`, {
          description: d.kind === 'hls' ? 'A stream: the server saves it with ffmpeg, from the beginning.' : `To the download folder, from ${d.source.host}.`,
        })
        refresh()
      },
      onError: fail,
    }),
    start: useMutation({ mutationFn: (v: string) => unwrap(api.POST('/downloads/direct/{id}/start', id(v))), onSuccess: refresh, onError: fail }),
    pause: useMutation({ mutationFn: (v: string) => unwrap(api.POST('/downloads/direct/{id}/pause', id(v))), onSuccess: refresh, onError: fail }),
    remove: useMutation({
      mutationFn: (v: { id: string; files: boolean }) =>
        unwrap(api.DELETE('/downloads/direct/{id}', { params: { path: { id: v.id }, query: { files: v.files ? '1' : '0' } } })),
      onSuccess: (_, v) => {
        toast.success(v.files ? 'Removed, with its file' : 'Removed from the list')
        refresh()
      },
      onError: fail,
    }),
  }
}
