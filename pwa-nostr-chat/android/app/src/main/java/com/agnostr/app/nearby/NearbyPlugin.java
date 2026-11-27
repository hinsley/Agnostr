package com.agnostr.app.nearby;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;

@CapacitorPlugin(name = "AgnostrNearby", permissions = {
    @Permission(alias = "nearby", strings = {
        Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.BLUETOOTH_ADVERTISE
    }),
    @Permission(alias = "legacy", strings = { Manifest.permission.ACCESS_FINE_LOCATION })
})
public class NearbyPlugin extends Plugin {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private GattMesh mesh;
    private PluginCall pendingPermission;

    @Override
    public void load() {
        mesh = new GattMesh(getContext().getApplicationContext(), new GattMesh.Observer() {
            @Override public void changed(boolean active, String error, List<GattMesh.LinkInfo> links) {
                JSArray items = new JSArray();
                for (GattMesh.LinkInfo link : links) {
                    items.put(new JSObject().put("id", link.id).put("maxBytes", link.maxBytes));
                }
                JSObject event = new JSObject().put("active", active).put("links", items);
                if (error != null) event.put("error", error);
                notifyListeners("state", event);
            }
            @Override public void receive(String id, byte[] wire) {
                notifyListeners("frame", new JSObject().put("link", id)
                    .put("wire", Base64.encodeToString(wire, Base64.NO_WRAP)));
            }
        });
    }

    private String permissionAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "nearby" : "legacy";
    }

    private String permissionHint() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? "Allow Nearby devices in Android settings to use Bluetooth Mesh."
            : "Allow location permission in Android settings to discover Bluetooth Mesh peers.";
    }

    private boolean foreground() {
        return getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED);
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        ui.post(() -> {
            Context context = getContext();
            BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            boolean supported = context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
                && adapter != null;
            JSObject result = new JSObject().put("supported", supported).put("ready", false);
            if (supported && foreground()) {
                try {
                    if (getPermissionState(permissionAlias()) != PermissionState.GRANTED) {
                        result.put("error", permissionHint());
                    } else if (!adapter.isEnabled()) {
                        result.put("error", "Turn on Bluetooth in Android settings.");
                    } else {
                        result.put("ready", true);
                    }
                } catch (SecurityException revoked) {
                    result.put("error", permissionHint());
                }
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        ui.post(() -> {
            if (!foreground()) { call.reject("Bluetooth Mesh starts when Agnostr is open."); return; }
            String permission = permissionAlias();
            if (getPermissionState(permission) != PermissionState.GRANTED) {
                if (!Boolean.TRUE.equals(call.getBoolean("requestPermission", true))) {
                    call.reject(permissionHint());
                } else if (pendingPermission != null) {
                    call.reject("Android is already asking for Bluetooth permission.");
                } else {
                    pendingPermission = call;
                    requestPermissionForAlias(permission, call, "permissionResult");
                }
                return;
            }
            startMesh(call);
        });
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        ui.post(() -> {
            if (pendingPermission != call) return;
            pendingPermission = null;
            if (getPermissionState(permissionAlias()) != PermissionState.GRANTED) {
                call.reject(permissionHint());
                return;
            }
            startMesh(call);
        });
    }

    private void startMesh(PluginCall call) {
        if (!foreground()) { call.reject("Bluetooth Mesh starts when Agnostr is open."); return; }
        try {
            mesh.start();
            call.resolve();
        } catch (RuntimeException failure) {
            call.reject(failure.getMessage() == null ? "Bluetooth chat could not start." : failure.getMessage());
        }
    }

    private void stopMesh() {
        if (pendingPermission != null) {
            PluginCall canceled = pendingPermission;
            pendingPermission = null;
            canceled.reject("Bluetooth Mesh start canceled.");
        }
        if (mesh != null) mesh.stop();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String link = call.getString("link");
        JSArray input = call.getArray("frames");
        if (link == null || link.length() > 40 || input == null || input.length() < 1 || input.length() > 48) {
            call.reject("Invalid Bluetooth frame batch.");
            return;
        }
        ArrayList<byte[]> frames = new ArrayList<>();
        try {
            for (int i = 0; i < input.length(); i++) {
                String packed = input.getString(i);
                if (packed.length() < 30 || packed.length() > 684) throw new IllegalArgumentException();
                byte[] wire = Base64.decode(packed, Base64.NO_WRAP);
                if (wire.length < 22 || wire.length > 512) throw new IllegalArgumentException();
                frames.add(wire);
            }
        } catch (IllegalArgumentException | JSONException invalid) {
            call.reject("Invalid Bluetooth frame encoding.");
            return;
        }
        ui.post(() -> call.resolve(new JSObject().put("accepted", mesh.enqueue(link, frames))));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ui.post(() -> {
            stopMesh();
            call.resolve();
        });
    }

    @Override
    protected void handleOnStop() {
        ui.post(this::stopMesh);
    }

    @Override
    protected void handleOnDestroy() {
        ui.post(this::stopMesh);
    }
}
