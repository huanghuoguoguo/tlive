package notify

import (
	"sync"
	"time"
)

// SmartIdleDetector uses output classification to pick appropriate timeouts.
// AwaitingInput output -> short timeout -> high-confidence notification
// Processing output -> no timer (suppressed)
// Unknown output -> long timeout -> low-confidence notification
type SmartIdleDetector struct {
	shortTimeout time.Duration
	longTimeout  time.Duration
	classifier   *OutputClassifier
	onIdle       func(confidence string)

	mu        sync.Mutex
	timer     *time.Timer
	notified  bool
	stopped   bool
	lastClass OutputClass
}

// NewSmartIdleDetector creates a smart idle detector.
// extraInput/extraProcessing are additional regex patterns appended to built-ins.
func NewSmartIdleDetector(
	shortTimeout, longTimeout time.Duration,
	extraInput, extraProcessing []string,
	onIdle func(confidence string),
) *SmartIdleDetector {
	return &SmartIdleDetector{
		shortTimeout: shortTimeout,
		longTimeout:  longTimeout,
		classifier:   NewOutputClassifier(extraInput, extraProcessing),
		onIdle:       onIdle,
	}
}

func (d *SmartIdleDetector) Start() {
	d.mu.Lock()
	defer d.mu.Unlock()
	// Start with long timeout (unknown state)
	d.timer = time.AfterFunc(d.longTimeout, func() { d.fire("low") })
}

// Feed is called on every PTY output. It classifies the output
// and resets the appropriate timer.
func (d *SmartIdleDetector) Feed(data []byte) {
	line := LastVisibleLine(string(data))
	class := d.classifier.Classify(line)

	d.mu.Lock()
	defer d.mu.Unlock()

	if d.stopped {
		return
	}

	d.notified = false
	d.lastClass = class

	if d.timer != nil {
		d.timer.Stop()
	}

	switch class {
	case ClassAwaitingInput:
		d.timer = time.AfterFunc(d.shortTimeout, func() { d.fire("high") })
	case ClassProcessing:
		// No timer — suppress notifications while processing
		d.timer = nil
	default: // ClassUnknown
		d.timer = time.AfterFunc(d.longTimeout, func() { d.fire("low") })
	}
}

func (d *SmartIdleDetector) fire(confidence string) {
	d.mu.Lock()
	if d.stopped || d.notified {
		d.mu.Unlock()
		return
	}
	d.notified = true
	d.mu.Unlock()

	d.onIdle(confidence)
}

func (d *SmartIdleDetector) Stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stopped = true
	if d.timer != nil {
		d.timer.Stop()
	}
}
