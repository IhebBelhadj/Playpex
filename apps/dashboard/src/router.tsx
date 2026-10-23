import { createBrowserRouter, Navigate } from 'react-router'
import { Spinner } from '@/components/common'
import { AppLayout, RequireAdmin } from '@/components/layout'
import { AboutPage } from '@/pages/about'
import { ActivityPage } from '@/pages/activity'
import { DevicesPage } from '@/pages/devices'
import { LinkPage } from '@/pages/link'
import { LoginPage } from '@/pages/login'
import { LogsPage } from '@/pages/logs'
import { OverviewPage } from '@/pages/overview'
import { ProfilesPage } from '@/pages/profiles'
import { SettingsPage } from '@/pages/settings'
import { SetupPage } from '@/pages/setup'
import { StoragePage } from '@/pages/storage'
import { DownloadsPage } from '@/pages/downloads'

// Paths are served by the server's SPA fallback (lib/api.js): any GET without
// a dot outside /api answers index.html. /link is pairing's verification_uri.
// /docs (the client author guide) is public, like the spec it describes, and
// loaded on demand (Markdown renderer, API reference) so the admin pages don't
// carry it.
const docs = () => import('@/pages/docs')

export const router = createBrowserRouter([
  { path: '/setup', element: <SetupPage /> },
  { path: '/login', element: <LoginPage /> },
  {
    path: '/docs',
    lazy: async () => ({ Component: (await docs()).DocsLayout }),
    hydrateFallbackElement: (
      <div className="flex h-svh items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    ),
    children: [
      { index: true, lazy: async () => ({ Component: (await docs()).DocPage }) },
      { path: 'reference', lazy: async () => ({ Component: (await docs()).ReferencePage }) },
      { path: ':page', lazy: async () => ({ Component: (await docs()).DocPage }) },
    ],
  },
  {
    element: (
      <RequireAdmin>
        <AppLayout />
      </RequireAdmin>
    ),
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'devices', element: <DevicesPage /> },
      { path: 'link', element: <LinkPage /> },
      { path: 'logs', element: <LogsPage /> },
      { path: 'downloads', element: <DownloadsPage /> },
      { path: 'storage', element: <StoragePage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/:tab', element: <SettingsPage /> },
      { path: 'profiles', element: <ProfilesPage /> },
      { path: 'about', element: <AboutPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
