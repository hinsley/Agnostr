package com.agnostr.app;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.agnostr.app.nearby.NearbyPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NearbyPlugin.class);
        super.onCreate(savedInstanceState);
        WindowInsetsControllerCompat systemBars = WindowCompat.getInsetsController(
            getWindow(), getWindow().getDecorView()
        );
        systemBars.setAppearanceLightStatusBars(false);
        systemBars.setAppearanceLightNavigationBars(false);
    }
}
