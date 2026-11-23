import type { EventTemplate } from 'nostr-tools'
import type { VoiceMemoEncryption } from '../types/protocol.ts'
import type {
  MediaCryptoWorkerRequest,
  MediaCryptoWorkerResponse,
  MediaCryptoWorkerSuccess,
} from './mediaCrypto.worker.ts'

export class OffMainThreadUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OffMainThreadUnavailableError'
  }
}

export interface OffMainThreadImageResult {
  buffer: ArrayBuffer
  mime: 'image/webp' | 'image/jpeg'
  width: number
  height: number
  size: number
  fileName: string
}

interface PendingRpc {
  resolve: (value: MediaCryptoWorkerSuccess) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000
const MAX_CONSECUTIVE_WORKER_CRASHES = 3

let sharedWorker: Worker | null = null
let workerPermanentlyDisabled = false
let consecutiveWorkerCrashes = 0
let nextRequestId = 1
const pendingRequests = new Map<number, PendingRpc>()

function copyToTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function failAndResetWorker(reason: string, countAsCrash = true): void {
  const crashed = sharedWorker
  sharedWorker = null
  if (countAsCrash) {
    consecutiveWorkerCrashes += 1
    if (consecutiveWorkerCrashes >= MAX_CONSECUTIVE_WORKER_CRASHES) {
      workerPermanentlyDisabled = true
    }
  }
  if (crashed) {
    try {
      crashed.terminate()
    } catch {
      // Ignore terminate errors
    }
  }
  const entries = Array.from(pendingRequests.values())
  pendingRequests.clear()
  for (const entry of entries) {
    clearTimeout(entry.timer)
    entry.reject(new OffMainThreadUnavailableError(reason))
  }
}

function getOrSpawnWorker(): Worker {
  if (workerPermanentlyDisabled || typeof Worker === 'undefined') {
    throw new OffMainThreadUnavailableError('Web Workers are unavailable in this environment.')
  }
  if (sharedWorker) return sharedWorker

  try {
    const worker = new Worker(new URL('./mediaCrypto.worker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = (event: MessageEvent<MediaCryptoWorkerResponse>) => {
      const msg = event.data
      if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return
      const pending = pendingRequests.get(msg.id)
      if (!pending) return
      pendingRequests.delete(msg.id)
      clearTimeout(pending.timer)

      if (msg.ok) {
        consecutiveWorkerCrashes = 0
        pending.resolve(msg)
      } else if (msg.recoverable) {
        pending.reject(new OffMainThreadUnavailableError(msg.error))
      } else {
        consecutiveWorkerCrashes = 0
        pending.reject(new Error(msg.error))
      }
    }

    worker.onerror = (ev) => {
      const detail = ev.message || 'Media/crypto worker crashed.'
      failAndResetWorker(detail)
    }

    worker.onmessageerror = () => {
      failAndResetWorker('Media/crypto worker message deserialization error.')
    }

    sharedWorker = worker
    return worker
  } catch (err) {
    workerPermanentlyDisabled = true
    throw new OffMainThreadUnavailableError(
      err instanceof Error ? err.message : 'Unable to spawn media/crypto worker.'
    )
  }
}

function callWorker(
  request: MediaCryptoWorkerRequest,
  transfer: Transferable[] = [],
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS
): Promise<MediaCryptoWorkerSuccess> {
  const worker = getOrSpawnWorker()

  return new Promise<MediaCryptoWorkerSuccess>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingRequests.has(request.id)) return
      pendingRequests.delete(request.id)
      failAndResetWorker(`Media/crypto worker timed out on "${request.op}".`)
    }, timeoutMs)

    pendingRequests.set(request.id, { resolve, reject, timer })

    try {
      worker.postMessage(request, transfer)
    } catch (err) {
      pendingRequests.delete(request.id)
      clearTimeout(timer)
      const message = err instanceof Error ? err.message : 'Failed to post message to worker.'
      failAndResetWorker(message)
      reject(new OffMainThreadUnavailableError(message))
    }
  })
}

export function isOffMainThreadWorkerSupported(): boolean {
  return !workerPermanentlyDisabled && typeof Worker !== 'undefined'
}

