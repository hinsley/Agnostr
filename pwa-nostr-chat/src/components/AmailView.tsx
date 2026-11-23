import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  Copy,
  Database,
  FileText,
  Forward,
  HardDrive,
  Inbox,
  Lock,
  Mail,
  MailOpen,
  PenSquare,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  Reply,
  Search,
  Send,
  ShieldCheck,
  Star,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import type { AgnostrEngine } from '../types/protocol.ts'
import type {
  AmailContact,
  AmailDeliveryStatus,
  AmailFolder,
  AmailMessage,
} from '../types/amail.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { encodeNpubSafe } from '../lib/identity.ts'
import { parseShareTarget } from '../lib/shareLinks.ts'
import { RichMessageContent } from '../utils/markdown.tsx'
import { identiconDataUrl, pubkeyToColor, shortPubkey } from '../utils/identicon.ts'
import type { SoundCue } from '../utils/sound.ts'
import { useContextMenu, type ContextMenuItem } from './ContextMenu.tsx'
import '../styles/amail.css'

export type AmailInitialSection = 'inbox' | 'compose' | 'contacts' | 'mesh'

export interface AmailComposeTarget {
  pubkey: string
  nickname?: string
}

export interface AmailViewProps {
  open: boolean
  inShell?: boolean
  onClose: () => void
  engine: AgnostrEngine
  initialSection?: AmailInitialSection
  initialComposeTo?: AmailComposeTarget | null
  onOpenScanner?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

type AmailNavSection = AmailFolder | 'contacts' | 'mesh'

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
      pubkey: parsed.pubkey,
      npub: parsed.npub,
      nickname: parsed.nickname,
    }
  }
  return null
}

function formatDeliveryPill(msg: AmailMessage): {
  label: string
  tone: 'muted' | 'accent' | 'danger'
} {
  if (msg.direction === 'in') {
    if (msg.relayHopCount > 0) {
      return {
        label: `Encrypted · ${msg.relayHopCount} ${msg.relayHopCount === 1 ? 'hop' : 'hops'}`,
        tone: 'accent',
      }
    }
    return { label: 'E2EE Mesh Delivery', tone: 'accent' }
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
            ? `Relayed via ${msg.relayedPeerCount} mesh ${msg.relayedPeerCount === 1 ? 'peer' : 'peers'}`
            : 'Relayed into mesh',
        tone: 'muted',
      }
    case 'expired':
      return { label: 'Mesh TTL expired', tone: 'danger' }
    case 'draft':
      return { label: 'Draft', tone: 'muted' }
    case 'queued':
    default:
      return { label: 'Queued for mesh couriers', tone: 'muted' }
  }
}

function renderStatusIcon(status: AmailDeliveryStatus) {
  switch (status) {
    case 'read':
      return (
        <span className="ag-amail-receipt read" title="Read by recipient">
          <CheckCheck size={13} />
        </span>
      )
    case 'delivered':
      return (
        <span className="ag-amail-receipt delivered" title="Delivered (ACK received)">
          <Check size={13} />
        </span>
      )
    case 'relayed':
      return (
        <span className="ag-amail-receipt relayed" title="Relayed to mesh couriers">
          <Radio size={12} />
        </span>
      )
    case 'expired':
      return (
        <span className="ag-amail-receipt expired" title="Mesh TTL expired before delivery">
          <AlertCircle size={12} />
        </span>
      )
    case 'draft':
      return <span className="ag-amail-draft-pill">Draft</span>
    case 'queued':
    default:
      return (
        <span className="ag-amail-receipt queued" title="Queued in local mesh outbox">
          <Clock size={12} />
        </span>
      )
  }
}

