// Package daemon provides session lifecycle management for the TermLive daemon.
package daemon

import (
	"fmt"
	"io"
	"log"
	"os"
	"sync"
	"time"

	"github.com/termlive/termlive/core/internal/hub"
	"github.com/termlive/termlive/core/internal/pty"
	"github.com/termlive/termlive/core/internal/session"
)

// SessionConfig holds configuration for creating a new managed session.
type SessionConfig struct {
	Rows uint16
	Cols uint16
	Cwd  string // Working directory for the PTY process
}

// ManagedSession ties together a session, its hub, PTY process, and
// a channel that is closed when the process terminates.
type ManagedSession struct {
	Session  *session.Session
	Hub      *hub.Hub
	Proc     pty.Process
	done     chan struct{}
	exitCode int
	resizeFn func(rows, cols uint16)
}

// Done returns a channel that is closed when the process exits.
func (ms *ManagedSession) Done() <-chan struct{} { return ms.done }

// ExitCode blocks until the managed process exits and returns its exit code.
func (ms *ManagedSession) ExitCode() int {
	<-ms.done
	return ms.exitCode
}

// SessionManager coordinates the lifecycle of multiple managed sessions.
type SessionManager struct {
	store       *session.Store
	mu          sync.RWMutex
	managed     map[string]*ManagedSession
	noClientAt  map[string]time.Time // tracks when a session first had 0 clients
}

// NewSessionManager creates a new SessionManager.
func NewSessionManager() *SessionManager {
	return &SessionManager{
		store:      session.NewStore(),
		managed:    make(map[string]*ManagedSession),
		noClientAt: make(map[string]time.Time),
	}
}

// Store returns the underlying session store (for server API compatibility).
func (m *SessionManager) Store() *session.Store {
	return m.store
}

// CreateSession starts a PTY process, creates a hub, wires output
// broadcasting, and registers the session in the manager.
func (m *SessionManager) CreateSession(cmd string, args []string, cfg SessionConfig) (*ManagedSession, error) {
	// 1. Create session
	sess := session.New(cmd, args)

	// 2. Create hub and start its event loop
	h := hub.New()
	go h.Run()

	// 3. Start PTY process with specified working directory
	proc, err := pty.Start(cmd, args, cfg.Rows, cfg.Cols, cfg.Cwd, "TLIVE_SESSION_ID="+sess.ID)
	if err != nil {
		h.Stop()
		return nil, fmt.Errorf("pty start: %w", err)
	}

	// 4. Set session PID, size, and working directory
	sess.Pid = proc.Pid()
	sess.Rows = cfg.Rows
	sess.Cols = cfg.Cols
	if cfg.Cwd != "" {
		sess.Cwd = cfg.Cwd
	} else if cwd, err := os.Getwd(); err == nil {
		sess.Cwd = cwd
	}

	// 5. Set hub input handler to write to PTY
	h.SetInputHandler(func(data []byte) {
		if _, err := proc.Write(data); err != nil {
			log.Printf("write to PTY: %v", err)
		}
	})

	ms := &ManagedSession{
		Session: sess,
		Hub:     h,
		Proc:    proc,
		done:    make(chan struct{}),
		resizeFn: func(rows, cols uint16) {
			if err := proc.Resize(rows, cols); err != nil {
				log.Printf("resize PTY: %v", err)
			}
			sess.SetSize(rows, cols)
		},
	}

	// 6. Goroutine: PTY output -> hub.Broadcast + sess.AppendOutput
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := proc.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				sess.AppendOutput(data)
				h.Broadcast(data)
			}
			if err != nil {
				if err != io.EOF {
					// Read error; process likely exited
				}
				return
			}
		}
	}()

	// 7. Goroutine: proc.Wait() -> close done channel
	go func() {
		code, _ := proc.Wait()
		ms.exitCode = code
		close(ms.done)
	}()

	// 8. Register in internal maps
	m.store.Add(sess)
	m.mu.Lock()
	m.managed[sess.ID] = ms
	m.mu.Unlock()

	// 9. Goroutine: auto-cleanup after process exits
	go func() {
		<-ms.done
		log.Printf("process exited for session %s (code %d), auto-cleaning up", sess.ID, ms.exitCode)
		// Give clients a moment to receive the exit notification
		time.Sleep(5 * time.Second)
		_ = m.StopSession(sess.ID)
	}()

	return ms, nil
}

