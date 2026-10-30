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

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.net.URLEncoder;
import java.util.Collections;

/**
 * The phone's connection, for the picker and for the dashboards it opens:
 *
 *  - network() and the event "network": is there a network at all (connected), and is one of them a
 *    local one (local), where Playpex servers live: Wi-Fi, Ethernet, and also this phone's own hotspot
 *    or USB tethering (a computer on the hotspot reaches the phone, and Android doesn't list those as
 *    networks: they are read from the network interfaces, checked every few seconds). A Wi-Fi without
 *    internet counts: the server is still on it. Only a hint: whether a server answers is what counts.
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
    /** the hotspot and USB tethering send no network callbacks: their interfaces are looked at this often */
    private static final int INTERFACES_EVERY_MS = 3000;
    /** interfaces of a local network: Wi-Fi (also the hotspot: wlan1, swlan0, ap0, softap0), Ethernet, USB tethering */
    private static final String LAN_INTERFACES = "^(wlan|swlan|ap|softap|wigig|eth|rndis|usb|ncm|bt-pan).*";

    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback callback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable checkPage = this::checkPage;
    private final Runnable watchInterfaces = new Runnable() {
        @Override
        public void run() {
            new Thread(PlaypexConnection.this::changed, "playpex-interfaces").start();
            main.postDelayed(this, INTERFACES_EVERY_MS);
        }
    };
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
        main.postDelayed(watchInterfaces, INTERFACES_EVERY_MS);
    }

    @Override
    protected void handleOnPause() {
        main.removeCallbacks(watchInterfaces);
    }

    @Override
    protected void handleOnResume() {
        main.removeCallbacks(watchInterfaces);
        if (connectivity != null) {
            main.post(watchInterfaces);
        }
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
        main.removeCallbacks(watchInterfaces);
        if (connectivity != null && callback != null) {
            try {
                connectivity.unregisterNetworkCallback(callback);
            } catch (Exception e) {
                // not registered
            }
        }
    }

    // ── the network ───────────────────────────────────────────────────────────

    /** On ConnectivityManager's thread, or the interfaces' check */
    private void changed() {
        boolean wasConnected;
        boolean wasLocal;
        synchronized (this) {
            wasConnected = connected;
            wasLocal = local;
        }
        measure();
        boolean nowConnected;
        boolean nowLocal;
        synchronized (this) {
            nowConnected = connected;
            nowLocal = local;
        }
        if (nowConnected == wasConnected && nowLocal == wasLocal) {
            return;
        }
        notifyListeners("network", state(), true);
        // a dashboard on screen gets its server asked again once things settle
        main.removeCallbacks(checkPage);
        main.postDelayed(checkPage, SETTLE_MS);
    }

    @SuppressWarnings("deprecation")
    private void measure() {
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
        boolean lan = anyLocal || lanInterface();
        synchronized (this) {
            connected = anyNetwork || lan;
            local = lan;
        }
    }

    /** An interface of a local network that is up with a private IPv4 address (the hotspot, USB tethering…) */
    private static boolean lanInterface() {
        try {
            for (NetworkInterface net : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!net.isUp() || net.isLoopback() || !net.getName().matches(LAN_INTERFACES)) {
                    continue;
                }
                for (InetAddress a : Collections.list(net.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        return true;
                    }
                }
            }
        } catch (Exception e) {
            // no interfaces to read
        }
        return false;
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
