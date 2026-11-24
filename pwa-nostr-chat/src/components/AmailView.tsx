import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowUpDown,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  File,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  FolderInput,
  FolderPlus,
  Forward,
  HardDrive,
  Image as ImageIcon,
  Inbox,
  Loader2,
  Lock,
  Mail,
  MailOpen,
  Mic,
  Paperclip,
  Pencil,
  PenSquare,
  Plus,
  QrCode,
  RefreshCw,
  Reply,
  ReplyAll,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Star,
  Trash2,
  UserPlus,
  Users,
  Waves,
  X,
} from 'lucide-react'
import type {
  AgnostrEngine,
  ImageAttachment,
  RecordedVoiceMemo,
  VoiceMemoAttachment,
} from '../types/protocol.ts'
import {
  MAX_AMAIL_ATTACHMENTS,
  type AmailAttachment,
  type AmailAttachmentKind,
  type AmailBuiltinFolder,
  type AmailContact,
  type AmailCustomFolder,
  type AmailDeliveryStatus,
  type AmailFolder,
  type AmailFolderSortMode,
  type AmailMessage,
  type AmailRecipient,
} from '../types/amail.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { encodeNpubSafe } from '../lib/identity.ts'
import { parseShareTarget } from '../lib/shareLinks.ts'
import {
  VoiceRecorderController,
  formatVoiceDuration,
  isVoiceRecordingSupported,
  revokeVoicePreviewUrl,
} from '../lib/voiceRecorder.ts'
import { RichMessageContent } from '../utils/markdown.tsx'
import { identiconDataUrl, pubkeyToColor, shortPubkey } from '../utils/identicon.ts'
import type { SoundCue } from '../utils/sound.ts'
import { useContextMenu, type ContextMenuItem } from './ContextMenu.tsx'
import { ImageAttachmentCard } from './ImageAttachmentCard.tsx'
import type { LightboxImagePayload } from './ImageLightboxModal.tsx'
import { VoiceMemoPlayer } from './VoiceMemoPlayer.tsx'
import '../styles/amail.css'

export type AmailInitialSection = 'inbox' | 'compose' | 'contacts' | 'mesh'

export interface AmailComposeTarget {
  pubkey: string
  nickname?: string
}

export interface AmailViewProps {
  open: boolean
  embedded?: boolean
  inShell?: boolean
  onClose: () => void
  engine: AgnostrEngine
  initialSection?: AmailInitialSection
  initialComposeTo?: AmailComposeTarget | null
  onOpenScanner?: () => void
  onOpenLightbox?: (payload: LightboxImagePayload) => void
  onPlaySound?: (cue: SoundCue) => void
}

type AmailNavSection = AmailFolder | 'contacts' | 'mesh'
type RecipientField = 'to' | 'cc' | 'bcc'

interface AmailTooltipState {
  text: string
  anchorTop: number
  anchorBottom: number
  anchorCenterX: number
}

interface FolderPickerState {
  pickerKey: string
  targetIds: string[]
  currentFolder: AmailFolder
  anchorTop: number
  anchorBottom: number
  anchorLeft: number
  anchorRight: number
  closeReaderOnMove: boolean
}

interface MailThreadListItem {
  key: string
  isDraft: boolean
  sectionMessages: AmailMessage[]
  conversationMessages: AmailMessage[]
  primaryMsg: AmailMessage
  latestMsg: AmailMessage
  latestSentAt: number
  messageCount: number
  isUnread: boolean
  isStarred: boolean
  displaySubject: string
}

interface AutocompleteCandidate {
  pubkey: string
  npub: string
  nickname: string
  displayLabel: string
  subLabel: string
  isSelf?: boolean
  isTrustedPeer?: boolean
}

interface ComposerInitOpts {
  to?: AmailComposeTarget | null
  toList?: AmailRecipient[]
  ccList?: AmailRecipient[]
  bccList?: AmailRecipient[]
  subject?: string
  body?: string
  attachments?: AmailAttachment[]
  draftId?: string
  threadId?: string
  inReplyTo?: string
  requestReadReceipt?: boolean
  ttlSec?: number
}

interface UploadingAttachmentItem {
  tempId: string
  name: string
  kind: AmailAttachmentKind
  error?: string
}

interface FileDownloadState {
  loading: boolean
  error?: string
}

const BUILTIN_FOLDER_LABELS: Record<AmailBuiltinFolder, string> = {
  inbox: 'Inbox',
  starred: 'Starred',
  sent: 'Sent',
  drafts: 'Drafts',
  archive: 'Archive',
  trash: 'Trash',
}

const BUILTIN_FOLDER_SET = new Set<string>([
  'inbox',
  'starred',
  'sent',
  'drafts',
  'archive',
  'trash',
])

const VAULT_SIZE_OPTIONS: readonly { bytes: number; label: string }[] = [
  { bytes: 5 * 1024 * 1024, label: '5 MB' },
  { bytes: 10 * 1024 * 1024, label: '10 MB' },
  { bytes: 25 * 1024 * 1024, label: '25 MB' },
  { bytes: 50 * 1024 * 1024, label: '50 MB' },
]

const TTL_OPTIONS: readonly { sec: number; label: string }[] = [
  { sec: 24 * 3600, label: '24h' },
  { sec: 3 * 86_400, label: '3d' },
  { sec: 7 * 86_400, label: '7d' },
]

const MAX_HOPS_OPTIONS: readonly number[] = [3, 4, 5, 6, 7, 8]

function formatBytes(bytes: number): string {
  const safe = Math.max(0, Number.isFinite(bytes) ? bytes : 0)
  if (safe < 1024) return `${Math.round(safe)} B`
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(safe < 10_240 ? 1 : 0)} KB`
  return `${(safe / (1024 * 1024)).toFixed(1)} MB`
}

function formatMailTimestamp(unixSec: number): string {
  if (!unixSec) return ''
  const date = new Date(unixSec * 1000)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  const sameYear = date.getFullYear() === now.getFullYear()
  if (sameYear) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' })
}

function formatFullDateTime(unixSec: number): string {
  if (!unixSec) return ''
  try {
    return new Date(unixSec * 1000).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function formatTtlRemaining(expiresAtSec: number): string {
  const diff = Math.max(0, expiresAtSec - Math.floor(Date.now() / 1000))
  if (diff <= 0) return 'Expired'
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
  const days = Math.floor(diff / 86_400)
  const hrs = Math.floor((diff % 86_400) / 3600)
  return hrs > 0 ? `${days}d ${hrs}h` : `${days}d`
}

function buildBodySnippet(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\$\$[\s\S]*?\$\$/g, '[math]')
    .replace(/[#*_`~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
}

function resolvePubkeyInput(raw: string): { pubkey: string; npub: string; nickname?: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = parseShareTarget(trimmed)
  if (parsed?.kind === 'dm') {
    return {
      pubkey: parsed.pubkey.toLowerCase(),
      npub: parsed.npub,
      nickname: parsed.nickname,
    }
  }
  return null
}

function baseMailId(id: string): string {
  return id.endsWith(':self') ? id.slice(0, -5) : id
}

function formatThreadSubject(rawSubject: string): string {
  const trimmed = rawSubject.trim()
  if (!trimmed) return '(no subject)'
  return trimmed.replace(/^(re:\s*){2,}/i, 'Re: ')
}

function sanitizeDisplayFilename(raw: string | undefined, mime?: string): string {
  const cleaned = (raw ?? '')
    .replace(/[/\\]/g, '_')
    .replace(/[\p{Cc}]/gu, '')
    .trim()
    .slice(0, 120)
  if (cleaned) return cleaned
  const lower = (mime ?? '').toLowerCase()
  if (lower.startsWith('image/')) return 'image'
  if (lower.startsWith('audio/')) return 'audio-clip'
  if (lower.startsWith('video/')) return 'video-clip'
  if (lower === 'application/pdf') return 'document.pdf'
  return 'attachment'
}

function getFileIconKind(mime: string, name?: string): 'text' | 'audio' | 'video' | 'file' {
  const lowerMime = (mime || '').toLowerCase()
  const lowerName = (name || '').toLowerCase()
  if (lowerMime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(lowerName)) {
    return 'audio'
  }
  if (lowerMime.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/.test(lowerName)) {
    return 'video'
  }
  if (
    lowerMime.startsWith('text/') ||
    lowerMime === 'application/pdf' ||
    lowerMime === 'application/json' ||
    /\.(pdf|txt|md|csv|json|xml|doc|docx|rtf|log)$/.test(lowerName)
  ) {
    return 'text'
  }
  return 'file'
}

function scalePeaksToWaveform100(peaks: readonly number[] | undefined): number[] {
  if (!peaks || peaks.length === 0) return []
  return peaks.map((p) => {
    const safe = Number.isFinite(p) ? p : 0
    return safe <= 1 ? Math.round(safe * 100) : Math.round(safe)
  })
}

function adaptAmailImageAttachment(att: AmailAttachment): ImageAttachment {
  return {
    url: att.url,
    sha256: att.sha256,
    mime: att.mime,
    size: att.size,
    width: att.width ?? 0,
    height: att.height ?? 0,
    alt: att.name,
    encryption: att.encryption,
  }
}

function adaptAmailVoiceAttachment(att: AmailAttachment): VoiceMemoAttachment {
  return {
    url: att.url,
    sha256: att.sha256,
    mime: att.mime,
    size: att.size,
    durationSec: att.durationSec ?? 0,
    waveform: scalePeaksToWaveform100(att.peaks),
    encryption: att.encryption,
  }
}

function matchesMailQuery(m: AmailMessage, q: string): boolean {
  const recipMatch = [
    ...(m.toRecipients ?? []),
    ...(m.ccRecipients ?? []),
    ...(m.bccRecipients ?? []),
  ].some(
    (r) =>
      r.nickname.toLowerCase().includes(q) ||
      r.npub.toLowerCase().includes(q) ||
      r.pubkey.toLowerCase().includes(q),
  )
  const attachMatch = (m.attachments ?? []).some((a) =>
    (a.name ?? '').toLowerCase().includes(q),
  )
  return (
    m.subject.toLowerCase().includes(q) ||
    m.body.toLowerCase().includes(q) ||
    m.fromName.toLowerCase().includes(q) ||
    m.toName.toLowerCase().includes(q) ||
    m.fromNpub.toLowerCase().includes(q) ||
    m.toNpub.toLowerCase().includes(q) ||
    recipMatch ||
    attachMatch
  )
}

function buildCanonicalThreadMap(messages: readonly AmailMessage[]): Map<string, string> {
  const parent = new Map<string, string>()

  const find = (x: string): string => {
    let root = x
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!
    }
    let curr = x
    while (parent.has(curr) && parent.get(curr) !== root) {
      const next = parent.get(curr)!
      parent.set(curr, root)
      curr = next
    }
    if (!parent.has(root)) parent.set(root, root)
    return root
  }

  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) {
      if (ra < rb) parent.set(rb, ra)
      else parent.set(ra, rb)
    }
  }

  const nonDrafts = messages.filter((m) => m.folder !== 'drafts')
  for (const m of nonDrafts) {
    const baseKey = `m:${baseMailId(m.id)}`
    find(baseKey)
    const tid = m.threadId?.trim()
    if (tid) {
      union(baseKey, `t:${tid}`)
    }
    const replyTo = m.inReplyTo?.trim()
    if (replyTo) {
      union(baseKey, `m:${baseMailId(replyTo)}`)
    }
  }

  const map = new Map<string, string>()
  for (const m of nonDrafts) {
    map.set(m.id, find(`m:${baseMailId(m.id)}`))
  }
  return map
}

function dedupeThreadMessages(
  msgs: readonly AmailMessage[],
  preferOut: boolean,
  preferredId?: string | null,
): AmailMessage[] {
  const byBaseId = new Map<string, AmailMessage>()
  for (const m of msgs) {
    const bId = baseMailId(m.id)
    const prev = byBaseId.get(bId)
    if (!prev) {
      byBaseId.set(bId, m)
      continue
    }
    if (preferredId && m.id === preferredId) {
      byBaseId.set(bId, m)
    } else if (!preferredId || prev.id !== preferredId) {
      if (preferOut && m.direction === 'out') {
        byBaseId.set(bId, m)
      } else if (!preferOut && m.direction === 'in') {
        byBaseId.set(bId, m)
      }
    }
  }
  return [...byBaseId.values()].sort((a, b) => {
    if (a.sentAt !== b.sentAt) return a.sentAt - b.sentAt
    if (b.inReplyTo && baseMailId(b.inReplyTo) === baseMailId(a.id)) return -1
    if (a.inReplyTo && baseMailId(a.inReplyTo) === baseMailId(b.id)) return 1
    return a.updatedAt - b.updatedAt
  })
}

function getMessageToList(msg: AmailMessage): AmailRecipient[] {
  if (msg.toRecipients && msg.toRecipients.length > 0) {
    return msg.toRecipients
  }
  if (msg.toPubkey) {
    return [
      {
        pubkey: msg.toPubkey.toLowerCase(),
        npub: msg.toNpub || encodeNpubSafe(msg.toPubkey),
        nickname: msg.toName || shortPubkey(msg.toPubkey, 6, 4),
      },
    ]
  }
  return []
}

function formatDeliveryMeta(msg: AmailMessage): {
  label: string
  tone: 'muted' | 'accent' | 'danger'
} {
  if (msg.direction === 'in') {
    if (msg.relayHopCount > 0) {
      return {
        label: `Encrypted · ${msg.relayHopCount} ${msg.relayHopCount === 1 ? 'hop' : 'hops'}`,
        tone: 'muted',
      }
    }
    return { label: 'Encrypted', tone: 'muted' }
  }
  switch (msg.deliveryStatus) {
    case 'read':
      return {
        label: msg.readAt ? `Read · ${formatMailTimestamp(msg.readAt)}` : 'Read',
        tone: 'accent',
      }
    case 'delivered':
      return {
        label: msg.deliveredAt
          ? `Delivered · ${formatMailTimestamp(msg.deliveredAt)}`
          : 'Delivered',
        tone: 'accent',
      }
    case 'relayed':
      return {
        label:
          msg.relayedPeerCount > 0
            ? `Relayed · ${msg.relayedPeerCount} ${msg.relayedPeerCount === 1 ? 'peer' : 'peers'}`
            : 'Relayed',
        tone: 'muted',
      }
    case 'expired':
      return { label: 'Expired', tone: 'danger' }
    case 'draft':
      return { label: 'Draft', tone: 'muted' }
    case 'queued':
    default:
      return { label: 'Queued', tone: 'muted' }
  }
}

function renderStatusIcon(status: AmailDeliveryStatus) {
  switch (status) {
    case 'read':
      return (
        <span className="ag-amail-receipt read" aria-label="Read">
          <CheckCheck size={13} />
        </span>
      )
    case 'delivered':
      return (
        <span className="ag-amail-receipt delivered" aria-label="Delivered">
          <Check size={13} />
        </span>
      )
    case 'relayed':
      return (
        <span className="ag-amail-receipt relayed" aria-label="Relayed">
          <Waves size={12} />
        </span>
      )
    case 'expired':
      return (
        <span className="ag-amail-receipt expired" aria-label="Expired">
          <AlertCircle size={12} />
        </span>
      )
    case 'draft':
      return <span className="ag-amail-draft-tag">Draft</span>
    case 'queued':
    default:
      return (
        <span className="ag-amail-receipt queued" aria-label="Queued">
          <Clock size={12} />
        </span>
      )
  }
}

function getSortModeShortLabel(mode: AmailFolderSortMode): string {
  if (mode === 'az') return 'A–Z'
  if (mode === 'za') return 'Z–A'
  return 'Manual'
}

