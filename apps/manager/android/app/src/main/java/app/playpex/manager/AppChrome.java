package app.playpex.manager;

import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * What a browser does for a page and Capacitor's WebView doesn't:
 *
 *  - Full screen: a page's requestFullscreen() (the player's button, a double tap) shows the page's
 *    full-screen element over everything, hides the status and navigation bars and turns to landscape.
 *    Capacitor's BridgeWebChromeClient refuses it (it calls onCustomViewHidden() at once).
 *  - Back: leaves full screen, else closes the page's open dialog, sheet or menu (the Escape key, as on
 *    a computer), else goes back a page; on the first page the app goes to the background instead of
 *    closing.
 */
final class AppChrome {
    // Is a dialog, sheet, menu or list open (Radix marks them with these roles), or are items selected
    // (the dashboard's [data-selecting], a phone list's long-press selection)? Then Escape closes it.
    private static final String CLOSE_TOP =
        "(function () {" +
        "  var open = document.querySelector('[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-selecting]');" +
        "  if (!open) return 'none';" +
        "  var target = document.activeElement || document.body;" +
        "  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));" +
        "  return 'closed';" +
        "})()";

    private final AppCompatActivity activity;
    private final WebView web;
    private View fullscreen;
    private android.webkit.WebChromeClient.CustomViewCallback leave;
    private int orientationBefore;

    private AppChrome(AppCompatActivity activity, Bridge bridge) {
        this.activity = activity;
        this.web = bridge.getWebView();
    }

    static void attach(AppCompatActivity activity, Bridge bridge) {
        AppChrome chrome = new AppChrome(activity, bridge);
        bridge.getWebView().setWebChromeClient(chrome.new Client(bridge));
        activity.getOnBackPressedDispatcher().addCallback(activity, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                chrome.back();
            }
        });
    }

    private void back() {
        if (fullscreen != null) {
            exitFullscreen();
            return;
        }
        // the "can't reach" screen (PlaypexConnection): going back would only load the unreachable page again
        String url = web.getUrl();
        if (url != null && url.contains("#offline")) {
            activity.moveTaskToBack(true);
            return;
        }
        web.evaluateJavascript(CLOSE_TOP, (result) -> {
            if ("\"closed\"".equals(result)) {
                return;
            }
            if (web.canGoBack()) {
                web.goBack();
            } else {
                activity.moveTaskToBack(true);
            }
        });
    }

    private void exitFullscreen() {
        if (leave != null) {
            leave.onCustomViewHidden();   // the page leaves full screen, then onHideCustomView() below runs
        } else {
            hide();
        }
    }

    private void show(View view, android.webkit.WebChromeClient.CustomViewCallback callback) {
        if (fullscreen != null) {
            callback.onCustomViewHidden();
            return;
        }
        fullscreen = view;
        leave = callback;
        orientationBefore = activity.getRequestedOrientation();
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        view.setBackgroundColor(Color.BLACK);
        decor.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), decor);
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.systemBars());
        // a video is wider than it is tall: either landscape, as the phone is held
        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
    }

    private void hide() {
        if (fullscreen == null) {
            return;
        }
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        decor.removeView(fullscreen);
        fullscreen = null;
        leave = null;
        WindowCompat.getInsetsController(activity.getWindow(), decor).show(WindowInsetsCompat.Type.systemBars());
        activity.setRequestedOrientation(orientationBefore);
    }

    /** Capacitor's client (file choosers, permissions, console…) with full screen that works */
    private final class Client extends BridgeWebChromeClient {
        Client(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            show(view, callback);
        }

        @Override
        public void onHideCustomView() {
            hide();
        }
    }
}
