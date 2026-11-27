import { useEffect, useRef, useState } from 'react'
import { isNativeAppBuild } from '../lib/appPlatform.ts'
import type { NearbyPorts, NearbyRuntime, NearbySnapshot } from '../lib/nearby/nearbyRuntime.ts'

export type NearbyController = {
  state: NearbySnapshot
  api: () => NearbyRuntime | null
}

export function useNearbyRuntime(ports: Omit<NearbyPorts, 'snapshot'>, profile: string, nickname: string): NearbyController {
  const latest = useRef(ports)
  const runtime = useRef<NearbyRuntime | null>(null)
  const [state, setState] = useState<NearbySnapshot>({
    supported: false, active: false, working: false, sharing: false, links: 0, localId: null, peers: [], messages: [],
  })
  latest.current = ports
  useEffect(() => {
    if (!isNativeAppBuild) return
    let closed = false
    setState({ supported: false, active: false, working: false, sharing: false, links: 0, localId: null, peers: [], messages: [] })
    void import('../lib/nearby/nearbyRuntime.ts').then(({ makeNearbyRuntime }) => {
      if (!closed) runtime.current = makeNearbyRuntime({
        selectedGeohash: () => latest.current.selectedGeohash(),
        publish: (...args) => latest.current.publish(...args),
        receive: (...args) => latest.current.receive(...args),
        snapshot: setState,
      })
    }).catch(() => {})
    return () => {
      closed = true
      runtime.current?.close()
      runtime.current = null
    }
  }, [profile, nickname])
  return { state, api: () => runtime.current }
}
