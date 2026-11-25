# Same-profile device sync

Device sync moves a bounded set of records between browsers signed in with the **same Nostr key**. It is not a full backup, a device-pairing protocol, or a way to copy a profile's signing key. Local profile switching and its browser-local vault are separate from this relay protocol.

| Data | Behavior |
| --- | --- |
| Profile | Display nickname and Lightning receiving address; no wallet credentials or balances |
| People | Trusted/blocked peers and labels, private notes, recent real DM nicknames and per-peer clear cutoffs |
| Communities | Joined servers, custom order and channel metadata. Existing encrypted private communities share the room access material necessary for the same profile to open its joined rooms. |
| BitChat | Pinned channels in order and bounded message tails for the active/pinned scopes. Device-local long history is not a portable archive. |
| DMs | Bounded conversation history; delivery status, existing reply references and reactions converge without replacing the message body. Older clients can still exchange new message IDs but do not negotiate mutable DM metadata. |
| Agmail | Bounded mail and draft content including attachments' existing encrypted descriptors, contacts, folders, deletions, and timestamped folder sort preference. No relay/vault limits or read-receipt defaults copied. |
| Device list | Display label and last synchronization/online timestamps. “Forget” removes a list entry, **not** cryptographic access. A device still possessing the profile key can reappear. |

**Device-local by design:** translation/transcription model selections, runtime/accelerator, downloaded models and caches, automatic AI and language preferences, content filter preferences, appearance, active views/drafts outside Agmail, unread badges, permissions, audio/video devices, notification preferences, push endpoint and credentials, relay overrides, and provider/endpoint credentials. Wallet seeds, mint/Lightning signing or recovery material, proofs, and spending state must not enter sync; a public Lightning receiving address is separate from custody. Other independently synchronized Nostr applications/features aren't part of this protocol.

## Transport, conflicts and practical limits

- Relay events are signed by the profile key; content is NIP-44 encrypted back to that same key. Relays can still see the public key, sync kind, timing, sizes, and that the account is using sync. Nothing in the protocol authorizes just one device; withdraw access to the signing key if a device is lost. A conventional NIP-07 extension must support NIP-44; to avoid background prompts, extension mode is manual checkpoint sync only.
- Devices exchange authenticated fingerprints and request bounded chunks when online. Checkpoints carry profile state and as much recent history as fits, preferring data without discarding core deletion records. Relay rejections leave a dirty checkpoint queued for the next successful reconnect/heartbeat. A checkpoint can be accepted by one relay and absent or stale on another. Startup checks multiple relay copies when available.
- Lists/scalars are last-writer-wins, not field-by-field merges of simultaneous reorderings. Meaningful clock skew can still distort the winner. Per-entry deletion cutoffs protect against stale histories; Agmail retains only a bounded tombstone history. Server and BitChat history is still primarily deduplicated by message ID; reactions not available directly from their relays are not fully reconciled as DM reactions are.
- Recovery is **recent/best-effort**, not guaranteed: message scopes are capped, individual oversized records cannot be sent through current packets, and a large Agmail mailbox can exceed live transfer limits or fall outside the checkpoint. If even core state cannot fit in the encryption envelope it will not be published; it is not truncated silently. The next design milestone for full offline recovery is durable, independently replaceable shards with a manifest and explicit restore coverage/status. Do not solve capacity by silently dropping deletion records, private-room requirements or splitting wallet custody across devices.
- Apple/browser permissions, physical devices, and real relay retention vary and are not asserted by offline tests. Regression tests cover encrypted same-key exchange, other-key rejection, bounded Unicode packet sizes, timestamp conflicts, and DM metadata. The browser test launches two distinct synthetic profiles with the same throwaway key and a mock relay; it does not use production relays or existing identities.

```sh
node --experimental-strip-types --test scripts/check-device-sync.mjs
# In a second terminal, with npm run build and npm run preview already running:
node --experimental-strip-types scripts/check-device-sync-ui.mjs http://127.0.0.1:4173/
```
