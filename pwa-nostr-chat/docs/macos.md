# Agnostr for macOS

This local build runs the same bundled React app in an AppKit/WKWebView
window. macOS 13 or later is required. The build is Apple Silicon by default
on Apple Silicon, or Intel by default on Intel. It has separate browser
storage and does not automatically import PWA identities, preferences, or
wallet keys. Web Push, PWA install and PWA updates are disabled here.

## Offline Nearby Bluetooth

In the Bitchat globe, click the **Nearby Bluetooth** icon, choose a name,
click **Start Bluetooth**, and allow Agnostr's macOS Bluetooth permission.
On Android you can open the same control in the Agnostr APK or join the
public mesh in Bitchat. Nearby chat uses signed public text and an ephemeral
identity. It does not send chat to Nostr or support private Bitchat DMs.
Closing the nearby panel, minimizing the Mac window or quitting stops the
radio. Keeping the window open while switching focus does not stop it.

## Build on a Mac

Install Xcode command-line tools, Node 22 or later, and npm. Run:

```sh
npm ci
npm run mac:app -- --smoke-test
```

The result is `dist-mac/Agnostr.app` and a matching ZIP. The smoke test
opens the actual app in a temporary WebKit session and checks that the
bundled interface and native Bluetooth capability handshake work. It
does not turn on the radio or grant Bluetooth permission. Radio testing
requires a second nearby device with Bluetooth (and not an Internet relay).

The local output is ad-hoc signed unless `AGNOSTR_MAC_SIGN_IDENTITY` names
a usable signing identity. It isn't notarized; Developer ID signing and
Apple notarization are required before distributing downloads broadly.
Use `AGNOSTR_MAC_ARCH=x86_64` to target Intel. No GitHub build job is required.

The bundled local origin binds only to `127.0.0.1:47631` to preserve WebKit's
secure-context APIs and per-install storage. It serves only packaged web
assets. The Bluetooth bridge is confined to the app's top-level WebKit
page and is not an HTTP API.
