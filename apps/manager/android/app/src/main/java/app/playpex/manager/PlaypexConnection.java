package app.playpex.manager;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.URI;
import java.net.URLEncoder;

/**
 * The phone's connection, for the picker and for the dashboards it opens:
 *
 *  - network() and the event "network": is there a network at all (connected), and is one of them a
 *    local one (Wi-Fi or Ethernet), where Playpex servers live. A Wi-Fi without internet counts: the
 *    server is still on it.
 *  - A server's dashboard that can't load (no network, the server stopped, another Wi-Fi) shows the
 *    picker's "can't reach" screen instead of Chromium's error page: https://localhost/#offline=<url>.
 *  - While a dashboard is shown and the network changes (Wi-Fi lost, switched to mobile data), its server
 *    is asked again (GET /api/v1/server) after a moment; no answer → the same screen. It goes back to the
 *    page by itself once the server answers again.
 *  - wifiSettings() opens Android's Wi-Fi panel.
 */
@CapacitorPlugin(name = "PlaypexConnection")
public class PlaypexConnection extends Plugin {
    /** after a network change, the time networks take to settle (a switch is a loss then a gain) */
    private static final int SETTLE_MS = 2500;

    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback callback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable checkPage = this::checkPage;
    private boolean connected;
    private boolean local;

    @Override
    public void load() {
        Bridge bridge = getBridge();
        bridge.setWebViewClient(new Client(bridge));
        connectivity = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) {
            connected = true;
            local = true;
            return;
        }
        measure();
        callback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                changed();
            }

            @Override
            public void onLost(Network network) {
                changed();
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                changed();
            }
        };
        // every network, not only the default one: a VPN over mobile data hides the Wi-Fi beneath it
        NetworkRequest any = new NetworkRequest.Builder().removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build();
        connectivity.registerNetworkCallback(any, callback);
    }

    @PluginMethod
    public void network(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void wifiSettings(PluginCall call) {
        Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? new Intent(Settings.Panel.ACTION_WIFI)
            : new Intent(Settings.ACTION_WIFI_SETTINGS);
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No Wi-Fi settings on this device");
        }
    }

    @Override
    protected void handleOnDestroy() {
        main.removeCallbacks(checkPage);
        if (connectivity != null && callback != null) {
            try {
                connectivity.unregisterNetworkCallback(callback);
            } catch (Exception e) {
                // not registered
            }
        }
    }

    // ── the network ───────────────────────────────────────────────────────────

    /** Called on ConnectivityManager's thread */
    private void changed() {
        boolean wasConnected = connected;
        boolean wasLocal = local;
        measure();
        if (connected != wasConnected || local != wasLocal) {
            notifyListeners("network", state(), true);
        }
        // whatever changed, a dashboard on screen gets its server asked again once things settle
        main.removeCallbacks(checkPage);
        main.postDelayed(checkPage, SETTLE_MS);
    }

    @SuppressWarnings("deprecation")
    private synchronized void measure() {
        boolean anyNetwork = false;
        boolean anyLocal = false;
        for (Network n : connectivity.getAllNetworks()) {
            NetworkCapabilities caps = connectivity.getNetworkCapabilities(n);
            if (caps == null) {
                continue;
            }
            anyNetwork = true;
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                anyLocal = true;
            }
        }
        connected = anyNetwork;
        local = anyLocal;
    }

    private synchronized JSObject state() {
        JSObject s = new JSObject();
        s.put("connected", connected);
        s.put("local", local);
        return s;
    }

    // ── the page shown ────────────────────────────────────────────────────────

    private boolean isOurs(String url) {
        return url == null || url.startsWith(getBridge().getLocalUrl());
    }

    private void showOffline(WebView web, String url) {
        try {
            web.loadUrl(getBridge().getLocalUrl() + "/#offline=" + URLEncoder.encode(url, "UTF-8"));
        } catch (Exception e) {
            web.loadUrl(getBridge().getLocalUrl() + "/#offline");
        }
    }

    /** On the main thread: is the dashboard on screen still reachable? */
    private void checkPage() {
        WebView web = getBridge().getWebView();
        String url = web.getUrl();
        if (isOurs(url)) {
            return;   // the picker follows the "network" event itself
        }
        String origin;
        try {
            URI u = new URI(url);
            origin = u.getScheme() + "://" + u.getRawAuthority();
        } catch (Exception e) {
            return;
        }
        new Thread(() -> {
            boolean answers = PlaypexDiscovery.check(origin, null, "manual") != null;
            if (!answers) {
                main.post(() -> {
                    // still the same page (it may have been left meanwhile)
                    if (url.equals(web.getUrl())) {
                        showOffline(web, url);
                    }
                });
            }
        }, "playpex-connection-check").start();
    }

    /** Capacitor's client, with a page that fails to load sent to the "can't reach" screen */
    private final class Client extends BridgeWebViewClient {
        Client(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            String url = request.getUrl().toString();
            if (request.isForMainFrame() && !isOurs(url)) {
                showOffline(view, url);
            }
        }
    }
}
