package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestGroqRateLimitFallsBackAndCoolsDownModel(t *testing.T) {
	var seenModels []string
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		seenModels = append(seenModels, body.Model)
		if body.Model == defaultGroqModels[0] {
			resp := providerResponse(429, `{"error":{"message":"rate limit"}}`)
			resp.Header.Set("Retry-After", "30")
			return resp, nil
		}
		return providerResponse(200, fixture(t, "groq-reminder.json")), nil
	})

	// First request hits 429 on model 0, falls back immediately to model 1 and succeeds.
	w := requestAPI(handler, "/api/commands", fixtureCommand)
	if w.Code != 200 {
		t.Fatalf("expected seamless fallback to model 1, got %d %s", w.Code, w.Body.String())
	}
	if len(seenModels) != 2 || seenModels[0] != defaultGroqModels[0] || seenModels[1] != defaultGroqModels[1] {
		t.Fatalf("unexpected fallback order: %v", seenModels)
	}

	// Second request immediately skips the cooled-down model 0 and goes straight to model 1.
	seenModels = nil
	w = requestAPI(handler, "/api/commands", fixtureCommand)
	if w.Code != 200 || len(seenModels) != 1 || seenModels[0] != defaultGroqModels[1] {
		t.Fatalf("expected cooldown to skip model 0, got %d models=%v", w.Code, seenModels)
	}
}

func TestRecentTurnsAndForgivingContactResolution(t *testing.T) {
	for _, tc := range []struct {
		name          string
		recipientName *string
		subject       string
		body          string
	}{
		{"full saved name accepted", strPtr("Priya Shah"), " NVIDIA CEO update ", "Hi Priya,\n\nJensen Huang is the CEO of NVIDIA.\n\nThanks!\n"},
		{"omitted recipient_name accepted", nil, "NVIDIA CEO update", "Hi Priya,\n\nJensen Huang is the CEO of NVIDIA.\n\nBest,"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := commandRequest{
				CommandID:  "email-priya-about-this",
				Transcript: "Draft an email to Priya about this.",
				Now:        "2026-11-03T09:05:00+05:30",
				Timezone:   "Asia/Kolkata",
				Contacts:   []contact{{ID: "priya-shah", Name: "Priya Shah", Email: "priya.shah@example.com"}},
				RecentTurns: []recentTurnContext{{
					Transcript:   "Who is NVIDIA's CEO?",
					Kind:         "web",
					Topic:        "NVIDIA CEO",
					Answer:       "Jensen Huang is the CEO of NVIDIA.",
					PriorSession: true,
				}},
			}
			handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
				var payload struct{ Messages []struct{ Content string } }
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(payload.Messages[1].Content, `"recent_turns"`) || !strings.Contains(payload.Messages[1].Content, `"prior_session":true`) {
					t.Fatalf("recent_turns missing from Groq input: %s", payload.Messages[1].Content)
				}
				return lookupIntentResponse(modelInterpretation{
					RecipientName: tc.recipientName,
					Actions: []action{{
						Type:        "draft_email",
						ToContactID: "priya-shah",
						Subject:     tc.subject,
						Body:        tc.body,
					}},
				}), nil
			})
			status, body := requestCommand(t, handler, request)
			var resp commandResponse
			if err := json.Unmarshal([]byte(body), &resp); err != nil || status != 200 || len(resp.Actions) != 1 || resp.Actions[0].ToContactID != "priya-shah" {
				t.Fatalf("expected clean 200 draft, got %d %s", status, body)
			}
			if resp.Actions[0].Subject != strings.TrimSpace(tc.subject) || resp.Actions[0].Body != strings.TrimSpace(tc.body) {
				t.Fatalf("expected trimmed draft fields, got %+v", resp.Actions[0])
			}
		})
	}

	// Ambiguity safety preserved: if two Priyas exist, full-name model guess still disambiguates.
	request := draftRequest()
	addSecondPriya(&request)
	request.Transcript = "Draft an email to Priya about this."
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		return lookupIntentResponse(modelInterpretation{
			RecipientName: strPtr("Priya Shah"),
			Actions: []action{{
				Type:        "draft_email",
				ToContactID: "priya-shah",
				Subject:     "Update",
				Body:        "Hi Priya, here is the update.",
			}},
		}), nil
	})
	status, body := requestCommand(t, handler, request)
	var resp commandResponse
	if json.Unmarshal([]byte(body), &resp) != nil || status != 200 || len(resp.Actions) != 0 || len(resp.ClarificationOptions) != 2 {
		t.Fatalf("ambiguous Priyas must still ask for disambiguation: %d %s", status, body)
	}
}

