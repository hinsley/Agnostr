export const isNativeAndroidBuild = import.meta.env?.MODE === 'android'
export const isNativeMacBuild = import.meta.env?.MODE === 'macos'
export const isNativeAppBuild = isNativeAndroidBuild || isNativeMacBuild
export const PUBLIC_APP_URL = 'https://agnostr.com/'

export function getShareBaseHref(): string {
  if (isNativeAppBuild || typeof window === 'undefined') return PUBLIC_APP_URL
  return `${window.location.origin}${window.location.pathname}`
}
