import AppKit
import CoreBluetooth
import Foundation
import Network
import WebKit

final class AgnostrApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var server: AssetServer?
    private var webView: WKWebView?
    private var window: NSWindow?
    private let radio = BluetoothMesh()
    private let smoke = CommandLine.arguments.contains("--smoke-test")
    private var smokeDone = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        radio.onEvent = { [weak self] type, payload in
            self?.js("window.__agnostrNearbyEvent?.(type, payload)", ["type": type, "payload": payload])
        }
        let config = WKWebViewConfiguration()
        if smoke { config.websiteDataStore = .nonPersistent() }
        config.applicationNameForUserAgent = "AgnostrMac"
        // In-app WebRTC permission must use the system permission path. The
        // app never injects Nostr credentials or wallet secrets into native code.
        config.userContentController.add(self, name: "agnostrNearby")
        if smoke {
            config.userContentController.addUserScript(WKUserScript(source: """
            window.__agnostrSmokeErrors = [];
            window.addEventListener('error', e => window.__agnostrSmokeErrors.push(String(e.message || e.target?.src || 'resource error')));
            window.addEventListener('unhandledrejection', e => window.__agnostrSmokeErrors.push(String(e.reason)));
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 780), configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        webView = view

        if !smoke {
            let frame = NSRect(x: 0, y: 0, width: 1100, height: 780)
            let win = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                               backing: .buffered, defer: false)
            win.title = "Agnostr"
            win.minSize = NSSize(width: 380, height: 500)
            win.delegate = self
            win.center()
            win.contentView = view
            win.makeKeyAndOrderFront(nil)
            window = win
            installMenus()
            if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
        }

        do {
            guard let root = Bundle.main.resourceURL?.appendingPathComponent("web") else { throw CocoaError(.fileNoSuchFile) }
            let server = try AssetServer(root: root)
            self.server = server
            server.start { [weak self, weak view] state in
                switch state {
                case .ready:
                    view?.load(URLRequest(url: AssetServer.rootURL, cachePolicy: .reloadIgnoringLocalCacheData))
                case .failed:
                    self?.failure("Couldn’t start Agnostr’s offline resources. Close any other running copies of Agnostr, then retry.")
                default: break
                }
            }
        } catch { failure("Couldn’t load the bundled Agnostr app.") }
        if smoke {
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
                self?.failure("Mac shell smoke test timed out.")
            }
        }
    }

    private func installMenus() {
        let menu = NSMenu()
        let app = NSMenuItem()
        let options = NSMenu()
        options.addItem(withTitle: "Quit Agnostr", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        app.submenu = options
        menu.addItem(app)
        let edit = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu
        menu.addItem(edit)
        NSApp.mainMenu = menu
    }

    private func failure(_ message: String) {
        if smoke {
            if !smokeDone { fputs(message + "\n", stderr); exit(1) }
            return
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { !smoke }
    func applicationWillTerminate(_ notification: Notification) { radio.stop(); server?.stop() }
    func windowWillMiniaturize(_ notification: Notification) { if radio.active { radio.stop() } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { radio.stop(); webView.reload() }

    private func isBundleOrigin(_ url: URL?) -> Bool {
        url?.scheme == "http" && url?.host == AssetServer.host && url?.port == Int(AssetServer.port)
    }

    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let target = action.request.url
        if isBundleOrigin(target) { decisionHandler(.allow); return }
        if action.targetFrame?.isMainFrame == false, target?.scheme == "https" { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, let target, ["https", "http", "mailto"].contains(target.scheme ?? "") {
            NSWorkspace.shared.open(target)
        }
        decisionHandler(.cancel)
    }

    func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Never give a popup the in-app Bluetooth bridge.
        return nil
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "http", origin.host == AssetServer.host,
              origin.port == Int(AssetServer.port), message.webView === webView,
              let body = message.body as? [String: Any], let id = body["id"] as? Int, id > 0,
              let action = body["action"] as? String else { return }
        func reply(_ result: [String: Any] = [:], error: String? = nil) {
            js("window.__agnostrNearbyReply?.(id, value, problem)",
               ["id": id, "value": result, "problem": error as Any? ?? NSNull()])
        }
        switch action {
        case "capabilities": reply(["supported": true])
        case "start":
            // Only a native, focused app window can start a radio session.
            guard !smoke, window?.isVisible == true, window?.isMiniaturized == false, NSApp.isActive else {
                reply(error: "Bring the Agnostr window forward to start Bluetooth."); return
            }
            radio.start()
            reply()
        case "stop":
            radio.stop()
            reply()
        case "send":
            guard let options = body["options"] as? [String: Any], let id = options["link"] as? String, id.count <= 40,
                  let input = options["frames"] as? [String], (1...48).contains(input.count) else {
                reply(error: "Invalid Bluetooth frame batch."); return
            }
            var frames = [Data]()
            for frame in input {
                guard (30...684).contains(frame.utf8.count), let decoded = Data(base64Encoded: frame),
                      (22...512).contains(decoded.count) else { reply(error: "Invalid Bluetooth frame."); return }
                frames.append(decoded)
            }
            reply(["accepted": radio.send(to: id, frames: frames)])
        default: reply(error: "Unknown Bluetooth action.")
        }
    }

    private func js(_ source: String, _ arguments: [String: Any]) {
        guard let webView, isBundleOrigin(webView.url) else { return }
        webView.callAsyncJavaScript(source, arguments: arguments, in: nil, in: .page, completionHandler: nil)
    }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        if smoke { smokeStep(view, attempt: 0) }
    }

    private func smokeStep(_ view: WKWebView, attempt: Int) {
        view.callAsyncJavaScript("""
        if (location.origin !== origin || !isSecureContext || !crypto.subtle) return 'wrong-origin';
        if (!document.querySelector('#root')?.children.length) return 'no-root: ' + document.title + ' ' + window.__agnostrSmokeErrors?.slice(-4);
        const supported = document.querySelector('[aria-label="Nearby Bluetooth"]');
        if (supported) supported.click();
        return document.body.innerText.includes('Nearby Bluetooth') &&
          document.body.innerText.includes('Bluetooth chat is off.') ? 'ready' : 'waiting: ' + document.body.innerText.slice(0, 420) + ' errors: ' + window.__agnostrSmokeErrors?.slice(-4);
        """, arguments: ["origin": "http://" + AssetServer.address], in: nil, in: .page) { [weak self, weak view] result in
            guard let self, let view else { return }
            if let value = try? result.get() as? String, value == "ready" {
                self.smokeDone = true
                print("Mac WebKit startup, secure loopback and native BLE capability bridge passed.")
                exit(0)
            }
            if attempt < 60 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { self.smokeStep(view, attempt: attempt + 1) }
            } else { self.failure("Mac WebKit could not open Nearby Bluetooth in smoke test: \(result)") }
        }
    }
}

let app = NSApplication.shared
let delegate = AgnostrApp()
app.delegate = delegate
app.setActivationPolicy(CommandLine.arguments.contains("--smoke-test") ? .accessory : .regular)
app.run()
