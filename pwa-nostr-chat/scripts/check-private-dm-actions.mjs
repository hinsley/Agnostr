import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, nip59 } from 'nostr-tools'
import { createEncryptedDmEvent, decryptGiftWrapEvent } from '../src/lib/dmCrypto.ts'
import { addDmReaction, dmReplyReference, dmTargetId } from '../src/lib/dmMessageActions.ts'

const identity = () => {
  const secretKey = generateSecretKey()
  return { mode: 'local', secretKey, pubkey: getPublicKey(secretKey) }
}
const alice = identity(), bob = identity(), other = identity()
const make = (signer, to, protocol, content, extra) =>
  createEncryptedDmEvent({ signer, recipientPubkey: to.pubkey, protocol, content, ...extra })

for (const protocol of ['nip17', 'bitchat']) {
  test(protocol + ': both participants address the same message, even with long content', async () => {
    for (const content of ['hello', 'long message '.repeat(50)]) {
      const parent = await make(alice, bob, protocol, content, { messageId: 'local-parent' })
      const received = await decryptGiftWrapEvent(parent.event, bob)
      assert.equal(received.content, content)
      assert.equal(received.id, parent.wireId)
      assert.equal(dmTargetId({ id: 'local-parent', wireId: parent.wireId, deliveryStatus: 'sent' }), received.id)
      for (const type of ['reply', 'reaction']) {
        const text = type === 'reply' ? 'private reply' : '🔥'
        const { event } = await make(bob, alice, protocol, text, { action: { type, targetId: received.id } })
        assert.equal(event.kind, 1059)
        assert.deepEqual(event.tags, [['p', alice.pubkey]])
        assert.notEqual(event.pubkey, bob.pubkey)
        assert.ok(!event.content.includes(text))
        assert.equal(await decryptGiftWrapEvent(event, other), null)
        const decoded = await decryptGiftWrapEvent(event, alice)
        assert.equal(decoded[type === 'reply' ? 'replyToId' : 'reactionToId'], parent.wireId)
        assert.equal(decoded.senderPubkey, bob.pubkey)
        assert.equal(decoded.content, text)
      }
    }
  })
}
test('NIP-07 sender and recipient with a synthetic extension', async () => {
  const extension = (key) => ({ nip44: {
    encrypt: async (pk, msg) => nip44.v2.encrypt(msg, nip44.v2.utils.getConversationKey(key.secretKey, pk)),
    decrypt: async (pk, msg) => nip44.v2.decrypt(msg, nip44.v2.utils.getConversationKey(key.secretKey, pk)),
  }, signEvent: async (template) => finalizeEvent(template, key.secretKey) })
  globalThis.window = { nostr: extension(alice) }
  try {
    const parent = await make({mode:'extension',pubkey:alice.pubkey}, bob, 'nip17', 'private')
    const remote = await decryptGiftWrapEvent(parent.event,bob)
    assert.equal(parent.wireId,remote.id)
    const rx = await make(bob,alice,'nip17','💜',{action:{type:'reaction',targetId:remote.id}})
    assert.equal((await decryptGiftWrapEvent(rx.event,{mode:'extension',pubkey:alice.pubkey})).reactionToId,parent.wireId)
  } finally { delete globalThis.window }
})
test('group references do not enter a 1:1 thread', async () => {
  const event = nip59.wrapEvent({kind:7, tags:[['p',bob.pubkey],['p',other.pubkey],['e','x']],content:'🙏'},alice.secretKey,bob.pubkey)
  assert.equal(await decryptGiftWrapEvent(event,bob), null)
})
test('repeat reactions do not inflate counts; replies use local scroll IDs and media previews', () => {
  const parent = { id:'local', wireId:'wire', content:'', imageAttachment:{}, isOwn:true, senderPubkey:alice.pubkey }
  const once = addDmReaction(parent, bob.pubkey, '🔥', false)
  assert.equal(addDmReaction(once,bob.pubkey,'🔥',false),once)
  assert.deepEqual(addDmReaction(once,alice.pubkey,'🔥',true).reactions[0], {
    emoji:'🔥',count:2,pubkeys:[bob.pubkey,alice.pubkey],reactedByMe:true })
  assert.deepEqual(dmReplyReference('wire',parent,'Alice','Bob'),{id:'local',pubkey:alice.pubkey,nickname:'Alice',preview:'Image'})
  assert.equal(dmReplyReference('absent',undefined,'Alice','Bob').preview,'Original message unavailable')
})
