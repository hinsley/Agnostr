import React from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import type { ToastItem } from '../types/protocol'

export interface ToastStackProps {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}

const iconForLevel = (level: ToastItem['level']) => {
  switch (level) {
    case 'success':
      return <CheckCircle2 size={16} />
    case 'warning':
      return <AlertTriangle size={16} />
    case 'error':
      return <AlertCircle size={16} />
    default:
      return <Info size={16} />
  }
}

export const ToastStack: React.FC<ToastStackProps> = ({ toasts, onDismiss }) => {
  if (!toasts.length) return null

  return (
    <div className="ag-toast-stack" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`ag-toast ${toast.level}`} role="status">
          <span className="ag-toast-icon" aria-hidden="true">
            {iconForLevel(toast.level)}
          </span>
          <div className="ag-toast-body">
            <div className="ag-toast-title">{toast.title}</div>
            {toast.detail && <div className="ag-toast-detail">{toast.detail}</div>}
          </div>
          <button
            type="button"
            className="ag-icon-btn"
            style={{ height: 24, minWidth: 24 }}
            aria-label="Dismiss notification"
            onClick={() => onDismiss(toast.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

export default ToastStack
