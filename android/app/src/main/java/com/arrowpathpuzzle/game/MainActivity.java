package com.arrowpathpuzzle.game;

import android.app.ActivityManager;
import android.graphics.Color;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int APP_SURFACE = Color.rgb(11, 12, 24);

    public final class EscapeArrowsBuild {
        @JavascriptInterface
        public boolean isDebugBuild() {
            return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        }

        @JavascriptInterface
        public long getDeviceMemoryBytes() {
            ActivityManager manager = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
            if (manager == null) return 0;
            ActivityManager.MemoryInfo memoryInfo = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(memoryInfo);
            return memoryInfo.totalMem;
        }

        @JavascriptInterface
        public void openSupportEmail(String email) {
            if (email == null || email.isEmpty()) return;
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.fromParts("mailto", email, null));
                try {
                    startActivity(intent);
                } catch (Exception ignored) {
                }
            });
        }
    }

    private void applyDarkSystemBars() {
        Window window = getWindow();
    WindowCompat.setDecorFitsSystemWindows(window, false);
    window.setStatusBarColor(APP_SURFACE);
    window.setNavigationBarColor(APP_SURFACE);
        View decor = window.getDecorView();
    decor.setBackgroundColor(APP_SURFACE);
        if (bridge != null) {
            WebView webView = bridge.getWebView();
            if (webView != null) webView.setBackgroundColor(APP_SURFACE);
        }
    int systemUi = decor.getSystemUiVisibility()
        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
    systemUi &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        | View.SYSTEM_UI_FLAG_FULLSCREEN
        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_IMMERSIVE
        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        decor.setSystemUiVisibility(systemUi);
    WindowInsetsControllerCompat insets = WindowCompat.getInsetsController(window, decor);
    insets.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_DEFAULT);
    insets.setAppearanceLightStatusBars(false);
    insets.setAppearanceLightNavigationBars(false);
    insets.show(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.navigationBars());
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().addJavascriptInterface(new EscapeArrowsBuild(), "EscapeArrowsBuild");
        }

        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        applyDarkSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyDarkSystemBars();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyDarkSystemBars();
    }
}
