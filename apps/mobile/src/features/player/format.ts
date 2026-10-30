// Numbers as the player shows them (the TV's formatBytes)

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${Math.round(bytes)} B`
}

/** "Ends at 22:41": when the video ends at this speed */
export function endsAt(remaining: number, speed: number, now = Date.now()): string {
  const end = new Date(now + (remaining * 1000) / (speed || 1))
  return end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