export function resetOffMainThreadWorker(): void {
  consecutiveWorkerCrashes = 0
  failAndResetWorker('Media/crypto worker reset.', false)
}

export async function processImageOffMainThread(
  file: File,
  maxDimension: number
): Promise<OffMainThreadImageResult> {
  if (!isOffMainThreadWorkerSupported()) {
    throw new OffMainThreadUnavailableError('Web Workers are unavailable.')
  }
  const buffer = await file.arrayBuffer()
  const id = nextRequestId++
  const res = await callWorker(
    {
      id,
      op: 'processImage',
      buffer,
      mime: file.type || 'application/octet-stream',
      fileName: file.name || 'image',
      maxDimension,
    },
    [buffer],
    30_000
  )
  if (res.op !== 'processImage') {
    throw new OffMainThreadUnavailableError('Unexpected worker response for processImage.')
  }
  return {
    buffer: res.buffer,
    mime: res.mime,
    width: res.width,
    height: res.height,
    size: res.size,
    fileName: res.fileName,
  }
}

export async function sha256HexOffMainThread(bytes: Uint8Array): Promise<string> {
  if (!isOffMainThreadWorkerSupported()) {
    throw new OffMainThreadUnavailableError('Web Workers are unavailable.')
  }
  const buffer = copyToTransferableBuffer(bytes)
  const id = nextRequestId++
  const res = await callWorker(
    {
      id,
      op: 'sha256Hex',
      buffer,
    },
    [buffer],
    15_000
  )
  if (res.op !== 'sha256Hex') {
    throw new OffMainThreadUnavailableError('Unexpected worker response for sha256Hex.')
  }
  return res.hex
}

export async function encryptAesGcmOffMainThread(plaintext: Uint8Array): Promise<{
  ciphertext: Uint8Array
  ciphertextSha256: string
  encryption: VoiceMemoEncryption
}> {
  if (!isOffMainThreadWorkerSupported()) {
    throw new OffMainThreadUnavailableError('Web Workers are unavailable.')
  }
  const buffer = copyToTransferableBuffer(plaintext)
  const id = nextRequestId++
  const res = await callWorker(
    {
      id,
      op: 'encryptAesGcm',
      buffer,
    },
    [buffer],
    30_000
  )
  if (res.op !== 'encryptAesGcm') {
    throw new OffMainThreadUnavailableError('Unexpected worker response for encryptAesGcm.')
  }
  return {
    ciphertext: new Uint8Array(res.ciphertext),
    ciphertextSha256: res.ciphertextSha256,
    encryption: res.encryption,
  }
}

export async function decryptAesGcmOffMainThread(
  ciphertext: Uint8Array,
  encryption: VoiceMemoEncryption
): Promise<Uint8Array> {
  if (!isOffMainThreadWorkerSupported()) {
    throw new OffMainThreadUnavailableError('Web Workers are unavailable.')
  }
  const buffer = copyToTransferableBuffer(ciphertext)
  const id = nextRequestId++
  const res = await callWorker(
    {
      id,
      op: 'decryptAesGcm',
      buffer,
      encryption,
    },
    [buffer],
    30_000
  )
  if (res.op !== 'decryptAesGcm') {
    throw new OffMainThreadUnavailableError('Unexpected worker response for decryptAesGcm.')
  }
  return new Uint8Array(res.plaintext)
}

export async function mineNip13OffMainThread(
  template: EventTemplate,
  pubkeyHex: string,
  targetBits: number,
  timeCapMs: number
): Promise<string[] | null> {
  if (!isOffMainThreadWorkerSupported()) {
    throw new OffMainThreadUnavailableError('Web Workers are unavailable.')
  }
  const id = nextRequestId++
  const timeoutMs = Math.max(5_000, Math.ceil(timeCapMs) + 3_000)
  const res = await callWorker(
    {
      id,
      op: 'mineNip13',
      pubkeyHex,
      createdAt: template.created_at,
      kind: template.kind,
      tags: template.tags,
      content: template.content,
      targetBits,
      timeCapMs,
    },
    [],
    timeoutMs
  )
  if (res.op !== 'mineNip13') {
    throw new OffMainThreadUnavailableError('Unexpected worker response for mineNip13.')
  }
  return res.nonceTag
}
