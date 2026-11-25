// Local-only signed messages for the Bitchat pulse smoke test.
import { finalizeEvent } from 'nostr-tools'
import { buildNamedBitchatChatTemplate } from '../../src/lib/bitchatProtocol'

export function fixtureDrawerEvents() {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? 12 : 0)
  return ['pinned-active', 'live-room'].map((topic) => finalizeEvent(buildNamedBitchatChatTemplate({
    content: 'Synthetic discovery event', topic, nickname: 'Fixture',
  }), secret))
}
