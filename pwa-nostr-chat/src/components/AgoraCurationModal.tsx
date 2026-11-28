import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BellOff,
  Check,
  ExternalLink,
  Hash,
  List,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import type { AgoraCustomList } from '../types/agora.ts'
import type { AgnostrEngine } from '../types/protocol.ts'
import { getProfileDisplayName, sanitizeHttpUrl } from '../lib/agoraProtocol.ts'
import { encodeNpubSafe } from '../lib/identity.ts'
import { useBackHandler } from '../hooks/useBackNavigation.ts'
import { identiconDataUrl, shortPubkey } from '../utils/identicon.ts'
import type { SoundCue } from '../utils/sound.ts'

export interface AgoraCurationModalProps {
  open: boolean
  engine: AgnostrEngine
  onClose: () => void
  initialTab?: 'mutes' | 'lists'
  onPlaySound?: (cue: SoundCue) => void
}

interface MemberAvatarProps {
  engine: AgnostrEngine
  pubkey: string
  picture?: string
  alt: string
}

const MemberAvatar: React.FC<MemberAvatarProps> = ({ engine, pubkey, picture, alt }) => {
  const { contentFilter } = engine
  const requestedRef = useRef<string | null>(null)
  const pk = pubkey.trim().toLowerCase()
  const safeHttpsUrl = useMemo(() => {
    const clean = sanitizeHttpUrl(picture)
    return clean && clean.startsWith('https://') ? clean : null
  }, [picture])
  const cacheKey = safeHttpsUrl ? `agora-img:${pk || 'anon'}:${safeHttpsUrl}` : ''
  const verdict = cacheKey ? contentFilter.getVerdict(cacheKey) : null
  const safeBlobUrl =
    cacheKey && verdict?.status === 'safe' ? contentFilter.getSafeImageObjectUrl(cacheKey) : null
  const identicon = useMemo(() => identiconDataUrl(pk || 'anon'), [pk])

  useEffect(() => {
    if (!safeHttpsUrl || !cacheKey) return
    const needsScreen = !verdict || verdict.status === 'idle'
    const needsRehydrate = verdict?.status === 'safe' && !safeBlobUrl
    if (!needsScreen && !needsRehydrate) return
    if (requestedRef.current === cacheKey) return
    requestedRef.current = cacheKey
    void contentFilter.screenExternalImageUrl(cacheKey, safeHttpsUrl, pk)
  }, [safeHttpsUrl, cacheKey, verdict, safeBlobUrl, contentFilter, pk])

  return (
    <img
      src={safeBlobUrl || identicon}
      alt={alt}
      className="ag-agora-avatar ag-agora-avatar-xs"
      loading="lazy"
    />
  )
}

