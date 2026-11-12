import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ChevronUp, Play, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, QueryError } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ApiError, api, errorMessage, unwrap, type Schemas } from '@/lib/api'

// A plugin's options (docs/plugins-plan.md §4.3, §6.3), rendered from what its
// manifest declares (`contributes.settings`): the plugin page's Settings
// (server scope) and Profiles (one profile at a time: shown or hidden, its
// personal permissions, its profile-scope settings). Groups, "Show advanced"
// for `level: advanced`, `visibleIf` / `enabledIf` against the values being
// edited, secrets entered but never shown, `action` buttons that call the
// plugin and show its toasts, `list` settings (plugin API 1.5) as entries the
// admin adds, reorders and removes (or chips for a list of plain values).
// Edits are a draft per tab, saved together (the server takes all or nothing
// and answers per field what it refused).

type PluginSettings = Schemas['PluginSettings']
type Definition = Schemas['PluginSettingDefinition']
type Values = Record<string, unknown>

export function usePluginSettings(plugin: string) {
  return useQuery({
    queryKey: ['admin-plugin-settings', plugin],
    queryFn: () => unwrap(api.GET('/admin/plugins/{pluginId}/settings', { params: { path: { pluginId: plugin } } })),
  })
}

/** The plugin page's Settings tab: its server-scope options */
export function PluginServerSettings({ plugin }: { plugin: string }) {
  const query = usePluginSettings(plugin)
  if (query.isPending) return <Loading />
  if (query.error) return <QueryError error={query.error} title="Could not load its settings" />
  const s = query.data
  const defs = s.definitions.filter((d) => d.scope === 'server')
  if (!defs.length) return <Empty title="Nothing to set">This plugin has no server settings.</Empty>
  return <ScopeForm key={`server:${s.plugin}`} settings={s} definitions={defs} values={s.server} />
}

/** The plugin page's Profiles tab: per profile, shown or hidden, its personal permissions and its profile settings */
export function PluginProfiles({ plugin }: { plugin: string }) {
  const query = usePluginSettings(plugin)
  if (query.isPending) return <Loading />
  if (query.error) return <QueryError error={query.error} title="Could not load its profiles" />
  const s = query.data
  return <ProfilesTab settings={s} definitions={s.definitions.filter((d) => d.scope === 'profile' && d.type !== 'action')} />
}

