// The state a controller exposes: a value, replaced (never mutated) on every
// change, and listeners told after each change. React reads it through
// useSyncExternalStore (state/useStore.ts); tests read `get()`.

export type Listener = () => void

export class Store<T> {
  private value: T
  private readonly listeners = new Set<Listener>()

  constructor(initial: T) {
    this.value = initial
  }

  /** The current value (stable between changes: safe as a useSyncExternalStore snapshot) */
  readonly get = (): T => this.value

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Replaces the value; an identical value (Object.is) tells nobody */
  set(next: T | ((previous: T) => T)): void {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(this.value) : next
    if (Object.is(value, this.value)) return
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }

  /** Merges fields into an object value */
  patch(this: Store<T & object>, fields: Partial<T>): void {
    this.set((previous) => ({ ...previous, ...fields }))
  }
}
