import { Keyboard, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { RemoteField, RemoteInput } from '@/lib/remote'

// The device's open text field (its on-screen keyboard: a search, a name, an address) on this page
// (docs/remote-control-plan.md, "Text fields"): the text box gets the focus and this phone's own
// keyboard comes up, every change sends the whole text (autocorrect, swipe typing and deletions land
// as they are), Enter is the device keyboard's Done, Cancel its Back.

interface NativeKeyboard {
  show(): Promise<unknown>
}

/** Playpex Server Manager's native keyboard (its WebView won't open the keyboard for a page's focus() alone) */
function nativeKeyboard(): NativeKeyboard | null {
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  return (cap?.Plugins?.PlaypexKeyboard as NativeKeyboard | undefined) ?? null
}

/** Focus the box and bring up the phone's keyboard (a browser opens it only on a tap: the box says so) */
function bringUp(input: HTMLInputElement) {
  input.focus({ preventScroll: true })
  const end = input.value.length
  try {
    input.setSelectionRange(end, end)
  } catch {
    // type=search / url may refuse a selection: the caret stays where the browser put it
  }
  nativeKeyboard()?.show().catch(() => undefined)
}

const KIND = {
  search: { type: 'search', enterKeyHint: 'search', autoCapitalize: 'none', autoCorrect: 'on' },
  address: { type: 'url', enterKeyHint: 'go', autoCapitalize: 'none', autoCorrect: 'off' },
  text: { type: 'text', enterKeyHint: 'done', autoCapitalize: 'words', autoCorrect: 'on' },
} as const

export function RemoteFieldBar({ field, send, name }: { field: RemoteField; send: (msg: RemoteInput) => void; name: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(field.value)
  // what this page sent last: the device's copy of it (or of an older text) never overwrites newer typing
  const [sent, setSent] = useState(field.value)
  const kind = KIND[field.kind ?? 'text']

  // shown (one bar per field: the parent keys it by the field's id): the focus and the keyboard, not
  // while the mouse is captured for the TV (the keys go there as they are)
  useEffect(() => {
    const el = input.current
    if (el && !document.pointerLockElement) bringUp(el)
  }, [])

  // typed on the device itself (its remote): this box follows; an echo of what this page sent doesn't
  const [seen, setSeen] = useState(field.value)
  if (field.value !== seen) {
    setSeen(field.value)
    if (field.value !== sent) {
      setSent(field.value)
      setValue(field.value)
    }
  }

  const change = (text: string) => {
    const next = field.maxLength ? text.slice(0, field.maxLength) : text
    setValue(next)
    setSent(next)
    send({ type: 'field', id: field.id, value: next })
  }

  const submit = () => {
    send({ type: 'field', id: field.id, value, submit: true })
    input.current?.blur()
  }

  const cancel = () => {
    send({ type: 'key', phase: 'down', key: 'Escape', code: 'Escape' })
    send({ type: 'key', phase: 'up', key: 'Escape', code: 'Escape' })
  }

  return (
    <form
      className="flex shrink-0 flex-col gap-2 rounded-2xl bg-muted p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Keyboard className="size-4 shrink-0 text-gold" />
        <span className="min-w-0 flex-1 truncate">
          {field.title ? `${field.title} on ${name}` : `Typing on ${name}`}
          <span className="max-md:hidden"> · Enter to finish</span>
        </span>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Cancel" title="Cancel (Back on the device)" onClick={cancel}>
          <X />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          ref={input}
          value={value}
          onChange={(e) => change(e.target.value)}
          type={kind.type}
          enterKeyHint={kind.enterKeyHint}
          autoCapitalize={kind.autoCapitalize}
          autoCorrect={kind.autoCorrect}
          autoComplete="off"
          spellCheck={field.kind !== 'address'}
          maxLength={field.maxLength}
          placeholder={field.placeholder || 'Type here'}
          aria-label={field.title || `Text on ${name}`}
          className="h-11 min-w-0 flex-1 rounded-full px-4 text-base"
          // a tap brings the keyboard back after the phone hid it
          onClick={(e) => nativeKeyboard() && bringUp(e.currentTarget)}
        />
        <Button type="submit" className="h-11 rounded-full px-5">
          {field.kind === 'search' ? 'Search' : 'Done'}
        </Button>
      </div>
    </form>
  )
}
