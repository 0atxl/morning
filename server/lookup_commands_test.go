package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func lookupIntentResponse(model modelInterpretation) *http.Response {
	content, _ := json.Marshal(model)
	body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(content)}}}})
	return providerResponse(200, string(body))
}

func TestLookupCommandWeatherUsesExistingCommandFlow(t *testing.T) {
	t.Setenv("TAVILY_API_KEY", "")
	calls := 0
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		calls++
		switch r.URL.Host {
		case "api.groq.com":
			return lookupIntentResponse(modelInterpretation{Actions: []action{}, Lookup: &lookupQuery{Kind: "weather", Place: "Pune"}}), nil
		case "geocoding-api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
		case "api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		default:
			t.Fatalf("unexpected provider: %s", r.URL)
			return nil, nil
		}
	})
	var request commandRequest
	_ = json.Unmarshal([]byte(fixtureCommand), &request)
	request.Transcript = "What's the weather in Pune right now?"
	status, body := requestCommand(t, handler, request)
	var response commandResponse
	if json.Unmarshal([]byte(body), &response) != nil || status != 200 || calls != 3 || response.CommandID != request.CommandID || response.Lookup == nil || len(response.Actions) != 0 || response.Reply != "" || response.Clarification != nil {
		t.Fatalf("wrong lookup envelope: %d %s", status, body)
	}
	if response.Lookup.Kind != "weather" || !strings.Contains(response.Lookup.Answer, "Pune") || response.Lookup.LookedUpAt == response.Lookup.DataTime {
		t.Fatalf("wrong weather snapshot: %+v", response.Lookup)
	}
}

func TestLookupCommandHindiWeatherKeepsCityStateAndCountry(t *testing.T) {
	t.Setenv("TAVILY_API_KEY", "")
	calls := 0
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		calls++
		switch r.URL.Host {
		case "api.groq.com":
			return lookupIntentResponse(modelInterpretation{ReplyLanguage: "hi", Actions: []action{}, Lookup: &lookupQuery{Kind: "weather", Place: "Pune, Maharashtra, India"}}), nil
		case "geocoding-api.open-meteo.com":
			if r.URL.Query().Get("name") != "Pune, Maharashtra, India" {
				t.Fatal("state/country lost before geocoding")
			}
			// Deliberately include out-of-region results first and with unknown
			// populations. Go must honor the spoken qualifiers, not list order.
			return lookupJSONResponse(200, fixture(t, "open-meteo-pune-namesakes.json")), nil
		case "api.open-meteo.com":
			if r.URL.Query().Get("latitude") != "18.52" || r.URL.Query().Get("longitude") != "73.86" || r.URL.Query().Get("timezone") != "Asia/Kolkata" {
				t.Fatal("weather selected a namesake outside the spoken location")
			}
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		default:
			t.Fatal("weather must not call Tavily or another provider")
			return nil, nil
		}
	})
	request := mustLookupRequest(t)
	request.Transcript = "अभी पुणे, महाराष्ट्र, भारत में क्या मौसम है?"
	status, body := requestCommand(t, handler, request)
	var result commandResponse
	if json.Unmarshal([]byte(body), &result) != nil || status != 200 || result.Lookup == nil || result.Clarification != nil || result.LookupContext != nil || result.ReplyLanguage != "hi" || calls != 3 {
		t.Fatalf("qualified weather must answer without another place question: %d %s", status, body)
	}
	if !strings.Contains(result.Lookup.Answer, "Pune, Maharashtra, India") || result.Lookup.Timezone != "Asia/Kolkata" {
		t.Fatalf("wrong resolved place: %+v", result.Lookup)
	}
}

