package com.agnostr.app.nearby;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@SuppressLint("MissingPermission")
final class GattMesh {
    private static final UUID SERVICE = UUID.fromString("F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C");
    private static final UUID DATA = UUID.fromString("A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final int MAX_LINKS = 6, MAX_OUTBOUND_LINKS = 3, MAX_QUEUE = 96, MIN_DATA = 64;
    private static final long RETRY_DELAY_MS = 8000, LINK_TIMEOUT_MS = 10000;

    interface Observer {
        void changed(boolean active, String error, List<LinkInfo> links);
        void receive(String id, byte[] wire);
    }

    static final class LinkInfo {
        final String id;
        final int maxBytes;
        LinkInfo(Link link) { id = link.id; maxBytes = link.maxBytes(); }
    }

    private static final class Link {
        final String id = UUID.randomUUID().toString();
        final BluetoothDevice device;
        final boolean isCentral;
        final ArrayDeque<byte[]> queued = new ArrayDeque<>();
        BluetoothGatt gatt;
        BluetoothGattCharacteristic data;
        boolean subscribed;
        boolean discoveryStarted;
        int mtu = 23;
        int writeAttempt;
        boolean writing;
        long rateWindow;
        int received;
        Link(BluetoothDevice device, boolean isCentral) { this.device = device; this.isCentral = isCentral; }
        int maxBytes() { return Math.min(512, mtu - 3); }
        boolean ready() { return subscribed && maxBytes() >= MIN_DATA; }
    }

    private final Context context;
    private final Observer observer;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, Link> outgoing = new LinkedHashMap<>();
    private final Map<String, Link> incoming = new LinkedHashMap<>();
    private final Map<String, Long> retry = new LinkedHashMap<>();
    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothGattServer server;
    private BluetoothGattCharacteristic serverData;
    private ScanCallback scanCallback;
    private AdvertiseCallback advertiseCallback;
    private Link pendingNotification;
    private boolean active;
    private int generation;
    private int notificationAttempt;

    GattMesh(Context context, Observer observer) { this.context = context; this.observer = observer; }

    void start() {
        if (active) { publish(null); return; }
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) throw new IllegalStateException("This device has no Bluetooth adapter.");
        if (!adapter.isEnabled()) throw new IllegalStateException("Turn on Bluetooth in Android settings first.");
        scanner = adapter.getBluetoothLeScanner();
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (scanner == null && advertiser == null) throw new IllegalStateException("Bluetooth LE is unavailable on this device.");
        final int session = ++generation;
        active = true;
        try {
            if (advertiser != null) startServer(manager, session);
            if (scanner != null) startScan(session);
        } catch (RuntimeException failed) {
            stop();
            throw failed;
        }
        publish(null);
        monitor(session);
    }

    private void monitor(int session) {
        handler.postDelayed(() -> {
            if (!current(session)) return;
            try {
                if (!adapter.isEnabled()) {
                    stop();
                    publish("Bluetooth was turned off.");
                    return;
                }
            } catch (SecurityException revoked) {
                stop();
                publish("Nearby devices permission was revoked.");
                return;
            }
            monitor(session);
        }, 4000);
    }

    private boolean current(int session) { return active && generation == session; }

    void stop() {
        if (!active) return;
        active = false;
        generation++;
        try { if (scanner != null && scanCallback != null) scanner.stopScan(scanCallback); } catch (RuntimeException ignored) {}
        try { if (advertiser != null && advertiseCallback != null) advertiser.stopAdvertising(advertiseCallback); } catch (RuntimeException ignored) {}
        for (Link link : outgoing.values()) closeGatt(link.gatt);
        try { if (server != null) server.close(); } catch (RuntimeException ignored) {}
        outgoing.clear();
        incoming.clear();
        retry.clear();
        server = null;
        serverData = null;
        scanCallback = null;
        advertiseCallback = null;
        pendingNotification = null;
        publish(null);
    }