func TestMultiItemReminderAndDraftUpdateAndDelete(t *testing.T) {
	due1, _ := time.Parse(time.RFC3339, "2026-11-03T10:00:00+05:30")
	due2, _ := time.Parse(time.RFC3339, "2026-11-03T11:00:00+05:30")
	baseReq := commandRequest{
		CommandID: "multi-edit-1",
		Now:       "2026-11-03T09:00:00+05:30",
		Timezone:  "Asia/Kolkata",
		Contacts: []contact{
			{ID: "priya-shah", Name: "Priya Shah", Email: "priya.shah@example.com"},
			{ID: "alex-chen", Name: "Alex Chen", Email: "alex.chen@example.com"},
		},
		RemindersContext: []reminderContextItem{
			{ID: "rem-1", Title: "Call Priya", DueAt: due1},
			{ID: "rem-2", Title: "Check oven", DueAt: due2},
		},
		DraftsContext: []draftContext{
			{ID: "draft:d1", Subject: "Timeline", Body: "Hi Priya", Recipient: "Priya Shah", To: "priya.shah@example.com"},
			{ID: "draft:d2", Subject: "Budget", Body: "Hi Alex", Recipient: "Alex Chen", To: "alex.chen@example.com"},
		},
	}

	// 1. Update reminder #2 title + time.
	t.Run("update reminder title and time", func(t *testing.T) {
		req := baseReq
		req.Transcript = "Rename the check oven reminder to turn off oven and move it to noon."
		handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
			return lookupIntentResponse(modelInterpretation{
				Actions: []action{{
					Type:       "reschedule_reminder",
					ReminderID: "rem-2",
					Title:      "Turn off oven",
					DueAt:      "2026-11-03T12:00:00+05:30",
				}},
			}), nil
		})
		status, body := requestCommand(t, handler, req)
		var resp commandResponse
		if json.Unmarshal([]byte(body), &resp) != nil || status != 200 || len(resp.Actions) != 1 || resp.Actions[0].ReminderID != "rem-2" || resp.Actions[0].Title != "Turn off oven" {
			t.Fatalf("unexpected reminder update: %d %s", status, body)
		}
	})

	// 2. Delete reminder #1.
	t.Run("delete reminder", func(t *testing.T) {
		req := baseReq
		req.Transcript = "Delete my call Priya reminder."
		handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
			return lookupIntentResponse(modelInterpretation{
				Actions: []action{{Type: "delete_reminder", ReminderID: "rem-1"}},
			}), nil
		})
		status, body := requestCommand(t, handler, req)
		var resp commandResponse
		if json.Unmarshal([]byte(body), &resp) != nil || status != 200 || len(resp.Actions) != 1 || resp.Actions[0].Type != "delete_reminder" || resp.Actions[0].ReminderID != "rem-1" {
			t.Fatalf("unexpected reminder delete: %d %s", status, body)
		}
	})

	// 3. Update draft #1 including recipient change to Alex.
	t.Run("update draft recipient and body", func(t *testing.T) {
		req := baseReq
		req.Transcript = "Change the timeline draft recipient to Alex."
		handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
			return lookupIntentResponse(modelInterpretation{
				Actions: []action{{
					Type:        "update_draft",
					DraftID:     "draft:d1",
					ToContactID: "alex-chen",
					Subject:     "Timeline",
					Body:        "Hi Alex,\n\nPlease review the timeline.",
				}},
			}), nil
		})
		status, body := requestCommand(t, handler, req)
		var resp commandResponse
		if json.Unmarshal([]byte(body), &resp) != nil || status != 200 || len(resp.Actions) != 1 || resp.Actions[0].DraftID != "draft:d1" || resp.Actions[0].ToContactID != "alex-chen" {
			t.Fatalf("unexpected draft update: %d %s", status, body)
		}
	})

	// 4. Delete draft #2.
	t.Run("delete draft", func(t *testing.T) {
		req := baseReq
		req.Transcript = "Delete the budget draft."
		handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
			return lookupIntentResponse(modelInterpretation{
				Actions: []action{{Type: "delete_draft", DraftID: "draft:d2"}},
			}), nil
		})
		status, body := requestCommand(t, handler, req)
		var resp commandResponse
		if json.Unmarshal([]byte(body), &resp) != nil || status != 200 || len(resp.Actions) != 1 || resp.Actions[0].Type != "delete_draft" || resp.Actions[0].DraftID != "draft:d2" {
			t.Fatalf("unexpected draft delete: %d %s", status, body)
		}
	})
}

