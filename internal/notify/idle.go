package notify

import (
	"sync"
	"time"
)

type IdleDetector struct {
	timeout  time.Duration
	onIdle   func()
	timer    *time.Timer
	notified bool
	mu       sync.Mutex
	stopped  bool
}

func NewIdleDetector(timeout time.Duration, onIdle func()) *IdleDetector {
	return &IdleDetector{timeout: timeout, onIdle: onIdle}
}

func (d *IdleDetector) Start() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.timer = time.AfterFunc(d.timeout, d.fire)
}

func (d *IdleDetector) fire() {
	d.mu.Lock()
	if d.stopped || d.notified {
		d.mu.Unlock()
		return
	}
	d.notified = true
	d.mu.Unlock()
	d.onIdle()
}

func (d *IdleDetector) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.notified = false
	if d.timer != nil {
		d.timer.Stop()
		d.timer.Reset(d.timeout)
	}
}

func (d *IdleDetector) Stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stopped = true
	if d.timer != nil {
		d.timer.Stop()
	}
}
