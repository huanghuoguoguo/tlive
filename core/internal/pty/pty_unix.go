//go:build !windows

package pty

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

type unixProcess struct {
	ptmx   *os.File
	cmd    *exec.Cmd
	hasPgid bool
}

func Start(name string, args []string, rows, cols uint16, dir string, extraEnv ...string) (Process, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), extraEnv...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		// Retry without Setpgid — some environments (containers, certain
		// security policies) reject setpgid with EPERM.
		cmd = exec.Command(name, args...)
		cmd.Env = append(os.Environ(), extraEnv...)
		if dir != "" {
			cmd.Dir = dir
		}
		ptmx, err = pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
		if err != nil {
			return nil, err
		}
		return &unixProcess{ptmx: ptmx, cmd: cmd, hasPgid: false}, nil
	}
	return &unixProcess{ptmx: ptmx, cmd: cmd, hasPgid: true}, nil
}

func (p *unixProcess) Read(b []byte) (int, error)  { return p.ptmx.Read(b) }
func (p *unixProcess) Write(b []byte) (int, error) { return p.ptmx.Write(b) }
func (p *unixProcess) Resize(rows, cols uint16) error {
	return pty.Setsize(p.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}

func (p *unixProcess) Wait() (int, error) {
	err := p.cmd.Wait()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.Sys().(syscall.WaitStatus).ExitStatus(), nil
		}
		return -1, err
	}
	return 0, nil
}

// Kill forcefully terminates the process and its entire child tree by
// sending SIGKILL to the process group. Safe to call on an already-exited process.
func (p *unixProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	if p.hasPgid {
		// Kill the entire process group (negative PID = process group).
		syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
	} else {
		// No process group — kill the process directly.
		p.cmd.Process.Kill()
	}
	return nil
}

func (p *unixProcess) Close() error { return p.ptmx.Close() }

func (p *unixProcess) Pid() int {
	if p.cmd.Process != nil {
		return p.cmd.Process.Pid
	}
	return 0
}
