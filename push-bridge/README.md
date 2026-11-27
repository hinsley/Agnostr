# Agnostr Push Bridge (`agnostr-push`)

Zero-knowledge Web Push bridge for [Agnostr](https://agnostr.com), built on Cloudflare Workers + KV with RFC 8292 VAPID (ES256), RFC 8291 `aes128gcm` Web Push payload encryption, and NIP-98 HTTP authentication.

## Architecture

- **Zero plaintext for private messages & calls**: DMs (`dm`), DM calls (`dm-call`), Agmail (`agmail`), and call cancellations (`call-cancel`) are delivered as blind push pokes — the worker never receives or stores private message content or private Nostr keys.
- **Durable delivery**: signed `POST /poke` queues per-device encrypted Web Push work before acknowledging it. The per-recipient `PushDelivery` Durable Object starts the first attempt and uses alarms for durable retry of network errors, 408/425/429, and 5xx (respecting Retry-After, expiry, and bounded attempts). An accepted or permanently refused device is not replayed when another device needs retry. Provider acceptance does not prove that an OS displayed the notification. A crash between provider acceptance and saving the receipt can still lead to an at-least-once duplicate.
- **Bounded recipient-scoped fallback**: a minute-triggered relay scan pages through independent per-account subscription/alias KV keys by a Durable Object cursor (not a shared read-modify-write index) and uses overlapping timestamp bands of more than 48 hours for NIP-17 gift wraps, without changing sender timestamps. The first complete relay/tag poll baselines old IDs silently; later polls queue newly observed IDs, including backdated wraps. Relay `CLOSED` replies, timeouts, saturated bands and bounded scanning capacity are not delivery guarantees. The worker never authenticates as a recipient, so NIP-42 private relays remain invisible to this fallback. Use a compatible sender or an authorized relay-side notification integration for those messages. Direct NIP-98 pokes deliberately do not correlate signed senders with the anonymous wrapper IDs from the relay.
- **Optional public Bitchat rooms**: only a signed, currently eligible device opted into background notifications for all messages in its known pinned public rooms receives exact `#g`/named-topic `#d` matches. The app does not upload social block or allow lists; it disables this watcher when its local sender filters cannot be enforced. The Worker checks the current registered room and a 12-hour eligibility lease again for queued delivery. Changes can take time to reach Workers KV. Encrypted virtual groups and restricted group-specific relays have no safe untagged fallback without independently authorized routing; direct Agnostr pokes and recipient-tagged public events remain separate.
- **Bounded state**: durable outcome/observed rows expire; relay work rotates, events are validated, and leases/alarms avoid per-event KV writes. The daily free-tier allowance still depends on user counts, relay traffic, and registration churn.

The minute trigger still polls relays every minute. The discovery coordinator
lists subscription and alias prefixes at most once per eight minutes (360 list
requests per 24 hours) and serves bounded minute-size slices from the cached
batch. An unlisted new registration may wait for discovery; cached identifiers
never bypass the live device/preferences checks. On a list error the Worker
continues with the last batch and emits an aggregate `discoveryDegraded` flag.
Known stale cursors restart on the next budgeted refresh, not immediately.

Each minute now sends the ordered relay observations and public-room jobs in
one queue request per canonical recipient. Previously seen gift wraps read
observation state once across relay copies and skip per-device terminal and
pending queue lookups. Relay copies reuse signature verification only if all
signed fields and the signature match. The relay lookback, per-source silent
first baseline, recipient scope, and durable retry policy are unchanged.
Aggregate `queueCalls` and `queueBatches` show the actual batching ratio.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Worker version and durable-delivery binding status (not proof of provider or scheduler health) |
| `GET` | `/vapid-public-key` | Public | Returns the bridge's base64url P-256 VAPID public key |
| `POST` | `/subscribe` | NIP-98 | Register or update a browser `PushSubscription` and notification preferences for the signed pubkey |
| `DELETE` | `/subscribe` | NIP-98 | Remove a browser `PushSubscription` for the signed pubkey |
| `POST` | `/poke` | NIP-98 | Trigger an instant blind Web Push poke to recipient pubkeys |
| `POST` | `/test-push` | NIP-98 | Attempt a verification Web Push to one signed registered endpoint |

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
4. Run the type check and offline tests, then deploy the Worker (independently of GitHub Pages). The `delivery-v1` migration creates the SQLite-backed `PushDelivery` class and installs the alarm binding:
   ```bash
   npm run typecheck
   npm test
   npm run deploy
   ```

Verify `GET /health` returns `version: 2` and `durableDelivery: true`. Inspect aggregate relay scan and provider-status logs without exposing push endpoints, pubkeys, or private keys. Test with an installed, opted-in device after a real release; the offline test suite does not connect to real devices or relays.
