import Foundation
import Network
import UniformTypeIdentifiers

/// Serve only packaged public assets on IPv4 loopback. The Bluetooth bridge
/// belongs to WKWebView, not this HTTP listener. No profile data is served.
final class AssetServer {
    static let port: UInt16 = 47631
    static let host = "127.0.0.1"
    static let address = "\(host):\(port)"
    static let rootURL = URL(string: "http://\(address)/")!
    private let root: URL
    private let queue = DispatchQueue(label: "com.agnostr.assets")
    private let listener: NWListener
    private var clients = [ObjectIdentifier: NWConnection]()

    init(root: URL) throws {
        self.root = root.resolvingSymlinksInPath().standardizedFileURL
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: Self.port)!)
        listener = try NWListener(using: parameters)
    }

    func start(state: @escaping (NWListener.State) -> Void) {
        listener.stateUpdateHandler = { status in DispatchQueue.main.async { state(status) } }
        listener.newConnectionHandler = { [weak self] client in self?.accept(client) }
        listener.start(queue: queue)
    }

    func stop() {
        listener.cancel()
        queue.async {
            for client in self.clients.values { client.cancel() }
            self.clients.removeAll()
        }
    }

    private func accept(_ client: NWConnection) {
        guard clients.count < 48 else { client.cancel(); return }
        let id = ObjectIdentifier(client)
        clients[id] = client
        client.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 12) { [weak self, weak client] in
            guard let self, let client, self.clients[id] === client else { return }
            self.close(client)
        }
        read(client, accumulated: Data())
    }

    private func close(_ client: NWConnection) {
        clients.removeValue(forKey: ObjectIdentifier(client))
        client.cancel()
    }

    private func read(_ client: NWConnection, accumulated: Data) {
        client.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] part, _, ended, error in
            guard let self, self.clients[ObjectIdentifier(client)] != nil else { return }
            if error != nil { self.close(client); return }
            var header = accumulated
            if let part { header.append(part) }
            if header.count > 16384 {
                self.reply(client, status: "431 Request Header Fields Too Large")
            } else if let terminator = header.range(of: Data([13, 10, 13, 10])) {
                self.respond(client, header: header[..<terminator.lowerBound])
            } else if !ended {
                self.read(client, accumulated: header)
            } else {
                self.close(client)
            }
        }
    }

    private func respond(_ client: NWConnection, header: Data) {
        guard let text = String(data: header, encoding: .utf8) else { reply(client, status: "400 Bad Request"); return }
        let lines = text.components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
        guard first.count == 3, ["HTTP/1.0", "HTTP/1.1"].contains(String(first[2])) else {
            reply(client, status: "400 Bad Request"); return
        }
        guard first[0] == "GET" || first[0] == "HEAD" else { reply(client, status: "405 Method Not Allowed"); return }
        var hosts = [String]()
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { reply(client, status: "400 Bad Request"); return }
            if line[..<colon].lowercased() == "host" {
                hosts.append(line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
            }
        }
        guard hosts == [Self.address] else { reply(client, status: "403 Forbidden"); return }
        let target = first[1].split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
        guard target.hasPrefix("/"), !target.hasPrefix("//"), let path = target.removingPercentEncoding,
              !path.contains("\\"),
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !path.split(separator: "/").contains(where: { $0.hasPrefix(".") })
        else { reply(client, status: "400 Bad Request"); return }
        let relative = path == "/" ? "index.html" : String(path.dropFirst())
        let url = root.appendingPathComponent(relative).resolvingSymlinksInPath().standardizedFileURL
        guard url.path.hasPrefix(root.path + "/"),
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, let size = values.fileSize, size <= 64 * 1024 * 1024
        else { reply(client, status: "404 Not Found"); return }
        let mime: String
        switch url.pathExtension.lowercased() {
        case "js", "mjs": mime = "text/javascript"
        case "css": mime = "text/css"
        case "wasm": mime = "application/wasm"
        case "json", "webmanifest": mime = "application/json"
        case "ktx2": mime = "image/ktx2"
        default: mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
        let head = first[0] == "HEAD"
        let data = head ? Data() : (try? Data(contentsOf: url, options: .mappedIfSafe))
        guard let data, head || data.count == size else { reply(client, status: "404 Not Found"); return }
        reply(client, status: "200 OK", type: mime, length: size, body: data,
              cache: relative.hasPrefix("assets/") ? "public, max-age=31536000, immutable" : "no-cache")
    }

    private func reply(_ client: NWConnection, status: String, type: String = "text/plain", length: Int? = nil,
                       body: Data = Data(), cache: String = "no-store") {
        let envelope = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(length ?? body.count)\r\n" +
            "Connection: close\r\nCache-Control: \(cache)\r\nX-Content-Type-Options: nosniff\r\n" +
            "Cross-Origin-Resource-Policy: same-origin\r\nContent-Security-Policy: frame-ancestors 'none'; base-uri 'none'; object-src 'none'\r\n\r\n"
        client.send(content: Data(envelope.utf8), isComplete: false, completion: .contentProcessed { [weak self] error in
            guard let self, error == nil, !body.isEmpty else { self?.close(client); return }
            client.send(content: body, isComplete: true, completion: .contentProcessed { [weak self] _ in self?.close(client) })
        })
    }
}
