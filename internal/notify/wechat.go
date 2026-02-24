package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

type WeChatNotifier struct {
	webhookURL string
	client     *http.Client
}

func NewWeChatNotifier(webhookURL string) *WeChatNotifier {
	return &WeChatNotifier{webhookURL: webhookURL, client: &http.Client{}}
}

func (w *WeChatNotifier) Send(msg *NotifyMessage) error {
	if w.webhookURL == "" {
		return nil
	}
	content := fmt.Sprintf(
		"**TermLive: 终端等待输入 (空闲 %ds)**\n\n"+
			"> 会话: %s (PID: %d)\n> 运行时长: %s\n\n"+
			"最近输出:\n```\n%s\n```\n\n[打开 Web 终端](%s)",
		msg.IdleSeconds, msg.Command, msg.Pid, msg.Duration, msg.LastOutput, msg.WebURL,
	)
	payload := map[string]interface{}{
		"msgtype":  "markdown",
		"markdown": map[string]string{"content": content},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	resp, err := w.client.Post(w.webhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("wechat webhook returned status %d", resp.StatusCode)
	}
	return nil
}
