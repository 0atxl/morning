package main

import (
	"net/http"
	"strings"
	"testing"
)

const calendarTranscript = "Schedule a project review Friday at three PM for thirty minutes."

func calendarRequest(transcript string) commandRequest {
	return commandRequest{CommandID: "review-1", Transcript: transcript, Now: "2026-11-03T09:00:00+05:30", Timezone: "Asia/Kolkata"}
}

func TestCalendarExportContract(t *testing.T) {
	base := fixture(t, "groq-calendar-review.json")
	for _, tc := range []struct {
		name, zone, now, start, end, wantEnd, startPhrase, endPhrase string
	}{
		{"Friday duration", "Asia/Kolkata", "2026-11-03T09:00:00+05:30", "2026-11-06T15:00:00+05:30", "30m", "2026-11-06T15:30:00+05:30", "Friday at three PM", "for thirty minutes"},
		{"explicit end", "Asia/Kolkata", "2026-11-03T09:00:00+05:30", "2026-11-06T15:00:00+05:30", "2026-11-06T16:00:00+05:30", "2026-11-06T16:00:00+05:30", "Friday at three PM", "until four PM"},
		{"duration crosses spring clock change", "America/New_York", "2026-03-07T12:00:00-05:00", "2026-03-08T01:45:00-05:00", "30m", "2026-03-08T03:15:00-04:00", "Sunday at 1:45 AM", "for thirty minutes"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := calendarRequest("Schedule a project review " + tc.startPhrase + " " + tc.endPhrase + ".")
			request.Now, request.Timezone = tc.now, tc.zone
			completion := strings.NewReplacer("2026-11-06T15:00:00+05:30", tc.start, "30m", tc.end, "Friday at three PM", tc.startPhrase, "for thirty minutes", tc.endPhrase).Replace(base)
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) { return providerResponse(200, completion), nil })
			status, body := requestCommand(t, handler, request)
			// Decode against the browser contract. Internal timing evidence or other action fields must not escape.
			type publicEvent struct{ Type, Title, Start, End, Timezone string }
			var reply struct {
				CommandID     string `json:"command_id"`
				Actions       []publicEvent
				Clarification *string
			}
			want := publicEvent{"create_calendar_event", "Project review", tc.start, tc.wantEnd, tc.zone}
			if err := decodeObject([]byte(body), &reply); err != nil || status != 200 || reply.CommandID != request.CommandID ||
				reply.Clarification != nil || len(reply.Actions) != 1 || reply.Actions[0] != want {
				t.Fatalf("unexpected calendar reply: %d %s", status, body)
			}
		})
	}
}

func TestCalendarClarification(t *testing.T) {
	for _, tc := range []struct{ name, transcript, fixtureName, question string }{
		{"missing duration", "Schedule a project review Friday at three PM.", "groq-calendar-clarification.json", "How long should the project review last?"},
		{"provider guessed duration", "Schedule a project review Friday at three PM.", "groq-calendar-review.json", "How long should the event last?"},
		{"no start", "Schedule a meeting for thirty minutes.", "groq-calendar-review.json", "When should the event start?"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, fixture(t, tc.fixtureName)), nil
			})
			status, body := requestCommand(t, handler, calendarRequest(tc.transcript))
			var reply commandResponse
			if err := decodeObject([]byte(body), &reply); err != nil || status != 200 || reply.CommandID != "review-1" ||
				reply.Actions == nil || len(reply.Actions) != 0 || reply.Clarification == nil || *reply.Clarification != tc.question {
				t.Fatalf("expected a clarification: %d %s", status, body)
			}
		})
	}
}

func TestCalendarIsDistinctFromReminder(t *testing.T) {
	const reminder = "Remind me in ten minutes to schedule a meeting."
	reminderFixture := strings.ReplaceAll(fixture(t, "groq-reminder.json"), "Check the oven", "Schedule a meeting")
	for _, tc := range []struct {
		transcript, completion string
		wantStatus             int
	}{
		{reminder, reminderFixture, 200},
		{reminder, fixture(t, "groq-calendar-review.json"), 422},
		{calendarTranscript, reminderFixture, 422},
	} {
		handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
			return providerResponse(200, tc.completion), nil
		})
		status, body := requestCommand(t, handler, calendarRequest(tc.transcript))
		if status != tc.wantStatus || status == 200 && !strings.Contains(body, `"type":"create_reminder"`) ||
			status == 422 && (strings.Contains(body, `"actions"`) || !strings.Contains(body, "command_provider_invalid_response")) {
			t.Fatalf("incorrect scheduling intent for %q: %d %s", tc.transcript, status, body)
		}
	}
}

func TestInvalidCalendarOutput(t *testing.T) {
	base := fixture(t, "groq-calendar-review.json")
	for _, tc := range []struct{ name, from, to string }{
		{"empty title", "Project review", ""},
		{"past start", "2026-11-06T15:00:00", "2026-11-02T15:00:00"},
		{"wrong start offset", "+05:30", "+00:00"},
		{"wrong end offset", "30m", "2026-11-06T16:00:00+00:00"},
		{"end before start", "30m", "2026-11-06T14:00:00+05:30"},
		{"zero duration", "30m", "0m"},
		{"missing end", `,\"end\":\"30m\"`, ""},
		{"extra property", `\"title\":`, `\"attendees\":[],\"title\":`},
		{"event plus reminder", `}],`, `},{\"type\":\"create_reminder\",\"title\":\"Review\",\"due_at\":\"2026-11-06T15:00:00+05:30\"}],`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, strings.Replace(base, tc.from, tc.to, 1)), nil
			})
			status, body := requestCommand(t, handler, calendarRequest(calendarTranscript))
			var reply apiError
			if err := decodeObject([]byte(body), &reply); err != nil || status != 422 || reply.Error.Code != "command_provider_invalid_response" {
				t.Fatalf("invalid calendar action accepted: %d %s", status, body)
			}
		})
	}
}
