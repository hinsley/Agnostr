import assert from 'node:assert/strict'
import test from 'node:test'
import { getPeerLastActivity } from '../src/lib/peerActivity.ts'
import { formatCompactLastActive } from '../src/utils/relativeTime.ts'

test('peer activity includes only remote activity and stays independent from notes', () => {
  const pubkey = 'a'.repeat(64)
  const messages = [
    {senderPubkey:pubkey,createdAt:100,isOwn:false},
    {senderPubkey:'b'.repeat(64),createdAt:200,isOwn:true},
    {senderPubkey:'c'.repeat(64),createdAt:300,isOwn:false},
  ]
  assert.equal(getPeerLastActivity(pubkey,{lastSeenAt:50},messages),100)
  assert.equal(getPeerLastActivity(pubkey,{lastSeenAt:150},messages),150)
  assert.equal(getPeerLastActivity(pubkey,null,messages.slice(1)),0)
  assert.equal(formatCompactLastActive(getPeerLastActivity(pubkey,null,messages),1900),'30m')
})
