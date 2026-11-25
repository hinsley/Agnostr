import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Camera,
  CornerUpLeft,
  Image as ImageIcon,
  ImagePlus,
  Languages,
  Loader2,
  Lock,
  Mic,
  X,
} from 'lucide-react'
import type {
  AgnostrEngine,
  PreparedImage,
  RecordedVoiceMemo,
  SlashCommandDef,
} from '../types/protocol'
import {
  formatImageBytes,
  isSupportedImageFile,
  prepareImageFile,
  revokeImagePreviewUrl,
} from '../lib/imageProcessor'
import {
  formatVoiceDuration,
  isVoiceRecordingSupported,
  revokeVoicePreviewUrl,
} from '../lib/voiceRecorder'
import { formatBitchatChannelLabel } from '../lib/bitchatChannel'
import { KeyedFifoQueue } from '../lib/sendQueue'
import { useBackHandler } from '../hooks/useBackNavigation'
import { pubkeyToColor } from '../utils/identicon'
import { AvatarImg } from './AvatarImg'
import { CameraCaptureModal } from './CameraCaptureModal'
import { VoiceRecorderBar, type VoicePreviewTranscript } from './VoiceRecorderBar'

function dataTransferHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  if (dt.types && Array.from(dt.types).includes('Files')) return true
  return dt.files.length > 0
}

function isMobileCameraCaptureDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const coarse = Boolean(window.matchMedia?.('(pointer: coarse)').matches)
  const mobileUa = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  return coarse || mobileUa
}

export interface ComposerProps {
  engine: AgnostrEngine
  externalDraftToken: { id: number; text: string } | null
  onSent?: (isDm: boolean) => void
}

interface MentionCandidate {
  pubkey: string
  nickname: string
  displayHandle: string
  subtitle: string
}

type AutocompleteMode =
  | { type: 'none' }
  | { type: 'command'; query: string; items: SlashCommandDef[] }
  | { type: 'mention'; query: string; startIdx: number; endIdx: number; items: MentionCandidate[] }

