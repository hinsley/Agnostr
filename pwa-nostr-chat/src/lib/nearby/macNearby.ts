import type { PluginListenerHandle } from '@capacitor/core'
import type { NearbyState, NearbyFrame, NearbyPlugin } from './nativeNearby.ts'

type Events = { state: NearbyState; frame: NearbyFrame }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }
type MacBridge = {
  webkit?: { messageHandlers?: { agnostrNearby?: { postMessage: (value: unknown) => void } } }
  __agnostrNearbyReply?: (id: number, value: unknown, error?: string) => void
  __agnostrNearbyEvent?: <K extends keyof Events>(kind: K, payload: Events[K]) => void
}

export function macNearby(): NearbyPlugin {
  const host = window as unknown as MacBridge
  const pending = new Map<number, Pending>()
  const events: { [K in keyof Events]: Set<(payload: Events[K]) => void> } = { state: new Set(), frame: new Set() }
  let counter = 0
  host.__agnostrNearbyReply = (id, value, error) => {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    window.clearTimeout(request.timer)
    if (error) request.reject(new Error(error))
    else request.resolve(value)
  }
  host.__agnostrNearbyEvent = (kind, payload) => {
    if (kind === 'state' || kind === 'frame') for (const listener of events[kind]) listener(payload)
  }

  function call<T>(action: string, options?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const sender = host.webkit?.messageHandlers?.agnostrNearby
      if (!sender || pending.size >= 128) { reject(new Error('Mac Bluetooth bridge is unavailable.')); return }
      const id = ++counter
      const timer = window.setTimeout(() => {
        pending.delete(id)
        reject(new Error('The Mac Bluetooth bridge did not reply.'))
      }, 8000)
      pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try { sender.postMessage({ id, action, options: options ?? {} }) }
      catch {
        pending.delete(id)
        window.clearTimeout(timer)
        reject(new Error('The Mac Bluetooth request failed.'))
      }
    })
  }

  async function addListener<K extends keyof Events>(kind: K, listener: (payload: Events[K]) => void): Promise<PluginListenerHandle> {
    events[kind].add(listener)
    return { async remove() { events[kind].delete(listener) } }
  }

  return {
    capabilities: () => call('capabilities'),
    start: () => call('start'),
    stop: () => call('stop'),
    send: options => call('send', options),
    addListener,
  }
}