// GetSession returns a managed session by ID.
func (m *SessionManager) GetSession(id string) (*ManagedSession, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ms, ok := m.managed[id]
	return ms, ok
}

// ListSessions returns all sessions from the underlying store.
func (m *SessionManager) ListSessions() []*session.Session {
	return m.store.List()
}

// Hubs returns a map of session ID to hub for all managed sessions.
func (m *SessionManager) Hubs() map[string]*hub.Hub {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make(map[string]*hub.Hub, len(m.managed))
	for id, ms := range m.managed {
		result[id] = ms.Hub
	}
	return result
}

// StopSession kills the process tree, releases PTY resources, stops the hub,
// and marks the session as stopped. Safe to call multiple times for the same ID
// (second call returns an error but causes no harm).
func (m *SessionManager) StopSession(id string) error {
	m.mu.Lock()
	ms, ok := m.managed[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", id)
	}
	delete(m.managed, id)
	m.mu.Unlock()

	// 1. Kill the entire process tree (children included) to prevent
	//    orphaned processes from holding ConPTY/conhost resources.
	if err := ms.Proc.Kill(); err != nil {
		log.Printf("warning: kill process tree for session %s: %v", id, err)
	}

	// 2. Wait briefly for the process to actually exit so that handles
	//    are safe to close. The Wait goroutine closes ms.done on exit.
	select {
	case <-ms.done:
		// Process exited cleanly.
	case <-time.After(3 * time.Second):
		log.Printf("warning: process for session %s did not exit within 3s", id)
	}

	// 3. Close PTY handles (idempotent).
	if err := ms.Proc.Close(); err != nil {
		log.Printf("warning: closing PTY for session %s: %v", id, err)
	}

	// 4. Stop the hub event loop.
	ms.Hub.Stop()

	// 5. Mark session as stopped and remove from store.
	ms.Session.Status = session.StatusStopped
	m.store.Remove(id)

	return nil
}

// SetResizeFunc registers a resize callback for a session.
func (m *SessionManager) SetResizeFunc(id string, fn func(rows, cols uint16)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ms, ok := m.managed[id]; ok {
		ms.resizeFn = fn
	}
}

// ResizeFunc returns the resize callback for a session.
func (m *SessionManager) ResizeFunc(id string) func(rows, cols uint16) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if ms, ok := m.managed[id]; ok {
		return ms.resizeFn
	}
	return nil
}

// Hub returns the hub for a specific session.
func (m *SessionManager) Hub(id string) *hub.Hub {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if ms, ok := m.managed[id]; ok {
		return ms.Hub
	}
	return nil
}

// ActiveCount returns the number of active (running) managed sessions.
func (m *SessionManager) ActiveCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.managed)
}

// StartReaper launches a goroutine that periodically checks for orphaned
// sessions (sessions with no connected clients for longer than timeout).
// This handles cases where client processes are killed without cleanup.
func (m *SessionManager) StartReaper(timeout time.Duration) {
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			m.mu.Lock()
			var toReap []string
			for id, ms := range m.managed {
				if ms.Hub.ClientCount() == 0 {
					if first, ok := m.noClientAt[id]; ok {
						if time.Since(first) > timeout {
							toReap = append(toReap, id)
						}
					} else {
						m.noClientAt[id] = time.Now()
					}
				} else {
					delete(m.noClientAt, id)
				}
			}
			m.mu.Unlock()

			for _, id := range toReap {
				log.Printf("reaping orphaned session %s (no clients for %v)", id, timeout)
				_ = m.StopSession(id)
				m.mu.Lock()
				delete(m.noClientAt, id)
				m.mu.Unlock()
			}
		}
	}()
}
