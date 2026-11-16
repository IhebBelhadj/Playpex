import { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { Choice, ServerEntry } from '../../core/session/finder'
import type { SessionState } from '../../core/session/session'
import { useSession, useSessionState } from '../../state/app'
import { useStore } from '../../state/hooks'
import { useServerFinder } from '../../state/session'
import { Wordmark } from '../../ui/brand'
import { Button, type IconName } from '../../ui/components'
import { Press } from '../../ui/press'
import { color, font, radius, space, text } from '../../ui/theme'

// "Find your server" (docs/api/discovery.md): servers on this network and the
// ones paired before (ServerFinder), or an address typed. A paired one opens at
// once; another one is paired first (Pair).

// In a browser the server is the one that served the page (docs/mobile-web-plan.md): no other
// address can be used from here (its device cookie would be another site's)
const WEB = Platform.OS === 'web'

export default function ConnectScreen() {
  const finder = useServerFinder()
  const { entries, quiet, probing, error } = useStore(finder.state)
  const session = useSession()
  const state = useSessionState()

  function follow(choice: Choice) {
    if (choice.kind === 'pair') router.push({ pathname: '/pair', params: choice.server })
  }

  return (
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Wordmark size={30} />
          <Text style={[text.hero, { marginTop: space.xxl }]}>{WEB ? 'Your server' : 'Find your server'}</Text>
          <Text style={[text.body, { marginTop: space.s, color: color.textMuted }]}>
            {WEB
              ? 'Playpex plays what this Playpex Media Server has. Pair this browser with it once.'
              : 'Playpex plays what your Playpex Media Server has: pick it from your network, or type its address.'}
          </Text>

          <SessionNotice state={state} onRetry={() => void session.retry()} />

          <Text style={[text.heading, styles.section]}>{WEB ? 'This server' : 'On this network'}</Text>
          {entries.map((server) => (
            <ServerRow key={server.id} server={server} onPress={async () => follow(await finder.choose(server))} />
          ))}
          {!entries.length ? (
            <Text style={[text.body, { color: color.textMuted }]}>
              {!finder.discoveryAvailable
                ? 'Enter your server’s address below.'
                : WEB
                  ? quiet
                    ? 'The server didn’t answer. Reload the page to try again.'
                    : 'Looking…'
                  : quiet
                  ? 'No server found yet. Is the server on, and this phone on the same Wi-Fi? Its LAN sharing must be on (dashboard › Settings › Network).'
                  : 'Looking…'}
            </Text>
          ) : null}

          {!WEB ? <AddressForm finder={finder} probing={probing} onChoice={follow} /> : null}
          {error ? <Text style={[text.body, { color: color.error, marginTop: space.m }]}>{error}</Text> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

/** "Or type its address": a phone only */
function AddressForm({ finder, probing, onChoice: follow }: { finder: ReturnType<typeof useServerFinder>; probing: boolean; onChoice: (choice: Choice) => void }) {
  const [address, setAddress] = useState('')
  return (
    <>
      <Text style={[text.heading, styles.section]}>Or type its address</Text>
      <TextInput
        value={address}
        onChangeText={setAddress}
        placeholder="playpex.local or 192.168.1.20"
        placeholderTextColor={color.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={async () => follow(await finder.chooseAddress(address))}
        cursorColor={color.accent}
        selectionColor={color.accent}
        style={styles.input}
      />
      <Button
        label={probing ? 'Connecting…' : 'Connect'}
        onPress={async () => follow(await finder.chooseAddress(address))}
        disabled={probing || !address.trim()}
        style={{ marginTop: space.m }}
      />
    </>
  )
}

function ServerRow({ server, onPress }: { server: ServerEntry; onPress: () => void }) {
  return (
    <Press onPress={onPress} style={styles.server} scale={0.98} accessibilityLabel={server.name}>
      <View style={styles.serverIcon}>
        <Ionicons name="server-outline" size={22} color={color.accent} />
        {server.seen ? <View style={styles.liveDot} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={text.label}>{server.name}</Text>
        <Text style={text.small}>{server.seen ? (server.host ?? server.url.replace(/^https?:\/\//, '')) : 'Not seen on this network'}</Text>
      </View>
      {server.paired ? <Text style={styles.paired}>Paired</Text> : null}
      <Ionicons name="chevron-forward" size={20} color={color.textDim} />
    </Press>
  )
}

/** Why there is no server: the last one didn't answer, or it ended the session */
function SessionNotice({ state, onRetry }: { state: SessionState; onRetry: () => void }) {
  if (state.kind === 'unreachable') {
    return (
      <Notice
        icon="cloud-offline-outline"
        title={`Can’t reach ${state.server.name}`}
        body="Is the server on, and this phone on the same Wi-Fi?"
        action={{ label: 'Try again', onPress: onRetry }}
      />
    )
  }
  if (state.kind === 'noServer' && state.lost) {
    const { lost } = state
    return (
      <Notice
        icon="alert-circle-outline"
        title={
          lost.code === 'PAIRING_REQUIRED' ? `This phone was removed from ${lost.serverName}` : lost.code === 'CLIENT_TOO_OLD' ? 'Update Playpex' : 'Update Playpex Media Server'
        }
        body={lost.code === 'PAIRING_REQUIRED' ? 'Pair it again to keep watching.' : lost.message}
      />
    )
  }
  return null
}

function Notice({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.notice}>
      <Ionicons name={icon} size={22} color={color.caution} />
      <View style={{ flex: 1 }}>
        <Text style={text.heading}>{title}</Text>
        <Text style={[text.small, { marginTop: 2 }]}>{body}</Text>
        {action ? <Button kind="secondary" label={action.label} onPress={action.onPress} style={{ marginTop: space.m, alignSelf: 'flex-start' }} /> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.xl, paddingTop: space.xxl * 1.5 },
  section: { marginTop: space.xxl, marginBottom: space.m },
  server: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    padding: space.l,
    borderRadius: radius.l,
    backgroundColor: color.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    marginBottom: space.s,
  },
  serverIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.surface1, alignItems: 'center', justifyContent: 'center' },
  liveDot: { position: 'absolute', right: 2, top: 2, width: 10, height: 10, borderRadius: 5, backgroundColor: color.live, borderWidth: 2, borderColor: color.surface2 },
  paired: { ...text.tiny, color: color.accent },
  input: {
    backgroundColor: color.surface2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    paddingHorizontal: space.xl,
    height: 50,
    color: color.text,
    fontFamily: font.medium,
    fontSize: 16,
  },
  notice: {
    flexDirection: 'row',
    gap: space.m,
    padding: space.l,
    borderRadius: radius.l,
    backgroundColor: color.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.caution,
    marginTop: space.xl,
  },
})
