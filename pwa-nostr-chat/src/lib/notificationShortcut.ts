import type { NotificationEngine } from '../types/notifications.ts'

type NotificationOptionState = Pick<
  NotificationEngine,
  'settings' | 'permission' | 'isSupported' | 'isIosRequiresInstall' | 'isPushSupported' | 'pushStatus'
>

/** A discoverability cue only: nothing here requests permission or changes preferences. */
export function shouldOfferNotificationOptions(state: NotificationOptionState): boolean {
  const { settings, pushStatus } = state
  // The live connection is authoritative. A separate permission value can
  // briefly lag behind it, and optional alert preferences aren't setup.
  if (settings.enabled && settings.backgroundPushEnabled && pushStatus === 'connected') {
    return false
  }
  if (state.isIosRequiresInstall || (state.isSupported && state.permission !== 'granted')) {
    return true
  }
  if (!settings.enabled) return true
  return state.isPushSupported && pushStatus !== 'unsupported'
}
