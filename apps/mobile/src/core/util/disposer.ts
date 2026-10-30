// What a controller owns and must give back: timers, subscriptions, sockets.
// Everything registered here ends in dispose(), once, whatever happened before;
// nothing can be added after (it is cleaned up at once instead).

export type Cleanup = () => void

export class Disposer {
  private cleanups: Cleanup[] = []
  private done = false

  get disposed(): boolean {
    return this.done
  }

  /** Registers a cleanup; after dispose() it runs at once */
  add(cleanup: Cleanup): Cleanup {
    if (this.done) {
      cleanup()
      return () => {}
    }
    this.cleanups.push(cleanup)
    return () => {
      this.cleanups = this.cleanups.filter((c) => c !== cleanup)
      cleanup()
    }
  }

  /** setTimeout that dispose() clears; the returned function cancels it early */
  timeout(ms: number, run: () => void): Cleanup {
    const timer = setTimeout(() => {
      this.cleanups = this.cleanups.filter((c) => c !== clear)
      run()
    }, ms)
    const clear = () => clearTimeout(timer)
    return this.add(clear)
  }

  /** setInterval that dispose() clears */
  interval(ms: number, run: () => void): Cleanup {
    const timer = setInterval(run, ms)
    return this.add(() => clearInterval(timer))
  }

  /** A promise that resolves after `ms`, or never once disposed (the caller checks `disposed`) */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timeout(ms, resolve)
    })
  }

  dispose(): void {
    if (this.done) return
    this.done = true
    const cleanups = this.cleanups.reverse()
    this.cleanups = []
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // one failing cleanup never keeps the others from running
      }
    }
  }
}
