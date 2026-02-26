package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/termlive/termlive/internal/notify"
)

// DaemonConfig holds configuration for the daemon HTTP server.
type DaemonConfig struct {
	Port         int
	Token        string
	HistoryLimit int
}

// Daemon is the TermLive notification hub. It receives notifications via
// HTTP API and relays them to configured channels (WeChat, Feishu, Web UI).
type Daemon struct {
	cfg           DaemonConfig
	mgr           *SessionManager
	notifications *NotificationStore
	notifier      *notify.MultiNotifier
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

// SetNotifiers configures external notification channels (WeChat, Feishu, etc.).
func (d *Daemon) SetNotifiers(n *notify.MultiNotifier) {
	d.notifier = n
}

// SetExtraHandler sets an additional HTTP handler that serves routes
// not handled by the daemon's own API (e.g., Web UI, WebSocket).
// Must be called before Run() or Handler().
func (d *Daemon) SetExtraHandler(h http.Handler) {
	d.extraHandler = h
}

// --- HTTP API types ---

// NotifyRequest is the JSON body for POST /api/notify.
type NotifyRequest struct {
	Type    NotificationType `json:"type"`
	Message string           `json:"message"`
	Context string           `json:"context,omitempty"`
}

// NotifyResponse is the JSON response for POST /api/notify.
type NotifyResponse struct {
	ID        string    `json:"id"`
	Timestamp time.Time `json:"timestamp"`
}

// NotificationsResponse is the JSON response for GET /api/notifications.
type NotificationsResponse struct {
	Notifications []Notification `json:"notifications"`
	Total         int            `json:"total"`
}

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
	mux.HandleFunc("/api/notify", d.handleNotify)
	mux.HandleFunc("/api/notifications", d.handleNotifications)
	mux.HandleFunc("/api/status", d.handleStatus)
	mux.HandleFunc("/api/sessions/", d.handleDeleteSession)
	mux.HandleFunc("/api/sessions", d.handleCreateSession)
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

func (d *Daemon) handleNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req NotifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Type == "" || req.Message == "" {
		http.Error(w, "type and message are required", http.StatusBadRequest)
		return
	}
	n := d.notifications.Add(req.Type, req.Message, req.Context)

	// Relay to external notification channels
	if d.notifier != nil {
		relayMsg := &notify.NotifyMessage{
			Command:    string(req.Type),
			LastOutput: req.Message,
			Confidence: "high",
		}
		if req.Context != "" {
			relayMsg.LastOutput = req.Message + "\n\n" + req.Context
		}
		if err := d.notifier.Send(relayMsg); err != nil {
			log.Printf("notification relay error: %v", err)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(NotifyResponse{
		ID:        n.ID,
		Timestamp: n.Timestamp,
	})
}

func (d *Daemon) handleNotifications(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	items := d.notifications.List(limit)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(NotificationsResponse{
		Notifications: items,
		Total:         len(items),
	})
}

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

func (d *Daemon) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
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
