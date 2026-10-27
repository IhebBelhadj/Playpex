package app.playpex.manager;

import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;

/**
 * Swipe down from the top to reload, on every page the app shows (the picker and the servers'
 * dashboards): the WebView is wrapped in Android's SwipeRefreshLayout.
 *
 * A pull only reloads when it starts at the very top of the page, outside any list that is itself
 * scrolled, and with no dialog or sheet open: a script added to each page reports that on every
 * touch (window.PlaypexPull.set), so scrolling a list back up or dragging a sheet never reloads.
 */
final class PullToReload {
    private static final int GOLD = 0xFFE0A93B;     // the logo's gold: what moves
    private static final int RAISED = 0xFF1F1F1F;  // one step above the black ground

    // Runs at the start of each touch, before the pull is recognised
    private static final String SCRIPT =
        "(function () {" +
        "  if (window.__playpexPull) return; window.__playpexPull = true;" +
        "  function scrolled(el) {" +
        "    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {" +
        "      if (el.scrollTop > 0) return true;" +
        "    }" +
        "    return false;" +
        "  }" +
        "  document.addEventListener('touchstart', function (e) {" +
        "    var open = document.querySelector('[role=dialog], [role=alertdialog]');" +
        "    var top = (window.scrollY || document.documentElement.scrollTop || 0) <= 0;" +
        "    try { PlaypexPull.set(top && !open && !scrolled(e.target)); } catch (_) {}" +
        "  }, { capture: true, passive: true });" +
        "})();";

    private volatile boolean allowed = true;

    static void attach(BridgeActivityHost host) {
        new PullToReload().wrap(host.bridge());
    }

    /** What MainActivity gives: its Capacitor bridge */
    interface BridgeActivityHost {
        Bridge bridge();
    }

    private void wrap(Bridge bridge) {
        WebView web = bridge.getWebView();
        ViewGroup parent = (ViewGroup) web.getParent();
        if (parent == null) {
            return;
        }
        int index = parent.indexOfChild(web);
        ViewGroup.LayoutParams params = web.getLayoutParams();
        parent.removeView(web);

        SwipeRefreshLayout swipe = new SwipeRefreshLayout(web.getContext());
        swipe.setColorSchemeColors(GOLD);
        swipe.setProgressBackgroundColorSchemeColor(RAISED);
        swipe.addView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        parent.addView(swipe, index, params);

        // "the child can scroll up" = don't start a pull
        swipe.setOnChildScrollUpCallback((layout, child) -> !allowed || web.getScrollY() > 0 || web.canScrollVertically(-1));
        swipe.setOnRefreshListener(() -> {
            web.reload();
            // a page that never finishes loading must not keep the spinner forever
            swipe.postDelayed(() -> swipe.setRefreshing(false), 10000);
        });

        web.addJavascriptInterface(this, "PlaypexPull");
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                swipe.setRefreshing(false);
                allowed = true;
                view.evaluateJavascript(SCRIPT, null);
            }

            @Override
            public void onReceivedError(WebView view) {
                swipe.setRefreshing(false);
            }
        });
    }

    /** From the page's script: may a pull that starts with this touch reload? */
    @JavascriptInterface
    public void set(boolean value) {
        allowed = value;
    }
}
