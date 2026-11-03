package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const correctionRequest = `{"command_id":"correction-2","transcript":"Actually, make that eleven.","now":"2026-11-03T09:02:00+05:30","timezone":"Asia/Kolkata","reminder_context":{"id":"draft-follow-up-1","due_at":"2026-11-06T10:00:00+05:30"}}`

func TestRescheduleSavedReminder(t *testing.T) {
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		var payload struct{ Messages []struct{ Content string } }
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload.Messages) != 2 {
			t.Fatalf("unexpected Groq request: %v", err)
		}
		var context map[string]string
		if err := json.Unmarshal([]byte(payload.Messages[1].Content), &context); err != nil {
			t.Fatal(err)
		}
		if len(context) != 4 || context["saved_reminder_due_at"] != "2026-11-06T10:00:00+05:30" ||
			context["transcript"] != "Actually, make that eleven." || context["timezone"] != "Asia/Kolkata" ||
			context["now"] != "2026-11-03T09:02:00+05:30" {
			t.Fatalf("unexpected correction context: %v", context)
		}
		return providerResponse(200, fixture(t, "groq-reschedule.json")), nil
	})
	// The same saved instant can arrive in UTC. On retry the receipt ID and
	// target ID must still refer to the correction and original record respectively.
	request := strings.Replace(correctionRequest, "10:00:00+05:30", "04:30:00Z", 1)
	want := action{Type: "reschedule_reminder", ReminderID: "draft-follow-up-1", DueAt: "2026-11-06T11:00:00+05:30"}
	for i := 0; i < 2; i++ {
		w := requestAPI(handler, "/api/commands", request)
		var got commandResponse
		if err := decodeObject(w.Body.Bytes(), &got); err != nil || w.Code != 200 || got.CommandID != "correction-2" ||
			len(got.Actions) != 1 || got.Actions[0] != want || got.Clarification != nil || len(got.ClarificationOptions) != 0 {
			t.Fatalf("unexpected correction: %d %s", w.Code, w.Body)
		}
	}
}

func TestUnclearCorrectionReturnsQuestion(t *testing.T) {
	for _, tc := range []struct {
		name, transcript, question string
		omitTarget                 bool
	}{
		{"missing target", "Actually, make that eleven.", "Which reminder should I move?", true},
		{"different target", "Move the other reminder to eleven.", "Which reminder should I move?", false},
		{"vague time", "Actually, make that later.", "What time should I move the reminder to?", false},
		{"two possible times", "Actually, make that eleven or noon.", "What time should I move the reminder to?", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var request commandRequest
			if err := json.Unmarshal([]byte(correctionRequest), &request); err != nil {
				t.Fatal(err)
			}
			request.Transcript = tc.transcript
			if tc.omitTarget {
				request.ReminderContext = nil
			}
			// Even a confident provider guess must not move the record.
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, fixture(t, "groq-reschedule.json")), nil
			})
			status, body := requestCommand(t, handler, request)
			var got commandResponse
			if err := decodeObject([]byte(body), &got); err != nil || status != 200 || got.CommandID != request.CommandID ||
				got.Actions == nil || len(got.Actions) != 0 || got.Clarification == nil || *got.Clarification != tc.question {
				t.Fatalf("expected an empty array and a question: %d %s", status, body)
			}
		})
	}
}

