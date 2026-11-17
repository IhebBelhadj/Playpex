// Switch view (docs/web-unified-plan.md §5): Playpex TV on the web, from here. /app/ remembers the
// choice for this browser and translates the place (`at`) into Playpex TV's address; the profile
// follows through the tab's sessionStorage (profileMemory.web.ts, `playpex.web.profile`).

/** Playpex TV is served here (GET /clients: on and built) */
export async function tvViewAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${window.location.origin}/api/v1/clients`, { credentials: 'same-origin' })
    if (!res.ok) return false
    const body = (await res.json()) as { web?: { id: string; enabled: boolean; built: boolean }[] }
    return !!body.web?.some((c) => c.id === 'tv' && c.enabled && c.built)
  } catch {
    return false
  }
}

export function switchToTvView(at: string): void {
  window.location.assign(`/app/?view=tv&at=${encodeURIComponent(at)}`)
}
