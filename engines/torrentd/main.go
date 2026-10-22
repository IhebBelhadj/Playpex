// playpex-torrentd: a torrent engine for Playpex Media Server, built on
// anacrolix/torrent (docs/media-server-plan.md §4.3, engine "torrentd").
//
// A sidecar: the server starts it, talks to its HTTP API on loopback, and
// stops it. Its API mirrors the server's engine port (apps/server/lib/torrents/port.js):
// torrents by info hash, files by their path inside the torrent, data in
// <savePath>/<path>. It is built for streaming: a stream is a responsive
// reader with read-ahead, so a seek fetches the pieces it needs first; which
// pieces are verified is kept in a BoltDB file (no re-check on start).
//
//	playpex-torrentd --listen 127.0.0.1:0 --data-dir <dir> --state-dir <dir> [--peer-port 6881]
//	                 [--no-discovery] [--port-forwarding] [--no-upload]
//	playpex-torrentd --version
//
// Auth: every request carries `Authorization: Bearer <PLAYPEX_TORRENTD_TOKEN>`.
// On start it prints `LISTENING <host:port>` on stdout, then logs on stderr.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	g "github.com/anacrolix/generics"
	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"
	"golang.org/x/time/rate"
)

var version = "0.1.0"

const readahead = 16 << 20

// What we keep per torrent, whether it is in the anacrolix client or paused
type entry struct {
	hash        metainfo.Hash
	savePath    string
	files       []string // selected paths; nil = every file
	onlyLargest bool
	magnet      string
	infoBytes   []byte // the info dictionary once known (a paused torrent restarts from it)
	trackers    []string
	peers       []string
	paused      bool
	t           *torrent.Torrent // nil while paused
	errText     string
	// speed samples
	lastRead, lastWritten int64
	downBps, upBps        int64
	// counters of the anacrolix torrent at the last sample (they restart with it)
	readTotal, writtenTotal int64
}

type engine struct {
	mu      sync.Mutex
	cl      *torrent.Client
	entries map[metainfo.Hash]*entry
	// save path per torrent, read by the storage while a torrent is added
	// (under mu): its own lock
	dirsMu   sync.Mutex
	dirs     map[metainfo.Hash]string
	down, up *rate.Limiter
	log      *slog.Logger
}

type apiError struct {
	status int
	code   string
	msg    string
}

func (e *apiError) Error() string { return e.msg }

func fail(status int, code, format string, args ...any) error {
	return &apiError{status, code, fmt.Sprintf(format, args...)}
}

// ── paths ───────────────────────────────────────────────────────────────────

// Our path of a file: <name>/<path…> for a folder torrent, <name> for one file
// (the layout every engine uses)
func filePath(info *metainfo.Info, fi metainfo.FileInfo) string {
	if !info.IsDir() {
		return info.BestName()
	}
	return filepath.Join(append([]string{info.BestName()}, fi.BestPath()...)...)
}

func (e *engine) filePaths(t *torrent.Torrent) []string {
	info := t.Info()
	out := make([]string, 0, len(t.Files()))
	for _, f := range t.Files() {
		out = append(out, filePath(info, f.FileInfo()))
	}
	return out
}

// ── torrents ────────────────────────────────────────────────────────────────

