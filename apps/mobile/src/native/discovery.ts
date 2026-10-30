import { Platform } from 'react-native'
import { codecs, hasDiscovery, probe, startDiscovery } from '../../modules/playpex-device'
import { PLAYER_CAPABILITIES } from '../core/player/capabilities'
import type { DeviceDescription, Discovery } from '../core/session/ports'

// The playpex-device module (Kotlin: NsdManager mDNS + UDP, MediaCodecList) as
// the ports of core/session.

export const discovery: Discovery = {
  available: hasDiscovery,
  start: startDiscovery,
  probe,
}

/** The video formats this phone decodes in hardware, and the tallest picture */
export function decoders(): { video: string[]; maxHeight: number } {
  const c = codecs()
  return { video: c.video, maxHeight: c.maxHeight }
}

/** This phone as PUT /devices/me describes it: its name, and everything the player decodes */
export function describeThisDevice(): DeviceDescription {
  return {
    name: deviceName(),
    platform: Platform.OS,
    capabilities: { ...PLAYER_CAPABILITIES, maxHeight: codecs().maxHeight },
  }
}

function deviceName(): string {
  const constants = Platform.constants as { Model?: string; Brand?: string }
  if (Platform.OS === 'android' && constants.Model) {
    const brand = constants.Brand ? constants.Brand.charAt(0).toUpperCase() + constants.Brand.slice(1) + ' ' : ''
    return (constants.Model.toLowerCase().startsWith((constants.Brand ?? '').toLowerCase()) ? '' : brand) + constants.Model
  }
  return Platform.OS === 'ios' ? 'iPhone' : 'Phone'
}
