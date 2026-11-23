/// <reference lib="webworker" />

import { sha256 } from '@noble/hashes/sha256'
import type { VoiceMemoEncryption } from '../types/protocol.ts'

export type MediaCryptoWorkerRequest =
  | {
      id: number
      op: 'processImage'
      buffer: ArrayBuffer
      mime: string
      fileName: string
      maxDimension: number
    }
  | {
      id: number
      op: 'sha256Hex'
      buffer: ArrayBuffer
    }
  | {
      id: number
      op: 'encryptAesGcm'
      buffer: ArrayBuffer
    }
  | {
      id: number
      op: 'decryptAesGcm'
      buffer: ArrayBuffer
      encryption: VoiceMemoEncryption
    }
  | {
      id: number
      op: 'mineNip13'
      pubkeyHex: string
      createdAt: number
      kind: number
      tags: string[][]
      content: string
      targetBits: number
      timeCapMs: number
    }

export type MediaCryptoWorkerSuccess =
  | {
      id: number
      ok: true
      op: 'processImage'
      buffer: ArrayBuffer
      mime: 'image/webp' | 'image/jpeg'
      width: number
      height: number
      size: number
      fileName: string
    }
  | {
      id: number
      ok: true
      op: 'sha256Hex'
      hex: string
    }
  | {
      id: number
      ok: true
      op: 'encryptAesGcm'
      ciphertext: ArrayBuffer
      ciphertextSha256: string
      encryption: VoiceMemoEncryption
    }
  | {
      id: number
      ok: true
      op: 'decryptAesGcm'
      plaintext: ArrayBuffer
    }
  | {
      id: number
      ok: true
      op: 'mineNip13'
      nonceTag: string[] | null
    }

export interface MediaCryptoWorkerFailure {
  id: number
  ok: false
  error: string
  recoverable?: boolean
}

export type MediaCryptoWorkerResponse = MediaCryptoWorkerSuccess | MediaCryptoWorkerFailure

const workerScope = self as unknown as DedicatedWorkerGlobalScope
const utf8Encoder = new TextEncoder()

const HEX_TABLE: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0')
)

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_TABLE[bytes[i]]
  }
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    for (let j = 0; j < sub.length; j++) {
      binary += String.fromCharCode(sub[j])
    }
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.trim())
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

async function sha256HexFromBuffer(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', buffer)
      return bytesToHex(new Uint8Array(digest))
    } catch {
      // Fall back to pure-JS @noble/hashes inside the worker
    }
  }
  return bytesToHex(sha256(new Uint8Array(buffer)))
}

function leadingZeroBitsBytes(bytes: Uint8Array): number {
  let total = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0) {
      total += 8
    } else {
      let mask = 0x80
      while ((b & mask) === 0 && mask > 0) {
        total += 1
        mask >>= 1
      }
      break
    }
  }
  return total
}

async function encodeOffscreenBlob(
  canvas: OffscreenCanvas,
  type: string,
  quality: number
): Promise<Blob | null> {
  try {
    return await canvas.convertToBlob({ type, quality })
  } catch {
    return null
  }
}

