import { ArrowLeft, Menu } from 'lucide-react'
import { Children, isValidElement, lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router'
import remarkGfm from 'remark-gfm'
import { Spinner } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

// The client author guide (docs/api/*.md at the repo root, plan step 10),
// bundled at build time and shown without sign-in: client authors aren't the
// server's admin. /api/v1/docs redirects here.
const FILES = import.meta.glob('../../../../docs/api/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

const PAGES: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([file, text]) => [slugOf(file), text]),
)

// Sidebar order; README is the index (/docs)
const ORDER = ['', 'discovery', 'auth', 'catalog', 'playback', 'search', 'live', 'profiles', 'settings', 'plugins', 'events', 'errors-and-versions']

function slugOf(file: string) {
  const name = file.split('/').pop()!.replace(/\.md$/, '')
  return name === 'README' ? '' : name
}

function titleOf(text: string) {
  return /^#\s+(.+)$/m.exec(text)?.[1] ?? 'Untitled'
}

const CHAPTERS = [
  ...ORDER.filter((slug) => slug in PAGES),
  ...Object.keys(PAGES).filter((slug) => !ORDER.includes(slug)).sort(),
].map((slug) => ({ slug, title: slug ? titleOf(PAGES[slug]) : 'Overview' }))

/** GitHub-style heading ids, so `chapter.md#some-heading` links keep working */
function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/** `auth.md#x` → `/docs/auth#x`, `README.md` → `/docs`; other links open outside */
function DocLink({ href = '', children }: { href?: string; children?: ReactNode }) {
  const md = /^(?:\.\/)?([\w-]+)\.md(#.*)?$/.exec(href)
  if (md) {
    const slug = md[1] === 'README' ? '' : md[1]
    return <Link to={`/docs${slug ? `/${slug}` : ''}${md[2] ?? ''}`}>{children}</Link>
  }
  if (href.startsWith('#')) return <a href={href}>{children}</a>
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

function heading(Tag: 'h1' | 'h2' | 'h3' | 'h4') {
  return function Heading({ children }: { children?: ReactNode }) {
    const id = slugify(textOf(Children.toArray(children)))
    return (
      <Tag id={id}>
        {children}
        {Tag !== 'h1' && (
          <a href={`#${id}`} className="doc-anchor" aria-label="Link to this section">
            #
          </a>
        )}
      </Tag>
    )
  }
}

const COMPONENTS: Components = {
  a: ({ href, children }) => <DocLink href={href}>{children}</DocLink>,
  h1: heading('h1'),
  h2: heading('h2'),
  h3: heading('h3'),
  h4: heading('h4'),
  table: ({ children }) => (
    <div className="doc-table">
      <table>{children}</table>
    </div>
  ),
}

function DocsNav({ onNavigate }: { onNavigate?: () => void }) {
  const item = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex h-[34px] items-center rounded-full px-3 text-sm text-muted-foreground transition-colors hover:text-foreground',
      isActive && 'font-medium text-foreground',
    )
  return (
    <nav className="flex flex-col gap-6">
      <div className="flex flex-col">
        <p className="px-3 pb-1.5 text-xs text-muted-foreground/80">Guide</p>
        {CHAPTERS.map(({ slug, title }) => (
          <NavLink key={slug} to={`/docs${slug ? `/${slug}` : ''}`} end onClick={onNavigate} className={item}>
            <span className="truncate">{title}</span>
          </NavLink>
        ))}
      </div>
      <div className="flex flex-col">
        <p className="px-3 pb-1.5 text-xs text-muted-foreground/80">Reference</p>
        <NavLink to="/docs/reference" onClick={onNavigate} className={item}>
          API reference
        </NavLink>
        <a href="/api/v1/openapi.yaml" className={item({ isActive: false })}>
          openapi.yaml
        </a>
      </div>
    </nav>
  )
}

function Brand() {
  return (
    <Link to="/docs" className="flex items-center gap-2.5 px-2.5">
      <img src="/logo.svg" alt="" className="size-6" />
      <div className="min-w-0 leading-tight">
        <div className="text-sm font-semibold">Playpex</div>
        <div className="truncate text-xs text-muted-foreground">Client guide · API v1</div>
      </div>
    </Link>
  )
}

/** Public: no RequireAdmin, no events socket */
export function DocsLayout() {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const reference = location.pathname.startsWith('/docs/reference')
  return (
    <div className="flex min-h-svh">
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col gap-6 border-r bg-sidebar px-3 py-4 md:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto">
          <DocsNav />
        </div>
        <Link to="/" className="flex items-center gap-2 border-t px-2.5 pt-3 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Dashboard
        </Link>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background px-4 py-2 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Chapters">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 gap-6 px-3 py-4">
              <SheetTitle className="sr-only">Chapters</SheetTitle>
              <Brand />
              <DocsNav onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <span className="text-sm font-medium">Playpex client guide</span>
        </header>
        <main className={cn('min-w-0 flex-1', !reference && 'px-4 py-8 md:px-10')}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export function DocPage() {
  const { page = '' } = useParams()
  const { hash } = useLocation()
  const text = PAGES[page]
  const index = CHAPTERS.findIndex((c) => c.slug === page)
  const next = CHAPTERS[index + 1]

  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1))
    const target = id ? document.getElementById(id) : null
    if (target) target.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [page, hash])

  if (text === undefined) {
    return (
      <div className="doc-prose">
        <h1>Not found</h1>
        <p>
          No chapter named “{page}”. <Link to="/docs">Back to the guide</Link>.
        </p>
      </div>
    )
  }
  return (
    <article className="doc-prose">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </Markdown>
      {next && (
        <p className="doc-next">
          Next: <Link to={`/docs/${next.slug}`}>{next.title}</Link>
        </p>
      )}
    </article>
  )
}

// Scalar (≈ 3 MB with its Vue runtime) loads only on this page
const Reference = lazy(() => import('@/pages/docs-reference'))

export function ReferencePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-svh items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      }
    >
      <Reference />
    </Suspense>
  )
}
