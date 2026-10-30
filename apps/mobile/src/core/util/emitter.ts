// Typed events between core objects (a player's end, a server event): what
// happened once, as opposed to a Store's current state.

export class Emitter<Events extends Record<string, unknown>> {
  private readonly handlers: { [K in keyof Events]?: Set<(payload: Events[K]) => void> } = {}

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    const set = (this.handlers[event] ??= new Set())
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const handler of [...(this.handlers[event] ?? [])]) handler(payload)
  }

  clear(): void {
    for (const key of Object.keys(this.handlers) as (keyof Events)[]) delete this.handlers[key]
  }
}
