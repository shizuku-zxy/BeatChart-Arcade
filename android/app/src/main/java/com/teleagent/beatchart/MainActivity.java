package com.teleagent.beatchart;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * v1.5.2：防御系统"显示大小/字体大小"缩放——Android WebView 默认跟随系统
     * fontScale，textZoom ≠ 100% 时页面布局与触点坐标系会出现偏差。
     * v1.6.1：沉浸式全屏——隐藏状态栏/导航栏（游戏内容本就全屏绘制，
     * 系统栏悬浮其上遮挡内容导致"界面偏一侧"的观感），从边缘划入可临时唤出。
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            WebView wv = getBridge() != null ? getBridge().getWebView() : null;
            if (wv != null) {
                WebSettings settings = wv.getSettings();
                settings.setTextZoom(100);
            }
        } catch (Exception e) {
            // 防御性：任何异常都不阻断游戏启动
        }
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 沉浸式在焦点恢复时重新应用（权限弹窗/通知面板拉起后系统栏会复原）
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        try {
            View decor = getWindow().getDecorView();
            if (Build.VERSION.SDK_INT >= 30) {
                getWindow().setDecorFitsSystemWindows(false);
                WindowInsetsController c = decor.getWindowInsetsController();
                if (c != null) {
                    c.hide(WindowInsets.Type.systemBars());
                    c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            }
        } catch (Exception e) {
            // 防御性：任何异常都不阻断游戏启动
        }
    }
}
