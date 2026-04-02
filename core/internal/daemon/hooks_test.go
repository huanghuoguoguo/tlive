package daemon

import (
	"encoding/json"
	"testing"
	"time"
)

func TestHookManager_AddPermission_UniqueID(t *testing.T) {
	hm := NewHookManager()

	req1 := hm.AddPermission("Bash", json.RawMessage(`{"command":"ls"}`), "", nil)
	req2 := hm.AddPermission("Read", json.RawMessage(`{"file_path":"/tmp/foo"}`), "", nil)

	if req1.ID == "" {
		t.Fatal("expected non-empty ID for req1")
	}
	if req2.ID == "" {
		t.Fatal("expected non-empty ID for req2")
	}
	if req1.ID == req2.ID {
		t.Fatalf("expected unique IDs, got %q for both", req1.ID)
	}
	if req1.ToolName != "Bash" {
		t.Errorf("expected tool_name 'Bash', got %q", req1.ToolName)
	}
}

func TestHookManager_WaitForResolution_Allow(t *testing.T) {
	hm := NewHookManager()
	req := hm.AddPermission("Bash", json.RawMessage(`{"command":"echo hi"}`), "", nil)

	go func() {
		time.Sleep(20 * time.Millisecond)
		hm.Resolve(req.ID, "allow", nil)
	}()

	result := hm.WaitForResolution(req)
	if result.Decision != "allow" {
		t.Errorf("expected 'allow', got %q", result.Decision)
	}
}

func TestHookManager_WaitForResolution_Timeout(t *testing.T) {
	hm := NewHookManager()
	// Override timeout to something very short for the test
	hm.timeout = 50 * time.Millisecond

	req := hm.AddPermission("Bash", json.RawMessage(`{"command":"sleep 100"}`), "", nil)

	start := time.Now()
	result := hm.WaitForResolution(req)
	elapsed := time.Since(start)

	if result.Decision != "deny" {
		t.Errorf("expected 'deny' on timeout, got %q", result.Decision)
	}
	if elapsed > 500*time.Millisecond {
		t.Errorf("expected timeout within 500ms, took %v", elapsed)
	}
}

func TestHookManager_Resolve_UnknownID(t *testing.T) {
	hm := NewHookManager()
	ok := hm.Resolve("nonexistent-id", "allow", nil)
	if ok {
		t.Error("expected false for unknown ID, got true")
	}
}

func TestHookManager_ListPending(t *testing.T) {
	hm := NewHookManager()

	if pending := hm.ListPending(); len(pending) != 0 {
		t.Fatalf("expected 0 pending, got %d", len(pending))
	}

	req1 := hm.AddPermission("Bash", json.RawMessage(`{}`), "", nil)
	req2 := hm.AddPermission("Read", json.RawMessage(`{}`), "", nil)

	pending := hm.ListPending()
	if len(pending) != 2 {
		t.Fatalf("expected 2 pending, got %d", len(pending))
	}

	// Collect IDs
	ids := map[string]bool{}
	for _, p := range pending {
		ids[p.ID] = true
	}
	if !ids[req1.ID] {
		t.Errorf("expected req1 ID %q in pending list", req1.ID)
	}
	if !ids[req2.ID] {
		t.Errorf("expected req2 ID %q in pending list", req2.ID)
	}
}
