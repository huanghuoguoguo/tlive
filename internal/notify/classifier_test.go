package notify

import "testing"

func TestClassifyAwaitingInput(t *testing.T) {
	c := NewOutputClassifier(nil, nil)
	tests := []struct {
		name string
		line string
	}{
		{"Y/n prompt", "Do you want to proceed? [Y/n]"},
		{"y/N prompt", "Continue? [y/N]"},
		{"yes/no prompt", "Are you sure? (yes/no)"},
		{"inquirer style", "? Select a framework"},
		{"shell prompt", "user@host:~$ "},
		{"password", "Password: "},
		{"press enter", "Press Enter to continue"},
		{"confirm", "Please confirm"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := c.Classify(tt.line)
			if got != ClassAwaitingInput {
				t.Errorf("Classify(%q) = %v, want ClassAwaitingInput", tt.line, got)
			}
		})
	}
}

func TestClassifyProcessing(t *testing.T) {
	c := NewOutputClassifier(nil, nil)
	tests := []struct {
		name string
		line string
	}{
		{"spinner", "⠙ Processing..."},
		{"thinking", "Thinking"},
		{"loading", "Loading modules..."},
		{"compiling", "Compiling src/main.go"},
		{"building", "Building project..."},
		{"installing", "Installing dependencies..."},
		{"downloading", "Downloading packages"},
		{"ellipsis", "Analyzing code..."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := c.Classify(tt.line)
			if got != ClassProcessing {
				t.Errorf("Classify(%q) = %v, want ClassProcessing", tt.line, got)
			}
		})
	}
}

func TestClassifyUnknown(t *testing.T) {
	c := NewOutputClassifier(nil, nil)
	tests := []struct {
		name string
		line string
	}{
		{"regular output", "src/main.go:15: syntax error"},
		{"empty", ""},
		{"random text", "The quick brown fox"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := c.Classify(tt.line)
			if got != ClassUnknown {
				t.Errorf("Classify(%q) = %v, want ClassUnknown", tt.line, got)
			}
		})
	}
}

func TestClassifyCustomPatterns(t *testing.T) {
	extraInput := []string{`my_custom_prompt>`}
	extraProcessing := []string{`CRUNCHING`}
	c := NewOutputClassifier(extraInput, extraProcessing)

	if c.Classify("my_custom_prompt>") != ClassAwaitingInput {
		t.Error("expected custom input pattern to match")
	}
	if c.Classify("CRUNCHING data") != ClassProcessing {
		t.Error("expected custom processing pattern to match")
	}
}
