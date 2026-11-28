import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  BarChart2,
  Check,
  ChevronLeft,
  ChevronRight,
  Hash,
  ImagePlus,
  ListPlus,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type {
  AgoraNote,
  AgoraPublishNoteOptions,
  AgoraUploadedMedia,
} from '../types/agora.ts'
import type { AgnostrEngine } from '../types/protocol.ts'
import { getProfileDisplayName, sanitizeHttpUrl } from '../lib/agoraProtocol.ts'
import { clearAgoraDraft, loadAgoraDraft, saveAgoraDraft } from '../lib/agoraExtras.ts'
import {
  extractEmojiShortcodeToken,
  recordRecentEmojiShortcode,
  searchEmojiShortcodes,
} from '../lib/emojiShortcodes.ts'
import { encodeNpubSafe } from '../lib/identity.ts'
import { identiconDataUrl, shortPubkey } from '../utils/identicon.ts'
import type { SoundCue } from '../utils/sound.ts'

export interface AgoraComposerProps {
  engine: AgnostrEngine
  placeholder: string
  submitLabel: string
  draftKey?: string
  replyTarget?: AgoraNote
  quoteTarget?: AgoraNote
  inModal?: boolean
  autoFocus?: boolean
  onSubmitted?: () => void
  onPlaySound?: (cue: SoundCue) => void
}

type AutocompleteTrigger =
  | { kind: 'mention'; start: number; end: number; query: string }
  | { kind: 'hashtag'; start: number; end: number; query: string }
  | { kind: 'emoji'; start: number; end: number; query: string }

type AutocompleteSuggestion =
  | {
      kind: 'mention'
      key: string
      pubkey: string
      displayName: string
      secondary: string
      picture?: string
      insertText: string
    }
  | {
      kind: 'hashtag'
      key: string
      tag: string
      count?: number
      insertText: string
    }
  | {
      kind: 'emoji'
      key: string
      emoji: string
      shortcode: string
      name: string
      insertText: string
    }

const MAX_UPLOADS = 4
const MAX_THREAD_PARTS = 8
const MAX_POLL_OPTIONS = 5
const POLL_DURATION_PRESETS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: '1h', seconds: 3600 },
  { label: '24h', seconds: 86_400 },
  { label: '3d', seconds: 86_400 * 3 },
  { label: '7d', seconds: 86_400 * 7 },
]

function formatRelativeSeconds(tsSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000)
  const diff = Math.max(0, nowSec - tsSec)
  if (diff < 45) return 'now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86_400)}d`
}

