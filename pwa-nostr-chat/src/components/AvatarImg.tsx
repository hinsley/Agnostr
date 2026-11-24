import React, { useMemo, useState } from 'react'
import { identiconDataUrl } from '../utils/identicon.ts'

export interface AvatarImgProps {
  pubkey: string
  pictureUrl?: string | null
  alt?: string
  className?: string
  width?: number
  height?: number
  loading?: 'lazy' | 'eager'
  style?: React.CSSProperties
}

function sanitizeHttpsPictureUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || !/^https:\/\//i.test(trimmed)) return null
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export const AvatarImg: React.FC<AvatarImgProps> = ({
  pubkey,
  pictureUrl,
  alt,
  className,
  width,
  height,
  loading,
  style,
}) => {
  const validPictureUrl = useMemo(() => sanitizeHttpsPictureUrl(pictureUrl), [pictureUrl])
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const fallbackSrc = useMemo(() => identiconDataUrl(pubkey || 'anon'), [pubkey])

  const useRemote = Boolean(validPictureUrl && failedUrl !== validPictureUrl)
  const src = useRemote && validPictureUrl ? validPictureUrl : fallbackSrc

  return (
    <img
      src={src}
      alt={alt ?? ''}
      width={width}
      height={height}
      loading={loading ?? 'lazy'}
      decoding="async"
      referrerPolicy="no-referrer"
      className={className}
      style={{ objectFit: 'cover', ...style }}
      onError={() => {
        if (useRemote && validPictureUrl) {
          setFailedUrl(validPictureUrl)
        }
      }}
    />
  )
}
