package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestDraftRevisionUsesSavedContextAndServerBindsID(t *testing.T) {
	var request commandRequest
	_ = json.Unmarshal([]byte(fixtureCommand), &request)
	request.Transcript = "Make that email more detailed."
	request.DraftContext = &draftContext{ID: "draft:original", Subject: "Slides", Body: "My reviewed wording", Recipient: "Priya", To: "priya@example.com"}
	savedDue, _ := time.Parse(time.RFC3339, "2026-11-03T09:10:00+05:30")
	request.ReminderContext = &reminderContext{ID: "reminder", DueAt: savedDue}
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		var payload struct{ Messages []struct{ Content string } }
		if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload.Messages) != 2 {
			t.Fatal("invalid provider request")
		}
		var data map[string]json.RawMessage
		_ = json.Unmarshal([]byte(payload.Messages[1].Content), &data)
		var saved map[string]string
		_ = json.Unmarshal(data["saved_draft"], &saved)
		if request.DraftContext != nil && (saved["body"] != request.DraftContext.Body || saved["subject"] != request.DraftContext.Subject) {
			t.Fatal("the saved edits were not passed to Groq")
		}
		model, _ := json.Marshal(modelInterpretation{Actions: []action{{Type: "update_draft", Subject: "Request for slides", Body: "A complete revised draft with a clear request."}}})
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(model)}}}})
		return providerResponse(200, string(body)), nil
	})
	status, body := requestCommand(t, handler, request)
	var response commandResponse
	_ = json.Unmarshal([]byte(body), &response)
	if status != 200 || len(response.Actions) != 1 || response.Actions[0].Type != "update_draft" || response.Actions[0].DraftID != "draft:original" || response.Actions[0].ToContactID != "" {
		t.Fatalf("unexpected draft update: %d %s", status, body)
	}
	request.DraftContext = nil
	status, body = requestCommand(t, handler, request)
	_ = json.Unmarshal([]byte(body), &response)
	if status != 200 || len(response.Actions) != 0 || response.Clarification == nil {
		t.Fatal("a missing draft must clarify without actions")
	}
}
