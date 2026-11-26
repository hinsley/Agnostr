import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptChatEcho, chatRetries, publishChatWire } from '../src/lib/chatDelivery.ts'
import { KeyedFifoQueue, sortChannelMessagesWithPending, swapPendingWithSigned } from '../src/lib/sendQueue.ts'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { createEncryptedDmEvent, decryptGiftWrapEvent } from '../src/lib/dmCrypto.ts'

const fixture = (id, createdAt, deliveryStatus) => ({ id, createdAt, deliveryStatus })
test('pending and failed rows stay out of chronological wire order until confirmed', () => {
  const p = fixture('pending-bitchat-one', 900, 'sending')
  const q = fixture('pending-bitchat-two', 4, 'sending')
  const A = fixture('a', 15)
  const B = fixture('b', 15)
  const C = fixture('c', 16, 'sending')
  const swapped = swapPendingWithSigned([B, A, p, q], p.id, C, 'pending-bitchat-')
  assert.deepEqual(swapped.map(m => m.id), ['a', 'b', 'c', q.id])
  assert.equal(swapped[2].createdAt, 16, 'local optimistic timestamp must never overwrite the wire timestamp')
  const confirmed = acceptChatEcho(swapped, { ...C, deliveryStatus: undefined })
  assert.deepEqual(sortChannelMessagesWithPending(confirmed, 'pending-bitchat-').map(m => m.id), ['a', 'b', 'c', q.id])
  assert.equal(confirmed[2].deliveryStatus, 'sent')
  assert.deepEqual(sortChannelMessagesWithPending([fixture('d', 30, 'failed'), B, A], 'pending-bitchat-').map(m => m.id), ['a', 'b', 'd'])
})

test('retry reuses the original event, ignores double taps, and clears on acceptance', async () => {
  const queue = new KeyedFifoQueue()
  const updates = [], wire = { id: 'signed-original' }, payloads = []
  let success = 0
  const publish = () => {
    payloads.push(wire)
    return Promise.resolve(payloads.length === 1
      ? { acceptedRelays: [], rejectedRelays: [{ reason: 'timeout' }] }
      : { acceptedRelays: [], rejectedRelays: [{ reason: 'duplicate: already have this event' }] })
  }
  assert.equal(await publishChatWire({
    rowId: wire.id, publish, isCurrent: () => true, update: status => updates.push(status),
    queueRetry: retry => queue.enqueue('room', retry), onFailure: () => {}, onSuccess: () => ++success,
  }), false)
  assert.equal(chatRetries.has(wire.id), true)
  const firstTap = chatRetries.retry(wire.id)
  assert.equal(await chatRetries.retry(wire.id), false)
  assert.equal(await firstTap, true)
  assert.deepEqual(payloads, [wire, wire])
  assert.deepEqual(updates, ['sending', 'failed', 'sending', 'sent'])
  assert.equal(chatRetries.has(wire.id), false)
  assert.equal(success, 1)
})

test('a relay echo wins over a missing OK acknowledgment', async () => {
  let resolve
  const updates = []
  const id = 'late-echo'
  const run = publishChatWire({
    rowId: id, publish: () => new Promise(r => { resolve = r }), isCurrent: () => true,
    update: s => updates.push(s), queueRetry: retry => retry(), onFailure: () => assert.fail('false failure'),
  })
  assert.equal(acceptChatEcho([fixture(id, 16, 'sending')], fixture(id, 16))[0].deliveryStatus,'sent')
  resolve({ acceptedRelays: [], rejectedRelays: [{ reason: 'timeout' }] })
  assert.equal(await run, true)
  assert.deepEqual(updates, ['sending', 'sent'])
  assert.equal(chatRetries.has(id), false)
})

test('the first accepting relay confirms without waiting for slow relays', async () => {
  let finish
  const updates = []
  const id = 'first-ack'
  const run = publishChatWire({
    rowId: id, publish: (ack) => { ack(1); return new Promise(r => { finish = r }) },
    isCurrent: () => true, update: (status, count) => updates.push([status,count]),
    queueRetry: attempt => attempt(), onFailure: () => assert.fail('false failure'),
  })
  assert.equal(chatRetries.has(id),false)
  assert.deepEqual(updates,[['sending',0],['sent',1]])
  finish({ acceptedRelays: ['relay-one'], rejectedRelays: [{ reason: 'timeout' }] })
  assert.equal(await run,true)
})

test('DM sender and recipient share the same encrypted timestamp and message ID', async () => {
  const identity = () => {
    const secretKey = generateSecretKey()
    return { secretKey, pubkey: getPublicKey(secretKey), mode: 'local' }
  }
  const sender = identity(), recipient = identity()
  for (const protocol of ['nip17', 'bitchat']) {
    for (const content of ['short message', 'long message '.repeat(30)]) {
      const sent = await createEncryptedDmEvent({ content, recipientPubkey: recipient.pubkey,
        signer: sender, protocol, messageId: '0123456789abcdef' })
      const received = await decryptGiftWrapEvent(sent.event, recipient)
      assert.equal(received.content, content)
      assert.equal(received.timestampMs, sent.orderMs)
      assert.equal(received.id, sent.wireId)
      assert.ok(!sent.event.tags.some(tag => tag[0]==='agnostr-ms'), 'do not expose the private timestamp on the outer wrap')
    }
  }
})
