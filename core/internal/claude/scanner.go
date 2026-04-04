package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ScannedSession represents a Claude Code session found in ~/.claude/projects/
type ScannedSession struct {
	SdkSessionId string `json:"sdk_session_id"` // .jsonl filename (UUID)
	ProjectDir   string `json:"project_dir"`    // encoded dir name, e.g. "-home-yhh-myproject"
	Cwd          string `json:"cwd"`            // from first user message's cwd field
	Mtime        int64  `json:"mtime"`          // file mtime (ms since epoch)
	Preview      string `json:"preview"`        // last message content, truncated
}

// ScanClaudeSessions scans ~/.claude/projects/ for Claude Code session .jsonl files.
// Returns sessions sorted by mtime descending (most recent first).
func ScanClaudeSessions(limit int, filterByCwd string) []ScannedSession {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	projectsDir := filepath.Join(homeDir, ".claude", "projects")

	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return nil
	}

	// Collect all .jsonl files with mtime
	var candidates []struct {
		path       string
		projectDir string
		sessionId  string
		mtime      time.Time
	}

	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "memory" {
			continue
		}
		dirPath := filepath.Join(projectsDir, entry.Name())
		files, err := os.ReadDir(dirPath)
		if err != nil {
			continue
		}
		for _, f := range files {
			// Skip sub-agent sessions
			if strings.HasPrefix(f.Name(), "agent-") {
				continue
			}
			if !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			filePath := filepath.Join(dirPath, f.Name())
			info, err := f.Info()
			if err != nil {
				continue
			}
			candidates = append(candidates, struct {
				path       string
				projectDir string
				sessionId  string
				mtime      time.Time
			}{
				path:       filePath,
				projectDir: entry.Name(),
				sessionId:  strings.TrimSuffix(f.Name(), ".jsonl"),
				mtime:      info.ModTime(),
			})
		}
	}

	// Sort by mtime descending
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].mtime.After(candidates[j].mtime)
	})

	// Parse header of each file for metadata
	var result []ScannedSession
	for _, c := range candidates {
		session := parseSessionHeader(c.path, c.projectDir, c.sessionId, c.mtime)
		// Filter out empty sessions
		if session.Preview == "(empty)" {
			continue
		}
		// Apply cwd filter
		if filterByCwd != "" {
			normalizedFilter := strings.TrimRight(filterByCwd, "/")
			normalizedCwd := strings.TrimRight(session.Cwd, "/")
			if normalizedCwd != normalizedFilter {
				continue
			}
		}
		result = append(result, session)
		if len(result) >= limit {
			break
		}
	}

	return result
}

func parseSessionHeader(filePath, projectDir, sessionId string, mtime time.Time) ScannedSession {
	cwd := decodeDirName(projectDir)
	preview := "(empty)"

	// Read last 32KB of file for efficiency (session files can grow large)
	const readSize = 32 * 1024
	data, err := readFileTail(filePath, readSize)
	if err != nil {
		return ScannedSession{
			SdkSessionId: sessionId,
			ProjectDir:   projectDir,
			Cwd:          cwd,
			Mtime:        mtime.UnixMilli(),
			Preview:      preview,
		}
	}

	lines := strings.Split(string(data), "\n")

	// Parse lines backwards to find last meaningful message
	var lastUserMsg string
	var lastCwd string

	// Iterate backwards to find last meaningful message
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var obj map[string]interface{}
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			continue
		}

		// Track cwd from any message (first found going backwards)
		if lastCwd == "" {
			if c, ok := obj["cwd"].(string); ok && c != "" {
				lastCwd = c
			}
		}

		// Look for user messages with content
		typ, _ := obj["type"].(string)
		if typ == "user" && lastUserMsg == "" {
			if msg, ok := obj["message"].(map[string]interface{}); ok {
				// content can be string or array
				if content, ok := msg["content"].(string); ok && content != "" {
					// Skip meta/command messages
					if !strings.HasPrefix(content, "<local-command") && !strings.HasPrefix(content, "<command-name") && !strings.HasPrefix(content, "<command-message") {
						lastUserMsg = content
					}
				}
				// Handle array content (tool results, etc.)
				if arr, ok := msg["content"].([]interface{}); ok && len(arr) > 0 {
					for _, item := range arr {
						if m, ok := item.(map[string]interface{}); ok {
							if txt, ok := m["text"].(string); ok && txt != "" {
								lastUserMsg = txt
								break
							}
						}
					}
				}
			}
		}
	}

	if lastCwd != "" {
		cwd = lastCwd
	}
	if lastUserMsg != "" {
		// Clean up and truncate preview
		preview = strings.TrimSpace(lastUserMsg)
		// Remove excessive whitespace/newlines for display
		preview = strings.Join(strings.Fields(preview), " ")
		if len(preview) > 80 {
			preview = preview[:77] + "..."
		}
	}

	return ScannedSession{
		SdkSessionId: sessionId,
		ProjectDir:   projectDir,
		Cwd:          cwd,
		Mtime:        mtime.UnixMilli(),
		Preview:      preview,
	}
}

// decodeDirName converts project directory name back to path:
// "-home-yhh-myproject" → "/home/yhh/myproject"
func decodeDirName(name string) string {
	if !strings.HasPrefix(name, "-") {
		return name
	}
	return strings.ReplaceAll(name, "-", "/")
}

// readFileTail reads the last N bytes of a file for efficiency.
// Returns the data, possibly with a partial first line (discarded by caller).
func readFileTail(filePath string, size int64) ([]byte, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, err
	}

	fileSize := info.Size()
	if fileSize <= size {
		// File is small, read entire content
		return os.ReadFile(filePath)
	}

	// Read last N bytes
	offset := fileSize - size
	_, err = f.Seek(offset, 0)
	if err != nil {
		return nil, err
	}

	buf := make([]byte, size)
	n, err := f.Read(buf)
	if err != nil {
		return nil, err
	}
	return buf[:n], nil
}