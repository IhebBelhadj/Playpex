// Share to Playpex is Android's Share sheet: nothing shares into a page

/** Text shared to the app; `shortcut`: the direct share target it came through */
export type Shared = { text: string; shortcut: string | null }

export function takeShared(): Shared | null {
  return null
}

export function onShare(_listener: (shared: Shared) => void): () => void {
  return () => {}
}

export function setShareTargets(_targets: { id: string; label: string }[]): void {}