function ProfilesTab({ settings, definitions }: { settings: PluginSettings; definitions: Definition[] }) {
  const [chosen, setChosen] = useState<string | null>(settings.profiles[0]?.id ?? null)
  const profile = settings.profiles.find((p) => p.id === chosen) ?? settings.profiles[0]
  if (!profile) {
    return <Empty title="No profiles">Profiles made on this server get their own values here.</Empty>
  }
  return (
    <div className="space-y-6 pt-2">
      <div className="space-y-1.5">
        <Label>Profile</Label>
        <Select value={profile.id} onValueChange={setChosen}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {settings.profiles.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
                {p.kids ? ' (kids)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Shown settings={settings} profile={profile} />
      {profile.shown && settings.personal.length > 0 && <Grants settings={settings} profile={profile} />}
      {profile.shown && definitions.length > 0 && (
        <ScopeForm
          key={`profile:${profile.id}`}
          settings={settings}
          definitions={definitions}
          values={profile.values}
          profile={profile.id}
          // a profile setting may depend on a server one
          context={settings.server}
        />
      )}
    </div>
  )
}

// Shown to this profile, or hidden from it: then nothing of the plugin reaches it
function Shown({ settings, profile }: { settings: PluginSettings; profile: PluginSettings['profiles'][number] }) {
  const client = useQueryClient()
  const show = useMutation({
    mutationFn: (shown: boolean) =>
      unwrap(
        api.PUT('/admin/plugins/{pluginId}/profiles', {
          params: { path: { pluginId: settings.plugin } },
          body: { profile: profile.id, shown },
        }),
      ),
    onSuccess: (r, shown) => {
      client.setQueryData(['admin-plugin-settings', settings.plugin], r)
      toast.success(shown ? `Shown to ${profile.name}` : `Hidden from ${profile.name}`)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor="plugin-shown">Use it for {profile.name}</Label>
        <p className="text-xs text-muted-foreground">
          Off: {profile.name} sees nothing of this plugin (no menu entry, screens or rows), and it gets nothing of {profile.name}&apos;s:
          no sources in Play, events or notifications.
        </p>
      </div>
      <Switch id="plugin-shown" checked={profile.shown} disabled={show.isPending} onCheckedChange={(on) => show.mutate(on)} />
    </div>
  )
}

// Personal permissions (decision G): off for every profile until switched on here
function Grants({ settings, profile }: { settings: PluginSettings; profile: PluginSettings['profiles'][number] }) {
  const client = useQueryClient()
  const grant = useMutation({
    mutationFn: (v: { permission: string; granted: boolean }) =>
      unwrap(
        api.PUT('/admin/plugins/{pluginId}/grants', {
          params: { path: { pluginId: settings.plugin } },
          body: { profile: profile.id, permission: v.permission, granted: v.granted },
        }),
      ),
    onSuccess: (r) => client.setQueryData(['admin-plugin-settings', settings.plugin], r),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const granted = profile.grants ?? []
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-medium text-muted-foreground">What it may do for {profile.name}</legend>
      <p className="text-xs text-muted-foreground">
        Off until you switch them on, for each profile: the person watching isn&apos;t asked on their screen.
      </p>
      {settings.personal.map((perm) => (
        <div key={perm.key} className="flex items-center justify-between gap-4">
          <Label htmlFor={`grant-${perm.key}`}>{perm.text}</Label>
          <Switch
            id={`grant-${perm.key}`}
            checked={granted.includes(perm.key)}
            disabled={grant.isPending}
            onCheckedChange={(on) => grant.mutate({ permission: perm.key, granted: on })}
          />
        </div>
      ))}
    </fieldset>
  )
}

function ScopeForm({
  settings,
  definitions,
  values,
  profile,
  context = {},
}: {
  settings: PluginSettings
  definitions: Definition[]
  values: Values
  profile?: string
  context?: Values
}) {
  const client = useQueryClient()
  const [draft, setDraft] = useState<Values>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [advanced, setAdvanced] = useState(false)

  const current = (d: Definition): unknown => (d.key in draft ? (draft[d.key] ?? d.default ?? null) : values[d.key])
  const all: Values = useMemo(() => {
    const out: Values = { ...context, ...values }
    for (const [k, v] of Object.entries(draft)) out[k] = v
    return out
  }, [context, values, draft])
  const meets = (c?: { key?: string; equals?: unknown }) => !c?.key || all[c.key] === c.equals

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/admin/plugins/{pluginId}/settings', {
          params: { path: { pluginId: settings.plugin } },
          body: { ...(profile ? { profile } : {}), values: draft },
        }),
      ),
    onSuccess: (r) => {
      client.setQueryData(['admin-plugin-settings', settings.plugin], r)
      setDraft({})
      setErrors({})
      toast.success('Settings saved')
    },
    onError: (err) => {
      setErrors(err instanceof ApiError ? err.fields : {})
      toast.error(errorMessage(err))
    },
  })

  const set = (key: string, value: unknown) => setDraft((d) => ({ ...d, [key]: value }))
  const shown = definitions.filter((d) => meets(d.visibleIf) && (advanced || d.level !== 'advanced'))
  const hasAdvanced = definitions.some((d) => d.level === 'advanced')
  const groups = [...new Set(shown.map((d) => d.group ?? ''))]
  const dirty = Object.keys(draft).length > 0

  return (
    <form
      className="space-y-6 pt-2"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      {groups.map((group) => (
        <fieldset key={group || '-'} className="space-y-4">
          {group && <legend className="mb-2 text-sm font-medium text-muted-foreground">{group}</legend>}
          {shown
            .filter((d) => (d.group ?? '') === group)
            .map((d) => (
              <Field
                key={d.key}
                definition={d}
                value={current(d)}
                secretSet={!!settings.secrets[d.key]}
                changed={d.key in draft}
                disabled={!meets(d.enabledIf) || settings.state !== 'enabled' && d.type === 'action'}
                error={errors[d.key]}
                plugin={settings.plugin}
                onChange={(v) => set(d.key, v)}
              />
            ))}
        </fieldset>
      ))}
      {hasAdvanced && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={advanced} onCheckedChange={setAdvanced} /> Show advanced settings
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={!dirty || save.isPending} onClick={() => setDraft({})}>
          Discard changes
        </Button>
        <Button type="submit" disabled={!dirty || save.isPending}>
          Save
        </Button>
      </div>
    </form>
  )
}

function Field({
  definition: d,
  value,
  secretSet,
  changed,
  disabled,
  error,
  plugin,
  onChange,
}: {
  definition: Definition
  value: unknown
  secretSet: boolean
  changed: boolean
  disabled: boolean
  error?: string
  plugin: string
  onChange: (value: unknown) => void
}) {
  const id = `setting-${d.key}`
  const isDefault = d.type !== 'secret' && d.type !== 'action' && d.default !== undefined && value === d.default
  const reset =
    d.type !== 'secret' && d.type !== 'action' && !isDefault && d.default !== undefined ? (
      <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => onChange(null)}>
        <RotateCcw className="mr-1 inline size-3" />
        Default
      </button>
    ) : null
  const note = (
    <>
      {d.description && <p className="text-xs text-muted-foreground">{d.description}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  )

  if (d.type === 'switch') {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor={id}>
            {d.label} {changed && <span className="text-xs text-warning">(changed)</span>}
          </Label>
          {note}
        </div>
        <Switch id={id} checked={value === true} disabled={disabled} onCheckedChange={onChange} />
      </div>
    )
  }

  if (d.type === 'action') {
    return <ActionField definition={d} plugin={plugin} disabled={disabled} />
  }

  if (d.type === 'list') {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>
            {d.label} {changed && <span className="text-xs text-warning">(changed)</span>}
          </Label>
          {Array.isArray(value) && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {value.length} / {d.maxItems}
            </span>
          )}
        </div>
        {d.fields ? (
          <EntryList definition={d} value={Array.isArray(value) ? (value as Values[]) : []} disabled={disabled} plugin={plugin} onChange={onChange} />
        ) : (
          <ValueList definition={d} value={Array.isArray(value) ? value : []} disabled={disabled} onChange={onChange} />
        )}
        {note}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>
          {d.label} {changed && <span className="text-xs text-warning">(changed)</span>}
        </Label>
        {reset}
      </div>
      {d.type === 'choice' ? (
        <Select value={String(value ?? '')} disabled={disabled} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(d.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : d.type === 'slider' ? (
        <div className="flex items-center gap-3">
          <input
            id={id}
            type="range"
            className="w-full accent-primary"
            min={d.min}
            max={d.max}
            step={d.step ?? 1}
            value={Number(value ?? d.min ?? 0)}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <span className="w-16 text-right text-sm tabular-nums">
            {String(value ?? '')}
            {d.unit ? ` ${d.unit}` : ''}
          </span>
        </div>
      ) : d.type === 'number' ? (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            className="max-w-40"
            min={d.min}
            max={d.max}
            step={d.step ?? (d.integer ? 1 : 'any')}
            value={value === null || value === undefined ? '' : String(value)}
            disabled={disabled}
            aria-invalid={!!error}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
          {d.unit && <span className="text-sm text-muted-foreground">{d.unit}</span>}
        </div>
      ) : d.type === 'secret' ? (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="off"
            maxLength={d.maxLength}
            placeholder={secretSet ? 'Set: type to replace it' : d.placeholder || 'Not set'}
            value={typeof value === 'string' && changed ? value : ''}
            disabled={disabled}
            aria-invalid={!!error}
            onChange={(e) => onChange(e.target.value)}
          />
          {secretSet && (
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange('')}>
              Remove
            </Button>
          )}
        </div>
      ) : d.type === 'url' ? (
        <>
          <Input
            id={id}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            maxLength={d.maxLength ?? 2048}
            placeholder={d.placeholder}
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            aria-invalid={!!error}
            onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          />
          {d.grantsHost && (
            <p className="text-xs text-muted-foreground">
              Saving it lets the plugin reach this address's host
              {d.streamHosts ? ', and play the streams the document there lists' : ''} (public addresses only).
            </p>
          )}
        </>
      ) : (
        <Input
          id={id}
          maxLength={d.maxLength}
          placeholder={d.placeholder}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {note}
    </div>
  )
}

/** A field's value in a new entry, or when reset */
function fieldDefault(f: Definition): unknown {
  if (f.default !== undefined) return f.default
  return f.type === 'text' || f.type === 'url' ? '' : f.type === 'switch' ? false : null
}

/** A list of entries: each a card of its fields, reordered with ↑ / ↓, removed with an Undo */
function EntryList({
  definition: d,
  value,
  disabled,
  plugin,
  onChange,
}: {
  definition: Definition
  value: Values[]
  disabled: boolean
  plugin: string
  onChange: (value: unknown) => void
}) {
  const fields = d.fields ?? []
  // collapsed entries, by id (new ones, without an id yet, by their place)
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const keyOf = (entry: Values, i: number) => (typeof entry.id === 'string' ? entry.id : `new-${i}`)
  const titleOf = (entry: Values, i: number) => {
    const named = d.titleField ? entry[d.titleField] : null
    return typeof named === 'string' && named.trim() ? named : `${d.itemLabel ?? 'Entry'} ${i + 1}`
  }
  const summaryOf = (entry: Values) =>
    fields
      .filter((f) => f.type === 'url' && typeof entry[f.key] === 'string' && entry[f.key])
      .map((f) => {
        try {
          return new URL(String(entry[f.key])).host
        } catch {
          return String(entry[f.key])
        }
      })
      .join(' · ')
  const update = (i: number, key: string, v: unknown) =>
    onChange(value.map((e, j) => (j === i ? { ...e, [key]: v === null ? fieldDefault(fields.find((f) => f.key === key)!) : v } : e)))
  const move = (i: number, by: number) => {
    const next = value.slice()
    const [entry] = next.splice(i, 1)
    next.splice(i + by, 0, entry)
    onChange(next)
  }
  const remove = (i: number) => {
    const before = value
    onChange(value.filter((_, j) => j !== i))
    toast(`${titleOf(value[i], i)} removed`, { description: 'Save to keep it removed.', action: { label: 'Undo', onClick: () => onChange(before) } })
  }
  const add = () => {
    const entry: Values = {}
    for (const f of fields) entry[f.key] = fieldDefault(f)
    onChange([...value, entry])
  }

  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
      {value.map((entry, i) => {
        const key = keyOf(entry, i)
        const open = !closed[key]
        const meets = (c?: { key?: string; equals?: unknown }) => !c?.key || entry[c.key] === c.equals
        return (
          <div key={key} className="rounded-2xl bg-muted p-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
                aria-expanded={open}
                onClick={() => setClosed((c) => ({ ...c, [key]: open }))}
              >
                {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                <span className="truncate">{titleOf(entry, i)}</span>
                {!open && <span className="truncate font-mono text-xs font-normal text-muted-foreground">{summaryOf(entry)}</span>}
              </button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Move up" disabled={disabled || i === 0} onClick={() => move(i, -1)}>
                <ChevronUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Move down"
                disabled={disabled || i === value.length - 1}
                onClick={() => move(i, 1)}
              >
                <ChevronDown />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${titleOf(entry, i)}`} disabled={disabled} onClick={() => remove(i)}>
                <Trash2 />
              </Button>
            </div>
            {open && (
              <div className="mt-3 space-y-4 px-1">
                {fields
                  .filter((f) => meets(f.visibleIf))
                  .map((f) => (
                    <Field
                      key={f.key}
                      definition={{ ...f, key: `${d.key}-${key}-${f.key}` }}
                      value={entry[f.key]}
                      secretSet={false}
                      changed={false}
                      disabled={disabled || !meets(f.enabledIf)}
                      plugin={plugin}
                      onChange={(v) => update(i, f.key, v)}
                    />
                  ))}
              </div>
            )}
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" disabled={disabled || value.length >= (d.maxItems ?? Infinity)} onClick={add}>
        <Plus /> Add {(d.itemLabel ?? 'entry').toLowerCase()}
      </Button>
    </div>
  )
}

/** A list of plain values: chips, a field to add one (Enter) */
function ValueList({
  definition: d,
  value,
  disabled,
  onChange,
}: {
  definition: Definition
  value: unknown[]
  disabled: boolean
  onChange: (value: unknown) => void
}) {
  const item = d.item
  const [text, setText] = useState('')
  const full = value.length >= (d.maxItems ?? Infinity)
  const add = (raw: unknown) => {
    if (raw === '' || raw === null || raw === undefined || full) return
    if (d.unique && value.some((v) => String(v).toLowerCase() === String(raw).toLowerCase())) return setText('')
    onChange([...value, raw])
    setText('')
  }
  const label = (v: unknown) => item?.options?.find((o) => o.value === v)?.label ?? String(v)
  const long = value.some((v) => String(v).length > 30)

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className={long ? 'space-y-1' : 'flex flex-wrap gap-1.5'}>
          {value.map((v, i) => (
            <span
              key={`${String(v)}-${i}`}
              className={
                long
                  ? 'flex items-center justify-between gap-2 rounded-full bg-muted py-1 pr-1 pl-3 text-sm'
                  : 'inline-flex items-center gap-1 rounded-full bg-muted py-1 pr-1 pl-3 text-sm'
              }
            >
              <span className={item?.type === 'url' ? 'truncate font-mono text-xs' : 'truncate'}>{label(v)}</span>
              <button
                type="button"
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${label(v)}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {item?.type === 'choice' ? (
        <Select value="" disabled={disabled || full} onValueChange={(v) => add(v)}>
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue placeholder={`Add ${(d.itemLabel ?? 'a value').toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {(item.options ?? [])
              .filter((o) => !value.includes(o.value))
              .map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="flex gap-2">
          <Input
            type={item?.type === 'number' ? 'number' : item?.type === 'url' ? 'url' : 'text'}
            className={item?.type === 'url' ? 'font-mono' : undefined}
            maxLength={item?.maxLength}
            placeholder={item?.placeholder ?? `Add ${(d.itemLabel ?? 'a value').toLowerCase()}, then Enter`}
            value={text}
            disabled={disabled || full}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add(item?.type === 'number' ? (text === '' ? null : Number(text)) : text.trim())
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={disabled || full || !text.trim()}
            onClick={() => add(item?.type === 'number' ? Number(text) : text.trim())}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  )
}

function ActionField({ definition: d, plugin, disabled }: { definition: Definition; plugin: string; disabled: boolean }) {
  const run = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/admin/plugins/{pluginId}/settings/{key}/run', { params: { path: { pluginId: plugin, key: d.key } } })),
    onSuccess: (r) => {
      const toasts = r.effects.filter((e) => e.type === 'toast') as unknown as { text: string; tone?: string }[]
      if (!toasts.length) toast.success(`${d.label}: done`)
      for (const t of toasts) (t.tone === 'error' ? toast.error : t.tone === 'success' ? toast.success : toast.info)(t.text)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const button = (
    <Button type="button" variant="outline" size="sm" disabled={disabled || run.isPending} onClick={d.confirm ? undefined : () => run.mutate()}>
      <Play /> {d.label}
    </Button>
  )
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        {d.description && <p className="text-sm text-muted-foreground">{d.description}</p>}
        {disabled && <p className="text-xs text-muted-foreground">Turn the plugin on to use it.</p>}
      </div>
      {d.confirm ? (
        <Confirm trigger={button} title={d.label} description={d.confirm} action="Go" destructive={false} onConfirm={() => run.mutate()} />
      ) : (
        button
      )}
    </div>
  )
}
