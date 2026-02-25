//go:build windows

package pty

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestWindowsStartAndRead(t *testing.T) {
	proc, err := Start("cmd.exe", []string{"/C", "echo", "hello"}, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer proc.Close()

	var buf bytes.Buffer
	tmp := make([]byte, 4096)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			n, err := proc.Read(tmp)
			if n > 0 {
				buf.Write(tmp[:n])
			}
			if err != nil {
				return
			}
		}
	}()

	proc.Wait()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}

	if !strings.Contains(buf.String(), "hello") {
		t.Errorf("expected output to contain 'hello', got: %q", buf.String())
	}
}

func TestWindowsPid(t *testing.T) {
	proc, err := Start("cmd.exe", []string{"/C", "timeout", "/t", "2"}, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer proc.Close()

	if proc.Pid() <= 0 {
		t.Errorf("expected positive PID, got %d", proc.Pid())
	}

	proc.Wait()
}
