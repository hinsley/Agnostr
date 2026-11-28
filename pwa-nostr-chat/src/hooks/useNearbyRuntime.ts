import { useEffect, useRef, useState } from 'react'
import { isNativeAndroidBuild, isNativeAppBuild } from '../lib/appPlatform.ts'
import type { NearbyPorts, NearbyRuntime, NearbySnapshot } from '../lib/nearby/nearbyRuntime.ts'

const ANDROID_MESH_KEY = 'agnostr:android:mesh-enabled'
const emptyState: NearbySnapshot = {
  supported: false, active: false, working: false, sharing: false, links: 0, localId: null, peers: [], messages: [],
}

export type NearbyController = {
  state: NearbySnapshot
  api: () => NearbyRuntime | null
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export function useNearbyRuntime(ports: Omit<NearbyPorts, 'snapshot'>, profile: string, nickname: string): NearbyController {
  const latest = useRef(ports)
  const runtime = useRef<NearbyRuntime | null>(null)
  const [state, setState] = useState(emptyState)
  const [enabled, setEnabledState] = useState(() => {
    try { return isNativeAndroidBuild && localStorage.getItem(ANDROID_MESH_KEY) === '1' }
    catch { return false }
  })
  const enabledRef = useRef(enabled)
  latest.current = ports

  useEffect(() => {
    if (!isNativeAppBuild) return
    let closed = false
    setState(emptyState)
    function resume() {
      if (isNativeAndroidBuild && document.visibilityState !== 'hidden') {
        void runtime.current?.resume(nickname, () => enabledRef.current && document.visibilityState !== 'hidden')
      }
    }
    // While enabled, retry only when inactive; this handles returning to the app,
    // granting permission in Android settings, and switching the radio back on.
    const timer = isNativeAndroidBuild ? window.setInterval(resume, 4000) : undefined
    if (isNativeAndroidBuild) document.addEventListener('visibilitychange', resume)
    void import('../lib/nearby/nearbyRuntime.ts').then(({ makeNearbyRuntime }) => {
      if (closed) return
      runtime.current = makeNearbyRuntime({
        selectedGeohash: () => latest.current.selectedGeohash(),
        canBridge: () => latest.current.canBridge?.() ?? true,
        publish: (...args) => latest.current.publish(...args),
        receive: (...args) => latest.current.receive(...args),
        publishTorrent: (event) => latest.current.publishTorrent?.(event) ?? Promise.resolve(false),
        receiveTorrent: (event) => latest.current.receiveTorrent?.(event),
        snapshot: setState,
      })
      resume()
    }).catch(() => {})
    return () => {
      closed = true
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', resume)
      runtime.current?.close()
      runtime.current = null
    }
  }, [profile, nickname])

  function setEnabled(value: boolean) {
    if (!isNativeAndroidBuild) return
    enabledRef.current = value
    setEnabledState(value)
    try {
      if (value) localStorage.setItem(ANDROID_MESH_KEY, '1')
      else localStorage.removeItem(ANDROID_MESH_KEY)
    } catch { /* Keep the current in-memory choice. */ }
    if (value) void runtime.current?.start(nickname, { managed: true, requestPermission: true })
    else void runtime.current?.stop()
  }

  return { state, api: () => runtime.current, enabled, setEnabled }
}
