import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Columns3, MoreHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// The dashboard's dense list (docs/dashboard-plan.md §4.1, step 1): TanStack
// Table with sorting, a column menu (show, hide, reorder; kept in
// localStorage, a per-viewer convenience), selection like a file manager's
// (click, Ctrl/Cmd-click, Shift-click ranges, checkboxes), a row menu (the ⋯
// button and right click: the same actions) and the keyboard: ↑ / ↓ move,
// Shift extends, Enter opens, Space, Delete and P call `onKey`, Ctrl/Cmd+A
// selects all, Escape clears.

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    /** in the column menu */
    label?: string
    /** numbers: right-aligned */
    numeric?: boolean
    className?: string
    /** hidden until the list is this wide (container widths: 2xl 42rem, 3xl 48rem, 4xl 56rem, 5xl 64rem, 6xl 72rem) */
    from?: '2xl' | '3xl' | '4xl' | '5xl' | '6xl'
    /** can't be hidden or moved */
    fixed?: boolean
  }
}

export type RowAction = {
  label: string
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  destructive?: boolean
  onSelect: () => void
} | 'separator'

// the list's own width decides, not the window's (a rail and a sidebar take some)
const FROM = {
  '2xl': 'hidden @2xl:table-cell',
  '3xl': 'hidden @3xl:table-cell',
  '4xl': 'hidden @4xl:table-cell',
  '5xl': 'hidden @5xl:table-cell',
  '6xl': 'hidden @6xl:table-cell',
}

type Saved = { hidden?: string[]; order?: string[]; sorting?: SortingState }

function load(key: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Saved
  } catch {
    return {}
  }
}

function save(key: string, value: Saved) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // private window, storage off: the defaults again next time
  }
}

