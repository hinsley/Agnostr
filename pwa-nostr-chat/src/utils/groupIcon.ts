/**
 * Sanitizes an optional manual Group 2-letter specifier to 0..2 uppercase ASCII
 * alphanumeric characters (`[A-Za-z0-9]`), stripping emojis and punctuation.
 */
export function sanitizeGroupSpecifier(raw?: string | null): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
}

/**
 * Resolves the 1-2 character uppercase alphanumeric Group specifier shown when
 * no uploaded HTTPS picture icon is set. Never returns emojis.
 */
export function getGroupSpecifier(name: string, icon?: string | null): string {
  const custom = sanitizeGroupSpecifier(icon)
  if (custom) return custom

  const words = (typeof name === 'string' ? name : '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)

  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase()
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase()
  }
  return 'GR'
}

/**
 * Returns true if the supplied group picture is a valid HTTPS image URL.
 */
export function hasUploadedGroupPicture(picture?: string | null): boolean {
  if (typeof picture !== 'string') return false
  const trimmed = picture.trim()
  if (!trimmed || !/^https:\/\//i.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}