export const AgoraCurationModal: React.FC<AgoraCurationModalProps> = ({
  open,
  engine,
  onClose,
  initialTab = 'mutes',
  onPlaySound,
}) => {
  const { agora } = engine
  const [tab, setTab] = useState<'mutes' | 'lists'>(initialTab)
  const [muteInput, setMuteInput] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // List creation / editing state
  const [editingDTag, setEditingDTag] = useState<string | null>(null)
  const [creatingList, setCreatingList] = useState(false)
  const [listTitle, setListTitle] = useState('')
  const [listDescription, setListDescription] = useState('')
  const [listPubkeys, setListPubkeys] = useState<string[]>([])
  const [memberFilter, setMemberFilter] = useState('')

  useBackHandler(open, onClose)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  // Candidate profiles for list picker (followed first, then cached profiles)
  const candidateProfiles = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ pubkey: string; name: string; secondary: string; picture?: string; followed: boolean }> = []
    const addPk = (rawPk: string, followed: boolean) => {
      const pk = rawPk.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(pk) || seen.has(pk)) return
      seen.add(pk)
      const profile = agora.profilesByPubkey[pk]
      const name = getProfileDisplayName(profile, pk)
      const secondary = profile?.nip05?.trim() || shortPubkey(encodeNpubSafe(pk))
      out.push({ pubkey: pk, name, secondary, picture: profile?.picture, followed })
    }
    for (const pk of agora.followingPubkeys) addPk(pk, true)
    for (const pk of listPubkeys) addPk(pk, agora.isFollowing(pk))
    for (const profile of Object.values(agora.profilesByPubkey)) {
      addPk(profile.pubkey, agora.isFollowing(profile.pubkey))
    }
    return out
  }, [agora, listPubkeys])

  const filteredCandidates = useMemo(() => {
    const q = memberFilter.trim().toLowerCase()
    if (!q) return candidateProfiles.slice(0, 40)
    return candidateProfiles
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.secondary.toLowerCase().includes(q) ||
          c.pubkey.includes(q)
      )
      .slice(0, 40)
  }, [candidateProfiles, memberFilter])

  if (!open || typeof document === 'undefined') return null

  const handleAddMute = async (e: React.FormEvent) => {
    e.preventDefault()
    const clean = muteInput.trim()
    if (!clean || busyKey) return
    setBusyKey('add-mute')
    try {
      const ok = await agora.addMutedWord(clean)
      if (ok) {
        setMuteInput('')
        onPlaySound?.('click')
      } else {
        engine.pushToast('error', 'Could not update mute list', 'Try again in a moment.')
      }
    } finally {
      setBusyKey(null)
    }
  }

  const handleRemoveMute = async (word: string) => {
    if (busyKey) return
    setBusyKey(`rm-mute:${word}`)
    try {
      await agora.removeMutedWord(word)
      onPlaySound?.('click')
    } finally {
      setBusyKey(null)
    }
  }

  const handleUnmuteThread = async (rootId: string) => {
    if (busyKey) return
    setBusyKey(`unmute-thread:${rootId}`)
    try {
      await agora.unmuteThread(rootId)
      onPlaySound?.('click')
    } finally {
      setBusyKey(null)
    }
  }

  const startCreateList = () => {
    setEditingDTag(null)
    setCreatingList(true)
    setListTitle('')
    setListDescription('')
    setListPubkeys([])
    setMemberFilter('')
  }

  const startEditList = (list: AgoraCustomList) => {
    setCreatingList(false)
    setEditingDTag(list.dTag)
    setListTitle(list.title)
    setListDescription(list.description ?? '')
    setListPubkeys([...list.pubkeys])
    setMemberFilter('')
  }

  const cancelListEditor = () => {
    setCreatingList(false)
    setEditingDTag(null)
    setListTitle('')
    setListDescription('')
    setListPubkeys([])
    setMemberFilter('')
  }

  const toggleMemberPubkey = (pk: string) => {
    setListPubkeys((prev) => (prev.includes(pk) ? prev.filter((p) => p !== pk) : [...prev, pk]))
  }

  const handleSaveList = async (e: React.FormEvent) => {
    e.preventDefault()
    const cleanTitle = listTitle.trim()
    if (!cleanTitle || busyKey) return
    const cleanDesc = listDescription.trim() || undefined

    setBusyKey('save-list')
    try {
      if (editingDTag) {
        const ok = await agora.updateCustomList(editingDTag, {
          title: cleanTitle,
          description: cleanDesc,
          pubkeys: listPubkeys,
        })
        if (ok) {
          onPlaySound?.('send')
          cancelListEditor()
        } else {
          engine.pushToast('error', 'Could not update list', 'Try again in a moment.')
        }
      } else {
        const created = await agora.createCustomList(cleanTitle, listPubkeys, cleanDesc)
        if (created) {
          onPlaySound?.('send')
          cancelListEditor()
        } else {
          engine.pushToast('error', 'Could not create list', 'Try again in a moment.')
        }
      }
    } finally {
      setBusyKey(null)
    }
  }

  const handleDeleteList = async (list: AgoraCustomList) => {
    if (busyKey) return
    setBusyKey(`del-list:${list.dTag}`)
    try {
      const ok = await agora.deleteCustomList(list.dTag)
      if (ok) {
        onPlaySound?.('click')
        if (editingDTag === list.dTag) cancelListEditor()
      } else {
        engine.pushToast('error', 'Could not delete list', 'Try again in a moment.')
      }
    } finally {
      setBusyKey(null)
    }
  }

  const isEditingAnyList = creatingList || editingDTag !== null

  return createPortal(
    <div
      className="ag-agora-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Mutes and Custom Feeds"
      onClick={onClose}
    >
      <div
        className="ag-agora-curation-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ag-agora-curation-head">
          <div className="ag-agora-curation-title-row">
            <h2 className="ag-agora-curation-title">Mutes &amp; Custom Lists</h2>
            <button
              type="button"
              className="ag-agora-icon-btn"
              onClick={onClose}
              aria-label="Close curation modal"
            >
              <X size={16} />
            </button>
          </div>

          <div className="ag-agora-curation-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mutes'}
              className={`ag-agora-curation-tab${tab === 'mutes' ? ' active' : ''}`}
              onClick={() => setTab('mutes')}
            >
              <BellOff size={14} aria-hidden="true" />
              <span>Mutes</span>
              {agora.muteList.words.length +
                agora.muteList.hashtags.length +
                agora.muteList.threads.length >
                0 && (
                <span className="ag-agora-curation-count tabular">
                  {agora.muteList.words.length +
                    agora.muteList.hashtags.length +
                    agora.muteList.threads.length}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'lists'}
              className={`ag-agora-curation-tab${tab === 'lists' ? ' active' : ''}`}
              onClick={() => setTab('lists')}
            >
              <List size={14} aria-hidden="true" />
              <span>Custom Feeds</span>
              {agora.customLists.length > 0 && (
                <span className="ag-agora-curation-count tabular">{agora.customLists.length}</span>
              )}
            </button>
          </div>
        </div>

        <div className="ag-agora-curation-body">
          {tab === 'mutes' ? (
            <div className="ag-agora-curation-pane">
              <form className="ag-agora-curation-add-form" onSubmit={(e) => void handleAddMute(e)}>
                <input
                  type="text"
                  className="ag-agora-curation-input"
                  value={muteInput}
                  onChange={(e) => setMuteInput(e.target.value)}
                  placeholder="Mute a word or #hashtag…"
                  maxLength={64}
                  aria-label="Word or hashtag to mute"
                />
                <button
                  type="submit"
                  className="ag-agora-post-btn"
                  disabled={!muteInput.trim() || Boolean(busyKey)}
                >
                  {busyKey === 'add-mute' ? (
                    <Loader2 size={14} className="ag-agora-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  <span>Mute</span>
                </button>
              </form>

              <section className="ag-agora-curation-section">
                <h3 className="ag-agora-curation-section-title">Muted Words &amp; Hashtags</h3>
                {agora.muteList.words.length === 0 && agora.muteList.hashtags.length === 0 ? (
                  <p className="ag-agora-curation-empty">
                    No muted words or hashtags yet. Notes matching muted terms are hidden from your feeds.
                  </p>
                ) : (
                  <div className="ag-agora-curation-chips">
                    {agora.muteList.hashtags.map((tag) => (
                      <span key={`tag:${tag}`} className="ag-agora-mute-chip">
                        <Hash size={12} aria-hidden="true" />
                        <span>{tag}</span>
                        <button
                          type="button"
                          className="ag-agora-mute-chip-rm"
                          disabled={Boolean(busyKey)}
                          onClick={() => void handleRemoveMute(`#${tag}`)}
                          aria-label={`Unmute #${tag}`}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                    {agora.muteList.words.map((word) => (
                      <span key={`word:${word}`} className="ag-agora-mute-chip">
                        <span>{word}</span>
                        <button
                          type="button"
                          className="ag-agora-mute-chip-rm"
                          disabled={Boolean(busyKey)}
                          onClick={() => void handleRemoveMute(word)}
                          aria-label={`Unmute ${word}`}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </section>

              <section className="ag-agora-curation-section">
                <h3 className="ag-agora-curation-section-title">Muted Threads</h3>
                {agora.muteList.threads.length === 0 ? (
                  <p className="ag-agora-curation-empty">
                    No muted threads. Use the note menu to silence notifications on noisy threads.
                  </p>
                ) : (
                  <div className="ag-agora-curation-list">
                    {agora.muteList.threads.map((rootId) => {
                      const cached = agora.getNote(rootId)
                      const preview = cached?.content.trim()
                        ? cached.content.trim().slice(0, 96)
                        : `Thread ${shortPubkey(rootId)}`
                      return (
                        <div key={rootId} className="ag-agora-curation-row">
                          <div className="ag-agora-curation-row-info">
                            <span className="ag-agora-curation-row-title truncate">{preview}</span>
                            <span className="ag-agora-curation-row-sub mono">
                              {shortPubkey(rootId)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="ag-agora-composer-pill-btn"
                            disabled={Boolean(busyKey)}
                            onClick={() => void handleUnmuteThread(rootId)}
                          >
                            {busyKey === `unmute-thread:${rootId}` ? (
                              <Loader2 size={12} className="ag-agora-spin" />
                            ) : null}
                            <span>Unmute</span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div className="ag-agora-curation-pane">
              {!isEditingAnyList ? (
                <>
                  <div className="ag-agora-curation-toolbar">
                    <span className="ag-agora-curation-hint">
                      Curate NIP-51 people lists as custom Agora feed tabs.
                    </span>
                    <button
                      type="button"
                      className="ag-agora-post-btn"
                      onClick={startCreateList}
                    >
                      <Plus size={14} />
                      <span>New List</span>
                    </button>
                  </div>

                  {agora.customLists.length === 0 ? (
                    <p className="ag-agora-curation-empty">
                      No custom lists yet. Create a list to filter your feed to specific people.
                    </p>
                  ) : (
                    <div className="ag-agora-curation-list">
                      {agora.customLists.map((list) => (
                        <div key={list.id} className="ag-agora-curation-row">
                          <div className="ag-agora-curation-row-info">
                            <span className="ag-agora-curation-row-title truncate">
                              {list.title}
                            </span>
                            <span className="ag-agora-curation-row-sub">
                              <Users size={11} aria-hidden="true" />
                              <span>
                                {list.pubkeys.length}{' '}
                                {list.pubkeys.length === 1 ? 'person' : 'people'}
                              </span>
                              {list.description ? ` · ${list.description}` : ''}
                            </span>
                          </div>
                          <div className="ag-agora-curation-row-actions">
                            <button
                              type="button"
                              className="ag-agora-composer-pill-btn"
                              onClick={() => {
                                agora.setActiveListId(list.id)
                                onPlaySound?.('click')
                                onClose()
                              }}
                              title="Open custom feed"
                            >
                              <ExternalLink size={12} />
                              <span>Open Feed</span>
                            </button>
                            <button
                              type="button"
                              className="ag-agora-icon-btn"
                              onClick={() => startEditList(list)}
                              title="Edit list"
                              aria-label={`Edit ${list.title}`}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className="ag-agora-icon-btn"
                              disabled={Boolean(busyKey)}
                              onClick={() => void handleDeleteList(list)}
                              title="Delete list"
                              aria-label={`Delete ${list.title}`}
                            >
                              {busyKey === `del-list:${list.dTag}` ? (
                                <Loader2 size={14} className="ag-agora-spin" />
                              ) : (
                                <Trash2 size={14} />
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <form className="ag-agora-list-editor" onSubmit={(e) => void handleSaveList(e)}>
                  <div className="ag-agora-list-editor-head">
                    <h3>{editingDTag ? 'Edit Custom List' : 'Create Custom List'}</h3>
                    <button
                      type="button"
                      className="ag-agora-filter-clear"
                      onClick={cancelListEditor}
                      aria-label="Cancel list editor"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  <input
                    type="text"
                    className="ag-agora-curation-input"
                    value={listTitle}
                    onChange={(e) => setListTitle(e.target.value)}
                    placeholder="List title (e.g. Builders, Bitcoin Devs)…"
                    maxLength={60}
                    required
                    aria-label="List title"
                  />

                  <input
                    type="text"
                    className="ag-agora-curation-input"
                    value={listDescription}
                    onChange={(e) => setListDescription(e.target.value)}
                    placeholder="Short description (optional)…"
                    maxLength={140}
                    aria-label="List description"
                  />

                  <div className="ag-agora-member-picker">
                    <div className="ag-agora-member-picker-head">
                      <Search size={13} aria-hidden="true" />
                      <input
                        type="text"
                        className="ag-agora-member-search"
                        value={memberFilter}
                        onChange={(e) => setMemberFilter(e.target.value)}
                        placeholder={`Filter people (${listPubkeys.length} selected)…`}
                        aria-label="Filter people for list"
                      />
                    </div>

                    <div className="ag-agora-member-list">
                      {filteredCandidates.length === 0 ? (
                        <p className="ag-agora-curation-empty">No matching profiles loaded yet.</p>
                      ) : (
                        filteredCandidates.map((cand) => {
                          const selected = listPubkeys.includes(cand.pubkey)
                          return (
                            <button
                              key={cand.pubkey}
                              type="button"
                              className={`ag-agora-member-row${selected ? ' is-selected' : ''}`}
                              aria-pressed={selected}
                              onClick={() => toggleMemberPubkey(cand.pubkey)}
                            >
                              <MemberAvatar
                                engine={engine}
                                pubkey={cand.pubkey}
                                picture={cand.picture}
                                alt={cand.name}
                              />
                              <span className="ag-agora-member-info">
                                <span className="ag-agora-member-name truncate">{cand.name}</span>
                                <span className="ag-agora-member-sub mono truncate">
                                  {cand.secondary}
                                </span>
                              </span>
                              <span className="ag-agora-member-check" aria-hidden="true">
                                {selected ? <Check size={14} /> : <Plus size={14} />}
                              </span>
                            </button>
                          )
                        })
                      )}
                    </div>
                  </div>

                  <div className="ag-agora-list-editor-foot">
                    <button
                      type="button"
                      className="ag-agora-composer-pill-btn"
                      onClick={cancelListEditor}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="ag-agora-post-btn"
                      disabled={!listTitle.trim() || Boolean(busyKey)}
                    >
                      {busyKey === 'save-list' ? (
                        <Loader2 size={14} className="ag-agora-spin" />
                      ) : null}
                      <span>{editingDTag ? 'Save Changes' : 'Create List'}</span>
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default AgoraCurationModal
