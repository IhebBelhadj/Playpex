import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

// The native side (android/.../PlaypexConnection.java) watches the phone's networks, sends a dashboard
// that can't load (or whose server stops answering after a network change) to this page's
// "can't reach" screen (#offline=<url>), and opens Android's Wi-Fi panel.

export type Network = {
  /** any network at all (Wi-Fi, mobile data, Ethernet, a VPN) */
  connected: boolean
  /** a Wi-Fi or Ethernet one: where Playpex servers are found (with or without internet) */
  local: boolean
}

interface ConnectionPlugin {
  network(): Promise<Network>
  wifiSettings(): Promise<void>
  addListener(event: 'network', listener: (n: Network) => void): Promise<PluginListenerHandle>
}

const native = registerPlugin<ConnectionPlugin>('PlaypexConnection')
const isNative = Capacitor.isNativePlatform()

/** In a browser (development): navigator.onLine, and any network counts as local */
function browserNetwork(): Network {
  return { connected: navigator.onLine, local: navigator.onLine }
}

export async function network(): Promise<Network> {
  if (!isNative) return browserNetwork()
  try {
    return await native.network()
  } catch {
    return { connected: true, local: true }
  }
}

export function onNetwork(listener: (n: Network) => void): void {
  if (!isNative) {
    const send = () => listener(browserNetwork())
    addEventListener('online', send)
    addEventListener('offline', send)
    return
  }
  void native.addListener('network', listener)
}

/** Android's Wi-Fi panel; nothing in a browser */
export const canOpenWifiSettings = isNative

export async function wifiSettings(): Promise<void> {
  if (isNative) await native.wifiSettings().catch(() => {})
}
