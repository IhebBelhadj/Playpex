import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { changeSetting, scopeOf, type SettingKey, type Settings, type SettingValues } from '../core/services/settings'
import { useClient, useProfile } from './app'
import { keys, queries } from './queries'

// The settings as the Settings page reads and changes them: a change shows at
// once (the cache takes it before the server answers) and comes back if the
// server refuses it; settings.changed from elsewhere refreshes them
// (invalidation.ts).

export function useSettings() {
  const client = useClient()
  const profile = useProfile()
  return useQuery(queries.settings(client, profile.id))
}

/** One setting and its new value */
export type SettingChange = { [K in SettingKey]: { key: K; value: SettingValues[K] } }[SettingKey]

export function useChangeSetting() {
  const client = useClient()
  const profile = useProfile()
  const queryClient = useQueryClient()
  const key = keys.settings(profile.id)
  return useMutation({
    mutationFn: (change: SettingChange) => changeSetting(client, profile.id, change.key, change.value),
    onMutate: async (change: SettingChange) => {
      await queryClient.cancelQueries({ queryKey: key })
      const before = queryClient.getQueryData<Settings>(key)
      if (before) {
        const scope = scopeOf(change.key)
        queryClient.setQueryData<Settings>(key, {
          ...before,
          [scope]: { ...(before[scope] ?? {}), [change.key]: change.value },
        })
      }
      return { before }
    },
    onError: (_e, _change, context) => {
      if (context?.before) queryClient.setQueryData(key, context.before)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })
}
