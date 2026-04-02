package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"
)

// HookResolution carries the decision and optional updatedInput back to Claude Code
type HookResolution struct {
	Decision     string          `json:"decision"`
	UpdatedInput json.RawMessage `json:"updated_input,omitempty"`
}

// HookPermissionRequest represents a pending permission request from a Claude Code hook
type HookPermissionRequest struct {
	ID          string          `json:"id"`
	ToolName    string          `json:"tool_name"`
	Input       json.RawMessage `json:"input"`
	SessionID   string          `json:"session_id,omitempty"`
	Suggestions json.RawMessage `json:"permission_suggestions,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	Resolved    bool            `json:"-"`
	Result      chan HookResolution `json:"-"` // receives resolution with decision + optional updatedInput
}

// HookManager manages pending hook permission requests
type HookManager struct {
	mu      sync.RWMutex
	pending map[string]*HookPermissionRequest
	timeout time.Duration // 295 seconds (slightly less than hook script's 300s)
}

func NewHookManager() *HookManager {
	return &HookManager{
		pending: make(map[string]*HookPermissionRequest),
		timeout: 295 * time.Second,
	}
}

// AddPermission stores a pending permission and returns the request
func (hm *HookManager) AddPermission(toolName string, input json.RawMessage, sessionID string, suggestions json.RawMessage) *HookPermissionRequest {
	b := make([]byte, 8)
	rand.Read(b)
	id := hex.EncodeToString(b)

	req := &HookPermissionRequest{
		ID:          id,
		ToolName:    toolName,
		Input:       input,
		SessionID:   sessionID,
		Suggestions: suggestions,
		CreatedAt:   time.Now(),
		Result:      make(chan HookResolution, 1),
	}

	hm.mu.Lock()
	hm.pending[id] = req
	hm.mu.Unlock()

	return req
}

// WaitForResolution blocks until resolved or timeout. Returns a HookResolution.
func (hm *HookManager) WaitForResolution(req *HookPermissionRequest) HookResolution {
	ctx, cancel := context.WithTimeout(context.Background(), hm.timeout)
	defer cancel()
	defer func() {
		hm.mu.Lock()
		delete(hm.pending, req.ID)
		hm.mu.Unlock()
	}()

	select {
	case result := <-req.Result:
		return result
	case <-ctx.Done():
		// Timeout → deny for safety
		return HookResolution{Decision: "deny"}
	}
}

// Resolve resolves a pending permission
func (hm *HookManager) Resolve(id string, decision string, updatedInput json.RawMessage) bool {
	hm.mu.RLock()
	req, ok := hm.pending[id]
	hm.mu.RUnlock()
	if !ok {
		return false
	}

	select {
	case req.Result <- HookResolution{Decision: decision, UpdatedInput: updatedInput}:
		return true
	default:
		return false
	}
}

// ListPending returns all unresolved permissions
func (hm *HookManager) ListPending() []*HookPermissionRequest {
	hm.mu.RLock()
	defer hm.mu.RUnlock()

	result := make([]*HookPermissionRequest, 0)
	for _, req := range hm.pending {
		result = append(result, req)
	}
	return result
}