async function handleProcessImage(
  req: Extract<MediaCryptoWorkerRequest, { op: 'processImage' }>
): Promise<{ message: MediaCryptoWorkerSuccess; transfer: Transferable[] }> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
    const err = new Error('OffscreenCanvas or createImageBitmap unavailable in worker.')
    ;(err as Error & { recoverable?: boolean }).recoverable = true
    throw err
  }

  const sourceBlob = new Blob([req.buffer], { type: req.mime || 'application/octet-stream' })
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(sourceBlob, { imageOrientation: 'from-image' })
  } catch {
    bitmap = await createImageBitmap(sourceBlob)
  }

  try {
    const origW = bitmap.width
    const origH = bitmap.height
    if (origW <= 0 || origH <= 0) {
      throw new Error('Image dimensions could not be read.')
    }

    const maxDim = Math.max(1, Math.floor(req.maxDimension || 1920))
    const longest = Math.max(origW, origH)
    const scale = longest > maxDim ? maxDim / longest : 1
    const width = Math.max(1, Math.round(origW * scale))
    const height = Math.max(1, Math.round(origH * scale))

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      const err = new Error('Unable to initialize OffscreenCanvas 2D context.')
      ;(err as Error & { recoverable?: boolean }).recoverable = true
      throw err
    }

    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)

    // Prefer WebP (0.85); if unsupported or engine silently fell back to PNG, use dark-backed JPEG (0.86)
    let outBlob = await encodeOffscreenBlob(canvas, 'image/webp', 0.85)
    let outMime = outBlob?.type?.toLowerCase() || ''

    if (!outBlob || outMime !== 'image/webp' || outBlob.size === 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#090C0A'
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
      const jpegBlob = await encodeOffscreenBlob(canvas, 'image/jpeg', 0.86)
      if (jpegBlob && jpegBlob.size > 0) {
        outBlob = jpegBlob
        outMime = 'image/jpeg'
      }
    }

    if (!outBlob || outBlob.size === 0) {
      throw new Error('Failed to encode compressed image.')
    }

    const cleanMime: 'image/webp' | 'image/jpeg' =
      outMime === 'image/webp' ? 'image/webp' : 'image/jpeg'
    const baseName = (req.fileName || 'image').replace(/\.[^.]+$/, '').slice(0, 48) || 'image'
    const ext = cleanMime === 'image/webp' ? 'webp' : 'jpg'
    const outBuffer = await outBlob.arrayBuffer()

    return {
      message: {
        id: req.id,
        ok: true,
        op: 'processImage',
        buffer: outBuffer,
        mime: cleanMime,
        width,
        height,
        size: outBuffer.byteLength,
        fileName: `${baseName}.${ext}`,
      },
      transfer: [outBuffer],
    }
  } finally {
    try {
      bitmap.close()
    } catch {
      // Ignore bitmap close errors
    }
  }
}

async function handleEncryptAesGcm(
  req: Extract<MediaCryptoWorkerRequest, { op: 'encryptAesGcm' }>
): Promise<{ message: MediaCryptoWorkerSuccess; transfer: Transferable[] }> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    const err = new Error('Web Crypto API (SubtleCrypto) is unavailable in worker.')
    ;(err as Error & { recoverable?: boolean }).recoverable = true
    throw err
  }

  const keyBytes = new Uint8Array(32)
  const ivBytes = new Uint8Array(12)
  crypto.getRandomValues(keyBytes)
  crypto.getRandomValues(ivBytes)

  const plaintextSha256 = await sha256HexFromBuffer(req.buffer)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  )
  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    cryptoKey,
    req.buffer
  )
  const ciphertextSha256 = await sha256HexFromBuffer(encryptedBuf)

  return {
    message: {
      id: req.id,
      ok: true,
      op: 'encryptAesGcm',
      ciphertext: encryptedBuf,
      ciphertextSha256,
      encryption: {
        alg: 'aes-gcm-256',
        keyB64: bytesToBase64(keyBytes),
        ivB64: bytesToBase64(ivBytes),
        plaintextSha256,
      },
    },
    transfer: [encryptedBuf],
  }
}

