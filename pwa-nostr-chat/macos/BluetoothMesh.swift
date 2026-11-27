import CoreBluetooth
import Foundation

final class BluetoothMesh: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate, CBPeripheralManagerDelegate {
    static let service = CBUUID(string: "F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C")
    static let wire = CBUUID(string: "A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D")
    private static let minFrame = 64
    private static let maxLinks = 6

    private class Link {
        let id = UUID().uuidString
        var queue = [Data]()
        var received = 0
        var window = ProcessInfo.processInfo.systemUptime
        var size: Int { 0 }
        func admitsFrame() -> Bool {
            let now = ProcessInfo.processInfo.systemUptime
            if now - window >= 1 { window = now; received = 0 }
            guard received < 96 else { return false }
            received += 1
            return true
        }
    }

    private final class Outgoing: Link {
        let peer: CBPeripheral
        var wire: CBCharacteristic?
        var ready = false
        var writing = false
        init(_ peer: CBPeripheral) { self.peer = peer }
        var type: CBCharacteristicWriteType { wire?.properties.contains(.writeWithoutResponse) == true ? .withoutResponse : .withResponse }
        override var size: Int {
            guard ready else { return 0 }
            return min(512, peer.maximumWriteValueLength(for: .withoutResponse), peer.maximumWriteValueLength(for: type))
        }
    }

    private final class Incoming: Link {
        let peer: CBCentral
        init(_ peer: CBCentral) { self.peer = peer }
        override var size: Int { min(512, peer.maximumUpdateValueLength) }
    }

    private var central: CBCentralManager?
    private var peripheral: CBPeripheralManager?
    private var published: CBMutableCharacteristic?
    private var outgoing = [UUID: Outgoing]()
    private var incoming = [UUID: Incoming]()
    private var retry = [UUID: TimeInterval]()
    private(set) var active = false
    var onEvent: ((String, [String: Any]) -> Void)?

    func start() {
        if active { publish(); return }
        active = true
        central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        peripheral = CBPeripheralManager(delegate: self, queue: .main, options: nil)
        publish()
    }

    func stop(error: String? = nil) {
        active = false
        central?.stopScan()
        for link in outgoing.values {
            link.peer.delegate = nil
            central?.cancelPeripheralConnection(link.peer)
        }
        peripheral?.stopAdvertising()
        peripheral?.removeAllServices()
        central?.delegate = nil
        peripheral?.delegate = nil
        central = nil
        peripheral = nil
        published = nil
        outgoing.removeAll()
        incoming.removeAll()
        retry.removeAll()
        publish(error)
    }

    private func publish(_ error: String? = nil) {
        let links: [Link] = Array(outgoing.values) + Array(incoming.values)
        var state: [String: Any] = [
            "active": active,
            "links": links.filter { $0.size >= Self.minFrame }.map { ["id": $0.id, "maxBytes": $0.size] },
        ]
        if let error { state["error"] = error }
        onEvent?("state", state)
    }

    func send(to id: String, frames: [Data]) -> Bool {
        guard active, (1...48).contains(frames.count) else { return false }
        let links: [Link] = Array(outgoing.values) + Array(incoming.values)
        guard let link = links.first(where: { $0.id == id }), link.size >= Self.minFrame,
              link.queue.count + frames.count <= 96,
              frames.allSatisfy({ $0.count >= 22 && $0.count <= link.size })
        else { return false }
        link.queue.append(contentsOf: frames)
        if let link = link as? Outgoing { pump(link) }
        if let link = link as? Incoming { pump(link) }
        return true
    }

    private func receive(_ data: Data, via link: Link) {
        guard active, (22...512).contains(data.count), link.admitsFrame() else { return }
        onEvent?("frame", ["link": link.id, "wire": data.base64EncodedString()])
    }

    private func managerIssue(_ state: CBManagerState) -> String? {
        switch state {
        case .unauthorized: return "Allow Agnostr to use Bluetooth in System Settings → Privacy & Security → Bluetooth."
        case .unsupported: return "Bluetooth LE is unavailable on this Mac."
        case .poweredOff: return "Turn on Bluetooth in System Settings first."
        default: return nil
        }
    }

    func centralManagerDidUpdateState(_ manager: CBCentralManager) {
        guard active, manager === central else { return }
        if let error = managerIssue(manager.state) { stop(error: error); return }
        if manager.state == .poweredOn { manager.scanForPeripherals(withServices: [Self.service]) }
    }

    func peripheralManagerDidUpdateState(_ manager: CBPeripheralManager) {
        guard active, manager === peripheral else { return }
        if let error = managerIssue(manager.state) { stop(error: error); return }
        guard manager.state == .poweredOn, published == nil else { return }
        let characteristic = CBMutableCharacteristic(type: Self.wire,
            properties: [.notify, .write, .writeWithoutResponse], value: nil, permissions: [.writeable])
        let service = CBMutableService(type: Self.service, primary: true)
        service.characteristics = [characteristic]
        published = characteristic
        manager.add(service)
    }

