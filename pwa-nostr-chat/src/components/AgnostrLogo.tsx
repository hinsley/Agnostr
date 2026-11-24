import React, { useId } from 'react'

export interface AgnostrLogoProps {
  /** Width and height in pixels. Defaults to 20. */
  size?: number
  /**
   * 'mark' renders the theme-adaptive 2-shape geometric A (arch in currentColor, floating pill in var(--accent)).
   * 'badge' renders the full obsidian squircle app icon matching /icon.svg.
   */
  variant?: 'mark' | 'badge'
  className?: string
  /** Optional accessible label. When omitted, the SVG is marked aria-hidden="true". */
  ariaLabel?: string
}

const ARCH_MARK_PATH =
  'M4.32 28.33Q3.12 28.33 3.64 27.25L14.23 5.47Q16 1.83 17.77 5.47L28.36 27.25Q28.88 28.33 27.68 28.33L24.28 28.33Q23.73 28.33 23.49 27.83L16.6 13.67Q16 12.43 15.4 13.67L8.51 27.83Q8.27 28.33 7.72 28.33Z'

const ARCH_BADGE_PATH =
  'M129 386Q116 386 121.7 374.3L236.8 137.6Q256 98 275.2 137.6L390.3 374.3Q396 386 383 386L346 386Q340 386 337.4 380.6L262.6 226.7Q256 213.2 249.4 226.7L174.6 380.6Q172 386 166 386Z'

export const AgnostrLogo: React.FC<AgnostrLogoProps> = ({
  size = 20,
  variant = 'mark',
  className,
  ariaLabel,
}) => {
  const uid = useId()
  const a11yProps = ariaLabel
    ? { role: 'img' as const, 'aria-label': ariaLabel }
    : { 'aria-hidden': true as const }

  if (variant === 'badge') {
    const bgId = `${uid}-bg`
    const dpId = `${uid}-dp`
    const arId = `${uid}-ar`
    const plId = `${uid}-pl`

    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        width={size}
        height={size}
        className={className}
        focusable="false"
        {...a11yProps}
      >
        <defs>
          <linearGradient id={bgId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#161b26" />
            <stop offset=".52" stopColor="#0c0f16" />
            <stop offset="1" stopColor="#07090d" />
          </linearGradient>
          <radialGradient id={dpId} cx=".5" cy=".16" r=".64">
            <stop offset="0" stopColor="#3b82f6" stopOpacity=".11" />
            <stop offset=".58" stopColor="#3b82f6" stopOpacity=".025" />
            <stop offset="1" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={arId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#e2ecfa" />
          </linearGradient>
          <linearGradient id={plId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#60a5fa" />
            <stop offset=".52" stopColor="#3b82f6" />
            <stop offset="1" stopColor="#6366f1" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="7.25" fill={`url(#${bgId})`} />
        <rect width="32" height="32" rx="7.25" fill={`url(#${dpId})`} />
        <g transform="scale(0.0625)">
          <path d={ARCH_BADGE_PATH} fill={`url(#${arId})`} />
          <rect x="214" y="328" width="84" height="36" rx="18" fill={`url(#${plId})`} />
        </g>
      </svg>
    )
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      focusable="false"
      {...a11yProps}
    >
      <path d={ARCH_MARK_PATH} fill="currentColor" />
      <rect x="12.14" y="22.99" width="7.73" height="3.31" rx="1.66" fill="var(--accent)" />
    </svg>
  )
}

export default AgnostrLogo