async function handleDecryptAesGcm(
  req: Extract<MediaCryptoWorkerRequest, { op: 'decryptAesGcm' }>
): Promise<{ message: MediaCryptoWorkerSuccess; transfer: Transferable[] }> {
  const { encryption } = req
  if (encryption.alg !== 'aes-gcm-256') {
    throw new Error(`Unsupported voice encryption algorithm: ${String(encryption.alg)}`)
  }
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    const err = new Error('Web Crypto API (SubtleCrypto) is unavailable in worker.')
    ;(err as Error & { recoverable?: boolean }).recoverable = true
    throw err
  }

  const keyBytes = base64ToBytes(encryption.keyB64)
  const ivBytes = base64ToBytes(encryption.ivB64)
  if (keyBytes.length !== 32 || ivBytes.length !== 12) {
    throw new Error('Malformed AES-256-GCM key or IV in voice memo metadata.')
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )
  const decryptedBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    cryptoKey,
    req.buffer
  )

  if (encryption.plaintextSha256) {
    const actualPlainHash = await sha256HexFromBuffer(decryptedBuf)
    if (actualPlainHash !== encryption.plaintextSha256.toLowerCase()) {
      throw new Error('Decrypted voice memo SHA-256 integrity check failed.')
    }
  }

  return {
    message: {
      id: req.id,
      ok: true,
      op: 'decryptAesGcm',
      plaintext: decryptedBuf,
    },
    transfer: [decryptedBuf],
  }
}

async function handleMineNip13(
  req: Extract<MediaCryptoWorkerRequest, { op: 'mineNip13' }>
): Promise<MediaCryptoWorkerSuccess> {
  const target = Math.max(0, Math.min(20, Math.floor(req.targetBits)))
  if (target === 0) {
    return { id: req.id, ok: true, op: 'mineNip13', nonceTag: null }
  }

  const targetStr = String(target)
  const pubkeyLower = req.pubkeyHex.toLowerCase()
  const deadline = performance.now() + Math.max(1, req.timeCapMs)
  let nonce = Math.floor(Math.random() * 0xffffffff)
  let attempts = 0

  const nonceEntry: string[] = ['nonce', '', targetStr]
  const tagsWithNonce: string[][] = [...req.tags, nonceEntry]
  const payload = [0, pubkeyLower, req.createdAt, req.kind, tagsWithNonce, req.content]

  while (performance.now() < deadline) {
    for (let batch = 0; batch < 64; batch++) {
      const nonceHex = nonce.toString(16).padStart(16, '0')
      nonceEntry[1] = nonceHex
      const serialized = JSON.stringify(payload)
      const hash = sha256(utf8Encoder.encode(serialized))
      if (leadingZeroBitsBytes(hash) >= target) {
        return {
          id: req.id,
          ok: true,
          op: 'mineNip13',
          nonceTag: ['nonce', nonceHex, targetStr],
        }
      }
      nonce += 1
      attempts += 1
    }

    // Periodically yield inside the worker so concurrent fast image/hash requests never starve
    if (attempts % 2048 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  return { id: req.id, ok: true, op: 'mineNip13', nonceTag: null }
}

workerScope.onmessage = (event: MessageEvent<MediaCryptoWorkerRequest>) => {
  const req = event.data
  if (!req || typeof req !== 'object' || typeof req.id !== 'number') return

  void (async () => {
    try {
      switch (req.op) {
        case 'processImage': {
          const { message, transfer } = await handleProcessImage(req)
          workerScope.postMessage(message, transfer)
          return
        }
        case 'sha256Hex': {
          const hex = await sha256HexFromBuffer(req.buffer)
          const response: MediaCryptoWorkerSuccess = {
            id: req.id,
            ok: true,
            op: 'sha256Hex',
            hex,
          }
          workerScope.postMessage(response)
          return
        }
        case 'encryptAesGcm': {
          const { message, transfer } = await handleEncryptAesGcm(req)
          workerScope.postMessage(message, transfer)
          return
        }
        case 'decryptAesGcm': {
          const { message, transfer } = await handleDecryptAesGcm(req)
          workerScope.postMessage(message, transfer)
          return
        }
        case 'mineNip13': {
          const response = await handleMineNip13(req)
          workerScope.postMessage(response)
          return
        }
      }
    } catch (err) {
      const failure: MediaCryptoWorkerFailure = {
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err || 'Worker operation failed.'),
        recoverable: Boolean((err as { recoverable?: boolean } | null)?.recoverable),
      }
      workerScope.postMessage(failure)
    }
  })()
}
