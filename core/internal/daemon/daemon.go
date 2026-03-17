package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// DaemonConfig holds configuration for the daemon HTTP server.
type DaemonConfig struct {
	Port         int
	Token        string
	HistoryLimit int
}

// Daemon is the TermLive session hub. It manages PTY sessions and exposes
// them via HTTP API and WebSocket.
type Daemon struct {
	cfg           DaemonConfig
	mgr           *SessionManager
	notifications *NotificationStore
	bridge        *BridgeManager
	stats         *Stats
	tokens        *TokenStore
	token         string
	startTime     time.Time
	server        *http.Server
	extraHandler  http.Handler
	mu            sync.Mutex
}

// NewDaemon creates a new Daemon with the given config.
func NewDaemon(cfg DaemonConfig) *Daemon {
	token := cfg.Token
	if token == "" {
		b := make([]byte, 16)
		rand.Read(b)
		token = hex.EncodeToString(b)
	}
	historyLimit := cfg.HistoryLimit
	if historyLimit <= 0 {
		historyLimit = 100
	}
	return &Daemon{
		cfg:           cfg,
		mgr:           NewSessionManager(),
		notifications: NewNotificationStore(historyLimit),
		bridge:        NewBridgeManager(),
		stats:         NewStats(),
		tokens:        NewTokenStore(),
		token:         token,
		startTime:     time.Now(),
	}
}

// Manager returns the session manager (used by full mode for PTY sessions).
func (d *Daemon) Manager() *SessionManager { return d.mgr }

// Token returns the authentication token.
func (d *Daemon) Token() string { return d.token }

// Notifications returns the notification store (for direct internal use).
func (d *Daemon) Notifications() *NotificationStore { return d.notifications }

// SetExtraHandler sets an additional HTTP handler that serves routes
// not handled by the daemon's own API (e.g., Web UI, WebSocket).
// Must be called before Run() or Handler().
func (d *Daemon) SetExtraHandler(h http.Handler) {
	d.extraHandler = h
}

// --- HTTP API types ---

// StatusResponse is the JSON response for GET /api/status.
type StatusResponse struct {
	Status   string `json:"status"`
	Uptime   string `json:"uptime"`
	Port     int    `json:"port"`
	Sessions int    `json:"sessions"`
}

// --- Session management API types ---

// CreateSessionRequest is the JSON body for POST /api/sessions.
type CreateSessionRequest struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Rows    uint16   `json:"rows"`
	Cols    uint16   `json:"cols"`
}

// CreateSessionResponse is the JSON response for POST /api/sessions.
type CreateSessionResponse struct {
	ID      string `json:"id"`
	Command string `json:"command"`
	Pid     int    `json:"pid"`
}

// DeleteSessionResponse is the JSON response for DELETE /api/sessions/{id}.
type DeleteSessionResponse struct {
	OK bool `json:"ok"`
}

// Handler returns the HTTP handler for the daemon API.
// Separated from Run() so it can be tested with httptest.
func (d *Daemon) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", d.handleStatus)
	mux.HandleFunc("/api/sessions/", d.handleDeleteSession)
	mux.HandleFunc("/api/sessions", d.handleSessions)
	mux.HandleFunc("/api/bridge/register", d.handleBridgeRegister)
	mux.HandleFunc("/api/bridge/heartbeat", d.handleBridgeHeartbeat)
	mux.HandleFunc("/api/bridge/status", d.handleBridgeStatus)
	mux.HandleFunc("/api/stats", d.handleStats)
	mux.HandleFunc("/api/git/status", d.handleGitStatus)
	mux.HandleFunc("/api/tokens/scoped", d.handleCreateScopedToken)
	if d.extraHandler != nil {
		mux.Handle("/", d.extraHandler)
	}
	return d.authMiddleware(mux)
}

// Run starts the HTTP server and blocks until Stop is called.
func (d *Daemon) Run() error {
	addr := fmt.Sprintf(":%d", d.cfg.Port)
	d.mu.Lock()
	d.server = &http.Server{Addr: addr, Handler: d.Handler()}
	d.mu.Unlock()
	log.Printf("TermLive daemon listening on %s", addr)
	if err := d.server.ListenAndServe(); err != http.ErrServerClosed {
		return err
	}
	return nil
}

