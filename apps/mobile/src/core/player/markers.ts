import type { ApiClient } from '../http/client'
import { markers as fetchMarkers, type Marker, type PlayTitle } from '../services/playback'
import { Store } from '../util/store'

// Plugins' markers in the file playing (POST /play/markers): "Skip intro" /
// "Skip recap" while inside one, and where the credits start (Up next shows
// from there). Asked once per file, when its length is known.

/** Up next shows in the last 40 s, or from the credits marker (at most 10 min before the end) */
export const UP_NEXT_S = 40

export type MarkersState = { markers: Marker[]; dismissed: Marker[] }

export class Markers {
  readonly state = new Store<MarkersState>({ markers: [], dismissed: [] })
  private askedFor: string | null = null

  constructor(
    private readonly client: ApiClient,
    private readonly title: PlayTitle,
    private readonly enabled: boolean,
  ) {}

  /** The file `ref` is open and `duration` long: its markers, once */
  load(ref: string, duration: number, file: { name?: string | null; size?: number | null }): void {
    if (!this.enabled || !this.title.tmdbId || !(duration > 0) || this.askedFor === ref) return
    this.askedFor = ref
    this.state.set({ markers: [], dismissed: [] })
    void fetchMarkers(this.client, this.title, Math.round(duration), { name: file.name?.split('/').pop(), size: file.size }).then((markers) => {
      if (this.askedFor === ref) this.state.patch({ markers })
    })
  }

  /** The intro / recap playing at `position`, unless dismissed */
  skippable(position: number): Marker | null {
    const { markers, dismissed } = this.state.get()
    return markers.find((m) => (m.kind === 'intro' || m.kind === 'recap') && m.end != null && position >= m.start && position < m.end - 1 && !dismissed.includes(m)) ?? null
  }

  dismiss(marker: Marker): void {
    this.state.patch({ dismissed: [...this.state.get().dismissed, marker] })
  }

  /** Seconds before the end Up next shows */
  upNextWindow(duration: number): number {
    const credits = this.state.get().markers.find((m) => m.kind === 'credits')
    return credits && duration > credits.start ? Math.min(600, Math.max(UP_NEXT_S / 4, duration - credits.start)) : UP_NEXT_S
  }
}

export function skipLabel(marker: Marker): string {
  return marker.label || (marker.kind === 'intro' ? 'Skip intro' : 'Skip recap')
}
