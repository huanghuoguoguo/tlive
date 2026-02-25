package daemon

import (
	"fmt"
	"runtime"
	"testing"
	"time"

	"github.com/termlive/termlive/internal/session"
)

func testCommand() (string, []string) {
	if runtime.GOOS == "windows" {
		return "cmd.exe", []string{"/C", "echo hello"}
	}
	return "echo", []string{"hello"}
}

func TestCreateAndStopSession(t *testing.T) {
	mgr := NewSessionManager()

	cmd, args := testCommand()
	cfg := SessionConfig{Rows: 24, Cols: 80}

	ms, err := mgr.CreateSession(cmd, args, cfg)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	// Verify session fields
	if ms.Session == nil {
		t.Fatal("ManagedSession.Session is nil")
	}
	if ms.Session.Command != cmd {
		t.Errorf("expected command %q, got %q", cmd, ms.Session.Command)
	}
	if ms.Session.Status != session.StatusRunning {
		t.Errorf("expected status %q, got %q", session.StatusRunning, ms.Session.Status)
	}
	if ms.Session.Pid == 0 {
		t.Error("expected non-zero PID")
	}
	if ms.Hub == nil {
		t.Error("ManagedSession.Hub is nil")
	}
	if ms.Proc == nil {
		t.Error("ManagedSession.Proc is nil")
	}

	// Verify GetSession works
	got, ok := mgr.GetSession(ms.Session.ID)
	if !ok {
		t.Fatal("GetSession returned false for existing session")
	}
	if got.Session.ID != ms.Session.ID {
		t.Errorf("GetSession returned wrong session ID: %q vs %q", got.Session.ID, ms.Session.ID)
	}

	// Verify ListSessions includes it
	list := mgr.ListSessions()
	if len(list) != 1 {
		t.Fatalf("expected 1 session in list, got %d", len(list))
	}

	// Verify Hubs map
	hubs := mgr.Hubs()
	if _, ok := hubs[ms.Session.ID]; !ok {
		t.Error("Hubs map does not contain session ID")
	}

	// Verify Store returns the underlying store
	if mgr.Store() == nil {
		t.Error("Store() returned nil")
	}

	// Wait for the echo command to finish (it's short-lived)
	exitCode := ms.ExitCode()
	if exitCode != 0 {
		t.Errorf("expected exit code 0, got %d", exitCode)
	}

	// Stop the session
	err = mgr.StopSession(ms.Session.ID)
	if err != nil {
		t.Fatalf("StopSession failed: %v", err)
	}

	// Verify status changed to stopped
	if ms.Session.Status != session.StatusStopped {
		t.Errorf("expected status %q after stop, got %q", session.StatusStopped, ms.Session.Status)
	}

	// Verify session removed from managed map after stop
	_, ok = mgr.GetSession(ms.Session.ID)
	if ok {
		t.Error("expected GetSession to return false after StopSession")
	}

	// Verify session still visible in store (for API status reporting)
	list = mgr.ListSessions()
	if len(list) != 1 {
		t.Errorf("expected session to remain in store after stop, got %d sessions", len(list))
	}
}

func TestStopNonexistentSession(t *testing.T) {
	mgr := NewSessionManager()

	err := mgr.StopSession("nonexistent-id")
	if err == nil {
		t.Fatal("expected error when stopping nonexistent session, got nil")
	}
}

func TestSessionOutput(t *testing.T) {
	mgr := NewSessionManager()

	cmd, args := testCommand()
	cfg := SessionConfig{Rows: 24, Cols: 80}

	ms, err := mgr.CreateSession(cmd, args, cfg)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	// Wait for the process to finish so output is captured
	ms.ExitCode()

	// Give a small window for the output goroutine to flush
	deadline := time.After(5 * time.Second)
	for {
		output := ms.Session.LastOutput(4096)
		if len(output) > 0 {
			t.Logf("captured output (%d bytes): %q", len(output), string(output))
			break
		}
		select {
		case <-deadline:
			t.Fatal("timed out waiting for session output")
		default:
			time.Sleep(50 * time.Millisecond)
		}
	}

	// Cleanup
	_ = mgr.StopSession(ms.Session.ID)
}

func TestExitCodeMultipleCallers(t *testing.T) {
	mgr := NewSessionManager()

	cmd, args := testCommand()
	cfg := SessionConfig{Rows: 24, Cols: 80}

	ms, err := mgr.CreateSession(cmd, args, cfg)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	// Call ExitCode from multiple goroutines to verify channel-close pattern
	errc := make(chan error, 3)
	for i := 0; i < 3; i++ {
		go func() {
			code := ms.ExitCode()
			if code != 0 {
				errc <- fmt.Errorf("expected exit code 0, got %d", code)
				return
			}
			errc <- nil
		}()
	}

	for i := 0; i < 3; i++ {
		select {
		case err := <-errc:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for ExitCode caller")
		}
	}

	// Cleanup
	_ = mgr.StopSession(ms.Session.ID)
}
