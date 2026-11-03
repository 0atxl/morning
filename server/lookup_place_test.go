package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func lookupPlaceResponse(content string) *http.Response {
	body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": content}}}})
	return providerResponse(200, string(body))
}

func TestLookupPlaceFullHindiWeatherQuestionResumesOriginalLookup(t *testing.T) {
	t.Setenv("TAVILY_API_KEY", "")
	const spoken = "वडोदरा गुजरात भारत में क्या मौसम हो रहा है?"
	calls := 0
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		calls++
		switch r.URL.Host {
		case "api.groq.com":
			var payload struct {
				Messages       []struct{ Role, Content string }
				ResponseFormat struct {
					JSONSchema struct {
						Name   string
						Strict bool
						Schema struct{ Properties map[string]json.RawMessage }
					} `json:"json_schema"`
				} `json:"response_format"`
			}
			if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload.Messages) != 2 || payload.ResponseFormat.JSONSchema.Name != "morning_lookup_place" || !payload.ResponseFormat.JSONSchema.Strict || len(payload.ResponseFormat.JSONSchema.Schema.Properties) != 1 {
				t.Fatal("a follow-up must use only the place-extraction schema")
			}
			var data map[string]string
			if json.Unmarshal([]byte(payload.Messages[1].Content), &data) != nil || len(data) != 2 || data["reply"] != spoken || data["known_city"] != "" {
				t.Fatal("place extraction received unrelated or incomplete context")
			}
			return lookupPlaceResponse(`{"place":"Vadodara, Gujarat, India"}`), nil
		case "geocoding-api.open-meteo.com":
			if r.URL.Query().Get("name") != "Vadodara, Gujarat, India" || r.URL.Query().Get("language") != "en" {
				t.Fatal("the whole question or unnormalized script reached geocoding")
			}
			return lookupJSONResponse(200, fixture(t, "open-meteo-vadodara.json")), nil
		case "api.open-meteo.com":
			if r.URL.Query().Get("latitude") != "22.3" || r.URL.Query().Get("longitude") != "73.18" {
				t.Fatal("weather did not use the resolved place")
			}
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		default:
			t.Fatal("place replies cannot invoke another provider or action")
			return nil, nil
		}
	})
	request := mustLookupRequest(t)
	request.Transcript = spoken
	// Matches the failed context supplied from the production response. The
	// previous bad place must be replaced, not reused or parsed as a command.
	request.LookupContext = &lookupContext{Query: lookupQuery{Kind: "weather", Place: spoken}, ReplyLanguage: "hi"}
	status, body := requestCommand(t, handler, request)
	var result commandResponse
	if json.Unmarshal([]byte(body), &result) != nil || status != 200 || calls != 3 || result.Lookup == nil || result.LookupContext != nil || result.Clarification != nil || len(result.Actions) != 0 || result.ReplyLanguage != "hi" {
		t.Fatalf("full-question follow-up did not produce a read-only answer: %d %s", status, body)
	}
	if result.Lookup.Query != "Vadodara, Gujarat, India" || !strings.Contains(result.Lookup.Answer, "Vadodara, Gujarat, India") || !strings.Contains(result.Lookup.Speech, "Open-Meteo") {
		t.Fatalf("missing resolved place or weather credit: %+v", result.Lookup)
	}
}

func TestLookupPlaceExtractionPreservesLookupAndAllowsCityCorrection(t *testing.T) {
	for _, tc := range []struct{ reply, city, extracted string }{
		{"Illinois", "Springfield", "Springfield, Illinois"},
		{"Gujarat, India", "Vadodara", "Vadodara, Gujarat, India"},
		{"Actually Vadodara, Gujarat, India", "Pune", "Vadodara, Gujarat, India"},
		{"जयपुर रेलवे स्टेशन के पास होटल ढूँढो", "", "Jaipur railway station"},
	} {
		t.Run(tc.reply, func(t *testing.T) {
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.String() != groqCommandURL {
					t.Fatal("extraction must not retrieve facts")
				}
				content, _ := json.Marshal(map[string]string{"place": tc.extracted})
				return lookupPlaceResponse(string(content)), nil
			})
			query, err := s.spokenLookupPlace(context.Background(), lookupContext{Query: lookupQuery{Kind: "hotels"}, City: tc.city, ReplyLanguage: "hi"}, tc.reply, "guest")
			if err != nil || query.Place != tc.extracted || query.Kind != "hotels" || query.ReplyLanguage != "hi" {
				t.Fatalf("lost the original lookup or incorrectly prepended an old city: %+v %v", query, err)
			}
		})
	}
}

func TestLookupPlaceExtractionRejectsActionsAndInvalidOutput(t *testing.T) {
	for _, content := range []string{`{"actions":[{"type":"draft_email"}]}`, `{}`, `{"place":"Vadodara","actions":[]}`, `{"place":123}`, `{"place":""}`} {
		s := lookupFixtureService(t, func(*http.Request) (*http.Response, error) { return lookupPlaceResponse(content), nil })
		_, err := s.spokenLookupPlace(context.Background(), lookupContext{Query: lookupQuery{Kind: "weather"}}, "Send Priya an email", "guest")
		if err == nil {
			t.Fatalf("invalid place output accepted: %s", content)
		}
	}
}

func TestLookupPlaceEmptyRepliesAreRateLimitedWithoutRetrieval(t *testing.T) {
	calls := 0
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != groqCommandURL {
			t.Fatal("no location must not call weather or search")
		}
		return lookupPlaceResponse(`{"place":null}`), nil
	})
	request := mustLookupRequest(t)
	request.Transcript = "Send Priya an email"
	request.LookupContext = &lookupContext{Query: lookupQuery{Kind: "weather"}, ReplyLanguage: "hi"}
	for i := 0; i < 5; i++ {
		status, body := requestCommand(t, handler, request)
		if i < 4 {
			var result commandResponse
			if json.Unmarshal([]byte(body), &result) != nil || status != 200 || result.LookupContext == nil || result.LookupContext.Query.Kind != "weather" || result.LookupContext.Query.Place != "" || result.Lookup != nil || len(result.Actions) != 0 {
				t.Fatalf("unrelated reply changed the original lookup: %d %s", status, body)
			}
		} else if status != 429 || !strings.Contains(body, "lookup_rate_limited") || calls != 4 {
			t.Fatalf("place extraction is not rate limited: %d %s", status, body)
		}
	}
}
