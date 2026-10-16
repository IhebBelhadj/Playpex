# Finding a server

A server that shares on the LAN (its default) can be found in two ways. Use **both** and merge what you find by the server's `id`: multicast is filtered on some networks (guest Wi-Fi, some routers, Windows setups), and mDNS isn't available on every platform.

| Method | You send | You get |
|---|---|---|
| mDNS / DNS-SD | browse `_playpex._tcp.local` | SRV (host + **HTTP port in use**), A records, TXT `id`, `v`, `ver`, `name` |
| UDP | the datagram `PLAYPEX_DISCOVER 1` to port **28471** | one JSON datagram per server: `{ id, name, port, apiVersion, minApiVersion, version }` |
| Manual entry | the user types an address | probe `GET http://<address>/api/v1/server` |

Whatever the method, **confirm every address** with `GET /api/v1/server` before you list it: it must answer, and its `id` must match what discovery said.

## mDNS / DNS-SD

- Service type `_playpex._tcp` in the `local.` domain. Android: `NsdManager`; Apple: `NWBrowser` / Bonjour; Node: `bonjour-service` or `multicast-dns`; Linux: Avahi.
- **Instance name** = the server's name (cut to 63 bytes; when two servers have the same name, the second becomes `<name> (<4 chars of its id>)`). Show TXT `name` rather than the instance name: it's never cut.
- **SRV** port = the HTTP port the server listens on now; target `playpex-<8 chars of id>.local`.
- **A records** list every address of the server machine, including Docker bridges and VPNs. Try them in turn and keep the first that answers `GET /server` with the right `id`.
- **TXT**: `id` (server id, UUID), `v` (its `apiVersion`), `ver` (server software version), `name` (full name).
- A server that stops or moves to another port sends an mDNS goodbye (TTL 0): drop it, or update its port when it re-announces.
- macOS 15+ and iOS ask the user for local network access the first time an app browses (declare `_playpex._tcp` in `NSBonjourServices`).

## UDP fallback

- Send the 18 ASCII bytes `PLAYPEX_DISCOVER 1` (no newline) **from any local port** to UDP **28471**: to `255.255.255.255` and to each interface's directed broadcast address (e.g. `192.168.1.255`), or unicast to one address.
- Each server answers the sender with one datagram of JSON:
  ```json
  { "id": "6f1c…", "name": "Living room PC", "port": 28470, "apiVersion": 1, "minApiVersion": 1, "version": "0.9.0" }
  ```
  The server's address is the datagram's source address; `port` is its HTTP port.
- Ask again every **5 s** while your server picker is open (`DISCOVERY.INTERVAL_MS`); a server that didn't answer for three rounds is gone.
- The server answers only senders on loopback, private (RFC 1918), link-local and CGNAT addresses, at most 20 answers per address per 10 s, and ignores any other datagram.
- 28471 is fixed: it isn't a setting, so clients can always ask there.

## Manual entry

Let the user type `host`, `host:port` or a full URL. No port means **28470**. Probe `GET /api/v1/server`; on success, treat it like a discovered server.

## Recognising a server: its `id`

`GET /api/v1/server` (no auth) answers:

```json
{
  "id": "6f1c2a9e-…",
  "name": "Living room PC",
  "version": "0.9.0",
  "apiVersion": 1,
  "minApiVersion": 1,
  "auth": "pairing",
  "features": { "transcode": true, "subtitles": ["opensubtitles-stremio", "yify"], "adult": true }
}
```

- **Store servers by `id`, never by address.** Addresses change (DHCP), and the admin can change the port. When a saved URL stops answering, run discovery and look for the same `id`: it gives you the new address and port. The token you stored for that `id` stays valid.
- Check versions before pairing: you can talk to the server if your API version is between its `minApiVersion` and `apiVersion` ([versions](errors-and-versions.md#versions)).
- `features.transcode`: the server has ffmpeg, so `/probe` and `/transcode` work. `features.subtitles`: the subtitle providers enabled on it.

## A client on the server machine

Probe `http://localhost:28470/api/v1/server` too (UDP and mDNS also work over loopback). A server on the same machine should be reached through **loopback** (`localhost` / `127.0.0.1`): loopback clients need no pairing ([auth](auth.md#clients-on-the-server-machine)).

## When nothing is found

Say why and what to do: no Playpex Media Server on this network, the server's LAN sharing is off (dashboard › Settings › Network), a firewall blocks it (Windows asks once to allow it on private networks; Linux deb packages open the ports when ufw or firewalld is active), or the client is on another network (guest Wi-Fi, VPN). Always offer manual entry.

## Reference

- Constants: `DISCOVERY` (`MDNS_TYPE`, `MDNS_SERVICE`, `UDP_PORT`, `QUERY`, `INTERVAL_MS`), `DEFAULT_PORT` in `@playpex/protocol`; type `DiscoveryReply` in `index.d.ts`.
- Implementations: server `apps/server/lib/discovery.js`; client `apps/tv/electron/discovery.js` (Node, mDNS + UDP, merged by `id`, probes every address). On machines with several networks, send each mDNS query on every interface (`@playpex/protocol/mdns.js` does): sent only through the default interface, queries from another network get no answer.
- IPv4 only for now.