// Stop gracefully shuts down the daemon HTTP server.
func (d *Daemon) Stop() error {
	d.mu.Lock()
	srv := d.server
	d.mu.Unlock()
	if srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}

// --- Handlers ---

func (d *Daemon) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sessions := d.mgr.ListSessions()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(StatusResponse{
		Status:   "running",
		Uptime:   time.Since(d.startTime).Truncate(time.Second).String(),
		Port:     d.cfg.Port,
		Sessions: len(sessions),
	})
}

func (d *Daemon) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		d.handleListSessions(w, r)
	case http.MethodPost:
		d.handleCreateSession(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ansiRegex matches ANSI CSI sequences (colors, cursor movement, etc.),
// OSC sequences (title, hyperlinks), and other common escape codes.
var ansiRegex = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z@]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\r`)

// stripANSI removes ANSI escape sequences and control characters from
// terminal output, leaving only printable text suitable for display in HTML.
func stripANSI(s string) string {
	s = ansiRegex.ReplaceAllString(s, "")
	// Remove remaining non-printable control chars (keep newline/tab)
	var b strings.Builder
	for _, r := range s {
		if r == '\n' || r == '\t' || r >= 32 {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (d *Daemon) handleListSessions(w http.ResponseWriter, r *http.Request) {
	sessions := d.mgr.Store().List()
	type sessionInfo struct {
		ID         string `json:"id"`
		Command    string `json:"command"`
		Pid        int    `json:"pid"`
		Status     string `json:"status"`
		Duration   string `json:"duration"`
		LastOutput string `json:"last_output"`
	}
	infos := make([]sessionInfo, len(sessions))
	for i, s := range sessions {
		infos[i] = sessionInfo{
			ID:         s.ID,
			Command:    s.Command,
			Pid:        s.Pid,
			Status:     string(s.Status),
			Duration:   s.Duration().Truncate(time.Second).String(),
			LastOutput: stripANSI(string(s.LastOutput(200))),
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(infos)
}

func (d *Daemon) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req CreateSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Command == "" {
		http.Error(w, "command is required", http.StatusBadRequest)
		return
	}
	if req.Rows == 0 {
		req.Rows = 24
	}
	if req.Cols == 0 {
		req.Cols = 80
	}

	ms, err := d.mgr.CreateSession(req.Command, req.Args, SessionConfig{
		Rows: req.Rows, Cols: req.Cols,
	})
	if err != nil {
		http.Error(w, "failed to create session: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(CreateSessionResponse{
		ID:      ms.Session.ID,
		Command: ms.Session.Command,
		Pid:     ms.Session.Pid,
	})
}

func (d *Daemon) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	if id == "" {
		http.Error(w, "session ID required", http.StatusBadRequest)
		return
	}
	if err := d.mgr.StopSession(id); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(DeleteSessionResponse{OK: true})
}

// --- Bridge API handlers ---

// BridgeRegisterRequest is the JSON body for POST /api/bridge/register.
type BridgeRegisterRequest struct {
	Version        string   `json:"version"`
	CoreMinVersion string   `json:"core_min_version"`
	Channels       []string `json:"channels"`
}

func (d *Daemon) handleBridgeRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req BridgeRegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := d.bridge.Register(req.Version, req.CoreMinVersion, req.Channels); err != nil {
		http.Error(w, "registration failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (d *Daemon) handleBridgeHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	d.bridge.Heartbeat()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (d *Daemon) handleBridgeStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	status := d.bridge.Status()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// --- Stats API handlers ---

// StatsAddRequest is the JSON body for POST /api/stats.
type StatsAddRequest struct {
	InputTokens  int64   `json:"input_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	CostUSD      float64 `json:"cost_usd"`
}

