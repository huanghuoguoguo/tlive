// Package daemon provides session lifecycle management for the TermLive daemon.
package daemon

import (
	"fmt"
	"io"
	"log"
	"sync"

	"github.com/termlive/termlive/internal/hub"
	"github.com/termlive/termlive/internal/pty"
	"github.com/termlive/termlive/internal/session"
)

// SessionConfig holds configuration for creating a new managed session.
type SessionConfig struct {
	Rows uint16
	Cols uint16
}

// ManagedSession ties together a session, its hub, PTY process, and
// a channel that is closed when the process terminates.
type ManagedSession struct {
	Session  *session.Session
	Hub      *hub.Hub
	Proc     pty.Process
	done     chan struct{}
	exitCode int
}

// ExitCode blocks until the managed process exits and returns its exit code.
func (ms *ManagedSession) ExitCode() int {
	<-ms.done
	return ms.exitCode
}

// SessionManager coordinates the lifecycle of multiple managed sessions.
type SessionManager struct {
	store    *session.Store
	mu       sync.RWMutex
	managed  map[string]*ManagedSession
}

// NewSessionManager creates a new SessionManager.
func NewSessionManager() *SessionManager {
	return &SessionManager{
		store:   session.NewStore(),
		managed: make(map[string]*ManagedSession),
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

	// 3. Start PTY process
	proc, err := pty.Start(cmd, args, cfg.Rows, cfg.Cols)
	if err != nil {
		h.Stop()
		return nil, fmt.Errorf("pty start: %w", err)
	}

	// 4. Set session PID
	sess.Pid = proc.Pid()

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

// StopSession closes the PTY, stops the hub, and marks the session as stopped.
func (m *SessionManager) StopSession(id string) error {
	m.mu.Lock()
	ms, ok := m.managed[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", id)
	}
	delete(m.managed, id)
	m.mu.Unlock()

	// Close PTY process
	if err := ms.Proc.Close(); err != nil {
		log.Printf("warning: closing PTY for session %s: %v", id, err)
	}

	// Stop the hub event loop
	ms.Hub.Stop()

	// Mark session as stopped
	ms.Session.Status = session.StatusStopped

	return nil
}
