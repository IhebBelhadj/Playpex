package app.playpex.mobile.device

import android.content.Context
import android.media.MediaCodecList
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL
import java.util.Collections
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Finds Playpex servers on the network (docs/api/discovery.md), ported from the Server
 * Manager's PlaypexDiscovery.java: mDNS / DNS-SD with NsdManager, and the UDP query
 * `PLAYPEX_DISCOVER 1` to port 28471 every 5 s. Every address is confirmed with
 * GET /api/v1/server (its id must match what discovery said) before the event "server".
 * Also what this phone decodes (`codecs`, for /media/{ref}/playback and PUT /devices/me).
 */
class PlaypexDeviceModule : Module() {
  private var nsd: NsdManager? = null
  private var browsing: NsdManager.DiscoveryListener? = null
  private var lock: WifiManager.MulticastLock? = null
  private var udp: DatagramSocket? = null
  private var asker: Thread? = null
  private var checks: ExecutorService? = null
  private var resolving: ExecutorService? = null  // NsdManager resolves one service at a time (before Android 14)
  @Volatile private var running = false
  /** server id → the URL last reported, so each server is reported once per address */
  private val reported = Collections.synchronizedMap(HashMap<String, String>())

  override fun definition() = ModuleDefinition {
    Name("PlaypexDevice")
    Events("server")

    Function("startDiscovery") { start() }
    Function("stopDiscovery") { stopAll() }

    /** "192.168.1.20", "playpex.local:28470", "http://nas.local:28470/": is a Playpex server there? */
    AsyncFunction("probe") { address: String, promise: Promise ->
      Thread {
        try {
          val server = check(baseUrl(address.trim()), null, "manual")
          if (server == null) promise.reject(NotAServer())
          else promise.resolve(server)
        } catch (e: Exception) {
          promise.reject(NotAServer())
        }
      }.start()
    }

    Function("codecs") { codecs() }

    OnDestroy { stopAll() }
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw IllegalStateException("No context")

  private fun start() {
    stopAll()
    running = true
    reported.clear()
    checks = Executors.newFixedThreadPool(4)
    resolving = Executors.newSingleThreadExecutor()
    val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    if (wifi != null) {
      // without it some devices drop the multicast (mDNS) and broadcast (UDP) answers
      lock = wifi.createMulticastLock("playpex-discovery").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    startNsd()
    startUdp()
  }

  // ── mDNS ──────────────────────────────────────────────────────────────────

  private fun startNsd() {
    val manager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
    nsd = manager
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(type: String) {}
      override fun onServiceFound(service: NsdServiceInfo) {
        if (running) resolving?.execute { resolve(service) }
      }
      override fun onServiceLost(service: NsdServiceInfo) {}
      override fun onDiscoveryStopped(type: String) {}
      override fun onStartDiscoveryFailed(type: String, code: Int) {
        Log.w(TAG, "mDNS browse failed: $code")
      }
      override fun onStopDiscoveryFailed(type: String, code: Int) {}
    }
    try {
      manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
      browsing = listener
    } catch (e: Exception) {
      Log.w(TAG, "mDNS unavailable", e)
    }
  }

  // One at a time: the resolving executor waits for each answer before the next
  @Suppress("DEPRECATION")
  private fun resolve(service: NsdServiceInfo) {
    val manager = nsd ?: return
    val done = Object()
    var finished = false
    try {
      manager.resolveService(service, object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, code: Int) = finish()
        override fun onServiceResolved(info: NsdServiceInfo) {
          val host = info.host
          if (host != null && running) {
            val id = info.attributes["id"]?.let { String(it, Charsets.UTF_8) }
            val base = "http://" + literal(host) + ":" + info.port
            checks?.execute { report(base, id, "mdns") }
          }
          finish()
        }
        private fun finish() = synchronized(done) {
          finished = true
          done.notifyAll()
        }
      })
      synchronized(done) {
        val until = System.currentTimeMillis() + 5000
        while (!finished && System.currentTimeMillis() < until) done.wait(250)
      }
    } catch (e: Exception) {
      Log.d(TAG, "resolve failed", e)
    }
  }

  // ── UDP ───────────────────────────────────────────────────────────────────

  private fun startUdp() {
    asker = Thread({
      try {
        val socket = DatagramSocket().apply {
          broadcast = true
          soTimeout = 500
        }
        udp = socket
        val query = QUERY.toByteArray(Charsets.US_ASCII)
        val buffer = ByteArray(2048)
        var nextAsk = 0L
        while (running) {
          if (System.currentTimeMillis() >= nextAsk) {
            for (target in broadcastAddresses()) {
              try {
                socket.send(DatagramPacket(query, query.size, target, UDP_PORT))
              } catch (e: Exception) {
                Log.d(TAG, "UDP query not sent to $target", e)
              }
            }
            nextAsk = System.currentTimeMillis() + ASK_EVERY_MS
          }
          val answer = DatagramPacket(buffer, buffer.size)
          try {
            socket.receive(answer)
          } catch (e: SocketTimeoutException) {
            continue
          }
          try {
            val json = JSONObject(String(answer.data, 0, answer.length, Charsets.UTF_8))
            val base = "http://" + literal(answer.address) + ":" + json.optInt("port", DEFAULT_PORT)
            val id = json.optString("id").ifEmpty { null }
            checks?.execute { report(base, id, "udp") }
          } catch (e: Exception) {
            Log.d(TAG, "not a Playpex answer", e)
          }
        }
      } catch (e: Exception) {
        if (running) Log.w(TAG, "UDP discovery stopped", e)
      }
    }, "playpex-udp")
    asker?.start()
  }

  // ── confirming an address ──────────────────────────────────────────────────

  /** Confirms `base` and reports it once per server and address */
  private fun report(base: String, expectedId: String?, via: String) {
    if (!running) return
    val server = check(base, expectedId, via) ?: return
    val previous = reported.put(server["id"] as String, base)
    if (base != previous) sendEvent("server", server)
  }

  private fun stopAll() {
    running = false
    browsing?.let { listener ->
      try {
        nsd?.stopServiceDiscovery(listener)
      } catch (e: Exception) {
        // not started or already stopped
      }
    }
    browsing = null
    udp?.close()
    udp = null
    asker?.interrupt()
    asker = null
    checks?.shutdownNow()
    checks = null
    resolving?.shutdownNow()
    resolving = null
    lock?.let { if (it.isHeld) it.release() }
    lock = null
  }

  // ── codecs ────────────────────────────────────────────────────────────────

  private fun codecs(): Map<String, Any> {
    val video = linkedSetOf<String>()
    val audio = linkedSetOf<String>()
    var maxHeight = 0
    for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
      if (info.isEncoder) continue
      for (type in info.supportedTypes) {
        val mime = type.lowercase()
        VIDEO[mime]?.let { name ->
          video.add(name)
          if (name == "h264" || name == "hevc") {
            try {
              val heights = info.getCapabilitiesForType(type).videoCapabilities?.supportedHeights
              if (heights != null) maxHeight = maxOf(maxHeight, heights.upper)
            } catch (e: Exception) {
              // a codec that can't describe itself
            }
          }
        }
        AUDIO[mime]?.let { audio.add(it) }
      }
    }
    return mapOf(
      "video" to video.toList(),
      "audio" to audio.toList(),
      "maxHeight" to (if (maxHeight > 0) minOf(maxHeight, 2160) else 1080)
    )
  }

  class NotAServer : CodedException("It isn’t a Playpex server, or it didn’t answer.")

  companion object {
    private const val TAG = "PlaypexDevice"
    private const val SERVICE_TYPE = "_playpex._tcp."
    private const val DEFAULT_PORT = 28470
    private const val UDP_PORT = 28471
    private const val QUERY = "PLAYPEX_DISCOVER 1"
    private const val ASK_EVERY_MS = 5000L
    private const val TIMEOUT_MS = 3000

    /** Android's MIME types → ffprobe's names (what the server's /probe answers) */
    private val VIDEO = mapOf(
      "video/avc" to "h264",
      "video/hevc" to "hevc",
      "video/x-vnd.on2.vp9" to "vp9",
      "video/av01" to "av1",
      "video/mp4v-es" to "mpeg4"
    )
    private val AUDIO = mapOf(
      "audio/mp4a-latm" to "aac",
      "audio/mpeg" to "mp3",
      "audio/opus" to "opus",
      "audio/vorbis" to "vorbis",
      "audio/flac" to "flac",
      "audio/ac3" to "ac3",
      "audio/eac3" to "eac3",
      "audio/eac3-joc" to "eac3",
      "audio/vnd.dts" to "dts",
      "audio/vnd.dts.hd" to "dts",
      "audio/true-hd" to "truehd"
    )

    /** GET <base>/api/v1/server: the server's identity, or null when it isn't one (or not the expected one) */
    fun check(base: String, expectedId: String?, via: String): Map<String, Any?>? {
      var http: HttpURLConnection? = null
      return try {
        http = URL("$base/api/v1/server").openConnection() as HttpURLConnection
        http.connectTimeout = TIMEOUT_MS
        http.readTimeout = TIMEOUT_MS
        http.setRequestProperty("Accept", "application/json")
        http.setRequestProperty("X-Playpex-Client", "playpex-mobile/0.1.0; api=2")
        if (http.responseCode != 200) return null
        val json = JSONObject(read(http.inputStream))
        val id = json.optString("id")
        if (id.isEmpty() || (!expectedId.isNullOrEmpty() && expectedId != id)) return null
        mapOf(
          "id" to id,
          "name" to json.optString("name", "Playpex"),
          "version" to json.optString("version", ""),
          "apiVersion" to json.optInt("apiVersion", 1),
          "minApiVersion" to json.optInt("minApiVersion", 1),
          "url" to base,
          "host" to (if (json.isNull("host")) null else json.optString("host").ifEmpty { null }),
          "via" to via
        )
      } catch (e: Exception) {
        Log.d(TAG, "no Playpex server at $base: ${e.message}")
        null
      } finally {
        http?.disconnect()
      }
    }

    private fun read(input: InputStream): String {
      val out = ByteArrayOutputStream()
      val buf = ByteArray(4096)
      var total = 0
      while (total < 65536) {
        val n = input.read(buf)
        if (n <= 0) break
        out.write(buf, 0, n)
        total += n
      }
      return out.toString("UTF-8")
    }

    /** What a person typed, as a base URL: no scheme = http, no port = 28470 */
    fun baseUrl(address: String): String {
      val text = if (Regex("(?i)^[a-z]+://.*").matches(address)) address else "http://$address"
      val uri = URI(text)
      val rawHost = uri.host ?: throw IllegalArgumentException("Not an address: $address")
      val host = if (rawHost.contains(":") && !rawHost.startsWith("[")) "[$rawHost]" else rawHost
      val port = if (uri.port > 0) uri.port else DEFAULT_PORT
      return (uri.scheme?.lowercase() ?: "http") + "://" + host + ":" + port
    }

    // 255.255.255.255 and each network's own broadcast address (some routers drop the first)
    private fun broadcastAddresses(): List<InetAddress> {
      val list = mutableListOf<InetAddress>()
      try {
        list.add(InetAddress.getByName("255.255.255.255"))
        for (net in Collections.list(NetworkInterface.getNetworkInterfaces())) {
          if (!net.isUp || net.isLoopback) continue
          for (a in net.interfaceAddresses) {
            val b = a.broadcast
            if (b != null && !list.contains(b)) list.add(b)
          }
        }
      } catch (e: Exception) {
        Log.d(TAG, "no interfaces", e)
      }
      return list
    }

    /** An address as it goes in a URL ([fe80::1] for IPv6) */
    private fun literal(address: InetAddress): String {
      var text = address.hostAddress ?: return ""
      val zone = text.indexOf('%')
      if (zone >= 0) text = text.substring(0, zone)
      return if (text.contains(":")) "[$text]" else text
    }
  }
}
