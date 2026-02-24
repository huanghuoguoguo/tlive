package notify

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestIdleDetectorNotifies(t *testing.T) {
	var notified atomic.Int32
	d := NewIdleDetector(100*time.Millisecond, func() { notified.Add(1) })
	d.Start()
	defer d.Stop()
	time.Sleep(200 * time.Millisecond)
	if notified.Load() != 1 {
		t.Errorf("expected 1 notification, got %d", notified.Load())
	}
}

func TestIdleDetectorResetPreventsNotify(t *testing.T) {
	var notified atomic.Int32
	d := NewIdleDetector(100*time.Millisecond, func() { notified.Add(1) })
	d.Start()
	defer d.Stop()
	time.Sleep(50 * time.Millisecond)
	d.Reset()
	time.Sleep(50 * time.Millisecond)
	d.Reset()
	time.Sleep(50 * time.Millisecond)
	if notified.Load() != 0 {
		t.Errorf("expected 0 notifications, got %d", notified.Load())
	}
}

func TestIdleDetectorNotifiesOnceUntilReset(t *testing.T) {
	var notified atomic.Int32
	d := NewIdleDetector(50*time.Millisecond, func() { notified.Add(1) })
	d.Start()
	defer d.Stop()
	time.Sleep(100 * time.Millisecond)
	time.Sleep(100 * time.Millisecond)
	if notified.Load() != 1 {
		t.Errorf("expected exactly 1 notification, got %d", notified.Load())
	}
	d.Reset()
	time.Sleep(100 * time.Millisecond)
	if notified.Load() != 2 {
		t.Errorf("expected 2 notifications after reset, got %d", notified.Load())
	}
}
