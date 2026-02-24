package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/termlive/termlive/internal/config"
	"github.com/termlive/termlive/internal/hub"
	"github.com/termlive/termlive/internal/notify"
	ptyPkg "github.com/termlive/termlive/internal/pty"
	"github.com/termlive/termlive/internal/server"
	"github.com/termlive/termlive/internal/session"
	"github.com/termlive/termlive/web"

	qrterminal "github.com/mdp/qrterminal/v3"
	"golang.org/x/term"
)

func runCommand(cmd *cobra.Command, args []string) error {
	// Load config
	cfg := config.Default()
	cfg.Server.Port = port
	cfg.Notify.IdleTimeout = idleTimeout

	// Create session
	store := session.NewStore()
	sess := session.New(args[0], args[1:])
	store.Add(sess)

	// Create hub
	h := hub.New()
	go h.Run()
	hubs := map[string]*hub.Hub{sess.ID: h}

	// Start PTY
	proc, err := ptyPkg.Start(args[0], args[1:], 24, 80)
	if err != nil {
		return fmt.Errorf("failed to start command: %w", err)
	}
	sess.Pid = proc.Pid()

	// Hub input -> PTY
	h.SetInputHandler(func(data []byte) {
		proc.Write(data)
	})

	// Setup notifiers
	var notifiers []notify.Notifier
	if cfg.Notify.WeChat.WebhookURL != "" {
		notifiers = append(notifiers, notify.NewWeChatNotifier(cfg.Notify.WeChat.WebhookURL))
	}
	if cfg.Notify.Feishu.WebhookURL != "" {
		notifiers = append(notifiers, notify.NewFeishuNotifier(cfg.Notify.Feishu.WebhookURL))
	}
	multiNotifier := notify.NewMultiNotifier(notifiers...)

	// Setup idle detector
	localIP := getLocalIP()
	idleDetector := notify.NewIdleDetector(
		time.Duration(cfg.Notify.IdleTimeout)*time.Second,
		func() {
			msg := &notify.NotifyMessage{
				SessionID:   sess.ID,
				Command:     sess.Command,
				Pid:         sess.Pid,
				Duration:    sess.Duration().Truncate(time.Second).String(),
				LastOutput:  string(sess.LastOutput(200)),
				WebURL:      fmt.Sprintf("http://%s:%d/terminal.html?id=%s", localIP, cfg.Server.Port, sess.ID),
				IdleSeconds: cfg.Notify.IdleTimeout,
			}
			if err := multiNotifier.Send(msg); err != nil {
				log.Printf("notification error: %v", err)
			}
		},
	)
	idleDetector.Start()

	// PTY output -> local terminal + hub + session buffer
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := proc.Read(buf)
			if n > 0 {
				data := buf[:n]
				os.Stdout.Write(data)
				h.Broadcast(data)
				sess.AppendOutput(data)
				idleDetector.Reset()
			}
			if err != nil {
				break
			}
		}
	}()

	// Set terminal to raw mode for proper input pass-through
	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err == nil {
		defer term.Restore(int(os.Stdin.Fd()), oldState)
	}

	// Local terminal input -> PTY
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				proc.Write(buf[:n])
			}
			if err != nil {
				break
			}
		}
	}()

	// Start HTTP server with embedded web assets
	token := generateToken()
	srv := server.New(store, hubs, token)
	srv.SetResizeFunc(sess.ID, func(rows, cols uint16) {
		proc.Resize(rows, cols)
	})
	srv.SetWebFS(web.Assets)
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)

	url := fmt.Sprintf("http://%s:%d?token=%s", localIP, cfg.Server.Port, token)
	fmt.Fprintf(os.Stderr, "\n  TermLive Web UI: %s\n", url)
	fmt.Fprintf(os.Stderr, "  Session: %s (ID: %s)\n\n", sess.Command, sess.ID)
	qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stderr)
	fmt.Fprintln(os.Stderr)

	httpServer := &http.Server{Addr: addr, Handler: srv.Handler()}
	go httpServer.ListenAndServe()

	// Wait for process exit or signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	doneCh := make(chan int, 1)
	go func() {
		code, _ := proc.Wait()
		doneCh <- code
	}()

	var exitCode int
	select {
	case exitCode = <-doneCh:
		fmt.Fprintf(os.Stderr, "\n  Process exited with code %d\n", exitCode)
	case sig := <-sigCh:
		fmt.Fprintf(os.Stderr, "\n  Received signal: %v\n", sig)
		proc.Close()
		exitCode = 130
	}

	// Cleanup
	idleDetector.Stop()
	h.Stop()
	sess.Status = session.StatusStopped
	httpServer.Close()

	return nil
}

func getLocalIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() && ipnet.IP.To4() != nil {
			return ipnet.IP.String()
		}
	}
	return "127.0.0.1"
}

func generateToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