    private void startScan(int session) {
        scanCallback = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult result) {
                handler.post(() -> { if (current(session)) consider(result.getDevice(), session); });
            }
            @Override public void onScanFailed(int errorCode) {
                handler.post(() -> { if (current(session)) publish("Couldn’t scan for nearby Bluetooth devices (" + errorCode + ")."); });
            }
        };
        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE)).build();
        ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER).build();
        scanner.startScan(Collections.singletonList(filter), settings, scanCallback);
    }

    private void consider(BluetoothDevice device, int session) {
        String address = device.getAddress();
        if (outgoing.size() >= MAX_OUTBOUND_LINKS || totalLinks() >= MAX_LINKS
            || outgoing.containsKey(address) || incoming.containsKey(address)) return;
        if (retry.getOrDefault(address, 0L) > SystemClock.elapsedRealtime()) return;
        Link link = new Link(device, true);
        outgoing.put(address, link);
        try {
            link.gatt = device.connectGatt(context, false, centralCallbacks(link, session), BluetoothDevice.TRANSPORT_LE);
            if (link.gatt == null) discard(link);
        } catch (RuntimeException ignored) {
            discard(link);
        }
        handler.postDelayed(() -> { if (liveCentral(link, session) && !link.ready()) discard(link); }, LINK_TIMEOUT_MS);
    }

    private boolean liveCentral(Link link, int session) {
        return current(session) && outgoing.get(link.device.getAddress()) == link;
    }

    private BluetoothGattCallback centralCallbacks(Link link, int session) {
        return new BluetoothGattCallback() {
            @Override public void onConnectionStateChange(BluetoothGatt gatt, int status, int state) {
                handler.post(() -> {
                    if (!liveCentral(link, session)) { closeGatt(gatt); return; }
                    if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) { discard(link); return; }
                    if (state != BluetoothProfile.STATE_CONNECTED) return;
                    try {
                        if (!gatt.requestMtu(517)) discover(link, session);
                        else handler.postDelayed(() -> discover(link, session), 3000);
                    } catch (RuntimeException ex) { discard(link); }
                });
            }
            @Override public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
                handler.post(() -> {
                    if (!liveCentral(link, session)) return;
                    if (status == BluetoothGatt.GATT_SUCCESS) { link.mtu = mtu; if (link.subscribed) publish(null); }
                    discover(link, session);
                });
            }
            @Override public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                handler.post(() -> {
                    if (!liveCentral(link, session)) return;
                    try {
                        BluetoothGattService service = gatt.getService(SERVICE);
                        link.data = service == null ? null : service.getCharacteristic(DATA);
                        BluetoothGattDescriptor descriptor = link.data == null ? null : link.data.getDescriptor(CCCD);
                        if (status != BluetoothGatt.GATT_SUCCESS || descriptor == null ||
                            !gatt.setCharacteristicNotification(link.data, true) || !subscribe(gatt, descriptor)) discard(link);
                    } catch (RuntimeException ex) { discard(link); }
                });
            }
            @Override public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
                handler.post(() -> {
                    if (!liveCentral(link, session) || !CCCD.equals(descriptor.getUuid())) return;
                    if (status != BluetoothGatt.GATT_SUCCESS) { discard(link); return; }
                    link.subscribed = true;
                    publish(null);
                });
            }
            @Override public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
                if (DATA.equals(characteristic.getUuid())) centralReceive(link, session, value);
            }
            @SuppressWarnings("deprecation")
            @Override public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
                if (Build.VERSION.SDK_INT < 33 && DATA.equals(characteristic.getUuid())) centralReceive(link, session, characteristic.getValue());
            }
            @Override public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
                handler.post(() -> {
                    if (!liveCentral(link, session) || !link.writing || !DATA.equals(characteristic.getUuid())) return;
                    link.writing = false;
                    if (status != BluetoothGatt.GATT_SUCCESS) { discard(link); return; }
                    if (link.queued.peekFirst() != null) link.queued.removeFirst();
                    drainCentral(link);
                });
            }
        };
    }

    private void discover(Link link, int session) {
        if (!liveCentral(link, session) || link.discoveryStarted) return;
        link.discoveryStarted = true;
        try { if (!link.gatt.discoverServices()) discard(link); }
        catch (RuntimeException ex) { discard(link); }
    }

    @SuppressWarnings("deprecation")
    private boolean subscribe(BluetoothGatt gatt, BluetoothGattDescriptor descriptor) {
        if (Build.VERSION.SDK_INT >= 33) {
            return gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS;
        }
        descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        return gatt.writeDescriptor(descriptor);
    }

    private void centralReceive(Link link, int session, byte[] data) {
        if (data == null || data.length > 512 || data.length < 22) return;
        byte[] wire = data.clone();
        handler.post(() -> { if (liveCentral(link, session)) deliver(link, wire); });
    }

    private void startServer(BluetoothManager manager, int session) {
        server = manager.openGattServer(context, serverCallbacks(session));
        if (server == null) return;
        BluetoothGattService service = new BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        serverData = new BluetoothGattCharacteristic(DATA,
            BluetoothGattCharacteristic.PROPERTY_READ | BluetoothGattCharacteristic.PROPERTY_WRITE |
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ | BluetoothGattCharacteristic.PERMISSION_WRITE);
        serverData.addDescriptor(new BluetoothGattDescriptor(CCCD, BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE));
        service.addCharacteristic(serverData);
        if (!server.addService(service)) { server.close(); server = null; serverData = null; }
    }

    private void advertise(int session) {
        if (!current(session) || server == null || advertiseCallback != null) return;
        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartFailure(int code) {
                handler.post(() -> { if (current(session)) publish("Bluetooth advertising is unavailable (" + code + "). Scanning can still work."); });
            }
        };
        try {
            AdvertiseSettings settings = new AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).setConnectable(true).build();
            AdvertiseData payload = new AdvertiseData.Builder().addServiceUuid(new ParcelUuid(SERVICE)).build();
            advertiser.startAdvertising(settings, payload, advertiseCallback);
        } catch (RuntimeException ex) { publish("Bluetooth advertising could not start. Scanning can still work."); }
    }

    private BluetoothGattServerCallback serverCallbacks(int session) {
        return new BluetoothGattServerCallback() {
            @Override public void onServiceAdded(int status, BluetoothGattService service) {
                handler.post(() -> {
                    if (!current(session)) return;
                    if (status == BluetoothGatt.GATT_SUCCESS && SERVICE.equals(service.getUuid())) advertise(session);
                    else publish("Couldn’t publish the Bluetooth chat service.");
                });
            }
            @Override public void onConnectionStateChange(BluetoothDevice device, int status, int state) {
                handler.post(() -> {
                    if (!current(session)) return;
                    if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) {
                        Link link = incoming.get(device.getAddress());
                        if (link != null) discard(link);
                    } else if (state == BluetoothProfile.STATE_CONNECTED) {
                        if (incoming.containsKey(device.getAddress())) return;
                        if (totalLinks() >= MAX_LINKS) {
                            try { server.cancelConnection(device); } catch (RuntimeException ignored) {}
                            return;
                        }
                        Link link = new Link(device, false);
                        incoming.put(device.getAddress(), link);
                        handler.postDelayed(() -> {
                            if (current(session) && incoming.get(device.getAddress()) == link && !link.ready()) discard(link);
                        }, LINK_TIMEOUT_MS);
                    }
                });
            }
            @Override public void onMtuChanged(BluetoothDevice device, int mtu) {
                handler.post(() -> {
                    if (!current(session)) return;
                    Link link = incoming.get(device.getAddress());
                    if (link != null) { link.mtu = mtu; if (link.subscribed) publish(null); }
                });
            }
            @Override public void onDescriptorWriteRequest(BluetoothDevice dev, int req, BluetoothGattDescriptor descriptor,
                    boolean prepared, boolean respond, int offset, byte[] value) {
                byte[] input = value == null ? new byte[0] : value.clone();
                handler.post(() -> {
                    if (!current(session)) return;
                    Link link = incoming.get(dev.getAddress());
                    boolean enable = Arrays.equals(input, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    boolean disable = Arrays.equals(input, BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
                    boolean okay = link != null && CCCD.equals(descriptor.getUuid()) && !prepared && offset == 0 && (enable || disable);
                    if (okay) {
                        link.subscribed = enable;
                        if (!enable) link.queued.clear();
                        publish(null);
                    }
                    if (respond) reply(dev, req, okay, null);
                });
            }
            @Override public void onDescriptorReadRequest(BluetoothDevice dev, int req, int offset, BluetoothGattDescriptor descriptor) {
                handler.post(() -> {
                    if (!current(session)) return;
                    Link link = incoming.get(dev.getAddress());
                    reply(dev, req, offset == 0 && CCCD.equals(descriptor.getUuid()), link != null && link.subscribed ?
                        BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
                });
            }
            @Override public void onCharacteristicReadRequest(BluetoothDevice dev, int req, int offset, BluetoothGattCharacteristic c) {
                handler.post(() -> { if (current(session)) reply(dev, req, offset == 0 && DATA.equals(c.getUuid()), new byte[0]); });
            }
            @Override public void onCharacteristicWriteRequest(BluetoothDevice dev, int req, BluetoothGattCharacteristic c,
                    boolean prepared, boolean respond, int offset, byte[] value) {
                byte[] wire = value != null && value.length <= 512 ? value.clone() : null;
                handler.post(() -> {
                    if (!current(session)) return;
                    Link link = incoming.get(dev.getAddress());
                    boolean okay = link != null && DATA.equals(c.getUuid()) && !prepared && offset == 0 &&
                        wire != null && wire.length >= 22 && wire.length <= link.maxBytes();
                    if (respond) reply(dev, req, okay, null);
                    if (okay) deliver(link, wire);
                });
            }
            @Override public void onExecuteWrite(BluetoothDevice dev, int req, boolean execute) {
                handler.post(() -> { if (current(session)) reply(dev, req, !execute, null); });
            }
            @Override public void onNotificationSent(BluetoothDevice device, int status) {
                handler.post(() -> {
                    if (!current(session) || pendingNotification == null || !device.equals(pendingNotification.device)) return;
                    Link link = pendingNotification;
                    pendingNotification = null;
                    if (status == BluetoothGatt.GATT_SUCCESS) link.queued.pollFirst();
                    else discard(link);
                    drainPeripheral();
                });
            }
        };
    }

    private void reply(BluetoothDevice device, int req, boolean ok, byte[] value) {
        try { if (server != null) server.sendResponse(device, req, ok ? BluetoothGatt.GATT_SUCCESS : BluetoothGatt.GATT_FAILURE, 0, value); }
        catch (RuntimeException ignored) {}
    }

    boolean enqueue(String id, List<byte[]> frames) {
        if (!active) return false;
        for (Map<String, Link> map : Arrays.asList(outgoing, incoming)) for (Link link : map.values()) {
            if (!link.id.equals(id) || !link.ready()) continue;
            if (link.queued.size() + frames.size() > MAX_QUEUE) return false;
            for (byte[] frame : frames) if (frame.length > link.maxBytes()) return false;
            link.queued.addAll(frames);
            if (link.isCentral) drainCentral(link);
            else drainPeripheral();
            return true;
        }
        return false;
    }

    @SuppressWarnings("deprecation")
    private void drainCentral(Link link) {
        if (!link.ready() || link.writing || link.queued.isEmpty()) return;
        byte[] data = link.queued.peekFirst();
        try {
            int type = (link.data.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0 ?
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
            boolean started;
            if (Build.VERSION.SDK_INT >= 33) {
                started = link.gatt.writeCharacteristic(link.data, data, type) == BluetoothStatusCodes.SUCCESS;
            } else {
                link.data.setWriteType(type);
                link.data.setValue(data);
                started = link.gatt.writeCharacteristic(link.data);
            }
            if (!started) { discard(link); return; }
        } catch (RuntimeException ex) { discard(link); return; }
        link.writing = true;
        int attempt = ++link.writeAttempt;
        handler.postDelayed(() -> { if (link.writing && link.writeAttempt == attempt && outgoing.containsValue(link)) discard(link); }, 4000);
    }

    @SuppressWarnings("deprecation")
    private void drainPeripheral() {
        if (server == null || serverData == null || pendingNotification != null) return;
        Link selected = null;
        for (Link link : incoming.values()) if (link.ready() && !link.queued.isEmpty()) { selected = link; break; }
        if (selected == null) return;
        Link link = selected;
        byte[] wire = link.queued.peekFirst();
        try {
            boolean sent;
            if (Build.VERSION.SDK_INT >= 33) {
                sent = server.notifyCharacteristicChanged(link.device, serverData, false, wire) == BluetoothStatusCodes.SUCCESS;
            } else {
                serverData.setValue(wire);
                sent = server.notifyCharacteristicChanged(link.device, serverData, false);
            }
            if (!sent) { discard(link); return; }
        } catch (RuntimeException ex) { discard(link); return; }
        pendingNotification = link;
        int attempt = ++notificationAttempt;
        handler.postDelayed(() -> {
            if (pendingNotification == link && notificationAttempt == attempt) { discard(link); drainPeripheral(); }
        }, 4000);
    }

    private void deliver(Link link, byte[] wire) {
        long now = SystemClock.elapsedRealtime();
        if (now - link.rateWindow >= 1000) { link.rateWindow = now; link.received = 0; }
        if (link.received++ < 72) observer.receive(link.id, wire);
    }

    private void discard(Link link) {
        String address = link.device.getAddress();
        if (link.isCentral) {
            if (!outgoing.remove(address, link)) return;
            closeGatt(link.gatt);
            retry.put(address, SystemClock.elapsedRealtime() + RETRY_DELAY_MS);
            if (retry.size() > 80) retry.remove(retry.keySet().iterator().next());
        } else {
            if (!incoming.remove(address, link)) return;
            if (pendingNotification == link) pendingNotification = null;
            try { if (server != null) server.cancelConnection(link.device); } catch (RuntimeException ignored) {}
        }
        link.queued.clear();
        publish(null);
        if (!link.isCentral) handler.post(this::drainPeripheral);
    }

    private int totalLinks() { return outgoing.size() + incoming.size(); }

    private static void closeGatt(BluetoothGatt gatt) {
        if (gatt == null) return;
        try { gatt.disconnect(); } catch (RuntimeException ignored) {}
        try { gatt.close(); } catch (RuntimeException ignored) {}
    }

    private void publish(String error) {
        List<LinkInfo> links = new ArrayList<>();
        for (Map<String, Link> map : Arrays.asList(outgoing, incoming)) {
            for (Link link : map.values()) if (link.ready()) links.add(new LinkInfo(link));
        }
        observer.changed(active, error, links);
    }
}
