import type { PeerInfo, SlashCommandDef, ThemeId, TrustedPeerEntry } from '../types/protocol.ts'
import { decodePubkeyInput } from './identity.ts'
import { formatBitchatChannelLabel, isTopicChannel } from './bitchatChannel.ts'

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'nick',
    aliases: ['name'],
    usage: '/nick <handle>',
    description: 'Change your display nickname',
    category: 'system',
  },
  {
    name: 'j',
    aliases: ['join', 'geo'],
    usage: '/j <geohash | city | topic:name>',
    description: 'Tune to a geohash, city, or topic channel (e.g. /j dr5r, /j tokyo, /j bitcoin)',
    category: 'nav',
  },
  {
    name: 'topic',
    aliases: ['t', 'chan'],
    usage: '/topic <name>',
    description: 'Join a global topic Bitchat channel (e.g. /topic bitcoin, /topic nostr)',
    category: 'nav',
  },
  {
    name: 'w',
    aliases: ['who'],
    usage: '/w',
    description: 'List active peers online in this channel',
    category: 'peer',
  },
  {
    name: 'm',
    aliases: ['msg', 'dm'],
    usage: '/m @handle [message]',
    description: 'Open or send an encrypted private DM',
    category: 'peer',
  },
  {
    name: 'me',
    aliases: [],
    usage: '/me <action>',
    description: 'Send a third-person action emote',
    category: 'chat',
  },
  {
    name: 'slap',
    aliases: [],
    usage: '/slap @handle',
    description: 'Slap a peer with a large trout (classic Bitchat/IRC)',
    category: 'chat',
  },
  {
    name: 'hug',
    aliases: [],
    usage: '/hug @handle',
    description: 'Send a warm hug emote to a peer',
    category: 'chat',
  },
  {
    name: 'drop',
    aliases: [],
    usage: '/drop <note>',
    description: 'Pin a 24h persistent dead-drop note to this geohash',
    category: 'chat',
  },
  {
    name: 'notes',
    aliases: [],
    usage: '/notes',
    description: 'Fetch 24h dead-drop notes pinned in this geohash',
    category: 'nav',
  },
  {
    name: 'block',
    aliases: ['mute'],
    usage: '/block [@handle]',
    description: 'Block a peer pubkey (or list blocked peers)',
    category: 'peer',
  },
  {
    name: 'unblock',
    aliases: ['unmute'],
    usage: '/unblock <@handle | pubkey>',
    description: 'Unblock a previously blocked peer',
    category: 'peer',
  },
  {
    name: 'trust',
    aliases: ['allow'],
    usage: '/trust <@handle | npub | hex>',
    description: 'Trust a peer to unlock their images & calls (and voice memos if restricted)',
    category: 'peer',
  },
  {
    name: 'untrust',
    aliases: ['revoke'],
    usage: '/untrust <@handle | npub | hex>',
    description: 'Remove a peer from your Trusted Peers',
    category: 'peer',
  },
  {
    name: 'trusted',
    aliases: ['whitelist'],
    usage: '/trusted',
    description: 'List all Trusted Peers',
    category: 'peer',
  },
  {
    name: 'strict',
    aliases: [],
    usage: '/strict [on | off]',
    description: 'Toggle Trusted Peers Only mode (hides untrusted text too)',
    category: 'system',
  },
  {
    name: 'clear',
    aliases: [],
    usage: '/clear',
    description: 'Clear messages in the current channel view',
    category: 'system',
  },
  {
    name: 'theme',
    aliases: [],
    usage: '/theme <phosphor | amber | indigo | daylight>',
    description: 'Switch visual theme immediately',
    category: 'system',
  },
  {
    name: 'burn',
    aliases: ['rotate'],
    usage: '/burn',
    description: 'Rotate your ephemeral Nostr identity keypair',
    category: 'system',
  },
  {
    name: 'help',
    aliases: ['?'],
    usage: '/help',
    description: 'Show all available slash commands',
    category: 'system',
  },
]

