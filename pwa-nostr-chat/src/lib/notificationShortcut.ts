import type { NotificationEngine, NotificationSettings } from '../types/notifications.ts'

const ALERT_SWITCHES = [
  'dms',
  'agmail',
  'agmailCcBcc',
  'directPings',
  'dmCallRinging',
  'serverCalls',
  'agoraRepliesMentions',
  'agoraReactionsReposts',
  'agoraZaps',
  'agoraFollows',
  'soundEnabled',
  'ringtoneEnabled',
  'vibrationEnabled',
  'showPreviews',
] as const satisfies readonly (keyof NotificationSettings)[]

type NotificationOptionState = Pick<
  NotificationEngine,
  'settings' | 'permission' | 'isSupported' | 'isIosRequiresInstall' | 'isPushSupported' |
    'pushStatus' | 'usesExternalPushSigner' | 'publicPinnedRoomFallbackAvailable'
>

/** A discoverability cue only: nothing here requests permission or changes preferences. */
export function shouldOfferNotificationOptions(state: NotificationOptionState): boolean {
  const { settings } = state
  if (state.isIosRequiresInstall || (state.isSupported && state.permission !== 'granted')) {
    return true
  }
  if (
    !settings.enabled ||
    ALERT_SWITCHES.some((key) => !settings[key]) ||
    settings.serverMessages === 'off' ||
    settings.geoMessages === 'off'
  ) {
    return true
  }
  if (!state.isPushSupported || state.pushStatus === 'unsupported') return false
  if (!settings.backgroundPushEnabled || state.pushStatus !== 'connected') return true

  return state.usesExternalPushSigner
    ? !settings.extensionPushPokes
    : state.publicPinnedRoomFallbackAvailable && !settings.publicPinnedRoomFallback
}
