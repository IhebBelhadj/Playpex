import { api, unwrap } from './api'

// "Restart server" (POST /admin/restart): the server answers, then restarts
// ~200 ms later. Waits until it answers again on this origin, or tells where it
// went (another port).

export interface RestartResult {
  /** The dashboard's address after the restart, when it changed. */
  movedTo: string | null
}

async function answers(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/v1/server`, { cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function restartServer(): Promise<RestartResult> {
  const { port, currentPort } = await unwrap(api.POST('/admin/restart'))
  const here = location.origin
  // In development (vite proxy) the page's port is vite's, not the server's
  const devProxy = import.meta.env.DEV
  const moved = !devProxy && currentPort !== null && port !== currentPort
  const target = moved ? `${location.protocol}//${location.hostname}:${port}` : here
  await sleep(1000)
  for (let i = 0; i < 30; i++) {
    // Another origin can't be read (CORS): a fetch in no-cors mode still tells it's up
    const up = moved
      ? await fetch(`${target}/api/v1/server`, { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false)
      : await answers(target)
    if (up) return { movedTo: moved ? target : null }
    await sleep(1000)
  }
  throw new Error(
    moved
      ? `The server did not come back on port ${port}. It may be in recovery mode (the port is in use): check its log.`
      : 'The server did not come back within 30 s; check its log.',
  )
}
