import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { Disposer } from '../disposer'
import { Emitter } from '../emitter'
import { Store } from '../store'

describe('Store', () => {
  it('tells its listeners after a change, never for the same value', () => {
    const store = new Store({ n: 1 })
    const heard: number[] = []
    const stop = store.subscribe(() => heard.push(store.get().n))
    store.patch({ n: 2 })
    store.set(store.get())
    store.set((s) => ({ n: s.n + 1 }))
    stop()
    store.patch({ n: 9 })
    expect(heard).toEqual([2, 3])
  })

  it('keeps the same snapshot between changes', () => {
    const store = new Store({ a: [1] })
    expect(store.get()).toBe(store.get())
  })
})

describe('Disposer', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('clears its timers and runs its cleanups once, last first', () => {
    const d = new Disposer()
    const order: string[] = []
    const tick = jest.fn()
    d.interval(1000, tick)
    d.timeout(5000, () => order.push('late timeout'))
    d.add(() => order.push('first'))
    d.add(() => order.push('second'))
    jest.advanceTimersByTime(2500)
    d.dispose()
    d.dispose()
    jest.advanceTimersByTime(10_000)
    expect(tick).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['second', 'first'])
    expect(d.disposed).toBe(true)
  })

  it('cleans up at once what is added after dispose', () => {
    const d = new Disposer()
    d.dispose()
    const cleanup = jest.fn()
    d.add(cleanup)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('a failing cleanup does not stop the others', () => {
    const d = new Disposer()
    const after = jest.fn()
    d.add(after)
    d.add(() => {
      throw new Error('boom')
    })
    d.dispose()
    expect(after).toHaveBeenCalled()
  })
})

describe('Emitter', () => {
  it('delivers to handlers until they unsubscribe', () => {
    const e = new Emitter<{ end: number }>()
    const got: number[] = []
    const off = e.on('end', (n) => got.push(n))
    e.emit('end', 1)
    off()
    e.emit('end', 2)
    expect(got).toEqual([1])
  })
})
