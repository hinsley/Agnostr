import { useCallback, useRef, useState } from 'react'
import type { ToastItem, ToastLevel } from '../types/protocol.ts'

const MAX_TOASTS = 4
const TOAST_TTL_MS = 4500

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timersRef = useRef<Map<string, number>>(new Map())

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const pushToast = useCallback(
    (level: ToastLevel, title: string, detail?: string) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const item: ToastItem = {
        id,
        level,
        title,
        detail,
        createdAt: Date.now(),
      }
      setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), item])
      const timer = window.setTimeout(() => {
        timersRef.current.delete(id)
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, TOAST_TTL_MS)
      timersRef.current.set(id, timer)
    },
    []
  )

  const clearToasts = useCallback(() => {
    for (const timer of timersRef.current.values()) {
      window.clearTimeout(timer)
    }
    timersRef.current.clear()
    setToasts([])
  }, [])

  return { toasts, pushToast, dismissToast, clearToasts }
}
