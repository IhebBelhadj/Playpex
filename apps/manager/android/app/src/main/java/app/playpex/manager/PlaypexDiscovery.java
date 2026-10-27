package app.playpex.manager;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Finds Playpex servers on the network the way Playpex TV does (docs/api/discovery.md):
 *   1. mDNS / DNS-SD: browse `_playpex._tcp` with Android's NsdManager, resolve each service
 *   2. UDP: `PLAYPEX_DISCOVER 1` to port 28471 (broadcast) every 5 s; servers answer with JSON
 * Every address is confirmed with GET /api/v1/server before it is reported (event "server"):
 * the page (https://localhost) can't read a LAN server's answers itself. probe() does the same
 * for an address a person typed.
 */
@CapacitorPlugin(name = "PlaypexDiscovery")
public class PlaypexDiscovery extends Plugin {
    private static final String TAG = "PlaypexDiscovery";
    private static final String SERVICE_TYPE = "_playpex._tcp.";
    private static final int DEFAULT_PORT = 28470;
    private static final int UDP_PORT = 28471;
    private static final String QUERY = "PLAYPEX_DISCOVER 1";
    private static final int ASK_EVERY_MS = 5000;
    private static final int TIMEOUT_MS = 3000;

    private NsdManager nsd;
    private NsdManager.DiscoveryListener browsing;
    private WifiManager.MulticastLock lock;
    private DatagramSocket udp;
    private Thread asker;
    private ExecutorService checks;
    private ExecutorService resolving;   // NsdManager resolves one service at a time (before Android 14)
    private volatile boolean running = false;
    /** server id → the URL last reported, so each server is reported once per address */
    private final Map<String, String> reported = Collections.synchronizedMap(new HashMap<>());

    @PluginMethod
    public void start(PluginCall call) {
        stopAll();
        running = true;
        reported.clear();
        checks = Executors.newFixedThreadPool(4);
        resolving = Executors.newSingleThreadExecutor();
        Context context = getContext().getApplicationContext();
        WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            // without it some devices drop the multicast (mDNS) and broadcast (UDP) answers
            lock = wifi.createMulticastLock("playpex-discovery");
            lock.setReferenceCounted(false);
            lock.acquire();
        }
        startNsd(context);
        startUdp();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopAll();
        call.resolve();
    }

    /** "192.168.1.20", "playpex.local:28470", "http://nas.local:28470/": is a Playpex server there? */
    @PluginMethod
    public void probe(PluginCall call) {
        String address = call.getString("address", "").trim();
        if (address.isEmpty()) {
            call.reject("No address");
            return;
        }
        new Thread(() -> {
            try {
                String base = baseUrl(address);
                JSObject server = check(base, null, "manual");
                if (server == null) {
                    call.reject("It isn’t a Playpex server, or it didn’t answer.");
                } else {
                    call.resolve(server);
                }
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "It didn’t answer.");
            }
        }).start();
    }

    @Override
    protected void handleOnDestroy() {
        stopAll();
    }

    // ── mDNS ──────────────────────────────────────────────────────────────────

    private void startNsd(Context context) {
        nsd = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        if (nsd == null) {
            return;
        }
        browsing = new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String type) {}

            @Override
            public void onServiceFound(NsdServiceInfo service) {
                if (running) {
                    resolving.execute(() -> resolve(service));
                }
            }

            @Override
            public void onServiceLost(NsdServiceInfo service) {}

            @Override
            public void onDiscoveryStopped(String type) {}

            @Override
            public void onStartDiscoveryFailed(String type, int code) {
                Log.w(TAG, "mDNS browse failed: " + code);
            }

            @Override
            public void onStopDiscoveryFailed(String type, int code) {}
        };
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, browsing);
        } catch (Exception e) {
            Log.w(TAG, "mDNS unavailable", e);
            browsing = null;
        }
    }

    // One at a time: the resolving executor waits for each answer before the next
    @SuppressWarnings("deprecation")
    private void resolve(NsdServiceInfo service) {
        final Object done = new Object();
        final boolean[] finished = {false};
        try {
            nsd.resolveService(service, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo info, int code) {
                    finish();
                }

                @Override
                public void onServiceResolved(NsdServiceInfo info) {
                    InetAddress host = info.getHost();
                    if (host != null && running) {
                        String id = txt(info, "id");
                        String base = "http://" + literal(host) + ":" + info.getPort();
                        checks.execute(() -> report(base, id, "mdns"));
                    }
                    finish();
                }

                private void finish() {
                    synchronized (done) {
                        finished[0] = true;
                        done.notifyAll();
                    }
                }
            });
            synchronized (done) {
                long until = System.currentTimeMillis() + 5000;
                while (!finished[0] && System.currentTimeMillis() < until) {
                    done.wait(250);
                }
            }
        } catch (Exception e) {
            Log.d(TAG, "resolve failed", e);
        }
    }

    private static String txt(NsdServiceInfo info, String key) {
        byte[] value = info.getAttributes().get(key);
        return value == null ? null : new String(value, StandardCharsets.UTF_8);
    }

    // ── UDP ───────────────────────────────────────────────────────────────────

    private void startUdp() {
        asker = new Thread(() -> {
            try {
                udp = new DatagramSocket();
                udp.setBroadcast(true);
                udp.setSoTimeout(500);
                byte[] query = QUERY.getBytes(StandardCharsets.US_ASCII);
                byte[] buffer = new byte[2048];
                long nextAsk = 0;
                while (running) {
                    if (System.currentTimeMillis() >= nextAsk) {
                        for (InetAddress target : broadcastAddresses()) {
                            try {
                                udp.send(new DatagramPacket(query, query.length, target, UDP_PORT));
                            } catch (Exception e) {
                                Log.d(TAG, "UDP query not sent to " + target, e);
                            }
                        }
                        nextAsk = System.currentTimeMillis() + ASK_EVERY_MS;
                    }
                    DatagramPacket answer = new DatagramPacket(buffer, buffer.length);
                    try {
                        udp.receive(answer);
                    } catch (SocketTimeoutException e) {
                        continue;
                    }
                    try {
                        JSONObject json = new JSONObject(new String(answer.getData(), 0, answer.getLength(), StandardCharsets.UTF_8));
                        int port = json.optInt("port", DEFAULT_PORT);
                        String base = "http://" + literal(answer.getAddress()) + ":" + port;
                        String id = json.optString("id", null);
                        checks.execute(() -> report(base, id, "udp"));
                    } catch (Exception e) {
                        Log.d(TAG, "not a Playpex answer", e);
                    }
                }
            } catch (Exception e) {
                if (running) {
                    Log.w(TAG, "UDP discovery stopped", e);
                }
            }
        }, "playpex-udp");
        asker.start();
    }

    // 255.255.255.255 and each network's own broadcast address (some routers drop the first)
    private static List<InetAddress> broadcastAddresses() {
        List<InetAddress> list = new ArrayList<>();
        try {
            list.add(InetAddress.getByName("255.255.255.255"));
            for (NetworkInterface net : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!net.isUp() || net.isLoopback()) {
                    continue;
                }
                for (InterfaceAddress a : net.getInterfaceAddresses()) {
                    if (a.getBroadcast() != null && !list.contains(a.getBroadcast())) {
                        list.add(a.getBroadcast());
                    }
                }
            }
        } catch (Exception e) {
            Log.d(TAG, "no interfaces", e);
        }
        return list;
    }

    // ── confirming an address ──────────────────────────────────────────────────

    /** Confirms `base` and reports it once per server and address */
    private void report(String base, String expectedId, String via) {
        if (!running) {
            return;
        }
        JSObject server = check(base, expectedId, via);
        if (server == null) {
            return;
        }
        String id = server.getString("id");
        String previous = reported.put(id, base);
        if (!base.equals(previous)) {
            notifyListeners("server", server);
        }
    }

    /** GET <base>/api/v1/server: the server's identity, or null when it isn't one (or not the expected one) */
    static JSObject check(String base, String expectedId, String via) {
        HttpURLConnection http = null;
        try {
            http = (HttpURLConnection) new URL(base + "/api/v1/server").openConnection();
            http.setConnectTimeout(TIMEOUT_MS);
            http.setReadTimeout(TIMEOUT_MS);
            http.setRequestProperty("Accept", "application/json");
            // no api=: the manager only opens dashboards, so any server version is fine
            http.setRequestProperty("X-Playpex-Client", "playpex-manager/0.1.0");
            if (http.getResponseCode() != 200) {
                return null;
            }
            JSONObject json = new JSONObject(read(http.getInputStream()));
            String id = json.optString("id", "");
            if (id.isEmpty() || (expectedId != null && !expectedId.isEmpty() && !expectedId.equals(id))) {
                return null;
            }
            URI uri = new URI(base);
            JSObject server = new JSObject();
            server.put("id", id);
            server.put("name", json.optString("name", "Playpex"));
            server.put("version", json.optString("version", ""));
            server.put("apiVersion", json.optInt("apiVersion", 1));
            server.put("url", base);
            server.put("address", uri.getHost());
            server.put("port", uri.getPort() > 0 ? uri.getPort() : 80);
            server.put("host", json.isNull("host") ? null : json.optString("host", null));
            server.put("via", via);
            return server;
        } catch (Exception e) {
            Log.d(TAG, "no Playpex server at " + base + ": " + e.getMessage());
            return null;
        } finally {
            if (http != null) {
                http.disconnect();
            }
        }
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0 && total < 65536) {
            out.write(buf, 0, n);
            total += n;
        }
        return out.toString("UTF-8");
    }

    /** What a person typed, as a base URL: no scheme = http, no port = 28470 */
    static String baseUrl(String address) throws Exception {
        String text = address.matches("(?i)^[a-z]+://.*") ? address : "http://" + address;
        URI uri = new URI(text);
        if (uri.getHost() == null) {
            throw new IllegalArgumentException("Not an address: " + address);
        }
        String host = uri.getHost().contains(":") && !uri.getHost().startsWith("[") ? "[" + uri.getHost() + "]" : uri.getHost();
        int port = uri.getPort() > 0 ? uri.getPort() : DEFAULT_PORT;
        return (uri.getScheme() == null ? "http" : uri.getScheme().toLowerCase()) + "://" + host + ":" + port;
    }

    /** An address as it goes in a URL ([fe80::1] for IPv6) */
    private static String literal(InetAddress address) {
        String text = address.getHostAddress();
        if (text == null) {
            return "";
        }
        int zone = text.indexOf('%');
        if (zone >= 0) {
            text = text.substring(0, zone);
        }
        return text.contains(":") ? "[" + text + "]" : text;
    }

    private void stopAll() {
        running = false;
        if (nsd != null && browsing != null) {
            try {
                nsd.stopServiceDiscovery(browsing);
            } catch (Exception e) {
                // not started or already stopped
            }
        }
        browsing = null;
        if (udp != null) {
            udp.close();
            udp = null;
        }
        if (asker != null) {
            asker.interrupt();
            asker = null;
        }
        if (checks != null) {
            checks.shutdownNow();
            checks = null;
        }
        if (resolving != null) {
            resolving.shutdownNow();
            resolving = null;
        }
        if (lock != null && lock.isHeld()) {
            lock.release();
        }
        lock = null;
    }
}
