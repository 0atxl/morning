package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRejectsInvalidModelOutput(t *testing.T) {
	validAction := `{"type":"create_reminder","title":"Check the oven","due_at":"2026-11-03T09:10:00+05:30"}`
	validContent := `{"actions":[` + validAction + `],"clarification":null,"recipient_name":null}`
	for _, tc := range []struct{ name, content string }{
		{"unknown action", strings.Replace(validContent, "create_reminder", "delete_task", 1)},
		{"unknown field", strings.Replace(validContent, `"title":`, `"recipient":"someone","title":`, 1)},
		{"empty draft field on reminder", strings.Replace(validContent, `"title":`, `"subject":"","title":`, 1)},
		{"no title", strings.Replace(validContent, "Check the oven", "", 1)},
		{"long title", strings.Replace(validContent, "Check the oven", strings.Repeat("a", 201), 1)},
		{"control in title", strings.Replace(validContent, "Check the oven", `Check\nthe oven`, 1)},
		{"past due", strings.Replace(validContent, "09:10:00", "08:59:00", 1)},
		{"due now", strings.Replace(validContent, "09:10:00", "09:00:00", 1)},
		{"no due offset", strings.Replace(validContent, "09:10:00+05:30", "09:10:00", 1)},
		{"wrong timezone offset", strings.Replace(validContent, "+05:30", "+05:00", 1)},
		{"invalid calendar date", strings.Replace(validContent, "2026-11-03", "2026-02-30", 1)},
		{"multiple reminders", `{"actions":[` + validAction + `,` + validAction + `],"clarification":null,"recipient_name":null}`},
		{"action and question", strings.Replace(validContent, `"clarification":null`, `"clarification":"When?"`, 1)},
		{"missing clarification", `{"actions":[` + validAction + `]}`},
		{"missing recipient context", `{"actions":[` + validAction + `],"clarification":null}`},
		{"missing actions", `{"clarification":"When?"}`},
		{"null actions", `{"actions":null,"clarification":"When?"}`},
		{"no action or question", `{"actions":[],"clarification":null}`},
		{"blank question", `{"actions":[],"clarification":" "}`},
		{"non-JSON content", "Here is your reminder"},
		{"fenced JSON", "```json\n" + validContent + "\n```"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			envelope, err := json.Marshal(map[string]any{
				"choices": []any{map[string]any{
					"finish_reason": "stop", "message": map[string]string{"content": tc.content},
				}},
			})
			if err != nil {
				t.Fatal(err)
			}
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, string(envelope)), nil
			})
			w := requestAPI(handler, "/api/commands", fixtureCommand)
			if w.Code != 422 || !strings.Contains(w.Body.String(), `"code":"command_provider_invalid_response"`) || strings.Contains(w.Body.String(), `"actions"`) {
				t.Fatalf("invalid model output escaped validation: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestRejectsIncompleteOrRefusedProviderCompletions(t *testing.T) {
	for _, body := range []string{
		`{"choices":[]}`,
		strings.Replace(fixture(t, "groq-reminder.json"), `"stop"`, `"length"`, 1),
		strings.Replace(fixture(t, "groq-reminder.json"), `"role": "assistant"`, `"refusal":"Cannot comply","role":"assistant"`, 1),
		strings.Replace(fixture(t, "groq-reminder.json"), `"role": "assistant"`, `"tool_calls":[{"type":"function"}],"role":"assistant"`, 1),
	} {
		handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
			return providerResponse(200, body), nil
		})
		w := requestAPI(handler, "/api/commands", fixtureCommand)
		if w.Code != 422 || !strings.Contains(w.Body.String(), "command_provider_invalid_response") {
			t.Fatalf("incomplete response was accepted: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestValidatesDueOffsetAtDueInstant(t *testing.T) {
	for _, tc := range []struct {
		name, timezone, now, due, want string
		valid                          bool
	}{
		{"Kolkata", "Asia/Kolkata", "2026-11-03T03:30:00Z", "2026-11-03T09:10:00+05:30", "2026-11-03T09:10:00+05:30", true},
		{"UTC numeric offset", "UTC", "2026-11-03T09:00:00Z", "2026-11-03T09:10:00Z", "2026-11-03T09:10:00+00:00", true},
		{"fractional seconds", "UTC", "2026-11-03T09:00:00.1Z", "2026-11-03T09:00:00.2Z", "2026-11-03T09:00:00.2+00:00", true},
		{"cross midnight", "Asia/Kolkata", "2026-11-03T23:55:00+05:30", "2026-11-04T00:05:00+05:30", "2026-11-04T00:05:00+05:30", true},
		{"DST transition", "America/New_York", "2026-03-08T01:55:00-05:00", "2026-03-08T03:05:00-04:00", "2026-03-08T03:05:00-04:00", true},
		{"nonexistent DST time", "America/New_York", "2026-03-08T01:55:00-05:00", "2026-03-08T02:05:00-05:00", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now, location, err := validateRequest(commandRequest{
				CommandID: "time-case", Transcript: "Remind me in ten minutes to check the oven", Now: tc.now, Timezone: tc.timezone,
			})
			if err != nil {
				t.Fatal(err)
			}
			result := interpretation{Actions: []action{{Type: "create_reminder", Title: "Check the oven", DueAt: tc.due}}}
			err = validateInterpretation(&result, now, location)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, error=%v", tc.valid, err)
			}
			if tc.valid && result.Actions[0].DueAt != tc.want {
				t.Fatalf("due_at=%s, want %s", result.Actions[0].DueAt, tc.want)
			}
		})
	}
}

func TestTokenGrantMustBeTemporary(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"empty token", `{"access_token":"","expires_in":30}`},
		{"empty token with omitted expiry", `{"access_token":""}`},
		{"missing token with omitted expiry", `{}`},
		{"permanent key", `{"access_token":"fixture-permanent-deepgram-key","expires_in":30}`},
		{"permanent key with omitted expiry", `{"access_token":"fixture-permanent-deepgram-key"}`},
		{"excessive expiry", `{"access_token":"temporary","expires_in":31}`},
		{"zero expiry", `{"access_token":"temporary","expires_in":0}`},
		{"negative expiry", `{"access_token":"temporary","expires_in":-1}`},
		{"null expiry", `{"access_token":"temporary","expires_in":null}`},
		{"string expiry", `{"access_token":"temporary","expires_in":"30"}`},
		{"fractional expiry", `{"access_token":"temporary","expires_in":1.5}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, tc.body), nil
			})
			w := requestAPI(handler, "/api/voice/token", `{}`)
			if w.Code != 502 || !strings.Contains(w.Body.String(), "voice_provider_invalid_response") {
				t.Fatalf("unsafe grant accepted: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestRateLimitGlobalCapAndReset(t *testing.T) {
	limiter := newRateLimiter(1, 2)
	now := time.Date(2026, 11, 3, 9, 0, 10, 0, time.UTC)
	if limiter.allow("192.0.2.1:1000", now) != 0 || limiter.allow("192.0.2.2:1000", now) != 0 {
		t.Fatal("expected two different IPs to be allowed")
	}
	if limiter.allow("192.0.2.3:1000", now) != 50 {
		t.Fatal("the global cap should block a new IP until the next minute")
	}
	if limiter.allow("192.0.2.1:2000", now.Add(time.Minute)) != 0 {
		t.Fatal("the next minute should reset both IP and global counts")
	}
}
