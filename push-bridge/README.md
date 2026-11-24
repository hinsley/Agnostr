# Agnostr Push Bridge (`agnostr-push`)

Zero-knowledge Web Push bridge for [Agnostr](https://agnostr.com), built on Cloudflare Workers + KV with RFC 8292 VAPID (ES256), RFC 8291 `aes128gcm` Web Push payload encryption, and NIP-98 HTTP authentication.

## Architecture

- **Zero plaintext for private messages & calls**: DMs (`dm`), DM calls (`dm-call`), Agmail (`agmail`), and call cancellations (`call-cancel`) are delivered as blind push pokes — the worker never receives or stores private message content or private Nostr keys.
- **Instant delivery + background fallback**:
  - `POST /poke` delivers immediate sub-second Web Push notifications for DMs, calls, Agmail, and Bitchat mentions.
  - A 1-minute Cloudflare Cron Trigger (`* * * * *`) polls public Nostr relays as a fallback for offline / third-party-client events (`kind:1059` gift wraps, `kind:4` legacy DMs, `kind:9` server chat, `kind:20000` geo chat).
- **Free-tier safe**: Deduplication uses the Cloudflare edge `caches.default` Cache API (zero KV writes per message), and expired `404`/`410` browser endpoints are pruned automatically.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Health check and worker status |
| `GET` | `/vapid-public-key` | Public | Returns the bridge's base64url P-256 VAPID public key |
| `POST` | `/subscribe` | NIP-98 | Register or update a browser `PushSubscription` and notification preferences for the signed pubkey |
| `DELETE` | `/subscribe` | NIP-98 | Remove a browser `PushSubscription` for the signed pubkey |
| `POST` | `/poke` | NIP-98 | Trigger an instant blind Web Push poke to recipient pubkeys |
| `POST` | `/test-push` | NIP-98 | Deliver a verification Web Push to the caller's own registered devices |

## Self-Hosting / Deployment

1. Install dependencies:
   ```bash
   cd push-bridge
   npm install
   ```
2. Create a Cloudflare KV namespace and set its `id` under `[[kv_namespaces]]` in `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create AGNOSTR_PUSH_KV
   ```
3. Generate a P-256 VAPID keypair (uncompressed 65-byte public key and 32-byte private key encoded as unpadded base64url). Put the **public** key in `wrangler.toml` (`[vars].VAPID_PUBLIC_KEY`) and upload the **private** key strictly as an encrypted Wrangler secret (never commit it):
   ```bash
   npx wrangler secret put VAPID_PRIVATE_KEY
   ```
4. Typecheck and deploy:
   ```bash
   npm run typecheck
   npm run deploy
   ```
