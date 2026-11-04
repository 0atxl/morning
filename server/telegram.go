package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type telegramNotifier struct {
	client   *http.Client
	botToken string
	chatID   string
}

func newTelegramNotifier(client *http.Client) *telegramNotifier {
	botToken := strings.TrimSpace(os.Getenv("TELEGRAM_BOT_TOKEN"))
	chatID := strings.TrimSpace(os.Getenv("TELEGRAM_CHAT_ID"))
	if botToken == "" || chatID == "" {
		return nil
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &telegramNotifier{
		client:   client,
		botToken: botToken,
		chatID:   chatID,
	}
}

func (t *telegramNotifier) SendReminder(ctx context.Context, title string, dueAt time.Time) error {
	if t == nil || t.botToken == "" || t.chatID == "" {
		return nil
	}
	apiURL := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", t.botToken)
	text := fmt.Sprintf("⏰ *Morning Reminder Due*\n\n*%s*\nScheduled for: %s",
		title, dueAt.Format("3:04 PM, 2 Jan 2006"))
	payload := map[string]any{
		"chat_id":    t.chatID,
		"text":       text,
		"parse_mode": "Markdown",
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("telegram notification failed: status=%d", resp.StatusCode)
	}
	log.Printf("Telegram reminder notification sent for: %s", title)
	return nil
}
