// Finding Playpex servers on the LAN, for the TV client's server picker
// (docs/server-separation-plan.md §10.1, protocol in @playpex/protocol
// `DISCOVERY`). Runs in Electron's main process (plain Node: no browser APIs);
// step 9 hands it to the renderer through the preload bridge.
//
//   const discovery = createDiscovery({ onChange })
//   discovery.start()            browse mDNS + broadcast UDP every 5 s, until stop()
//   discovery.rescan()           ask again now (the picker's "Rescan")
//   discovery.stop()
//   discovery.servers()          → [Server], the local one first, then by name
//   discovery.find(id, ms)       → Promise<Server | null>: a paired server by its id,
//                                  e.g. when its saved URL stopped answering (new port, new IP)
//   probe('192.168.1.20')        → Promise<Server>: manual entry, port 28470 when none is given
//
// Server: { id, name, version, apiVersion, minApiVersion, compatible, url, port,
//           addresses, local, via: ['mdns' | 'udp' | 'local'], lastSeen }
// Every address found is confirmed with GET /api/v1/server before it is listed,
// and servers are merged by id: one entry per server however it was found.

const dgram = require('dgram')
const http = require('http')
const os = require('os')
const { EventEmitter } = require('events')
const protocol = require('@playpex/protocol')
const mdnsSocket = require('@playpex/protocol/mdns')

const { DISCOVERY, DEFAULT_PORT, API_PREFIX, API_VERSION } = protocol

const PROBE_TIMEOUT_MS = 2000
// a candidate address confirmed this recently isn't probed again
const CONFIRMED_MS = 30000

function ipv4Interfaces() {
    const nets = os.networkInterfaces()
    return Object.keys(nets).reduce((all, name) => all.concat(nets[name].filter(a => a.family === 'IPv4' && !a.internal)), [])
}

// Directed broadcast address of an interface (192.168.1.255 for 192.168.1.20/24)
function broadcastAddress(iface) {
    const ip = iface.address.split('.').map(Number)
    const mask = iface.netmask.split('.').map(Number)
    return ip.map((part, i) => (part | (~mask[i] & 255))).join('.')
}

function isLocalAddress(address) {
    return address === '127.0.0.1' || address === 'localhost' || ipv4Interfaces().some(a => a.address === address)
}

function urlFor(address, port) {
    return 'http://' + (address.indexOf(':') !== -1 ? '[' + address + ']' : address) + ':' + port
}

// GET <url>/api/v1/server → its answer (rejects on anything but a Playpex server)
function serverInfo(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.get(url + API_PREFIX + '/server', { timeout: timeoutMs || PROBE_TIMEOUT_MS }, res => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', d => {
                body += d
                if (body.length > 65536) {
                    req.destroy(new Error('answer too large'))
                }
            })
            res.on('end', () => {
                try {
                    const info = JSON.parse(body)
                    if (res.statusCode !== 200 || typeof info.id !== 'string' || !Number.isInteger(info.apiVersion)) {
                        throw new Error('not a Playpex server')
                    }
                    resolve(info)
                } catch (e) {
                    reject(e)
                }
            })
        })
        req.on('timeout', () => req.destroy(new Error('no answer')))
        req.on('error', reject)
    })
}

function compatible(info) {
    return (info.minApiVersion || info.apiVersion) <= API_VERSION && API_VERSION <= info.apiVersion
}

function describe(info, url, port) {
    return {
        id: info.id,
        name: info.name,
        version: info.version,
        apiVersion: info.apiVersion,
        minApiVersion: info.minApiVersion,
        compatible: compatible(info),
        url,
        port
    }
}

// Manual entry: "192.168.1.20", "192.168.1.20:28480", "http://nas.local:28470/"
function probe(address, timeoutMs) {
    let text = String(address || '').trim()
    if (!/^https?:\/\//i.test(text)) {
        text = 'http://' + text
    }
    let parsed
    try {
        parsed = new URL(text)
    } catch (e) {
        return Promise.reject(new Error('Not an address: ' + address))
    }
    const port = parsed.port ? Number(parsed.port) : DEFAULT_PORT
    const url = parsed.protocol + '//' + parsed.host.replace(/:\d+$/, '') + ':' + port
    return serverInfo(url, timeoutMs).then(info => Object.assign(describe(info, url, port), {
        addresses: [parsed.hostname],
        local: isLocalAddress(parsed.hostname),
        via: ['manual'],
        lastSeen: Date.now()
    }))
}

