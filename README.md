# Agnostr
Cross-platform Bitchat client (Nostr)

## Bitchat room history

Scroll upward to pause following the live feed. Incoming messages are counted
without moving what you're reading. Tap the new-message counter to return to
live chat, or use **Load earlier messages** / **Load newer messages** to browse
the history saved on this device.

Public Bitchat rooms keep up to 5,000 recent confirmed messages per room, capped
at 20,000 across profiles and rooms. The app mounts no more than 160 messages
at once. This cache does not fetch older messages from relays, does not include
DMs or group chats, and does not sync between devices. Oversized events stay in
the recent cache only; available history depends on what the client saw and
what the browser has retained. To clear a room's saved history, use `/clear`.
