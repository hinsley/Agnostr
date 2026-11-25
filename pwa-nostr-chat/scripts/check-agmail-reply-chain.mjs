import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAmailReplyChain } from '../src/lib/amailReplyChain.ts'

const mail = (id, inReplyTo, sentAt = 0, folder = 'inbox', threadId = 'thread') => ({
  id, inReplyTo, sentAt, folder, threadId,
})
const ids = (chain) => chain.messages.map((m) => m.id)

test('follows parents to the selected target, independent of times and folder', () => {
  const messages = [
    mail('later', 'target', 210),
    mail('same-thread-but-no-reply-link'),
    mail('target', 'parent', 10),
    mail('side-branch', 'parent', 5),
    mail('root', undefined, 55, 'archive'),
    mail('parent', 'root', 40, 'folder:research', 'older-client-thread-id'),
  ]
  const chain = buildAmailReplyChain(messages, 'target')
  assert.deepEqual(ids(chain), ['root', 'parent', 'target'])
  assert.equal(chain.incomplete, false)
})

test('picks the exact self-mail copy first, and resolves a missing copy either way', () => {
  const root = mail('root')
  const copy = mail('root:self')
  const target = mail('target', 'root:self')
  assert.deepEqual(ids(buildAmailReplyChain([root, copy, target], 'target')), ['root:self', 'target'])
  assert.deepEqual(ids(buildAmailReplyChain([root, target], 'target')), ['root', 'target'])
  assert.deepEqual(ids(buildAmailReplyChain([copy], 'root')), ['root:self'])
})

test('does not substitute drafts or unrelated messages for missing ancestors or targets', () => {
  const target = mail('target', 'missing')
  const messages = [target, mail('missing', undefined, 0, 'drafts'), mail('unrelated')]
  const chain = buildAmailReplyChain(messages, 'target')
  assert.deepEqual(ids(chain), ['target'])
  assert.equal(chain.incomplete, true)
  assert.deepEqual(buildAmailReplyChain(messages, 'missing'), { messages: [], incomplete: true })
})

test('reports cyclic ancestry without repeating a message or its self copy', () => {
  const chain = buildAmailReplyChain([mail('target', 'root'), mail('root', 'target:self')], 'target')
  assert.deepEqual(ids(chain), ['root', 'target'])
  assert.equal(chain.incomplete, true)
})
