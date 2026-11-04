package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
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

func TestPreviousTurnForwardedToGroq(t *testing.T) {
	calls := 0
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		calls++
		var payload struct{ Messages []struct{ Content string } }
		if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload.Messages) != 2 {
			t.Fatal("expected 2 messages to Groq")
		}
		userContent := payload.Messages[1].Content
		if !strings.Contains(userContent, `"previous_turn"`) ||
			!strings.Contains(userContent, `"topic":"Adolf Hitler"`) ||
			!strings.Contains(userContent, `"answer":"Adolf Hitler was an Austrian-born German politician."`) {
			t.Fatalf("previous_turn missing or incomplete in Groq payload: %s", userContent)
		}
		model, _ := json.Marshal(modelInterpretation{
			Actions: []action{{Type: "reply", Text: "He died on 30 April 1945 in Berlin."}},
		})
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(model)}}}})
		return providerResponse(200, string(body)), nil
	})

	var request commandRequest
	_ = json.Unmarshal([]byte(fixtureCommand), &request)
	request.Transcript = "When did he die?"
	request.PreviousTurn = &previousTurnContext{
		Transcript: "Tell me about Adolf Hitler",
		Topic:      "Adolf Hitler",
		Answer:     "Adolf Hitler was an Austrian-born German politician.",
		Reply:      "Adolf Hitler was an Austrian-born German politician.",
	}
	status, body := requestCommand(t, handler, request)
	var response commandResponse
	if json.Unmarshal([]byte(body), &response) != nil || status != 200 || calls != 1 {
		t.Fatalf("unexpected response: %d %s", status, body)
	}
	if response.Reply != "He died on 30 April 1945 in Berlin." {
		t.Fatalf("unexpected reply: %s", response.Reply)
	}
}

func TestRejectsOversizedPreviousTurn(t *testing.T) {
	var request commandRequest
	_ = json.Unmarshal([]byte(fixtureCommand), &request)
	request.PreviousTurn = &previousTurnContext{
		Transcript: strings.Repeat("x", 8193),
	}
	_, _, err := validateRequest(request)
	if err == nil || !strings.Contains(err.Error(), "previous_turn") {
		t.Fatalf("expected previous_turn validation error, got %v", err)
	}

	request.PreviousTurn = &previousTurnContext{
		Topic: strings.Repeat("a", 301),
	}
	_, _, err = validateRequest(request)
	if err == nil || !strings.Contains(err.Error(), "previous_turn") {
		t.Fatalf("expected previous_turn topic validation error, got %v", err)
	}
}

func TestRecurringReminderValidation(t *testing.T) {
	var request commandRequest
	_ = json.Unmarshal([]byte(fixtureCommand), &request)
	now, location, _ := validateRequest(request)

	for _, tc := range []struct {
		repeat string
		valid  bool
	}{
		{"", true},
		{"daily", true},
		{"weekly", true},
		{"weekdays", true},
		{"monthly", false},
		{"hourly", false},
	} {
		result := interpretation{
			Actions: []action{{
				Type:   "create_reminder",
				Title:  "Drink water",
				DueAt:  now.Add(time.Hour).Format(offsetTimestamp),
				Repeat: tc.repeat,
			}},
		}
		err := validateInterpretation(&result, now, location)
		if (err == nil) != tc.valid {
			t.Fatalf("repeat=%q valid=%v, got err=%v", tc.repeat, tc.valid, err)
		}
	}
}

func TestReminderProviderAcceptsSchemaRepeatAndLegacyOmission(t *testing.T) {
	for _, field := range []string{"", `,"repeat":""`, `,"repeat":"daily"`, `,"repeat":"weekly"`, `,"repeat":"weekdays"`} {
		t.Run(field, func(t *testing.T) {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				content := `{"actions":[{"type":"create_reminder","title":"Check the oven","due_at":"2026-11-03T09:10:00+05:30"` + field + `}],"clarification":null,"recipient_name":null}`
				body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": content}}}})
				return providerResponse(200, string(body)), nil
			})
			w := requestAPI(handler, "/api/commands", fixtureCommand)
			if w.Code != http.StatusOK {
				t.Fatalf("schema repeat rejected: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestPendingBriefingContractRejectsActionAndMemoryContexts(t *testing.T) {
	var request commandRequest
	_ = json.Unmarshal([]byte(fixtureCommand), &request)
	request.LookupContext = &lookupContext{Query: lookupQuery{Kind: "briefing", Today: true}}
	if _, _, err := validateRequest(request); err != nil {
		t.Fatal(err)
	}
	request.PreviousTurn = &previousTurnContext{Topic: "Old discussion"}
	if _, _, err := validateRequest(request); err == nil {
		t.Fatal("pending place lookup accepted unrelated conversation context")
	}
	request.PreviousTurn = nil
	request.ReminderContext = &reminderContext{ID: "saved", DueAt: time.Now()}
	if _, _, err := validateRequest(request); err == nil {
		t.Fatal("pending place lookup accepted action context")
	}
}
