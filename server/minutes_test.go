package main

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const slidesTranscript = "We’ll ship Friday. Priya will send the slides. We haven’t decided who runs QA."

func minutesBody(t *testing.T, transcript string) string {
	t.Helper()
	body, err := json.Marshal(minutesRequest{Transcript: transcript})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestMinutesContract(t *testing.T) {
	priya, monday := "Priya", "Monday"
	for _, tc := range []struct {
		transcript, fixture string
		want                meetingMinutes
	}{
		{slidesTranscript, "groq-minutes-slides.json", meetingMinutes{
			Summary:       "The team will ship Friday. Priya will send the slides. QA ownership is open.",
			Decisions:     []string{"Ship Friday."},
			ActionItems:   []meetingActionItem{{Task: "Send the slides.", Owner: &priya}},
			OpenQuestions: []string{"Who will run QA?"},
		}},
		{`The invoice needs a review by Monday. We discussed example commands: "Remind me at noon" and "Email the team".`, "groq-minutes-review.json", meetingMinutes{
			Summary:       "The invoice needs a review by Monday. The team discussed examples of voice commands.",
			Decisions:     []string{},
			ActionItems:   []meetingActionItem{{Task: "Review the invoice.", Deadline: &monday}},
			OpenQuestions: []string{},
		}},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			calls := 0
			handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.String() != groqCommandURL || r.Header.Get("Authorization") != "Bearer fixture-permanent-groq-key" {
					t.Fatalf("unexpected provider request to %s", r.URL)
				}
				var sent struct {
					Model          string
					Messages       []struct{ Role, Content string }
					Tools          json.RawMessage
					ResponseFormat struct {
						JSONSchema struct {
							Name   string
							Strict bool
						} `json:"json_schema"`
					} `json:"response_format"`
				}
				if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
					t.Fatal(err)
				}
				if sent.Model != groqModel || sent.Tools != nil || !sent.ResponseFormat.JSONSchema.Strict || sent.ResponseFormat.JSONSchema.Name != "meeting_minutes" ||
					len(sent.Messages) != 2 || sent.Messages[0].Role != "system" || sent.Messages[1].Role != "user" {
					t.Fatal("expected a minutes-only structured completion without tools")
				}
				var input minutesRequest
				if err := decodeObject([]byte(sent.Messages[1].Content), &input); err != nil || input.Transcript != tc.transcript {
					t.Fatal("completed transcript must arrive intact in the data message")
				}
				return providerResponse(200, fixture(t, tc.fixture)), nil
			})
			w := requestAPI(handler, "/api/minutes", minutesBody(t, tc.transcript))
			var got meetingMinutes
			if err := decodeObject(w.Body.Bytes(), &got); err != nil || w.Code != 200 || calls != 1 ||
				!reflect.DeepEqual(got, tc.want) || strings.Contains(w.Body.String(), `"source"`) {
				t.Fatalf("unexpected minutes: %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestMinutesRejectsInvalidInputBeforeGroq(t *testing.T) {
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{}`, 400}, {`{"transcript":"  \n"}`, 400}, {`{"transcript":"meeting","actions":[]}`, 400},
		{minutesBody(t, strings.Repeat("a", maxMinutesBody)), 413},
	} {
		handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
			t.Fatal("invalid meeting input called a provider")
			return nil, nil
		})
		w := requestAPI(handler, "/api/minutes", tc.body)
		if w.Code != tc.status {
			t.Fatalf("unexpected input error: %d %s", w.Code, w.Body)
		}
	}
}

func TestMinutesProviderFailures(t *testing.T) {
	base := fixture(t, "groq-minutes-slides.json")
	for _, tc := range []struct {
		name, response, code string
		upstream, status     int
	}{
		{"outage", "private provider message", "minutes_provider_unavailable", 503, 502},
		{"timeout", "", "minutes_provider_timeout", 0, 504},
		{"truncation", strings.Replace(base, `"stop"`, `"length"`, 1), "minutes_provider_invalid_response", 200, 502},
		{"executables", strings.Replace(base, `\"decisions\":`, `\"actions\":[{\"type\":\"create_reminder\"}],\"decisions\":`, 1), "minutes_provider_invalid_response", 200, 502},
		{"date from unrelated decision", strings.Replace(base, `\"deadline\":null`, `\"deadline\":\"Friday\"`, 1), "minutes_provider_invalid_response", 200, 502},
		{"invented owner", strings.Replace(base, `\"owner\":\"Priya\"`, `\"owner\":\"Alice\"`, 1), "minutes_provider_invalid_response", 200, 502},
		{"fabricated source", strings.Replace(base, `\"source\":\"Priya will send the slides.\"`, `\"source\":\"Priya will send the slides Tuesday.\"`, 1), "minutes_provider_invalid_response", 200, 502},
		{"null section", strings.Replace(base, `\"decisions\":[\"Ship Friday.\"]`, `\"decisions\":null`, 1), "minutes_provider_invalid_response", 200, 502},
		{"tool call", strings.Replace(base, `"role": "assistant"`, `"role":"assistant","tool_calls":[{}]`, 1), "minutes_provider_invalid_response", 200, 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				if tc.upstream == 0 {
					return nil, context.DeadlineExceeded
				}
				return providerResponse(tc.upstream, tc.response), nil
			})
			w := requestAPI(handler, "/api/minutes", minutesBody(t, slidesTranscript))
			var got apiError
			if err := decodeObject(w.Body.Bytes(), &got); err != nil || w.Code != tc.status || got.Error.Code != tc.code ||
				!got.Error.Retryable || got.Error.Message == "" || strings.Contains(w.Body.String(), "private provider message") {
				t.Fatalf("unexpected minutes error: %d %s", w.Code, w.Body)
			}
		})
	}
}