    func peripheralManager(_ manager: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard active, manager === peripheral else { return }
        if error != nil { publish("Couldn’t publish the Bluetooth service. Scanning may still work."); return }
        manager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [Self.service]])
    }

    func peripheralManagerDidStartAdvertising(_ manager: CBPeripheralManager, error: Error?) {
        guard active, manager === peripheral else { return }
        if error != nil { publish("Couldn’t advertise this Mac. Scanning may still work.") }
    }

    func centralManager(_ manager: CBCentralManager, didDiscover peer: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard active, manager === central, outgoing.count < 3, outgoing.count + incoming.count < Self.maxLinks,
              outgoing[peer.identifier] == nil else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let until = retry[peer.identifier], now < until { return }
        if retry.count >= 64 { retry = retry.filter { $0.value > now } }
        if retry.count >= 64 { return }
        let link = Outgoing(peer)
        outgoing[peer.identifier] = link
        peer.delegate = self
        manager.connect(peer)
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self, weak link] in
            guard let self, let link, self.outgoing[peer.identifier] === link, !link.ready else { return }
            self.drop(peer)
        }
    }

    func centralManager(_ manager: CBCentralManager, didConnect peer: CBPeripheral) {
        guard manager === central, outgoing[peer.identifier] != nil else { return }
        peer.discoverServices([Self.service])
    }

    func centralManager(_ manager: CBCentralManager, didFailToConnect peer: CBPeripheral, error: Error?) {
        if manager === central, outgoing[peer.identifier] != nil { drop(peer) }
    }

    func centralManager(_ manager: CBCentralManager, didDisconnectPeripheral peer: CBPeripheral, error: Error?) {
        if manager === central, outgoing[peer.identifier] != nil { drop(peer) }
    }

    private func drop(_ peer: CBPeripheral) {
        guard outgoing.removeValue(forKey: peer.identifier) != nil else { return }
        retry[peer.identifier] = ProcessInfo.processInfo.systemUptime + 9
        peer.delegate = nil
        central?.cancelPeripheralConnection(peer)
        publish()
    }

    func peripheral(_ peer: CBPeripheral, didDiscoverServices error: Error?) {
        guard outgoing[peer.identifier]?.peer === peer else { return }
        guard error == nil, let service = peer.services?.first(where: { $0.uuid == Self.service }) else { drop(peer); return }
        peer.discoverCharacteristics([Self.wire], for: service)
    }

    func peripheral(_ peer: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let link = outgoing[peer.identifier], link.peer === peer else { return }
        guard error == nil, let wire = service.characteristics?.first(where: { $0.uuid == Self.wire }),
              wire.properties.contains(.notify) || wire.properties.contains(.indicate),
              wire.properties.contains(.writeWithoutResponse) || wire.properties.contains(.write)
        else { drop(peer); return }
        link.wire = wire
        peer.setNotifyValue(true, for: wire)
    }

    func peripheral(_ peer: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard let link = outgoing[peer.identifier], link.peer === peer, characteristic === link.wire else { return }
        guard error == nil, characteristic.isNotifying else { drop(peer); return }
        link.ready = true
        publish()
    }

    func peripheral(_ peer: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, let link = outgoing[peer.identifier], link.peer === peer,
              characteristic === link.wire, let data = characteristic.value else { return }
        receive(data, via: link)
    }

    func peripheralIsReady(toSendWriteWithoutResponse peer: CBPeripheral) {
        if let link = outgoing[peer.identifier], link.peer === peer { pump(link) }
    }

    func peripheral(_ peer: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let link = outgoing[peer.identifier], link.peer === peer, characteristic === link.wire else { return }
        if error != nil { drop(peer); return }
        link.writing = false
        pump(link)
    }

    private func pump(_ link: Outgoing) {
        guard link.ready, let wire = link.wire else { return }
        if link.type == .withResponse {
            if !link.writing, !link.queue.isEmpty {
                link.writing = true
                link.peer.writeValue(link.queue.removeFirst(), for: wire, type: .withResponse)
            }
        } else {
            while !link.queue.isEmpty && link.peer.canSendWriteWithoutResponse {
                link.peer.writeValue(link.queue.removeFirst(), for: wire, type: .withoutResponse)
            }
        }
    }

    func peripheralManager(_ manager: CBPeripheralManager, central peer: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard active, manager === peripheral, characteristic.uuid == Self.wire,
              incoming[peer.identifier] == nil, outgoing.count + incoming.count < Self.maxLinks else { return }
        incoming[peer.identifier] = Incoming(peer)
        publish()
    }

    func peripheralManager(_ manager: CBPeripheralManager, central peer: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        if manager === peripheral, characteristic.uuid == Self.wire, incoming.removeValue(forKey: peer.identifier) != nil { publish() }
    }

    func peripheralManager(_ manager: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard active, manager === peripheral, let first = requests.first else { return }
        for request in requests {
            guard request.characteristic.uuid == Self.wire, request.offset == 0, let data = request.value,
                  (22...512).contains(data.count), incoming[request.central.identifier] != nil else {
                manager.respond(to: first, withResult: .requestNotSupported)
                return
            }
        }
        manager.respond(to: first, withResult: .success)
        for request in requests {
            if let data = request.value, let link = incoming[request.central.identifier] { receive(data, via: link) }
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers manager: CBPeripheralManager) {
        guard manager === peripheral else { return }
        for link in incoming.values { pump(link) }
    }

    private func pump(_ link: Incoming) {
        guard let manager = peripheral, let wire = published else { return }
        while let value = link.queue.first {
            guard manager.updateValue(value, for: wire, onSubscribedCentrals: [link.peer]) else { return }
            link.queue.removeFirst()
        }
    }
}