export interface CommandExecutionContext {
  nickname: string
  activeGeohash: string
  peers: PeerInfo[]
  blockedPubkeys: string[]
  trustedPubkeys: TrustedPeerEntry[]
  strictWhitelistMode: boolean
  setNickname: (nick: string) => void
  tuneGeohash: (target: string) => boolean
  tuneTopicChannel: (slug: string) => boolean
  openDmThread: (pubkey: string, nicknameHint?: string) => void
  sendDirectMessage: (pubkey: string, content: string) => Promise<boolean>
  sendPublicContent: (content: string) => Promise<boolean>
  postLocationNote: (content: string) => Promise<boolean>
  refreshLocationNotes: () => void
  toggleBlockPeer: (pubkey: string, label?: string) => void
  trustPubkey: (pubkeyOrNpub: string, label?: string) => boolean
  untrustPubkey: (pubkey: string) => void
  setStrictWhitelistMode: (enabled: boolean) => void
  clearCurrentTimeline: () => void
  setTheme: (theme: ThemeId) => void
  rotateIdentity: () => void
  addSystemMessage: (text: string) => void
}

function resolvePeer(query: string, peers: PeerInfo[]): PeerInfo | null {
  const clean = query.trim().replace(/^@/, '').replace(/\s+/g, ' ')
  if (!clean) return null

  const directPk = decodePubkeyInput(clean)
  if (directPk) {
    const existing = peers.find((p) => p.pubkey === directPk)
    if (existing) return existing
    return {
      pubkey: directPk,
      npub: clean.startsWith('npub1') ? clean : directPk,
      nickname: `anon${directPk.slice(-4)}`,
      displayHandle: `@anon${directPk.slice(-4)}#${directPk.slice(-4)}`,
      lastSeenAt: 0,
      isOnline: false,
      isSelf: false,
      isTeleported: false,
      isMeshBridge: false,
      isBlocked: false,
      messageCount: 0,
      channels: [],
    }
  }

  const lower = clean.toLowerCase()
  const tagged = /^(.+)#([0-9a-f]{4})$/.exec(lower)
  const taggedName = tagged?.[1]?.trim()
  const taggedSuffix = tagged?.[2]

  return (
    peers.find((p) => p.displayHandle.toLowerCase() === `@${lower}`) ??
    peers.find((p) => p.displayHandle.replace(/^@/, '').toLowerCase() === lower) ??
    peers.find((p) => p.nickname.trim().replace(/\s+/g, ' ').toLowerCase() === lower) ??
    (taggedName && taggedSuffix
      ? peers.find(
          (p) =>
            p.pubkey.toLowerCase().endsWith(taggedSuffix) &&
            p.nickname.trim().replace(/\s+/g, ' ').toLowerCase() === taggedName
        ) ?? peers.find((p) => p.pubkey.toLowerCase().endsWith(taggedSuffix))
      : undefined) ??
    peers.find((p) => p.pubkey.endsWith(lower) && lower.length >= 4) ??
    peers.find((p) => p.nickname.trim().replace(/\s+/g, ' ').toLowerCase().startsWith(lower)) ??
    null
  )
}

