package notify

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWeChatNotify(t *testing.T) {
	var receivedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &receivedBody)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
	}))
	defer server.Close()

	n := NewWeChatNotifier(server.URL)
	msg := &NotifyMessage{
		SessionID:   "abc123",
		Command:     "claude",
		Pid:         12345,
		Duration:    "15m 32s",
		LastOutput:  "? Do you want to proceed? [Y/n]",
		WebURL:      "http://192.168.1.5:8080/s/abc123",
		IdleSeconds: 30,
	}
	err := n.Send(msg)
	if err != nil {
		t.Fatal(err)
	}
	if receivedBody == nil {
		t.Fatal("expected request body")
	}
	if receivedBody["msgtype"] != "markdown" {
		t.Errorf("expected msgtype 'markdown', got %v", receivedBody["msgtype"])
	}
}

func TestWeChatNotifyEmptyURL(t *testing.T) {
	n := NewWeChatNotifier("")
	err := n.Send(&NotifyMessage{})
	if err != nil {
		t.Error("empty URL should be a no-op, not an error")
	}
}
