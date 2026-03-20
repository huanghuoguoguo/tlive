//go:build windows

package main

import "github.com/termlive/termlive/core/internal/daemon"

func startResizeHandler(_ *daemon.ManagedSession) {
	// Windows does not have SIGWINCH; terminal resize is handled differently.
}
