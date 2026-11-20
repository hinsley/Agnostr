import type { PeerInfo, SlashCommandDef, ThemeId, TrustedPeerEntry } from '../types/protocol.ts'
import { decodePubkeyInput } from './identity.ts'

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
    usage: '/j <geohash | city | lat,lon>',
    description: 'Tune to a geohash channel or city (e.g. /j dr5r, /j tokyo)',
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
    description: 'Pin a 24h persistent dead-drop note to this geohash (kind 1 + NIP-40)',
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
    description: 'Trust a peer to unlock their voice memos & media',
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
    usage: '/theme <phosphor | amber | obsidian | daylight>',
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
  const clean = query.trim().replace(/^@/, '')
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
  return (
    peers.find((p) => p.displayHandle.toLowerCase() === `@${lower}`) ??
    peers.find((p) => p.displayHandle.toLowerCase().slice(1) === lower) ??
    peers.find((p) => p.nickname.toLowerCase() === lower) ??
    peers.find((p) => p.pubkey.endsWith(lower) && lower.length >= 4) ??
    peers.find((p) => p.nickname.toLowerCase().startsWith(lower)) ??
    null
  )
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
        ctx.addSystemMessage(`Current handle: ${ctx.nickname}. Usage: /nick <new_handle>`)
        return true
      }
      const next = args.replace(/\s+/g, '_').slice(0, 32)
      ctx.setNickname(next)
      ctx.addSystemMessage(`Handle updated to @${next}`)
      return true
    }

    case 'j':
    case 'join':
    case 'geo': {
      if (!args) {
        ctx.addSystemMessage('Usage: /j <geohash | city | lat,lon> (e.g. /j dr5r, /j tokyo)')
        return true
      }
      const ok = ctx.tuneGeohash(args)
      if (!ok) {
        ctx.addSystemMessage(`Could not resolve "${args}" to a valid geohash or city.`)
      }
      return true
    }

    case 'w':
    case 'who': {
      const online = ctx.peers.filter((p) => p.isOnline && !p.isBlocked)
      if (online.length === 0) {
        ctx.addSystemMessage(`No active peers detected in #${ctx.activeGeohash} yet.`)
      } else {
        const list = online
          .map((p) => `${p.displayHandle}${p.isSelf ? ' (you)' : p.isTeleported ? ' [teleport]' : ''}`)
          .join(', ')
        ctx.addSystemMessage(`Online in #${ctx.activeGeohash} (${online.length}): ${list}`)
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
      const firstSpace = args.indexOf(' ')
      const targetToken = firstSpace === -1 ? args : args.slice(0, firstSpace)
      const body = firstSpace === -1 ? '' : args.slice(firstSpace + 1).trim()
      const peer = resolvePeer(targetToken, ctx.peers)
      if (!peer) {
        ctx.addSystemMessage(`Peer "${targetToken}" not found in #${ctx.activeGeohash} (or pass a full npub/hex).`)
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
      if (!args) {
        ctx.addSystemMessage('Usage: /drop <note> — pins a 24h location note to this geohash.')
        return true
      }
      const ok = await ctx.postLocationNote(args)
      if (ok) {
        ctx.addSystemMessage(`📍 Dead-drop note pinned to #${ctx.activeGeohash} (expires in 24h).`)
      }
      return true
    }

    case 'notes': {
      ctx.refreshLocationNotes()
      ctx.addSystemMessage(`Scanning relays for 24h dead-drop notes in #${ctx.activeGeohash}… Check the Notes tab.`)
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
      const label = peer && peer.nickname !== `anon${directPk.slice(-4)}` ? peer.displayHandle : undefined
      const ok = ctx.trustPubkey(directPk, label)
      if (ok) {
        ctx.addSystemMessage(
          `Trusted ${label ?? `#${directPk.slice(-6)}`} — voice memos & media from this pubkey are now enabled.`
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
          `No Trusted Peers yet (Trusted Peers Only: ${ctx.strictWhitelistMode ? 'ON' : 'OFF'}). Use /trust <@handle|npub> to unlock voice memos & media from a peer.`
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
          ? 'Trusted Peers Only ENABLED — hiding text & media from untrusted peers.'
          : 'Trusted Peers Only DISABLED — public text visible; voice memos & media still require trusting the sender.'
      )
      return true
    }

    case 'clear': {
      ctx.clearCurrentTimeline()
      return true
    }

    case 'theme': {
      const valid: ThemeId[] = ['phosphor', 'amber', 'obsidian', 'daylight']
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
