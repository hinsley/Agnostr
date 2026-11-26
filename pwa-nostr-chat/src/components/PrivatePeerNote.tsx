import { StickyNote } from 'lucide-react'

export function PrivatePeerNote({ note }: { note?: string }) {
  if (!note) return null
  return (
    <span className="ag-person-note-line" title={note}>
      <StickyNote size={11} aria-hidden="true" />
      <span className="sr-only">Private note: </span>
      <span className="truncate">{note}</span>
    </span>
  )
}