/**
 * @param {{ mdns?: boolean, udp?: boolean, local?: boolean, intervalMs?: number,
 *           udpPort?: number, localPort?: number, onChange?: Function, log?: Function }} [options]
 *   mdns / udp / local: which ways to look (all on by default; local = the
 *   default port on this machine, for a server that doesn't share on the LAN)
 */
function createDiscovery(options) {
    options = Object.assign({
        mdns: true,
        udp: true,
        local: true,
        intervalMs: DISCOVERY.INTERVAL_MS,
        udpPort: DISCOVERY.UDP_PORT,
        localPort: DEFAULT_PORT,
        log: () => {}
    }, options)

    const emitter = new EventEmitter()
    const found = new Map()       // id → Server + seen: { mdns, udp, local } (timestamps)
    const confirmed = new Map()   // 'id@address:port' → time it last answered
    const probing = new Set()     // 'address:port' in flight
    let bonjour = null
    let browser = null
    let socket = null
    let timer = null
    let running = false

    if (options.onChange) {
        emitter.on('change', options.onChange)
    }

    function list() {
        return Array.from(found.values()).map(s => {
            const copy = Object.assign({}, s, { addresses: s.addresses.slice() })
            copy.via = Object.keys(s.seen).filter(k => s.seen[k])
            delete copy.seen
            return copy
        }).sort((a, b) => (b.local - a.local) || a.name.localeCompare(b.name))
    }

    function changed() {
        emitter.emit('change', list())
    }

    // An address said to be a Playpex server (by mDNS or UDP): confirm it over
    // HTTP, then add or update the server it belongs to
    function candidate(address, port, via, expectedId) {
        if (!address || !port || address.indexOf(':') !== -1) {
            return   // IPv4 only: IPv6 link-local addresses need a zone id the URL can't carry
        }
        const key = address + ':' + port
        const recent = expectedId && confirmed.get(expectedId + '@' + key)
        if (recent && Date.now() - recent < CONFIRMED_MS) {
            seen(found.get(expectedId), via)
            return
        }
        if (probing.has(key)) {
            return
        }
        probing.add(key)
        const url = urlFor(address, port)
        serverInfo(url).then(info => {
            probing.delete(key)
            if (!running || (expectedId && info.id !== expectedId)) {
                return
            }
            confirmed.set(info.id + '@' + key, Date.now())
            add(info, address, port, via)
        }, err => {
            probing.delete(key)
            options.log('discovery: ' + url + ' did not answer: ' + err.message)
        })
    }

    function add(info, address, port, via) {
        const local = isLocalAddress(address)
        let server = found.get(info.id)
        const isNew = !server
        if (isNew) {
            server = Object.assign(describe(info, null, port), { addresses: [], local: false, seen: {}, lastSeen: 0 })
            found.set(info.id, server)
        }
        // name, version… may have changed (renamed, updated)
        Object.assign(server, describe(info, server.url, server.port))
        if (server.addresses.indexOf(address) === -1) {
            server.addresses.push(address)
        }
        server.local = server.local || local
        // The URL to use: on the server machine always loopback (a local client
        // needs no pairing); a new port wins over the old one (the server moved)
        if (!server.url || server.port !== port || (local && server.url !== urlFor('127.0.0.1', port))) {
            server.url = urlFor(local ? '127.0.0.1' : address, port)
            server.port = port
        }
        seen(server, via)
        if (isNew) {
            emitter.emit('found', list().find(s => s.id === info.id))
        }
        changed()
    }

    function seen(server, via) {
        if (server) {
            server.seen[via] = Date.now()
            server.lastSeen = Date.now()
        }
    }

    // Servers nobody announced for 3 rounds are gone
    function prune() {
        const limit = Date.now() - options.intervalMs * 3
        let removed = false
        found.forEach((server, id) => {
            Object.keys(server.seen).forEach(via => {
                if (server.seen[via] < limit) {
                    delete server.seen[via]
                }
            })
            if (!Object.keys(server.seen).length) {
                found.delete(id)
                removed = true
                emitter.emit('lost', { id, name: server.name })
            }
        })
        if (removed) {
            changed()
        }
    }

    // ── mDNS ──────────────────────────────────────────────────────────────
    function onService(service) {
        const txt = service.txt || {}
        const addresses = (service.addresses || []).concat(service.referer ? [service.referer.address] : [])
        addresses.filter((a, i) => addresses.indexOf(a) === i).forEach(a => candidate(a, service.port, 'mdns', txt.id))
    }

    function startMdns() {
        let Bonjour
        try {
            Bonjour = require('bonjour-service').Bonjour
            const sock = mdnsSocket.create()
            bonjour = new Bonjour({ socket: sock }, err => options.log('discovery: mDNS error: ' + err.message))
            // queries leave through every interface, not only the default one
            mdnsSocket.sendOnEveryInterface(bonjour.server.mdns, sock)
        } catch (e) {
            options.log('discovery: mDNS unavailable: ' + e.message)
            return
        }
        bonjour.server.mdns.on('error', err => options.log('discovery: mDNS unavailable: ' + err.message))
        bonjour.server.mdns.on('warning', () => {})
        browser = bonjour.find({ type: DISCOVERY.MDNS_TYPE, protocol: 'tcp' })
        browser.on('up', onService)
        browser.on('srv-update', onService)   // same server, new port
        browser.on('txt-update', onService)
        browser.on('down', service => {
            const id = service.txt && service.txt.id
            if (id && found.has(id)) {
                delete found.get(id).seen.mdns
                prune()
            }
        })
    }

    // ── UDP ───────────────────────────────────────────────────────────────
    function startUdp() {
        socket = dgram.createSocket({ type: 'udp4' })
        socket.on('error', err => {
            options.log('discovery: UDP unavailable: ' + err.message)
            try { socket.close() } catch (e) { /* closed */ }
            socket = null
        })
        socket.on('message', (msg, rinfo) => {
            let reply
            try {
                reply = JSON.parse(msg.toString('utf8'))
            } catch (e) {
                return
            }
            if (reply && typeof reply.id === 'string' && Number.isInteger(reply.port)) {
                candidate(rinfo.address, reply.port, 'udp', reply.id)
            }
        })
        socket.bind(0, () => {
            if (socket) {
                socket.setBroadcast(true)
                broadcast()
            }
        })
    }

    function broadcast() {
        if (!socket) {
            return
        }
        const query = Buffer.from(DISCOVERY.QUERY)
        // 255.255.255.255 leaves through one interface only; each interface's
        // own broadcast address reaches every network this machine is on
        const targets = ['255.255.255.255'].concat(ipv4Interfaces().map(broadcastAddress))
        targets.filter((t, i) => targets.indexOf(t) === i).forEach(target => {
            socket.send(query, options.udpPort, target, err => {
                if (err) {
                    options.log('discovery: UDP query to ' + target + ' not sent: ' + err.message)
                }
            })
        })
    }

    // ── rounds ────────────────────────────────────────────────────────────
    function round() {
        if (!running) {
            return
        }
        if (browser) {
            browser.update()   // query again; answers update the known services
            browser.services.forEach(service => {
                const id = service.txt && service.txt.id
                if (id && found.has(id)) {
                    seen(found.get(id), 'mdns')
                } else {
                    onService(service)
                }
            })
        }
        broadcast()
        if (options.local) {
            candidate('127.0.0.1', options.localPort, 'local')
        }
        prune()
    }

    function start() {
        if (running) {
            return emitter
        }
        running = true
        if (options.mdns) {
            startMdns()
        }
        if (options.udp) {
            startUdp()
        }
        if (options.local) {
            candidate('127.0.0.1', options.localPort, 'local')
        }
        timer = setInterval(round, options.intervalMs)
        return emitter
    }

    function stop() {
        running = false
        clearInterval(timer)
        timer = null
        if (browser) {
            browser.stop()
            browser = null
        }
        if (bonjour) {
            bonjour.destroy()
            bonjour = null
        }
        if (socket) {
            try { socket.close() } catch (e) { /* closed */ }
            socket = null
        }
        found.clear()
        confirmed.clear()
    }

    function find(id, timeoutMs) {
        const known = found.get(id)
        if (known && known.url) {
            return Promise.resolve(list().find(s => s.id === id))
        }
        const startedHere = !running
        start()
        return new Promise(resolve => {
            const done = server => {
                clearTimeout(timeout)
                emitter.removeListener('change', onChange)
                if (startedHere) {
                    stop()
                }
                resolve(server)
            }
            const onChange = servers => {
                const server = servers.find(s => s.id === id)
                if (server && server.url) {
                    done(server)
                }
            }
            const timeout = setTimeout(() => done(null), timeoutMs || options.intervalMs * 2)
            emitter.on('change', onChange)
        })
    }

    return Object.assign(emitter, {
        start,
        stop,
        rescan: round,
        servers: list,
        find
    })
}

module.exports = { createDiscovery, probe, serverInfo }
