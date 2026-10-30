import { useState } from 'react'
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useMutation, useQuery } from '@tanstack/react-query'
import Ionicons from '@expo/vector-icons/Ionicons'
import { unlockProfile, type Profile } from '../../core/services/profiles'
import { useClient, useSession } from '../../state/app'
import { queries } from '../../state/queries'
import { Avatar } from '../../ui/avatar'
import { Mark } from '../../ui/brand'
import { Button, Loading, Message } from '../../ui/components'
import { Press } from '../../ui/press'
import { color, font, radius, space, text } from '../../ui/theme'

// "Who's watching?" (docs/api/profiles.md): the server's profiles, the last
// used first, ringed; a locked one asks for its PIN. Choosing one tells the
// session, and the layout shows the app. Profiles are made on the TV or the dashboard.

export default function ProfilesScreen() {
  const client = useClient()
  const session = useSession()
  const profiles = useQuery(queries.profiles(client))
  const [locked, setLocked] = useState<Profile | null>(null)
  const unlock = useMutation({
    mutationFn: ({ profile, pin }: { profile: Profile; pin?: string }) => unlockProfile(client, profile.id, pin),
    onSuccess: (profile) => {
      setLocked(null)
      session.chooseProfile(profile)
    },
  })

  if (profiles.isPending) return <Loading />
  if (profiles.isError)
    return <Message title="The profiles didn’t load" body={profiles.error.message} action={{ label: 'Try again', onPress: () => profiles.refetch() }} />

  const { lastUsedId } = profiles.data
  const list = [...profiles.data.profiles].sort((a, b) => (a.id === lastUsedId ? -1 : b.id === lastUsedId ? 1 : 0))

  function pick(profile: Profile) {
    unlock.reset()
    if (profile.hasPin) setLocked(profile)
    else unlock.mutate({ profile })
  }

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={{ alignItems: 'center', marginBottom: space.xxxl }}>
          <Mark size={36} centred />
        </View>
        <Text style={[text.hero, { textAlign: 'center', marginBottom: space.xxl }]}>Who’s watching?</Text>
        <View style={styles.grid}>
          {list.map((p) => (
            <Press key={p.id} onPress={() => pick(p)} style={styles.tile} scale={0.92} accessibilityLabel={p.hasPin ? `${p.name}, locked` : p.name}>
              <View style={[styles.ring, p.id === lastUsedId && styles.ringLast]}>
                <Avatar id={p.avatar} name={p.name} size={104} round />
              </View>
              <View style={styles.name}>
                <Text style={[text.label, { fontSize: 15 }]} numberOfLines={1}>
                  {p.name}
                </Text>
                {p.hasPin ? <Ionicons name="lock-closed" size={12} color={color.textMuted} /> : null}
              </View>
            </Press>
          ))}
        </View>
        {!list.length ? (
          <Text style={[text.body, { textAlign: 'center', color: color.textMuted }]}>This server has no profile yet. Create one on the TV or the server’s dashboard.</Text>
        ) : null}
        {unlock.error && !locked ? <Text style={[text.body, { color: color.error, textAlign: 'center' }]}>{unlock.error.message}</Text> : null}
        <Button kind="quiet" icon="swap-horizontal" label="Change server" onPress={() => session.disconnect()} style={{ marginTop: space.xxl }} />
      </ScrollView>
      {locked ? (
        <PinDialog
          key={locked.id}
          profile={locked}
          error={unlock.error?.message ?? null}
          busy={unlock.isPending}
          onCancel={() => setLocked(null)}
          onSubmit={(pin) => unlock.mutate({ profile: locked, pin })}
        />
      ) : null}
    </SafeAreaView>
  )
}

function PinDialog({ profile, error, busy, onCancel, onSubmit }: { profile: Profile; error: string | null; busy: boolean; onCancel: () => void; onSubmit: (pin: string) => void }) {
  const [pin, setPin] = useState('')
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.scrim}>
        <View style={styles.dialog}>
          <Text style={text.heading}>Enter {profile.name}’s PIN</Text>
          <TextInput
            value={pin}
            onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            secureTextEntry
            autoFocus
            maxLength={6}
            cursorColor={color.accent}
            onSubmitEditing={() => pin.length >= 4 && onSubmit(pin)}
            style={styles.pin}
          />
          {error ? <Text style={[text.small, { color: color.error }]}>{error}</Text> : null}
          <View style={styles.actions}>
            <Button kind="quiet" label="Cancel" onPress={onCancel} />
            <Button label={busy ? 'Checking…' : 'OK'} onPress={() => onSubmit(pin)} disabled={busy || pin.length < 4} />
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.xl, paddingTop: space.xxl * 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.xl },
  tile: { width: 112, alignItems: 'center' },
  ring: { padding: 3, borderRadius: 999, borderWidth: 2, borderColor: color.transparent },
  ringLast: { borderColor: color.accent },
  name: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.s, maxWidth: 104 },
  scrim: { flex: 1, backgroundColor: color.scrim, justifyContent: 'center', padding: space.xl },
  dialog: { backgroundColor: color.surface2, borderRadius: radius.xl, padding: space.xl, gap: space.m, borderWidth: StyleSheet.hairlineWidth, borderColor: color.lineStrong },
  pin: {
    backgroundColor: color.surface1,
    borderRadius: radius.m,
    color: color.text,
    fontFamily: font.display,
    fontSize: 28,
    letterSpacing: 12,
    textAlign: 'center',
    paddingVertical: space.m,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.s },
})
