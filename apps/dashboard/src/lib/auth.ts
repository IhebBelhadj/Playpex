import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from './api'

// The admin's session (Better Auth's HttpOnly cookie) and the first-run setup.

export function useSetupState() {
  return useQuery({
    queryKey: ['setup'],
    queryFn: () => unwrap(api.GET('/admin/setup')),
    staleTime: 60_000,
  })
}

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => unwrap(api.GET('/auth/get-session')),
    staleTime: 60_000,
  })
}

export function useSignIn() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: { username: string; password: string }) =>
      unwrap(api.POST('/auth/sign-in/username', { body: { ...body, rememberMe: true } })),
    onSuccess: () => client.invalidateQueries(),
  })
}

export function useSignOut() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(api.POST('/auth/sign-out', { body: {} })),
    onSettled: () => {
      client.clear()
      client.invalidateQueries({ queryKey: ['session'] })
    },
  })
}

/** The signed-in admin's display name, from Better Auth's user object. */
export function adminName(session: unknown): string | null {
  const user = (session as { user?: Record<string, unknown> } | null)?.user
  if (!user) return null
  return String(user.displayUsername ?? user.username ?? user.name ?? 'admin')
}
