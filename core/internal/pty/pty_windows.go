//go:build windows

package pty

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	"github.com/UserExistsError/conpty"
)

type windowsProcess struct {
	cpty     *conpty.ConPty
	pid      int
	closeOnce sync.Once
	closeErr  error
}

func Start(name string, args []string, rows, cols uint16, extraEnv ...string) (Process, error) {
	cmdLine := name
	if len(args) > 0 {
		cmdLine = name + " " + strings.Join(args, " ")
	}

	// Windows: wrap with cmd /c to resolve .cmd/.bat scripts in PATH
	// Only needed when the command is not a direct .exe path
	if !strings.ContainsAny(name, `\/`) && !strings.HasSuffix(strings.ToLower(name), ".exe") {
		cmdLine = "cmd /c " + cmdLine
	}

	// conpty doesn't support per-process env, set on parent
	for _, env := range extraEnv {
		if parts := strings.SplitN(env, "=", 2); len(parts) == 2 {
			os.Setenv(parts[0], parts[1])
		}
	}

	cpty, err := conpty.Start(cmdLine, conpty.ConPtyDimensions(int(cols), int(rows)))
	if err != nil {
		return nil, fmt.Errorf("conpty start: %w", err)
	}

	return &windowsProcess{
		cpty: cpty,
		pid:  cpty.Pid(),
	}, nil
}

func (p *windowsProcess) Read(b []byte) (int, error) {
	return p.cpty.Read(b)
}

func (p *windowsProcess) Write(b []byte) (int, error) {
	return p.cpty.Write(b)
}

func (p *windowsProcess) Resize(rows, cols uint16) error {
	return p.cpty.Resize(int(cols), int(rows))
}

func (p *windowsProcess) Wait() (int, error) {
	exitCode, err := p.cpty.Wait(context.Background())
	if err != nil {
		return -1, err
	}
	return int(exitCode), nil
}

// Kill forcefully terminates the process and its entire child tree using
// taskkill /T /F. Safe to call multiple times or on an already-exited process.
func (p *windowsProcess) Kill() error {
	// taskkill /T kills the process tree (all children), /F forces termination.
	// Errors are ignored because the process may have already exited.
	exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(p.pid)).Run()
	return nil
}

// Close releases ConPTY handles. Idempotent — safe to call multiple times.
func (p *windowsProcess) Close() error {
	p.closeOnce.Do(func() {
		p.closeErr = p.cpty.Close()
	})
	return p.closeErr
}

func (p *windowsProcess) Pid() int {
	return p.pid
}
