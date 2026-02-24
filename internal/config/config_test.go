package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	cfg := Default()
	if cfg.Server.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Server.Port)
	}
	if cfg.Server.Host != "0.0.0.0" {
		t.Errorf("expected default host 0.0.0.0, got %s", cfg.Server.Host)
	}
	if cfg.Notify.IdleTimeout != 30 {
		t.Errorf("expected default idle timeout 30, got %d", cfg.Notify.IdleTimeout)
	}
}

func TestLoadFromFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	content := []byte(`
[server]
port = 3000
host = "127.0.0.1"

[notify]
idle_timeout = 60

[notify.wechat]
webhook_url = "https://example.com/wechat"

[notify.feishu]
webhook_url = "https://example.com/feishu"
`)
	if err := os.WriteFile(cfgPath, content, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadFromFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 3000 {
		t.Errorf("expected port 3000, got %d", cfg.Server.Port)
	}
	if cfg.Server.Host != "127.0.0.1" {
		t.Errorf("expected host 127.0.0.1, got %s", cfg.Server.Host)
	}
	if cfg.Notify.IdleTimeout != 60 {
		t.Errorf("expected idle timeout 60, got %d", cfg.Notify.IdleTimeout)
	}
	if cfg.Notify.WeChat.WebhookURL != "https://example.com/wechat" {
		t.Errorf("unexpected wechat webhook url: %s", cfg.Notify.WeChat.WebhookURL)
	}
	if cfg.Notify.Feishu.WebhookURL != "https://example.com/feishu" {
		t.Errorf("unexpected feishu webhook url: %s", cfg.Notify.Feishu.WebhookURL)
	}
}

func TestLoadFromFileMissing(t *testing.T) {
	cfg, err := LoadFromFile("/nonexistent/config.toml")
	if err != nil {
		t.Fatal("missing file should return defaults, not error")
	}
	if cfg.Server.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Server.Port)
	}
}
