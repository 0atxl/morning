package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Synthetic provider records. The model chooses an index; all coordinates,
// timezones and weather facts still come from the intercepted provider calls.
func placeChoiceCandidates() []map[string]any {
	return []map[string]any{
		{"name": "New Delhi", "admin1": "National Capital Territory of Delhi", "country": "India", "country_code": "IN", "timezone": "Asia/Kolkata", "feature_code": "PPLC", "population": 3000000, "latitude": 28.61, "longitude": 77.21},
		{"name": "New Delhi", "admin1": "Illinois", "country": "United States", "country_code": "US", "timezone": "America/Chicago", "feature_code": "PPL", "latitude": 39.8, "longitude": -89.6},
	}
}

func TestLookupPlaceChoiceFetchesFactsForOnlyTheSelectedProviderRecord(t *testing.T) {
	for _, selected := range []int{0, 1} {
		t.Run(fmt.Sprint(selected), func(t *testing.T) {
			places := placeChoiceCandidates()
			geocoding, _ := json.Marshal(map[string]any{"results": places})
			chosen := places[selected]
			calls := 0
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				calls++
				switch r.URL.Host {
				case "geocoding-api.open-meteo.com":
					return lookupJSONResponse(200, string(geocoding)), nil
				case "api.groq.com":
					var payload struct {
						Messages       []struct{ Content string }
						ResponseFormat struct {
							JSONSchema struct {
								Name   string
								Strict bool
								Schema struct{ Properties map[string]json.RawMessage }
							} `json:"json_schema"`
						} `json:"response_format"`
					}
					if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload.Messages) != 2 || payload.ResponseFormat.JSONSchema.Name != "morning_lookup_place_choice" || !payload.ResponseFormat.JSONSchema.Strict || len(payload.ResponseFormat.JSONSchema.Schema.Properties) != 1 {
						t.Fatal("selection must use only the candidate-index schema")
					}
					var data struct {
						Query      string
						Candidates []map[string]any
					}
					if json.Unmarshal([]byte(payload.Messages[1].Content), &data) != nil || data.Query != "New Delhi" || len(data.Candidates) != 2 {
						t.Fatal("missing query or provider candidates")
					}
					for _, candidate := range data.Candidates {
						for _, key := range []string{"latitude", "longitude", "timezone", "transcript", "contacts", "actions"} {
							if _, ok := candidate[key]; ok {
								t.Fatalf("selection received unnecessary field %s", key)
							}
						}
					}
					if _, ok := data.Candidates[1]["population"]; ok {
						t.Fatal("missing population was represented as a known zero")
					}
					if deadline, ok := r.Context().Deadline(); !ok || time.Until(deadline) > 8*time.Second {
						t.Fatal("selection needs an eight-second deadline within the lookup budget")
					}
					return lookupPlaceResponse(fmt.Sprintf(`{"candidate_index":%d}`, selected)), nil
				case "api.open-meteo.com":
					query := r.URL.Query()
					if query.Get("latitude") != fmt.Sprint(chosen["latitude"]) || query.Get("longitude") != fmt.Sprint(chosen["longitude"]) || query.Get("timezone") != chosen["timezone"] {
						t.Fatal("weather used model-authored or unselected coordinates")
					}
					var weather map[string]any
					_ = json.Unmarshal([]byte(fixture(t, "open-meteo-current.json")), &weather)
					weather["timezone"] = chosen["timezone"]
					body, _ := json.Marshal(weather)
					return lookupJSONResponse(200, string(body)), nil
				default:
					t.Fatal("candidate choice cannot invoke other tools/providers")
					return nil, nil
				}
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "weather", Place: "New Delhi"}, "guest", "Asia/Kolkata")
			if err != nil || outcome.Result == nil || outcome.Pending != nil || calls != 3 {
				t.Fatalf("selected place did not retrieve weather: %+v %v", outcome, err)
			}
			if outcome.Result.Timezone != chosen["timezone"] || !strings.Contains(outcome.Result.Answer, fmt.Sprint(chosen["country"])) || !strings.Contains(outcome.Result.Answer, "24.5 °C") || len(outcome.Result.Sources) != 2 {
				t.Fatalf("answer did not retain provider facts: %+v", outcome.Result)
			}
		})
	}
}

func TestLookupPlaceChoiceNullAsksWithoutFetchingWeather(t *testing.T) {
	geocoding, _ := json.Marshal(map[string]any{"results": placeChoiceCandidates()})
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Host {
		case "geocoding-api.open-meteo.com":
			return lookupJSONResponse(200, string(geocoding)), nil
		case "api.groq.com":
			return lookupPlaceResponse(`{"candidate_index":null}`), nil
		default:
			t.Fatal("an unresolved model choice must not retrieve weather")
			return nil, nil
		}
	})
	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "weather", Place: "New Delhi"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result != nil || outcome.Pending == nil || !strings.HasPrefix(outcome.Question, "Which place:") {
		t.Fatalf("uncertain choice must ask: %+v %v", outcome, err)
	}
}

func TestLookupPlaceChoiceRejectsInventedIndicesAndActionOutput(t *testing.T) {
	for _, content := range []string{`{}`, `{"candidate_index":-1}`, `{"candidate_index":2}`, `{"candidate_index":0.5}`, `{"candidate_index":"0"}`, `{"candidate_index":0,"latitude":1}`, `{"candidate_index":0,"actions":[{"type":"draft_email"}]}`} {
		s := lookupFixtureService(t, func(*http.Request) (*http.Response, error) { return lookupPlaceResponse(content), nil })
		_, err := s.selectLookupPlace(context.Background(), "Some city", []lookupPlace{{Name: "A"}, {Name: "B"}})
		if !errors.Is(err, errInvalidProviderOutput) {
			t.Fatalf("invalid selection accepted: %s %v", content, err)
		}
	}
	s := lookupFixtureService(t, func(*http.Request) (*http.Response, error) {
		return providerResponse(200, `{"choices":[{"finish_reason":"stop","message":{"content":"{\"candidate_index\":0}","tool_calls":[{"type":"function","function":{"name":"send_email"}}]}}]}`), nil
	})
	if _, err := s.selectLookupPlace(context.Background(), "Some city", []lookupPlace{{Name: "A"}, {Name: "B"}}); !errors.Is(err, errInvalidProviderOutput) {
		t.Fatal("provider tool output was accepted")
	}
}

func TestLookupPlaceChoiceProviderFailureDoesNotGuessTheFirstResult(t *testing.T) {
	for _, issue := range []string{"timeout", "quota"} {
		t.Run(issue, func(t *testing.T) {
			geocoding, _ := json.Marshal(map[string]any{"results": placeChoiceCandidates()})
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "geocoding-api.open-meteo.com" {
					return lookupJSONResponse(200, string(geocoding)), nil
				}
				if r.URL.String() != groqCommandURL {
					t.Fatal("failed selection must not fetch weather")
				}
				if issue == "timeout" {
					return nil, context.DeadlineExceeded
				}
				return providerResponse(429, "fixture quota"), nil
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "weather", Place: "New Delhi"}, "guest", "Asia/Kolkata")
			var failure *lookupError
			if !errors.As(err, &failure) || outcome.Result != nil || (issue == "timeout" && failure.Code != "lookup_timeout") || (issue == "quota" && failure.Code != "lookup_quota_limited") {
				t.Fatalf("selection failure was hidden: %+v %v", outcome, err)
			}
		})
	}
}
