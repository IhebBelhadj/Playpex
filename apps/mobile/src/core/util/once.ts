/** `fn`, run at most once (cleanups reached from two paths: done, and disposed) */
export function once(fn: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}
