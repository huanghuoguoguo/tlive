//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"

	"github.com/termlive/termlive/core/internal/daemon"
	"golang.org/x/term"
)

func startResizeHandler(ms *daemon.ManagedSession) {
	winchCh := make(chan os.Signal, 1)
	signal.Notify(winchCh, syscall.SIGWINCH)
	go func() {
		for range winchCh {
			if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
				r, c := uint16(h), uint16(w)
				ms.Proc.Resize(r, c)
				ms.Session.SetSize(r, c)
			}
		}
	}()
}
