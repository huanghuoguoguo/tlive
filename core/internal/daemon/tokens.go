package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// ScopedToken represents a short-lived token scoped to a specific session.
type ScopedToken struct {
	Token     string    `json:"token"`
	SessionID string    `json:"session_id"`
	ExpiresAt time.Time `json:"expires_at"`
	ReadOnly  bool      `json:"read_only"`
}

// IsExpired reports whether the token has passed its expiry time.
func (st *ScopedToken) IsExpired() bool {
	return time.Now().After(st.ExpiresAt)
}

// TokenStore holds scoped tokens in memory with thread-safe access.
type TokenStore struct {
	mu     sync.RWMutex
	tokens map[string]*ScopedToken
}

// NewTokenStore creates an empty TokenStore.
func NewTokenStore() *TokenStore {
	return &TokenStore{
		tokens: make(map[string]*ScopedToken),
	}
}

// Create generates a new scoped token for sessionID with the given TTL.
// The token string is a 32-character lowercase hex value (16 random bytes).
// Tokens are always read-only.
func (ts *TokenStore) Create(sessionID string, ttl time.Duration) *ScopedToken {
	b := make([]byte, 16)
	rand.Read(b)
	tok := &ScopedToken{
		Token:     hex.EncodeToString(b),
		SessionID: sessionID,
		ExpiresAt: time.Now().Add(ttl),
		ReadOnly:  true,
	}
	ts.mu.Lock()
	ts.tokens[tok.Token] = tok
	ts.mu.Unlock()
	return tok
}

// Validate looks up token and returns the ScopedToken if it exists and has
// not expired. Returns (nil, false) for unknown or expired tokens.
func (ts *TokenStore) Validate(token string) (*ScopedToken, bool) {
	ts.mu.RLock()
	st, ok := ts.tokens[token]
	ts.mu.RUnlock()
	if !ok || st.IsExpired() {
		return nil, false
	}
	return st, true
}

// Cleanup removes all expired tokens from the store.
func (ts *TokenStore) Cleanup() {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	for k, st := range ts.tokens {
		if st.IsExpired() {
			delete(ts.tokens, k)
		}
	}
}