func TestLookupCommandSpokenPlaceFinishesOriginalSearchWithoutInterpretingAnAction(t *testing.T) {
	t.Setenv("TAVILY_API_KEY", "fixture-tavily-secret")
	intents := 0
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() == groqCommandURL {
			var body struct {
				ResponseFormat struct {
					JSONSchema struct {
						Name string `json:"name"`
					} `json:"json_schema"`
				} `json:"response_format"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Fatal("invalid model request")
			}
			if body.ResponseFormat.JSONSchema.Name == "morning_command" {
				intents++
				if intents > 1 {
					t.Fatal("a spoken place must not run command interpretation again")
				}
				return lookupIntentResponse(modelInterpretation{Actions: []action{}, Lookup: &lookupQuery{Kind: "hotels"}}), nil
			}
			if body.ResponseFormat.JSONSchema.Name == "morning_lookup_place" {
				return lookupPlaceResponse(`{"place":"Jaipur railway station"}`), nil
			}
			return evidenceResponse("", evidenceItem(0, "Hotel Station Garden", "Hotel Station Garden is near Jaipur railway station.")), nil
		}
		return fixtureMCP(t, r, fixture(t, "tavily-hotels.json"), func(args map[string]any) {
			if args["query"] != "Hotels near Jaipur railway station" {
				t.Fatalf("original search lost: %v", args)
			}
		}), nil
	})
	var request commandRequest
	_ = json.Unmarshal([]byte(fixtureCommand), &request)
	request.Transcript = "Find hotels near me"
	status, body := requestCommand(t, handler, request)
	var question commandResponse
	_ = json.Unmarshal([]byte(body), &question)
	if status != 200 || question.LookupContext == nil || question.Clarification == nil || *question.Clarification != "Which city or landmark?" || len(question.Actions) != 0 {
		t.Fatalf("missing place question: %d %s", status, body)
	}
	request.CommandID = "lookup-place-reply"
	request.Transcript = "Jaipur railway station"
	request.LookupContext = question.LookupContext
	status, body = requestCommand(t, handler, request)
	var answer commandResponse
	_ = json.Unmarshal([]byte(body), &answer)
	if status != 200 || answer.Lookup == nil || answer.Lookup.Kind != "hotels" || len(answer.Lookup.Sources) != 1 || answer.LookupContext != nil || len(answer.Actions) != 0 || intents != 1 {
		t.Fatalf("lookup continuation failed: %d %s", status, body)
	}
}

func TestLookupCommandRejectsMixedAndInvalidModelIntentsBeforeRetrieval(t *testing.T) {
	for _, model := range []modelInterpretation{
		{Actions: []action{{Type: "create_reminder", Title: "Injected task", DueAt: "2026-11-03T09:10:00+05:30"}}, Lookup: &lookupQuery{Kind: "weather", Place: "Pune"}},
		{Actions: []action{{Type: "reply", Text: "Unverified answer"}}, Lookup: &lookupQuery{Kind: "web", Terms: "Go release"}},
		{Actions: []action{}, Lookup: &lookupQuery{Kind: "weather", Place: "Pune", Today: true}},
		{Actions: []action{}, Lookup: &lookupQuery{Kind: "send_email", Terms: "Untrusted"}},
	} {
		handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
			if r.URL.String() != groqCommandURL {
				t.Fatal("mixed model output must not retrieve or execute anything")
			}
			return lookupIntentResponse(model), nil
		})
		w := requestAPI(handler, "/api/commands", fixtureCommand)
		if w.Code != 422 || !strings.Contains(w.Body.String(), "command_provider_invalid_response") {
			t.Fatalf("mixed lookup escaped: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestLookupCommandUntrustedContextCannotSelectOtherActions(t *testing.T) {
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid lookup context must be rejected before any provider call")
		return nil, nil
	})
	for _, context := range []string{
		`{"query":{"kind":"web","terms":"untrusted","place":"","today":false}}`,
		`{"query":{"kind":"hotels","terms":"","place":"","today":false},"tool":"send_email"}`,
		`{"query":{"kind":"hotels","terms":"","place":"","today":false},"latitude":1}`,
	} {
		body := strings.TrimSuffix(fixtureCommand, "}") + `,"lookup_context":` + context + `}`
		w := requestAPI(handler, "/api/commands", body)
		if w.Code != 400 {
			t.Fatalf("invalid lookup context accepted: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestLookupCommandMissingTavilyDoesNotDisableWeatherOrReminders(t *testing.T) {
	t.Setenv("TAVILY_API_KEY", "")
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Host {
		case "api.groq.com":
			var body struct {
				Messages []struct {
					Content string `json:"content"`
				} `json:"messages"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Messages) != 2 {
				t.Fatal("missing transcript")
			}
			if strings.Contains(body.Messages[1].Content, "weather") {
				return lookupIntentResponse(modelInterpretation{Actions: []action{}, Lookup: &lookupQuery{Kind: "weather", Place: "Pune"}}), nil
			}
			if strings.Contains(body.Messages[1].Content, "stable Go") {
				return lookupIntentResponse(modelInterpretation{Actions: []action{}, Lookup: &lookupQuery{Kind: "web", Terms: "latest stable Go release"}}), nil
			}
			return providerResponse(200, fixture(t, "groq-reminder.json")), nil
		case "geocoding-api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
		case "api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		default:
			t.Fatalf("unexpected provider: %s", r.URL)
			return nil, nil
		}
	})
	var request commandRequest
	_ = json.Unmarshal([]byte(fixtureCommand), &request)
	request.Transcript = "What's the latest stable Go release?"
	status, body := requestCommand(t, handler, request)
	if status != 503 || !strings.Contains(body, "search_not_configured") || !strings.Contains(body, request.CommandID) {
		t.Fatalf("search error was not retained: %d %s", status, body)
	}
	request.Transcript = "What's the weather in Pune?"
	status, body = requestCommand(t, handler, request)
	if status != 200 || !strings.Contains(body, `"kind":"weather"`) {
		t.Fatalf("search failure disabled weather: %d %s", status, body)
	}
	status, body = requestCommand(t, handler, mustLookupRequest(t))
	if status != 200 || !strings.Contains(body, "create_reminder") {
		t.Fatalf("search failure disabled reminders: %d %s", status, body)
	}
}

func mustLookupRequest(t *testing.T) commandRequest {
	t.Helper()
	var request commandRequest
	if err := json.Unmarshal([]byte(fixtureCommand), &request); err != nil {
		t.Fatal(err)
	}
	return request
}
