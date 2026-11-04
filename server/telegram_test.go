package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTelegramNotifierSendsFormattedReminder(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		var payload map[string]string
		if json.Unmarshal(body, &payload) != nil {
			t.Fatal("invalid JSON payload")
		}
		if payload["chat_id"] != "123456" {
			t.Fatalf("wrong chat_id: %s", payload["chat_id"])
		}
		if !strings.Contains(payload["text"], "Take vitamins") || !strings.Contains(payload["text"], "⏰ *Morning Reminder Due*") {
			t.Fatalf("missing reminder content in text: %s", payload["text"])
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	notifier := &telegramNotifier{
		client:   server.Client(),
		botToken: "test-token",
		chatID:   "123456",
	}

	dueAt := time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC)
	// Temporarily override the apiURL by setting up notifier with server's transport
	transport := server.Client().Transport
	notifier.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			req.URL.Scheme = "http"
			req.URL.Host = strings.TrimPrefix(server.URL, "http://")
			return transport.RoundTrip(req)
		}),
	}

	err := notifier.SendReminder(context.Background(), "Take vitamins", dueAt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Fatal("expected Telegram mock server to be called")
	}
}

func TestTelegramNotifierDisabledWhenUnset(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "")
	t.Setenv("TELEGRAM_CHAT_ID", "")
	n := newTelegramNotifier(nil)
	if n != nil {
		t.Fatal("expected nil notifier when environment variables are unset")
	}
}

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
