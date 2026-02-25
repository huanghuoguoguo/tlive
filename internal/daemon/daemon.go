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

// Handler returns the HTTP handler for the daemon API.
// Separated from Run() so it can be tested with httptest.
func (d *Daemon) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/notify", d.handleNotify)
	mux.HandleFunc("/api/notifications", d.handleNotifications)
	mux.HandleFunc("/api/status", d.handleStatus)
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

// --- Auth middleware ---

func (d *Daemon) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := ""
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			token = strings.TrimPrefix(auth, "Bearer ")
		}
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		if token != d.token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
