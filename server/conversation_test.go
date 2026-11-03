package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestConversationalReplyUsesGroqAndReturnsNoSavedActions(t *testing.T) {
	for _, transcript := range []string{"Hi, hello!", "Could you tell me what you can do for me?"} {
		calls := 0
		handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
			calls++
			var payload struct{ Messages []struct{ Content string } }
			if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload.Messages) != 2 || !strings.Contains(payload.Messages[1].Content, transcript) {
				t.Fatal("the complete turn must reach Groq as data")
			}
			model, _ := json.Marshal(modelInterpretation{Actions: []action{{Type: "reply", Text: "I can help you save a reminder or prepare an editable email draft."}}})
			body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(model)}}}})
			return providerResponse(200, string(body)), nil
		})
		var request commandRequest
		_ = json.Unmarshal([]byte(fixtureCommand), &request)
		request.Transcript = transcript
		status, body := requestCommand(t, handler, request)
		var reply commandResponse
		if json.Unmarshal([]byte(body), &reply) != nil || status != 200 || calls != 1 || reply.Reply == "" || len(reply.Actions) != 0 || reply.Clarification != nil {
			t.Fatalf("expected a model reply without actions: %d %s", status, body)
		}
	}
}

func TestReplyCannotAccompanyOrSmuggleSavedActions(t *testing.T) {
	var request commandRequest
	_ = json.Unmarshal([]byte(fixtureCommand), &request)
	now, location, _ := validateRequest(request)
	for _, actions := range [][]action{
		{{Type: "reply", Text: "Hello", DueAt: "2026-11-03T09:10:00+05:30"}},
		{{Type: "reply", Text: "Hello"}, {Type: "create_reminder", Title: "Water", DueAt: "2026-11-03T09:10:00+05:30"}},
		{{Type: "reply", Text: strings.Repeat("x", 241)}},
	} {
		result := interpretation{Actions: actions}
		if validateInterpretation(&result, now, location) == nil {
			t.Fatal("invalid reply escaped validation")
		}
	}
}
