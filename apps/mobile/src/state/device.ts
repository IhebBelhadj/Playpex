import { useState } from 'react'
import { decoders, describeThisDevice } from '../native/discovery'

// This phone, for the Settings page: its name as the server knows it, and the
// formats it decodes in hardware (the rest plays too, in software).

export type ThisDevice = { name: string; hardware: string[]; maxHeight: number }

export function useThisDevice(): ThisDevice {
  const [device] = useState<ThisDevice>(() => {
    const codecs = decoders()
    return { name: describeThisDevice().name, hardware: codecs.video, maxHeight: codecs.maxHeight }
  })
  return device
}