export function AmailView({
  open,
  inShell = false,
  onClose,
  engine,
  initialSection = 'inbox',
  initialComposeTo = null,
  onOpenScanner,
  onPlaySound,
}: AmailViewProps) {
  const { amail } = engine
  const { openContextMenu } = useContextMenu()

  const [section, setSection] = useState<AmailNavSection>('inbox')
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Compose state
  const [composing, setComposing] = useState(false)
  const [composeDraftId, setComposeDraftId] = useState<string | undefined>(undefined)
  const [composeThreadId, setComposeThreadId] = useState<string | undefined>(undefined)
  const [composeInReplyTo, setComposeInReplyTo] = useState<string | undefined>(undefined)
  const [toInput, setToInput] = useState('')
  const [selectedRecipient, setSelectedRecipient] = useState<{
    pubkey: string
    npub: string
    nickname: string
  } | null>(null)
  const [toDropdownOpen, setToDropdownOpen] = useState(false)
  const [subjectDraft, setSubjectDraft] = useState('')
  const [bodyDraft, setBodyDraft] = useState('')
  const [composeTab, setComposeTab] = useState<'write' | 'preview'>('write')
  const [requestReceipt, setRequestReceipt] = useState(true)
  const [composeTtlSec, setComposeTtlSec] = useState(amail.settings.defaultTtlSec)
  const [sendingMail, setSendingMail] = useState(false)
  const [composeError, setComposeError] = useState<string | null>(null)

  // Contacts add form state
  const [contactKeyDraft, setContactKeyDraft] = useState('')
  const [contactNickDraft, setContactNickDraft] = useState('')
  const [contactNoteDraft, setContactNoteDraft] = useState('')
  const [contactFeedback, setContactFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  // Mesh vault purge 2-tap confirm
  const [confirmPurgeVault, setConfirmPurgeVault] = useState(false)
  const [meshFeedback, setMeshFeedback] = useState<string | null>(null)

  const toWrapRef = useRef<HTMLDivElement | null>(null)
  const openFreshComposerRef = useRef<
    | ((opts?: {
        to?: { pubkey: string; nickname?: string } | null
        subject?: string
        body?: string
        draftId?: string
        threadId?: string
        inReplyTo?: string
        requestReadReceipt?: boolean
        ttlSec?: number
      }) => void)
    | null
  >(null)

  // Merge Amail contacts + Trusted Peers for autocomplete & contacts directory
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

  const openFreshComposer = useCallback(
    (opts?: {
      to?: { pubkey: string; nickname?: string } | null
      subject?: string
      body?: string
      draftId?: string
      threadId?: string
      inReplyTo?: string
      requestReadReceipt?: boolean
      ttlSec?: number
    }) => {
      setComposeDraftId(opts?.draftId)
      setComposeThreadId(opts?.threadId)
      setComposeInReplyTo(opts?.inReplyTo)
      if (opts?.to?.pubkey) {
        const pk = opts.to.pubkey.toLowerCase()
        const known = mergedContacts.find((c) => c.pubkey.toLowerCase() === pk)
        const nick = opts.to.nickname?.trim() || known?.nickname || shortPubkey(pk, 8, 6)
        const npub = known?.npub || encodeNpubSafe(pk)
        setSelectedRecipient({ pubkey: pk, npub, nickname: nick })
        setToInput('')
      } else {
        setSelectedRecipient(null)
        setToInput('')
      }
      setSubjectDraft(opts?.subject ?? '')
      setBodyDraft(opts?.body ?? '')
      setComposeTab('write')
      setRequestReceipt(opts?.requestReadReceipt ?? true)
      setComposeTtlSec(opts?.ttlSec ?? amail.settings.defaultTtlSec)
      setComposeError(null)
      setToDropdownOpen(false)
      setComposing(true)
    },
    [mergedContacts, amail.settings.defaultTtlSec],
  )

  openFreshComposerRef.current = openFreshComposer

  const initialComposePubkey = initialComposeTo?.pubkey ?? null
  const initialComposeNickname = initialComposeTo?.nickname

  // Sync only when Amail opens or navigation intent props genuinely change
  useEffect(() => {
    if (!open) return
    setSearchQuery('')
    setSelectedMessageId(null)
    setConfirmPurgeVault(false)
    setMeshFeedback(null)

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

  // Android / PWA Back button LIFO: Composer -> Reader -> Non-Inbox Section -> Close
  useBackHandler(open, onClose)
  useBackHandler(open && section !== 'inbox' && !selectedMessageId && !composing, () =>
    setSection('inbox'),
  )
  useBackHandler(open && Boolean(selectedMessageId) && !composing, () =>
    setSelectedMessageId(null),
  )
  useBackHandler(open && composing, () => setComposing(false))

  // Escape step-back
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (toDropdownOpen) {
        setToDropdownOpen(false)
      } else if (composing) {
        setComposing(false)
      } else if (selectedMessageId) {
        setSelectedMessageId(null)
      } else {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, toDropdownOpen, composing, selectedMessageId, onClose])

  // Close To: autocomplete dropdown on outside click
  useEffect(() => {
    if (!toDropdownOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (toWrapRef.current && !toWrapRef.current.contains(e.target as Node)) {
        setToDropdownOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [toDropdownOpen])

  const folderCounts = useMemo(() => {
    let starred = 0
    let drafts = 0
    for (const m of amail.messages) {
      if (m.isStarred && m.folder !== 'trash') starred += 1
      if (m.folder === 'drafts') drafts += 1
    }
    return { starred, drafts }
  }, [amail.messages])

  const visibleMessages = useMemo(() => {
    if (section === 'contacts' || section === 'mesh') return []
    const q = searchQuery.trim().toLowerCase()
    return amail.messages
      .filter((m) => {
        if (section === 'starred') {
          if (!m.isStarred || m.folder === 'trash') return false
        } else if (m.folder !== section) {
          return false
        }
        if (!q) return true
        return (
          m.subject.toLowerCase().includes(q) ||
          m.body.toLowerCase().includes(q) ||
          m.fromName.toLowerCase().includes(q) ||
          m.toName.toLowerCase().includes(q) ||
          m.fromNpub.toLowerCase().includes(q) ||
          m.toNpub.toLowerCase().includes(q)
        )
      })
      .sort((a, b) => b.sentAt - a.sentAt)
  }, [amail.messages, section, searchQuery])

  const selectedMessage = useMemo(
    () =>
      selectedMessageId
        ? (amail.messages.find((m) => m.id === selectedMessageId) ?? null)
        : null,
    [amail.messages, selectedMessageId],
  )

  const threadMessages = useMemo(() => {
    if (!selectedMessage) return []
    const tid = selectedMessage.threadId
    if (!tid) return [selectedMessage]
    const siblings = amail.messages
      .filter((m) => m.threadId === tid && m.folder !== 'drafts' && (m.folder !== 'trash' || m.id === selectedMessage.id))
      .sort((a, b) => a.sentAt - b.sentAt)
    return siblings.length > 0 ? siblings : [selectedMessage]
  }, [amail.messages, selectedMessage])

  const autocompleteMatches = useMemo(() => {
    const q = toInput.trim().toLowerCase()
    if (!q) return mergedContacts.slice(0, 8)
    return mergedContacts
      .filter(
        (c) =>
          c.nickname.toLowerCase().includes(q) ||
          c.npub.toLowerCase().includes(q) ||
          c.pubkey.toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [mergedContacts, toInput])

  if (!open) return null

  const connectedCouriers = amail.meshPeers.filter((p) => p.state === 'connected').length
  const vaultPct = Math.min(
    100,
    Math.round(
      (amail.storageStats.vaultBytes / Math.max(1, amail.storageStats.vaultLimitBytes)) * 100,
    ),
  )

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

  const handleOpenMessage = (msg: AmailMessage) => {
    onPlaySound?.('click')
    if (msg.folder === 'drafts') {
      openFreshComposer({
        to: msg.toPubkey ? { pubkey: msg.toPubkey, nickname: msg.toName } : null,
        subject: msg.subject,
        body: msg.body,
        draftId: msg.id,
        threadId: msg.threadId,
        inReplyTo: msg.inReplyTo,
        requestReadReceipt: msg.requestReadReceipt,
        ttlSec: msg.ttlSec,
      })
      return
    }
    setSelectedMessageId(msg.id)
    if (!msg.isRead) {
      void amail.markRead(msg.id, true)
    }
  }

  const handleReply = (msg: AmailMessage) => {
    onPlaySound?.('click')
    const replyPubkey = msg.direction === 'in' ? msg.fromPubkey : msg.toPubkey
    const replyName = msg.direction === 'in' ? msg.fromName : msg.toName
    const nextSubject = /^re:/i.test(msg.subject.trim())
      ? msg.subject.trim()
      : `Re: ${msg.subject.trim() || '(no subject)'}`
    openFreshComposer({
      to: { pubkey: replyPubkey, nickname: replyName },
      subject: nextSubject,
      body: '',
      threadId: msg.threadId,
      inReplyTo: msg.id,
    })
  }

  const handleForward = (msg: AmailMessage) => {
    onPlaySound?.('click')
    const nextSubject = /^fwd:/i.test(msg.subject.trim())
      ? msg.subject.trim()
      : `Fwd: ${msg.subject.trim() || '(no subject)'}`
    const quoted = `\n\n---\n**Forwarded from ${msg.fromName}** (${formatFullDateTime(msg.sentAt)})\n\n${msg.body}`
    openFreshComposer({
      to: null,
      subject: nextSubject,
      body: quoted,
    })
  }

  const openMessageContextMenu = (e: ReactMouseEvent, msg: AmailMessage) => {
    const items: ContextMenuItem[] = [
      {
        id: 'open',
        label: msg.folder === 'drafts' ? 'Edit Draft' : 'Open',
        icon: <MailOpen size={14} />,
        onSelect: () => handleOpenMessage(msg),
      },
    ]

    if (msg.folder !== 'drafts') {
      items.push(
        {
          id: 'reply',
          label: 'Reply',
          icon: <Reply size={14} />,
          onSelect: () => handleReply(msg),
        },
        {
          id: 'toggle-read',
          label: msg.isRead ? 'Mark as Unread' : 'Mark as Read',
          icon: msg.isRead ? <Mail size={14} /> : <MailOpen size={14} />,
          onSelect: () => {
            onPlaySound?.('click')
            void amail.markRead(msg.id, !msg.isRead)
          },
        },
        {
          id: 'toggle-star',
          label: msg.isStarred ? 'Remove Star' : 'Star',
          icon: <Star size={14} />,
          onSelect: () => {
            onPlaySound?.('click')
            void amail.toggleStar(msg.id)
          },
        },
        {
          id: 'archive',
          label: msg.folder === 'archive' ? 'Move to Inbox' : 'Archive',
          icon: <Archive size={14} />,
          dividerBefore: true,
          onSelect: () => {
            onPlaySound?.('click')
            const targetFolder: AmailFolder = msg.folder === 'archive' ? 'inbox' : 'archive'
            void amail.moveToFolder(msg.id, targetFolder)
            if (selectedMessageId === msg.id) setSelectedMessageId(null)
          },
        },
      )
    }

    items.push({
      id: 'delete',
      label: msg.folder === 'trash' || msg.folder === 'drafts' ? 'Delete Permanently' : 'Move to Trash',
      icon: <Trash2 size={14} />,
      danger: true,
      dividerBefore: msg.folder === 'drafts',
      onSelect: () => {
        onPlaySound?.('click')
        if (msg.folder === 'drafts') {
          void amail.deleteDraft(msg.id)
        } else if (msg.folder === 'trash') {
          void amail.deletePermanently(msg.id)
        } else {
          void amail.moveToFolder(msg.id, 'trash')
        }
        if (selectedMessageId === msg.id) setSelectedMessageId(null)
      },
    })

    openContextMenu(e, {
      header: msg.subject.trim() || '(no subject)',
      items,
    })
  }

  const resolveRecipientForCompose = (): { pubkey: string; npub: string; nickname: string } | null => {
    if (selectedRecipient) return selectedRecipient
    const parsed = resolvePubkeyInput(toInput)
    if (!parsed) return null
    const known = mergedContacts.find((c) => c.pubkey.toLowerCase() === parsed.pubkey.toLowerCase())
    return {
      pubkey: parsed.pubkey,
      npub: parsed.npub,
      nickname: parsed.nickname || known?.nickname || shortPubkey(parsed.pubkey, 8, 6),
    }
  }

  const handleSendMail = async (e: FormEvent) => {
    e.preventDefault()
    if (sendingMail) return
    const recipient = resolveRecipientForCompose()
    if (!recipient) {
      setComposeError('Select a contact or paste a valid npub1…, 64-char hex pubkey, or #dm= link.')
      return
    }
    if (!subjectDraft.trim() && !bodyDraft.trim()) {
      setComposeError('Add a subject or message body before sending.')
      return
    }

    setComposeError(null)
    setSendingMail(true)
    try {
      const sent = await amail.sendMail({
        toPubkey: recipient.pubkey,
        subject: subjectDraft.trim() || '(no subject)',
        body: bodyDraft,
        inReplyTo: composeInReplyTo,
        threadId: composeThreadId,
        requestReadReceipt: requestReceipt,
        ttlSec: composeTtlSec,
        draftId: composeDraftId,
      })
      if (sent) {
        onPlaySound?.('send')
        setComposing(false)
        setSection('sent')
        setSelectedMessageId(sent.id)
      }
    } finally {
      setSendingMail(false)
    }
  }

  const handleSaveDraft = async () => {
    const recipient = resolveRecipientForCompose()
    const saved = await amail.saveDraft({
      id: composeDraftId,
      toPubkey: recipient?.pubkey,
      subject: subjectDraft.trim(),
      body: bodyDraft,
      inReplyTo: composeInReplyTo,
      threadId: composeThreadId,
      requestReadReceipt: requestReceipt,
      ttlSec: composeTtlSec,
    })
    setComposeDraftId(saved.id)
    onPlaySound?.('click')
    engine.pushToast('info', 'Saved Amail draft')
    setSelectedMessageId(null)
    setComposing(false)
    setSection('drafts')
  }

  const handleDiscardCompose = () => {
    onPlaySound?.('click')
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
      setContactFeedback({ ok: true, msg: `Saved contact ${added.nickname}` })
    } else {
      setContactFeedback({
        ok: false,
        msg: 'Enter a valid npub1…, 64-char hex pubkey, or Agnostr #dm= link.',
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
    setMeshFeedback('Purged all third-party relay capsules from local vault.')
  }

  const handlePruneExpired = async () => {
    onPlaySound?.('click')
    const removed = await amail.pruneExpired()
    setMeshFeedback(
      removed > 0
        ? `Pruned ${removed} expired ${removed === 1 ? 'capsule' : 'capsules'}.`
        : 'No expired capsules to prune.',
    )
  }

  const handleSyncMesh = async () => {
    onPlaySound?.('click')
    setMeshFeedback(null)
    await amail.syncMeshNow()
  }

  const navFolders: readonly {
    id: AmailFolder
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

  const renderMailList = () => (
    <div className="ag-amail-list-pane">
      {visibleMessages.length === 0 ? (
        <div className="ag-amail-empty">
          <div className="ag-amail-empty-icon" aria-hidden="true">
            <Mail size={22} />
          </div>
          <p className="ag-amail-empty-title">
            {searchQuery.trim()
              ? 'No messages match your search'
              : section === 'inbox'
                ? 'Your encrypted mesh inbox is empty'
                : `No messages in ${section}`}
          </p>
          <p className="ag-amail-empty-sub">
            Amail delivers end-to-end encrypted messages across peer-to-peer WebRTC mesh couriers
            with zero email servers.
          </p>
          {section === 'inbox' && !searchQuery.trim() && (
            <button
              type="button"
              className="ag-btn ag-btn-primary ag-btn-sm"
              onClick={() => {
                onPlaySound?.('click')
                openFreshComposer()
              }}
            >
              <PenSquare size={14} />
              <span>Compose Amail</span>
            </button>
          )}
        </div>
      ) : (
        <div className="ag-amail-rows" role="list" aria-label={`${section} messages`}>
          {visibleMessages.map((msg) => {
            const isUnread = !msg.isRead && msg.direction === 'in'
            const counterpartyName =
              msg.direction === 'out'
                ? `To: ${msg.toName || shortPubkey(msg.toPubkey, 6, 4)}`
                : msg.fromName || shortPubkey(msg.fromPubkey, 6, 4)
            const counterpartyPubkey = msg.direction === 'out' ? msg.toPubkey : msg.fromPubkey
            const snippet = buildBodySnippet(msg.body)

            return (
              <div
                key={msg.id}
                role="listitem"
                className={`ag-amail-row ${isUnread ? 'unread' : ''}`}
                onClick={() => handleOpenMessage(msg)}
                onContextMenu={(e) => openMessageContextMenu(e, msg)}
              >
                <button
                  type="button"
                  className={`ag-amail-star-btn ${msg.isStarred ? 'starred' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onPlaySound?.('click')
                    void amail.toggleStar(msg.id)
                  }}
                  title={msg.isStarred ? 'Unstar' : 'Star'}
                  aria-label={msg.isStarred ? 'Unstar message' : 'Star message'}
                >
                  <Star size={14} fill={msg.isStarred ? 'currentColor' : 'none'} />
                </button>

                <div className="ag-amail-row-main">
                  <div className="ag-amail-row-sender-col">
                    {isUnread && <span className="ag-amail-unread-dot" aria-hidden="true" />}
                    <span
                      className="ag-amail-row-sender truncate"
                      style={{ color: counterpartyPubkey ? pubkeyToColor(counterpartyPubkey) : undefined }}
                    >
                      {counterpartyName}
                    </span>
                  </div>

                  <div className="ag-amail-row-content-col">
                    <span className="ag-amail-row-subject truncate">
                      {msg.subject.trim() || '(no subject)'}
                    </span>
                    {snippet && (
                      <span className="ag-amail-row-snippet truncate"> — {snippet}</span>
                    )}
                  </div>
                </div>

                <div className="ag-amail-row-right">
                  {msg.direction === 'out' && renderStatusIcon(msg.deliveryStatus)}
                  <span className="ag-amail-row-time mono">{formatMailTimestamp(msg.sentAt)}</span>

                  <div className="ag-amail-row-hover-actions" onClick={(e) => e.stopPropagation()}>
                    {msg.folder !== 'drafts' && (
                      <>
                        <button
                          type="button"
                          className="ag-icon-btn-xs"
                          onClick={() => {
                            onPlaySound?.('click')
                            void amail.markRead(msg.id, !msg.isRead)
                          }}
                          title={msg.isRead ? 'Mark unread' : 'Mark read'}
                          aria-label={msg.isRead ? 'Mark unread' : 'Mark read'}
                        >
                          {msg.isRead ? <Mail size={13} /> : <MailOpen size={13} />}
                        </button>
                        <button
                          type="button"
                          className="ag-icon-btn-xs"
                          onClick={() => {
                            onPlaySound?.('click')
                            void amail.moveToFolder(
                              msg.id,
                              msg.folder === 'archive' ? 'inbox' : 'archive',
                            )
                          }}
                          title={msg.folder === 'archive' ? 'Move to Inbox' : 'Archive'}
                          aria-label={msg.folder === 'archive' ? 'Move to Inbox' : 'Archive'}
                        >
                          <Archive size={13} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="ag-icon-btn-xs ag-icon-btn-danger"
                      onClick={() => {
                        onPlaySound?.('click')
                        if (msg.folder === 'drafts') {
                          void amail.deleteDraft(msg.id)
                        } else if (msg.folder === 'trash') {
                          void amail.deletePermanently(msg.id)
                        } else {
                          void amail.moveToFolder(msg.id, 'trash')
                        }
                      }}
                      title={
                        msg.folder === 'trash' || msg.folder === 'drafts'
                          ? 'Delete permanently'
                          : 'Move to Trash'
                      }
                      aria-label="Delete message"
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
    const statusPill = formatDeliveryPill(msg)
    return (
      <div className="ag-amail-reader">
        <div className="ag-amail-reader-toolbar">
          <button
            type="button"
            className="ag-btn ag-btn-ghost ag-btn-xs"
            onClick={() => {
              onPlaySound?.('click')
              setSelectedMessageId(null)
            }}
          >
            <ArrowLeft size={14} />
            <span>Back</span>
          </button>

          <div className="ag-amail-reader-actions">
            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-xs"
              onClick={() => handleReply(msg)}
            >
              <Reply size={13} />
              <span>Reply</span>
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-xs"
              onClick={() => handleForward(msg)}
            >
              <Forward size={13} />
              <span>Forward</span>
            </button>
            <button
              type="button"
              className={`ag-icon-btn-sm ${msg.isStarred ? 'ag-amail-star-active' : ''}`}
              onClick={() => {
                onPlaySound?.('click')
                void amail.toggleStar(msg.id)
              }}
              title={msg.isStarred ? 'Unstar' : 'Star'}
              aria-label={msg.isStarred ? 'Unstar message' : 'Star message'}
            >
              <Star size={14} fill={msg.isStarred ? 'currentColor' : 'none'} />
            </button>
            <button
              type="button"
              className="ag-icon-btn-sm"
              onClick={() => {
                onPlaySound?.('click')
                void amail.moveToFolder(msg.id, msg.folder === 'archive' ? 'inbox' : 'archive')
                setSelectedMessageId(null)
              }}
              title={msg.folder === 'archive' ? 'Move to Inbox' : 'Archive'}
              aria-label={msg.folder === 'archive' ? 'Move to Inbox' : 'Archive'}
            >
              <Archive size={14} />
            </button>
            <button
              type="button"
              className="ag-icon-btn-sm ag-icon-btn-danger"
              onClick={() => {
                onPlaySound?.('click')
                if (msg.folder === 'trash') {
                  void amail.deletePermanently(msg.id)
                } else {
                  void amail.moveToFolder(msg.id, 'trash')
                }
                setSelectedMessageId(null)
              }}
              title={msg.folder === 'trash' ? 'Delete permanently' : 'Move to Trash'}
              aria-label="Delete message"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="ag-amail-reader-scroll">
          <div className="ag-amail-reader-head">
            <h2 className="ag-amail-reader-subject">{msg.subject.trim() || '(no subject)'}</h2>
            <div className="ag-amail-reader-badges">
              <span className={`ag-amail-status-pill ${statusPill.tone}`}>
                {msg.deliveryStatus === 'read' ? (
                  <CheckCheck size={12} />
                ) : (
                  <Lock size={11} />
                )}
                <span>{statusPill.label}</span>
              </span>
              {threadMessages.length > 1 && (
                <span className="ag-badge ag-badge-muted mono">
                  {threadMessages.length} messages
                </span>
              )}
            </div>
          </div>

          <div className="ag-amail-thread-stack">
            {threadMessages.map((item) => {
              const itemPill = formatDeliveryPill(item)
              return (
                <article key={item.id} className="ag-amail-message-card">
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
                            {item.fromName}
                          </span>
                          <button
                            type="button"
                            className="ag-amail-npub-chip mono"
                            onClick={() =>
                              void copyValue(`from-${item.id}`, item.fromNpub, 'Copied sender npub')
                            }
                            title={`Copy ${item.fromNpub}`}
                          >
                            <span>{shortPubkey(item.fromNpub, 8, 5)}</span>
                            {copiedId === `from-${item.id}` ? (
                              <Check size={10} />
                            ) : (
                              <Copy size={10} />
                            )}
                          </button>
                        </div>
                        <div className="ag-amail-msg-to-row">
                          <span>To: {item.toName}</span>
                          <button
                            type="button"
                            className="ag-amail-npub-chip subtle mono"
                            onClick={() =>
                              void copyValue(`to-${item.id}`, item.toNpub, 'Copied recipient npub')
                            }
                            title={`Copy ${item.toNpub}`}
                          >
                            <span>{shortPubkey(item.toNpub, 7, 4)}</span>
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="ag-amail-msg-time-col">
                      <span className="ag-amail-msg-time mono">
                        {formatFullDateTime(item.sentAt)}
                      </span>
                      {threadMessages.length > 1 && (
                        <span className={`ag-amail-status-inline ${itemPill.tone}`}>
                          {itemPill.label}
                        </span>
                      )}
                    </div>
                  </header>

                  <div className="ag-amail-msg-body">
                    <RichMessageContent
                      content={item.body}
                      onTuneGeohash={(gh) => {
                        engine.tuneGeohash(gh)
                        onClose()
                      }}
                    />
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const renderCompose = () => (
    <form className="ag-amail-compose" onSubmit={(e) => void handleSendMail(e)}>
      <div className="ag-amail-compose-head">
        <div className="ag-amail-compose-title-wrap">
          <button
            type="button"
            className="ag-btn ag-btn-ghost ag-btn-xs"
            onClick={() => {
              onPlaySound?.('click')
              setComposing(false)
            }}
          >
            <ArrowLeft size={14} />
            <span>Back</span>
          </button>
          <span className="ag-amail-compose-title">New Encrypted Amail</span>
        </div>
        <div className="ag-amail-compose-head-actions">
          <button
            type="button"
            className="ag-btn ag-btn-secondary ag-btn-xs"
            onClick={() => void handleSaveDraft()}
          >
            <span>Save Draft</span>
          </button>
          <button
            type="button"
            className="ag-icon-btn-xs ag-icon-btn-danger"
            onClick={handleDiscardCompose}
            title="Discard draft"
            aria-label="Discard draft"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="ag-amail-compose-scroll">
        {/* Recipient To: Field */}
        <div className="ag-amail-field" ref={toWrapRef}>
          <label className="ag-amail-field-label" htmlFor="ag-amail-to-input">
            To
          </label>
          <div className="ag-amail-to-box">
            {selectedRecipient ? (
              <span className="ag-amail-recip-chip">
                <img
                  src={identiconDataUrl(selectedRecipient.pubkey)}
                  alt=""
                  width={18}
                  height={18}
                  className="ag-amail-recip-avatar"
                />
                <span className="truncate">{selectedRecipient.nickname}</span>
                <span className="ag-amail-recip-npub mono">
                  {shortPubkey(selectedRecipient.npub, 6, 4)}
                </span>
                <button
                  type="button"
                  className="ag-amail-recip-clear"
                  onClick={() => {
                    setSelectedRecipient(null)
                    setToInput('')
                  }}
                  aria-label="Clear recipient"
                >
                  <X size={12} />
                </button>
              </span>
            ) : (
              <div className="ag-amail-to-input-row">
                <input
                  id="ag-amail-to-input"
                  type="text"
                  className="ag-input"
                  value={toInput}
                  onFocus={() => setToDropdownOpen(true)}
                  onChange={(e) => {
                    const val = e.target.value
                    setToInput(val)
                    setToDropdownOpen(true)
                    if (composeError) setComposeError(null)
                    const direct = resolvePubkeyInput(val)
                    if (direct && (val.startsWith('npub1') || val.includes('#dm=') || val.length === 64)) {
                      const known = mergedContacts.find(
                        (c) => c.pubkey.toLowerCase() === direct.pubkey.toLowerCase(),
                      )
                      setSelectedRecipient({
                        pubkey: direct.pubkey,
                        npub: direct.npub,
                        nickname:
                          direct.nickname || known?.nickname || shortPubkey(direct.pubkey, 8, 6),
                      })
                      setToInput('')
                      setToDropdownOpen(false)
                    }
                  }}
                  placeholder="Contact name, npub1…, 64-hex pubkey, or #dm= link"
                  autoComplete="off"
                />
                {onOpenScanner && (
                  <button
                    type="button"
                    className="ag-btn ag-btn-secondary ag-btn-sm"
                    onClick={() => {
                      onPlaySound?.('click')
                      onOpenScanner()
                    }}
                    title="Scan recipient QR code"
                  >
                    <QrCode size={14} />
                    <span className="ag-hide-xs">QR</span>
                  </button>
                )}
              </div>
            )}

            {!selectedRecipient && toDropdownOpen && autocompleteMatches.length > 0 && (
              <div className="ag-amail-autocomplete" role="listbox" aria-label="Contacts">
                {autocompleteMatches.map((c) => (
                  <button
                    key={c.pubkey}
                    type="button"
                    role="option"
                    className="ag-amail-ac-item"
                    onClick={() => {
                      setSelectedRecipient({
                        pubkey: c.pubkey,
                        npub: c.npub,
                        nickname: c.nickname,
                      })
                      setToInput('')
                      setToDropdownOpen(false)
                      setComposeError(null)
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
                        {c.nickname}
                      </span>
                      <span className="ag-amail-ac-npub mono truncate">
                        {shortPubkey(c.npub, 10, 6)}
                      </span>
                    </span>
                    {c.isTrustedPeer && (
                      <span className="ag-badge ag-badge-accent">
                        <ShieldCheck size={9} />
                        <span>Trusted</span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Subject */}
        <div className="ag-amail-field">
          <label className="ag-amail-field-label" htmlFor="ag-amail-subject">
            Subject
          </label>
          <input
            id="ag-amail-subject"
            type="text"
            maxLength={180}
            className="ag-input"
            value={subjectDraft}
            onChange={(e) => setSubjectDraft(e.target.value)}
            placeholder="Subject"
          />
        </div>

        {/* Body Write | Preview */}
        <div className="ag-amail-body-field">
          <div className="ag-amail-body-head">
            <span className="ag-amail-field-label">Message (Markdown + $LaTeX$ Math)</span>
            <div className="ag-segmented ag-amail-mode-seg" role="tablist" aria-label="Editor mode">
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
              className="ag-textarea ag-amail-textarea"
              rows={9}
              value={bodyDraft}
              onChange={(e) => {
                setBodyDraft(e.target.value)
                if (composeError) setComposeError(null)
              }}
              placeholder="Write your encrypted message… Supports **Markdown**, lists, code blocks, and $E = mc^2$ math."
              aria-label="Email body"
            />
          ) : (
            <div className="ag-amail-preview-box">
              {bodyDraft.trim() ? (
                <RichMessageContent content={bodyDraft} />
              ) : (
                <p className="ag-amail-preview-empty">Nothing to preview yet.</p>
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
            <span>Request read receipt</span>
          </label>

          <div className="ag-amail-ttl-group">
            <span className="ag-amail-ttl-label">Mesh TTL</span>
            <div className="ag-segmented ag-amail-ttl-seg" role="radiogroup" aria-label="Mesh TTL">
              {TTL_OPTIONS.map((opt) => (
                <button
                  key={opt.sec}
                  type="button"
                  role="radio"
                  aria-checked={composeTtlSec === opt.sec}
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

      <div className="ag-amail-compose-footer">
        <span className="ag-amail-e2ee-note">
          <Lock size={12} />
          <span>NIP-44 E2EE sealed capsule · zero email servers</span>
        </span>
        <button
          type="submit"
          className="ag-btn ag-btn-primary"
          disabled={sendingMail}
        >
          <Send size={14} />
          <span>{sendingMail ? 'Sealing & Sending…' : 'Send via Mesh'}</span>
        </button>
      </div>
    </form>
  )

  const renderContacts = () => (
    <div className="ag-amail-section-scroll">
      <div className="ag-amail-section-head">
        <div>
          <h3 className="ag-amail-section-title">Contacts</h3>
          <p className="ag-amail-section-sub">
            Pure Nostr public keys &amp; synced Trusted People — no email addresses required.
          </p>
        </div>
      </div>

      <form className="ag-amail-card ag-amail-contact-form" onSubmit={(e) => void handleAddContact(e)}>
        <div className="ag-amail-to-input-row">
          <input
            type="text"
            className="ag-input mono"
            value={contactKeyDraft}
            onChange={(e) => {
              setContactKeyDraft(e.target.value)
              if (contactFeedback) setContactFeedback(null)
            }}
            placeholder="Paste npub1…, 64-char hex pubkey, or #dm= link"
            aria-label="Contact public key or DM link"
          />
          {onOpenScanner && (
            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-sm"
              onClick={() => {
                onPlaySound?.('click')
                onOpenScanner()
              }}
              title="Scan QR code"
            >
              <QrCode size={14} />
            </button>
          )}
        </div>
        <div className="ag-amail-contact-row-2">
          <input
            type="text"
            maxLength={32}
            className="ag-input"
            value={contactNickDraft}
            onChange={(e) => setContactNickDraft(e.target.value)}
            placeholder="Nickname (optional)"
            aria-label="Contact nickname"
          />
          <input
            type="text"
            maxLength={80}
            className="ag-input"
            value={contactNoteDraft}
            onChange={(e) => setContactNoteDraft(e.target.value)}
            placeholder="Note (optional)"
            aria-label="Contact note"
          />
          <button
            type="submit"
            className="ag-btn ag-btn-primary ag-btn-sm"
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
        <div className="ag-amail-card ag-amail-empty-inline">
          No contacts yet. Add a peer&apos;s npub above or trust peers in chat.
        </div>
      ) : (
        <div className="ag-amail-contact-list" role="list">
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
                      <span className="ag-badge ag-badge-accent">
                        <ShieldCheck size={9} />
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
                    className="ag-btn ag-btn-primary ag-btn-xs"
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
                    className="ag-icon-btn-xs"
                    onClick={() => void copyValue(`c-${c.pubkey}`, c.npub, 'Copied npub')}
                    title="Copy npub"
                    aria-label={`Copy npub for ${c.nickname}`}
                  >
                    {copiedId === `c-${c.pubkey}` ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                  {isSavedAmailContact && (
                    <button
                      type="button"
                      className="ag-icon-btn-xs ag-icon-btn-danger"
                      onClick={() => {
                        onPlaySound?.('click')
                        void amail.removeContact(c.pubkey)
                      }}
                      title="Remove contact"
                      aria-label={`Remove ${c.nickname}`}
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
    return (
      <div className="ag-amail-section-scroll">
        <div className="ag-amail-section-head">
          <div>
            <h3 className="ag-amail-section-title">Mesh Relay &amp; Storage</h3>
            <p className="ag-amail-section-sub">
              Briar-inspired store-and-forward courier vault. Third-party capsules are strictly
              opaque NIP-44 ciphertext.
            </p>
          </div>
        </div>

        {/* Storage Utilization Card */}
        <div className="ag-amail-card">
          <div className="ag-amail-card-head">
            <span className="ag-amail-card-title">
              <HardDrive size={14} />
              <span>Local Storage Breakdown</span>
            </span>
            <span className="ag-badge ag-badge-accent mono">{vaultPct}% vault used</span>
          </div>

          <div className="ag-amail-vault-track" aria-hidden="true">
            <span className="ag-amail-vault-fill" style={{ width: `${vaultPct}%` }} />
          </div>

          <div className="ag-amail-storage-breakdown">
            <div className="ag-amail-stat-chip">
              <span className="ag-amail-stat-k">Relay Vault</span>
              <span className="ag-amail-stat-v mono">
                {formatBytes(stats.vaultBytes)} / {formatBytes(stats.vaultLimitBytes)}
              </span>
            </div>
            <div className="ag-amail-stat-chip">
              <span className="ag-amail-stat-k">My Mail</span>
              <span className="ag-amail-stat-v mono">
                {formatBytes(stats.mailBytes)} ({stats.mailCount})
              </span>
            </div>
            <div className="ag-amail-stat-chip">
              <span className="ag-amail-stat-k">ACK Tombstones</span>
              <span className="ag-amail-stat-v mono">{stats.tombstoneCount}</span>
            </div>
          </div>
        </div>

        {/* Live Mesh Telemetry */}
        <div className="ag-amail-telemetry-grid">
          <div className="ag-amail-kpi">
            <span className="ag-amail-kpi-label">Mesh Relay</span>
            <span className="ag-amail-kpi-val">{st.relayEnabled ? 'ON' : 'OFF'}</span>
          </div>
          <div className="ag-amail-kpi">
            <span className="ag-amail-kpi-label">WebRTC Couriers</span>
            <span className="ag-amail-kpi-val mono">{connectedCouriers}</span>
          </div>
          <div className="ag-amail-kpi">
            <span className="ag-amail-kpi-label">Capsules Carrying</span>
            <span className="ag-amail-kpi-val mono">{stats.vaultCapsuleCount}</span>
          </div>
          <div className="ag-amail-kpi">
            <span className="ag-amail-kpi-label">Total Relayed</span>
            <span className="ag-amail-kpi-val mono">{stats.totalRelayedOut}</span>
          </div>
          <div className="ag-amail-kpi">
            <span className="ag-amail-kpi-label">Delivered &amp; Purged</span>
            <span className="ag-amail-kpi-val mono">{stats.totalDeliveredPurged}</span>
          </div>
          <div className="ag-amail-kpi">
            <span className="ag-amail-kpi-label">Expired Purged</span>
            <span className="ag-amail-kpi-val mono">{stats.totalExpiredPurged}</span>
          </div>
        </div>

        {/* Relay Controls */}
        <div className="ag-amail-card ag-amail-controls-card">
          <label className="ag-amail-toggle-row">
            <div>
              <div className="ag-amail-toggle-title">Enable Mesh Relay</div>
              <div className="ag-amail-toggle-desc">
                Store and forward sealed capsules for offline peers over WebRTC DataChannels.
              </div>
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

          <label className="ag-amail-toggle-row">
            <div>
              <div className="ag-amail-toggle-title">Send Read Receipts</div>
              <div className="ag-amail-toggle-desc">
                Notify senders when you open their Amail (if they requested a receipt).
              </div>
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

          <div className="ag-amail-control-row">
            <span className="ag-amail-toggle-title">Max Vault Size</span>
            <div className="ag-segmented" role="radiogroup" aria-label="Max relay vault size">
              {VAULT_SIZE_OPTIONS.map((opt) => (
                <button
                  key={opt.bytes}
                  type="button"
                  role="radio"
                  aria-checked={st.maxVaultBytes === opt.bytes}
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

          <div className="ag-amail-control-row">
            <span className="ag-amail-toggle-title">Max Hops</span>
            <div className="ag-segmented" role="radiogroup" aria-label="Max relay hops">
              {MAX_HOPS_OPTIONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={st.maxHops === h}
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
              className="ag-btn ag-btn-primary ag-btn-sm"
              disabled={amail.isSyncing}
              onClick={() => void handleSyncMesh()}
            >
              <RefreshCw size={13} className={amail.isSyncing ? 'ag-spin' : ''} />
              <span>{amail.isSyncing ? 'Syncing Mesh…' : 'Sync Mesh Now'}</span>
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-secondary ag-btn-sm"
              onClick={() => void handlePruneExpired()}
            >
              <Clock size={13} />
              <span>Prune Expired</span>
            </button>
            <button
              type="button"
              className={`ag-btn ag-btn-sm ${
                confirmPurgeVault ? 'ag-btn-danger' : 'ag-btn-danger-outline'
              }`}
              onClick={() => void handlePurgeVault()}
            >
              <Trash2 size={13} />
              <span>{confirmPurgeVault ? 'Tap again to purge' : 'Purge Relay Vault'}</span>
            </button>
          </div>

          {meshFeedback && (
            <p className="ag-field-hint ag-field-hint-accent" role="status">
              {meshFeedback}
            </p>
          )}
        </div>

        {/* Carried Sealed Relay Capsules Table */}
        <div className="ag-amail-card">
          <div className="ag-amail-card-head">
            <span className="ag-amail-card-title">
              <Database size={14} />
              <span>Carried Sealed Capsules ({amail.relayCapsules.length})</span>
            </span>
            <span className="ag-amail-ciphertext-tag">
              <Lock size={10} />
              <span>Encrypted ciphertext · Zero plaintext visibility</span>
            </span>
          </div>

          {amail.relayCapsules.length === 0 ? (
            <p className="ag-amail-empty-inline">
              No third-party capsules currently buffered in your relay vault.
            </p>
          ) : (
            <div className="ag-amail-capsule-table" role="table" aria-label="Carried relay capsules">
              <div className="ag-amail-capsule-row head mono" role="row">
                <span role="columnheader">Capsule ID</span>
                <span role="columnheader">Size</span>
                <span role="columnheader">Hops</span>
                <span role="columnheader">TTL</span>
                <span role="columnheader">Dest Hint</span>
              </div>
              {amail.relayCapsules.map((cap) => (
                <div key={cap.capsuleId} className="ag-amail-capsule-row mono" role="row">
                  <span role="cell" className="truncate" title={cap.capsuleId}>
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
        aria-label="Amail — Encrypted Mesh Mail"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Bar (Search + Mesh Status + Sync + Mobile Compose / Close) */}
        <header className="ag-amail-topbar">
          <div className="ag-amail-brand">
            <span className="ag-amail-brand-icon" aria-hidden="true">
              <Mail size={15} />
            </span>
            <span className="ag-amail-brand-name">Amail</span>
          </div>

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
              placeholder="Search mail…"
              aria-label="Search Amail messages"
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
                setComposing(false)
                setSelectedMessageId(null)
                setSection('mesh')
              }}
              title="Open Mesh Relay & Storage Inspector"
            >
              <Radio size={12} />
              <span className="ag-hide-xs">
                {connectedCouriers > 0 ? `${connectedCouriers} mesh` : 'Mesh'}
              </span>
            </button>

            <button
              type="button"
              className="ag-icon-btn-sm"
              disabled={amail.isSyncing}
              onClick={() => void handleSyncMesh()}
              title="Sync Amail mesh now"
              aria-label="Sync Amail mesh now"
            >
              <RefreshCw size={14} className={amail.isSyncing ? 'ag-spin' : ''} />
            </button>

            <button
              type="button"
              className="ag-amail-mobile-compose-btn"
              onClick={() => {
                onPlaySound?.('click')
                openFreshComposer()
              }}
              aria-label="Compose Amail"
              title="Compose Amail"
            >
              <Plus size={16} />
            </button>

            <button
              type="button"
              className="ag-icon-btn-sm ag-amail-close-btn"
              onClick={onClose}
              aria-label="Close Amail"
              title="Close Amail (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Mobile Scrollable Folder Pills */}
        {!composing && !selectedMessage && (
          <div className="ag-amail-mobile-pills" role="tablist" aria-label="Amail folders">
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
        )}

        {/* Body Layout: Slim 188px Desktop Rail + Main Content Pane */}
        <div className="ag-amail-body">
          <nav className="ag-amail-rail" aria-label="Amail folders">
            <button
              type="button"
              className="ag-amail-compose-btn"
              onClick={() => {
                onPlaySound?.('click')
                openFreshComposer()
              }}
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
      </div>
    </div>
  )
}

export default AmailView
