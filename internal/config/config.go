package config

import (
	"os"

	"github.com/pelletier/go-toml/v2"
)

type Config struct {
	Server ServerConfig `toml:"server"`
	Notify NotifyConfig `toml:"notify"`
}

type ServerConfig struct {
	Port int    `toml:"port"`
	Host string `toml:"host"`
}

type NotifyConfig struct {
	IdleTimeout int          `toml:"idle_timeout"`
	WeChat      WeChatConfig `toml:"wechat"`
	Feishu      FeishuConfig `toml:"feishu"`
}

type WeChatConfig struct {
	WebhookURL string `toml:"webhook_url"`
}

type FeishuConfig struct {
	WebhookURL string `toml:"webhook_url"`
}

func Default() *Config {
	return &Config{
		Server: ServerConfig{Port: 8080, Host: "0.0.0.0"},
		Notify: NotifyConfig{IdleTimeout: 30},
	}
}

func LoadFromFile(path string) (*Config, error) {
	cfg := Default()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}
	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}