export function DataTable<T>({
  data,
  columns,
  getRowId,
  storageKey,
  defaultHidden = [],
  defaultSorting = [],
  selection,
  onSelectionChange,
  active,
  onActiveChange,
  onOpen,
  onKey,
  actions,
  rowClassName,
  label,
  className,
}: {
  data: T[]
  columns: ColumnDef<T, unknown>[]
  getRowId: (row: T) => string
  storageKey: string
  defaultHidden?: string[]
  defaultSorting?: SortingState
  selection: string[]
  onSelectionChange: (ids: string[]) => void
  /** the row the keyboard is on (and whose detail is open) */
  active: string | null
  onActiveChange: (id: string | null) => void
  /** Enter, a double click */
  onOpen?: (id: string) => void
  onKey?: (key: 'space' | 'delete' | 'play', ids: string[]) => void
  /** the row menu: right click and the ⋯ button */
  actions?: (row: T) => RowAction[]
  rowClassName?: (row: T) => string | undefined
  label: string
  className?: string
}) {
  const saved = useMemo(() => load(storageKey), [storageKey])
  const [sorting, setSorting] = useState<SortingState>(saved.sorting ?? defaultSorting)
  const [visibility, setVisibility] = useState<VisibilityState>(() =>
    Object.fromEntries((saved.hidden ?? defaultHidden).map((id) => [id, false])),
  )
  const [order, setOrder] = useState<ColumnOrderState>(saved.order ?? [])
  const anchor = useRef<string | null>(null)
  const body = useRef<HTMLTableSectionElement>(null)

  useEffect(() => {
    save(storageKey, {
      sorting,
      order,
      hidden: Object.entries(visibility).filter(([, v]) => !v).map(([k]) => k),
    })
  }, [storageKey, sorting, order, visibility])

  const selected = useMemo(() => new Set(selection), [selection])
  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting, columnVisibility: visibility, columnOrder: order },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    onColumnOrderChange: setOrder,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableSortingRemoval: true,
  })
  const rows = table.getRowModel().rows
  const ids = useMemo(() => rows.map((r) => r.id), [rows])

  // the active row stays in view as the keyboard moves
  useEffect(() => {
    if (!active) return
    body.current?.querySelector(`[data-row-id="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const range = (from: string | null, to: string) => {
    const a = from ? ids.indexOf(from) : -1
    const b = ids.indexOf(to)
    if (a === -1 || b === -1) return [to]
    return ids.slice(Math.min(a, b), Math.max(a, b) + 1)
  }

  const click = (e: MouseEvent, id: string) => {
    if (e.shiftKey) {
      onSelectionChange(range(anchor.current ?? active, id))
      onActiveChange(id)
      return
    }
    anchor.current = id
    if (e.ctrlKey || e.metaKey) {
      onSelectionChange(selected.has(id) ? selection.filter((s) => s !== id) : [...selection, id])
    } else {
      onSelectionChange([id])
    }
    onActiveChange(id)
  }

  const toggle = (id: string, on: boolean) => {
    anchor.current = id
    onSelectionChange(on ? [...selection, id] : selection.filter((s) => s !== id))
  }

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('input, button, [role=menuitem]') && e.target !== e.currentTarget) return
    const at = active ? ids.indexOf(active) : -1
    const move = (to: number) => {
      e.preventDefault()
      const id = ids[Math.max(0, Math.min(ids.length - 1, to))]
      if (!id) return
      if (e.shiftKey) {
        onSelectionChange(range(anchor.current ?? active, id))
      } else {
        anchor.current = id
        onSelectionChange([id])
      }
      onActiveChange(id)
    }
    switch (e.key) {
      case 'ArrowDown':
        return move(at + 1)
      case 'ArrowUp':
        return move(at === -1 ? ids.length - 1 : at - 1)
      case 'Home':
        return move(0)
      case 'End':
        return move(ids.length - 1)
      case 'Enter':
        if (active && onOpen) {
          e.preventDefault()
          onOpen(active)
        }
        return
      case ' ':
        if (selection.length && onKey) {
          e.preventDefault()
          onKey('space', selection)
        }
        return
      case 'Delete':
      case 'Backspace':
        if (selection.length && onKey) {
          e.preventDefault()
          onKey('delete', selection)
        }
        return
      case 'Escape':
        if (selection.length) {
          e.preventDefault()
          onSelectionChange([])
        }
        return
      case 'p':
        if (active && onKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault()
          onKey('play', [active])
        }
        return
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          onSelectionChange(ids)
        }
    }
  }

  const allShown = ids.length > 0 && ids.every((id) => selected.has(id))
  const someShown = ids.some((id) => selected.has(id))

  return (
    <div
      role="grid"
      aria-label={label}
      aria-multiselectable
      tabIndex={0}
      onKeyDown={keyDown}
      className={cn('@container relative min-h-0 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset', className)}
    >
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-10 bg-card">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              <th className="w-9 border-b px-3 py-2 text-left">
                <Checkbox
                  aria-label="Select every row shown"
                  checked={allShown ? true : someShown ? 'indeterminate' : false}
                  onCheckedChange={(v) => onSelectionChange(v ? ids : [])}
                />
              </th>
              {group.headers.map((header) => {
                const meta = header.column.columnDef.meta
                const sort = header.column.getIsSorted()
                return (
                  <th
                    key={header.id}
                    aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'border-b px-2 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground',
                      meta?.numeric ? 'text-right' : 'text-left',
                      meta?.from && FROM[meta.from],
                      meta?.className,
                    )}
                  >
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          'inline-flex w-full items-center gap-1 hover:text-foreground',
                          meta?.numeric && 'flex-row-reverse',
                          sort && 'text-foreground',
                        )}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sort === 'asc' ? <ArrowUp className="size-3" /> : sort === 'desc' ? <ArrowDown className="size-3" /> : null}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                )
              })}
              <th className="w-10 border-b px-1 py-1 text-right">
                <ColumnMenu table={table} />
              </th>
            </tr>
          ))}
        </thead>
        <tbody ref={body}>
          {rows.map((row) => {
            const id = row.id
            const isSelected = selected.has(id)
            const items = actions?.(row.original) ?? []
            const tr = (
              <tr
                data-row-id={id}
                aria-selected={isSelected}
                data-active={active === id ? '' : undefined}
                onClick={(e) => click(e, id)}
                onDoubleClick={() => onOpen?.(id)}
                className={cn(
                  'group/row cursor-default select-none',
                  isSelected ? 'bg-primary/10' : 'hover:bg-muted/50',
                  rowClassName?.(row.original),
                )}
              >
                {/* the selected rows' gold edge */}
                <td className={cn('relative border-b px-3 py-1.5', isSelected && 'shadow-[inset_2px_0_0_var(--primary)]')} onClick={(e) => e.stopPropagation()}>
                  <Checkbox aria-label="Select" checked={isSelected} onCheckedChange={(v) => toggle(id, !!v)} />
                </td>
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta
                  return (
                    <td
                      key={cell.id}
                      className={cn(
                        'border-b px-2 py-1.5 align-middle',
                        meta?.numeric && 'text-right whitespace-nowrap',
                        meta?.from && FROM[meta.from],
                        meta?.className,
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  )
                })}
                <td className="border-b px-1 py-1 text-right" onClick={(e) => e.stopPropagation()}>
                  {items.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          tabIndex={-1}
                          aria-label="Actions"
                          className="opacity-60 group-hover/row:opacity-100 aria-expanded:opacity-100"
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-52">
                        {items.map((a, i) =>
                          a === 'separator' ? (
                            <DropdownMenuSeparator key={i} />
                          ) : (
                            <DropdownMenuItem key={i} disabled={a.disabled} variant={a.destructive ? 'destructive' : 'default'} onSelect={a.onSelect}>
                              {a.icon}
                              <span className="flex-1">{a.label}</span>
                              {a.shortcut && <kbd className="text-xs text-muted-foreground">{a.shortcut}</kbd>}
                            </DropdownMenuItem>
                          ),
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </td>
              </tr>
            )
            if (!items.length) return <FragmentRow key={id}>{tr}</FragmentRow>
            return (
              <ContextMenu
                key={id}
                onOpenChange={(open) => {
                  // like a file manager: right click on an unselected row selects it
                  if (open && !isSelected) {
                    anchor.current = id
                    onSelectionChange([id])
                    onActiveChange(id)
                  }
                }}
              >
                <ContextMenuTrigger asChild>{tr}</ContextMenuTrigger>
                <ContextMenuContent className="min-w-52">
                  {items.map((a, i) =>
                    a === 'separator' ? (
                      <ContextMenuSeparator key={i} />
                    ) : (
                      <ContextMenuItem key={i} disabled={a.disabled} variant={a.destructive ? 'destructive' : 'default'} onSelect={a.onSelect}>
                        {a.icon}
                        <span className="flex-1">{a.label}</span>
                        {a.shortcut && <kbd className="text-xs text-muted-foreground">{a.shortcut}</kbd>}
                      </ContextMenuItem>
                    ),
                  )}
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>
}

// Show, hide and reorder the columns
function ColumnMenu<T>({ table }: { table: ReturnType<typeof useReactTable<T>> }) {
  const columns = table.getAllLeafColumns().filter((c) => !c.columnDef.meta?.fixed)
  const all = table.getAllLeafColumns().map((c) => c.id)
  const order = table.getState().columnOrder.length ? table.getState().columnOrder : all
  const sorted = [...columns].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  // swaps a column with its neighbour in this list
  const move = (i: number, by: number) => {
    const a = sorted[i]?.id
    const b = sorted[i + by]?.id
    if (!a || !b) return
    const current = [...order]
    for (const c of all) if (!current.includes(c)) current.push(c)
    const x = current.indexOf(a)
    const y = current.indexOf(b)
    ;[current[x], current[y]] = [current[y], current[x]]
    table.setColumnOrder(current)
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" tabIndex={-1} aria-label="Columns" title="Columns">
          <Columns3 />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-sm font-medium">Columns</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              table.resetColumnOrder(true)
              table.resetColumnVisibility(false)
            }}
          >
            Reset
          </Button>
        </div>
        <ul className="max-h-80 overflow-y-auto">
          {sorted.map((c, i) => (
            <li key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
              <Checkbox id={`col-${c.id}`} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(!!v)} />
              <label htmlFor={`col-${c.id}`} className="flex-1 truncate text-sm">
                {c.columnDef.meta?.label ?? c.id}
              </label>
              <Button variant="ghost" size="icon-xs" aria-label={`Move ${c.columnDef.meta?.label ?? c.id} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ChevronUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Move ${c.columnDef.meta?.label ?? c.id} down`}
                disabled={i === sorted.length - 1}
                onClick={() => move(i, 1)}
              >
                <ChevronDown />
              </Button>
            </li>
          ))}
        </ul>
        {columns.some((c) => c.columnDef.meta?.from) && (
          <p className="border-t px-2 pt-2 pb-1 text-xs text-muted-foreground">Some columns only show when the list is wide enough.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
