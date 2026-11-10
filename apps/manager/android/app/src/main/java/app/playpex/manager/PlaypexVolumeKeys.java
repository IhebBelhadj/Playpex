package app.playpex.manager;

import android.view.KeyEvent;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The phone's volume buttons as a remote's: while the dashboard's remote control page asks for them
 * (capture({on: true}), apps/dashboard/src/pages/remote.tsx), a press doesn't change the phone's volume:
 * it goes to the page as a `key` event { key: 'up' | 'down', phase: 'down' | 'up', repeat }, which sends
 * it to the TV. Only on the page that asked (its address when it asked): a page left without saying so
 * (a reload, another page) gets the buttons back at once. MainActivity.dispatchKeyEvent calls handle().
 */
@CapacitorPlugin(name = "PlaypexVolumeKeys")
public class PlaypexVolumeKeys extends Plugin {

    private static PlaypexVolumeKeys instance;
    /** the page that asked (WebView.getUrl() then), null: the buttons are the phone's */
    private volatile String capturedBy;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void capture(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        WebView web = getBridge().getWebView();
        web.post(() -> {
            capturedBy = on ? web.getUrl() : null;
            call.resolve();
        });
    }

    /** From MainActivity: true when the key went to the page (the phone's volume stays as it is) */
    static boolean handle(KeyEvent event) {
        int code = event.getKeyCode();
        if (code != KeyEvent.KEYCODE_VOLUME_UP && code != KeyEvent.KEYCODE_VOLUME_DOWN) return false;
        PlaypexVolumeKeys self = instance;
        if (self == null || self.capturedBy == null || self.getBridge() == null) return false;
        String url = self.getBridge().getWebView().getUrl();
        if (url == null || !url.equals(self.capturedBy)) {
            self.capturedBy = null;
            return false;
        }
        int action = event.getAction();
        if (action != KeyEvent.ACTION_DOWN && action != KeyEvent.ACTION_UP) return true;
        JSObject data = new JSObject();
        data.put("key", code == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down");
        data.put("phase", action == KeyEvent.ACTION_DOWN ? "down" : "up");
        data.put("repeat", action == KeyEvent.ACTION_DOWN && event.getRepeatCount() > 0);
        self.notifyListeners("key", data);
        return true;
    }
}
