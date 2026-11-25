import { mnemonicToSeedSync } from '@scure/bip39'
import { deriveNativeBtcWallet } from './bitcoinOnchain.ts'
import {
  deriveNut13SeedBytes,
  derivePrivateKeyHexFromSeed,
  deriveWalletP2pkPubkeyHex,
  isValidBip39Mnemonic,
  normalizeMnemonicPhrase,
  parseWalletPrivateKeyHex,
} from './cashuWallet.ts'

export interface WalletRestoreCredentials {
  mnemonic?: string
  privateKeyHex?: string
}

function normalizeCredentials(credentials: WalletRestoreCredentials): WalletRestoreCredentials {
  let mnemonic: string | undefined
  if (credentials.mnemonic != null) {
    if (!isValidBip39Mnemonic(credentials.mnemonic)) throw new Error('Invalid wallet recovery phrase.')
    mnemonic = normalizeMnemonicPhrase(credentials.mnemonic)
  }

  let privateKeyHex: string | undefined
  if (credentials.privateKeyHex != null) {
    const parsed = parseWalletPrivateKeyHex(credentials.privateKeyHex)
    if (!parsed || !deriveWalletP2pkPubkeyHex(parsed)) throw new Error('Invalid wallet private key.')
    privateKeyHex = parsed
  } else if (mnemonic) {
    privateKeyHex = derivePrivateKeyHexFromSeed(mnemonicToSeedSync(mnemonic))
  }

  return { mnemonic, privateKeyHex }
}

/**
 * Recovery can initialize a keyless wallet or add records to the same account.
 * For existing wallets it must preserve the Bitcoin address, Cashu restore seed,
 * and exact P2PK spending scalar, none of which a short legacy fingerprint covers.
 */
export function selectWalletRestoreCredentials(
  existing: WalletRestoreCredentials,
  incoming: WalletRestoreCredentials
): WalletRestoreCredentials {
  const next = normalizeCredentials(incoming)
  if (!next.mnemonic && !next.privateKeyHex) return existing
  const current = normalizeCredentials(existing)
  if (!current.mnemonic && !current.privateKeyHex) return next

  const currentAddress = deriveNativeBtcWallet(current)?.address
  const nextAddress = deriveNativeBtcWallet(next)?.address
  const currentSeed = deriveNut13SeedBytes(current)
  const nextSeed = deriveNut13SeedBytes(next)
  if (
    !currentAddress ||
    currentAddress !== nextAddress ||
    current.privateKeyHex !== next.privateKeyHex ||
    !currentSeed ||
    !nextSeed ||
    currentSeed.length !== nextSeed.length ||
    !currentSeed.every((byte, index) => byte === nextSeed[index])
  ) {
    throw new Error(
      'This recovery belongs to another Agwallet. Restore it in a separate Agnostr profile. Your current wallet was not changed.'
    )
  }
  return existing
}
