package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/termlive/termlive/internal/config"
	"github.com/termlive/termlive/internal/daemon"
	"github.com/termlive/termlive/internal/notify"
	"github.com/termlive/termlive/internal/server"
	"github.com/termlive/termlive/web"

	qrterminal "github.com/mdp/qrterminal/v3"
	"golang.org/x/term"
)

var (
	shortTimeout int
	longTimeout  int
	publicIP     string
)

var runCmd = &cobra.Command{
	Use:   "run <command> [args...]",
	Short: "Run a command with PTY wrapping and Web UI (full mode)",
	Long:  "Start a command inside a PTY with remote Web UI, notifications, and idle detection.",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runCommand,
}

func init() {
	runCmd.Flags().IntVarP(&shortTimeout, "short-timeout", "s", 30, "Short idle timeout for detected prompts (seconds)")
	runCmd.Flags().IntVarP(&longTimeout, "long-timeout", "l", 120, "Long idle timeout for unknown idle (seconds)")
	runCmd.Flags().StringVar(&publicIP, "ip", "", "Override auto-detected LAN IP address")
}

// localOutputClient implements hub.Client to write PTY output to local
// stdout and feed the idle detector. It is registered on the session hub
// so that the SessionManager's output goroutine delivers data here.
type localOutputClient struct {
	writer       *os.File
	idleDetector *notify.SmartIdleDetector
}

func (c *localOutputClient) Send(data []byte) error {
	c.writer.Write(data)
	if c.idleDetector != nil {
		c.idleDetector.Feed(data)
	}
	return nil
}

func runCommand(cmd *cobra.Command, args []string) error {
	// Load config
	cfg := config.Default()
	cfg.Server.Port = port
	cfg.Notify.ShortTimeout = shortTimeout
	cfg.Notify.LongTimeout = longTimeout

	// Detect terminal size
	rows, cols := uint16(24), uint16(80)
	if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
		cols, rows = uint16(w), uint16(h)
	}

	// Create daemon (replaces standalone SessionManager + HTTP server)
	d := daemon.NewDaemon(daemon.DaemonConfig{
		Port:         cfg.Server.Port,
		HistoryLimit: cfg.Notify.Options.HistoryLimit,
	})
	mgr := d.Manager()

	ms, err := mgr.CreateSession(args[0], args[1:], daemon.SessionConfig{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		return fmt.Errorf("failed to start command: %w", err)
	}
	defer mgr.StopSession(ms.Session.ID)

	// Master shutdown context — cancelled on any exit path
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Setup notifiers
	var notifiers []notify.Notifier
	if cfg.Notify.WeChat.WebhookURL != "" {
		notifiers = append(notifiers, notify.NewWeChatNotifier(cfg.Notify.WeChat.WebhookURL))
	}
	if cfg.Notify.Feishu.WebhookURL != "" {
		notifiers = append(notifiers, notify.NewFeishuNotifier(cfg.Notify.Feishu.WebhookURL))
	}
	multiNotifier := notify.NewMultiNotifier(notifiers...)
	d.SetNotifiers(multiNotifier)

	// Setup smart idle detector
	localIP := publicIP
	if localIP == "" {
		localIP = getLocalIP()
	}
	idleDetector := notify.NewSmartIdleDetector(
		time.Duration(cfg.Notify.ShortTimeout)*time.Second,
		time.Duration(cfg.Notify.LongTimeout)*time.Second,
		cfg.Notify.Patterns.AwaitingInput,
		cfg.Notify.Patterns.Processing,
		func(confidence string) {
			msg := &notify.NotifyMessage{
				SessionID:   ms.Session.ID,
				Command:     ms.Session.Command,
				Pid:         ms.Session.Pid,
				Duration:    ms.Session.Duration().Truncate(time.Second).String(),
				LastOutput:  string(ms.Session.LastOutput(200)),
				WebURL:      fmt.Sprintf("http://%s:%d/terminal.html?id=%s", localIP, cfg.Server.Port, ms.Session.ID),
				IdleSeconds: cfg.Notify.ShortTimeout,
				Confidence:  confidence,
			}
			if confidence == "low" {
				msg.IdleSeconds = cfg.Notify.LongTimeout
			}
			if err := multiNotifier.Send(msg); err != nil {
				log.Printf("notification error: %v", err)
			}
		},
	)
	idleDetector.Start()

	// Register local output client on the hub so that PTY output is
	// written to local stdout and fed to the idle detector.
	localClient := &localOutputClient{
		writer:       os.Stdout,
		idleDetector: idleDetector,
	}
	ms.Hub.Register(localClient)
	defer ms.Hub.Unregister(localClient)

	// Set terminal to raw mode for proper input pass-through
	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	rawMode := err == nil

	// Local terminal input -> PTY (exits when ctx cancelled or stdin errors)
	go func() {
		buf := make([]byte, 1024)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				ms.Proc.Write(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()

	// Setup Web UI server as extra handler on the daemon.
	// Pass empty token so the server skips its own auth middleware —
	// the daemon's auth middleware already covers all routes.
	srv := server.New(mgr.Store(), mgr.Hubs(), "")
	srv.SetResizeFunc(ms.Session.ID, func(rows, cols uint16) {
		ms.Proc.Resize(rows, cols)
	})
	srv.SetWebFS(web.Assets)
	d.SetExtraHandler(srv.Handler())

	// Print connection info
	url := fmt.Sprintf("http://%s:%d?token=%s", localIP, cfg.Server.Port, d.Token())
	localURL := fmt.Sprintf("http://localhost:%d?token=%s", cfg.Server.Port, d.Token())
	fmt.Fprintf(os.Stderr, "\n  TermLive Web UI:\n")
	fmt.Fprintf(os.Stderr, "    Local:   %s\n", localURL)
	fmt.Fprintf(os.Stderr, "    Network: %s\n", url)
	fmt.Fprintf(os.Stderr, "  Session: %s (ID: %s)\n\n", ms.Session.Command, ms.Session.ID)
	qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stderr)
	fmt.Fprintln(os.Stderr)

	// Start daemon in goroutine (replaces httpServer.ListenAndServe)
	go d.Run()

	// Wait for process exit or signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	doneCh := make(chan int, 1)
	go func() {
		doneCh <- ms.ExitCode()
	}()

	var exitCode int
	select {
	case exitCode = <-doneCh:
		fmt.Fprintf(os.Stderr, "\n  Process exited with code %d\n", exitCode)
	case sig := <-sigCh:
		fmt.Fprintf(os.Stderr, "\n  Received signal: %v\n", sig)
		ms.Proc.Close()
		exitCode = 130
	}

	// Cleanup: cancel context first to signal all goroutines
	cancel()

	// Restore terminal BEFORE other cleanup (critical for Windows forced close)
	if rawMode {
		term.Restore(int(os.Stdin.Fd()), oldState)
	}

	// Stop idle detector
	idleDetector.Stop()

	// StopSession (hub + PTY + session status) is handled by defer

	// Graceful daemon shutdown (replaces httpServer.Shutdown)
	d.Stop()

	return nil
}

func getLocalIP() string {
	// UDP dial trick: connect to a public IP to find the preferred outbound interface.
	// No actual traffic is sent since UDP is connectionless.
	conn, err := net.DialTimeout("udp4", "8.8.8.8:53", 1*time.Second)
	if err == nil {
		defer conn.Close()
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && addr.IP.To4() != nil && !addr.IP.IsLoopback() {
			return addr.IP.String()
		}
	}

	// Fallback: iterate interfaces
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