func TestFastWebLookupUsesTavilyAnswerWithoutSecondGroqCall(t *testing.T) {
	tavilyCalls := 0
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() == groqCommandURL {
			t.Fatal("fast Tavily web lookup with include_answer must not make a second Groq call")
		}
		tavilyCalls++
		return fixtureTavilyREST(t, r, `{"answer":"Jensen Huang is the co-founder, president, and CEO of NVIDIA.","results":[{"title":"NVIDIA Leadership","url":"https://nvidianews.nvidia.com/bios/jensen-huang","content":"Jensen Huang founded NVIDIA in 1993 and has served since its inception as president, chief executive officer and a member of the board of directors."}]}`, func(args map[string]any) {
			if args["include_answer"] != true || args["search_depth"] != "basic" {
				t.Fatalf("expected fast basic search with include_answer, got %v", args)
			}
		}), nil
	})
	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "web", Terms: "NVIDIA CEO"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil || tavilyCalls != 1 {
		t.Fatalf("fast web lookup failed: %+v %v calls=%d", outcome, err, tavilyCalls)
	}
	if outcome.Result.Status != "answered" || !strings.Contains(outcome.Result.Answer, "Jensen Huang") || len(outcome.Result.Sources) != 1 {
		t.Fatalf("unexpected web answer: %+v", outcome.Result)
	}
}

func TestWikiNotFoundFallsBackToTavilyWeb(t *testing.T) {
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Host {
		case "en.wikipedia.org":
			if r.URL.Path == "/w/api.php" {
				return lookupJSONResponse(200, `["NVIDIA CEO",[],[],[]]`), nil
			}
			return lookupJSONResponse(404, `{"type":"not_found"}`), nil
		case "api.tavily.com":
			return fixtureTavilyREST(t, r, `{"answer":"Jensen Huang is the CEO of NVIDIA.","results":[{"title":"NVIDIA Leadership","url":"https://nvidianews.nvidia.com/bios/jensen-huang","content":"Jensen Huang is CEO of NVIDIA."}]}`, nil), nil
		default:
			t.Fatalf("unexpected request: %s", r.URL)
			return nil, nil
		}
	})
	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "NVIDIA CEO"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil || outcome.Result.Status != "answered" || outcome.Result.Kind != "web" || !strings.Contains(outcome.Result.Answer, "Jensen Huang") {
		t.Fatalf("wiki fallback to web failed: %+v %v", outcome, err)
	}
}

func TestFencedJSONAcceptedFromModel(t *testing.T) {
	content := "```json\n{\"actions\":[{\"type\":\"create_reminder\",\"title\":\"Check the oven\",\"due_at\":\"2026-11-03T09:10:00+05:30\"}]}\n```"
	envelope, _ := json.Marshal(map[string]any{
		"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": content}}},
	})
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		return providerResponse(200, string(envelope)), nil
	})
	w := requestAPI(handler, "/api/commands", fixtureCommand)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"Check the oven"`) {
		t.Fatalf("fenced JSON should be parsed cleanly: %d %s", w.Code, w.Body.String())
	}
}

func strPtr(s string) *string { return &s }
