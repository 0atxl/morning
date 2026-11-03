package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const draftTranscript = "Draft Priya an email asking her to confirm the revised timeline."
const compoundTranscript = "Draft Priya an email asking her to confirm the revised timeline, and remind me Friday at ten AM to follow up."

func draftRequest() commandRequest {
	return commandRequest{
		CommandID: "draft-follow-up-1", Transcript: compoundTranscript,
		Now: "2026-11-03T09:00:00+05:30", Timezone: "Asia/Kolkata",
		Contacts: []contact{{ID: "priya-shah", Name: "Priya Shah", Email: "priya.shah@example.com"}},
	}
}

func requestCommand(t *testing.T, handler http.Handler, request commandRequest) (int, string) {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	w := requestAPI(handler, "/api/commands", string(body))
	return w.Code, w.Body.String()
}

func addSecondPriya(request *commandRequest) {
	request.Contacts = append(request.Contacts, contact{ID: "priya-rao", Name: "Priya Rao", Email: "priya.rao@example.com"})
}

func TestDraftAndCompoundContracts(t *testing.T) {
	for _, tc := range []struct {
		name, transcript, fixture string
		actions                   int
	}{
		{"draft alone", draftTranscript, "groq-draft.json", 1},
		{"draft and reminder", compoundTranscript, "groq-draft-reminder.json", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := draftRequest()
			request.Transcript = tc.transcript
			handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
				var body struct {
					Messages []struct{ Content string } `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if len(body.Messages) != 2 {
					t.Fatal("expected transcript and contact data separate from instructions")
				}
				var context commandRequest
				if err := json.Unmarshal([]byte(body.Messages[1].Content), &context); err != nil {
					t.Fatal(err)
				}
				if context.CommandID != "" || context.Transcript != tc.transcript || context.Now != request.Now || context.Timezone != request.Timezone || len(context.Contacts) != 1 || context.Contacts[0] != request.Contacts[0] {
					t.Fatalf("unexpected model context: %+v", context)
				}
				return providerResponse(200, fixture(t, tc.fixture)), nil
			})
			status, body := requestCommand(t, handler, request)
			var result commandResponse
			if err := decodeObject([]byte(body), &result); err != nil {
				t.Fatal(err)
			}
			if status != 200 || result.CommandID != request.CommandID || result.Clarification != nil || len(result.ClarificationOptions) != 0 || len(result.Actions) != tc.actions {
				t.Fatalf("unexpected result: %d %s", status, body)
			}
			draft := result.Actions[0]
			if draft.Type != "draft_email" || draft.ToContactID != "priya-shah" || draft.Subject != "Confirm the revised timeline" || draft.Body != "Hi Priya,\n\nCould you confirm the revised timeline?\n\nThanks!" {
				t.Fatalf("unexpected draft: %+v", draft)
			}
			if tc.actions == 2 {
				reminder := result.Actions[1]
				if reminder.Type != "create_reminder" || reminder.Title != "Follow up with Priya" || reminder.DueAt != "2026-11-06T10:00:00+05:30" {
					t.Fatalf("unexpected reminder: %+v", reminder)
				}
			}
			if strings.Contains(body, "recipient_name") || strings.Contains(body, "clarification_options") || strings.Contains(body, "@") {
				t.Fatalf("success must expose only the agreed action fields: %s", body)
			}
		})
	}
}

func TestAmbiguousContactsOverrideModelChoice(t *testing.T) {
	for _, providerFixture := range []string{"groq-contact-clarification.json", "groq-draft.json", "groq-draft-reminder.json"} {
		t.Run(providerFixture, func(t *testing.T) {
			request := draftRequest()
			addSecondPriya(&request)
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, fixture(t, providerFixture)), nil
			})
			status, body := requestCommand(t, handler, request)
			var result commandResponse
			if err := json.Unmarshal([]byte(body), &result); err != nil {
				t.Fatal(err)
			}
			if status != 200 || result.Actions == nil || len(result.Actions) != 0 || result.Clarification == nil || *result.Clarification != "Which Priya should I draft the email to?" || len(result.ClarificationOptions) != 2 {
				t.Fatalf("ambiguity did not block all actions: %d %s", status, body)
			}
			for i, option := range result.ClarificationOptions {
				contact := request.Contacts[i]
				if option.ContactID != contact.ID || option.Name != contact.Name || option.Email != contact.Email {
					t.Fatalf("choice must come from the request snapshot: %+v", option)
				}
			}
		})
	}
}

func TestSelectedContactResolvesPendingCommand(t *testing.T) {
	request := draftRequest()
	addSecondPriya(&request)
	selected := "priya-rao"
	request.SelectedContactID = &selected
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		var body struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		var context commandRequest
		if err := json.Unmarshal([]byte(body.Messages[1].Content), &context); err != nil {
			t.Fatal(err)
		}
		if context.SelectedContactID == nil || *context.SelectedContactID != selected || context.Now != request.Now || context.Transcript != request.Transcript {
			t.Fatal("selection must retain the original command context")
		}
		return providerResponse(200, strings.ReplaceAll(fixture(t, "groq-draft-reminder.json"), "priya-shah", "priya-rao")), nil
	})
	// The backend is stateless. Replays retain the ID and produce a complete pair;
	// the browser's command receipt is responsible for saving that pair once.
	for i := 0; i < 2; i++ {
		status, body := requestCommand(t, handler, request)
		var result commandResponse
		if err := json.Unmarshal([]byte(body), &result); err != nil {
			t.Fatal(err)
		}
		if status != 200 || result.CommandID != request.CommandID || len(result.Actions) != 2 || result.Actions[0].ToContactID != selected || result.Actions[1].DueAt != "2026-11-06T10:00:00+05:30" {
			t.Fatalf("selection or replay changed command context: %d %s", status, body)
		}
	}
}

func TestRejectsInvalidContactContext(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*commandRequest)
	}{
		{"duplicate IDs", func(r *commandRequest) { r.Contacts = append(r.Contacts, r.Contacts[0]) }},
		{"invalid ID", func(r *commandRequest) { r.Contacts[0].ID = "invalid id" }},
		{"invalid email", func(r *commandRequest) { r.Contacts[0].Email = "not-an-address" }},
		{"email header injection", func(r *commandRequest) { r.Contacts[0].Email = "priya@example.com\nBcc: other@example.com" }},
		{"unknown selection", func(r *commandRequest) { selected := "missing"; r.SelectedContactID = &selected }},
		{"empty selection", func(r *commandRequest) { selected := ""; r.SelectedContactID = &selected }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := draftRequest()
			tc.change(&request)
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				t.Fatal("invalid contact context must not call Groq")
				return nil, nil
			})
			status, body := requestCommand(t, handler, request)
			if status != 400 || !strings.Contains(body, `"code":"invalid_request"`) {
				t.Fatalf("invalid context was accepted: %d %s", status, body)
			}
		})
	}
	request := draftRequest()
	request.Contacts = append(request.Contacts, contact{ID: "anita", Name: "Anita Rao", Email: "anita@example.com"})
	selected := "anita"
	request.SelectedContactID = &selected
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		return providerResponse(200, fixture(t, "groq-draft-reminder.json")), nil
	})
	status, body := requestCommand(t, handler, request)
	if status != 400 || !strings.Contains(body, `"code":"invalid_request"`) || strings.Contains(body, `"actions"`) {
		t.Fatalf("selection outside matching candidates was accepted: %d %s", status, body)
	}
}

func TestMissingContactAndTimeBlockAllActions(t *testing.T) {
	for _, tc := range []struct {
		name, providerFixture, transcript string
		noContacts                        bool
	}{
		{"missing contact", "groq-contact-clarification.json", compoundTranscript, true},
		{"missing time", "groq-draft-time-clarification.json", "Draft Priya an email asking her to confirm the revised timeline, and remind me to follow up.", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := draftRequest()
			request.Transcript = tc.transcript
			if tc.noContacts {
				request.Contacts = nil
			}
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, fixture(t, tc.providerFixture)), nil
			})
			status, body := requestCommand(t, handler, request)
			var result commandResponse
			if err := json.Unmarshal([]byte(body), &result); err != nil {
				t.Fatal(err)
			}
			if status != 200 || result.Actions == nil || len(result.Actions) != 0 || result.Clarification == nil || len(result.ClarificationOptions) != 0 {
				t.Fatalf("expected zero actions and a question: %d %s", status, body)
			}
		})
	}
}

func TestFullNameNarrowsContactChoices(t *testing.T) {
	request := draftRequest()
	addSecondPriya(&request)
	request.Transcript = strings.Replace(request.Transcript, "Priya", "priya rao", 1)
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		body := strings.ReplaceAll(fixture(t, "groq-draft-reminder.json"), "priya-shah", "priya-rao")
		body = strings.Replace(body, `\"recipient_name\":\"Priya\"`, `\"recipient_name\":\"priya rao\"`, 1)
		return providerResponse(200, body), nil
	})
	status, body := requestCommand(t, handler, request)
	var result commandResponse
	if err := json.Unmarshal([]byte(body), &result); err != nil {
		t.Fatal(err)
	}
	if status != 200 || len(result.Actions) != 2 || result.Actions[0].ToContactID != "priya-rao" || len(result.ClarificationOptions) != 0 {
		t.Fatalf("full name should resolve one contact: %d %s", status, body)
	}
}

func TestInvalidDraftOutputRejectsWholeCommand(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*modelInterpretation, *commandRequest)
	}{
		{"unknown recipient ID", func(m *modelInterpretation, _ *commandRequest) { m.Actions[0].ToContactID = "invented" }},
		{"missing recipient context", func(m *modelInterpretation, _ *commandRequest) { m.RecipientName = nil }},
		{"invented recipient name", func(m *modelInterpretation, _ *commandRequest) { name := "Priya Shah"; m.RecipientName = &name }},
		{"empty subject", func(m *modelInterpretation, _ *commandRequest) { m.Actions[0].Subject = "" }},
		{"subject header injection", func(m *modelInterpretation, _ *commandRequest) {
			m.Actions[0].Subject = "Timeline\nBcc: other@example.com"
		}},
		{"empty body", func(m *modelInterpretation, _ *commandRequest) { m.Actions[0].Body = "" }},
		{"body too long", func(m *modelInterpretation, _ *commandRequest) { m.Actions[0].Body = strings.Repeat("x", 8001) }},
		{"body control character", func(m *modelInterpretation, _ *commandRequest) { m.Actions[0].Body = "Hello\x00Priya" }},
		{"reminder fields on draft", func(m *modelInterpretation, _ *commandRequest) { m.Actions[0].DueAt = "2026-11-06T10:00:00+05:30" }},
		{"invalid reminder after valid draft", func(m *modelInterpretation, _ *commandRequest) { m.Actions[1].DueAt = "2026-11-02T10:00:00+05:30" }},
		{"duplicate drafts", func(m *modelInterpretation, _ *commandRequest) { m.Actions[1] = m.Actions[0] }},
		{"too many actions", func(m *modelInterpretation, _ *commandRequest) { m.Actions = append(m.Actions, m.Actions[0]) }},
		{"partial reminder only", func(m *modelInterpretation, _ *commandRequest) { m.Actions = m.Actions[1:] }},
		{"wrong selected recipient", func(_ *modelInterpretation, r *commandRequest) {
			addSecondPriya(r)
			selected := "priya-rao"
			r.SelectedContactID = &selected
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var envelope struct {
				Choices []struct {
					Message struct{ Content string } `json:"message"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(fixture(t, "groq-draft-reminder.json")), &envelope); err != nil {
				t.Fatal(err)
			}
			var model modelInterpretation
			if err := json.Unmarshal([]byte(envelope.Choices[0].Message.Content), &model); err != nil {
				t.Fatal(err)
			}
			request := draftRequest()
			tc.change(&model, &request)
			content, err := json.Marshal(model)
			if err != nil {
				t.Fatal(err)
			}
			response, err := json.Marshal(map[string]any{
				"choices": []any{map[string]any{
					"finish_reason": "stop", "message": map[string]string{"content": string(content)},
				}},
			})
			if err != nil {
				t.Fatal(err)
			}
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, string(response)), nil
			})
			status, body := requestCommand(t, handler, request)
			if status != 422 || !strings.Contains(body, "command_provider_invalid_response") || strings.Contains(body, `"actions"`) {
				t.Fatalf("invalid output escaped validation: %d %s", status, body)
			}
		})
	}
}

func TestCompoundCommandRejectsEitherMissingHalf(t *testing.T) {
	for _, transcript := range []string{
		"Draft Priya an email asking for the revised timeline, and remind me Friday at ten to follow up.",
		"Remind me Friday at ten to follow up, and draft Priya an email asking for the revised timeline.",
	} {
		for _, providerFixture := range []string{"groq-incomplete-draft-only.json", "groq-incomplete-reminder-only.json"} {
			t.Run(transcript+"/"+providerFixture, func(t *testing.T) {
				request := draftRequest()
				request.Transcript = transcript
				handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
					return providerResponse(200, fixture(t, providerFixture)), nil
				})
				status, body := requestCommand(t, handler, request)
				var result apiError
				// Strict decoding also rejects an actions field in the error response.
				if err := decodeObject([]byte(body), &result); err != nil {
					t.Fatalf("incomplete response exposed executable fields: %s", body)
				}
				if status != 422 || result.CommandID != request.CommandID || result.Error.Code != "command_provider_invalid_response" {
					t.Fatalf("incomplete compound command was accepted: %d %s", status, body)
				}
			})
		}
	}
}

func TestSingleActionCommandsRemainValid(t *testing.T) {
	for _, tc := range []struct{ name, transcript, providerFixture, actionType string }{
		{"draft alone", "Draft Priya an email asking for the revised timeline.", "groq-incomplete-draft-only.json", "draft_email"},
		{"reminder alone", "Remind me Friday at ten AM to follow up with Priya.", "groq-incomplete-reminder-only.json", "create_reminder"},
		{"draft asking the recipient to remind me", "Draft Priya an email asking her to remind me Friday at ten AM.", "groq-incomplete-draft-only.json", "draft_email"},
		{"reminder to draft an email", "Remind me Friday at ten AM to draft Priya an email asking for the revised timeline.", "groq-incomplete-reminder-only.json", "create_reminder"},
		{"quoted draft content", `Draft Priya an email saying "Check the revised timeline and remind me Friday at ten AM."`, "groq-incomplete-draft-only.json", "draft_email"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := draftRequest()
			request.Transcript = tc.transcript
			if tc.actionType == "create_reminder" {
				request.Contacts = nil
			}
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, fixture(t, tc.providerFixture)), nil
			})
			status, body := requestCommand(t, handler, request)
			var result commandResponse
			if err := decodeObject([]byte(body), &result); err != nil {
				t.Fatal(err)
			}
			if status != 200 || result.CommandID != request.CommandID || len(result.Actions) != 1 || result.Actions[0].Type != tc.actionType || result.Clarification != nil {
				t.Fatalf("genuine single-action command was rejected: %d %s", status, body)
			}
		})
	}
}

func TestCombiningMarksDistinguishContactNames(t *testing.T) {
	for _, tc := range []struct{ name, contactID, providerFixture string }{
		{"रीना", "reena", "groq-draft-reena.json"},
		{"रैना", "raina", "groq-draft-raina.json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := draftRequest()
			request.Transcript = "Draft " + tc.name + " an email asking for the revised timeline."
			request.Contacts = []contact{
				{ID: "reena", Name: "रीना", Email: "reena@example.com"},
				{ID: "raina", Name: "रैना", Email: "raina@example.com"},
			}
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return providerResponse(200, fixture(t, tc.providerFixture)), nil
			})
			status, body := requestCommand(t, handler, request)
			var result commandResponse
			if err := decodeObject([]byte(body), &result); err != nil {
				t.Fatal(err)
			}
			if status != 200 || len(result.Actions) != 1 || result.Actions[0].Type != "draft_email" || result.Actions[0].ToContactID != tc.contactID || result.Clarification != nil || len(result.ClarificationOptions) != 0 {
				t.Fatalf("combining marks must distinguish the two contacts: %d %s", status, body)
			}
		})
	}
}