func TestUnsafeCorrectionRejected(t *testing.T) {
	base := fixture(t, "groq-reschedule.json")
	for _, tc := range []struct{ name, response string }{
		{"provider supplies target", strings.Replace(base, `\"due_at\"`, `\"reminder_id\":\"unrelated\",\"due_at\"`, 1)},
		{"different Friday", strings.Replace(base, "2026-11-06", "2026-11-13", 1)},
		{"wrong meridiem", strings.Replace(base, "T11:", "T23:", 1)},
		{"wrong offset", strings.Replace(base, "+05:30", "+00:00", 1)},
		{"past due", strings.Replace(base, "2026-11-06", "2026-11-01", 1)},
		{"creates duplicate instead", fixture(t, "groq-reminder.json")},
		{"replays compound action", fixture(t, "groq-draft-reminder.json")},
		{"also creates reminder", strings.Replace(base, `}],`, `},{\"type\":\"create_reminder\",\"title\":\"Follow up\",\"due_at\":\"2026-11-06T11:00:00+05:30\"}],`, 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, tc.response), nil
			})
			w := requestAPI(handler, "/api/commands", correctionRequest)
			var got apiError
			if err := decodeObject(w.Body.Bytes(), &got); err != nil || w.Code != 502 || got.Error.Code != "command_provider_invalid_response" {
				t.Fatalf("unsafe correction escaped validation: %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestSavedContextDoesNotTurnNewReminderIntoCorrection(t *testing.T) {
	request := strings.Replace(correctionRequest, "Actually, make that eleven.", "Remind me in ten minutes to check the oven.", 1)
	for _, tc := range []struct {
		fixture string
		status  int
	}{
		{"groq-reminder.json", 200},
		{"groq-reschedule.json", 502},
	} {
		handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
			return providerResponse(200, fixture(t, tc.fixture)), nil
		})
		w := requestAPI(handler, "/api/commands", request)
		if w.Code != tc.status || strings.Contains(w.Body.String(), `"reminder_id"`) {
			t.Fatalf("unexpected response to a new command: %d %s", w.Code, w.Body)
		}
	}
}

func TestInvalidCorrectionContext(t *testing.T) {
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid reminder context reached Groq")
		return nil, nil
	})
	for _, request := range []string{
		strings.Replace(correctionRequest, "draft-follow-up-1", "", 1),
		strings.Replace(correctionRequest, "draft-follow-up-1", "correction-2", 1),
		strings.Replace(correctionRequest, "2026-11-06T10:00:00+05:30", "Friday", 1),
		strings.Replace(correctionRequest, `,"due_at":"2026-11-06T10:00:00+05:30"`, "", 1),
	} {
		w := requestAPI(handler, "/api/commands", request)
		if w.Code != 400 || !strings.Contains(w.Body.String(), `"code":"invalid_request"`) {
			t.Fatalf("invalid context accepted: %d %s", w.Code, w.Body)
		}
	}
}

func TestNaturalTaskCorrectionAndExplicitReminderSelection(t *testing.T) {
	for _, transcript := range []string{"Change the existing task to two minutes.", "No. Change that reminder to two minutes.", "Maybe make that two minutes."} {
		var request commandRequest
		_ = json.Unmarshal([]byte(correctionRequest), &request)
		request.Transcript = transcript
		_, location, _ := validateRequest(request)
		result, err := resolveCorrection(interpretation{Actions: []action{{Type: "reschedule_reminder", DueAt: "2026-11-03T09:04:00+05:30"}}}, request, location)
		if err != nil || len(result.Actions) != 1 || result.Actions[0].ReminderID != request.ReminderContext.ID {
			t.Fatalf("correction lost its target: %v %+v", err, result)
		}
	}
	var request commandRequest
	_ = json.Unmarshal([]byte(correctionRequest), &request)
	request.Transcript = "Move the other reminder to eleven."
	selected := request.ReminderContext.ID
	request.SelectedReminderID = &selected
	_, location, err := validateRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	result, err := resolveCorrection(interpretation{Actions: []action{{Type: "reschedule_reminder", DueAt: "2026-11-06T11:00:00+05:30"}}}, request, location)
	if err != nil || len(result.Actions) != 1 || result.Actions[0].ReminderID != selected {
		t.Fatal("explicit reminder selection did not resolve the target")
	}
	wrong := "another-reminder"
	request.SelectedReminderID = &wrong
	if _, _, err := validateRequest(request); err == nil {
		t.Fatal("mismatched reminder selection accepted")
	}
}
