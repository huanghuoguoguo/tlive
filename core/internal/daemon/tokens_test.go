package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestTokenStore_Create verifies that Create returns a non-empty token string
// and a future expiry time.
func TestTokenStore_Create(t *testing.T) {
	ts := NewTokenStore()
	st := ts.Create("session-abc", 5*time.Minute)
	if st == nil {
		t.Fatal("expected non-nil ScopedToken")
	}
	if len(st.Token) != 32 {
		t.Errorf("expected 32-char hex token, got len=%d token=%q", len(st.Token), st.Token)
	}
	if st.SessionID != "session-abc" {
		t.Errorf("expected session_id 'session-abc', got %q", st.SessionID)
	}
	if !st.ExpiresAt.After(time.Now()) {
		t.Error("expected ExpiresAt to be in the future")
	}
	if !st.ReadOnly {
		t.Error("expected ReadOnly to be true")
	}
}

// TestTokenStore_Validate verifies that a freshly created token validates
// successfully and returns the correct session ID.
func TestTokenStore_Validate(t *testing.T) {
	ts := NewTokenStore()
	st := ts.Create("session-xyz", 5*time.Minute)

	got, ok := ts.Validate(st.Token)
	if !ok {
		t.Fatal("expected Validate to return true for valid token")
	}
	if got == nil {
		t.Fatal("expected non-nil ScopedToken from Validate")
	}
	if got.SessionID != "session-xyz" {
		t.Errorf("expected session_id 'session-xyz', got %q", got.SessionID)
	}
}

// TestTokenStore_Expired verifies that a token created with 0 TTL is
// immediately expired and Validate returns false.
func TestTokenStore_Expired(t *testing.T) {
	ts := NewTokenStore()
	// 0 TTL → ExpiresAt = time.Now(), which is already in the past by the time
	// Validate is called. Use a tiny negative duration to be safe.
	st := ts.Create("session-exp", -time.Millisecond)

	_, ok := ts.Validate(st.Token)
	if ok {
		t.Error("expected Validate to return false for expired token")
	}
}

// TestTokenStore_Cleanup verifies that Cleanup removes expired tokens but
// leaves valid ones in place.
func TestTokenStore_Cleanup(t *testing.T) {
	ts := NewTokenStore()
	expired := ts.Create("session-old", -time.Millisecond)
	valid := ts.Create("session-new", 5*time.Minute)

	ts.Cleanup()

	// expired token should be gone
	if _, ok := ts.Validate(expired.Token); ok {
		t.Error("expected expired token to be removed by Cleanup")
	}
	// valid token should still be present
	if _, ok := ts.Validate(valid.Token); !ok {
		t.Error("expected valid token to survive Cleanup")
	}
}

// TestScopedTokenAPI_Create verifies that POST /api/tokens/scoped with a valid
// main token returns 200 and a scoped token JSON payload.
func TestScopedTokenAPI_Create(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "main-token"})
	handler := d.Handler()

	body := `{"session_id":"abc"}`
	req := httptest.NewRequest(http.MethodPost, "/api/tokens/scoped", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer main-token")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp ScopedToken
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if len(resp.Token) != 32 {
		t.Errorf("expected 32-char token, got len=%d", len(resp.Token))
	}
	if resp.SessionID != "abc" {
		t.Errorf("expected session_id 'abc', got %q", resp.SessionID)
	}
	if !resp.ReadOnly {
		t.Error("expected read_only to be true")
	}
}

// TestScopedTokenAPI_Create_RequiresMainToken verifies that the endpoint
// rejects requests without the main auth token.
func TestScopedTokenAPI_Create_RequiresMainToken(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "main-token"})
	handler := d.Handler()

	body := `{"session_id":"abc"}`
	req := httptest.NewRequest(http.MethodPost, "/api/tokens/scoped", strings.NewReader(body))
	// no Authorization header
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

// TestScopedTokenAuth verifies that a request with ?stoken=<valid_scoped_token>
// passes auth for the matching session URL and gets 403 for other sessions.
func TestScopedTokenAuth(t *testing.T) {
	d := NewDaemon(DaemonConfig{Port: 0, Token: "main-token"})

	// Pre-create a scoped token directly via the store.
	st := d.tokens.Create("session-allowed", 5*time.Minute)

	handler := d.Handler()

	t.Run("allowed session passes", func(t *testing.T) {
		// GET /api/sessions — scoped token allows read-only access.
		// The middleware admits the request; the handler returns a list.
		req := httptest.NewRequest(http.MethodGet, "/api/sessions?stoken="+st.Token, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code == http.StatusUnauthorized {
			t.Fatalf("expected scoped token to pass auth, got 401")
		}
	})

	t.Run("wrong session gets 403", func(t *testing.T) {
		// Accessing a different session path with a scoped token should yield 403.
		req := httptest.NewRequest(http.MethodGet, "/api/sessions/other-session?stoken="+st.Token, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for out-of-scope session access, got %d", w.Code)
		}
	})

	t.Run("invalid stoken gets 401", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/sessions?stoken=deadbeefdeadbeefdeadbeefdeadbeef", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for invalid stoken, got %d", w.Code)
		}
	})

	t.Run("write via scoped token gets 403", func(t *testing.T) {
		body := `{"session_id":"session-allowed"}`
		req := httptest.NewRequest(http.MethodPost, "/api/tokens/scoped?stoken="+st.Token, strings.NewReader(body))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for write attempt via scoped token, got %d", w.Code)
		}
	})
}
