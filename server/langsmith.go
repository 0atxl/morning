package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	defaultLangsmithEndpoint = "https://api.smith.langchain.com/runs"
	defaultLangsmithProject  = "morning"
)

type langsmithRun struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	RunType     string         `json:"run_type"` // chain, llm, tool
	Inputs      map[string]any `json:"inputs"`
	Outputs     map[string]any `json:"outputs,omitempty"`
	Error       *string        `json:"error,omitempty"`
	StartTime   string         `json:"start_time"`
	EndTime     string         `json:"end_time"`
	Extra       map[string]any `json:"extra,omitempty"`
	SessionName string         `json:"session_name"`
	ParentRunID *string        `json:"parent_run_id,omitempty"`
}

type langsmithTracer struct {
	client   *http.Client
	apiKey   string
	project  string
	endpoint string
	queue    chan langsmithRun
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst)
}

func newLangsmithTracer(client *http.Client) *langsmithTracer {
	apiKey := strings.TrimSpace(os.Getenv("LANGSMITH_API_KEY"))
	if apiKey == "" {
		return nil
	}
	project := strings.TrimSpace(os.Getenv("LANGSMITH_PROJECT"))
	if project == "" {
		project = defaultLangsmithProject
	}
	endpoint := strings.TrimSpace(os.Getenv("LANGSMITH_ENDPOINT"))
	if endpoint == "" {
		endpoint = defaultLangsmithEndpoint
	}
	t := &langsmithTracer{
		client:   client,
		apiKey:   apiKey,
		project:  project,
		endpoint: endpoint,
		queue:    make(chan langsmithRun, 200),
	}
	go t.worker()
	return t
}

func (t *langsmithTracer) worker() {
	for run := range t.queue {
		t.postRun(run)
	}
}

func (t *langsmithTracer) postRun(run langsmithRun) {
	body, err := json.Marshal(run)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.endpoint, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", t.apiKey)
	resp, err := t.client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		log.Printf("LangSmith trace rejected: status=%d", resp.StatusCode)
	}
}

func (t *langsmithTracer) enqueue(run langsmithRun) {
	if t == nil || t.apiKey == "" {
		return
	}
	select {
	case t.queue <- run:
	default:
		// Queue full; drop silently to avoid degrading user voice latency.
	}
}

func (t *langsmithTracer) TraceCommand(commandID, transcript, replyLanguage string, start, end time.Time, output any, err error) string {
	if t == nil {
		return ""
	}
	runID := newUUID()
	run := langsmithRun{
		ID:          runID,
		Name:        "morning_command",
		RunType:     "chain",
		Inputs:      map[string]any{"command_id": commandID, "transcript": transcript},
		StartTime:   start.UTC().Format(time.RFC3339Nano),
		EndTime:     end.UTC().Format(time.RFC3339Nano),
		SessionName: t.project,
		Extra: map[string]any{
			"metadata": map[string]any{
				"reply_language": replyLanguage,
			},
		},
	}
	if err != nil {
		msg := err.Error()
		run.Error = &msg
	} else if output != nil {
		run.Outputs = map[string]any{"result": output}
	}
	t.enqueue(run)
	return runID
}

func (t *langsmithTracer) TraceLLM(parentRunID, model string, messages any, start, end time.Time, rawOutput string, err error) {
	if t == nil {
		return
	}
	runID := newUUID()
	run := langsmithRun{
		ID:          runID,
		Name:        "groq_completion",
		RunType:     "llm",
		Inputs:      map[string]any{"messages": messages},
		StartTime:   start.UTC().Format(time.RFC3339Nano),
		EndTime:     end.UTC().Format(time.RFC3339Nano),
		SessionName: t.project,
		Extra: map[string]any{
			"metadata": map[string]any{
				"model": model,
			},
		},
	}
	if parentRunID != "" {
		run.ParentRunID = &parentRunID
	}
	if err != nil {
		msg := err.Error()
		run.Error = &msg
	} else {
		run.Outputs = map[string]any{"content": rawOutput}
	}
	t.enqueue(run)
}

func (t *langsmithTracer) TraceLookup(parentRunID, kind, query string, start, end time.Time, answer string, sourceCount int, err error) {
	if t == nil {
		return
	}
	runID := newUUID()
	run := langsmithRun{
		ID:          runID,
		Name:        "lookup_" + kind,
		RunType:     "tool",
		Inputs:      map[string]any{"kind": kind, "query": query},
		StartTime:   start.UTC().Format(time.RFC3339Nano),
		EndTime:     end.UTC().Format(time.RFC3339Nano),
		SessionName: t.project,
	}
	if parentRunID != "" {
		run.ParentRunID = &parentRunID
	}
	if err != nil {
		msg := err.Error()
		run.Error = &msg
	} else {
		run.Outputs = map[string]any{
			"answer":       answer,
			"source_count": sourceCount,
		}
	}
	t.enqueue(run)
}
