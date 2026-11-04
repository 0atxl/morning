package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLangsmithTracerDisabledWhenUnset(t *testing.T) {
	t.Setenv("LANGSMITH_API_KEY", "")
	tracer := newLangsmithTracer(&http.Client{})
	if tracer != nil {
		t.Fatal("expected nil tracer when LANGSMITH_API_KEY is empty")
	}
}

func TestLangsmithTracerPostsRuns(t *testing.T) {
	var mu sync.Mutex
	var runs []langsmithRun
	received := make(chan struct{}, 10)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "ls-test-key" {
			t.Fatalf("missing or wrong x-api-key: %s", r.Header.Get("x-api-key"))
		}
		body, _ := io.ReadAll(r.Body)
		var run langsmithRun
		if json.Unmarshal(body, &run) != nil {
			t.Fatal("invalid JSON run")
		}
		mu.Lock()
		runs = append(runs, run)
		mu.Unlock()
		received <- struct{}{}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()

	t.Setenv("LANGSMITH_API_KEY", "ls-test-key")
	t.Setenv("LANGSMITH_PROJECT", "test-project")
	t.Setenv("LANGSMITH_ENDPOINT", server.URL)

	tracer := newLangsmithTracer(server.Client())
	if tracer == nil {
		t.Fatal("expected non-nil tracer")
	}

	start := time.Now().Add(-1 * time.Second)
	end := time.Now()

	cmdRunID := tracer.TraceCommand("cmd-1", "Check the weather", "en", start, end, map[string]string{"reply": "It's sunny"}, nil)
	if cmdRunID == "" {
		t.Fatal("expected non-empty command run ID")
	}

	tracer.TraceLLM(cmdRunID, "openai/gpt-oss-20b", "messages", start, end, `{"actions":[]}`, nil)
	tracer.TraceLookup(cmdRunID, "weather", "Pune", start, end, "Sunny 25C", 1, nil)

	// Wait for the 3 runs to arrive at the test server
	for i := 0; i < 3; i++ {
		select {
		case <-received:
		case <-time.After(2 * time.Second):
			t.Fatal("timeout waiting for runs to be posted to LangSmith")
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if len(runs) != 3 {
		t.Fatalf("expected 3 runs, got %d", len(runs))
	}
	for _, run := range runs {
		if run.SessionName != "test-project" {
			t.Fatalf("wrong project name: %s", run.SessionName)
		}
		if run.Name == "groq_completion" && (run.ParentRunID == nil || *run.ParentRunID != cmdRunID) {
			t.Fatalf("wrong parent run ID: %v", run.ParentRunID)
		}
		if run.Name == "lookup_weather" && (run.ParentRunID == nil || *run.ParentRunID != cmdRunID) {
			t.Fatalf("wrong parent run ID: %v", run.ParentRunID)
		}
	}
}
