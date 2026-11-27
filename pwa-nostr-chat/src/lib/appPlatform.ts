export const isNativeAndroidBuild = import.meta.env?.MODE === 'android'
export const PUBLIC_APP_URL = 'https://agnostr.com/'

export function getShareBaseHref(): string {
  if (isNativeAndroidBuild || typeof window === 'undefined') return PUBLIC_APP_URL
  return `${window.location.origin}${window.location.pathname}`
}
