//go:build windows

package pty

import (
	"context"
	"fmt"
	"strings"

	"github.com/UserExistsError/conpty"
)

type windowsProcess struct {
	cpty *conpty.ConPty
	pid  int
}

func Start(name string, args []string, rows, cols uint16) (Process, error) {
	cmdLine := name
	if len(args) > 0 {
		cmdLine = name + " " + strings.Join(args, " ")
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

func (p *windowsProcess) Close() error {
	return p.cpty.Close()
}

func (p *windowsProcess) Pid() int {
	return p.pid
}
