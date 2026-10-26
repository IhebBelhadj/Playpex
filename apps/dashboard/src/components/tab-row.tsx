import type { ReactNode } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

// A page's tabs (inside a <Tabs>): a row where they fit, a select below that (`from`:
// sm for a few tabs, lg or xl for more), never a row that runs off the screen with its last
// tab cut in half or wraps inside its track.

export type TabItem = { value: string; label: string; badge?: ReactNode }

const SHOW = {
  sm: { select: 'sm:hidden', row: 'hidden sm:flex' },
  lg: { select: 'sm:w-64 lg:hidden', row: 'hidden lg:flex' },
  xl: { select: 'sm:w-64 xl:hidden', row: 'hidden xl:flex' },
}

export function TabRow({
  items,
  value,
  onChange,
  label,
  from = 'sm',
}: {
  items: TabItem[]
  value: string
  onChange: (value: string) => void
  label: string
  from?: keyof typeof SHOW
}) {
  return (
    <>
      <div className={SHOW[from].select}>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger aria-label={label} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
                {t.badge}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <TabsList variant="line" aria-label={label} className={cn(SHOW[from].row, 'h-10 w-full justify-start border-b')}>
        {items.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
            {t.badge}
          </TabsTrigger>
        ))}
      </TabsList>
    </>
  )
}