function splitDmTargetAndBody(args: string, peers: PeerInfo[]): { targetToken: string; body: string } {
  // 1. Match explicit Bitchat #xxxx-suffixed handle (with optional leading @ and spaces)
  const taggedMatch = /^(@?[^\s@#\n](?:[^@#\n]{0,30}[^\s@#\n])?#[0-9a-fA-F]{4})(?:\s+([\s\S]*))?$/.exec(args)
  if (taggedMatch) {
    return {
      targetToken: taggedMatch[1],
      body: (taggedMatch[2] ?? '').trim(),
    }
  }

  // 2. Match longest known peer displayHandle or multi-word nickname prefix
  const hasAt = args.startsWith('@')
  const rest = hasAt ? args.slice(1) : args
  const restLower = rest.toLowerCase()
  const candidates = new Set<string>()
  for (const p of peers) {
    const bareHandle = p.displayHandle.replace(/^@/, '').trim()
    if (bareHandle) candidates.add(bareHandle)
    const nick = p.nickname.trim()
    if (nick) candidates.add(nick)
  }
  const sorted = Array.from(candidates).sort((a, b) => b.length - a.length)
  for (const cand of sorted) {
    const candLower = cand.toLowerCase()
    if (restLower === candLower) {
      return { targetToken: hasAt ? `@${cand}` : cand, body: '' }
    }
    if (restLower.startsWith(candLower) && /\s/.test(rest[cand.length] ?? '')) {
      return {
        targetToken: hasAt ? `@${cand}` : cand,
        body: rest.slice(cand.length).trim(),
      }
    }
  }

  // 3. Fallback: first-space split (npub, hex pubkey, or single-word handle)
  const firstSpace = args.indexOf(' ')
  return {
    targetToken: firstSpace === -1 ? args : args.slice(0, firstSpace),
    body: firstSpace === -1 ? '' : args.slice(firstSpace + 1).trim(),
  }
}

export async function executeSlashCommand(
  rawInput: string,
  ctx: CommandExecutionContext
): Promise<boolean> {
  const trimmed = rawInput.trim()
  if (!trimmed.startsWith('/')) return false

  const spaceIdx = trimmed.indexOf(' ')
  const cmdName = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

  switch (cmdName) {
    case 'nick':
    case 'name': {
      if (!args) {
        ctx.addSystemMessage(`Current handle: ${ctx.nickname}. Usage: /nick <new handle>`)
        return true
      }
      const next = args.trim().replace(/\s+/g, ' ').slice(0, 32)
      ctx.setNickname(next)
      ctx.addSystemMessage(`Handle updated to @${next}`)
      return true
    }

    case 'j':
    case 'join':
    case 'geo': {
      if (!args) {
        ctx.addSystemMessage('Usage: /j <geohash | city | topic:name> (e.g. /j dr5r, /j tokyo, /j bitcoin)')
        return true
      }
      const ok = ctx.tuneGeohash(args)
      if (!ok) {
        ctx.addSystemMessage(`Could not resolve "${args}" to a valid geohash, city, or topic name.`)
      }
      return true
    }

    case 'topic':
    case 't':
    case 'chan': {
      if (!args) {
        ctx.addSystemMessage('Usage: /topic <name> — join a global topic Bitchat channel (e.g. /topic bitcoin)')
        return true
      }
      const ok = ctx.tuneTopicChannel(args)
      if (!ok) {
        ctx.addSystemMessage(
          `Invalid topic name "${args}". Use 1–48 letters, numbers, hyphens, or underscores (e.g. /topic bitcoin).`
        )
      }
      return true
    }

    case 'w':
    case 'who': {
      const channelLabel = formatBitchatChannelLabel(ctx.activeGeohash)
      const online = ctx.peers.filter((p) => p.isOnline && !p.isBlocked)
      if (online.length === 0) {
        ctx.addSystemMessage(`No active peers detected in ${channelLabel} yet.`)
      } else {
        const list = online
          .map((p) => `${p.displayHandle}${p.isSelf ? ' (you)' : p.isTeleported ? ' [teleport]' : ''}`)
          .join(', ')
        ctx.addSystemMessage(`Online in ${channelLabel} (${online.length}): ${list}`)
      }
      return true
    }

    case 'm':
    case 'msg':
    case 'dm': {
      if (!args) {
        ctx.addSystemMessage('Usage: /m @handle [message]')
        return true
      }
      const { targetToken, body } = splitDmTargetAndBody(args, ctx.peers)
      const peer = resolvePeer(targetToken, ctx.peers)
      if (!peer) {
        ctx.addSystemMessage(
          `Peer "${targetToken}" not found in ${formatBitchatChannelLabel(ctx.activeGeohash)} (or pass a full npub/hex).`
        )
        return true
      }
      ctx.openDmThread(peer.pubkey, peer.nickname)
      if (body) {
        await ctx.sendDirectMessage(peer.pubkey, body)
      }
      return true
    }

    case 'me': {
      if (!args) {
        ctx.addSystemMessage('Usage: /me <action>')
        return true
      }
      await ctx.sendPublicContent(`* ${ctx.nickname} ${args} *`)
      return true
    }

    case 'slap': {
      if (!args) {
        ctx.addSystemMessage('Usage: /slap @handle')
        return true
      }
      const target = args.replace(/^@/, '')
      await ctx.sendPublicContent(`* 🐟 ${ctx.nickname} slaps ${target} around a bit with a large trout *`)
      return true
    }

    case 'hug': {
      if (!args) {
        ctx.addSystemMessage('Usage: /hug @handle')
        return true
      }
      const target = args.replace(/^@/, '')
      await ctx.sendPublicContent(`* 🫂 ${ctx.nickname} hugs ${target} *`)
      return true
    }

    case 'drop': {
      if (isTopicChannel(ctx.activeGeohash)) {
        ctx.addSystemMessage(
          '24h dead-drop notes (/drop) are only available in geohash channels. Switch to a geohash channel first.'
        )
        return true
      }
      if (!args) {
        ctx.addSystemMessage('Usage: /drop <note> — pins a 24h location note to this geohash.')
        return true
      }
      const ok = await ctx.postLocationNote(args)
      if (ok) {
        ctx.addSystemMessage(`📍 Dead-drop note pinned to ${formatBitchatChannelLabel(ctx.activeGeohash)} (expires in 24h).`)
      }
      return true
    }

    case 'notes': {
      if (isTopicChannel(ctx.activeGeohash)) {
        ctx.addSystemMessage(
          '24h dead-drop notes (/notes) are only available in geohash channels. Switch to a geohash channel first.'
        )
        return true
      }
      ctx.refreshLocationNotes()
      ctx.addSystemMessage(
        `Scanning relays for 24h dead-drop notes in ${formatBitchatChannelLabel(ctx.activeGeohash)}… Check the Notes tab.`
      )
      return true
    }

    case 'block':
    case 'mute': {
      if (!args) {
        if (ctx.blockedPubkeys.length === 0) {
          ctx.addSystemMessage('Blocked peers: none')
        } else {
          ctx.addSystemMessage(
            `Blocked pubkeys (${ctx.blockedPubkeys.length}): ${ctx.blockedPubkeys.map((p) => `#${p.slice(-6)}`).join(', ')}`
          )
        }
        return true
      }
      const peer = resolvePeer(args, ctx.peers)
      if (!peer) {
        ctx.addSystemMessage(`Peer "${args}" not found.`)
        return true
      }
      if (peer.isBlocked) {
        ctx.addSystemMessage(`${peer.displayHandle} is already blocked.`)
      } else {
        ctx.toggleBlockPeer(peer.pubkey, peer.displayHandle)
        ctx.addSystemMessage(`Blocked ${peer.displayHandle}.`)
      }
      return true
    }

    case 'unblock':
    case 'unmute': {
      if (!args) {
        ctx.addSystemMessage('Usage: /unblock <@handle | pubkey>')
        return true
      }
      const peer = resolvePeer(args, ctx.peers)
      const directPk = peer?.pubkey ?? decodePubkeyInput(args)
      if (!directPk || !ctx.blockedPubkeys.includes(directPk)) {
        ctx.addSystemMessage(`"${args}" is not in your block list.`)
        return true
      }
      ctx.toggleBlockPeer(directPk, peer?.displayHandle)
      ctx.addSystemMessage(`Unblocked ${peer?.displayHandle ?? directPk.slice(0, 8)}.`)
      return true
    }

    case 'trust':
    case 'allow': {
      if (!args) {
        ctx.addSystemMessage('Usage: /trust <@handle | npub | hex>')
        return true
      }
      const peer = resolvePeer(args, ctx.peers)
      const directPk = peer?.pubkey ?? decodePubkeyInput(args)
      if (!directPk) {
        ctx.addSystemMessage(`Could not resolve "${args}" to a peer handle, npub, or 64-char hex pubkey.`)
        return true
      }
      const label =
        peer && !/^a(?:gn|n)on(?:[0-9a-f]{4})?$/i.test(peer.nickname.trim())
          ? peer.displayHandle
          : undefined
      const ok = ctx.trustPubkey(directPk, label)
      if (ok) {
        ctx.addSystemMessage(
          `Trusted ${label ?? `#${directPk.slice(-6)}`} — images, calls, and restricted voice memos from this pubkey are now enabled.`
        )
      }
      return true
    }

    case 'untrust':
    case 'revoke': {
      if (!args) {
        ctx.addSystemMessage('Usage: /untrust <@handle | npub | hex>')
        return true
      }
      const clean = args.trim().replace(/^@/, '').toLowerCase()
      const peer = resolvePeer(args, ctx.peers)
      const directPk =
        peer?.pubkey ??
        decodePubkeyInput(args) ??
        ctx.trustedPubkeys.find(
          (t) =>
            t.pubkey.endsWith(clean) ||
            t.npub.toLowerCase() === clean ||
            (t.label && t.label.toLowerCase().replace(/^@/, '').includes(clean))
        )?.pubkey
      if (!directPk || !ctx.trustedPubkeys.some((t) => t.pubkey === directPk)) {
        ctx.addSystemMessage(`"${args}" is not in your Trusted Peers.`)
        return true
      }
      ctx.untrustPubkey(directPk)
      ctx.addSystemMessage(`Removed ${peer?.displayHandle ?? `#${directPk.slice(-6)}`} from Trusted Peers.`)
      return true
    }

    case 'trusted':
    case 'whitelist': {
      if (ctx.trustedPubkeys.length === 0) {
        ctx.addSystemMessage(
          `No Trusted Peers yet (Trusted Peers Only: ${ctx.strictWhitelistMode ? 'ON' : 'OFF'}). Use /trust <@handle|npub> to unlock images & calls from a peer (voice memos work for non-blocked peers by default unless restricted in Privacy settings).`
        )
      } else {
        const list = ctx.trustedPubkeys
          .map((t) => `${t.label ? `${t.label} ` : ''}(${t.npub.slice(0, 12)}…${t.npub.slice(-4)})`)
          .join(', ')
        ctx.addSystemMessage(
          `Trusted Peers (${ctx.trustedPubkeys.length}, Trusted Peers Only: ${ctx.strictWhitelistMode ? 'ON' : 'OFF'}): ${list}`
        )
      }
      return true
    }

    case 'strict': {
      const arg = args.toLowerCase()
      let next: boolean
      if (!arg) {
        next = !ctx.strictWhitelistMode
      } else if (arg === 'on' || arg === 'true' || arg === '1') {
        next = true
      } else if (arg === 'off' || arg === 'false' || arg === '0') {
        next = false
      } else {
        ctx.addSystemMessage('Usage: /strict [on | off]')
        return true
      }
      ctx.setStrictWhitelistMode(next)
      ctx.addSystemMessage(
        next
          ? 'Trusted Peers Only ENABLED — hiding text, voice memos & media from untrusted peers.'
          : 'Trusted Peers Only DISABLED — public text & voice memos visible for non-blocked peers (unless restricted in Privacy settings); images & calls still require trusting the sender.'
      )
      return true
    }

    case 'clear': {
      ctx.clearCurrentTimeline()
      return true
    }

    case 'theme': {
      const valid: ThemeId[] = ['phosphor', 'amber', 'indigo', 'daylight']
      const next = args.toLowerCase() as ThemeId
      if (!valid.includes(next)) {
        ctx.addSystemMessage(`Available themes: ${valid.join(', ')}`)
        return true
      }
      ctx.setTheme(next)
      ctx.addSystemMessage(`Theme switched to ${next}.`)
      return true
    }

    case 'burn':
    case 'rotate': {
      ctx.rotateIdentity()
      ctx.addSystemMessage('Ephemeral Nostr keypair rotated. Fresh identity active.')
      return true
    }

    case 'help':
    case '?': {
      const lines = SLASH_COMMANDS.map((c) => `${c.usage} — ${c.description}`)
      ctx.addSystemMessage(`Commands:\n${lines.join('\n')}`)
      return true
    }

    default: {
      ctx.addSystemMessage(`Unknown command "/${cmdName}". Type /help to see all commands.`)
      return true
    }
  }
}