function detectAutocompleteTrigger(text: string, caret: number): AutocompleteTrigger | null {
  if (!text || caret <= 0 || caret > text.length) return null
  const emojiTok = extractEmojiShortcodeToken(text, caret)
  if (emojiTok && !emojiTok.closed) {
    return { kind: 'emoji', start: emojiTok.start, end: emojiTok.end, query: emojiTok.query }
  }

  const before = text.slice(0, caret)
  const mentionMatch = /(?:^|[\s([{"'])@([^\s@#]{1,32})$/.exec(before)
  if (mentionMatch) {
    const query = mentionMatch[1]
    const start = caret - query.length - 1
    if (caret < text.length && /\S/.test(text[caret])) return null
    return { kind: 'mention', start, end: caret, query }
  }

  const hashMatch = /(?:^|[\s([{"'])#([a-zA-Z0-9_-]{1,32})$/.exec(before)
  if (hashMatch) {
    const query = hashMatch[1]
    const start = caret - query.length - 1
    if (caret < text.length && /[a-zA-Z0-9_-]/.test(text[caret])) return null
    return { kind: 'hashtag', start, end: caret, query }
  }

  return null
}

interface ComposerScreenedThumbProps {
  engine: AgnostrEngine
  url: string | undefined
  pubkey: string
  variant: 'avatar' | 'upload'
  size?: 'xs' | 'sm' | 'md'
  alt: string
}

const ComposerScreenedThumb: React.FC<ComposerScreenedThumbProps> = ({
  engine,
  url,
  pubkey,
  variant,
  size = 'md',
  alt,
}) => {
  const { contentFilter } = engine
  const requestedRef = useRef<string | null>(null)
  const safeHttpsUrl = useMemo(() => {
    const clean = sanitizeHttpUrl(url)
    return clean && clean.startsWith('https://') ? clean : null
  }, [url])
  const cacheKey = safeHttpsUrl
    ? `agora-img:${(pubkey || 'anon').trim().toLowerCase()}:${safeHttpsUrl}`
    : ''
  const verdict = cacheKey ? contentFilter.getVerdict(cacheKey) : null
  const safeBlobUrl =
    cacheKey && verdict?.status === 'safe' ? contentFilter.getSafeImageObjectUrl(cacheKey) : null
  const identicon = useMemo(
    () => (variant === 'avatar' ? identiconDataUrl(pubkey || 'anon') : ''),
    [pubkey, variant]
  )

  useEffect(() => {
    if (!safeHttpsUrl || !cacheKey) return
    const needsScreen = !verdict || verdict.status === 'idle'
    const needsRehydrate = verdict?.status === 'safe' && !safeBlobUrl
    if (!needsScreen && !needsRehydrate) return
    if (requestedRef.current === cacheKey) return
    requestedRef.current = cacheKey
    void contentFilter.screenExternalImageUrl(cacheKey, safeHttpsUrl, pubkey)
  }, [safeHttpsUrl, cacheKey, verdict, safeBlobUrl, contentFilter, pubkey])

  if (variant === 'avatar') {
    const src = verdict?.status === 'safe' && safeBlobUrl ? safeBlobUrl : identicon
    return <img src={src} alt={alt} className={`ag-agora-avatar ag-agora-avatar-${size}`} loading="lazy" />
  }

  if (verdict?.status === 'safe' && safeBlobUrl) {
    return <img src={safeBlobUrl} alt={alt} />
  }

  return (
    <div className="ag-agora-upload-pending" aria-label="Screening uploaded image">
      <Loader2 size={14} className="ag-agora-spin" />
    </div>
  )
}

export const AgoraComposer: React.FC<AgoraComposerProps> = ({
  engine,
  placeholder,
  submitLabel,
  draftKey,
  replyTarget,
  quoteTarget,
  inModal = false,
  autoFocus = false,
  onSubmitted,
  onPlaySound,
}) => {
  const { agora } = engine
  const effectiveDraftKey = useMemo(() => {
    if (draftKey && draftKey.trim()) return draftKey.trim()
    if (replyTarget) return `reply:${replyTarget.id}`
    if (quoteTarget) return `quote:${quoteTarget.id}`
    return inModal ? 'modal-post' : 'feed-post'
  }, [draftKey, replyTarget, quoteTarget, inModal])

  const initialDraft = useMemo(
    () => loadAgoraDraft(effectiveDraftKey),
    [effectiveDraftKey]
  )

  const [draft, setDraft] = useState<string>(() => initialDraft?.text ?? '')
  const [uploads, setUploads] = useState<AgoraUploadedMedia[]>(() => initialDraft?.uploads ?? [])
  const [cwEnabled, setCwEnabled] = useState<boolean>(() => Boolean(initialDraft?.cwEnabled))
  const [cwReason, setCwReason] = useState<string>(() => initialDraft?.cwReason ?? '')
  const [threadParts, setThreadParts] = useState<string[]>(() =>
    !replyTarget && !quoteTarget && Array.isArray(initialDraft?.threadParts)
      ? initialDraft.threadParts.slice(0, MAX_THREAD_PARTS - 1)
      : []
  )
  const [draftSavedVisible, setDraftSavedVisible] = useState<boolean>(() => Boolean(initialDraft))

  const [editingAltUrl, setEditingAltUrl] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState<boolean>(false)
  const [uploadingCount, setUploadingCount] = useState<number>(0)

  // Native NIP-88 Poll mode (standalone new posts only)
  const [pollMode, setPollMode] = useState<boolean>(false)
  const [pollOptions, setPollOptions] = useState<string[]>(['', ''])
  const [pollDurationSec, setPollDurationSec] = useState<number>(86_400)

  // Autocomplete state (targetField: -1 = main textarea, 0..N = threadParts[i])
  const [acState, setAcState] = useState<{
    fieldIndex: number
    trigger: AutocompleteTrigger
  } | null>(null)
  const [acActiveIndex, setAcActiveIndex] = useState<number>(0)

  const mainTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const threadTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef<number>(0)
  const didMountRef = useRef<boolean>(false)

  useEffect(() => {
    if (autoFocus) {
      window.setTimeout(() => mainTextareaRef.current?.focus(), 40)
    }
  }, [autoFocus])

  // Debounced draft auto-save (skip initial mount frame so we don't rewrite unchanged drafts)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    const hasContent =
      draft.trim().length > 0 ||
      uploads.length > 0 ||
      cwEnabled ||
      threadParts.some((p) => p.trim().length > 0)

    const timer = window.setTimeout(() => {
      if (!hasContent) {
        clearAgoraDraft(effectiveDraftKey)
        setDraftSavedVisible(false)
        return
      }
      saveAgoraDraft(effectiveDraftKey, {
        text: draft,
        uploads,
        cwEnabled,
        cwReason,
        threadParts: threadParts.length > 0 ? threadParts : undefined,
        updatedAt: Date.now(),
      })
      setDraftSavedVisible(true)
    }, 450)

    return () => window.clearTimeout(timer)
  }, [effectiveDraftKey, draft, uploads, cwEnabled, cwReason, threadParts])

  const resizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(240, Math.max(60, el.scrollHeight))}px`
  }, [])

  // Keep primary and thread textareas fitted whenever drafts restore or autocomplete inserts wrapped text
  useEffect(() => {
    resizeTextarea(mainTextareaRef.current)
    const rafId = window.requestAnimationFrame(() => {
      resizeTextarea(mainTextareaRef.current)
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [draft, pollMode, resizeTextarea])

  useEffect(() => {
    for (let i = 0; i < threadParts.length; i += 1) {
      resizeTextarea(threadTextareaRefs.current[i] ?? null)
    }
    const rafId = window.requestAnimationFrame(() => {
      for (let i = 0; i < threadParts.length; i += 1) {
        resizeTextarea(threadTextareaRefs.current[i] ?? null)
      }
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [threadParts, resizeTextarea])

  const uploadMediaFiles = useCallback(
    async (files: File[]) => {
      const mediaFiles = files.filter(
        (f) => f.type.startsWith('image/') || f.type.startsWith('video/')
      )
      if (mediaFiles.length === 0) return

      const availableSlots = Math.max(0, MAX_UPLOADS - uploads.length)
      const batch = mediaFiles.slice(0, availableSlots)
      if (batch.length === 0) {
        engine.pushToast('info', 'Attachment limit reached', `Up to ${MAX_UPLOADS} media items per post.`)
        return
      }

      setUploadingCount((c) => c + batch.length)
      try {
        for (const file of batch) {
          try {
            const uploaded = await agora.uploadMedia(file)
            setUploads((prev) => [...prev, uploaded].slice(0, MAX_UPLOADS))
          } catch (err) {
            engine.pushToast(
              'error',
              'Upload failed',
              err instanceof Error ? err.message : 'Unable to upload media to Blossom.'
            )
          }
        }
      } finally {
        setUploadingCount((c) => Math.max(0, c - batch.length))
      }
    },
    [agora, engine, uploads.length]
  )

  const handleFilesSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    await uploadMediaFiles(files)
  }

  const handlePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (pollMode) return
    const items = Array.from(e.clipboardData?.items ?? [])
    const pastedMedia: File[] = []
    for (const item of items) {
      if (item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/'))) {
        const f = item.getAsFile()
        if (f) pastedMedia.push(f)
      }
    }
    if (pastedMedia.length === 0) {
      const directFiles = Array.from(e.clipboardData?.files ?? []).filter(
        (f) => f.type.startsWith('image/') || f.type.startsWith('video/')
      )
      pastedMedia.push(...directFiles)
    }
    if (pastedMedia.length > 0) {
      e.preventDefault()
      void uploadMediaFiles(pastedMedia)
    }
  }

  const handleDragEnter = (e: ReactDragEvent<HTMLDivElement>) => {
    if (pollMode) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (pollMode) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (pollMode) return
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (pollMode) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) {
      void uploadMediaFiles(files)
    }
  }

  const moveUpload = (index: number, delta: -1 | 1) => {
    const nextIdx = index + delta
    if (nextIdx < 0 || nextIdx >= uploads.length) return
    setUploads((prev) => {
      const copy = [...prev]
      const [item] = copy.splice(index, 1)
      copy.splice(nextIdx, 0, item)
      return copy
    })
  }

  const updateUploadAlt = (url: string, alt: string) => {
    setUploads((prev) =>
      prev.map((item) => (item.url === url ? { ...item, alt: alt.slice(0, 400) } : item))
    )
  }

  // Collect autocomplete suggestions for @mentions, #hashtags, and :emoji
  const suggestions = useMemo<AutocompleteSuggestion[]>(() => {
    if (!acState) return []
    const { trigger } = acState
    const q = trigger.query.trim().toLowerCase()
    if (!q) return []

    if (trigger.kind === 'emoji') {
      return searchEmojiShortcodes(q, 8).map((entry) => ({
        kind: 'emoji',
        key: `emoji:${entry.shortcode}`,
        emoji: entry.emoji,
        shortcode: entry.shortcode,
        name: entry.name,
        insertText: `${entry.emoji} `,
      }))
    }

    if (trigger.kind === 'hashtag') {
      const countByTag = new Map<string, number>()
      for (const t of agora.trendingHashtags) {
        const clean = t.tag.trim().toLowerCase().replace(/^#/, '')
        if (clean) countByTag.set(clean, Math.max(countByTag.get(clean) ?? 0, t.count))
      }
      for (const note of Object.values(agora.notesById)) {
        for (const raw of note.hashtags) {
          const clean = raw.trim().toLowerCase().replace(/^#/, '')
          if (clean && !countByTag.has(clean)) countByTag.set(clean, 1)
        }
      }
      const matches: Array<{ tag: string; count: number; starts: boolean }> = []
      for (const [tag, count] of countByTag.entries()) {
        if (tag.includes(q)) {
          matches.push({ tag, count, starts: tag.startsWith(q) })
        }
      }
      matches.sort((a, b) => {
        if (a.starts !== b.starts) return a.starts ? -1 : 1
        if (b.count !== a.count) return b.count - a.count
        return a.tag.localeCompare(b.tag)
      })
      return matches.slice(0, 7).map((m) => ({
        kind: 'hashtag',
        key: `tag:${m.tag}`,
        tag: m.tag,
        count: m.count,
        insertText: `#${m.tag} `,
      }))
    }

    // Mention suggestions from Agora profiles + active chat peers
    const candidateMap = new Map<
      string,
      { pubkey: string; displayName: string; secondary: string; picture?: string; score: number }
    >()

    const consider = (
      rawPk: string,
      displayName: string,
      secondary: string,
      picture: string | undefined,
      extraSearch: string[]
    ) => {
      const pk = rawPk.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk)) return
      const fields = [displayName, secondary, ...extraSearch, pk].map((s) => s.toLowerCase())
      let score = 99
      if (fields.some((f) => f === q)) score = 0
      else if (fields.some((f) => f.startsWith(q))) score = 1
      else if (fields.some((f) => f.includes(q))) score = 2
      if (score >= 99) return
      const existing = candidateMap.get(pk)
      if (!existing || score < existing.score) {
        candidateMap.set(pk, { pubkey: pk, displayName, secondary, picture, score })
      }
    }

    for (const profile of Object.values(agora.profilesByPubkey)) {
      const name = getProfileDisplayName(profile, profile.pubkey)
      const nip05 = profile.nip05?.trim() || ''
      const secondary = nip05 || shortPubkey(profile.npub || encodeNpubSafe(profile.pubkey))
      consider(profile.pubkey, name, secondary, profile.picture, [
        profile.name ?? '',
        profile.displayName ?? '',
        nip05,
        profile.npub ?? '',
      ])
    }

    for (const peer of engine.peers) {
      const pk = peer.pubkey.toLowerCase()
      if (candidateMap.has(pk)) continue
      const name = peer.nickname?.trim() || peer.displayHandle || shortPubkey(pk)
      consider(pk, name, shortPubkey(encodeNpubSafe(pk)), engine.getProfilePicture(pk), [
        peer.displayHandle,
      ])
    }

    return Array.from(candidateMap.values())
      .sort((a, b) => a.score - b.score || a.displayName.localeCompare(b.displayName))
      .slice(0, 7)
      .map((item) => ({
        kind: 'mention',
        key: `mention:${item.pubkey}`,
        pubkey: item.pubkey,
        displayName: item.displayName,
        secondary: item.secondary,
        picture: item.picture,
        insertText: `nostr:${encodeNpubSafe(item.pubkey)} `,
      }))
  }, [acState, agora.profilesByPubkey, agora.trendingHashtags, agora.notesById, engine])

  const safeAcIndex = suggestions.length > 0 ? Math.min(acActiveIndex, suggestions.length - 1) : 0

  const syncAutocompleteForField = (fieldIndex: number, value: string, caret: number) => {
    const trigger = detectAutocompleteTrigger(value, caret)
    if (!trigger) {
      setAcState(null)
      return
    }
    setAcState({ fieldIndex, trigger })
    setAcActiveIndex(0)
  }

  const applySuggestion = (suggestion: AutocompleteSuggestion) => {
    if (!acState) return
    const { fieldIndex, trigger } = acState
    if (suggestion.kind === 'emoji') {
      recordRecentEmojiShortcode(suggestion.shortcode)
    }

    const currentText = fieldIndex === -1 ? draft : (threadParts[fieldIndex] ?? '')
    const nextText =
      currentText.slice(0, trigger.start) + suggestion.insertText + currentText.slice(trigger.end)
    const nextCaret = trigger.start + suggestion.insertText.length

    if (fieldIndex === -1) {
      setDraft(nextText)
    } else {
      setThreadParts((prev) => prev.map((p, i) => (i === fieldIndex ? nextText : p)))
    }
    setAcState(null)

    window.requestAnimationFrame(() => {
      const el =
        fieldIndex === -1 ? mainTextareaRef.current : (threadTextareaRefs.current[fieldIndex] ?? null)
      if (el) {
        el.focus()
        el.setSelectionRange(nextCaret, nextCaret)
        resizeTextarea(el)
      }
    })
  }

  const canThread = !replyTarget && !quoteTarget && !pollMode
  const canPoll = !replyTarget && !quoteTarget

  const handleAddThreadPart = () => {
    if (!canThread) return
    if (threadParts.length >= MAX_THREAD_PARTS - 1) return
    const nextIdx = threadParts.length
    setThreadParts((prev) => [...prev, ''])
    window.setTimeout(() => threadTextareaRefs.current[nextIdx]?.focus(), 30)
  }

  const handleRemoveThreadPart = (idx: number) => {
    setThreadParts((prev) => prev.filter((_, i) => i !== idx))
    setAcState((prev) => (prev && prev.fieldIndex === idx ? null : prev))
  }

  const handleTogglePollMode = () => {
    if (!canPoll) return
    setPollMode((prev) => {
      const next = !prev
      if (next) {
        setThreadParts([])
        setAcState(null)
      }
      return next
    })
  }

  const resetFormAfterPublish = () => {
    setDraft('')
    setUploads([])
    setCwEnabled(false)
    setCwReason('')
    setThreadParts([])
    setPollMode(false)
    setPollOptions(['', ''])
    setPollDurationSec(86_400)
    setEditingAltUrl(null)
    setAcState(null)
    clearAgoraDraft(effectiveDraftKey)
    setDraftSavedVisible(false)
    if (mainTextareaRef.current) {
      mainTextareaRef.current.style.height = '60px'
    }
  }

  const validPollOptions = pollOptions.map((o) => o.trim()).filter(Boolean)
  const isBusy = agora.publishing || agora.uploadingMedia || uploadingCount > 0

  const canPost = pollMode
    ? draft.trim().length > 0 && validPollOptions.length >= 2 && !isBusy
    : (draft.trim().length > 0 ||
        uploads.length > 0 ||
        threadParts.some((p) => p.trim().length > 0)) &&
      !isBusy

  const handleSubmit = async () => {
    if (!canPost) return
    const trimmed = draft.trim()

    if (pollMode) {
      const res = await agora.publishPoll(trimmed, validPollOptions, pollDurationSec)
      if (res.ok) {
        resetFormAfterPublish()
        onPlaySound?.('send')
        onSubmitted?.()
      } else {
        engine.pushToast('error', 'Could not publish poll', res.error || 'Try again in a moment.')
      }
      return
    }

    const baseOpts: AgoraPublishNoteOptions = {
      media: uploads.length > 0 ? uploads : undefined,
      contentWarning: cwEnabled ? cwReason.trim() || 'Sensitive content' : undefined,
    }

    const nonEmptyExtras = threadParts.map((p) => p.trim()).filter(Boolean)
    if (!replyTarget && !quoteTarget && nonEmptyExtras.length > 0) {
      const parts: Array<{ content: string; opts?: AgoraPublishNoteOptions }> = []
      if (trimmed || uploads.length > 0) {
        parts.push({ content: trimmed, opts: baseOpts })
      }
      for (const extra of nonEmptyExtras) {
        parts.push({
          content: extra,
          opts: baseOpts.contentWarning ? { contentWarning: baseOpts.contentWarning } : undefined,
        })
      }
      const res = await agora.publishThread(parts)
      if (res.ok) {
        resetFormAfterPublish()
        onPlaySound?.('send')
        onSubmitted?.()
      } else {
        engine.pushToast('error', 'Could not publish thread', res.error || 'Try again in a moment.')
      }
      return
    }

    const res = replyTarget
      ? await agora.replyToNote(replyTarget, trimmed, baseOpts)
      : quoteTarget
        ? await agora.quoteNote(quoteTarget, trimmed, baseOpts)
        : await agora.publishNote(trimmed, baseOpts)

    if (res.ok) {
      resetFormAfterPublish()
      onPlaySound?.('send')
      onSubmitted?.()
    } else {
      engine.pushToast('error', 'Could not publish note', res.error || 'Try again in a moment.')
    }
  }

  const handleTextareaKeyDown = (
    fieldIndex: number,
    e: ReactKeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (acState && acState.fieldIndex === fieldIndex && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAcActiveIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAcActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applySuggestion(suggestions[safeAcIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setAcState(null)
        return
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }

  const replyAuthorName = replyTarget
    ? getProfileDisplayName(agora.getProfile(replyTarget.pubkey), replyTarget.pubkey)
    : null
  const quoteAuthorProfile = quoteTarget ? agora.getProfile(quoteTarget.pubkey) : null
  const quoteAuthorName = quoteTarget
    ? getProfileDisplayName(quoteAuthorProfile, quoteTarget.pubkey)
    : null

  const effectiveSubmitLabel = pollMode
    ? 'Create Poll'
    : threadParts.some((p) => p.trim().length > 0)
      ? `Post Thread (${1 + threadParts.filter((p) => p.trim().length > 0).length})`
      : submitLabel

  const renderAutocompletePopover = (fieldIndex: number) => {
    if (!acState || acState.fieldIndex !== fieldIndex || suggestions.length === 0) return null
    return (
      <div
        className="ag-agora-ac-popover"
        role="listbox"
        aria-label="Autocomplete suggestions"
      >
        {suggestions.map((item, idx) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={idx === safeAcIndex}
            className={`ag-agora-ac-item${idx === safeAcIndex ? ' active' : ''}`}
            onMouseEnter={() => setAcActiveIndex(idx)}
            onMouseDown={(e) => {
              e.preventDefault()
              applySuggestion(item)
            }}
          >
            {item.kind === 'mention' && (
              <>
                <ComposerScreenedThumb
                  engine={engine}
                  url={item.picture}
                  pubkey={item.pubkey}
                  variant="avatar"
                  size="xs"
                  alt={item.displayName}
                />
                <span className="ag-agora-ac-text">
                  <span className="ag-agora-ac-primary truncate">{item.displayName}</span>
                  <span className="ag-agora-ac-secondary mono truncate">{item.secondary}</span>
                </span>
              </>
            )}
            {item.kind === 'hashtag' && (
              <>
                <Hash size={14} className="ag-agora-ac-icon" aria-hidden="true" />
                <span className="ag-agora-ac-text">
                  <span className="ag-agora-ac-primary truncate">#{item.tag}</span>
                  {typeof item.count === 'number' && item.count > 1 && (
                    <span className="ag-agora-ac-secondary tabular">{item.count} posts</span>
                  )}
                </span>
              </>
            )}
            {item.kind === 'emoji' && (
              <>
                <span className="ag-agora-ac-emoji" aria-hidden="true">
                  {item.emoji}
                </span>
                <span className="ag-agora-ac-text">
                  <span className="ag-agora-ac-primary mono">:{item.shortcode}:</span>
                  <span className="ag-agora-ac-secondary truncate">{item.name}</span>
                </span>
              </>
            )}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      className={`ag-agora-composer${inModal ? ' in-modal' : ''}${dragActive ? ' is-drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ComposerScreenedThumb
        engine={engine}
        url={agora.myProfile?.picture}
        pubkey={agora.myPubkey}
        variant="avatar"
        size="md"
        alt={getProfileDisplayName(agora.myProfile, agora.myPubkey)}
      />

      <div className="ag-agora-composer-main">
        {dragActive && (
          <div className="ag-agora-drop-overlay" aria-live="polite">
            <Upload size={18} />
            <span>Drop images or videos to upload via Blossom</span>
          </div>
        )}

        {replyAuthorName && (
          <div className="ag-agora-composer-reply-ctx">
            <span>Replying to</span>
            <strong>@{replyAuthorName}</strong>
          </div>
        )}

        {threadParts.length > 0 && (
          <div className="ag-agora-thread-part-label">
            <span>Post 1 of {threadParts.length + 1}</span>
          </div>
        )}

        <div className="ag-agora-composer-input-wrap">
          <textarea
            ref={mainTextareaRef}
            className="ag-agora-composer-textarea"
            value={draft}
            onChange={(e) => {
              const val = e.target.value
              setDraft(val)
              resizeTextarea(e.currentTarget)
              syncAutocompleteForField(-1, val, e.currentTarget.selectionStart ?? val.length)
            }}
            onKeyUp={(e) => {
              if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return
              syncAutocompleteForField(
                -1,
                e.currentTarget.value,
                e.currentTarget.selectionStart ?? e.currentTarget.value.length
              )
            }}
            onClick={(e) =>
              syncAutocompleteForField(
                -1,
                e.currentTarget.value,
                e.currentTarget.selectionStart ?? e.currentTarget.value.length
              )
            }
            onKeyDown={(e) => handleTextareaKeyDown(-1, e)}
            onPaste={handlePaste}
            placeholder={pollMode ? 'Ask a question…' : placeholder}
            rows={2}
            aria-label={pollMode ? 'Poll question' : placeholder}
          />
          {renderAutocompletePopover(-1)}
        </div>

        {/* Native NIP-88 Poll Editor */}
        {pollMode && (
          <div className="ag-agora-poll-editor">
            <div className="ag-agora-poll-editor-head">
              <span className="ag-agora-poll-editor-title">
                <BarChart2 size={14} aria-hidden="true" />
                <span>Poll Options</span>
              </span>
              <button
                type="button"
                className="ag-agora-filter-clear"
                onClick={handleTogglePollMode}
                aria-label="Close poll editor"
              >
                <X size={13} />
              </button>
            </div>

            <div className="ag-agora-poll-editor-list">
              {pollOptions.map((opt, idx) => (
                <div key={idx} className="ag-agora-poll-editor-option">
                  <input
                    type="text"
                    className="ag-agora-poll-option-input"
                    value={opt}
                    maxLength={80}
                    placeholder={`Option ${idx + 1}`}
                    aria-label={`Poll option ${idx + 1}`}
                    onChange={(e) =>
                      setPollOptions((prev) =>
                        prev.map((v, i) => (i === idx ? e.target.value : v))
                      )
                    }
                  />
                  {pollOptions.length > 2 && (
                    <button
                      type="button"
                      className="ag-agora-icon-btn"
                      onClick={() =>
                        setPollOptions((prev) => prev.filter((_, i) => i !== idx))
                      }
                      aria-label={`Remove option ${idx + 1}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="ag-agora-poll-editor-foot">
              {pollOptions.length < MAX_POLL_OPTIONS && (
                <button
                  type="button"
                  className="ag-agora-composer-pill-btn"
                  onClick={() => setPollOptions((prev) => [...prev, ''])}
                >
                  <Plus size={13} />
                  <span>Add option</span>
                </button>
              )}

              <div className="ag-agora-poll-durations" role="group" aria-label="Poll duration">
                {POLL_DURATION_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={`ag-agora-poll-dur-btn${pollDurationSec === preset.seconds ? ' active' : ''}`}
                    onClick={() => setPollDurationSec(preset.seconds)}
                    aria-pressed={pollDurationSec === preset.seconds}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* NIP-36 Content Warning Row */}
        {!pollMode && cwEnabled && (
          <div className="ag-agora-cw-row">
            <ShieldAlert size={14} aria-hidden="true" />
            <input
              type="text"
              className="ag-agora-cw-input"
              value={cwReason}
              onChange={(e) => setCwReason(e.target.value)}
              placeholder="Content warning reason (optional)…"
              maxLength={120}
              aria-label="Content warning reason"
            />
            <button
              type="button"
              className="ag-agora-filter-clear"
              onClick={() => {
                setCwEnabled(false)
                setCwReason('')
              }}
              aria-label="Remove content warning"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Uploaded Media Grid with ALT editor + reorder arrows */}
        {!pollMode && uploads.length > 0 && (
          <div className="ag-agora-upload-section">
            <div className="ag-agora-upload-grid">
              {uploads.map((item, idx) => (
                <div key={item.url} className="ag-agora-upload-thumb">
                  {item.kind === 'video' ? (
                    <video src={item.url} muted playsInline preload="metadata" />
                  ) : (
                    <ComposerScreenedThumb
                      engine={engine}
                      url={item.url}
                      pubkey={agora.myPubkey}
                      variant="upload"
                      alt={item.alt || 'Uploaded media'}
                    />
                  )}
                  <button
                    type="button"
                    className={`ag-agora-upload-alt-btn${item.alt?.trim() ? ' has-alt' : ''}`}
                    onClick={() =>
                      setEditingAltUrl((cur) => (cur === item.url ? null : item.url))
                    }
                    aria-pressed={editingAltUrl === item.url}
                    title={item.alt?.trim() ? `Alt text: ${item.alt.trim()}` : 'Add alt text'}
                  >
                    ALT
                  </button>
                  {uploads.length > 1 && (
                    <div className="ag-agora-upload-reorder">
                      <button
                        type="button"
                        className="ag-agora-upload-move-btn"
                        disabled={idx === 0}
                        onClick={() => moveUpload(idx, -1)}
                        aria-label="Move attachment left"
                        title="Move left"
                      >
                        <ChevronLeft size={12} />
                      </button>
                      <button
                        type="button"
                        className="ag-agora-upload-move-btn"
                        disabled={idx === uploads.length - 1}
                        onClick={() => moveUpload(idx, 1)}
                        aria-label="Move attachment right"
                        title="Move right"
                      >
                        <ChevronRight size={12} />
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className="ag-agora-upload-remove"
                    onClick={() => {
                      setUploads((prev) => prev.filter((u) => u.url !== item.url))
                      if (editingAltUrl === item.url) setEditingAltUrl(null)
                    }}
                    aria-label="Remove attachment"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>

            {editingAltUrl && uploads.some((u) => u.url === editingAltUrl) && (
              <div className="ag-agora-upload-alt-editor">
                <span className="ag-agora-alt-pill">ALT</span>
                <input
                  type="text"
                  className="ag-agora-cw-input"
                  value={uploads.find((u) => u.url === editingAltUrl)?.alt ?? ''}
                  onChange={(e) => updateUploadAlt(editingAltUrl, e.target.value)}
                  placeholder="Describe this image for accessibility…"
                  maxLength={400}
                  aria-label="Attachment alt text"
                />
                <button
                  type="button"
                  className="ag-agora-filter-clear"
                  onClick={() => setEditingAltUrl(null)}
                  aria-label="Done editing alt text"
                >
                  <Check size={13} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Chained Multi-Post Thread Parts */}
        {canThread && threadParts.length > 0 && (
          <div className="ag-agora-thread-parts">
            {threadParts.map((part, idx) => (
              <div key={idx} className="ag-agora-thread-part">
                <div className="ag-agora-thread-part-head">
                  <span className="ag-agora-thread-part-label">
                    Post {idx + 2} of {threadParts.length + 1}
                  </span>
                  <div className="ag-agora-thread-part-meta">
                    {part.length > 0 && (
                      <span
                        className={`ag-agora-char-count tabular${part.length > 2000 ? ' warn' : ''}`}
                      >
                        {part.length.toLocaleString()}
                      </span>
                    )}
                    <button
                      type="button"
                      className="ag-agora-filter-clear"
                      onClick={() => handleRemoveThreadPart(idx)}
                      aria-label={`Remove thread post ${idx + 2}`}
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
                <div className="ag-agora-composer-input-wrap">
                  <textarea
                    ref={(el) => {
                      threadTextareaRefs.current[idx] = el
                    }}
                    className="ag-agora-composer-textarea ag-agora-thread-textarea"
                    value={part}
                    onChange={(e) => {
                      const val = e.target.value
                      setThreadParts((prev) => prev.map((v, i) => (i === idx ? val : v)))
                      resizeTextarea(e.currentTarget)
                      syncAutocompleteForField(idx, val, e.currentTarget.selectionStart ?? val.length)
                    }}
                    onKeyUp={(e) => {
                      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return
                      syncAutocompleteForField(
                        idx,
                        e.currentTarget.value,
                        e.currentTarget.selectionStart ?? e.currentTarget.value.length
                      )
                    }}
                    onClick={(e) =>
                      syncAutocompleteForField(
                        idx,
                        e.currentTarget.value,
                        e.currentTarget.selectionStart ?? e.currentTarget.value.length
                      )
                    }
                    onKeyDown={(e) => handleTextareaKeyDown(idx, e)}
                    placeholder={`Continue thread (part ${idx + 2})…`}
                    rows={2}
                    aria-label={`Thread post ${idx + 2}`}
                  />
                  {renderAutocompletePopover(idx)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Quoted Note Preview */}
        {quoteTarget && quoteAuthorName && (
          <div className="ag-agora-quote-card" style={{ cursor: 'default' }}>
            <div className="ag-agora-quote-head">
              <ComposerScreenedThumb
                engine={engine}
                url={quoteAuthorProfile?.picture}
                pubkey={quoteTarget.pubkey}
                variant="avatar"
                size="xs"
                alt={quoteAuthorName}
              />
              <span className="ag-agora-quote-author">{quoteAuthorName}</span>
              <span className="ag-agora-dot-sep">·</span>
              <span className="ag-agora-time tabular">
                {formatRelativeSeconds(quoteTarget.createdAt)}
              </span>
            </div>
            <div className="ag-agora-quote-body">{quoteTarget.content}</div>
          </div>
        )}

        {/* Composer Toolbar */}
        <div className="ag-agora-composer-bar">
          <div className="ag-agora-composer-tools">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => void handleFilesSelected(e)}
            />
            {!pollMode && (
              <>
                <button
                  type="button"
                  className="ag-agora-icon-btn"
                  disabled={agora.uploadingMedia || uploadingCount > 0 || uploads.length >= MAX_UPLOADS}
                  onClick={() => fileInputRef.current?.click()}
                  title="Upload image or video via Blossom (or paste/drop)"
                  aria-label="Upload image or video"
                >
                  {agora.uploadingMedia || uploadingCount > 0 ? (
                    <Loader2 size={16} className="ag-agora-spin" />
                  ) : (
                    <ImagePlus size={16} />
                  )}
                </button>

                <button
                  type="button"
                  className={`ag-agora-icon-btn${cwEnabled ? ' active' : ''}`}
                  onClick={() => setCwEnabled((v) => !v)}
                  aria-pressed={cwEnabled}
                  title="Add NIP-36 content warning"
                  aria-label="Toggle content warning"
                >
                  <ShieldAlert size={16} />
                </button>
              </>
            )}

            {canThread && (
              <button
                type="button"
                className="ag-agora-composer-pill-btn"
                disabled={threadParts.length >= MAX_THREAD_PARTS - 1}
                onClick={handleAddThreadPart}
                title="Add another chained post to this thread"
              >
                <ListPlus size={14} />
                <span>{threadParts.length > 0 ? '+ Post' : '+ Thread'}</span>
              </button>
            )}

            {canPoll && (
              <button
                type="button"
                className={`ag-agora-icon-btn${pollMode ? ' active' : ''}`}
                onClick={handleTogglePollMode}
                aria-pressed={pollMode}
                title="Create a NIP-88 poll"
                aria-label="Toggle poll composer"
              >
                <BarChart2 size={16} />
              </button>
            )}
          </div>

          <div className="ag-agora-composer-right">
            {draftSavedVisible && !pollMode && (
              <span className="ag-agora-draft-chip" aria-live="polite">
                Draft saved
              </span>
            )}
            {draft.length > 0 && (
              <span
                className={`ag-agora-char-count tabular${draft.length > 2000 ? ' warn' : ''}`}
              >
                {draft.length.toLocaleString()}
              </span>
            )}
            <button
              type="button"
              className="ag-agora-post-btn"
              disabled={!canPost}
              onClick={() => void handleSubmit()}
            >
              {agora.publishing ? <Loader2 size={14} className="ag-agora-spin" /> : null}
              <span>{effectiveSubmitLabel}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default AgoraComposer