func (d *Daemon) handleStats(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var req StatsAddRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
		d.stats.Add(req.InputTokens, req.OutputTokens, req.CostUSD)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(d.stats.Get())
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// --- Auth middleware ---

const unauthorizedHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TermLive - Unauthorized</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: #0d1117;
    color: #e6edf3;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
}
.card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    padding: 48px;
    max-width: 420px;
    width: 90%;
    text-align: center;
}
.lock-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.6;
}
h1 {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 8px;
    color: #e6edf3;
}
.desc {
    font-size: 14px;
    color: #8b949e;
    margin-bottom: 24px;
    line-height: 1.5;
}
.token-form {
    display: flex;
    gap: 8px;
}
.token-input {
    flex: 1;
    padding: 10px 14px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 8px;
    color: #e6edf3;
    font-size: 14px;
    font-family: monospace;
    outline: none;
    transition: border-color 0.2s;
}
.token-input:focus {
    border-color: #4ecca3;
}
.token-input::placeholder {
    color: #484f58;
}
.submit-btn {
    padding: 10px 20px;
    background: #4ecca3;
    color: #0d1117;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
}
.submit-btn:hover {
    opacity: 0.85;
}
.hint {
    margin-top: 16px;
    font-size: 12px;
    color: #484f58;
}
</style>
</head>
<body>
<div class="card">
    <div class="lock-icon">&#128274;</div>
    <h1>Access Unauthorized</h1>
    <p class="desc">A valid token is required to access TermLive.<br>Check your terminal for the access URL with token.</p>
    <form class="token-form" onsubmit="event.preventDefault();location.href='/?token='+document.getElementById('tk').value;">
        <input id="tk" class="token-input" type="text" placeholder="Paste token here..." autofocus>
        <button class="submit-btn" type="submit">Go</button>
    </form>
    <p class="hint">Token is displayed when you run <code style="color:#8b949e;">tlive run</code></p>
</div>
</body>
</html>`

func (d *Daemon) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check for scoped token via ?stoken= query parameter.
		if stoken := r.URL.Query().Get("stoken"); stoken != "" {
			st, ok := d.tokens.Validate(stoken)
			if !ok {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(unauthorizedHTML))
				return
			}
			// Scoped tokens are read-only — reject mutating methods.
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				http.Error(w, "scoped token is read-only", http.StatusForbidden)
				return
			}
			// Scoped tokens are bound to a specific session. Enforce that the
			// request path refers only to that session (or the session list).
			// Any path under /api/sessions/<id> must match the scoped session.
			const sessPrefix = "/api/sessions/"
			if strings.HasPrefix(r.URL.Path, sessPrefix) {
				requestedID := strings.TrimPrefix(r.URL.Path, sessPrefix)
				// Strip any further path components (e.g. /api/sessions/<id>/ws)
				if idx := strings.Index(requestedID, "/"); idx != -1 {
					requestedID = requestedID[:idx]
				}
				if requestedID != "" && requestedID != st.SessionID {
					http.Error(w, "scoped token not valid for this session", http.StatusForbidden)
					return
				}
			}
			next.ServeHTTP(w, r)
			return
		}

		token := ""
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			token = strings.TrimPrefix(auth, "Bearer ")
		}
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		if token == "" {
			if cookie, err := r.Cookie("tl_token"); err == nil {
				token = cookie.Value
			}
		}
		if token != d.token {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(unauthorizedHTML))
			return
		}
		// Set cookie so browser AJAX/WebSocket requests authenticate automatically
		http.SetCookie(w, &http.Cookie{
			Name:  "tl_token",
			Value: d.token,
			Path:  "/",
		})
		next.ServeHTTP(w, r)
	})
}

// --- Scoped token API handler ---

// CreateScopedTokenRequest is the JSON body for POST /api/tokens/scoped.
type CreateScopedTokenRequest struct {
	SessionID string        `json:"session_id"`
	TTL       time.Duration `json:"ttl"` // nanoseconds; 0 defaults to 1 hour
}

func (d *Daemon) handleCreateScopedToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req CreateScopedTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.SessionID == "" {
		http.Error(w, "session_id is required", http.StatusBadRequest)
		return
	}
	ttl := req.TTL
	if ttl <= 0 {
		ttl = time.Hour
	}
	st := d.tokens.Create(req.SessionID, ttl)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(st)
}
