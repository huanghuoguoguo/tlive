package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDaemon_NotifyEndpoint(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "test-token"})
	handler := d.Handler()

	// POST /api/notify without auth -> 401
	req := httptest.NewRequest("POST", "/api/notify", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}

	// POST /api/notify with auth -> 200
	body := `{"type":"done","message":"Task completed"}`
	req = httptest.NewRequest("POST", "/api/notify", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp NotifyResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.ID == "" {
		t.Fatal("expected non-empty notification ID")
	}
}

func TestDaemon_NotificationsEndpoint(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "test-token"})
	d.notifications.Add("done", "msg1", "")
	d.notifications.Add("error", "msg2", "")

	handler := d.Handler()
	req := httptest.NewRequest("GET", "/api/notifications?limit=10", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp NotificationsResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Total != 2 {
		t.Fatalf("expected total 2, got %d", resp.Total)
	}
	if len(resp.Notifications) != 2 {
		t.Fatalf("expected 2 notifications, got %d", len(resp.Notifications))
	}
}

func TestDaemon_StatusEndpoint(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 8080, Token: "t"})
	handler := d.Handler()

	req := httptest.NewRequest("GET", "/api/status", nil)
	req.Header.Set("Authorization", "Bearer t")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp StatusResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "running" {
		t.Fatalf("expected status 'running', got %q", resp.Status)
	}
}

func TestDaemon_CreateSessionEndpoint(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "test-token"})
	handler := d.Handler()

	body := `{"command":"echo","args":["hello"],"rows":24,"cols":80}`
	req := httptest.NewRequest("POST", "/api/sessions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp CreateSessionResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.ID == "" {
		t.Fatal("expected non-empty session ID")
	}
	if resp.Command != "echo" {
		t.Errorf("expected command 'echo', got %q", resp.Command)
	}
}

func TestDaemon_UnauthorizedReturnsHTML(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "secret"})
	handler := d.Handler()

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	ct := w.Header().Get("Content-Type")
	if !strings.Contains(ct, "text/html") {
		t.Errorf("expected text/html content type, got %q", ct)
	}
	body := w.Body.String()
	if !strings.Contains(body, "<html") {
		t.Error("expected HTML response body")
	}
	if !strings.Contains(body, "token") {
		t.Error("expected token reference in response")
	}
}

func TestDaemon_DeleteSessionEndpoint(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "test-token"})
	handler := d.Handler()

	// Create a session first
	body := `{"command":"echo","args":["hello"],"rows":24,"cols":80}`
	req := httptest.NewRequest("POST", "/api/sessions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	var created CreateSessionResponse
	json.NewDecoder(w.Body).Decode(&created)

	// Delete it
	req = httptest.NewRequest("DELETE", "/api/sessions/"+created.ID, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
