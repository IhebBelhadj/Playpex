package app.playpex.manager;

import android.content.Context;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * show(): brings up the phone's keyboard for the field the page just focused. A WebView opens the
 * keyboard on a tap, not for a page's own focus(): the dashboard's remote control calls this when the
 * TV opens one of its text fields (a search), so typing on the phone can start at once
 * (apps/dashboard/src/components/remote-field.tsx).
 */
@CapacitorPlugin(name = "PlaypexKeyboard")
public class PlaypexKeyboard extends Plugin {

    @PluginMethod
    public void show(PluginCall call) {
        WebView web = getBridge().getWebView();
        web.post(() -> {
            web.requestFocus();
            // Android 11+: the window's insets controller; older ones: the input method manager
            WindowCompat.getInsetsController(getActivity().getWindow(), web).show(WindowInsetsCompat.Type.ime());
            InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            call.resolve();
        });
    }
}
