package com.agnostr.app.nearby;

import android.Manifest;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
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

    @PluginMethod
    public void capabilities(PluginCall call) {
        Context context = getContext();
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        boolean supported = context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
            && manager != null && manager.getAdapter() != null;
        call.resolve(new JSObject().put("supported", supported));
    }

    @PluginMethod
    public void start(PluginCall call) {
        String permission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "nearby" : "legacy";
        if (getPermissionState(permission) != PermissionState.GRANTED) {
            requestPermissionForAlias(permission, call, "permissionResult");
            return;
        }
        startMesh(call);
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        String permission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "nearby" : "legacy";
        if (getPermissionState(permission) != PermissionState.GRANTED) {
            call.reject("Allow Nearby devices in Android settings to use Bluetooth chat.");
            return;
        }
        startMesh(call);
    }

    private void startMesh(PluginCall call) {
        ui.post(() -> {
            try {
                mesh.start();
                call.resolve();
            } catch (RuntimeException failure) {
                call.reject(failure.getMessage() == null ? "Bluetooth chat could not start." : failure.getMessage());
            }
        });
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
            if (mesh != null) mesh.stop();
            call.resolve();
        });
    }

    @Override
    protected void handleOnStop() {
        ui.post(() -> { if (mesh != null) mesh.stop(); });
    }

    @Override
    protected void handleOnDestroy() {
        ui.post(() -> { if (mesh != null) mesh.stop(); });
    }
}
