package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The reported request uses the public sample contact and no saved-item context.
const reportedDraftCommand = `{"command_id":"5bf9e69c-6ac7-4621-9ea1-fee0f507edcb","transcript":"Drop the meeting. Meeting mail. To Priya saying that, as is clear weather, she needs to come to the office tomorrow.","now":"2026-11-03T23:27:41.957Z","timezone":"Asia/Calcutta","contacts":[{"id":"sample-priya-shah","name":"Priya Shah","email":"priya.shah@example.com"}]}`

func TestCommandRepairPreservesReportedDraftContext(t *testing.T) {
	for _, firstFailure := range []string{"contact", "mixed lookup", "malformed JSON"} {
		t.Run(firstFailure, func(t *testing.T) {
			calls := 0
			originalContext := ""
			var deadline time.Time
			handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.String() != groqCommandURL || calls > 2 {
					t.Fatal("repair must only interpret, with at most two calls")
				}
				var payload struct {
					Messages []struct{ Role, Content string }
				}
				if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload.Messages) != 2 {
					t.Fatal("expected separate instructions and request context")
				}
				currentDeadline, ok := r.Context().Deadline()
				if !ok {
					t.Fatal("both attempts must have a deadline")
				}
				if calls == 1 {
					originalContext, deadline = payload.Messages[1].Content, currentDeadline
					var data commandRequest
					if json.Unmarshal([]byte(originalContext), &data) != nil || data.CommandID != "" || data.Timezone != "Asia/Calcutta" || data.Now != "2026-11-04T04:57:41.957+05:30" || len(data.Contacts) != 1 || data.Contacts[0].ID != "sample-priya-shah" || data.ReminderContext != nil || data.DraftContext != nil {
						t.Fatal("reported context or local time changed")
					}
				} else if payload.Messages[1].Content != originalContext || !currentDeadline.Equal(deadline) || !strings.Contains(payload.Messages[0].Content, "failed server validation:") || !strings.Contains(payload.Messages[0].Content, "response language is English") {
					t.Fatal("repair must retain context, language, deadline and validation feedback")
				}
				name := "Priya"
				model := modelInterpretation{RecipientName: &name, Actions: []action{{Type: "draft_email", ToContactID: "sample-priya-shah", Subject: "Office tomorrow", Body: "Hi Priya,\n\nSince the weather is clear, please come to the office tomorrow.\n\nThanks!"}}}
				if calls == 1 {
					switch firstFailure {
					case "contact":
						name = "Priya Shah" // Not the name actually spoken.
					case "mixed lookup":
						model.Lookup = &lookupQuery{Kind: "weather", Place: "Pune"}
					case "malformed JSON":
						return providerResponse(200, `{not JSON}`), nil
					}
				}
				return lookupIntentResponse(model), nil
			})
			w := requestAPI(handler, "/api/commands", reportedDraftCommand)
			var result commandResponse
			if json.Unmarshal(w.Body.Bytes(), &result) != nil || w.Code != 200 || calls != 2 || result.CommandID != "5bf9e69c-6ac7-4621-9ea1-fee0f507edcb" || result.Clarification != nil || result.Lookup != nil || result.Reply != "" || len(result.Actions) != 1 || result.Actions[0].Type != "draft_email" || result.Actions[0].ToContactID != "sample-priya-shah" {
				t.Fatalf("repair must return exactly one validated draft: %d %s, calls=%d", w.Code, w.Body.String(), calls)
			}
		})
	}
}

func TestCommandRepairStillRejectsWrongRecipient(t *testing.T) {
	calls := 0
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return providerResponse(200, `{not JSON}`), nil
		}
		name := "Priya"
		return lookupIntentResponse(modelInterpretation{RecipientName: &name, Actions: []action{{Type: "draft_email", ToContactID: "wrong-contact", Subject: "Private subject", Body: "Private body"}}}), nil
	})
	w := requestAPI(handler, "/api/commands", reportedDraftCommand)
	var result apiError
	if decodeObject(w.Body.Bytes(), &result) != nil || w.Code != 422 || calls != 2 || result.CommandID != "5bf9e69c-6ac7-4621-9ea1-fee0f507edcb" || result.Error.Code != "command_provider_invalid_response" || !result.Error.Retryable || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") || !strings.Contains(result.Error.Message, "rephrase or retry") {
		t.Fatalf("persistent invalid output must be a usable JSON error: %d %s, calls=%d", w.Code, w.Body.String(), calls)
	}
	for _, private := range []string{"Priya", "Private", "wrong-contact", "@", "recipient_name", "actions"} {
		if strings.Contains(w.Body.String(), private) {
			t.Fatalf("invalid output leaked into error: %s", w.Body.String())
		}
	}
}

func TestCommandRepairDoesNotRetryProviderFailures(t *testing.T) {
	for _, tc := range []struct {
		name, code       string
		upstream, status int
		err              error
	}{
		{"rate limit", "command_provider_rate_limited", 429, 429, nil},
		{"outage", "command_provider_unavailable", 503, 502, nil},
		{"timeout", "command_provider_timeout", 0, 504, context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				calls++
				if tc.err != nil {
					return nil, tc.err
				}
				return providerResponse(tc.upstream, "private provider detail"), nil
			})
			w := requestAPI(handler, "/api/commands", reportedDraftCommand)
			var result apiError
			if decodeObject(w.Body.Bytes(), &result) != nil || w.Code != tc.status || calls != 1 || result.Error.Code != tc.code || tc.status == 429 && w.Header().Get("Retry-After") != "60" {
				t.Fatalf("provider failure was retried or misclassified: %d %s, calls=%d", w.Code, w.Body.String(), calls)
			}
		})
	}
}