export function AmailView({
  open,
  embedded = false,
  inShell = false,
  onClose,
  engine,
  initialSection = 'inbox',
  initialComposeTo = null,
  onOpenScanner,
  onOpenLightbox,
  onPlaySound,
}: AmailViewProps) {
  const { amail } = engine
  const { openContextMenu } = useContextMenu()

  const myPubkey = engine.identity.masterPubkey.toLowerCase()
  const myNpub = engine.identity.masterNpub || encodeNpubSafe(myPubkey)
  const myNickname = engine.identity.nickname?.trim() || 'Me'

  const [section, setSection] = useState<AmailNavSection>('inbox')
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Portal tooltip state (unclipped, viewport-clamped, zero OS title overlap)
  const [tooltip, setTooltip] = useState<AmailTooltipState | null>(null)
  const [tooltipCoords, setTooltipCoords] = useState<{
    left: number
    top: number
    placement: 'above' | 'below'
  } | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)

  // Portal Move-to-Folder popover state
  const [folderPicker, setFolderPicker] = useState<FolderPickerState | null>(null)
  const [folderPickerCoords, setFolderPickerCoords] = useState<{
    left: number
    top: number
  } | null>(null)
  const folderPickerRef = useRef<HTMLDivElement | null>(null)

  // Custom folder CRUD / reorder state
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameFolderDraft, setRenameFolderDraft] = useState('')
  const [armedDeleteFolderId, setArmedDeleteFolderId] = useState<string | null>(null)
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const newFolderInputRef = useRef<HTMLInputElement | null>(null)
  const renameFolderInputRef = useRef<HTMLInputElement | null>(null)

  // Multi-recipient compose state (To / CC / BCC)
  const [composing, setComposing] = useState(false)
  const [composeDraftId, setComposeDraftId] = useState<string | undefined>(undefined)
  const [composeThreadId, setComposeThreadId] = useState<string | undefined>(undefined)
  const [composeInReplyTo, setComposeInReplyTo] = useState<string | undefined>(undefined)
  const [toRecipients, setToRecipients] = useState<AmailRecipient[]>([])
  const [ccRecipients, setCcRecipients] = useState<AmailRecipient[]>([])
  const [bccRecipients, setBccRecipients] = useState<AmailRecipient[]>([])
  const [toInput, setToInput] = useState('')
  const [ccInput, setCcInput] = useState('')
  const [bccInput, setBccInput] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [activeRecipientField, setActiveRecipientField] = useState<RecipientField | null>(null)
  const [acHighlightIdx, setAcHighlightIdx] = useState(0)
  const [subjectDraft, setSubjectDraft] = useState('')
  const [bodyDraft, setBodyDraft] = useState('')
  const [composeTab, setComposeTab] = useState<'write' | 'preview'>('write')
  const [requestReceipt, setRequestReceipt] = useState(true)
  const [composeTtlSec, setComposeTtlSec] = useState(amail.settings.defaultTtlSec)
  const [sendingMail, setSendingMail] = useState(false)
  const [composeError, setComposeError] = useState<string | null>(null)

  // Compose E2EE Attachments & Live Voicemail Recorder state
  const [composeAttachments, setComposeAttachments] = useState<AmailAttachment[]>([])
  const [uploadingItems, setUploadingItems] = useState<UploadingAttachmentItem[]>([])
  const [composeLocalPreviews, setComposeLocalPreviews] = useState<Record<string, string>>({})
  const [composeDragOver, setComposeDragOver] = useState(false)
  const [isRecordingVoice, setIsRecordingVoice] = useState(false)
  const [voiceElapsedSec, setVoiceElapsedSec] = useState(0)
  const [voiceLiveBars, setVoiceLiveBars] = useState<number[]>([])
  const [fileDownloads, setFileDownloads] = useState<Record<string, FileDownloadState>>({})

  const composeImageInputRef = useRef<HTMLInputElement | null>(null)
  const composeFileInputRef = useRef<HTMLInputElement | null>(null)
  const composeDragDepthRef = useRef(0)
  const voiceRecorderRef = useRef<VoiceRecorderController | null>(null)
  const composeLocalPreviewsRef = useRef<Record<string, string>>({})
  const attachmentUrlCacheRef = useRef<Map<string, string>>(new Map())

  // Contacts add form state
  const [contactKeyDraft, setContactKeyDraft] = useState('')
  const [contactNickDraft, setContactNickDraft] = useState('')
  const [contactNoteDraft, setContactNoteDraft] = useState('')
  const [contactFeedback, setContactFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  // Mesh vault purge 2-tap confirm
  const [confirmPurgeVault, setConfirmPurgeVault] = useState(false)
  const [meshFeedback, setMeshFeedback] = useState<string | null>(null)

  const recipLinesWrapRef = useRef<HTMLDivElement | null>(null)
  const openFreshComposerRef = useRef<((opts?: ComposerInitOpts) => void) | null>(null)

  const hideTooltip = useCallback(() => {
    setTooltip(null)
    setTooltipCoords(null)
  }, [])

  const showTooltip = useCallback(
    (e: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>, text: string) => {
      if (!text) return
      const rect = e.currentTarget.getBoundingClientRect()
      const anchorCenterX = rect.left + rect.width / 2
      const placement: 'above' | 'below' = rect.top < 46 ? 'below' : 'above'
      const approxW = Math.min(260, Math.max(64, text.length * 6.8 + 20))
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
      const clampedLeft = Math.max(10, Math.min(vw - approxW - 10, anchorCenterX - approxW / 2))
      setTooltipCoords({
        left: clampedLeft,
        top: placement === 'below' ? rect.bottom + 8 : rect.top - 8,
        placement,
      })
      setTooltip({
        text,
        anchorTop: rect.top,
        anchorBottom: rect.bottom,
        anchorCenterX,
      })
    },
    [],
  )

  const tipProps = useCallback(
    (text: string) => ({
      onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => showTooltip(e, text),
      onMouseLeave: hideTooltip,
      onFocus: (e: ReactFocusEvent<HTMLElement>) => showTooltip(e, text),
      onBlur: hideTooltip,
      onPointerDown: hideTooltip,
    }),
    [showTooltip, hideTooltip],
  )

  // Precise post-paint viewport clamp for portal tooltip
  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return
    const box = tooltipRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let placement: 'above' | 'below' = tooltip.anchorTop - box.height - 10 < 10 ? 'below' : 'above'
    let top = placement === 'below' ? tooltip.anchorBottom + 8 : tooltip.anchorTop - 8
    if (placement === 'below' && top + box.height > vh - 10) {
      placement = 'above'
      top = Math.max(10 + box.height, tooltip.anchorTop - 8)
    }
    const left = Math.max(10, Math.min(vw - box.width - 10, tooltip.anchorCenterX - box.width / 2))
    setTooltipCoords({ left, top, placement })
  }, [tooltip])

  // Hide tooltip immediately on any scroll or key press
  useEffect(() => {
    if (!tooltip) return
    const dismiss = () => {
      setTooltip(null)
      setTooltipCoords(null)
    }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('keydown', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('keydown', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [tooltip])

  // Clear transient overlays when view changes
  useEffect(() => {
    hideTooltip()
    setFolderPicker(null)
  }, [open, section, selectedMessageId, composing, hideTooltip])

  // Precise viewport clamp for Move-to-Folder popover
  useLayoutEffect(() => {
    if (!folderPicker) {
      setFolderPickerCoords(null)
      return
    }
    const vw = window.innerWidth
    const vh = window.innerHeight
    const box = folderPickerRef.current?.getBoundingClientRect()
    const w = box?.width || 206
    const h = box?.height || 220
    let left = folderPicker.anchorRight - w
    if (left < 10) left = Math.min(vw - w - 10, Math.max(10, folderPicker.anchorLeft))
    left = Math.max(10, Math.min(vw - w - 10, left))
    let top = folderPicker.anchorBottom + 6
    if (top + h > vh - 10) {
      top = Math.max(10, folderPicker.anchorTop - h - 6)
    }
    setFolderPickerCoords({ left, top })
  }, [folderPicker])

  // Close Move-to-Folder popover on outside pointerdown or scroll
  useEffect(() => {
    if (!folderPicker) return
    const onPointerDown = (e: PointerEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setFolderPicker(null)
      }
    }
    const onScroll = (e: Event) => {
      if (folderPickerRef.current && folderPickerRef.current.contains(e.target as Node)) return
      setFolderPicker(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [folderPicker])

  // Focus inline folder inputs cleanly when opened
  useEffect(() => {
    if (!creatingFolder) return
    const raf = window.requestAnimationFrame(() => newFolderInputRef.current?.focus())
    return () => window.cancelAnimationFrame(raf)
  }, [creatingFolder])

  useEffect(() => {
    if (!renamingFolderId) return
    const raf = window.requestAnimationFrame(() => {
      renameFolderInputRef.current?.focus()
      renameFolderInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [renamingFolderId])

  // Auto-disarm folder delete confirmation after 3.2s
  useEffect(() => {
    if (!armedDeleteFolderId) return
    const t = window.setTimeout(() => setArmedDeleteFolderId(null), 3200)
    return () => window.clearTimeout(t)
  }, [armedDeleteFolderId])

  // Sort custom folders consistently with amail.folderSortMode
  const displayedCustomFolders = useMemo<AmailCustomFolder[]>(() => {
    const list = [...amail.customFolders]
    if (amail.folderSortMode === 'az') {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    } else if (amail.folderSortMode === 'za') {
      list.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: 'base' }))
    } else {
      list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    }
    return list
  }, [amail.customFolders, amail.folderSortMode])

  // If currently viewing a custom folder that was deleted (e.g. via sync), fall back cleanly to Inbox
  useEffect(() => {
    if (section === 'contacts' || section === 'mesh' || BUILTIN_FOLDER_SET.has(section)) return
    const exists = amail.customFolders.some((f) => f.id === section)
    if (!exists) {
      setSection('inbox')
      setSelectedMessageId(null)
    }
  }, [section, amail.customFolders])

  // Merge Agmail contacts + Trusted Peers for autocomplete & contacts directory
  const mergedContacts = useMemo<AmailContact[]>(() => {
    const byPubkey = new Map<string, AmailContact>()
    for (const c of amail.contacts) {
      byPubkey.set(c.pubkey.toLowerCase(), c)
    }
    for (const t of engine.trustedPubkeys) {
      const pk = t.pubkey.toLowerCase()
      const existing = byPubkey.get(pk)
      if (existing) {
        if (!existing.isTrustedPeer) {
          byPubkey.set(pk, { ...existing, isTrustedPeer: true })
        }
      } else {
        byPubkey.set(pk, {
          pubkey: pk,
          npub: t.npub || encodeNpubSafe(pk),
          nickname: t.label || shortPubkey(pk, 8, 6),
          addedAt: t.addedAt,
          isTrustedPeer: true,
        })
      }
    }
    return [...byPubkey.values()].sort((a, b) => a.nickname.localeCompare(b.nickname))
  }, [amail.contacts, engine.trustedPubkeys])

  const resolveRecipientInfo = useCallback(
    (pubkey: string, nicknameHint?: string): AmailRecipient => {
      const pk = pubkey.toLowerCase()
      if (pk === myPubkey) {
        return { pubkey: pk, npub: myNpub, nickname: 'You (Self)' }
      }
      const known = mergedContacts.find((c) => c.pubkey.toLowerCase() === pk)
      return {
        pubkey: pk,
        npub: known?.npub || encodeNpubSafe(pk),
        nickname: nicknameHint?.trim() || known?.nickname || shortPubkey(pk, 8, 6),
      }
    },
    [mergedContacts, myPubkey, myNpub],
  )

  const revokeAllComposePreviews = useCallback(() => {
    const map = composeLocalPreviewsRef.current
    for (const url of Object.values(map)) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Ignore
      }
    }
    composeLocalPreviewsRef.current = {}
    setComposeLocalPreviews({})
  }, [])

  const stopAndDiscardVoiceRecorder = useCallback(() => {
    if (voiceRecorderRef.current) {
      voiceRecorderRef.current.cancel()
      voiceRecorderRef.current = null
    }
    setIsRecordingVoice(false)
    setVoiceElapsedSec(0)
    setVoiceLiveBars([])
  }, [])

  // Cleanup active voice recorder & object URLs on unmount
  useEffect(() => {
    const urlCache = attachmentUrlCacheRef.current
    return () => {
      if (voiceRecorderRef.current) {
        voiceRecorderRef.current.cancel()
        voiceRecorderRef.current = null
      }
      for (const url of Object.values(composeLocalPreviewsRef.current)) {
        try {
          URL.revokeObjectURL(url)
        } catch {
          // Ignore
        }
      }
      composeLocalPreviewsRef.current = {}
      for (const url of urlCache.values()) {
        try {
          URL.revokeObjectURL(url)
        } catch {
          // Ignore
        }
      }
      urlCache.clear()
    }
  }, [])

  // Stop any live voicemail recording if composer closes or Agmail closes
  useEffect(() => {
    if (!open || !composing) {
      stopAndDiscardVoiceRecorder()
      composeDragDepthRef.current = 0
      setComposeDragOver(false)
    }
  }, [open, composing, stopAndDiscardVoiceRecorder])

  const fetchAmailImageUrl = useCallback(
    async (image: ImageAttachment): Promise<string> => {
      const cacheKey = image.sha256 || image.url
      const cached = attachmentUrlCacheRef.current.get(cacheKey)
      if (cached) return cached
      if (!image.encryption) {
        throw new Error('Missing encryption metadata for Agmail image attachment.')
      }
      const att: AmailAttachment = {
        id: cacheKey,
        kind: 'image',
        url: image.url,
        sha256: image.sha256,
        mime: image.mime,
        size: image.size,
        name: image.alt,
        width: image.width,
        height: image.height,
        encryption: image.encryption,
      }
      const blob = await amail.downloadAttachment(att)
      const objUrl = URL.createObjectURL(blob)
      attachmentUrlCacheRef.current.set(cacheKey, objUrl)
      return objUrl
    },
    [amail],
  )

  const fetchAmailVoiceUrl = useCallback(
    async (memo: VoiceMemoAttachment): Promise<string> => {
      const cacheKey = memo.sha256 || memo.url
      const cached = attachmentUrlCacheRef.current.get(cacheKey)
      if (cached) return cached
      if (!memo.encryption) {
        throw new Error('Missing encryption metadata for Agmail voicemail attachment.')
      }
      const att: AmailAttachment = {
        id: cacheKey,
        kind: 'voice',
        url: memo.url,
        sha256: memo.sha256,
        mime: memo.mime,
        size: memo.size,
        durationSec: memo.durationSec,
        encryption: memo.encryption,
      }
      const blob = await amail.downloadAttachment(att)
      const objUrl = URL.createObjectURL(blob)
      attachmentUrlCacheRef.current.set(cacheKey, objUrl)
      return objUrl
    },
    [amail],
  )

  const handleOpenAmailLightbox = useCallback(
    (payload: LightboxImagePayload) => {
      onOpenLightbox?.(payload)
    },
    [onOpenLightbox],
  )

  const handleTrustAttachmentSender = useCallback(
    (pubkey: string, nickname: string) => {
      engine.trustPubkey(pubkey, nickname)
      onPlaySound?.('click')
    },
    [engine, onPlaySound],
  )

  const handleBlockAttachmentSender = useCallback(
    (pubkey: string, displayHandle: string) => {
      engine.toggleBlockPeer(pubkey, displayHandle)
      onPlaySound?.('click')
    },
    [engine, onPlaySound],
  )

  const handleInspectAttachmentSender = useCallback(
    (pubkey: string, nickname: string) => {
      const npub = encodeNpubSafe(pubkey)
      void navigator.clipboard
        .writeText(npub)
        .then(() => {
          onPlaySound?.('click')
          engine.pushToast('success', `Copied ${nickname || 'sender'} npub`)
        })
        .catch(() => {
          engine.pushToast('error', 'Clipboard copy failed')
        })
    },
    [engine, onPlaySound],
  )

  const openFreshComposer = useCallback(
    (opts?: ComposerInitOpts) => {
      stopAndDiscardVoiceRecorder()
      revokeAllComposePreviews()
      composeDragDepthRef.current = 0
      setComposeDragOver(false)
      setUploadingItems([])
      setComposeAttachments(
        opts?.attachments ? opts.attachments.slice(0, MAX_AMAIL_ATTACHMENTS) : [],
      )
      setComposeDraftId(opts?.draftId)
      setComposeThreadId(opts?.threadId)
      setComposeInReplyTo(opts?.inReplyTo)

      const nextTo: AmailRecipient[] = []
      const seenTo = new Set<string>()
      if (opts?.toList && opts.toList.length > 0) {
        for (const r of opts.toList) {
          const pk = r.pubkey.toLowerCase()
          if (!pk || seenTo.has(pk)) continue
          seenTo.add(pk)
          nextTo.push(resolveRecipientInfo(pk, r.nickname))
        }
      } else if (opts?.to?.pubkey) {
        const pk = opts.to.pubkey.toLowerCase()
        seenTo.add(pk)
        nextTo.push(resolveRecipientInfo(pk, opts.to.nickname))
      }

      const nextCc: AmailRecipient[] = []
      const seenCc = new Set<string>()
      if (opts?.ccList && opts.ccList.length > 0) {
        for (const r of opts.ccList) {
          const pk = r.pubkey.toLowerCase()
          if (!pk || seenTo.has(pk) || seenCc.has(pk)) continue
          seenCc.add(pk)
          nextCc.push(resolveRecipientInfo(pk, r.nickname))
        }
      }

      const nextBcc: AmailRecipient[] = []
      const seenBcc = new Set<string>()
      if (opts?.bccList && opts.bccList.length > 0) {
        for (const r of opts.bccList) {
          const pk = r.pubkey.toLowerCase()
          if (!pk || seenTo.has(pk) || seenCc.has(pk) || seenBcc.has(pk)) continue
          seenBcc.add(pk)
          nextBcc.push(resolveRecipientInfo(pk, r.nickname))
        }
      }

      setToRecipients(nextTo)
      setCcRecipients(nextCc)
      setBccRecipients(nextBcc)
      setToInput('')
      setCcInput('')
      setBccInput('')
      setShowCc(nextCc.length > 0)
      setShowBcc(nextBcc.length > 0)
      setActiveRecipientField(null)
      setAcHighlightIdx(0)
      setSubjectDraft(opts?.subject ?? '')
      setBodyDraft(opts?.body ?? '')
      setComposeTab('write')
      setRequestReceipt(opts?.requestReadReceipt ?? true)
      setComposeTtlSec(opts?.ttlSec ?? amail.settings.defaultTtlSec)
      setComposeError(null)
      setComposing(true)
    },
    [
      resolveRecipientInfo,
      amail.settings.defaultTtlSec,
      stopAndDiscardVoiceRecorder,
      revokeAllComposePreviews,
    ],
  )

  openFreshComposerRef.current = openFreshComposer

  const initialComposePubkey = initialComposeTo?.pubkey ?? null
  const initialComposeNickname = initialComposeTo?.nickname

  // Sync only when Agmail opens or navigation intent props genuinely change
  useEffect(() => {
    if (!open) return
    setSearchQuery('')
    setSelectedMessageId(null)
    setConfirmPurgeVault(false)
    setMeshFeedback(null)
    setCreatingFolder(false)
    setRenamingFolderId(null)
    setArmedDeleteFolderId(null)
    setFolderPicker(null)

    if (initialComposePubkey) {
      setSection('inbox')
      openFreshComposerRef.current?.({
        to: { pubkey: initialComposePubkey, nickname: initialComposeNickname },
      })
      return
    }

    if (initialSection === 'compose') {
      setSection('inbox')
      openFreshComposerRef.current?.()
    } else if (initialSection === 'contacts') {
      setComposing(false)
      setSection('contacts')
    } else if (initialSection === 'mesh') {
      setComposing(false)
      setSection('mesh')
    } else {
      setComposing(false)
      setSection('inbox')
    }
  }, [open, initialSection, initialComposePubkey, initialComposeNickname])

  // Android / PWA Back button LIFO: Popover -> Composer -> Reader -> Non-Inbox Section -> Close (modal only)
  useBackHandler(open && !embedded, onClose)
  useBackHandler(open && section !== 'inbox' && !selectedMessageId && !composing, () =>
    setSection('inbox'),
  )
  useBackHandler(open && Boolean(selectedMessageId) && !composing, () =>
    setSelectedMessageId(null),
  )
  useBackHandler(open && composing, () => setComposing(false))
  useBackHandler(open && Boolean(folderPicker), () => setFolderPicker(null))

  // Escape step-back
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.ag-lightbox-backdrop')) {
        return
      }
      if (folderPicker) {
        e.preventDefault()
        setFolderPicker(null)
      } else if (renamingFolderId) {
        e.preventDefault()
        setRenamingFolderId(null)
      } else if (creatingFolder) {
        e.preventDefault()
        setCreatingFolder(false)
        setNewFolderName('')
      } else if (activeRecipientField) {
        e.preventDefault()
        setActiveRecipientField(null)
      } else if (composing) {
        e.preventDefault()
        setComposing(false)
      } else if (selectedMessageId) {
        e.preventDefault()
        setSelectedMessageId(null)
      } else if (!embedded) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    open,
    embedded,
    folderPicker,
    renamingFolderId,
    creatingFolder,
    activeRecipientField,
    composing,
    selectedMessageId,
    onClose,
  ])

  // Close recipient autocomplete dropdown on outside click or focus moving outside recipient lines
  useEffect(() => {
    if (!activeRecipientField) return
    const dismissIfOutside = (target: EventTarget | null) => {
      if (recipLinesWrapRef.current && !recipLinesWrapRef.current.contains(target as Node)) {
        setActiveRecipientField(null)
      }
    }
    const onPointerDown = (e: PointerEvent) => dismissIfOutside(e.target)
    const onFocusIn = (e: FocusEvent) => dismissIfOutside(e.target)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [activeRecipientField])

  const canonicalThreadMap = useMemo(
    () => buildCanonicalThreadMap(amail.messages),
    [amail.messages],
  )

  const folderCounts = useMemo(() => {
    const starredThreads = new Set<string>()
    let drafts = 0
    const customThreadSets: Record<string, Set<string>> = {}
    for (const m of amail.messages) {
      if (m.folder === 'drafts') {
        drafts += 1
        if (m.isStarred) starredThreads.add(`draft:${m.id}`)
        continue
      }
      const tKey = canonicalThreadMap.get(m.id) ?? `m:${baseMailId(m.id)}`
      if (m.isStarred && m.folder !== 'trash') {
        starredThreads.add(tKey)
      }
      if (!BUILTIN_FOLDER_SET.has(m.folder)) {
        if (!customThreadSets[m.folder]) {
          customThreadSets[m.folder] = new Set<string>()
        }
        customThreadSets[m.folder].add(tKey)
      }
    }
    const customCounts: Record<string, number> = {}
    for (const [folderId, set] of Object.entries(customThreadSets)) {
      customCounts[folderId] = set.size
    }
    return { starred: starredThreads.size, drafts, customCounts }
  }, [amail.messages, canonicalThreadMap])

  const visibleThreads = useMemo<MailThreadListItem[]>(() => {
    if (section === 'contacts' || section === 'mesh') return []
    const q = searchQuery.trim().toLowerCase()

    // Drafts stay un-consolidated (each draft is its own editable row)
    if (section === 'drafts') {
      return amail.messages
        .filter((m) => m.folder === 'drafts' && (!q || matchesMailQuery(m, q)))
        .sort((a, b) => b.sentAt - a.sentAt || b.updatedAt - a.updatedAt)
        .map<MailThreadListItem>((m) => ({
          key: m.id,
          isDraft: true,
          sectionMessages: [m],
          conversationMessages: [m],
          primaryMsg: m,
          latestMsg: m,
          latestSentAt: m.sentAt,
          messageCount: 1,
          isUnread: false,
          isStarred: m.isStarred,
          displaySubject: formatThreadSubject(m.subject),
        }))
    }

    const byThreadKey = new Map<string, AmailMessage[]>()
    const sectionBuckets = new Map<string, AmailMessage[]>()

    for (const m of amail.messages) {
      const isDraft = m.folder === 'drafts'
      const tKey = isDraft
        ? `draft:${m.id}`
        : (canonicalThreadMap.get(m.id) ?? `m:${baseMailId(m.id)}`)

      if (!isDraft) {
        const list = byThreadKey.get(tKey)
        if (list) list.push(m)
        else byThreadKey.set(tKey, [m])
      }

      const belongsToSection =
        section === 'starred' ? m.isStarred && m.folder !== 'trash' : m.folder === section
      if (!belongsToSection) continue

      const bucket = sectionBuckets.get(tKey)
      if (bucket) bucket.push(m)
      else sectionBuckets.set(tKey, [m])
    }

    const items: MailThreadListItem[] = []
    for (const [tKey, rawSecMsgs] of sectionBuckets.entries()) {
      const sectionMessages = [...rawSecMsgs].sort(
        (a, b) => b.sentAt - a.sentAt || b.updatedAt - a.updatedAt,
      )
      const primaryMsg = sectionMessages[0]
      const isDraft = primaryMsg.folder === 'drafts'

      let conversationMessages: AmailMessage[]
      if (isDraft) {
        conversationMessages = [primaryMsg]
      } else {
        const allInThread = byThreadKey.get(tKey) ?? sectionMessages
        const scoped =
          section === 'trash'
            ? allInThread.filter((m) => m.folder === 'trash')
            : allInThread.filter((m) => m.folder !== 'trash')
        const deduped = dedupeThreadMessages(scoped, section === 'sent')
        conversationMessages = deduped.length > 0 ? deduped : [...sectionMessages].reverse()
      }

      if (
        q &&
        !conversationMessages.some((m) => matchesMailQuery(m, q)) &&
        !sectionMessages.some((m) => matchesMailQuery(m, q))
      ) {
        continue
      }

      const latestMsg = conversationMessages[conversationMessages.length - 1] ?? primaryMsg
      const latestSentAt = Math.max(latestMsg.sentAt, primaryMsg.sentAt)
      const isUnread =
        sectionMessages.some((m) => !m.isRead && m.direction === 'in') ||
        (section === 'starred' &&
          conversationMessages.some((m) => !m.isRead && m.direction === 'in'))
      const isStarred =
        conversationMessages.some((m) => m.isStarred) || sectionMessages.some((m) => m.isStarred)
      const displaySubject = formatThreadSubject(
        conversationMessages[0]?.subject || primaryMsg.subject,
      )

      items.push({
        key: tKey,
        isDraft,
        sectionMessages,
        conversationMessages,
        primaryMsg,
        latestMsg,
        latestSentAt,
        messageCount: conversationMessages.length,
        isUnread,
        isStarred,
        displaySubject,
      })
    }

    items.sort(
      (a, b) => b.latestSentAt - a.latestSentAt || b.primaryMsg.updatedAt - a.primaryMsg.updatedAt,
    )
    return items
  }, [amail.messages, canonicalThreadMap, section, searchQuery])

  const selectedMessage = useMemo(
    () =>
      selectedMessageId
        ? (amail.messages.find((m) => m.id === selectedMessageId) ?? null)
        : null,
    [amail.messages, selectedMessageId],
  )

  // Show all messages in the canonical thread chronologically, deduplicating self-mail sibling pairs
  const threadMessages = useMemo(() => {
    if (!selectedMessage) return []
    if (selectedMessage.folder === 'drafts') return [selectedMessage]
    const tKey = canonicalThreadMap.get(selectedMessage.id)
    if (!tKey) return [selectedMessage]
    const isViewingTrash = section === 'trash' || selectedMessage.folder === 'trash'
    const rawSiblings = amail.messages.filter((m) => {
      if (m.folder === 'drafts') return false
      if (canonicalThreadMap.get(m.id) !== tKey) return false
      if (isViewingTrash) {
        return m.folder === 'trash' || m.id === selectedMessage.id
      }
      return m.folder !== 'trash' || m.id === selectedMessage.id
    })

    const preferOut =
      section === 'sent' ||
      (selectedMessage.direction === 'out' && selectedMessage.folder === 'sent')
    const deduped = dedupeThreadMessages(rawSiblings, preferOut, selectedMessage.id)
    return deduped.length > 0 ? deduped : [selectedMessage]
  }, [amail.messages, selectedMessage, canonicalThreadMap, section])

  // Build autocomplete matches for active recipient field (including top `Me (Yourself)` entry)
  const getAutocompleteForField = useCallback(
    (field: RecipientField, rawQuery: string): AutocompleteCandidate[] => {
      const q = rawQuery.trim().toLowerCase()
      const fieldChips =
        field === 'to' ? toRecipients : field === 'cc' ? ccRecipients : bccRecipients
      const existingSet = new Set(fieldChips.map((r) => r.pubkey.toLowerCase()))

      const results: AutocompleteCandidate[] = []

      // Top `Me (Yourself)` entry so self-mail is 1 click
      const selfMatches =
        !q ||
        'me'.includes(q) ||
        'self'.includes(q) ||
        'yourself'.includes(q) ||
        'you'.includes(q) ||
        myNickname.toLowerCase().includes(q) ||
        myNpub.toLowerCase().includes(q) ||
        myPubkey.includes(q)

      if (selfMatches && !existingSet.has(myPubkey)) {
        results.push({
          pubkey: myPubkey,
          npub: myNpub,
          nickname: 'You (Self)',
          displayLabel: 'Me (Yourself)',
          subLabel: `${myNickname} · ${shortPubkey(myNpub, 8, 5)}`,
          isSelf: true,
        })
      }

      for (const c of mergedContacts) {
        const pk = c.pubkey.toLowerCase()
        if (pk === myPubkey || existingSet.has(pk)) continue
        if (
          q &&
          !c.nickname.toLowerCase().includes(q) &&
          !c.npub.toLowerCase().includes(q) &&
          !pk.includes(q)
        ) {
          continue
        }
        results.push({
          pubkey: pk,
          npub: c.npub,
          nickname: c.nickname,
          displayLabel: c.nickname,
          subLabel: shortPubkey(c.npub, 10, 6),
          isTrustedPeer: c.isTrustedPeer,
        })
        if (results.length >= 9) break
      }

      return results
    },
    [toRecipients, ccRecipients, bccRecipients, mergedContacts, myNickname, myNpub, myPubkey],
  )

  if (!open) return null

  const connectedCouriers = amail.meshPeers.filter((p) => p.state === 'connected').length
  const vaultPct = Math.min(
    100,
    Math.round(
      (amail.storageStats.vaultBytes / Math.max(1, amail.storageStats.vaultLimitBytes)) * 100,
    ),
  )

  const getFolderDisplayName = (folderId: AmailFolder): string => {
    if (folderId in BUILTIN_FOLDER_LABELS) {
      return BUILTIN_FOLDER_LABELS[folderId as AmailBuiltinFolder]
    }
    return amail.customFolders.find((f) => f.id === folderId)?.name ?? 'Folder'
  }

  const formatRecipientName = (r: AmailRecipient): string =>
    r.pubkey.toLowerCase() === myPubkey ? 'You' : r.nickname || shortPubkey(r.pubkey, 6, 4)

  const formatRowCounterparty = (msg: AmailMessage): { label: string; colorPubkey: string } => {
    if (msg.direction === 'out') {
      const toList = getMessageToList(msg)
      const allRecips = [
        ...toList,
        ...(msg.ccRecipients ?? []),
        ...(msg.bccRecipients ?? []),
      ]
      if (allRecips.length === 0) {
        return {
          label: `To: ${msg.toName || shortPubkey(msg.toPubkey, 6, 4)}`,
          colorPubkey: msg.toPubkey,
        }
      }
      const first = allRecips[0]
      const firstIsSelf = first.pubkey.toLowerCase() === myPubkey
      if (allRecips.length === 1) {
        return {
          label: firstIsSelf ? 'To: You (Self)' : `To: ${first.nickname || shortPubkey(first.pubkey, 6, 4)}`,
          colorPubkey: first.pubkey,
        }
      }
      const baseName = firstIsSelf ? 'You' : first.nickname || shortPubkey(first.pubkey, 6, 4)
      return {
        label: `To: ${baseName} +${allRecips.length - 1}`,
        colorPubkey: first.pubkey,
      }
    }
    const fromIsSelf = msg.fromPubkey.toLowerCase() === myPubkey
    return {
      label: fromIsSelf ? 'Me (Self)' : msg.fromName || shortPubkey(msg.fromPubkey, 6, 4),
      colorPubkey: msg.fromPubkey,
    }
  }

  const formatThreadParticipants = (
    thread: MailThreadListItem,
  ): { label: string; colorPubkey: string } => {
    if (thread.messageCount <= 1) {
      return formatRowCounterparty(thread.primaryMsg)
    }
    const participants: { pubkey: string; name: string; isSelf: boolean }[] = []
    const seen = new Set<string>()
    for (const m of thread.conversationMessages) {
      const pk = (m.fromPubkey || '').toLowerCase()
      const isSelf = m.direction === 'out' || pk === myPubkey
      const dedupeKey = isSelf ? '__self__' : pk || (m.fromName || '').toLowerCase()
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      participants.push({
        pubkey: pk,
        name: isSelf ? 'Me' : m.fromName?.trim() || shortPubkey(m.fromPubkey, 6, 4),
        isSelf,
      })
    }
    if (participants.length === 0) {
      return formatRowCounterparty(thread.primaryMsg)
    }
    // If every message in the thread was sent by self to a remote recipient, show recipient cleanly
    if (participants.length === 1 && participants[0].isSelf) {
      const hasRemoteRecipient = thread.conversationMessages.some((m) =>
        [
          ...getMessageToList(m),
          ...(m.ccRecipients ?? []),
          ...(m.bccRecipients ?? []),
        ].some((r) => r.pubkey.toLowerCase() !== myPubkey),
      )
      if (hasRemoteRecipient && thread.primaryMsg.direction === 'out') {
        return formatRowCounterparty(thread.primaryMsg)
      }
      return { label: 'Me', colorPubkey: myPubkey }
    }

    const firstNonSelf = participants.find((p) => !p.isSelf)
    const colorPubkey = firstNonSelf?.pubkey || participants[0].pubkey
    if (participants.length <= 3) {
      return {
        label: participants.map((p) => p.name).join(', '),
        colorPubkey,
      }
    }
    return {
      label: `${participants[0].name}, ${participants[1].name} +${participants.length - 2}`,
      colorPubkey,
    }
  }

  const copyValue = async (key: string, value: string, toastTitle: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(key)
      onPlaySound?.('click')
      engine.pushToast('success', toastTitle)
      window.setTimeout(() => setCopiedId((prev) => (prev === key ? null : prev)), 1800)
    } catch {
      engine.pushToast('error', 'Clipboard copy failed')
    }
  }

  const handleOpenThread = (thread: MailThreadListItem) => {
    onPlaySound?.('click')
    hideTooltip()
    const msg = thread.primaryMsg
    if (thread.isDraft || msg.folder === 'drafts') {
      const toList = getMessageToList(msg)
      openFreshComposer({
        toList,
        ccList: msg.ccRecipients ?? [],
        bccList: msg.bccRecipients ?? [],
        subject: msg.subject,
        body: msg.body,
        attachments: msg.attachments ?? [],
        draftId: msg.id,
        threadId: msg.threadId,
        inReplyTo: msg.inReplyTo,
        requestReadReceipt: msg.requestReadReceipt,
        ttlSec: msg.ttlSec,
      })
      return
    }
    setSelectedMessageId(msg.id)
    const unreadIds = new Set<string>()
    for (const m of thread.sectionMessages) {
      if (!m.isRead) unreadIds.add(m.id)
    }
    for (const m of thread.conversationMessages) {
      if (!m.isRead) unreadIds.add(m.id)
    }
    if (unreadIds.size > 0) {
      void (async () => {
        for (const id of unreadIds) {
          await amail.markRead(id, true)
        }
      })()
    }
  }

  const handleToggleThreadRead = async (thread: MailThreadListItem) => {
    onPlaySound?.('click')
    if (thread.isUnread) {
      const unreadIds = new Set<string>()
      for (const m of thread.sectionMessages) {
        if (!m.isRead) unreadIds.add(m.id)
      }
      for (const m of thread.conversationMessages) {
        if (!m.isRead && (section === 'starred' || m.folder === section)) {
          unreadIds.add(m.id)
        }
      }
      for (const id of unreadIds) {
        await amail.markRead(id, true)
      }
      return
    }
    const target =
      thread.sectionMessages.find((m) => m.direction === 'in') ?? thread.primaryMsg
    await amail.markRead(target.id, false)
  }

  const handleToggleThreadStar = async (
    conversationMessages: readonly AmailMessage[],
    sectionMessages: readonly AmailMessage[],
    latestMsg: AmailMessage,
    isStarred: boolean,
  ) => {
    onPlaySound?.('click')
    if (isStarred) {
      const starredIds = new Set<string>()
      for (const m of conversationMessages) {
        if (m.isStarred) starredIds.add(m.id)
      }
      for (const m of sectionMessages) {
        if (m.isStarred) starredIds.add(m.id)
      }
      for (const id of starredIds) {
        await amail.toggleStar(id)
      }
      return
    }
    await amail.toggleStar(latestMsg.id)
  }

  const canReplyAll = (msg: AmailMessage): boolean => {
    const toList = getMessageToList(msg)
    const ccList = msg.ccRecipients ?? []
    if (ccList.length > 0) return true
    const distinct = new Set<string>()
    for (const r of toList) distinct.add(r.pubkey.toLowerCase())
    if (msg.direction === 'in' && msg.fromPubkey) {
      distinct.add(msg.fromPubkey.toLowerCase())
    }
    return distinct.size > 1
  }

  const handleReply = (msg: AmailMessage) => {
    onPlaySound?.('click')
    hideTooltip()
    const replyPubkey = msg.direction === 'in' ? msg.fromPubkey : msg.toPubkey
    const replyName = msg.direction === 'in' ? msg.fromName : msg.toName
    const nextSubject = /^re:/i.test(msg.subject.trim())
      ? msg.subject.trim()
      : `Re: ${msg.subject.trim() || '(no subject)'}`
    openFreshComposer({
      to: replyPubkey ? { pubkey: replyPubkey, nickname: replyName } : null,
      subject: nextSubject,
      body: '',
      threadId: msg.threadId || baseMailId(msg.id),
      inReplyTo: msg.id,
    })
  }

  const handleReplyAll = (msg: AmailMessage) => {
    onPlaySound?.('click')
    hideTooltip()
    const toCandidates: AmailRecipient[] = []
    const ccCandidates: AmailRecipient[] = []
    const seenTo = new Set<string>()
    const seenCc = new Set<string>()

    const addTo = (r: AmailRecipient) => {
      const pk = r.pubkey.toLowerCase()
      if (!pk || pk === myPubkey || seenTo.has(pk)) return
      seenTo.add(pk)
      toCandidates.push(resolveRecipientInfo(pk, r.nickname))
    }

    if (msg.direction === 'in' && msg.fromPubkey) {
      addTo({
        pubkey: msg.fromPubkey,
        npub: msg.fromNpub,
        nickname: msg.fromName,
      })
    }
    for (const r of getMessageToList(msg)) {
      addTo(r)
    }
    for (const r of msg.ccRecipients ?? []) {
      const pk = r.pubkey.toLowerCase()
      if (!pk || pk === myPubkey || seenTo.has(pk) || seenCc.has(pk)) continue
      seenCc.add(pk)
      ccCandidates.push(resolveRecipientInfo(pk, r.nickname))
    }

    // Solo self-mail fallback: keep self in To
    if (toCandidates.length === 0 && ccCandidates.length === 0) {
      toCandidates.push(resolveRecipientInfo(myPubkey, 'You (Self)'))
    }

    const nextSubject = /^re:/i.test(msg.subject.trim())
      ? msg.subject.trim()
      : `Re: ${msg.subject.trim() || '(no subject)'}`

    openFreshComposer({
      toList: toCandidates,
      ccList: ccCandidates,
      subject: nextSubject,
      body: '',
      threadId: msg.threadId || baseMailId(msg.id),
      inReplyTo: msg.id,
    })
  }

  const handleForward = (msg: AmailMessage) => {
    onPlaySound?.('click')
    hideTooltip()
    const nextSubject = /^fwd:/i.test(msg.subject.trim())
      ? msg.subject.trim()
      : `Fwd: ${msg.subject.trim() || '(no subject)'}`
    const toNames = getMessageToList(msg)
      .map((r) => formatRecipientName(r))
      .join(', ')
    const ccNames = (msg.ccRecipients ?? []).map((r) => formatRecipientName(r)).join(', ')
    const headerLines = [
      '**Forwarded message**',
      `**From:** ${msg.fromName}`,
      `**Date:** ${formatFullDateTime(msg.sentAt)}`,
      toNames ? `**To:** ${toNames}` : null,
      ccNames ? `**CC:** ${ccNames}` : null,
    ].filter(Boolean)
    const quoted = `\n\n---\n${headerLines.join('\n')}\n\n${msg.body}`
    openFreshComposer({
      toList: [],
      subject: nextSubject,
      body: quoted,
      attachments: msg.attachments ?? [],
    })
  }

  const handleRestoreMessages = async (targetIds: readonly string[], closeReader = false) => {
    if (targetIds.length === 0) return
    onPlaySound?.('click')
    hideTooltip()
    const uniqueIds = [...new Set(targetIds)]
    let restoredTo: AmailFolder | null = null
    for (const id of uniqueIds) {
      const dest = await amail.restoreMessage(id)
      if (dest && !restoredTo) restoredTo = dest
    }
    if (restoredTo) {
      engine.pushToast('success', `Restored to ${getFolderDisplayName(restoredTo)}`)
    }
    if (closeReader || (selectedMessageId && uniqueIds.includes(selectedMessageId))) {
      setSelectedMessageId(null)
    }
  }

  const handleMoveMessagesToFolder = async (
    targetIds: readonly string[],
    targetFolder: AmailFolder,
    closeReader = false,
  ) => {
    if (targetIds.length === 0) return
    onPlaySound?.('click')
    hideTooltip()
    setFolderPicker(null)
    const uniqueIds = [...new Set(targetIds)]
    for (const id of uniqueIds) {
      await amail.moveToFolder(id, targetFolder)
    }
    engine.pushToast('info', `Moved to ${getFolderDisplayName(targetFolder)}`)
    if (
      closeReader ||
      (selectedMessageId && uniqueIds.includes(selectedMessageId) && targetFolder !== section)
    ) {
      setSelectedMessageId(null)
    }
  }

  const handleDeleteMessages = async (
    targetIds: readonly string[],
    folder: AmailFolder,
    closeReader = false,
  ) => {
    if (targetIds.length === 0) return
    onPlaySound?.('click')
    hideTooltip()
    const uniqueIds = [...new Set(targetIds)]
    for (const id of uniqueIds) {
      if (folder === 'drafts') {
        await amail.deleteDraft(id)
      } else if (folder === 'trash') {
        await amail.deletePermanently(id)
      } else {
        await amail.moveToFolder(id, 'trash')
      }
    }
    if (closeReader || (selectedMessageId && uniqueIds.includes(selectedMessageId))) {
      setSelectedMessageId(null)
    }
  }

  const openFolderPickerAt = (
    e: ReactMouseEvent<HTMLElement>,
    opts: {
      pickerKey: string
      targetIds: string[]
      currentFolder: AmailFolder
      closeReaderOnMove: boolean
    },
  ) => {
    e.stopPropagation()
    hideTooltip()
    onPlaySound?.('click')
    if (folderPicker && folderPicker.pickerKey === opts.pickerKey) {
      setFolderPicker(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    setFolderPicker({
      pickerKey: opts.pickerKey,
      targetIds: opts.targetIds,
      currentFolder: opts.currentFolder,
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      anchorLeft: rect.left,
      anchorRight: rect.right,
      closeReaderOnMove: opts.closeReaderOnMove,
    })
  }

  const openThreadContextMenu = (e: ReactMouseEvent, thread: MailThreadListItem) => {
    hideTooltip()
    const msg = thread.primaryMsg
    const replyTarget = thread.latestMsg
    const targetIds = thread.sectionMessages.map((m) => m.id)
    const items: ContextMenuItem[] = [
      {
        id: 'open',
        label: thread.isDraft || msg.folder === 'drafts' ? 'Edit Draft' : 'Open',
        icon: <MailOpen size={14} />,
        onSelect: () => handleOpenThread(thread),
      },
    ]

    if (!thread.isDraft && msg.folder !== 'drafts') {
      items.push({
        id: 'reply',
        label: 'Reply',
        icon: <Reply size={14} />,
        onSelect: () => handleReply(replyTarget),
      })
      if (canReplyAll(replyTarget)) {
        items.push({
          id: 'reply-all',
          label: 'Reply All',
          icon: <ReplyAll size={14} />,
          onSelect: () => handleReplyAll(replyTarget),
        })
      }
      items.push(
        {
          id: 'forward',
          label: 'Forward',
          icon: <Forward size={14} />,
          onSelect: () => handleForward(replyTarget),
        },
        {
          id: 'toggle-read',
          label: thread.isUnread ? 'Mark as Read' : 'Mark as Unread',
          icon: thread.isUnread ? <MailOpen size={14} /> : <Mail size={14} />,
          dividerBefore: true,
          onSelect: () => {
            void handleToggleThreadRead(thread)
          },
        },
        {
          id: 'toggle-star',
          label: thread.isStarred ? 'Remove Star' : 'Star',
          icon: <Star size={14} />,
          onSelect: () => {
            void handleToggleThreadStar(
              thread.conversationMessages,
              thread.sectionMessages,
              thread.latestMsg,
              thread.isStarred,
            )
          },
        },
      )

      if (msg.folder === 'trash' || msg.folder === 'archive') {
        items.push({
          id: 'restore',
          label: 'Restore',
          icon: <RotateCcw size={14} />,
          dividerBefore: true,
          onSelect: () => void handleRestoreMessages(targetIds),
        })
      } else {
        items.push({
          id: 'archive',
          label: 'Archive',
          icon: <Archive size={14} />,
          dividerBefore: true,
          onSelect: () => void handleMoveMessagesToFolder(targetIds, 'archive'),
        })
      }

      if (msg.folder !== 'inbox') {
        items.push({
          id: 'move-inbox',
          label: 'Move to Inbox',
          icon: <Inbox size={14} />,
          onSelect: () => void handleMoveMessagesToFolder(targetIds, 'inbox'),
        })
      }

      for (const folder of displayedCustomFolders) {
        if (folder.id === msg.folder) continue
        items.push({
          id: `move-${folder.id}`,
          label: `Move to ${folder.name}`,
          icon: <Folder size={14} />,
          onSelect: () => void handleMoveMessagesToFolder(targetIds, folder.id),
        })
      }
    }

    items.push({
      id: 'delete',
      label:
        msg.folder === 'trash' || msg.folder === 'drafts' ? 'Delete Permanently' : 'Move to Trash',
      icon: <Trash2 size={14} />,
      danger: true,
      dividerBefore: true,
      onSelect: () => {
        void handleDeleteMessages(targetIds, msg.folder)
      },
    })

    openContextMenu(e, {
      header: thread.displaySubject,
      items,
    })
  }

  // Custom Folder CRUD handlers
  const handleCreateFolderSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    const trimmed = newFolderName.trim()
    if (!trimmed) return
    const created = await amail.createFolder(trimmed)
    if (created) {
      onPlaySound?.('click')
      setNewFolderName('')
      setCreatingFolder(false)
      engine.pushToast('success', `Created folder "${created.name}"`)
    }
  }

  const handleCommitRenameFolder = async (folderId: string) => {
    const trimmed = renameFolderDraft.trim()
    setRenamingFolderId(null)
    if (!trimmed) return
    const current = amail.customFolders.find((f) => f.id === folderId)
    if (!current || current.name === trimmed) return
    const ok = await amail.renameFolder(folderId, trimmed)
    if (ok) {
      onPlaySound?.('click')
    }
  }

  const handleCycleFolderSort = () => {
    onPlaySound?.('click')
    hideTooltip()
    const next: AmailFolderSortMode =
      amail.folderSortMode === 'az'
        ? 'za'
        : amail.folderSortMode === 'za'
          ? 'manual'
          : 'az'
    void amail.sortFolders(next)
  }

  const handleMoveFolderStep = (folderId: string, delta: -1 | 1) => {
    const ids = displayedCustomFolders.map((f) => f.id)
    const idx = ids.indexOf(folderId)
    const nextIdx = idx + delta
    if (idx < 0 || nextIdx < 0 || nextIdx >= ids.length) return
    onPlaySound?.('click')
    hideTooltip()
    const reordered = [...ids]
    const [moved] = reordered.splice(idx, 1)
    reordered.splice(nextIdx, 0, moved)
    void amail.reorderFolders(reordered)
  }

  const handleDeleteFolderClick = async (folderId: string, immediate = false) => {
    if (!immediate && armedDeleteFolderId !== folderId) {
      onPlaySound?.('click')
      setArmedDeleteFolderId(folderId)
      return
    }
    const target = amail.customFolders.find((f) => f.id === folderId)
    setArmedDeleteFolderId(null)
    onPlaySound?.('click')
    hideTooltip()
    await amail.deleteFolder(folderId)
    if (section === folderId) {
      setSection('inbox')
      setSelectedMessageId(null)
    }
    if (target) {
      engine.pushToast('info', `Deleted folder "${target.name}"`)
    }
  }

  const openFolderContextMenu = (e: ReactMouseEvent, folder: AmailCustomFolder, index: number) => {
    hideTooltip()
    const items: ContextMenuItem[] = [
      {
        id: 'rename-folder',
        label: 'Rename',
        icon: <Pencil size={14} />,
        onSelect: () => {
          setRenamingFolderId(folder.id)
          setRenameFolderDraft(folder.name)
        },
      },
      {
        id: 'move-up',
        label: 'Move Up',
        icon: <ChevronUp size={14} />,
        disabled: index === 0,
        onSelect: () => handleMoveFolderStep(folder.id, -1),
      },
      {
        id: 'move-down',
        label: 'Move Down',
        icon: <ChevronDown size={14} />,
        disabled: index >= displayedCustomFolders.length - 1,
        onSelect: () => handleMoveFolderStep(folder.id, 1),
      },
      {
        id: 'delete-folder',
        label: 'Delete Folder',
        icon: <Trash2 size={14} />,
        danger: true,
        dividerBefore: true,
        onSelect: () => void handleDeleteFolderClick(folder.id, true),
      },
    ]
    openContextMenu(e, { header: folder.name, items })
  }

  const handleFolderDrop = (e: ReactDragEvent, targetId: string) => {
    e.preventDefault()
    const sourceId = draggingFolderId || e.dataTransfer.getData('text/plain')
    setDraggingFolderId(null)
    setDragOverFolderId(null)
    if (!sourceId || sourceId === targetId) return
    const ids = displayedCustomFolders.map((f) => f.id)
    const fromIdx = ids.indexOf(sourceId)
    const toIdx = ids.indexOf(targetId)
    if (fromIdx < 0 || toIdx < 0) return
    const reordered = [...ids]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    onPlaySound?.('click')
    void amail.reorderFolders(reordered)
  }

  // Multi-recipient Compose helpers
  const addRecipientChip = (field: RecipientField, recipient: AmailRecipient) => {
    const pk = recipient.pubkey.toLowerCase()
    const normalized = resolveRecipientInfo(pk, recipient.nickname)

    // Remove from all 3 fields first to prevent duplicates across To / CC / BCC
    setToRecipients((prev) => {
      const filtered = prev.filter((r) => r.pubkey.toLowerCase() !== pk)
      return field === 'to' ? [...filtered, normalized] : filtered
    })
    setCcRecipients((prev) => {
      const filtered = prev.filter((r) => r.pubkey.toLowerCase() !== pk)
      return field === 'cc' ? [...filtered, normalized] : filtered
    })
    setBccRecipients((prev) => {
      const filtered = prev.filter((r) => r.pubkey.toLowerCase() !== pk)
      return field === 'bcc' ? [...filtered, normalized] : filtered
    })

    if (field === 'to') setToInput('')
    else if (field === 'cc') setCcInput('')
    else setBccInput('')
    setAcHighlightIdx(0)
    setComposeError(null)
  }

  const removeRecipientChip = (field: RecipientField, pubkey: string) => {
    const pk = pubkey.toLowerCase()
    if (field === 'to') {
      setToRecipients((prev) => prev.filter((r) => r.pubkey.toLowerCase() !== pk))
    } else if (field === 'cc') {
      setCcRecipients((prev) => prev.filter((r) => r.pubkey.toLowerCase() !== pk))
    } else {
      setBccRecipients((prev) => prev.filter((r) => r.pubkey.toLowerCase() !== pk))
    }
  }

  const tryCommitFieldInput = (
    field: RecipientField,
    rawText: string,
    allowAutocomplete: boolean,
  ): boolean => {
    const trimmed = rawText.trim().replace(/,+$/, '').trim()
    if (!trimmed) return false
    const parsed = resolvePubkeyInput(trimmed)
    if (parsed) {
      addRecipientChip(field, resolveRecipientInfo(parsed.pubkey, parsed.nickname))
      return true
    }
    if (allowAutocomplete) {
      const matches = getAutocompleteForField(field, trimmed)
      const pick = matches[acHighlightIdx] ?? matches[0]
      if (pick) {
        addRecipientChip(field, {
          pubkey: pick.pubkey,
          npub: pick.npub,
          nickname: pick.nickname,
        })
        return true
      }
    }
    return false
  }

  const collectFinalRecipients = (): {
    to: AmailRecipient[]
    cc: AmailRecipient[]
    bcc: AmailRecipient[]
    invalidInputs: string[]
  } => {
    const to = [...toRecipients]
    const cc = [...ccRecipients]
    const bcc = [...bccRecipients]
    const invalidInputs: string[] = []
    const seen = new Set<string>([
      ...to.map((r) => r.pubkey.toLowerCase()),
      ...cc.map((r) => r.pubkey.toLowerCase()),
      ...bcc.map((r) => r.pubkey.toLowerCase()),
    ])

    const absorb = (raw: string, bucket: AmailRecipient[]) => {
      const cleaned = raw.trim()
      if (!cleaned) return
      const parts = cleaned
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      for (const part of parts) {
        const parsed = resolvePubkeyInput(part)
        if (!parsed) {
          invalidInputs.push(part)
          continue
        }
        const pk = parsed.pubkey.toLowerCase()
        if (seen.has(pk)) continue
        seen.add(pk)
        bucket.push(resolveRecipientInfo(pk, parsed.nickname))
      }
    }

    absorb(toInput, to)
    absorb(ccInput, cc)
    absorb(bccInput, bcc)

    return { to, cc, bcc, invalidInputs }
  }

  const hasInFlightUploads = uploadingItems.some((item) => !item.error)

  const handleUploadComposeFiles = async (
    rawFiles: FileList | readonly File[],
    forcedKind?: AmailAttachmentKind,
  ) => {
    const incoming = Array.from(rawFiles)
    if (incoming.length === 0) return

    const activeCount = composeAttachments.length + uploadingItems.filter((u) => !u.error).length
    const remaining = Math.max(0, MAX_AMAIL_ATTACHMENTS - activeCount)
    if (remaining <= 0) {
      setComposeError(`Maximum ${MAX_AMAIL_ATTACHMENTS} attachments per message.`)
      return
    }

    const toProcess = incoming.slice(0, remaining)
    if (incoming.length > remaining) {
      setComposeError(`Only ${MAX_AMAIL_ATTACHMENTS} attachments are allowed per message.`)
    } else {
      setComposeError(null)
    }

    onPlaySound?.('click')

    for (const file of toProcess) {
      const kind: AmailAttachmentKind =
        forcedKind ?? (file.type.startsWith('image/') ? 'image' : 'file')
      const tempId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const displayName = sanitizeDisplayFilename(
        file.name,
        file.type || (kind === 'image' ? 'image/jpeg' : undefined),
      )

      setUploadingItems((prev) => [...prev, { tempId, name: displayName, kind }])

      try {
        const uploaded = await amail.uploadAttachment(file, {
          kind,
          name: displayName,
        })
        if (uploaded.kind === 'image') {
          try {
            const previewUrl = URL.createObjectURL(file)
            composeLocalPreviewsRef.current = {
              ...composeLocalPreviewsRef.current,
              [uploaded.id]: previewUrl,
            }
            setComposeLocalPreviews((prev) => ({ ...prev, [uploaded.id]: previewUrl }))
          } catch {
            // Ignore preview errors
          }
        }
        setComposeAttachments((prev) =>
          prev.length >= MAX_AMAIL_ATTACHMENTS ? prev : [...prev, uploaded],
        )
        setUploadingItems((prev) => prev.filter((item) => item.tempId !== tempId))
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Attachment upload failed.'
        setUploadingItems((prev) =>
          prev.map((item) => (item.tempId === tempId ? { ...item, error: msg } : item)),
        )
        engine.pushToast('error', 'Attachment upload failed', msg)
      }
    }
  }

  const handleComposeImageInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      void handleUploadComposeFiles(files, 'image')
    }
    e.target.value = ''
  }

  const handleComposeFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      void handleUploadComposeFiles(files)
    }
    e.target.value = ''
  }

  const handleComposePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items || items.length === 0) return
    const files: File[] = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      void handleUploadComposeFiles(files)
    }
  }

  const handleComposeDragEnter = (e: ReactDragEvent<HTMLFormElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    composeDragDepthRef.current += 1
    setComposeDragOver(true)
  }

  const handleComposeDragOver = (e: ReactDragEvent<HTMLFormElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleComposeDragLeave = (e: ReactDragEvent<HTMLFormElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    composeDragDepthRef.current = Math.max(0, composeDragDepthRef.current - 1)
    if (composeDragDepthRef.current === 0) {
      setComposeDragOver(false)
    }
  }

  const handleComposeDrop = (e: ReactDragEvent<HTMLFormElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    composeDragDepthRef.current = 0
    setComposeDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleUploadComposeFiles(e.dataTransfer.files)
    }
  }

  const handleRemoveComposeAttachment = (attachmentId: string) => {
    onPlaySound?.('click')
    setComposeAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
    const previewUrl = composeLocalPreviewsRef.current[attachmentId]
    if (previewUrl) {
      try {
        URL.revokeObjectURL(previewUrl)
      } catch {
        // Ignore
      }
      const nextMap = { ...composeLocalPreviewsRef.current }
      delete nextMap[attachmentId]
      composeLocalPreviewsRef.current = nextMap
      setComposeLocalPreviews(nextMap)
    }
  }

  const handleDismissUploadingItem = (tempId: string) => {
    setUploadingItems((prev) => prev.filter((u) => u.tempId !== tempId))
  }

  const handleRecordedVoicemail = async (rec: RecordedVoiceMemo) => {
    revokeVoicePreviewUrl(rec)
    const tempId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const voiceName = `voicemail-${Date.now()}.webm`
    setUploadingItems((prev) => [...prev, { tempId, name: 'Voicemail', kind: 'voice' }])
    try {
      const normalizedPeaks = rec.waveform.map((v) =>
        Math.max(0, Math.min(1, Number((v / 100).toFixed(3)))),
      )
      const uploaded = await amail.uploadAttachment(rec.blob, {
        kind: 'voice',
        name: voiceName,
        durationSec: rec.durationSec,
        peaks: normalizedPeaks,
      })
      setComposeAttachments((prev) =>
        prev.length >= MAX_AMAIL_ATTACHMENTS ? prev : [...prev, uploaded],
      )
      setUploadingItems((prev) => prev.filter((item) => item.tempId !== tempId))
      onPlaySound?.('click')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Voicemail upload failed.'
      setUploadingItems((prev) =>
        prev.map((item) => (item.tempId === tempId ? { ...item, error: msg } : item)),
      )
      engine.pushToast('error', 'Voicemail upload failed', msg)
    }
  }

  const handleStartVoiceRecording = async () => {
    if (isRecordingVoice) return
    const activeCount = composeAttachments.length + uploadingItems.filter((u) => !u.error).length
    if (activeCount >= MAX_AMAIL_ATTACHMENTS) {
      setComposeError(`Maximum ${MAX_AMAIL_ATTACHMENTS} attachments per message.`)
      return
    }
    if (!isVoiceRecordingSupported()) {
      setComposeError('Microphone recording is not supported in this browser.')
      return
    }
    setComposeError(null)
    const controller = new VoiceRecorderController()
    voiceRecorderRef.current = controller
    try {
      await controller.start({
        onLevel: (_lvl, liveBars, elapsedSec) => {
          setVoiceLiveBars(liveBars)
          setVoiceElapsedSec(elapsedSec)
        },
        onAutoStop: (rec) => {
          voiceRecorderRef.current = null
          setIsRecordingVoice(false)
          setVoiceElapsedSec(0)
          setVoiceLiveBars([])
          void handleRecordedVoicemail(rec)
        },
        onError: (err) => {
          voiceRecorderRef.current = null
          setIsRecordingVoice(false)
          setVoiceElapsedSec(0)
          setVoiceLiveBars([])
          setComposeError(err.message)
        },
      })
      setVoiceElapsedSec(0)
      setVoiceLiveBars(Array.from({ length: 24 }, () => 10))
      setIsRecordingVoice(true)
      onPlaySound?.('click')
    } catch (err) {
      voiceRecorderRef.current = null
      setIsRecordingVoice(false)
      const msg =
        err instanceof Error ? err.message : 'Unable to access microphone for voicemail.'
      setComposeError(msg)
      engine.pushToast('error', 'Microphone error', msg)
    }
  }

  const handleFinishVoiceRecording = async () => {
    const controller = voiceRecorderRef.current
    if (!controller) return
    voiceRecorderRef.current = null
    setIsRecordingVoice(false)
    const rec = await controller.stop()
    setVoiceElapsedSec(0)
    setVoiceLiveBars([])
    if (rec) {
      await handleRecordedVoicemail(rec)
    }
  }

  const handleDownloadFileAttachment = async (att: AmailAttachment) => {
    const dlKey = att.id || att.sha256 || att.url
    if (fileDownloads[dlKey]?.loading) return
    setFileDownloads((prev) => ({ ...prev, [dlKey]: { loading: true } }))
    try {
      const blob = await amail.downloadAttachment(att)
      const filename = sanitizeDisplayFilename(att.name, att.mime)
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = filename
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      window.setTimeout(() => {
        try {
          URL.revokeObjectURL(objectUrl)
        } catch {
          // Ignore
        }
      }, 10_000)
      onPlaySound?.('click')
      setFileDownloads((prev) => ({ ...prev, [dlKey]: { loading: false } }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to decrypt & download file.'
      setFileDownloads((prev) => ({ ...prev, [dlKey]: { loading: false, error: msg } }))
      engine.pushToast('error', 'Download failed', msg)
    }
  }

  const handleSendMail = async (e: FormEvent) => {
    e.preventDefault()
    if (sendingMail || hasInFlightUploads || isRecordingVoice) return
    const { to, cc, bcc, invalidInputs } = collectFinalRecipients()
    if (invalidInputs.length > 0) {
      setComposeError(
        `Unrecognized recipient "${invalidInputs[0]}". Pick a contact or paste an npub.`,
      )
      return
    }
    const allCount = to.length + cc.length + bcc.length
    if (allCount === 0) {
      setComposeError('Add at least one recipient in To, CC, or BCC.')
      return
    }
    if (!subjectDraft.trim() && !bodyDraft.trim() && composeAttachments.length === 0) {
      setComposeError('Add a subject, message, or attachment before sending.')
      return
    }

    const primary = to[0] ?? cc[0] ?? bcc[0]
    setComposeError(null)
    setSendingMail(true)
    try {
      const sent = await amail.sendMail({
        toPubkey: primary?.pubkey,
        toPubkeys: to.map((r) => r.pubkey),
        ccPubkeys: cc.map((r) => r.pubkey),
        bccPubkeys: bcc.map((r) => r.pubkey),
        subject: subjectDraft.trim() || '(no subject)',
        body: bodyDraft,
        attachments: composeAttachments.length > 0 ? composeAttachments : undefined,
        inReplyTo: composeInReplyTo,
        threadId: composeThreadId,
        requestReadReceipt: requestReceipt,
        ttlSec: composeTtlSec,
        draftId: composeDraftId,
      })
      if (sent) {
        onPlaySound?.('send')
        revokeAllComposePreviews()
        setComposeAttachments([])
        setUploadingItems([])
        setComposing(false)
        const isReply = Boolean(composeThreadId)
        let keepCurrentSection = false
        if (
          isReply &&
          section !== 'sent' &&
          section !== 'drafts' &&
          section !== 'contacts' &&
          section !== 'mesh'
        ) {
          const replyAnchorKey = composeInReplyTo
            ? (canonicalThreadMap.get(composeInReplyTo) ??
              `m:${baseMailId(composeInReplyTo)}`)
            : null
          keepCurrentSection = amail.messages.some((m) => {
            if (m.folder === 'drafts') return false
            const inSection =
              section === 'starred' ? m.isStarred && m.folder !== 'trash' : m.folder === section
            if (!inSection) return false
            if (composeThreadId && m.threadId === composeThreadId) return true
            if (replyAnchorKey && canonicalThreadMap.get(m.id) === replyAnchorKey) return true
            return false
          })
        }
        if (!keepCurrentSection) {
          setSection('sent')
        }
        setSelectedMessageId(sent.id)
      }
    } finally {
      setSendingMail(false)
    }
  }

  const handleSaveDraft = async () => {
    const { to, cc, bcc } = collectFinalRecipients()
    const primary = to[0] ?? cc[0] ?? bcc[0]
    const saved = await amail.saveDraft({
      id: composeDraftId,
      toPubkey: primary?.pubkey,
      toPubkeys: to.map((r) => r.pubkey),
      ccPubkeys: cc.map((r) => r.pubkey),
      bccPubkeys: bcc.map((r) => r.pubkey),
      subject: subjectDraft.trim(),
      body: bodyDraft,
      attachments: composeAttachments.length > 0 ? composeAttachments : undefined,
      inReplyTo: composeInReplyTo,
      threadId: composeThreadId,
      requestReadReceipt: requestReceipt,
      ttlSec: composeTtlSec,
    })
    setComposeDraftId(saved.id)
    onPlaySound?.('click')
    engine.pushToast('info', 'Saved draft')
    stopAndDiscardVoiceRecorder()
    revokeAllComposePreviews()
    setComposeAttachments([])
    setUploadingItems([])
    setSelectedMessageId(null)
    setComposing(false)
    setSection('drafts')
  }

  const handleDiscardCompose = () => {
    onPlaySound?.('click')
    hideTooltip()
    stopAndDiscardVoiceRecorder()
    revokeAllComposePreviews()
    setComposeAttachments([])
    setUploadingItems([])
    if (composeDraftId) {
      void amail.deleteDraft(composeDraftId)
    }
    setSelectedMessageId(null)
    setComposing(false)
  }

  const handleAddContact = async (e: FormEvent) => {
    e.preventDefault()
    const raw = contactKeyDraft.trim()
    if (!raw) return
    setContactFeedback(null)
    const added = await amail.addContact(
      raw,
      contactNickDraft.trim() || undefined,
      contactNoteDraft.trim() || undefined,
    )
    if (added) {
      onPlaySound?.('click')
      setContactKeyDraft('')
      setContactNickDraft('')
      setContactNoteDraft('')
      setContactFeedback({ ok: true, msg: `Added ${added.nickname}` })
    } else {
      setContactFeedback({
        ok: false,
        msg: 'Enter a valid npub or public key.',
      })
    }
  }

  const handlePurgeVault = async () => {
    if (!confirmPurgeVault) {
      setConfirmPurgeVault(true)
      window.setTimeout(() => setConfirmPurgeVault(false), 3200)
      return
    }
    setConfirmPurgeVault(false)
    onPlaySound?.('click')
    await amail.purgeRelayVault()
    setMeshFeedback('Relay vault cleared.')
  }

  const handlePruneExpired = async () => {
    onPlaySound?.('click')
    const removed = await amail.pruneExpired()
    setMeshFeedback(
      removed > 0
        ? `Cleared ${removed} expired ${removed === 1 ? 'item' : 'items'}.`
        : 'No expired items.',
    )
  }

  const handleSyncMesh = async () => {
    onPlaySound?.('click')
    hideTooltip()
    setMeshFeedback(null)
    await amail.syncMeshNow()
  }

  const navFolders: readonly {
    id: AmailBuiltinFolder
    label: string
    icon: typeof Inbox
    count?: number
  }[] = [
    { id: 'inbox', label: 'Inbox', icon: Inbox, count: amail.unreadInboxCount || undefined },
    { id: 'starred', label: 'Starred', icon: Star, count: folderCounts.starred || undefined },
    { id: 'sent', label: 'Sent', icon: Send },
    { id: 'drafts', label: 'Drafts', icon: FileText, count: folderCounts.drafts || undefined },
    { id: 'archive', label: 'Archive', icon: Archive },
    { id: 'trash', label: 'Trash', icon: Trash2 },
  ]

  const activeCustomFolder =
    section !== 'contacts' && section !== 'mesh' && !BUILTIN_FOLDER_SET.has(section)
      ? (displayedCustomFolders.find((f) => f.id === section) ?? null)
      : null
  const activeCustomFolderIndex = activeCustomFolder
    ? displayedCustomFolders.findIndex((f) => f.id === activeCustomFolder.id)
    : -1

  const renderMailList = () => (
    <div className="ag-amail-list-pane">
      {visibleThreads.length === 0 ? (
        <div className="ag-amail-empty">
          <Mail size={26} className="ag-amail-empty-icon" aria-hidden="true" />
          <p className="ag-amail-empty-title">
            {searchQuery.trim()
              ? 'No matches'
              : section === 'inbox'
                ? 'Inbox is empty'
                : activeCustomFolder
                  ? `No messages in ${activeCustomFolder.name}`
                  : 'No messages'}
          </p>
          {section === 'inbox' && !searchQuery.trim() && (
            <button
              type="button"
              className="ag-amail-action-primary"
              onClick={() => {
                onPlaySound?.('click')
                openFreshComposer()
              }}
            >
              <PenSquare size={14} />
              <span>Compose</span>
            </button>
          )}
        </div>
      ) : (
        <div className="ag-amail-rows" role="list" aria-label={`${getFolderDisplayName(section as AmailFolder)} messages`}>
          {visibleThreads.map((thread) => {
            const msg = thread.primaryMsg
            const latestMsg = thread.latestMsg
            const targetIds = thread.sectionMessages.map((m) => m.id)
            const isUnread = thread.isUnread
            const { label: counterpartyName, colorPubkey } = formatThreadParticipants(thread)
            const attachmentCount = thread.conversationMessages.reduce(
              (sum, m) => sum + (m.attachments?.length ?? 0),
              0,
            )
            const rawSnippet = buildBodySnippet(latestMsg.body)
            const snippet =
              rawSnippet ||
              (attachmentCount > 0
                ? attachmentCount === 1
                  ? 'Encrypted attachment'
                  : `${attachmentCount} encrypted attachments`
                : '')
            const isRestorable = msg.folder === 'trash' || msg.folder === 'archive'
            const restoreTip =
              msg.folder === 'trash' ? 'Restore from Trash' : 'Restore from Archive'
            const deleteTip =
              msg.folder === 'trash'
                ? 'Delete permanently'
                : msg.folder === 'drafts'
                  ? 'Discard draft'
                  : 'Move to Trash'
            const isPickerOpenForRow = folderPicker?.pickerKey === thread.key

            return (
              <div
                key={thread.key}
                role="listitem"
                className={`ag-amail-row ${isUnread ? 'unread' : ''} ${isPickerOpenForRow ? 'menu-open' : ''}`}
                onClick={() => handleOpenThread(thread)}
                onContextMenu={(e) => openThreadContextMenu(e, thread)}
              >
                <button
                  type="button"
                  className={`ag-amail-star-btn ${thread.isStarred ? 'starred' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleToggleThreadStar(
                      thread.conversationMessages,
                      thread.sectionMessages,
                      latestMsg,
                      thread.isStarred,
                    )
                  }}
                  aria-label={thread.isStarred ? 'Remove star' : 'Star this conversation'}
                  {...tipProps(thread.isStarred ? 'Remove star' : 'Star this conversation')}
                >
                  <Star size={14} fill={thread.isStarred ? 'currentColor' : 'none'} />
                </button>

                <div className="ag-amail-row-main">
                  <div className="ag-amail-row-sender-col">
                    {isUnread && <span className="ag-amail-unread-dot" aria-hidden="true" />}
                    <span
                      className="ag-amail-row-sender truncate"
                      style={{
                        color: colorPubkey ? pubkeyToColor(colorPubkey) : undefined,
                      }}
                    >
                      {counterpartyName}
                    </span>
                    {thread.messageCount > 1 && (
                      <span
                        className="ag-amail-row-count mono"
                        aria-label={`${thread.messageCount} messages`}
                      >
                        {thread.messageCount}
                      </span>
                    )}
                  </div>

                  <div className="ag-amail-row-content-col">
                    <span className="ag-amail-row-subject truncate">{thread.displaySubject}</span>
                    {snippet && <span className="ag-amail-row-snippet truncate"> — {snippet}</span>}
                  </div>
                </div>

                <div className="ag-amail-row-right">
                  {attachmentCount > 0 && (
                    <span
                      className="ag-amail-row-attach"
                      aria-label={`${attachmentCount} ${attachmentCount === 1 ? 'attachment' : 'attachments'}`}
                      {...tipProps(
                        `${attachmentCount} encrypted ${attachmentCount === 1 ? 'attachment' : 'attachments'}`,
                      )}
                    >
                      <Paperclip size={11} aria-hidden="true" />
                      {attachmentCount > 1 && <span className="mono">{attachmentCount}</span>}
                    </span>
                  )}
                  {latestMsg.direction === 'out' && renderStatusIcon(latestMsg.deliveryStatus)}
                  <span className="ag-amail-row-time mono">
                    {formatMailTimestamp(thread.latestSentAt)}
                  </span>

                  <div
                    className={`ag-amail-row-hover-actions ${isRestorable ? 'has-restore' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!thread.isDraft && msg.folder !== 'drafts' && (
                      <>
                        <button
                          type="button"
                          className="ag-amail-icon-btn"
                          onClick={() => void handleToggleThreadRead(thread)}
                          aria-label={isUnread ? 'Mark as read' : 'Mark as unread'}
                          {...tipProps(isUnread ? 'Mark as read' : 'Mark as unread')}
                        >
                          {isUnread ? <MailOpen size={13} /> : <Mail size={13} />}
                        </button>
                        <button
                          type="button"
                          className={`ag-amail-icon-btn ${isPickerOpenForRow ? 'active' : ''}`}
                          onClick={(e) =>
                            openFolderPickerAt(e, {
                              pickerKey: thread.key,
                              targetIds,
                              currentFolder: msg.folder,
                              closeReaderOnMove: false,
                            })
                          }
                          aria-label="Move to a folder"
                          aria-expanded={isPickerOpenForRow}
                          {...tipProps('Move to a folder')}
                        >
                          <FolderInput size={13} />
                        </button>
                        {isRestorable ? (
                          <button
                            type="button"
                            className="ag-amail-icon-btn restore"
                            onClick={() => void handleRestoreMessages(targetIds)}
                            aria-label={restoreTip}
                            {...tipProps(restoreTip)}
                          >
                            <RotateCcw size={13} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="ag-amail-icon-btn"
                            onClick={() => void handleMoveMessagesToFolder(targetIds, 'archive')}
                            aria-label="Archive — move out of Inbox without deleting"
                            {...tipProps('Archive — move out of Inbox without deleting')}
                          >
                            <Archive size={13} />
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      className="ag-amail-icon-btn danger"
                      onClick={() => void handleDeleteMessages(targetIds, msg.folder)}
                      aria-label={deleteTip}
                      {...tipProps(deleteTip)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  const renderReader = (msg: AmailMessage) => {
    const tKey = canonicalThreadMap.get(msg.id)
    const latestMsg = threadMessages[threadMessages.length - 1] ?? msg
    const readerSectionMessages = (() => {
      if (!tKey || msg.folder === 'drafts') return [msg]
      const inThread = amail.messages.filter(
        (m) => m.folder !== 'drafts' && canonicalThreadMap.get(m.id) === tKey,
      )
      if (section === 'starred') {
        const matched = inThread.filter(
          (m) => m.folder !== 'trash' && (m.isStarred || m.folder === msg.folder),
        )
        return matched.length > 0 ? matched : [msg]
      }
      if (section !== 'contacts' && section !== 'mesh') {
        const matched = inThread.filter((m) => m.folder === section)
        if (matched.length > 0) return matched
      }
      const sameFolder = inThread.filter((m) => m.folder === msg.folder)
      return sameFolder.length > 0 ? sameFolder : [msg]
    })()

    const readerTargetIds = readerSectionMessages.map((m) => m.id)
    const readerFolder: AmailFolder = readerSectionMessages[0]?.folder ?? msg.folder
    const readerPickerKey = `reader:${tKey ?? msg.id}`
    const statusMeta = formatDeliveryMeta(latestMsg)
    const isRestorable = readerFolder === 'trash' || readerFolder === 'archive'
    const restoreTip = readerFolder === 'trash' ? 'Restore from Trash' : 'Restore from Archive'
    const deleteTip = readerFolder === 'trash' ? 'Delete permanently' : 'Move to Trash'
    const showReplyAll = canReplyAll(latestMsg)
    const isStarred =
      threadMessages.some((m) => m.isStarred) || readerSectionMessages.some((m) => m.isStarred)
    const displaySubject = formatThreadSubject(threadMessages[0]?.subject || msg.subject)
    const isPickerOpen = folderPicker?.pickerKey === readerPickerKey

    return (
      <div className="ag-amail-reader">
        <div className="ag-amail-reader-toolbar">
          <button
            type="button"
            className="ag-amail-ghost-btn"
            onClick={() => {
              onPlaySound?.('click')
              setSelectedMessageId(null)
            }}
          >
            <ArrowLeft size={14} />
            <span>Back</span>
          </button>

          <div className="ag-amail-reader-actions">
            {isRestorable && (
              <button
                type="button"
                className="ag-amail-tonal-btn accent"
                onClick={() => void handleRestoreMessages(readerTargetIds, true)}
                aria-label={restoreTip}
                {...tipProps(restoreTip)}
              >
                <RotateCcw size={13} />
                <span>Restore</span>
              </button>
            )}
            <button
              type="button"
              className="ag-amail-tonal-btn"
              onClick={() => handleReply(latestMsg)}
              aria-label="Reply to sender"
              {...tipProps('Reply to sender')}
            >
              <Reply size={13} />
              <span>Reply</span>
            </button>
            {showReplyAll && (
              <button
                type="button"
                className="ag-amail-tonal-btn"
                onClick={() => handleReplyAll(latestMsg)}
                aria-label="Reply to all recipients"
                {...tipProps('Reply to all recipients')}
              >
                <ReplyAll size={13} />
                <span>Reply All</span>
              </button>
            )}
            <button
              type="button"
              className="ag-amail-tonal-btn"
              onClick={() => handleForward(latestMsg)}
              aria-label="Forward this message"
              {...tipProps('Forward this message')}
            >
              <Forward size={13} />
              <span>Forward</span>
            </button>
            <button
              type="button"
              className={`ag-amail-icon-btn ${isStarred ? 'ag-amail-star-active' : ''}`}
              onClick={() =>
                void handleToggleThreadStar(
                  threadMessages,
                  readerSectionMessages,
                  latestMsg,
                  isStarred,
                )
              }
              aria-label={isStarred ? 'Remove star' : 'Star this conversation'}
              {...tipProps(isStarred ? 'Remove star' : 'Star this conversation')}
            >
              <Star size={14} fill={isStarred ? 'currentColor' : 'none'} />
            </button>
            <button
              type="button"
              className={`ag-amail-icon-btn ${isPickerOpen ? 'active' : ''}`}
              onClick={(e) =>
                openFolderPickerAt(e, {
                  pickerKey: readerPickerKey,
                  targetIds: readerTargetIds,
                  currentFolder: readerFolder,
                  closeReaderOnMove: true,
                })
              }
              aria-label="Move to a folder"
              aria-expanded={isPickerOpen}
              {...tipProps('Move to a folder')}
            >
              <FolderInput size={14} />
            </button>
            {!isRestorable && (
              <button
                type="button"
                className="ag-amail-icon-btn"
                onClick={() => void handleMoveMessagesToFolder(readerTargetIds, 'archive', true)}
                aria-label="Archive — move out of Inbox without deleting"
                {...tipProps('Archive — move out of Inbox without deleting')}
              >
                <Archive size={14} />
              </button>
            )}
            <button
              type="button"
              className="ag-amail-icon-btn danger"
              onClick={() => void handleDeleteMessages(readerTargetIds, readerFolder, true)}
              aria-label={deleteTip}
              {...tipProps(deleteTip)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="ag-amail-reader-scroll">
          <div className="ag-amail-reader-head">
            <h2 className="ag-amail-reader-subject">{displaySubject}</h2>
            <div className="ag-amail-reader-meta-row">
              <span className={`ag-amail-status-text ${statusMeta.tone}`}>
                {latestMsg.deliveryStatus === 'read' ? <CheckCheck size={12} /> : <Lock size={11} />}
                <span>{statusMeta.label}</span>
              </span>
              {!BUILTIN_FOLDER_SET.has(readerFolder) && (
                <span className="ag-amail-folder-tag">
                  <Folder size={11} />
                  <span>{getFolderDisplayName(readerFolder)}</span>
                </span>
              )}
              {threadMessages.length > 1 && (
                <span className="ag-amail-thread-count mono">
                  · {threadMessages.length} messages
                </span>
              )}
            </div>
          </div>

          <div className="ag-amail-thread-stack">
            {threadMessages.map((item) => {
              const itemMeta = formatDeliveryMeta(item)
              const toList = getMessageToList(item)
              const ccList = item.ccRecipients ?? []
              const bccList = item.direction === 'out' ? (item.bccRecipients ?? []) : []
              const fromIsSelf = item.fromPubkey.toLowerCase() === myPubkey

              return (
                <article key={item.id} className="ag-amail-message-block">
                  <header className="ag-amail-msg-meta">
                    <div className="ag-amail-msg-sender-wrap">
                      <img
                        src={identiconDataUrl(item.fromPubkey)}
                        alt=""
                        width={34}
                        height={34}
                        className="ag-amail-avatar"
                      />
                      <div className="ag-amail-msg-ident">
                        <div className="ag-amail-msg-from-row">
                          <span
                            className="ag-amail-msg-from truncate"
                            style={{ color: pubkeyToColor(item.fromPubkey) }}
                          >
                            {fromIsSelf ? `${item.fromName} (You)` : item.fromName}
                          </span>
                          <button
                            type="button"
                            className="ag-amail-npub-link mono"
                            onClick={() =>
                              void copyValue(`from-${item.id}`, item.fromNpub, 'Copied sender npub')
                            }
                            aria-label="Copy sender npub"
                            {...tipProps(`Copy ${shortPubkey(item.fromNpub, 10, 6)}`)}
                          >
                            <span>{shortPubkey(item.fromNpub, 8, 5)}</span>
                            {copiedId === `from-${item.id}` ? (
                              <Check size={10} />
                            ) : (
                              <Copy size={10} />
                            )}
                          </button>
                        </div>

                        {toList.length > 0 && (
                          <div className="ag-amail-msg-recip-row">
                            <span className="ag-amail-msg-recip-label">To</span>
                            <div className="ag-amail-msg-recip-list">
                              {toList.map((r, idx) => (
                                <button
                                  key={`${item.id}-to-${r.pubkey}`}
                                  type="button"
                                  className="ag-amail-msg-recip-btn"
                                  onClick={() =>
                                    void copyValue(
                                      `to-${item.id}-${r.pubkey}`,
                                      r.npub,
                                      'Copied recipient npub',
                                    )
                                  }
                                  aria-label={`Copy npub for ${formatRecipientName(r)}`}
                                  {...tipProps(`Copy ${shortPubkey(r.npub, 10, 6)}`)}
                                >
                                  <span>
                                    {formatRecipientName(r)}
                                    {idx < toList.length - 1 ? ',' : ''}
                                  </span>
                                </button>
                              ))}
                              {item.direction === 'in' && item.isBccRecipient && (
                                <span className="ag-amail-bcc-tag">BCC</span>
                              )}
                            </div>
                          </div>
                        )}

                        {toList.length === 0 && item.direction === 'in' && item.isBccRecipient && (
                          <div className="ag-amail-msg-recip-row">
                            <span className="ag-amail-bcc-tag">BCC</span>
                            <span className="ag-amail-msg-recip-label">Sent to you via BCC</span>
                          </div>
                        )}

                        {ccList.length > 0 && (
                          <div className="ag-amail-msg-recip-row">
                            <span className="ag-amail-msg-recip-label">CC</span>
                            <div className="ag-amail-msg-recip-list">
                              {ccList.map((r, idx) => (
                                <button
                                  key={`${item.id}-cc-${r.pubkey}`}
                                  type="button"
                                  className="ag-amail-msg-recip-btn"
                                  onClick={() =>
                                    void copyValue(
                                      `cc-${item.id}-${r.pubkey}`,
                                      r.npub,
                                      'Copied CC npub',
                                    )
                                  }
                                  aria-label={`Copy npub for ${formatRecipientName(r)}`}
                                  {...tipProps(`Copy ${shortPubkey(r.npub, 10, 6)}`)}
                                >
                                  <span>
                                    {formatRecipientName(r)}
                                    {idx < ccList.length - 1 ? ',' : ''}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {bccList.length > 0 && (
                          <div className="ag-amail-msg-recip-row">
                            <span className="ag-amail-msg-recip-label">BCC</span>
                            <div className="ag-amail-msg-recip-list">
                              {bccList.map((r, idx) => (
                                <button
                                  key={`${item.id}-bcc-${r.pubkey}`}
                                  type="button"
                                  className="ag-amail-msg-recip-btn"
                                  onClick={() =>
                                    void copyValue(
                                      `bcc-${item.id}-${r.pubkey}`,
                                      r.npub,
                                      'Copied BCC npub',
                                    )
                                  }
                                  aria-label={`Copy npub for ${formatRecipientName(r)}`}
                                  {...tipProps(`Copy ${shortPubkey(r.npub, 10, 6)}`)}
                                >
                                  <span>
                                    {formatRecipientName(r)}
                                    {idx < bccList.length - 1 ? ',' : ''}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="ag-amail-msg-time-col">
                      <span className="ag-amail-msg-time mono">
                        {formatFullDateTime(item.sentAt)}
                      </span>
                      {threadMessages.length > 1 && (
                        <span className={`ag-amail-status-text compact ${itemMeta.tone}`}>
                          {itemMeta.label}
                        </span>
                      )}
                    </div>
                  </header>

                  {(item.body.trim().length > 0 || !(item.attachments && item.attachments.length > 0)) && (
                    <div className="ag-amail-msg-body">
                      <RichMessageContent
                        content={item.body}
                        onTuneGeohash={(gh) => {
                          engine.tuneGeohash(gh)
                          onClose()
                        }}
                      />
                    </div>
                  )}

                  {item.attachments && item.attachments.length > 0 && (() => {
                    const msgAttachments = item.attachments
                    const imageAtts = msgAttachments.filter((a) => a.kind === 'image')
                    const voiceAtts = msgAttachments.filter((a) => a.kind === 'voice')
                    const fileAtts = msgAttachments.filter((a) => a.kind === 'file')
                    const isSenderOwn = fromIsSelf || item.direction === 'out'
                    const isSenderTrusted = isSenderOwn || engine.isTrusted(item.fromPubkey)
                    const canLoadVoice = isSenderOwn || engine.canLoadVoiceMemo(item.fromPubkey)

                    return (
                      <div
                        className="ag-amail-msg-attachments"
                        aria-label={`Encrypted attachments (${msgAttachments.length})`}
                      >
                        <div className="ag-amail-msg-attachments-head">
                          <Lock size={11} aria-hidden="true" />
                          <span>
                            Attachments ({msgAttachments.length}) · Encrypted
                          </span>
                        </div>

                        {imageAtts.length > 0 && (
                          <div className="ag-amail-reader-images">
                            {imageAtts.map((att) => (
                              <ImageAttachmentCard
                                key={att.id || att.sha256 || att.url}
                                image={adaptAmailImageAttachment(att)}
                                senderPubkey={item.fromPubkey}
                                senderNickname={item.fromName}
                                senderDisplayHandle={item.fromName}
                                isTrusted={isSenderTrusted}
                                isOwn={isSenderOwn}
                                isDmMode={true}
                                caption={att.name}
                                contentFilter={engine.contentFilter}
                                fetchImageAttachmentBlob={fetchAmailImageUrl}
                                onTrustSender={handleTrustAttachmentSender}
                                onInspectSender={handleInspectAttachmentSender}
                                onBlockSender={handleBlockAttachmentSender}
                                onOpenLightbox={handleOpenAmailLightbox}
                              />
                            ))}
                          </div>
                        )}

                        {voiceAtts.length > 0 && (
                          <div className="ag-amail-reader-voices">
                            {voiceAtts.map((att) => {
                              const voiceKey = att.sha256 || att.url
                              return (
                                <VoiceMemoPlayer
                                  key={att.id || voiceKey}
                                  memo={adaptAmailVoiceAttachment(att)}
                                  memoKey={voiceKey}
                                  senderPubkey={item.fromPubkey}
                                  senderNickname={item.fromName}
                                  senderDisplayHandle={item.fromName}
                                  isTrusted={isSenderTrusted}
                                  isAllowed={canLoadVoice}
                                  isDmMode={true}
                                  autoTranscribe={engine.transcription.autoTranscribe}
                                  fetchVoiceMemoBlob={fetchAmailVoiceUrl}
                                  memoTranscript={engine.transcription.memoTranscripts[voiceKey]}
                                  transcriptionModelStatus={engine.transcription.modelStatus}
                                  transcriptionDownloadProgress={
                                    engine.transcription.downloadProgress
                                  }
                                  activeTranscriptionModelLabel={
                                    engine.transcription.activeModel.label
                                  }
                                  onTranscribeMemo={engine.transcription.transcribeVoiceMemo}
                                  onTrustSender={handleTrustAttachmentSender}
                                  onInspectSender={handleInspectAttachmentSender}
                                  onBlockSender={handleBlockAttachmentSender}
                                />
                              )
                            })}
                          </div>
                        )}

                        {fileAtts.length > 0 && (
                          <div className="ag-amail-reader-files">
                            {fileAtts.map((att) => {
                              const dlKey = att.id || att.sha256 || att.url
                              const dlState = fileDownloads[dlKey]
                              const fileName = sanitizeDisplayFilename(att.name, att.mime)
                              const iconKind = getFileIconKind(att.mime, fileName)
                              const FileKindIcon =
                                iconKind === 'audio'
                                  ? FileAudio
                                  : iconKind === 'video'
                                    ? FileVideo
                                    : iconKind === 'text'
                                      ? FileText
                                      : File

                              return (
                                <div key={dlKey} className="ag-amail-file-card">
                                  <div className="ag-amail-file-card-main">
                                    <span className="ag-amail-file-icon" aria-hidden="true">
                                      <FileKindIcon size={17} />
                                    </span>
                                    <div className="ag-amail-file-meta">
                                      <span className="ag-amail-file-name truncate" title={fileName}>
                                        {fileName}
                                      </span>
                                      <div className="ag-amail-file-sub">
                                        <span className="mono">{formatBytes(att.size)}</span>
                                        <span className="ag-amail-file-e2ee">
                                          <Lock size={9} aria-hidden="true" />
                                          <span>E2EE</span>
                                        </span>
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      className="ag-amail-file-dl-btn"
                                      disabled={Boolean(dlState?.loading)}
                                      onClick={() => void handleDownloadFileAttachment(att)}
                                      aria-label={`Download ${fileName}`}
                                    >
                                      {dlState?.loading ? (
                                        <Loader2 size={13} className="ag-spin" />
                                      ) : (
                                        <Download size={13} />
                                      )}
                                      <span>
                                        {dlState?.loading
                                          ? 'Decrypting…'
                                          : dlState?.error
                                            ? 'Retry'
                                            : 'Download'}
                                      </span>
                                    </button>
                                  </div>
                                  {dlState?.error && (
                                    <p className="ag-amail-file-err" role="alert">
                                      <AlertCircle size={12} aria-hidden="true" />
                                      <span>{dlState.error}</span>
                                    </p>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </article>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const renderRecipientLine = (field: RecipientField) => {
    const label = field === 'to' ? 'To' : field === 'cc' ? 'CC' : 'BCC'
    const inputId =
      field === 'to'
        ? 'ag-amail-to-input'
        : field === 'cc'
          ? 'ag-amail-cc-input'
          : 'ag-amail-bcc-input'
    const chips =
      field === 'to' ? toRecipients : field === 'cc' ? ccRecipients : bccRecipients
    const inputVal = field === 'to' ? toInput : field === 'cc' ? ccInput : bccInput
    const setInputVal =
      field === 'to' ? setToInput : field === 'cc' ? setCcInput : setBccInput
    const isDropdownOpen = activeRecipientField === field
    const matches = isDropdownOpen ? getAutocompleteForField(field, inputVal) : []

    const handleFieldKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown' && matches.length > 0) {
        e.preventDefault()
        setAcHighlightIdx((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp' && matches.length > 0) {
        e.preventDefault()
        setAcHighlightIdx((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' || e.key === ',') {
        if (inputVal.trim() || matches.length > 0) {
          e.preventDefault()
          const committed = tryCommitFieldInput(field, inputVal, true)
          if (committed) {
            setAcHighlightIdx(0)
          }
        }
        return
      }
      if (e.key === 'Tab' && inputVal.trim()) {
        if (tryCommitFieldInput(field, inputVal, true)) {
          e.preventDefault()
          setAcHighlightIdx(0)
        }
        return
      }
      if (e.key === 'Backspace' && !inputVal && chips.length > 0) {
        e.preventDefault()
        const last = chips[chips.length - 1]
        if (last) removeRecipientChip(field, last.pubkey)
      }
    }

    return (
      <div className="ag-amail-compose-line" key={field}>
        <label className="ag-amail-line-label" htmlFor={inputId}>
          {label}
        </label>
        <div className="ag-amail-to-box">
          <div className="ag-amail-chip-field">
            {chips.map((r) => {
              const isSelf = r.pubkey.toLowerCase() === myPubkey
              return (
                <span key={`${field}-${r.pubkey}`} className="ag-amail-recip-chip">
                  <img
                    src={identiconDataUrl(r.pubkey)}
                    alt=""
                    width={16}
                    height={16}
                    className="ag-amail-recip-avatar"
                  />
                  <span className="truncate">{isSelf ? 'You (Self)' : r.nickname}</span>
                  <button
                    type="button"
                    className="ag-amail-recip-clear"
                    onClick={() => removeRecipientChip(field, r.pubkey)}
                    aria-label={`Remove ${r.nickname}`}
                  >
                    <X size={11} />
                  </button>
                </span>
              )
            })}
            <input
              id={inputId}
              type="text"
              className="ag-amail-line-input ag-amail-chip-input"
              value={inputVal}
              onFocus={() => {
                setActiveRecipientField(field)
                setAcHighlightIdx(0)
              }}
              onBlur={(e) => {
                const next = e.relatedTarget as Node | null
                if (!next || !recipLinesWrapRef.current?.contains(next)) {
                  setActiveRecipientField((prev) => (prev === field ? null : prev))
                }
              }}
              onChange={(e) => {
                const val = e.target.value
                setInputVal(val)
                setActiveRecipientField(field)
                setAcHighlightIdx(0)
                if (composeError) setComposeError(null)
                const trimmed = val.trim()
                const direct = resolvePubkeyInput(trimmed)
                if (
                  direct &&
                  (trimmed.startsWith('npub1') ||
                    trimmed.includes('#dm=') ||
                    /^[0-9a-f]{64}$/i.test(trimmed))
                ) {
                  addRecipientChip(field, resolveRecipientInfo(direct.pubkey, direct.nickname))
                }
              }}
              onKeyDown={handleFieldKeyDown}
              placeholder={
                chips.length === 0
                  ? field === 'to'
                    ? 'Name, Me, or npub…'
                    : `Add ${label} recipient…`
                  : 'Add another…'
              }
              autoComplete="off"
            />
          </div>

          {isDropdownOpen && matches.length > 0 && (
            <div className="ag-amail-autocomplete" role="listbox" aria-label={`${label} contacts`}>
              {matches.map((c, idx) => (
                <button
                  key={`${field}-ac-${c.pubkey}`}
                  type="button"
                  role="option"
                  aria-selected={idx === acHighlightIdx}
                  className={`ag-amail-ac-item ${idx === acHighlightIdx ? 'highlighted' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setAcHighlightIdx(idx)}
                  onClick={() => {
                    addRecipientChip(field, {
                      pubkey: c.pubkey,
                      npub: c.npub,
                      nickname: c.nickname,
                    })
                    setActiveRecipientField(null)
                  }}
                >
                  <img
                    src={identiconDataUrl(c.pubkey)}
                    alt=""
                    width={24}
                    height={24}
                    className="ag-amail-avatar-sm"
                  />
                  <span className="ag-amail-ac-copy">
                    <span
                      className="ag-amail-ac-name truncate"
                      style={{ color: pubkeyToColor(c.pubkey) }}
                    >
                      {c.displayLabel}
                    </span>
                    <span className="ag-amail-ac-npub mono truncate">{c.subLabel}</span>
                  </span>
                  {c.isSelf ? (
                    <span className="ag-amail-self-tag">You</span>
                  ) : c.isTrustedPeer ? (
                    <span className="ag-amail-trusted-tag">
                      <ShieldCheck size={11} />
                      <span>Trusted</span>
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>

        {field === 'to' && (
          <div className="ag-amail-cc-bcc-toggles">
            {!showCc && (
              <button
                type="button"
                className="ag-amail-field-toggle"
                onClick={() => {
                  onPlaySound?.('click')
                  setShowCc(true)
                  setActiveRecipientField(null)
                }}
              >
                Cc
              </button>
            )}
            {!showBcc && (
              <button
                type="button"
                className="ag-amail-field-toggle"
                onClick={() => {
                  onPlaySound?.('click')
                  setShowBcc(true)
                  setActiveRecipientField(null)
                }}
              >
                Bcc
              </button>
            )}
            {onOpenScanner && (
              <button
                type="button"
                className="ag-amail-icon-btn"
                onClick={() => {
                  onPlaySound?.('click')
                  hideTooltip()
                  onOpenScanner()
                }}
                aria-label="Scan recipient QR code"
                {...tipProps('Scan recipient QR code')}
              >
                <QrCode size={15} />
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderCompose = () => {
    const activeAttachmentSlots =
      composeAttachments.length + uploadingItems.filter((u) => !u.error).length
    const atAttachmentCap = activeAttachmentSlots >= MAX_AMAIL_ATTACHMENTS

    return (
      <form
        className={`ag-amail-compose ${composeDragOver ? 'is-drag-over' : ''}`}
        onSubmit={(e) => void handleSendMail(e)}
        onDragEnter={handleComposeDragEnter}
        onDragOver={handleComposeDragOver}
        onDragLeave={handleComposeDragLeave}
        onDrop={handleComposeDrop}
      >
        {composeDragOver && (
          <div className="ag-amail-drop-overlay" aria-hidden="true">
            <Paperclip size={22} />
            <span>Drop files to encrypt &amp; attach</span>
          </div>
        )}

        <div className="ag-amail-compose-head">
          <div className="ag-amail-compose-title-wrap">
            <button
              type="button"
              className="ag-amail-ghost-btn"
              onClick={() => {
                onPlaySound?.('click')
                stopAndDiscardVoiceRecorder()
                setComposing(false)
              }}
            >
              <ArrowLeft size={14} />
              <span>Back</span>
            </button>
            <span className="ag-amail-compose-title">New Message</span>
          </div>
          <div className="ag-amail-compose-head-actions">
            <button
              type="button"
              className="ag-amail-tonal-btn"
              disabled={hasInFlightUploads || isRecordingVoice}
              onClick={() => void handleSaveDraft()}
            >
              <span>Save Draft</span>
            </button>
            <button
              type="button"
              className="ag-amail-icon-btn danger"
              onClick={handleDiscardCompose}
              aria-label="Discard draft"
              {...tipProps('Discard draft')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="ag-amail-compose-scroll">
          {/* Multi-recipient To / CC / BCC lines */}
          <div ref={recipLinesWrapRef}>
            {renderRecipientLine('to')}
            {showCc && renderRecipientLine('cc')}
            {showBcc && renderRecipientLine('bcc')}
          </div>

          {bccRecipients.length > 0 && (
            <p className="ag-amail-bcc-note">BCC recipients stay hidden from everyone else.</p>
          )}

          {/* Hairline Subject row */}
          <div className="ag-amail-compose-line">
            <input
              id="ag-amail-subject"
              type="text"
              maxLength={180}
              className="ag-amail-line-input subject"
              value={subjectDraft}
              onChange={(e) => setSubjectDraft(e.target.value)}
              placeholder="Subject"
              aria-label="Subject"
            />
          </div>

          {/* Body Write | Preview */}
          <div className="ag-amail-body-field">
            <div className="ag-amail-body-toolbar">
              <div className="ag-amail-seg" role="tablist" aria-label="Editor mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={composeTab === 'write'}
                  className={composeTab === 'write' ? 'active' : ''}
                  onClick={() => setComposeTab('write')}
                >
                  Write
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={composeTab === 'preview'}
                  className={composeTab === 'preview' ? 'active' : ''}
                  onClick={() => setComposeTab('preview')}
                >
                  Preview
                </button>
              </div>
            </div>

            {composeTab === 'write' ? (
              <textarea
                className="ag-amail-textarea"
                rows={9}
                value={bodyDraft}
                onPaste={handleComposePaste}
                onChange={(e) => {
                  setBodyDraft(e.target.value)
                  if (composeError) setComposeError(null)
                }}
                placeholder="Write a message… (drop files or paste images to attach)"
                aria-label="Email body"
              />
            ) : (
              <div className="ag-amail-preview-box">
                {bodyDraft.trim() ? (
                  <RichMessageContent content={bodyDraft} />
                ) : (
                  <p className="ag-amail-preview-empty">Nothing to preview</p>
                )}
              </div>
            )}
          </div>

          {/* Options Strip */}
          <div className="ag-amail-compose-opts">
            <label className="ag-amail-check-row">
              <input
                type="checkbox"
                className="ag-switch"
                checked={requestReceipt}
                onChange={() => setRequestReceipt((v) => !v)}
              />
              <span>Read receipt</span>
            </label>

            <div className="ag-amail-ttl-group">
              <span className="ag-amail-ttl-label">Expires</span>
              <div className="ag-amail-seg" role="group" aria-label="Message lifetime">
                {TTL_OPTIONS.map((opt) => (
                  <button
                    key={opt.sec}
                    type="button"
                    aria-pressed={composeTtlSec === opt.sec}
                    className={composeTtlSec === opt.sec ? 'active' : ''}
                    onClick={() => setComposeTtlSec(opt.sec)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {composeError && (
            <p className="ag-field-hint ag-field-hint-danger" role="alert">
              {composeError}
            </p>
          )}
        </div>

        {/* Inline Live Voicemail Recorder Bar */}
        {isRecordingVoice && (
          <div
            className="ag-amail-voice-rec-bar"
            role="region"
            aria-label="Recording encrypted voicemail"
          >
            <div className="ag-amail-voice-rec-left">
              <span className="ag-amail-voice-rec-dot" aria-hidden="true" />
              <span className="ag-amail-voice-rec-timer mono">
                {formatVoiceDuration(voiceElapsedSec)}
              </span>
              <div className="ag-amail-voice-rec-bars" aria-hidden="true">
                {(voiceLiveBars.length > 0 ? voiceLiveBars.slice(-24) : [10, 14, 10]).map(
                  (bar, idx) => (
                    <span
                      key={idx}
                      className="ag-amail-voice-rec-bar-seg"
                      style={{ height: `${Math.max(18, Math.min(100, bar))}%` }}
                    />
                  ),
                )}
              </div>
            </div>

            <div className="ag-amail-voice-rec-actions">
              <button
                type="button"
                className="ag-amail-icon-btn danger"
                onClick={() => {
                  onPlaySound?.('click')
                  stopAndDiscardVoiceRecorder()
                }}
                aria-label="Cancel voicemail recording"
                title="Cancel recording"
              >
                <X size={14} />
              </button>
              <button
                type="button"
                className="ag-amail-tonal-btn accent"
                onClick={() => void handleFinishVoiceRecording()}
                aria-label="Attach voicemail"
                title="Attach voicemail"
              >
                <Check size={14} />
                <span>Attach Voicemail</span>
              </button>
            </div>
          </div>
        )}

        {/* Compose Attachments Tray */}
        {(composeAttachments.length > 0 || uploadingItems.length > 0) && (
          <div className="ag-amail-compose-attachments" aria-label="Pending attachments">
            {composeAttachments.map((att) => {
              const localThumb = att.kind === 'image' ? composeLocalPreviews[att.id] : undefined
              const displayName =
                att.kind === 'voice'
                  ? `Voicemail · ${formatVoiceDuration(att.durationSec ?? 0)}`
                  : sanitizeDisplayFilename(att.name, att.mime)
              const fileIconKind =
                att.kind === 'file' ? getFileIconKind(att.mime, att.name) : 'file'
              const FileKindIcon =
                fileIconKind === 'audio'
                  ? FileAudio
                  : fileIconKind === 'video'
                    ? FileVideo
                    : fileIconKind === 'text'
                      ? FileText
                      : File

              return (
                <div
                  key={att.id}
                  className={`ag-amail-attach-chip kind-${att.kind}`}
                >
                  {att.kind === 'image' ? (
                    localThumb ? (
                      <img
                        src={localThumb}
                        alt=""
                        className="ag-amail-attach-thumb"
                      />
                    ) : (
                      <span className="ag-amail-attach-chip-icon" aria-hidden="true">
                        <ImageIcon size={14} />
                      </span>
                    )
                  ) : att.kind === 'voice' ? (
                    <span className="ag-amail-attach-chip-icon voice" aria-hidden="true">
                      <Mic size={14} />
                    </span>
                  ) : (
                    <span className="ag-amail-attach-chip-icon" aria-hidden="true">
                      <FileKindIcon size={14} />
                    </span>
                  )}

                  <div className="ag-amail-attach-chip-copy">
                    <span className="ag-amail-attach-chip-name truncate" title={displayName}>
                      {displayName}
                    </span>
                    <span className="ag-amail-attach-chip-size mono">
                      {formatBytes(att.size)} · E2EE
                    </span>
                  </div>

                  <button
                    type="button"
                    className="ag-amail-attach-chip-rm"
                    onClick={() => handleRemoveComposeAttachment(att.id)}
                    aria-label={`Remove ${displayName}`}
                    title="Remove attachment"
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })}

            {uploadingItems.map((up) => (
              <div
                key={up.tempId}
                className={`ag-amail-attach-chip ${up.error ? 'is-error' : 'is-uploading'}`}
                title={up.error || `Encrypting & uploading ${up.name}…`}
              >
                <span className="ag-amail-attach-chip-icon" aria-hidden="true">
                  {up.error ? (
                    <AlertCircle size={14} />
                  ) : (
                    <Loader2 size={14} className="ag-spin" />
                  )}
                </span>
                <div className="ag-amail-attach-chip-copy">
                  <span className="ag-amail-attach-chip-name truncate">{up.name}</span>
                  <span className="ag-amail-attach-chip-size">
                    {up.error ? 'Upload failed' : 'Encrypting…'}
                  </span>
                </div>
                {up.error && (
                  <button
                    type="button"
                    className="ag-amail-attach-chip-rm"
                    onClick={() => handleDismissUploadingItem(up.tempId)}
                    aria-label={`Dismiss failed upload ${up.name}`}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="ag-amail-compose-footer">
          <div className="ag-amail-compose-attach-btns">
            <input
              ref={composeImageInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleComposeImageInputChange}
            />
            <input
              ref={composeFileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={handleComposeFileInputChange}
            />

            <button
              type="button"
              className="ag-amail-icon-btn"
              disabled={atAttachmentCap || isRecordingVoice}
              onClick={() => composeImageInputRef.current?.click()}
              aria-label="Attach image"
              title="Attach image"
            >
              <ImageIcon size={16} />
            </button>

            <button
              type="button"
              className={`ag-amail-icon-btn ${isRecordingVoice ? 'active recording' : ''}`}
              disabled={!isRecordingVoice && atAttachmentCap}
              onClick={() => {
                if (isRecordingVoice) {
                  void handleFinishVoiceRecording()
                } else {
                  void handleStartVoiceRecording()
                }
              }}
              aria-label={isRecordingVoice ? 'Stop and attach voicemail' : 'Record voicemail'}
              aria-pressed={isRecordingVoice}
              title={isRecordingVoice ? 'Stop and attach voicemail' : 'Record voicemail'}
            >
              <Mic size={16} />
            </button>

            <button
              type="button"
              className="ag-amail-icon-btn"
              disabled={atAttachmentCap || isRecordingVoice}
              onClick={() => composeFileInputRef.current?.click()}
              aria-label="Attach file"
              title="Attach file (any type)"
            >
              <Paperclip size={16} />
            </button>

            {composeAttachments.length > 0 && (
              <span className="ag-amail-attach-counter mono">
                {composeAttachments.length}/{MAX_AMAIL_ATTACHMENTS}
              </span>
            )}
          </div>

          <button
            type="submit"
            className="ag-amail-action-primary"
            disabled={sendingMail || hasInFlightUploads || isRecordingVoice}
          >
            <Send size={14} />
            <span>
              {sendingMail
                ? 'Sending…'
                : hasInFlightUploads
                  ? 'Uploading…'
                  : 'Send'}
            </span>
          </button>
        </div>
      </form>
    )
  }

  const renderContacts = () => (
    <div className="ag-amail-section-scroll">
      <div className="ag-amail-section-head">
        <h3 className="ag-amail-section-title">Contacts</h3>
      </div>

      <form className="ag-amail-add-bar" onSubmit={(e) => void handleAddContact(e)}>
        <div className="ag-amail-to-input-row">
          <input
            type="text"
            className="ag-amail-soft-input mono"
            value={contactKeyDraft}
            onChange={(e) => {
              setContactKeyDraft(e.target.value)
              if (contactFeedback) setContactFeedback(null)
            }}
            placeholder="npub1… or public key"
            aria-label="Contact public key or invite link"
          />
          {onOpenScanner && (
            <button
              type="button"
              className="ag-amail-icon-btn"
              onClick={() => {
                onPlaySound?.('click')
                hideTooltip()
                onOpenScanner()
              }}
              aria-label="Scan QR code"
              {...tipProps('Scan QR code')}
            >
              <QrCode size={15} />
            </button>
          )}
        </div>
        <div className="ag-amail-contact-row-2">
          <input
            type="text"
            maxLength={32}
            className="ag-amail-soft-input"
            value={contactNickDraft}
            onChange={(e) => setContactNickDraft(e.target.value)}
            placeholder="Nickname"
            aria-label="Contact nickname"
          />
          <input
            type="text"
            maxLength={80}
            className="ag-amail-soft-input"
            value={contactNoteDraft}
            onChange={(e) => setContactNoteDraft(e.target.value)}
            placeholder="Note"
            aria-label="Contact note"
          />
          <button
            type="submit"
            className="ag-amail-action-primary compact"
            disabled={!contactKeyDraft.trim()}
          >
            <UserPlus size={14} />
            <span>Add</span>
          </button>
        </div>
        {contactFeedback && (
          <p
            className={`ag-field-hint ${
              contactFeedback.ok ? 'ag-field-hint-accent' : 'ag-field-hint-danger'
            }`}
            role="status"
          >
            {contactFeedback.msg}
          </p>
        )}
      </form>

      {mergedContacts.length === 0 ? (
        <p className="ag-amail-empty-inline">No contacts yet</p>
      ) : (
        <div className="ag-amail-flat-list" role="list">
          {mergedContacts.map((c) => {
            const isSavedAmailContact = amail.contacts.some(
              (saved) => saved.pubkey.toLowerCase() === c.pubkey.toLowerCase(),
            )
            return (
              <div key={c.pubkey} role="listitem" className="ag-amail-contact-item">
                <img
                  src={identiconDataUrl(c.pubkey)}
                  alt=""
                  width={34}
                  height={34}
                  className="ag-amail-avatar"
                />
                <div className="ag-amail-contact-copy">
                  <div className="ag-amail-contact-name-row">
                    <span
                      className="ag-amail-contact-name truncate"
                      style={{ color: pubkeyToColor(c.pubkey) }}
                    >
                      {c.nickname}
                    </span>
                    {c.isTrustedPeer && (
                      <span className="ag-amail-trusted-tag">
                        <ShieldCheck size={11} />
                        <span>Trusted</span>
                      </span>
                    )}
                  </div>
                  <span className="ag-amail-contact-npub mono truncate">
                    {shortPubkey(c.npub, 12, 6)}
                  </span>
                  {c.notes && <span className="ag-amail-contact-note truncate">{c.notes}</span>}
                </div>
                <div className="ag-amail-contact-actions">
                  <button
                    type="button"
                    className="ag-amail-tonal-btn accent"
                    onClick={() => {
                      onPlaySound?.('click')
                      openFreshComposer({ to: { pubkey: c.pubkey, nickname: c.nickname } })
                    }}
                  >
                    <PenSquare size={12} />
                    <span>Compose</span>
                  </button>
                  <button
                    type="button"
                    className="ag-amail-icon-btn"
                    onClick={() => void copyValue(`c-${c.pubkey}`, c.npub, 'Copied npub')}
                    aria-label={`Copy npub for ${c.nickname}`}
                    {...tipProps('Copy npub')}
                  >
                    {copiedId === `c-${c.pubkey}` ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                  {isSavedAmailContact && (
                    <button
                      type="button"
                      className="ag-amail-icon-btn danger"
                      onClick={() => {
                        onPlaySound?.('click')
                        hideTooltip()
                        void amail.removeContact(c.pubkey)
                      }}
                      aria-label={`Remove ${c.nickname}`}
                      {...tipProps('Remove contact')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  const renderMeshInspector = () => {
    const stats = amail.storageStats
    const st = amail.settings
    const totalPurged = stats.totalDeliveredPurged + stats.totalExpiredPurged

    return (
      <div className="ag-amail-section-scroll">
        <div className="ag-amail-section-head">
          <h3 className="ag-amail-section-title">Mesh &amp; Storage</h3>
        </div>

        {/* Single Borderless Tonal Overview Strip */}
        <div className="ag-amail-overview">
          <div className="ag-amail-overview-bar-head">
            <span className="ag-amail-overview-label">Vault</span>
            <span className="ag-amail-overview-usage mono">
              {formatBytes(stats.vaultBytes)} / {formatBytes(stats.vaultLimitBytes)} · {vaultPct}%
            </span>
          </div>

          <div className="ag-amail-vault-track" aria-hidden="true">
            <span className="ag-amail-vault-fill" style={{ width: `${vaultPct}%` }} />
          </div>

          <div className="ag-amail-metrics-strip">
            <div className="ag-amail-metric">
              <span className="ag-amail-metric-label">Couriers</span>
              <span className="ag-amail-metric-val mono">{connectedCouriers}</span>
            </div>
            <div className="ag-amail-metric">
              <span className="ag-amail-metric-label">Carrying</span>
              <span className="ag-amail-metric-val mono">{stats.vaultCapsuleCount}</span>
            </div>
            <div className="ag-amail-metric">
              <span className="ag-amail-metric-label">Relayed</span>
              <span className="ag-amail-metric-val mono">{stats.totalRelayedOut}</span>
            </div>
            <div className="ag-amail-metric">
              <span className="ag-amail-metric-label">Purged</span>
              <span className="ag-amail-metric-val mono">{totalPurged}</span>
            </div>
            <div className="ag-amail-metric">
              <span className="ag-amail-metric-label">My Mail</span>
              <span className="ag-amail-metric-val mono">{formatBytes(stats.mailBytes)}</span>
            </div>
            <div className="ag-amail-metric">
              <span className="ag-amail-metric-label">Receipts</span>
              <span className="ag-amail-metric-val mono">{stats.tombstoneCount}</span>
            </div>
          </div>
        </div>

        {/* Flat Hairline-Divided Settings */}
        <div className="ag-amail-settings-list">
          <label className="ag-amail-setting-row">
            <div className="ag-amail-setting-copy">
              <span className="ag-amail-setting-title">Peer relay</span>
              <span className="ag-amail-setting-desc">Deliver encrypted mail for offline peers</span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={st.relayEnabled}
              onChange={() => {
                onPlaySound?.('click')
                void amail.updateSettings({ relayEnabled: !st.relayEnabled })
              }}
            />
          </label>

          <label className="ag-amail-setting-row">
            <div className="ag-amail-setting-copy">
              <span className="ag-amail-setting-title">Read receipts</span>
              <span className="ag-amail-setting-desc">Notify senders when opened</span>
            </div>
            <input
              type="checkbox"
              className="ag-switch"
              checked={st.sendReadReceipts}
              onChange={() => {
                onPlaySound?.('click')
                void amail.updateSettings({ sendReadReceipts: !st.sendReadReceipts })
              }}
            />
          </label>

          <div className="ag-amail-setting-row stack">
            <span className="ag-amail-setting-title">Vault limit</span>
            <div className="ag-amail-seg wide" role="group" aria-label="Max relay vault size">
              {VAULT_SIZE_OPTIONS.map((opt) => (
                <button
                  key={opt.bytes}
                  type="button"
                  aria-pressed={st.maxVaultBytes === opt.bytes}
                  className={st.maxVaultBytes === opt.bytes ? 'active' : ''}
                  onClick={() => {
                    onPlaySound?.('click')
                    void amail.updateSettings({ maxVaultBytes: opt.bytes })
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="ag-amail-setting-row stack">
            <span className="ag-amail-setting-title">Max hops</span>
            <div className="ag-amail-seg wide" role="group" aria-label="Max relay hops">
              {MAX_HOPS_OPTIONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  aria-pressed={st.maxHops === h}
                  className={st.maxHops === h ? 'active' : ''}
                  onClick={() => {
                    onPlaySound?.('click')
                    void amail.updateSettings({ maxHops: h })
                  }}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>

          <div className="ag-amail-mesh-actions">
            <button
              type="button"
              className="ag-amail-action-primary compact"
              disabled={amail.isSyncing}
              onClick={() => void handleSyncMesh()}
            >
              <RefreshCw size={13} className={amail.isSyncing ? 'ag-spin' : ''} />
              <span>{amail.isSyncing ? 'Syncing…' : 'Sync'}</span>
            </button>
            <button
              type="button"
              className="ag-amail-tonal-btn"
              onClick={() => void handlePruneExpired()}
            >
              <Clock size={13} />
              <span>Prune Expired</span>
            </button>
            <button
              type="button"
              className={`ag-amail-tonal-btn danger ${confirmPurgeVault ? 'armed' : ''}`}
              onClick={() => void handlePurgeVault()}
            >
              <Trash2 size={13} />
              <span>{confirmPurgeVault ? 'Confirm Purge' : 'Purge Vault'}</span>
            </button>
          </div>

          {meshFeedback && (
            <p className="ag-field-hint ag-field-hint-accent" role="status">
              {meshFeedback}
            </p>
          )}
        </div>

        {/* Clean Borderless Relay Vault Table */}
        <div className="ag-amail-vault-section">
          <h4 className="ag-amail-subsection-title">
            Relay Vault ({amail.relayCapsules.length})
          </h4>

          {amail.relayCapsules.length === 0 ? (
            <p className="ag-amail-empty-inline">No queued items</p>
          ) : (
            <div className="ag-amail-capsule-table" role="table" aria-label="Queued relay items">
              <div className="ag-amail-capsule-row head mono" role="row">
                <span role="columnheader">ID</span>
                <span role="columnheader">Size</span>
                <span role="columnheader">Hops</span>
                <span role="columnheader">Expires</span>
                <span role="columnheader">Route</span>
              </div>
              {amail.relayCapsules.map((cap) => (
                <div key={cap.capsuleId} className="ag-amail-capsule-row mono" role="row">
                  <span role="cell" className="truncate">
                    {cap.capsuleId.slice(0, 12)}…
                  </span>
                  <span role="cell">{formatBytes(cap.sizeBytes)}</span>
                  <span role="cell">
                    {cap.hopCount}/{cap.maxHops}
                  </span>
                  <span role="cell">{formatTtlRemaining(cap.expiresAt)}</span>
                  <span role="cell" className="ag-amail-hint-cell">
                    {cap.recipientHint}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  const content = (
    <>
      {/* Top Bar */}
      <header className="ag-amail-topbar">
        <div className="ag-amail-brand">
          <Mail size={16} className="ag-amail-brand-glyph" aria-hidden="true" />
          <span className="ag-amail-brand-name">Agmail</span>
        </div>

        <div className="ag-amail-topbar-main">
          <div className="ag-amail-search-wrap">
            <Search size={14} className="ag-amail-search-icon" aria-hidden="true" />
            <input
              type="text"
              className="ag-amail-search-input"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                if (section === 'contacts' || section === 'mesh') {
                  setSection('inbox')
                }
                if (selectedMessageId) setSelectedMessageId(null)
              }}
              placeholder="Search…"
              aria-label="Search Agmail messages"
            />
            {searchQuery && (
              <button
                type="button"
                className="ag-amail-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="ag-amail-top-actions">
            <button
              type="button"
              className={`ag-amail-mesh-pill ${connectedCouriers > 0 ? 'live' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                hideTooltip()
                setComposing(false)
                setSelectedMessageId(null)
                setSection('mesh')
              }}
              aria-label="Mesh relay & storage status"
              {...tipProps('Mesh relay & storage status')}
            >
              <span
                className={`ag-amail-mesh-dot ${connectedCouriers > 0 ? 'live' : ''}`}
                aria-hidden="true"
              />
              <span className="ag-hide-xs">
                {connectedCouriers > 0 ? `${connectedCouriers} mesh` : 'Mesh'}
              </span>
            </button>

            <button
              type="button"
              className="ag-amail-icon-btn"
              disabled={amail.isSyncing}
              onClick={() => void handleSyncMesh()}
              aria-label="Sync Agmail mesh now"
              {...tipProps('Sync Agmail mesh now')}
            >
              <RefreshCw size={14} className={amail.isSyncing ? 'ag-spin' : ''} />
            </button>

            <button
              type="button"
              className="ag-amail-mobile-compose-btn"
              onClick={() => {
                onPlaySound?.('click')
                hideTooltip()
                openFreshComposer()
              }}
              aria-label="Compose new Agmail"
              {...tipProps('Compose new Agmail')}
            >
              <Plus size={16} />
            </button>

            {!embedded && (
              <button
                type="button"
                className="ag-amail-icon-btn"
                onClick={() => {
                  hideTooltip()
                  onClose()
                }}
                aria-label="Close Agmail"
                {...tipProps('Close Agmail')}
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      </header>

        {/* Mobile Scrollable Folder Pills */}
        {!composing && !selectedMessage && (
          <>
            <div className="ag-amail-mobile-pills" role="tablist" aria-label="Agmail folders">
              {navFolders.map((f) => {
                const Icon = f.icon
                const active = section === f.id
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`ag-amail-pill-tab ${active ? 'active' : ''}`}
                    onClick={() => {
                      onPlaySound?.('click')
                      setSection(f.id)
                      setSelectedMessageId(null)
                    }}
                  >
                    <Icon size={13} />
                    <span>{f.label}</span>
                    {f.count !== undefined && f.count > 0 && (
                      <span className="ag-amail-pill-count mono">{f.count}</span>
                    )}
                  </button>
                )
              })}

              {displayedCustomFolders.map((folder) => {
                const active = section === folder.id
                const count = folderCounts.customCounts[folder.id] ?? 0
                return (
                  <button
                    key={folder.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`ag-amail-pill-tab ${active ? 'active' : ''}`}
                    onClick={() => {
                      onPlaySound?.('click')
                      setSection(folder.id)
                      setSelectedMessageId(null)
                    }}
                  >
                    <Folder size={13} />
                    <span>{folder.name}</span>
                    {count > 0 && <span className="ag-amail-pill-count mono">{count}</span>}
                  </button>
                )
              })}

              <button
                type="button"
                className={`ag-amail-pill-tab subtle ${creatingFolder ? 'active' : ''}`}
                onClick={() => {
                  onPlaySound?.('click')
                  setCreatingFolder((v) => !v)
                  setNewFolderName('')
                }}
                aria-label="Create new folder"
              >
                <FolderPlus size={13} />
                <span>Folder</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={section === 'contacts'}
                className={`ag-amail-pill-tab ${section === 'contacts' ? 'active' : ''}`}
                onClick={() => {
                  onPlaySound?.('click')
                  setSection('contacts')
                  setSelectedMessageId(null)
                }}
              >
                <Users size={13} />
                <span>Contacts</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={section === 'mesh'}
                className={`ag-amail-pill-tab ${section === 'mesh' ? 'active' : ''}`}
                onClick={() => {
                  onPlaySound?.('click')
                  setSection('mesh')
                  setSelectedMessageId(null)
                }}
              >
                <HardDrive size={13} />
                <span>Mesh</span>
              </button>
            </div>

            {/* Mobile Inline Create / Manage Custom Folder Strip */}
            {(creatingFolder || activeCustomFolder) && (
              <div className="ag-amail-mobile-folder-bar">
                {creatingFolder ? (
                  <form
                    className="ag-amail-mobile-folder-form"
                    onSubmit={(e) => void handleCreateFolderSubmit(e)}
                  >
                    <input
                      type="text"
                      maxLength={32}
                      className="ag-amail-soft-input compact"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="New folder name…"
                      aria-label="New folder name"
                    />
                    <button
                      type="submit"
                      className="ag-amail-tonal-btn accent"
                      disabled={!newFolderName.trim()}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className="ag-amail-icon-btn"
                      onClick={() => {
                        setCreatingFolder(false)
                        setNewFolderName('')
                      }}
                      aria-label="Cancel creating folder"
                    >
                      <X size={14} />
                    </button>
                  </form>
                ) : activeCustomFolder ? (
                  renamingFolderId === activeCustomFolder.id ? (
                    <form
                      className="ag-amail-mobile-folder-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void handleCommitRenameFolder(activeCustomFolder.id)
                      }}
                    >
                      <input
                        type="text"
                        maxLength={32}
                        className="ag-amail-soft-input compact"
                        value={renameFolderDraft}
                        onChange={(e) => setRenameFolderDraft(e.target.value)}
                        aria-label="Rename folder"
                      />
                      <button
                        type="submit"
                        className="ag-amail-tonal-btn accent"
                        disabled={!renameFolderDraft.trim()}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="ag-amail-icon-btn"
                        onClick={() => setRenamingFolderId(null)}
                        aria-label="Cancel rename"
                      >
                        <X size={14} />
                      </button>
                    </form>
                  ) : (
                    <div className="ag-amail-mobile-folder-manage">
                      <span className="ag-amail-mobile-folder-name truncate">
                        <Folder size={13} />
                        <span className="truncate">{activeCustomFolder.name}</span>
                      </span>
                      <div className="ag-amail-mobile-folder-btns">
                        <button
                          type="button"
                          className="ag-amail-tonal-btn compact"
                          onClick={() => {
                            setRenamingFolderId(activeCustomFolder.id)
                            setRenameFolderDraft(activeCustomFolder.name)
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="ag-amail-tonal-btn compact"
                          onClick={handleCycleFolderSort}
                        >
                          {getSortModeShortLabel(amail.folderSortMode)}
                        </button>
                        <button
                          type="button"
                          className="ag-amail-icon-btn"
                          disabled={activeCustomFolderIndex <= 0}
                          onClick={() => handleMoveFolderStep(activeCustomFolder.id, -1)}
                          aria-label="Move folder up"
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="ag-amail-icon-btn"
                          disabled={activeCustomFolderIndex >= displayedCustomFolders.length - 1}
                          onClick={() => handleMoveFolderStep(activeCustomFolder.id, 1)}
                          aria-label="Move folder down"
                        >
                          <ChevronDown size={14} />
                        </button>
                        <button
                          type="button"
                          className={`ag-amail-tonal-btn compact danger ${
                            armedDeleteFolderId === activeCustomFolder.id ? 'armed' : ''
                          }`}
                          onClick={() => void handleDeleteFolderClick(activeCustomFolder.id)}
                        >
                          {armedDeleteFolderId === activeCustomFolder.id ? 'Confirm' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  )
                ) : null}
              </div>
            )}
          </>
        )}

        {/* Body Layout */}
        <div className="ag-amail-body">
          <nav className="ag-amail-rail" aria-label="Agmail folders">
            <button
              type="button"
              className="ag-amail-compose-btn"
              onClick={() => {
                onPlaySound?.('click')
                hideTooltip()
                openFreshComposer()
              }}
              aria-label="Compose new Agmail"
              {...tipProps('Compose new Agmail')}
            >
              <PenSquare size={15} />
              <span>Compose</span>
            </button>

            <div className="ag-amail-nav-list">
              {navFolders.map((f) => {
                const Icon = f.icon
                const active = !composing && section === f.id
                return (
                  <button
                    key={f.id}
                    type="button"
                    className={`ag-amail-nav-item ${active ? 'active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      onPlaySound?.('click')
                      setComposing(false)
                      setSection(f.id)
                      setSelectedMessageId(null)
                    }}
                  >
                    <Icon size={15} />
                    <span className="ag-amail-nav-label truncate">{f.label}</span>
                    {f.count !== undefined && f.count > 0 && (
                      <span
                        className={`ag-amail-nav-badge mono ${
                          f.id === 'inbox' ? 'accent' : ''
                        }`}
                      >
                        {f.count}
                      </span>
                    )}
                  </button>
                )
              })}

              <div className="ag-amail-nav-divider" />

              {/* Custom Folders Section */}
              <div className="ag-amail-folders-head">
                <span className="ag-amail-folders-title">Folders</span>
                <div className="ag-amail-folders-head-actions">
                  <button
                    type="button"
                    className="ag-amail-folder-sort-btn"
                    onClick={handleCycleFolderSort}
                    aria-label="Sort folders (A–Z / Z–A / Manual)"
                    {...tipProps('Sort folders (A–Z / Z–A / Manual)')}
                  >
                    <ArrowUpDown size={11} />
                    <span>{getSortModeShortLabel(amail.folderSortMode)}</span>
                  </button>
                  <button
                    type="button"
                    className="ag-amail-folder-head-btn"
                    onClick={() => {
                      onPlaySound?.('click')
                      hideTooltip()
                      setCreatingFolder((v) => !v)
                      setNewFolderName('')
                    }}
                    aria-label="Create new folder"
                    {...tipProps('Create new folder')}
                  >
                    <Plus size={13} />
                  </button>
                </div>
              </div>

              {creatingFolder && (
                <form
                  className="ag-amail-folder-inline-form"
                  onSubmit={(e) => void handleCreateFolderSubmit(e)}
                >
                  <input
                    ref={newFolderInputRef}
                    type="text"
                    maxLength={32}
                    className="ag-amail-folder-inline-input"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="Folder name…"
                    aria-label="New folder name"
                  />
                  <button
                    type="submit"
                    className="ag-amail-folder-head-btn accent"
                    disabled={!newFolderName.trim()}
                    aria-label="Save new folder"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    type="button"
                    className="ag-amail-folder-head-btn"
                    onClick={() => {
                      setCreatingFolder(false)
                      setNewFolderName('')
                    }}
                    aria-label="Cancel new folder"
                  >
                    <X size={12} />
                  </button>
                </form>
              )}

              {displayedCustomFolders.map((folder, index) => {
                const active = !composing && section === folder.id
                const count = folderCounts.customCounts[folder.id] ?? 0
                const isRenaming = renamingFolderId === folder.id
                const isArmedDelete = armedDeleteFolderId === folder.id
                const isDragging = draggingFolderId === folder.id
                const isDragOver = dragOverFolderId === folder.id

                if (isRenaming) {
                  return (
                    <form
                      key={folder.id}
                      className="ag-amail-folder-inline-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void handleCommitRenameFolder(folder.id)
                      }}
                    >
                      <input
                        ref={renameFolderInputRef}
                        type="text"
                        maxLength={32}
                        className="ag-amail-folder-inline-input"
                        value={renameFolderDraft}
                        onChange={(e) => setRenameFolderDraft(e.target.value)}
                        onBlur={() => void handleCommitRenameFolder(folder.id)}
                        aria-label="Rename folder"
                      />
                    </form>
                  )
                }

                return (
                  <div
                    key={folder.id}
                    draggable
                    onDragStart={(e) => {
                      setDraggingFolderId(folder.id)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', folder.id)
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      if (dragOverFolderId !== folder.id) setDragOverFolderId(folder.id)
                    }}
                    onDragLeave={() => {
                      if (dragOverFolderId === folder.id) setDragOverFolderId(null)
                    }}
                    onDrop={(e) => handleFolderDrop(e, folder.id)}
                    onDragEnd={() => {
                      setDraggingFolderId(null)
                      setDragOverFolderId(null)
                    }}
                    onContextMenu={(e) => openFolderContextMenu(e, folder, index)}
                    className={`ag-amail-custom-folder-row ${active ? 'active' : ''} ${
                      isDragging ? 'dragging' : ''
                    } ${isDragOver ? 'drag-over' : ''}`}
                  >
                    <button
                      type="button"
                      className="ag-amail-custom-folder-main"
                      aria-current={active ? 'page' : undefined}
                      onClick={() => {
                        onPlaySound?.('click')
                        setComposing(false)
                        setSection(folder.id)
                        setSelectedMessageId(null)
                      }}
                    >
                      <Folder size={14} />
                      <span className="ag-amail-nav-label truncate">{folder.name}</span>
                      {count > 0 && <span className="ag-amail-nav-badge mono">{count}</span>}
                    </button>
                    <div
                      className={`ag-amail-folder-row-actions ${isArmedDelete ? 'visible' : ''}`}
                    >
                      <button
                        type="button"
                        className="ag-amail-folder-mini-btn"
                        disabled={index === 0}
                        onClick={() => handleMoveFolderStep(folder.id, -1)}
                        aria-label="Move folder up"
                        {...tipProps('Move folder up')}
                      >
                        <ChevronUp size={11} />
                      </button>
                      <button
                        type="button"
                        className="ag-amail-folder-mini-btn"
                        disabled={index >= displayedCustomFolders.length - 1}
                        onClick={() => handleMoveFolderStep(folder.id, 1)}
                        aria-label="Move folder down"
                        {...tipProps('Move folder down')}
                      >
                        <ChevronDown size={11} />
                      </button>
                      <button
                        type="button"
                        className="ag-amail-folder-mini-btn"
                        onClick={() => {
                          hideTooltip()
                          setRenamingFolderId(folder.id)
                          setRenameFolderDraft(folder.name)
                        }}
                        aria-label="Rename folder"
                        {...tipProps('Rename folder')}
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        className={`ag-amail-folder-mini-btn danger ${isArmedDelete ? 'armed' : ''}`}
                        onClick={() => void handleDeleteFolderClick(folder.id)}
                        aria-label={isArmedDelete ? 'Confirm delete folder' : 'Delete folder'}
                        {...tipProps(
                          isArmedDelete ? 'Click again to delete folder' : 'Delete folder',
                        )}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                )
              })}

              <div className="ag-amail-nav-divider" />

              <button
                type="button"
                className={`ag-amail-nav-item ${!composing && section === 'contacts' ? 'active' : ''}`}
                aria-current={!composing && section === 'contacts' ? 'page' : undefined}
                onClick={() => {
                  onPlaySound?.('click')
                  setComposing(false)
                  setSection('contacts')
                  setSelectedMessageId(null)
                }}
              >
                <Users size={15} />
                <span className="ag-amail-nav-label truncate">Contacts</span>
                {mergedContacts.length > 0 && (
                  <span className="ag-amail-nav-badge mono">{mergedContacts.length}</span>
                )}
              </button>

              <button
                type="button"
                className={`ag-amail-nav-item ${!composing && section === 'mesh' ? 'active' : ''}`}
                aria-current={!composing && section === 'mesh' ? 'page' : undefined}
                onClick={() => {
                  onPlaySound?.('click')
                  setComposing(false)
                  setSection('mesh')
                  setSelectedMessageId(null)
                }}
              >
                <HardDrive size={15} />
                <span className="ag-amail-nav-label truncate">Mesh &amp; Storage</span>
                <span className="ag-amail-nav-badge mono">
                  {formatBytes(amail.storageStats.vaultBytes)}
                </span>
              </button>
            </div>
          </nav>

          <main className="ag-amail-main">
            {composing
              ? renderCompose()
              : section === 'contacts'
                ? renderContacts()
                : section === 'mesh'
                  ? renderMeshInspector()
                  : selectedMessage
                    ? renderReader(selectedMessage)
                    : renderMailList()}
          </main>
        </div>
    </>
  )

  const portals = (
    <>
      {/* Portal: Move-to-Folder Popover */}
      {folderPicker &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={folderPickerRef}
            className="ag-amail-folder-popover"
            role="menu"
            aria-label="Move to folder"
            style={
              folderPickerCoords
                ? { left: `${folderPickerCoords.left}px`, top: `${folderPickerCoords.top}px` }
                : { left: '-9999px', top: '-9999px' }
            }
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ag-amail-popover-head">Move to folder</div>
            {(
              [
                { id: 'inbox' as const, label: 'Inbox', icon: Inbox },
                { id: 'archive' as const, label: 'Archive', icon: Archive },
                { id: 'trash' as const, label: 'Trash', icon: Trash2 },
              ] as const
            ).map((item) => {
              const Icon = item.icon
              const isCurrent = folderPicker.currentFolder === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className={`ag-amail-popover-item ${isCurrent ? 'current' : ''} ${
                    item.id === 'trash' ? 'danger' : ''
                  }`}
                  onClick={() =>
                    void handleMoveMessagesToFolder(
                      folderPicker.targetIds,
                      item.id,
                      folderPicker.closeReaderOnMove,
                    )
                  }
                >
                  <Icon size={13} />
                  <span className="ag-amail-popover-label truncate">{item.label}</span>
                  {isCurrent && <Check size={13} className="ag-amail-popover-check" />}
                </button>
              )
            })}

            {displayedCustomFolders.length > 0 && (
              <>
                <div className="ag-amail-popover-divider" />
                {displayedCustomFolders.map((folder) => {
                  const isCurrent = folderPicker.currentFolder === folder.id
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      role="menuitem"
                      className={`ag-amail-popover-item ${isCurrent ? 'current' : ''}`}
                      onClick={() =>
                        void handleMoveMessagesToFolder(
                          folderPicker.targetIds,
                          folder.id,
                          folderPicker.closeReaderOnMove,
                        )
                      }
                    >
                      <Folder size={13} />
                      <span className="ag-amail-popover-label truncate">{folder.name}</span>
                      {isCurrent && <Check size={13} className="ag-amail-popover-check" />}
                    </button>
                  )
                })}
              </>
            )}
          </div>,
          document.body,
        )}

      {/* Portal: Unclipped Custom Mouseover Tooltip */}
      {tooltip &&
        tooltipCoords &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className={`ag-amail-tooltip ${tooltipCoords.placement === 'below' ? 'is-below' : 'is-above'}`}
            style={{
              left: `${tooltipCoords.left}px`,
              top: `${tooltipCoords.top}px`,
            }}
          >
            {tooltip.text}
          </div>,
          document.body,
        )}
    </>
  )

  if (embedded) {
    return (
      <div
        className="ag-amail-workspace"
        aria-label="Agmail"
        data-no-swipe="true"
      >
        {content}
        {portals}
      </div>
    )
  }

  return (
    <div
      className={`ag-amail-backdrop ${inShell ? 'in-shell' : ''}`}
      onClick={inShell ? undefined : onClose}
      role="presentation"
      data-no-swipe="true"
    >
      <div
        className="ag-amail-shell"
        role="dialog"
        aria-modal="true"
        aria-label="Agmail"
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </div>
      {portals}
    </div>
  )
}

export default AmailView
