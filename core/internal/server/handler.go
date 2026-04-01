package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Token-based auth middleware already protects all routes,
		// so allow any origin that passed authentication.
		return true
	},
}

// wsControlMessage represents a JSON control message sent over WebSocket.
type wsControlMessage struct {
	Type string `json:"type"`
	Rows uint16 `json:"rows"`
	Cols uint16 `json:"cols"`
}

// handleWebSocket handles WebSocket connections for terminal sessions at /ws/session/<id>.
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimPrefix(r.URL.Path, "/ws/session/")
	// Strip any trailing path segments (only first component is the session ID).
	if idx := strings.Index(sessionID, "/"); idx != -1 {
		sessionID = sessionID[:idx]
	}
	ms, ok := s.mgr.GetSession(sessionID)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	h := ms.Hub
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := NewWSClient(conn)

	// Send current PTY size so web client can match it
	if rows, cols := ms.Session.Size(); rows > 0 && cols > 0 {
		sizeMsg, _ := json.Marshal(map[string]interface{}{
			"type": "size",
			"rows": rows,
			"cols": cols,
		})
		client.SendText(sizeMsg)
	}

	// Replay buffered output so the browser sees prior ANSI
	// style/color sequences and existing terminal content.
	if buf := ms.Session.LastOutput(64 * 1024); len(buf) > 0 {
		client.Send(buf)
	}

	h.Register(client)
	defer func() {
		h.Unregister(client)
		client.Close()
	}()

	// Watch for process exit and notify this client via text frame.
	go func() {
		<-ms.Done()
		exitMsg, _ := json.Marshal(map[string]interface{}{
			"type": "exit",
			"code": ms.ExitCode(),
		})
		client.SendText(exitMsg)
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var ctrl wsControlMessage
		if json.Unmarshal(msg, &ctrl) == nil && ctrl.Type == "resize" {
			if fn := s.mgr.ResizeFunc(sessionID); fn != nil {
				fn(ctrl.Rows, ctrl.Cols)
			}
			continue
		}
		h.Input(msg)
	}
}

