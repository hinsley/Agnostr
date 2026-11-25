export interface WalletCredentialData {
  mnemonic?: string
  privateKeyHex?: string
}

export interface WalletCredentialEnvelope {
  version: 1
  salt: string
  iv: string
  ciphertext: string
}

const ITERATIONS = 600_000
const ENCODER = new TextEncoder()
const DOMAIN = ENCODER.encode('agnostr:agwallet:credentials:v1:pbkdf2-sha256:aes-256-gcm')

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Wallet encryption requires Web Crypto in a secure browser context.')
  }
  return globalThis.crypto
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function parseHex(value: unknown, min: number, max = min): Uint8Array<ArrayBuffer> | null {
  if (
    typeof value !== 'string' ||
    value.length < 2 * min ||
    value.length > 2 * max ||
    value.length % 2 !== 0 ||
    !/^[a-f0-9]+$/.test(value)
  ) {
    return null
  }
  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(2 * i, 2 * i + 2), 16)
  }
  return bytes
}

async function keyFor(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const passphraseBytes = ENCODER.encode(passphrase)
  try {
    const subtle = cryptoApi().subtle
    const base = await subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, ['deriveKey'])
    return await subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  } finally {
    passphraseBytes.fill(0)
  }
}

function isCredentialData(raw: unknown): raw is WalletCredentialData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as WalletCredentialData
  return Boolean(
    (value.mnemonic || value.privateKeyHex) &&
      (value.mnemonic === undefined || (typeof value.mnemonic === 'string' && value.mnemonic)) &&
      (value.privateKeyHex === undefined || /^[a-f0-9]{64}$/.test(value.privateKeyHex))
  )
}

export async function encryptWalletCredentials(
  data: WalletCredentialData,
  passphrase: string
): Promise<WalletCredentialEnvelope> {
  if (passphrase.length < 16 || passphrase.length > 1024) {
    throw new Error('Use a unique wallet passphrase of 16 to 1024 characters.')
  }
  if (!isCredentialData(data)) throw new Error('No recovery phrase or valid key to protect.')
  const crypto = cryptoApi()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await keyFor(passphrase, salt)
  const plaintext = ENCODER.encode(JSON.stringify({
    mnemonic: data.mnemonic,
    privateKeyHex: data.privateKeyHex,
  }))
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: DOMAIN, tagLength: 128 },
      key,
      plaintext
    )
    return { version: 1, salt: hex(salt), iv: hex(iv), ciphertext: hex(new Uint8Array(ciphertext)) }
  } finally {
    plaintext.fill(0)
  }
}

export async function decryptWalletCredentials(
  raw: unknown,
  passphrase: string
): Promise<WalletCredentialData> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Encrypted wallet data is invalid. Use your offline backup on a separate profile.')
  }
  const envelope = raw as Partial<WalletCredentialEnvelope>
  const iv = parseHex(envelope.iv, 12)
  const salt = parseHex(envelope.salt, 16)
  const data = parseHex(envelope.ciphertext, 16, 2048)
  if (envelope.version !== 1 || !iv || !salt || !data) {
    throw new Error('Encrypted wallet data is invalid. Use your offline backup on a separate profile.')
  }
  if (!passphrase || passphrase.length > 1024) throw new Error('Enter your wallet passphrase.')
  const key = await keyFor(passphrase, salt)
  let plaintext: Uint8Array | undefined
  try {
    plaintext = new Uint8Array(await cryptoApi().subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: DOMAIN, tagLength: 128 },
      key,
      data
    ))
    const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    if (!isCredentialData(result)) throw new Error('Invalid decrypted credentials.')
    return { mnemonic: result.mnemonic, privateKeyHex: result.privateKeyHex }
  } catch {
    throw new Error('The wallet passphrase was incorrect, or the encrypted wallet is damaged.')
  } finally {
    plaintext?.fill(0)
  }
}