func (e *engine) spawn(en *entry) error {
	var spec *torrent.TorrentSpec
	var err error
	switch {
	case en.infoBytes != nil:
		spec = &torrent.TorrentSpec{}
		spec.InfoHash = en.hash
		spec.InfoBytes = en.infoBytes
	case en.magnet != "":
		spec, err = torrent.TorrentSpecFromMagnetUri(en.magnet)
		if err != nil {
			return fail(400, "BAD_TORRENT", "cannot read this magnet: %v", err)
		}
	default:
		spec = &torrent.TorrentSpec{}
		spec.InfoHash = en.hash
	}
	// one tier per tracker: every tracker is announced to (within a tier, a
	// client only tries the next one when the previous fails)
	for _, tr := range en.trackers {
		spec.Trackers = append(spec.Trackers, []string{tr})
	}
	spec.PeerAddrs = append(spec.PeerAddrs, en.peers...)
	e.dirsMu.Lock()
	e.dirs[en.hash] = en.savePath
	e.dirsMu.Unlock()
	t, _, err := e.cl.AddTorrentSpec(spec)
	if err != nil {
		return fail(400, "BAD_TORRENT", "cannot add %s: %v", en.hash.HexString(), err)
	}
	en.t = t
	en.paused = false
	en.readTotal, en.writtenTotal, en.lastRead, en.lastWritten = 0, 0, 0, 0
	go func() {
		select {
		case <-t.GotInfo():
		case <-t.Closed():
			return
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		if en.t != t {
			return
		}
		if en.infoBytes == nil {
			en.infoBytes = t.Metainfo().InfoBytes
		}
		if en.files == nil && en.onlyLargest {
			var largest *torrent.File
			for _, f := range t.Files() {
				if largest == nil || f.Length() > largest.Length() {
					largest = f
				}
			}
			if largest != nil {
				en.files = []string{filePath(t.Info(), largest.FileInfo())}
			}
		}
		e.applySelection(en)
	}()
	return nil
}

// Priorities from the selection (only once the info is known)
func (e *engine) applySelection(en *entry) {
	t := en.t
	if t == nil || t.Info() == nil {
		return
	}
	paths := e.filePaths(t)
	for i, f := range t.Files() {
		if en.files == nil || contains(en.files, paths[i]) {
			f.SetPriority(torrent.PiecePriorityNormal)
		} else {
			f.SetPriority(torrent.PiecePriorityNone)
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func (e *engine) get(h string) (*entry, error) {
	var hash metainfo.Hash
	if err := hash.FromHexString(h); err != nil {
		return nil, fail(400, "BAD_TORRENT", "not an info hash: %s", h)
	}
	en := e.entries[hash]
	if en == nil {
		return nil, fail(404, "NOT_FOUND", "the engine has no torrent %s", h)
	}
	return en, nil
}

type addRequest struct {
	InfoHash    string   `json:"infoHash"`
	Magnet      string   `json:"magnet"`
	TorrentFile string   `json:"torrentFile"` // base64
	SavePath    string   `json:"savePath"`
	Files       []string `json:"files"`
	OnlyLargest bool     `json:"onlyLargest"`
	Paused      bool     `json:"paused"`
	Trackers    []string `json:"trackers"`
	Peers       []string `json:"peers"`
}

func (e *engine) add(req addRequest) (map[string]any, error) {
	var hash metainfo.Hash
	if err := hash.FromHexString(req.InfoHash); err != nil {
		return nil, fail(400, "BAD_TORRENT", "not an info hash: %s", req.InfoHash)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if en := e.entries[hash]; en != nil {
		return map[string]any{"infoHash": req.InfoHash, "name": nameOf(en)}, nil
	}
	en := &entry{hash: hash, savePath: req.SavePath, files: req.Files, onlyLargest: req.OnlyLargest,
		magnet: req.Magnet, trackers: req.Trackers, peers: req.Peers}
	if req.TorrentFile != "" {
		raw, err := base64.StdEncoding.DecodeString(req.TorrentFile)
		if err != nil {
			return nil, fail(400, "BAD_TORRENT", "torrentFile is not base64")
		}
		mi, err := metainfo.Load(strings.NewReader(string(raw)))
		if err != nil {
			return nil, fail(400, "BAD_TORRENT", "cannot read this torrent: %v", err)
		}
		if mi.HashInfoBytes() != hash {
			return nil, fail(400, "BAD_TORRENT", "the metainfo is not the one of %s", req.InfoHash)
		}
		if _, err := mi.UnmarshalInfo(); err != nil {
			return nil, fail(400, "BAD_TORRENT", "cannot read this torrent: %v", err)
		}
		en.infoBytes = mi.InfoBytes
	} else if req.Magnet != "" {
		spec, err := torrent.TorrentSpecFromMagnetUri(req.Magnet)
		if err != nil || spec.InfoHash != hash {
			return nil, fail(400, "BAD_TORRENT", "cannot read this magnet")
		}
	}
	if req.Paused {
		en.paused = true
	} else if err := e.spawn(en); err != nil {
		return nil, err
	}
	e.entries[hash] = en
	e.log.Info("added", "hash", req.InfoHash, "paused", req.Paused)
	return map[string]any{"infoHash": req.InfoHash, "name": nameOf(en)}, nil
}

func infoOf(en *entry) *metainfo.Info {
	if en.t != nil && en.t.Info() != nil {
		return en.t.Info()
	}
	if en.infoBytes != nil {
		var info metainfo.Info
		if bencode.Unmarshal(en.infoBytes, &info) == nil {
			return &info
		}
	}
	return nil
}

func nameOf(en *entry) any {
	if info := infoOf(en); info != nil {
		return info.BestName()
	}
	return nil
}

// metadata: { name, length, pieceLength, files: [{ path, size, offset }], torrentFile (base64) }
func (e *engine) metadata(en *entry) (map[string]any, error) {
	info := infoOf(en)
	if info == nil {
		return nil, fail(409, "NO_METADATA_YET", "no metadata yet for %s", en.hash.HexString())
	}
	files := []map[string]any{}
	var offset int64
	for _, fi := range info.UpvertedFiles() {
		files = append(files, map[string]any{"path": filePath(info, fi), "size": fi.Length, "offset": offset})
		offset += fi.Length
	}
	mi := metainfo.MetaInfo{InfoBytes: en.infoBytes, AnnounceList: [][]string{}}
	raw, err := bencode.Marshal(mi)
	if err != nil {
		return nil, fail(500, "DISK", "cannot encode the metainfo: %v", err)
	}
	return map[string]any{
		"name": info.BestName(), "length": info.TotalLength(), "pieceLength": info.PieceLength,
		"files": files, "torrentFile": base64.StdEncoding.EncodeToString(raw),
	}, nil
}

func (e *engine) pause(en *entry) {
	if en.t != nil {
		if en.infoBytes == nil && en.t.Info() != nil {
			en.infoBytes = en.t.Metainfo().InfoBytes
		}
		en.t.Drop()
		en.t = nil
	}
	en.paused = true
	en.downBps, en.upBps = 0, 0
}

func (e *engine) remove(en *entry, deleteData bool) {
	info := infoOf(en)
	e.pause(en)
	delete(e.entries, en.hash)
	if !deleteData || info == nil {
		return
	}
	root, _ := filepath.Abs(en.savePath)
	dirs := map[string]bool{}
	for _, fi := range info.UpvertedFiles() {
		full, _ := filepath.Abs(filepath.Join(root, filePath(info, fi)))
		if !strings.HasPrefix(full, root+string(filepath.Separator)) {
			continue
		}
		os.Remove(full)
		for d := filepath.Dir(full); strings.HasPrefix(d, root+string(filepath.Separator)); d = filepath.Dir(d) {
			dirs[d] = true
		}
	}
	// deepest first; a folder still holding something stays
	for len(dirs) > 0 {
		deepest := ""
		for d := range dirs {
			if len(d) > len(deepest) {
				deepest = d
			}
		}
		os.Remove(deepest)
		delete(dirs, deepest)
	}
}

// ── stats ───────────────────────────────────────────────────────────────────

// Speeds from the counters, every second
func (e *engine) sample() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, en := range e.entries {
		if en.t == nil {
			en.downBps, en.upBps = 0, 0
			continue
		}
		s := en.t.Stats()
		read, written := s.BytesReadUsefulData.Int64(), s.BytesWrittenData.Int64()
		en.downBps, en.upBps = read-en.lastRead, written-en.lastWritten
		if en.downBps < 0 {
			en.downBps = 0
		}
		if en.upBps < 0 {
			en.upBps = 0
		}
		en.lastRead, en.lastWritten = read, written
		en.readTotal, en.writtenTotal = read, written
	}
}

func (e *engine) stats(en *entry, withPieces bool) map[string]any {
	out := map[string]any{
		"infoHash": en.hash.HexString(), "state": "paused", "metadata": infoOf(en) != nil,
		"doneBytes": 0, "sizeBytes": nil, "downBps": 0, "upBps": 0, "peers": 0, "peersUnchoked": 0, "seeds": 0,
		"downloadedBytes": 0, "uploadedBytes": 0, "checking": nil, "pieces": nil, "error": nil,
	}
	if en.errText != "" {
		out["error"] = en.errText
	}
	t := en.t
	if t == nil {
		return out
	}
	out["state"] = "downloading"
	out["downBps"], out["upBps"] = en.downBps, en.upBps
	out["downloadedBytes"], out["uploadedBytes"] = en.readTotal, en.writtenTotal
	s := t.Stats()
	out["peers"], out["peersUnchoked"], out["seeds"] = s.ActivePeers, s.ActivePeers, s.ConnectedSeeders
	if t.Info() == nil {
		return out
	}
	paths := e.filePaths(t)
	var done, size int64
	for i, f := range t.Files() {
		if en.files == nil || contains(en.files, paths[i]) {
			size += f.Length()
			done += f.BytesCompleted()
		}
	}
	out["doneBytes"], out["sizeBytes"] = done, size
	checking, n := 0, t.NumPieces()
	out["pieceCount"] = n
	var bits []byte
	if withPieces {
		bits = make([]byte, (n+7)/8)
	}
	for i := 0; i < n; i++ {
		ps := t.PieceState(i)
		if ps.Checking {
			checking++
		}
		if bits != nil && ps.Complete {
			bits[i/8] |= 0x80 >> (i % 8)
		}
	}
	if bits != nil {
		out["pieces"] = base64.StdEncoding.EncodeToString(bits)
	}
	switch {
	case checking > 0 && done < size:
		out["state"] = "checking"
		out["checking"] = map[string]any{"done": t.Stats().PiecesComplete, "total": n}
	case size > 0 && done >= size:
		out["state"] = "seeding"
	}
	return out
}

// ── streaming ───────────────────────────────────────────────────────────────

// The bytes of a file, with HTTP ranges (http.ServeContent): a responsive
// reader, so the pieces under the read position come first
func (e *engine) stream(w http.ResponseWriter, r *http.Request, h string) {
	e.mu.Lock()
	en, err := e.get(h)
	var t *torrent.Torrent
	if err == nil {
		t = en.t
		if t == nil {
			err = fail(404, "NOT_FOUND", "the torrent %s is paused", h)
		}
	}
	e.mu.Unlock()
	if err != nil {
		writeError(w, err)
		return
	}
	select {
	case <-t.GotInfo():
	case <-r.Context().Done():
		return
	case <-t.Closed():
		writeError(w, fail(404, "NOT_FOUND", "the torrent %s stopped", h))
		return
	}
	want := r.URL.Query().Get("path")
	var file *torrent.File
	for i, p := range e.filePaths(t) {
		if p == want {
			file = t.Files()[i]
		}
	}
	if file == nil {
		writeError(w, fail(404, "NOT_FOUND", "no file %s in %s", want, h))
		return
	}
	reader := file.NewReader()
	defer reader.Close()
	reader.SetResponsive()
	reader.SetReadahead(readahead)
	reader.SetContext(r.Context())
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", time.Time{}, reader)
}

// ── HTTP ────────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeJSON(w, ae.status, map[string]string{"error": ae.msg, "code": ae.code})
		return
	}
	writeJSON(w, 500, map[string]string{"error": err.Error(), "code": "DISK"})
}

func (e *engine) routes(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": version})
	})
	// anacrolix's own status page (peers, half-open dials, piece states): for debugging
	mux.HandleFunc("GET /debug/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		e.cl.WriteStatus(w)
	})
	// known peers by source (Tr tracker, Hg/Ha DHT, X PEX, M given…), and connections
	mux.HandleFunc("GET /debug/peers/{hash}", func(w http.ResponseWriter, r *http.Request) {
		e.mu.Lock()
		en, err := e.get(r.PathValue("hash"))
		var t *torrent.Torrent
		if err == nil {
			t = en.t
		}
		e.mu.Unlock()
		if t == nil {
			writeError(w, fail(404, "NOT_FOUND", "not running"))
			return
		}
		known := map[string]int{}
		for _, p := range t.KnownSwarm() {
			known[string(p.Source)]++
		}
		st := t.Stats()
		writeJSON(w, 200, map[string]any{"known": known, "active": st.ActivePeers, "halfOpen": st.HalfOpenPeers,
			"pending": st.PendingPeers, "info": t.Info() != nil})
	})
	mux.HandleFunc("POST /torrents", func(w http.ResponseWriter, r *http.Request) {
		var req addRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, fail(400, "BAD_TORRENT", "bad request: %v", err))
			return
		}
		res, err := e.add(req)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, res)
	})
	mux.HandleFunc("GET /torrents", func(w http.ResponseWriter, r *http.Request) {
		e.mu.Lock()
		defer e.mu.Unlock()
		list := []map[string]any{}
		for _, en := range e.entries {
			list = append(list, e.stats(en, r.URL.Query().Get("pieces") == "1"))
		}
		writeJSON(w, 200, map[string]any{"torrents": list})
	})
	mux.HandleFunc("GET /torrents/{hash}/metadata", func(w http.ResponseWriter, r *http.Request) {
		e.mu.Lock()
		defer e.mu.Unlock()
		en, err := e.get(r.PathValue("hash"))
		if err == nil {
			var md map[string]any
			if md, err = e.metadata(en); err == nil {
				writeJSON(w, 200, md)
				return
			}
		}
		writeError(w, err)
	})
	action := func(fn func(*entry, *http.Request) error) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			e.mu.Lock()
			defer e.mu.Unlock()
			en, err := e.get(r.PathValue("hash"))
			if err == nil {
				err = fn(en, r)
			}
			if err != nil {
				writeError(w, err)
				return
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
		}
	}
	mux.HandleFunc("POST /torrents/{hash}/start", action(func(en *entry, r *http.Request) error {
		if en.t != nil {
			return nil
		}
		return e.spawn(en)
	}))
	mux.HandleFunc("POST /torrents/{hash}/pause", action(func(en *entry, r *http.Request) error {
		e.pause(en)
		e.log.Info("paused", "hash", en.hash.HexString())
		return nil
	}))
	mux.HandleFunc("POST /torrents/{hash}/stop", action(func(en *entry, r *http.Request) error {
		e.remove(en, false)
		e.log.Info("stopped", "hash", en.hash.HexString())
		return nil
	}))
	mux.HandleFunc("POST /torrents/{hash}/remove", action(func(en *entry, r *http.Request) error {
		var body struct {
			DeleteData bool `json:"deleteData"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		e.remove(en, body.DeleteData)
		e.log.Info("removed", "hash", en.hash.HexString(), "deleteData", body.DeleteData)
		return nil
	}))
	mux.HandleFunc("PUT /torrents/{hash}/files", action(func(en *entry, r *http.Request) error {
		var body struct {
			Files []string `json:"files"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			return fail(400, "BAD_TORRENT", "bad request: %v", err)
		}
		en.files = body.Files
		e.applySelection(en)
		return nil
	}))
	mux.HandleFunc("GET /torrents/{hash}/stream", func(w http.ResponseWriter, r *http.Request) {
		e.stream(w, r, r.PathValue("hash"))
	})
	mux.HandleFunc("PUT /limits", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			DownBps int64 `json:"downBps"`
			UpBps   int64 `json:"upBps"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, fail(400, "BAD_TORRENT", "bad request: %v", err))
			return
		}
		setLimit(e.down, body.DownBps)
		setLimit(e.up, body.UpBps)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			writeJSON(w, 401, map[string]string{"error": "unauthorized", "code": "UNAVAILABLE"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// 0 = no limit
func setLimit(l *rate.Limiter, bps int64) {
	if bps <= 0 {
		l.SetLimit(rate.Inf)
		return
	}
	l.SetLimit(rate.Limit(bps))
	if l.Burst() < int(bps) {
		l.SetBurst(int(max(bps, 256<<10)))
	}
}

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "HTTP API address (loopback)")
	dataDir := flag.String("data-dir", "", "default save path")
	stateDir := flag.String("state-dir", "", "where the piece completion database lives")
	peerPort := flag.Int("peer-port", 6881, "BitTorrent port (TCP and uTP); taken → any free port")
	noDiscovery := flag.Bool("no-discovery", false, "no DHT, trackers or PEX (tests)")
	portForwarding := flag.Bool("port-forwarding", false, "ask the router to forward the peer port (UPnP)")
	noUpload := flag.Bool("no-upload", false, "never upload")
	showVersion := flag.Bool("version", false, "print the version")
	debug := flag.Bool("debug", false, "log at debug level (anacrolix's too)")
	flag.Parse()
	if *showVersion {
		fmt.Println("playpex-torrentd " + version)
		return
	}
	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	token := os.Getenv("PLAYPEX_TORRENTD_TOKEN")
	if token == "" || *dataDir == "" || *stateDir == "" {
		fmt.Fprintln(os.Stderr, "PLAYPEX_TORRENTD_TOKEN, --data-dir and --state-dir are required")
		os.Exit(2)
	}
	if err := os.MkdirAll(*stateDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	completion, err := storage.NewBoltPieceCompletion(*stateDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "piece completion:", err)
		os.Exit(1)
	}

	e := &engine{
		entries: map[metainfo.Hash]*entry{},
		dirs:    map[metainfo.Hash]string{},
		// a burst > 0: unlimited limiters answer Tokens() = burst, and the
		// client opens no connection while the download one has none
		down: rate.NewLimiter(rate.Inf, 1<<20),
		up:   rate.NewLimiter(rate.Inf, 1<<20),
		log:  logger,
	}
	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = *dataDir
	cfg.DefaultStorage = storage.NewFileOpts(storage.NewFileClientOpts{
		ClientBaseDir: *dataDir,
		// each torrent in its own save path; files at <savePath>/<name>/<path>
		TorrentDirMaker: func(baseDir string, info *metainfo.Info, hash metainfo.Hash) string {
			e.dirsMu.Lock()
			defer e.dirsMu.Unlock()
			if dir, ok := e.dirs[hash]; ok && dir != "" {
				return dir
			}
			return baseDir
		},
		PieceCompletion: completion,
		UsePartFiles:    g.Some(false),
		Logger:          logger,
	})
	cfg.Seed = true
	cfg.NoUpload = *noUpload
	cfg.DisableWebtorrent = true
	cfg.NoDefaultPortForwarding = !*portForwarding
	if *noDiscovery {
		cfg.NoDHT = true
		cfg.DisableTrackers = true
		cfg.DisablePEX = true
	}
	// Start-up: trackers hand out hundreds of peers at once, many dead. The
	// defaults (25 half-open per torrent, 20 s dial timeout, 10 dials/s) left
	// the first connection 5 s away; dial wider and give up sooner
	cfg.HalfOpenConnsPerTorrent = 100
	cfg.TotalHalfOpenConns = 400
	cfg.NominalDialTimeout = 6 * time.Second
	cfg.MinDialTimeout = 2 * time.Second
	cfg.DialRateLimiter = rate.NewLimiter(100, 100)
	cfg.DownloadRateLimiter = e.down
	cfg.UploadRateLimiter = e.up
	cfg.Slogger = logger.With("component", "anacrolix")
	cfg.ListenPort = *peerPort
	cl, err := torrent.NewClient(cfg)
	if err != nil && *peerPort != 0 {
		logger.Warn("peer port taken, using a free one", "port", *peerPort, "err", err)
		cfg.ListenPort = 0
		cl, err = torrent.NewClient(cfg)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "torrent client:", err)
		os.Exit(1)
	}
	e.cl = cl

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(1)
	}
	fmt.Printf("LISTENING %s PEERPORT %d\n", ln.Addr().String(), cl.LocalPort())
	os.Stdout.Sync()

	go func() {
		for range time.Tick(time.Second) {
			e.sample()
		}
	}()
	srv := &http.Server{Handler: e.routes(token), ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	// the server closing our stdin (it died) stops us too
	go func() {
		io.Copy(io.Discard, os.Stdin)
		stop <- syscall.SIGTERM
	}()
	<-stop
	logger.Info("stopping")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	cl.Close()
	completion.Close()
}
