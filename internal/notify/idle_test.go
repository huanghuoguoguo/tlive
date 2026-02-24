package notify

import (
	"sync"
	"testing"
	"time"
)

func TestSmartIdleAwaitingInputNotifies(t *testing.T) {
	var mu sync.Mutex
	var lastConfidence string
	notifyCount := 0

	d := NewSmartIdleDetector(100*time.Millisecond, 500*time.Millisecond, nil, nil,
		func(confidence string) {
			mu.Lock()
			notifyCount++
			lastConfidence = confidence
			mu.Unlock()
		},
	)
	d.Start()
	defer d.Stop()

	// Feed output that looks like a prompt
	d.Feed([]byte("? Do you want to proceed? [Y/n]"))

	// Wait for short timeout to fire
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	if notifyCount != 1 {
		t.Errorf("expected 1 notification, got %d", notifyCount)
	}
	if lastConfidence != "high" {
		t.Errorf("expected high confidence, got %s", lastConfidence)
	}
	mu.Unlock()
}

func TestSmartIdleProcessingSuppresses(t *testing.T) {
	notifyCount := 0
	d := NewSmartIdleDetector(50*time.Millisecond, 200*time.Millisecond, nil, nil,
		func(confidence string) { notifyCount++ },
	)
	d.Start()
	defer d.Stop()

	// Feed output that looks like processing
	d.Feed([]byte("⠙ Thinking..."))

	// Wait past short timeout
	time.Sleep(100 * time.Millisecond)

	if notifyCount != 0 {
		t.Errorf("expected 0 notifications for processing output, got %d", notifyCount)
	}
}

func TestSmartIdleUnknownUsesLongTimeout(t *testing.T) {
	var mu sync.Mutex
	var lastConfidence string
	notifyCount := 0

	d := NewSmartIdleDetector(50*time.Millisecond, 200*time.Millisecond, nil, nil,
		func(confidence string) {
			mu.Lock()
			notifyCount++
			lastConfidence = confidence
			mu.Unlock()
		},
	)
	d.Start()
	defer d.Stop()

	// Feed output that doesn't match any pattern
	d.Feed([]byte("some random output"))

	// Should NOT notify at short timeout
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if notifyCount != 0 {
		t.Errorf("expected 0 notifications at short timeout, got %d", notifyCount)
	}
	mu.Unlock()

	// SHOULD notify at long timeout
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	if notifyCount != 1 {
		t.Errorf("expected 1 notification at long timeout, got %d", notifyCount)
	}
	if lastConfidence != "low" {
		t.Errorf("expected low confidence, got %s", lastConfidence)
	}
	mu.Unlock()
}

func TestSmartIdleFeedResetsTimers(t *testing.T) {
	notifyCount := 0
	d := NewSmartIdleDetector(100*time.Millisecond, 500*time.Millisecond, nil, nil,
		func(confidence string) { notifyCount++ },
	)
	d.Start()
	defer d.Stop()

	d.Feed([]byte("? prompt [Y/n]"))

	// Feed new output before timeout
	time.Sleep(50 * time.Millisecond)
	d.Feed([]byte("some new output"))
	time.Sleep(50 * time.Millisecond)
	d.Feed([]byte("more output"))
	time.Sleep(50 * time.Millisecond)

	if notifyCount != 0 {
		t.Errorf("expected 0 notifications when feed keeps resetting, got %d", notifyCount)
	}
}

func TestSmartIdleNotifiesOnceUntilNewOutput(t *testing.T) {
	var mu sync.Mutex
	notifyCount := 0

	d := NewSmartIdleDetector(50*time.Millisecond, 500*time.Millisecond, nil, nil,
		func(confidence string) {
			mu.Lock()
			notifyCount++
			mu.Unlock()
		},
	)
	d.Start()
	defer d.Stop()

	d.Feed([]byte("? prompt [Y/n]"))
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	if notifyCount != 1 {
		t.Errorf("expected 1 notification, got %d", notifyCount)
	}
	mu.Unlock()

	// Wait more — should NOT notify again
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if notifyCount != 1 {
		t.Errorf("expected still 1 notification, got %d", notifyCount)
	}
	mu.Unlock()

	// Feed new output, then wait — should notify again
	d.Feed([]byte("? another prompt [Y/n]"))
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if notifyCount != 2 {
		t.Errorf("expected 2 notifications after new output, got %d", notifyCount)
	}
	mu.Unlock()
}
