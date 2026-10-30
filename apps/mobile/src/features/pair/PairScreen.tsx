import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Redirect, router, useLocalSearchParams } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { splitCode, type PairingState, type PairingTarget } from '../../core/session/pairing'
import { useNow, useStore } from '../../state/hooks'
import { usePairing } from '../../state/session'
import { Button, IconButton, Loading } from '../../ui/components'
import { color, font, radius, space, text } from '../../ui/theme'

// Pairing once with a server (docs/api/auth.md): the code in two halves, where
// the admin approves it; PairingController polls and, once approved, connects
// the session (the layout then shows "Who's watching?").

type Params = { id?: string; name?: string; url?: string }

export default function PairScreen() {
  const { id, name, url } = useLocalSearchParams<Params>()
  // Opened without a server (the router falls back here at launch when "/" is guarded off): Connect picks one
  if (!id || !url) return <Redirect href="/connect" />
  return <Pairing target={{ id, name: name ?? '', url }} />
}

function Pairing({ target }: { target: PairingTarget }) {
  const pairing = usePairing(target)
  const state = useStore(pairing.state)
  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.bar}>
        <IconButton icon="chevron-back" label="Back" glass onPress={() => (router.canGoBack() ? router.back() : router.replace('/connect'))} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={text.title}>Pair with {target.name}</Text>
        <Step state={state} onRetry={() => pairing.restart()} />
      </ScrollView>
    </SafeAreaView>
  )
}

function Step({ state, onRetry }: { state: PairingState; onRetry: () => void }) {
  switch (state.step) {
    case 'asking':
    case 'approved':
      return <Loading label={state.step === 'approved' ? 'Paired' : undefined} />
    case 'waiting':
      return <Waiting state={state} />
    case 'expired':
      return <Retry message="The code expired." onPress={onRetry} />
    case 'denied':
      return <Retry message="The server’s admin refused this phone." onPress={onRetry} />
    case 'failed':
      return <Retry message={state.message} onPress={onRetry} />
  }
}

function Waiting({ state }: { state: Extract<PairingState, { step: 'waiting' }> }) {
  const now = useNow(1000)
  const minutes = Math.max(0, Math.ceil((state.expiresAt - now) / 60000))
  return (
    <>
      <Text style={[text.body, styles.lead]}>Approve this code on the server: on its dashboard’s Link page, or from its tray icon.</Text>
      <View style={styles.codeBox}>
        <Text style={styles.code} selectable>
          {splitCode(state.code.user_code)}
        </Text>
      </View>
      <Text style={[text.small, { textAlign: 'center' }]}>{state.code.verification_uri}</Text>
      <Text style={[text.tiny, { textAlign: 'center', marginTop: space.s }]}>Expires in {minutes} min. Waiting for approval…</Text>
      <Button
        kind="secondary"
        icon="open-outline"
        label="I’m the admin: open on this phone"
        onPress={() => Linking.openURL(state.code.verification_uri_complete ?? state.code.verification_uri)}
        style={{ marginTop: space.xxl }}
      />
    </>
  )
}

function Retry({ message, onPress }: { message: string; onPress: () => void }) {
  return (
    <View style={{ marginTop: space.xxl }}>
      <Text style={[text.body, { color: color.textMuted }]}>{message}</Text>
      <Button label="Get a new code" onPress={onPress} style={{ marginTop: space.l, alignSelf: 'flex-start' }} />
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  bar: { paddingHorizontal: space.l, paddingVertical: space.s },
  content: { padding: space.xl },
  lead: { marginTop: space.m, color: color.textMuted },
  codeBox: {
    marginVertical: space.xxl,
    paddingVertical: space.xl,
    borderRadius: radius.l,
    backgroundColor: color.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    alignItems: 'center',
  },
  code: { fontFamily: font.display, fontSize: 40, letterSpacing: 6, color: color.text, fontVariant: ['tabular-nums'] },
})