export const Composer: React.FC<ComposerProps> = ({
  engine,
  externalDraftToken,
  onSent,
}) => {
  const [draft, setDraft] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [voiceMode, setVoiceMode] = useState(false)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [cameraModalOpen, setCameraModalOpen] = useState(false)
  const [pendingImage, setPendingImage] = useState<PreparedImage | null>(null)
  const [preparingImage, setPreparingImage] = useState(false)
  const [translatingOutgoing, setTranslatingOutgoing] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const attachWrapRef = useRef<HTMLDivElement | null>(null)
  const pendingImageRef = useRef<PreparedImage | null>(null)
  const composerQueueRef = useRef<KeyedFifoQueue>(new KeyedFifoQueue())
  const translatingCountRef = useRef<number>(0)
  const submitSeqRef = useRef(0)
  const contextEpochRef = useRef(0)
  const dragDepthRef = useRef(0)

  const adjustTranslating = useCallback((delta: number) => {
    translatingCountRef.current = Math.max(0, translatingCountRef.current + delta)
    setTranslatingOutgoing(translatingCountRef.current > 0)
  }, [])

  const clearPendingImage = useCallback(() => {
    contextEpochRef.current += 1
    if (pendingImageRef.current) {
      revokeImagePreviewUrl(pendingImageRef.current)
      pendingImageRef.current = null
    }
    setPendingImage(null)
  }, [])

  // Detach staged image on submit without prematurely revoking its previewUrl
  // (the engine's queued sendImageAttachment revokes it once upload settles)
  const detachPendingImage = useCallback((): PreparedImage | null => {
    contextEpochRef.current += 1
    const staged = pendingImageRef.current
    pendingImageRef.current = null
    setPendingImage(null)
    return staged
  }, [])

  // Always revoke any staged image preview URL on unmount and invalidate in-flight image prep
  useEffect(() => {
    return () => {
      contextEpochRef.current += 1
      if (pendingImageRef.current) {
        revokeImagePreviewUrl(pendingImageRef.current)
        pendingImageRef.current = null
      }
    }
  }, [])

  const voiceSupported = useMemo(() => isVoiceRecordingSupported(), [])
  const isDm = engine.activeView.type === 'dm' && engine.activeDmThread !== null
  const isServer =
    engine.activeView.type === 'server' &&
    engine.servers.activeServer !== null &&
    engine.servers.activeChannel !== null
  const dmThread = engine.activeDmThread
  const activeServer = engine.servers.activeServer
  const activeChannel = engine.servers.activeChannel
  const isServerE2ee = Boolean(isServer && activeServer?.encrypted)
  const isViolet = isDm || isServerE2ee
  const activeReply = isServer ? engine.servers.replyingTo : isDm ? engine.dmReplyingTo : engine.replyingTo
  const dmContext = isDm && dmThread
    ? { peerPubkey: dmThread.peerPubkey, replyToId: engine.dmReplyingTo?.id }
    : undefined
  const clearDmReplyOnSubmit = () => {
    if (isDm && engine.dmReplyingTo) engine.setDmReplyingTo(null)
  }
  useEffect(() => {
    if (engine.dmReplyingTo) textareaRef.current?.focus({ preventScroll: true })
  }, [engine.dmReplyingTo])
  const activeTargetKey = isDm
    ? `dm:${dmThread?.peerPubkey ?? ''}`
    : isServer
      ? `srv:${activeServer?.id ?? ''}:${activeChannel?.id ?? ''}`
      : `ch:${engine.activeGeohash}`

  const outgoingTranslateActive =
    engine.translator.settings.enabled && engine.translator.settings.outgoingEnabled
  const outgoingTargetLang = engine.translator.settings.outgoingLanguage
  const activeTargetKeyRef = useRef(activeTargetKey)
  useLayoutEffect(() => {
    activeTargetKeyRef.current = activeTargetKey
  }, [activeTargetKey])

  // Tear down voice recorder & staged images on Panic Wipe, key rotation, or context switch
  const prevMasterPkRef = useRef(engine.identity.masterPubkey)
  const prevTargetKeyRef = useRef(activeTargetKey)
  useEffect(() => {
    const pkChanged = prevMasterPkRef.current !== engine.identity.masterPubkey
    const targetChanged = prevTargetKeyRef.current !== activeTargetKey
    prevMasterPkRef.current = engine.identity.masterPubkey
    prevTargetKeyRef.current = activeTargetKey
    if (pkChanged) {
      composerQueueRef.current.clearAll()
      translatingCountRef.current = 0
      setTranslatingOutgoing(false)
    }
    if (pkChanged || targetChanged) {
      setVoiceMode(false)
      setAttachMenuOpen(false)
      setCameraModalOpen(false)
      clearPendingImage()
      setPreparingImage(false)
      dragDepthRef.current = 0
      setDragActive(false)
    }
  }, [engine.identity.masterPubkey, activeTargetKey, clearPendingImage])

  // Close attach-media popover on outside tap/click or Escape
  useEffect(() => {
    if (!attachMenuOpen) return
    const handlePointerDown = (e: PointerEvent) => {
      const wrap = attachWrapRef.current
      if (wrap && !wrap.contains(e.target as Node)) {
        setAttachMenuOpen(false)
      }
    }
    const handleKeyDownClose = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setAttachMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDownClose, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDownClose, true)
    }
  }, [attachMenuOpen])

  useBackHandler(attachMenuOpen, () => setAttachMenuOpen(false))
  useBackHandler(cameraModalOpen, () => setCameraModalOpen(false))

  // Handle external mention or snippet insertions
  useEffect(() => {
    if (!externalDraftToken) return
    if (externalDraftToken.text) {
      setDraft((prev) => {
        const needsSpace = prev.length > 0 && !prev.endsWith(' ')
        return `${prev}${needsSpace ? ' ' : ''}${externalDraftToken.text}`
      })
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus({ preventScroll: true })
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }, [externalDraftToken])

  // Auto-grow textarea cleanly
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 136)}px`
  }, [draft])

  // Compute slash-command or @mention autocomplete state
  const autocomplete: AutocompleteMode = useMemo(() => {
    if (!isDm && !isServer && draft.startsWith('/') && !draft.includes('\n')) {
      const firstSpace = draft.indexOf(' ')
      if (firstSpace === -1) {
        const q = draft.slice(1).toLowerCase()
        const matches = engine.commands.filter(
          (c) =>
            c.name.toLowerCase().startsWith(q) ||
            c.aliases.some((a) => a.toLowerCase().startsWith(q)) ||
            (q.length >= 2 && c.description.toLowerCase().includes(q))
        )
        if (matches.length > 0) {
          return { type: 'command', query: q, items: matches.slice(0, 8) }
        }
      }
    }

    const beforeCursor = draft.slice(0, cursorPos)
    const mentionMatch = /(?:^|\s)@([^@\n]{0,32})$/.exec(beforeCursor)
    if (mentionMatch && !isDm && !/^\s/.test(mentionMatch[1])) {
      const q = mentionMatch[1].toLowerCase()
      const startIdx = beforeCursor.length - mentionMatch[1].length - 1
      const pool: MentionCandidate[] = isServer
        ? engine.servers.members
            .filter((m) => !m.isSelf && !m.isBanned)
            .map((m) => ({
              pubkey: m.pubkey,
              nickname: m.nickname,
              displayHandle: m.displayHandle,
              subtitle: m.isFounder ? 'Founder' : m.isAdmin ? 'Admin' : m.roles[0] || 'Member',
            }))
        : engine.peers
            .filter((p) => !p.isSelf && !p.isBlocked)
            .map((p) => ({
              pubkey: p.pubkey,
              nickname: p.nickname,
              displayHandle: p.displayHandle,
              subtitle: p.isOnline ? 'Online' : `${p.messageCount} msgs`,
            }))

      const candidates = pool
        .filter(
          (p) =>
            !q ||
            p.nickname.toLowerCase().includes(q) ||
            p.displayHandle.toLowerCase().includes(q)
        )
        .slice(0, 7)

      if (candidates.length > 0) {
        return {
          type: 'mention',
          query: q,
          startIdx,
          endIdx: cursorPos,
          items: candidates,
        }
      }
    }

    return { type: 'none' }
  }, [draft, cursorPos, engine.commands, engine.peers, engine.servers.members, isDm, isServer])

  const acQuery = autocomplete.type === 'none' ? '' : autocomplete.query
  useEffect(() => {
    setSelectedIndex(0)
  }, [autocomplete.type, acQuery])

  const { ensureProfilePictures } = engine
  const mentionPubkeysKey = useMemo(() => {
    if (autocomplete.type !== 'mention') return ''
    return autocomplete.items.map((p) => p.pubkey.toLowerCase()).join(',')
  }, [autocomplete])

  useEffect(() => {
    if (!mentionPubkeysKey) return
    ensureProfilePictures(mentionPubkeysKey.split(','))
  }, [mentionPubkeysKey, ensureProfilePictures])

  const applyCommandCompletion = (cmd: SlashCommandDef) => {
    const needsArg = cmd.usage.includes('<') || cmd.usage.includes('[')
    const next = `/${cmd.name}${needsArg ? ' ' : ''}`
    setDraft(next)
    setCursorPos(next.length)
    textareaRef.current?.focus({ preventScroll: true })
  }

  const applyMentionCompletion = (peer: MentionCandidate, startIdx: number, endIdx: number) => {
    const insert = `${peer.displayHandle} `
    const next = draft.slice(0, startIdx) + insert + draft.slice(endIdx)
    const nextCursor = startIdx + insert.length
    setDraft(next)
    setCursorPos(nextCursor)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus({ preventScroll: true })
        el.setSelectionRange(nextCursor, nextCursor)
      }
    })
  }

  const canSign =
    engine.identity.signMode === 'auto'
      ? Boolean(engine.identity.activePubkey)
      : engine.identity.signMode === 'extension'
        ? engine.identity.hasNip07
        : engine.identity.localSecretValid

  const { pushToast } = engine

  const stageImageFile = useCallback(
    async (file: File) => {
      if (!canSign || preparingImage) return
      if (!isSupportedImageFile(file)) {
        pushToast(
          'warning',
          'Unsupported image format',
          'Choose a PNG, JPEG, WebP, or GIF image (SVG is blocked for safety).'
        )
        return
      }
      const prepEpoch = ++contextEpochRef.current
      setVoiceMode(false)
      setPreparingImage(true)
      try {
        const prepared = await prepareImageFile(file)
        if (contextEpochRef.current !== prepEpoch) {
          revokeImagePreviewUrl(prepared)
          return
        }
        if (pendingImageRef.current) {
          revokeImagePreviewUrl(pendingImageRef.current)
        }
        pendingImageRef.current = prepared
        setPendingImage(prepared)
        requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
      } catch (err) {
        if (contextEpochRef.current !== prepEpoch) return
        pushToast(
          'warning',
          'Could not process image',
          err instanceof Error ? err.message : 'Unable to strip EXIF and compress image.'
        )
      } finally {
        if (contextEpochRef.current === prepEpoch) {
          setPreparingImage(false)
        }
      }
    },
    [canSign, preparingImage, pushToast]
  )

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) {
      void stageImageFile(file)
    }
  }

  const handleTakePhoto = () => {
    setAttachMenuOpen(false)
    if (!canSign || preparingImage) return
    if (isMobileCameraCaptureDevice()) {
      cameraInputRef.current?.click()
      return
    }
    setCameraModalOpen(true)
  }

  const handleChoosePhoto = () => {
    setAttachMenuOpen(false)
    if (!canSign || preparingImage) return
    fileInputRef.current?.click()
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (items) {
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            void stageImageFile(file)
            return
          }
        }
      }
    }
    const files = e.clipboardData?.files
    if (files && files.length > 0) {
      const imgFile = Array.from(files).find((f) => isSupportedImageFile(f))
      if (imgFile) {
        e.preventDefault()
        void stageImageFile(imgFile)
      }
    }
  }

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canSign || !dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canSign || !dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    if (!canSign) return
    const dropped = Array.from(e.dataTransfer.files)
    const imgFile = dropped.find((f) => isSupportedImageFile(f)) ?? dropped[0]
    if (imgFile) {
      void stageImageFile(imgFile)
    }
  }

  const keepTextareaFocused = (e: React.SyntheticEvent) => {
    e.preventDefault()
  }

  const handleSubmit = (keepFocus = false) => {
    const trimmed = draft.trim()
    const stagedSnapshot = pendingImageRef.current ?? pendingImage
    if ((!trimmed && !stagedSnapshot) || !canSign) return

    const textarea = textareaRef.current
    const shouldKeepFocus =
      Boolean(textarea) && (document.activeElement === textarea || keepFocus)

    const restoreFocusSynchronously = () => {
      if (!shouldKeepFocus) return
      const el = textareaRef.current
      if (!el) return
      el.style.height = 'auto'
      el.focus({ preventScroll: true })
      requestAnimationFrame(() => {
        const cur = textareaRef.current
        if (
          cur &&
          document.activeElement !== cur &&
          (document.activeElement === document.body || document.activeElement === null)
        ) {
          cur.focus({ preventScroll: true })
        }
      })
    }

    // Snapshot target context synchronously at submit time
    const submitSeq = ++submitSeqRef.current
    const submitTargetKey = activeTargetKey
    const submitIsServer = isServer
    const submitIsDm = isDm
    const submitDmThread = dmThread
    const submitIsViolet = isViolet
    const submitSourceLang = engine.translator.settings.myLanguage
    const submitTargetLang = outgoingTargetLang

    const restoreDraftIfSafe = () => {
      if (
        trimmed &&
        activeTargetKeyRef.current === submitTargetKey &&
        submitSeqRef.current === submitSeq
      ) {
        setDraft((curr) => (curr ? curr : trimmed))
      }
    }

    if (stagedSnapshot || !trimmed.startsWith('/')) clearDmReplyOnSubmit()

    if (stagedSnapshot) {
      const staged = detachPendingImage() ?? stagedSnapshot
      const caption = trimmed || undefined
      if (trimmed) {
        setHistory((prev) => [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, 30))
        setHistoryIdx(-1)
      }
      setDraft('')
      setCursorPos(0)
      restoreFocusSynchronously()

      const dispatchImage = (): Promise<boolean> =>
        submitIsServer
          ? engine.servers.sendImageAttachment(staged, caption)
          : engine.sendImageAttachment(staged, caption, dmContext)

      let sendPromise: Promise<boolean>
      if (composerQueueRef.current.getPendingCount(submitTargetKey) > 0) {
        // Wait behind any in-flight outgoing translation for this conversation so image stays in exact order,
        // handing off immediately into the engine's inner FIFO queue without blocking subsequent items.
        let innerImagePromise: Promise<boolean> | null = null
        sendPromise = composerQueueRef.current
          .enqueue(
            submitTargetKey,
            async () => {
              innerImagePromise = dispatchImage()
              return true
            },
            () => {
              revokeImagePreviewUrl(staged)
              return false
            }
          )
          .then((handedOff) => (handedOff && innerImagePromise ? innerImagePromise : false))
      } else {
        // Fast path: 0ms handoff into engine's per-conversation FIFO queue
        sendPromise = dispatchImage()
      }

      void sendPromise.then((ok) => {
        if (ok) {
          onSent?.(submitIsViolet)
        } else {
          restoreDraftIfSafe()
        }
      })
      return
    }

    setHistory((prev) => [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, 30))
    setHistoryIdx(-1)
    setDraft('')
    setCursorPos(0)
    restoreFocusSynchronously()

    const isSlashCmd = trimmed.startsWith('/')
    const shouldTranslate = outgoingTranslateActive && !isSlashCmd

    const dispatchText = (
      outgoingBody: string,
      translatedMeta?: { originalText: string; translatedToLang: string; sourceLang: string }
    ): Promise<boolean> => {
      if (submitIsServer) {
        if (outgoingBody.toLowerCase() === '/clear') {
          engine.servers.clearChannelCache()
          return Promise.resolve(true)
        }
        if (/^\/me\s+/i.test(outgoingBody)) {
          const action = outgoingBody.replace(/^\/me\s+/i, '').trim()
          return action
            ? engine.servers.sendMessage(`* ${engine.identity.nickname} ${action} *`)
            : Promise.resolve(false)
        }
        return engine.servers.sendMessage(
          outgoingBody,
          translatedMeta
            ? {
                onPublishedId: (id) => {
                  engine.translator.recordOutgoingOriginal(
                    id,
                    translatedMeta.originalText,
                    outgoingBody,
                    translatedMeta.translatedToLang,
                    translatedMeta.sourceLang
                  )
                },
              }
            : undefined
        )
      }
      if (submitIsDm && submitDmThread && !outgoingBody.startsWith('/')) {
        const onPublishedId = translatedMeta
          ? (id: string) => {
              engine.translator.recordOutgoingOriginal(
                id,
                translatedMeta.originalText,
                outgoingBody,
                translatedMeta.translatedToLang,
                translatedMeta.sourceLang
              )
            }
          : undefined
        return engine.sendDirectMessage(
          submitDmThread.peerPubkey,
          outgoingBody,
          submitDmThread.protocol,
          onPublishedId,
          dmContext?.replyToId
        )
      }
      return engine.sendInput(outgoingBody, translatedMeta)
    }

    // Slash commands execute immediately without waiting behind queued message publishes
    if (isSlashCmd) {
      void dispatchText(trimmed).then((ok) => {
        if (ok) {
          onSent?.(submitIsViolet)
        } else {
          restoreDraftIfSafe()
        }
      })
      return
    }

    // Fast path: no outgoing translation active or pending -> dispatch synchronously (0ms optimistic bubble!)
    // Engine's own per-conversation KeyedFifoQueue guarantees strict 1 -> 2 -> 3 wire order.
    if (!shouldTranslate && composerQueueRef.current.getPendingCount(submitTargetKey) === 0) {
      void dispatchText(trimmed).then((ok) => {
        if (ok) {
          onSent?.(submitIsViolet)
        } else {
          restoreDraftIfSafe()
        }
      })
      return
    }

    // Queued path: serialize translation + handoff strictly FIFO per conversation (zero deadlock:
    // handoff returns as soon as the message enters the engine's inner FIFO queue!)
    let innerSendPromise: Promise<boolean> | null = null
    void composerQueueRef.current
      .enqueue(
        submitTargetKey,
        async (): Promise<boolean> => {
          let outgoingBody = trimmed
          let translatedMeta:
            | { originalText: string; translatedToLang: string; sourceLang: string }
            | undefined

          if (shouldTranslate) {
            adjustTranslating(1)
            try {
              const translated = (
                await engine.translator.translateOutgoingText(
                  trimmed,
                  submitTargetLang,
                  submitSourceLang
                )
              ).trim()
              if (!translated) {
                throw new Error('Translator returned an empty message.')
              }
              outgoingBody = translated
              translatedMeta = {
                originalText: trimmed,
                translatedToLang: submitTargetLang,
                sourceLang: submitSourceLang,
              }
            } catch (err) {
              pushToast(
                'warning',
                'Outgoing translation failed',
                err instanceof Error ? err.message : 'Unable to translate message before sending.'
              )
              restoreDraftIfSafe()
              return false
            } finally {
              adjustTranslating(-1)
            }
          }

          // Guard Bitchat/Group sends against landing in a different room if the user switched rooms mid-translation
          if (!submitIsDm && activeTargetKeyRef.current !== submitTargetKey) {
            pushToast(
              'warning',
              'Switched rooms before translation finished',
              'Message was not sent to the new room.'
            )
            return false
          }

          // Synchronously appends optimistic UI & enqueues publish in the engine's inner FIFO queue
          innerSendPromise = dispatchText(outgoingBody, translatedMeta)
          return true
        },
        () => false
      )
      .then((handoffOk) => (handoffOk && innerSendPromise ? innerSendPromise : null))
      .then((ok) => {
        if (ok === null) return
        if (ok) {
          onSent?.(submitIsViolet)
        } else {
          restoreDraftIfSafe()
        }
      })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (autocomplete.type !== 'none') {
      const count = autocomplete.items.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % count)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + count) % count)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        if (
          e.key === 'Enter' &&
          autocomplete.type === 'command' &&
          autocomplete.items[selectedIndex] &&
          draft.trim() === `/${autocomplete.items[selectedIndex].name}`
        ) {
          e.preventDefault()
          handleSubmit()
          return
        }
        e.preventDefault()
        if (autocomplete.type === 'command') {
          const item = autocomplete.items[selectedIndex]
          if (item) applyCommandCompletion(item)
        } else {
          const peer = autocomplete.items[selectedIndex]
          if (peer) applyMentionCompletion(peer, autocomplete.startIdx, autocomplete.endIdx)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSelectedIndex(0)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
      return
    }

    if (e.key === 'ArrowUp' && draft.length === 0 && history.length > 0) {
      e.preventDefault()
      const nextIdx = Math.min(historyIdx + 1, history.length - 1)
      setHistoryIdx(nextIdx)
      const recalled = history[nextIdx]
      if (recalled) {
        setDraft(recalled)
        setCursorPos(recalled.length)
      }
      return
    }

    if (e.key === 'Escape') {
      if (pendingImage) {
        e.preventDefault()
        clearPendingImage()
        return
      }
      if (activeReply) {
        e.preventDefault()
        if (isServer) engine.servers.setReplyingTo(null)
        else if (isDm) engine.setDmReplyingTo(null)
        else engine.setReplyingTo(null)
      }
    }
  }

  const handleCancelVoice = useCallback(() => {
    setVoiceMode(false)
  }, [])

  const handleVoiceErrorToast = useCallback(
    (title: string, detail?: string) => {
      pushToast('warning', title, detail)
    },
    [pushToast]
  )

  const handleSendVoiceMemo = (
    recorded: RecordedVoiceMemo,
    caption: string,
    previewTranscript?: VoicePreviewTranscript
  ): Promise<boolean> => {
    clearDmReplyOnSubmit()
    submitSeqRef.current += 1
    const submitTargetKey = activeTargetKey
    const submitIsServer = isServer
    const submitIsViolet = isViolet

    const cleanTranscript = previewTranscript?.text.trim()
    const payload: RecordedVoiceMemo = cleanTranscript
      ? {
          ...recorded,
          previewTranscript: cleanTranscript,
          previewTranscriptModel: previewTranscript?.modelLabel,
        }
      : recorded

    const dispatchVoice = (): Promise<boolean> =>
      submitIsServer
        ? engine.servers.sendVoiceMemo(payload, caption)
        : engine.sendVoiceMemo(payload, caption, dmContext)

    let sendPromise: Promise<boolean>
    if (composerQueueRef.current.getPendingCount(submitTargetKey) > 0) {
      // Preserve strict FIFO order behind any in-flight outgoing translation in this conversation,
      // handing off immediately into the engine's inner FIFO queue without blocking subsequent items.
      let innerVoicePromise: Promise<boolean> | null = null
      sendPromise = composerQueueRef.current
        .enqueue(
          submitTargetKey,
          async () => {
            innerVoicePromise = dispatchVoice()
            return true
          },
          () => {
            revokeVoicePreviewUrl(payload)
            return false
          }
        )
        .then((handedOff) => (handedOff && innerVoicePromise ? innerVoicePromise : false))
    } else {
      sendPromise = dispatchVoice()
    }

    void sendPromise.then((ok) => {
      if (ok) {
        onSent?.(submitIsViolet)
      }
    })

    return Promise.resolve(true)
  }

  const handleSendTranscribedText = (text: string): Promise<boolean> => {
    const trimmed = text.trim()
    if (!trimmed || !canSign) return Promise.resolve(false)

    if (!trimmed.startsWith('/')) clearDmReplyOnSubmit()
    submitSeqRef.current += 1
    const submitTargetKey = activeTargetKey
    const submitIsServer = isServer
    const submitIsDm = isDm
    const submitDmThread = dmThread
    const submitIsViolet = isViolet
    const submitSourceLang = engine.translator.settings.myLanguage
    const submitTargetLang = outgoingTargetLang
    const shouldTranslate = outgoingTranslateActive && !trimmed.startsWith('/')

    const dispatchText = (
      outgoingBody: string,
      translatedMeta?: { originalText: string; translatedToLang: string; sourceLang: string }
    ): Promise<boolean> => {
      if (submitIsServer) {
        return engine.servers.sendMessage(
          outgoingBody,
          translatedMeta
            ? {
                onPublishedId: (id) => {
                  engine.translator.recordOutgoingOriginal(
                    id,
                    translatedMeta.originalText,
                    outgoingBody,
                    translatedMeta.translatedToLang,
                    translatedMeta.sourceLang
                  )
                },
              }
            : undefined
        )
      }
      if (submitIsDm && submitDmThread && !outgoingBody.startsWith('/')) {
        const onPublishedId = translatedMeta
          ? (id: string) => {
              engine.translator.recordOutgoingOriginal(
                id,
                translatedMeta.originalText,
                outgoingBody,
                translatedMeta.translatedToLang,
                translatedMeta.sourceLang
              )
            }
          : undefined
        return engine.sendDirectMessage(
          submitDmThread.peerPubkey,
          outgoingBody,
          submitDmThread.protocol,
          onPublishedId,
          dmContext?.replyToId
        )
      }
      return engine.sendInput(outgoingBody, translatedMeta)
    }

    let sendPromise: Promise<boolean>
    if (!shouldTranslate && composerQueueRef.current.getPendingCount(submitTargetKey) === 0) {
      sendPromise = dispatchText(trimmed)
    } else {
      let innerSendPromise: Promise<boolean> | null = null
      sendPromise = composerQueueRef.current
        .enqueue(
          submitTargetKey,
          async () => {
            let outgoingBody = trimmed
            let translatedMeta:
              | { originalText: string; translatedToLang: string; sourceLang: string }
              | undefined
            if (shouldTranslate) {
              adjustTranslating(1)
              try {
                const translated = (
                  await engine.translator.translateOutgoingText(
                    trimmed,
                    submitTargetLang,
                    submitSourceLang
                  )
                ).trim()
                if (translated) {
                  outgoingBody = translated
                  translatedMeta = {
                    originalText: trimmed,
                    translatedToLang: submitTargetLang,
                    sourceLang: submitSourceLang,
                  }
                }
              } catch (err) {
                pushToast(
                  'warning',
                  'Outgoing translation failed',
                  err instanceof Error ? err.message : 'Unable to translate message before sending.'
                )
                return false
              } finally {
                adjustTranslating(-1)
              }
            }
            if (!submitIsDm && activeTargetKeyRef.current !== submitTargetKey) {
              pushToast(
                'warning',
                'Switched rooms before translation finished',
                'Message was not sent to the new room.'
              )
              return false
            }
            innerSendPromise = dispatchText(outgoingBody, translatedMeta)
            return true
          },
          () => false
        )
        .then((handoffOk) => (handoffOk && innerSendPromise ? innerSendPromise : false))
    }

    void sendPromise.then((ok) => {
      if (ok) {
        setHistory((prev) => [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, 30))
        setHistoryIdx(-1)
        onSent?.(submitIsViolet)
      }
    })

    return Promise.resolve(true)
  }

  const replyPreviewText = useMemo(() => {
    const target = activeReply
    if (!target) return ''
    if (target.voiceMemo) {
      const stripped = target.content.split(target.voiceMemo.url).join('').trim()
      if (stripped) return stripped.slice(0, 72)
      return `Voice memo (${formatVoiceDuration(target.voiceMemo.durationSec)})`
    }
    if (target.imageAttachment) {
      const stripped = target.content.split(target.imageAttachment.url).join('').trim()
      if (stripped) return stripped.slice(0, 72)
      return `Image (${target.imageAttachment.width}×${target.imageAttachment.height})`
    }
    return target.content.slice(0, 72)
  }, [activeReply])

  const placeholder = !canSign
    ? engine.identity.signMode === 'extension'
      ? 'No NIP-07 extension — switch signer in Settings…'
      : 'Enter a valid nsec key in Settings to send…'
    : pendingImage
      ? 'Add a caption…'
      : isDm && dmThread
        ? `Message ${dmThread.peerNickname}…`
        : isServer && activeChannel
          ? `Message #${activeChannel.name}…`
          : `Message ${formatBitchatChannelLabel(engine.activeGeohash)}…`

  const hasContentToSend = draft.trim().length > 0 || pendingImage !== null
  const hasTopBanner = Boolean(activeReply)

  return (
    <div className="ag-composer-dock">
      <div
        className={`ag-composer-inner ag-composer-dropzone ${isViolet ? 'dm' : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/*"
          className="sr-only"
          onChange={handleFileInputChange}
          aria-hidden="true"
          tabIndex={-1}
        />

        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={handleFileInputChange}
          aria-hidden="true"
          tabIndex={-1}
        />

        {dragActive && (
          <div className="ag-composer-drop-overlay" role="status">
            <ImagePlus size={18} />
            <span>
              {isViolet
                ? 'Drop image to encrypt & send (EXIF stripped)'
                : 'Drop image to attach (EXIF stripped)'}
            </span>
          </div>
        )}

        {/* Slash Command Autocomplete Popup */}
        {!voiceMode && autocomplete.type === 'command' && (
          <div className="ag-autocomplete-popup" role="listbox" aria-label="Slash commands">
            <div className="ag-ac-head">
              <span>Commands</span>
              <span>Tab or Enter</span>
            </div>
            {autocomplete.items.map((cmd, idx) => (
              <button
                key={cmd.name}
                type="button"
                role="option"
                aria-selected={idx === selectedIndex}
                className={`ag-ac-item ${idx === selectedIndex ? 'selected' : ''}`}
                onPointerDown={keepTextareaFocused}
                onMouseDown={keepTextareaFocused}
                onClick={() => applyCommandCompletion(cmd)}
              >
                <div className="ag-ac-left">
                  <span className="ag-ac-cmd">/{cmd.name}</span>
                  <span className="ag-ac-usage">{cmd.usage.replace(`/${cmd.name}`, '').trim()}</span>
                </div>
                <span className="ag-ac-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}

        {/* @Mention Peer Autocomplete Popup */}
        {!voiceMode && autocomplete.type === 'mention' && (
          <div className="ag-autocomplete-popup" role="listbox" aria-label="Mention someone">
            <div className="ag-ac-head">
              <span>
                {isServer && activeServer
                  ? activeServer.name
                  : formatBitchatChannelLabel(engine.activeGeohash)}
              </span>
              <span>Tab or Enter</span>
            </div>
            {autocomplete.items.map((peer, idx) => (
              <button
                key={peer.pubkey}
                type="button"
                role="option"
                aria-selected={idx === selectedIndex}
                className={`ag-ac-item ${idx === selectedIndex ? 'selected' : ''}`}
                onPointerDown={keepTextareaFocused}
                onMouseDown={keepTextareaFocused}
                onClick={() =>
                  applyMentionCompletion(peer, autocomplete.startIdx, autocomplete.endIdx)
                }
              >
                <div className="ag-ac-left">
                  <AvatarImg
                    pubkey={peer.pubkey}
                    pictureUrl={engine.getProfilePicture(peer.pubkey)}
                    alt=""
                    width={24}
                    height={24}
                    className="ag-ac-avatar ag-mention-avatar"
                  />
                  <span style={{ fontWeight: 600, color: pubkeyToColor(peer.pubkey) }}>
                    {peer.displayHandle}
                  </span>
                </div>
                <span className="ag-ac-desc">{peer.subtitle}</span>
              </button>
            ))}
          </div>
        )}

        {/* Outgoing Translation Indicator Strip (Double-Column Translator Mode) */}
        {outgoingTranslateActive && !voiceMode && (
          <div
            className={`ag-composer-translate-strip ${isViolet ? 'dm' : ''} ${activeReply || pendingImage ? 'has-next' : ''}`}
            role="status"
          >
            <div className="ag-composer-translate-left truncate">
              {translatingOutgoing ? (
                <Loader2 size={13} className="ag-spin" />
              ) : (
                <Languages size={13} />
              )}
              <span className="truncate">
                {translatingOutgoing
                  ? `Translating to ${outgoingTargetLang}…`
                  : `Auto-translating outgoing → ${outgoingTargetLang}`}
              </span>
            </div>
            <button
              type="button"
              className="ag-composer-translate-off"
              onPointerDown={keepTextareaFocused}
              onMouseDown={keepTextareaFocused}
              onClick={() => engine.translator.updateSettings({ outgoingEnabled: false })}
              title="Turn off outgoing translation"
            >
              Off
            </button>
          </div>
        )}

        {/* Contextual Reply Strip */}
        {activeReply && (
          <div
            className={`ag-composer-reply-strip ${isViolet ? 'dm' : ''} ${pendingImage && !voiceMode ? 'has-next' : ''}`}
          >
            <div className="ag-composer-reply-left">
              <CornerUpLeft size={14} className="ag-composer-reply-icon" />
              <div className="ag-composer-reply-text truncate">
                <span className="ag-composer-reply-who">
                  Replying to <strong>{activeReply.nickname}</strong>
                </span>
                <span className="ag-composer-reply-snippet truncate">{replyPreviewText}</span>
              </div>
            </div>
            <button
              type="button"
              className="ag-mini-circle-btn"
              onPointerDown={keepTextareaFocused}
              onMouseDown={keepTextareaFocused}
              onClick={() =>
                isServer ? engine.servers.setReplyingTo(null) : isDm ? engine.setDmReplyingTo(null) : engine.setReplyingTo(null)
              }
              aria-label="Cancel reply"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Staged Image Preview Strip */}
        {pendingImage && !voiceMode && (
          <div
            className={`ag-composer-img-preview ${isViolet ? 'dm' : ''} ${hasTopBanner ? 'stacked' : ''}`}
            role="region"
            aria-label="Staged image preview"
          >
            <div className="ag-composer-img-preview-left">
              <div className="ag-composer-img-thumb-wrap">
                <img
                  src={pendingImage.previewUrl}
                  alt={pendingImage.fileName}
                  className="ag-composer-img-thumb"
                />
              </div>
              <div className="ag-composer-img-meta">
                <div className="ag-composer-img-name-row">
                  <span className="ag-composer-img-name truncate">{pendingImage.fileName}</span>
                  {isViolet && (
                    <span
                      className="ag-badge dm"
                      title="Encrypted with AES-256-GCM before upload"
                    >
                      <Lock size={10} />
                      E2EE
                    </span>
                  )}
                </div>
                <div className="ag-composer-img-sub tabular">
                  <span>
                    {pendingImage.width}×{pendingImage.height} · {formatImageBytes(pendingImage.size)} · EXIF stripped
                  </span>
                </div>
              </div>
            </div>
            <button
              type="button"
              className="ag-composer-img-discard"
              onPointerDown={keepTextareaFocused}
              onMouseDown={keepTextareaFocused}
              onClick={clearPendingImage}
              title="Discard image (Esc)"
              aria-label="Discard staged image"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {/* Sleek Full-Width Input Bar OR Voice Recorder Bar */}
        {voiceMode ? (
          <VoiceRecorderBar
            isDm={isViolet}
            hasBanner={Boolean(activeReply)}
            transcription={engine.transcription}
            onSend={handleSendVoiceMemo}
            onSendText={handleSendTranscribedText}
            onCancel={handleCancelVoice}
            onErrorToast={handleVoiceErrorToast}
          />
        ) : (
          <form
            className={`ag-composer-bar ${isViolet ? 'dm' : ''} ${activeReply || pendingImage || outgoingTranslateActive ? 'with-strip' : ''}`}
            onSubmit={(e) => {
              e.preventDefault()
              handleSubmit(true)
            }}
          >
            {/* Left Compact Attach-Media Button + Upward Popover Menu */}
            <div className="ag-attach-wrap" ref={attachWrapRef}>
              {attachMenuOpen && (
                <div
                  className={`ag-attach-menu ${isViolet ? 'dm' : ''}`}
                  role="menu"
                  aria-label="Attach photo"
                  data-no-swipe="true"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="ag-attach-menu-item"
                    onClick={handleTakePhoto}
                  >
                    <span className="ag-attach-menu-icon" aria-hidden="true">
                      <Camera size={16} />
                    </span>
                    <span className="ag-attach-menu-copy">
                      <span className="ag-attach-menu-label">Take Photo</span>
                      <span className="ag-attach-menu-sub">Use camera</span>
                    </span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className="ag-attach-menu-item"
                    onClick={handleChoosePhoto}
                  >
                    <span className="ag-attach-menu-icon" aria-hidden="true">
                      <ImageIcon size={16} />
                    </span>
                    <span className="ag-attach-menu-copy">
                      <span className="ag-attach-menu-label">Choose Photo</span>
                      <span className="ag-attach-menu-sub">Library or file</span>
                    </span>
                  </button>
                </div>
              )}

              <button
                type="button"
                className={`ag-composer-icon-btn ${isViolet ? 'dm' : ''} ${pendingImage || attachMenuOpen ? 'active' : ''}`}
                disabled={!canSign || preparingImage}
                onPointerDown={keepTextareaFocused}
                onMouseDown={keepTextareaFocused}
                onClick={() => setAttachMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={attachMenuOpen}
                title={
                  !canSign
                    ? 'Configure a signing key in Settings to send images'
                    : isViolet
                      ? 'Attach or take encrypted photo (EXIF stripped)'
                      : 'Attach or take photo (EXIF stripped)'
                }
                aria-label={isViolet ? 'Attach encrypted photo' : 'Attach photo'}
              >
                {preparingImage ? (
                  <Loader2 size={17} className="ag-spin" />
                ) : (
                  <ImagePlus size={18} />
                )}
              </button>
            </div>

            {/* Full-Width Auto-Growing Input (16px on mobile; never disabled while sending) */}
            <textarea
              ref={textareaRef}
              className="ag-composer-input"
              rows={1}
              value={draft}
              disabled={!canSign}
              enterKeyHint="send"
              placeholder={placeholder}
              onChange={(e) => {
                if (attachMenuOpen) setAttachMenuOpen(false)
                setDraft(e.target.value)
                setCursorPos(e.target.selectionStart ?? e.target.value.length)
              }}
              onClick={(e) => setCursorPos(e.currentTarget.selectionStart ?? draft.length)}
              onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart ?? draft.length)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              aria-label={placeholder}
            />

            {/* Right Compact Action Cluster: Mic + Accent Send (stably mounted; never blocked while prior messages confirm) */}
            <div className="ag-composer-right">
              <button
                type="button"
                className={`ag-composer-icon-btn ${isViolet ? 'dm' : ''}`}
                disabled={!voiceSupported || !canSign}
                onClick={() => {
                  setAttachMenuOpen(false)
                  clearPendingImage()
                  setPreparingImage(false)
                  setVoiceMode(true)
                }}
                title={
                  !voiceSupported
                    ? 'Voice memos require microphone support in this browser'
                    : !canSign
                      ? 'Configure a signing key in Settings to record voice memos'
                      : isViolet
                        ? 'Record encrypted voice memo'
                        : 'Record voice memo'
                }
                aria-label={isViolet ? 'Record encrypted voice memo' : 'Record voice memo'}
              >
                <Mic size={17} />
              </button>

              <button
                type="submit"
                className={`ag-composer-send-btn ${isViolet ? 'dm' : ''} ${hasContentToSend ? 'ready' : ''}`}
                disabled={!hasContentToSend || !canSign}
                onPointerDown={keepTextareaFocused}
                onMouseDown={keepTextareaFocused}
                title="Send message"
                aria-label="Send message"
              >
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
            </div>
          </form>
        )}
      </div>

      <CameraCaptureModal
        open={cameraModalOpen}
        onClose={() => setCameraModalOpen(false)}
        onCapture={(file) => {
          setCameraModalOpen(false)
          void stageImageFile(file)
        }}
        onFallbackChooseFile={() => {
          setCameraModalOpen(false)
          fileInputRef.current?.click()
        }}
      />
    </div>
  )
}

export default Composer
