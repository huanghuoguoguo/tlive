package main

import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"
	"github.com/termlive/termlive/core/internal/config"
	"github.com/termlive/termlive/core/internal/daemon"
	"github.com/termlive/termlive/core/internal/server"
	"github.com/termlive/termlive/core/web"
)

var daemonCmd = &cobra.Command{
	Use:   "daemon",
	Short: "Start the TLive daemon (HTTP API + Web UI)",
	RunE:  runDaemon,
}

func init() {
	rootCmd.AddCommand(daemonCmd)
}

func runDaemon(cmd *cobra.Command, args []string) error {
	cfg, _ := config.LoadFromEnv()

	// CLI flags override config values
	if cmd.Flags().Changed("port") {
		cfg.Daemon.Port = port
	}
	if cmd.Flags().Changed("token") && token != "" {
		cfg.Daemon.Token = token
	}

	lockPath := daemon.DefaultLockPath()

	// Check if already running
	lock, err := daemon.ReadLockFile(lockPath)
	if err == nil {
		if daemonHealthCheck(lock.Port, lock.Token) {
			return fmt.Errorf("daemon already running on port %d (PID %d)", lock.Port, lock.Pid)
		}
		daemon.RemoveLockFile(lockPath)
	}

	// Create daemon
	d := daemon.NewDaemon(daemon.DaemonConfig{
		Port:  cfg.Daemon.Port,
		Token: cfg.Daemon.Token,
		Host:  "0.0.0.0", // Listen on all interfaces for LAN access
	})

	// Setup Web UI
	localIP := publicIP
	if localIP == "" {
		localIP = getLocalIP()
	}
	srv := server.New(d.Manager())
	srv.SetWebFS(web.Assets)
	d.SetExtraHandler(srv.Handler())

	// Write lock file
	daemon.WriteLockFile(lockPath, daemon.LockInfo{
		Port:  cfg.Daemon.Port,
		Token: d.Token(),
		Pid:   os.Getpid(),
	})
	defer daemon.RemoveLockFile(lockPath)

	// Print connection info
	url := fmt.Sprintf("http://%s:%d?token=%s", localIP, cfg.Daemon.Port, d.Token())
	localURL := fmt.Sprintf("http://localhost:%d?token=%s", cfg.Daemon.Port, d.Token())
	fmt.Fprintf(os.Stderr, "\n  TLive Daemon:\n")
	fmt.Fprintf(os.Stderr, "    Local:   %s\n", localURL)
	fmt.Fprintf(os.Stderr, "    Network: %s\n", url)
	fmt.Fprintf(os.Stderr, "\n")

	// Handle signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Start daemon in goroutine
	errCh := make(chan error, 1)
	go func() {
		errCh <- d.Run()
	}()

	// Wait for signal or error
	select {
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			return err
		}
	case sig := <-sigCh:
		fmt.Fprintf(os.Stderr, "\n  Received signal: %v\n", sig)
		d.Stop()
	}

	fmt.Fprintf(os.Stderr, "  Daemon stopped.\n")
	return nil
}