# Agnostr Push Bridge (Optional Companion Server)

Agnostr works out of the box with live notifications and incoming DM call ringing whenever the app is open or backgrounded in a browser or installed PWA.

Because static GitHub Pages apps cannot hold open WebSocket connections once the OS fully terminates or sleeps a closed phone app, you can optionally self-host this lightweight **NIP-98 / VAPID Web Push bridge** so your phone wakes up and rings even when Agnostr is completely closed.

## Privacy Model

- **Zero plaintext access to DMs or Calls**: The bridge only watches encrypted `kind: 1059` (NIP-59 gift-wrapped DMs) and `kind: 25050` (NIP-44 encrypted DM call invites) targeted at your `#p` pubkey, plus optional `kind: 9` server mentions and `kind: 20000` Geo Radio channels.
- **Cryptographic NIP-98 Auth**: Every `POST /subscribe` and `DELETE /subscribe` request is verified against a signed `kind: 27235` Nostr HTTP Auth event matching the subscriber's pubkey and request payload SHA-256 hash.

## Quick Start

```bash
cd push-bridge
npm install

# 1. Generate persistent VAPID keys once:
npm run generate-vapid

# 2. Run the bridge with your keys:
VAPID_PUBLIC_KEY="<public-key>" \
VAPID_PRIVATE_KEY="<private-key>" \
VAPID_SUBJECT="mailto:you@yourdomain.com" \
SUBSCRIPTIONS_FILE="./subscriptions.json" \
PORT=8787 \
npm start
```

## Connect from Agnostr

1. Host the bridge behind HTTPS (e.g., Fly.io, Railway, Render, Cloudflare Tunnel, or Nginx/Caddy).
2. Open Agnostr → **Settings → Notifications → Background Web Push Server (Optional)**.
3. Paste your bridge URL (e.g. `https://push.yourdomain.com`) — the VAPID public key is fetched automatically from `GET /vapid-public-key`.
4. Click **Connect Device**.

## Endpoints

- `GET /health` — Returns `{ ok, subscribers, relays }`.
- `GET /vapid-public-key` — Returns `{ publicKey }` for `PushManager.subscribe()`.
- `POST /subscribe` *(NIP-98 required)* — Registers a Web Push subscription + watched relays/geohashes.
- `DELETE /subscribe` *(NIP-98 required)* — Unregisters the device endpoint.
