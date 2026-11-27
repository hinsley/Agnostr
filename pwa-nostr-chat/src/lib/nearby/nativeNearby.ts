import { isNativeMacBuild } from "../appPlatform.ts"
import { macNearby } from "./macNearby.ts"
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { framesFor, type MeshPacket } from './meshWire.ts'

export interface NearbyLink { id: string; maxBytes: number }
export interface NearbyState { active: boolean; links: NearbyLink[]; error?: string }
export interface NearbyFrame { link: string; wire: string }

export interface NearbyPlugin {
  capabilities(): Promise<{ supported: boolean }>
  start(): Promise<void>
  stop(): Promise<void>
  send(request: { link: string; frames: string[] }): Promise<{ accepted: boolean }>
  addListener(name: 'state', cb: (value: NearbyState) => void): Promise<PluginListenerHandle>
  addListener(name: 'frame', cb: (value: NearbyFrame) => void): Promise<PluginListenerHandle>
}

export const Nearby = isNativeMacBuild ? macNearby() : registerPlugin<NearbyPlugin>('AgnostrNearby')

export function unpackNearbyFrame(frame: string): Uint8Array | null {
  if (typeof frame !== 'string' || frame.length > 684) return null
  try { return Uint8Array.from(atob(frame), char => char.charCodeAt(0)) } catch { return null }
}

export async function sendOnLink(link: NearbyLink, ...packets: MeshPacket[]) {
  const frames = packets.flatMap(packet => framesFor(packet, link.maxBytes))
  if (!frames.length || frames.length > 48) return false
  try {
    const base64 = frames.map(frame => btoa(String.fromCharCode(...frame)))
    return (await Nearby.send({ link: link.id, frames: base64 })).accepted
  } catch { return false }
}
