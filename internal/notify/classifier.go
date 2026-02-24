package notify

import (
	"regexp"
	"strings"
)

// OutputClass represents the classification of a terminal output line.
type OutputClass int

const (
	// ClassUnknown indicates the line does not match any known pattern.
	ClassUnknown OutputClass = iota
	// ClassAwaitingInput indicates the line looks like a prompt waiting for user input.
	ClassAwaitingInput
	// ClassProcessing indicates the line looks like ongoing background work.
	ClassProcessing
)

func (c OutputClass) String() string {
	switch c {
	case ClassAwaitingInput:
		return "AwaitingInput"
	case ClassProcessing:
		return "Processing"
	default:
		return "Unknown"
	}
}

// Default built-in patterns for detecting awaiting-input lines.
var defaultAwaitingInputPatterns = []string{
	`\[Y/n\]`,
	`\[y/N\]`,
	`\(yes/no\)`,
	`\?\s+\S`,
	`>\s*$`,
	`\$\s*$`,
	`[Pp]assword\s*:`,
	`[Cc]onfirm`,
	`Press\s+(any key|Enter|enter)`,
	`Continue\?`,
	`\(y\)`,
}

// Default built-in patterns for detecting processing/working lines.
var defaultProcessingPatterns = []string{
	`[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]`,
	`(?i)^thinking`,
	`(?i)^loading`,
	`(?i)^processing`,
	`(?i)^compiling`,
	`(?i)^building`,
	`(?i)^installing`,
	`(?i)^downloading`,
	`\.\.\.\s*$`,
}

// OutputClassifier categorizes terminal output lines into known classes
// (awaiting input, processing, or unknown) using regex pattern matching.
type OutputClassifier struct {
	awaitingInput []*regexp.Regexp
	processing    []*regexp.Regexp
}

// NewOutputClassifier creates a classifier with built-in patterns
// plus any extra patterns provided. Extra patterns are regex strings.
func NewOutputClassifier(extraInput, extraProcessing []string) *OutputClassifier {
	c := &OutputClassifier{}

	all := append(defaultAwaitingInputPatterns, extraInput...)
	for _, p := range all {
		if re, err := regexp.Compile(p); err == nil {
			c.awaitingInput = append(c.awaitingInput, re)
		}
	}

	allProc := append(defaultProcessingPatterns, extraProcessing...)
	for _, p := range allProc {
		if re, err := regexp.Compile(p); err == nil {
			c.processing = append(c.processing, re)
		}
	}

	return c
}

// Classify returns the classification for a visible terminal line.
func (c *OutputClassifier) Classify(line string) OutputClass {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return ClassUnknown
	}

	// Check awaiting input first (higher priority).
	for _, re := range c.awaitingInput {
		if re.MatchString(trimmed) {
			return ClassAwaitingInput
		}
	}

	// Check processing patterns.
	for _, re := range c.processing {
		if re.MatchString(trimmed) {
			return ClassProcessing
		}
	}

	return ClassUnknown
}
