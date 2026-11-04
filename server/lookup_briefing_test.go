package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLookupBriefingWithExplicitPlace(t *testing.T) {
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Host {
		case "geocoding-api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
		case "api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		default:
			t.Fatalf("unexpected provider: %s", r.URL)
			return nil, nil
		}
	})
	s.tavilyKey = ""

	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "Pune", Today: true}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil || outcome.Pending != nil {
		t.Fatalf("briefing lookup failed: %+v %v", outcome, err)
	}
	r := outcome.Result
	if r.Kind != "briefing" || r.Status != "answered" {
		t.Fatalf("unexpected result: %+v", r)
	}
	for _, text := range []string{"Good morning!", "Tuesday, 3 November 2026", "Pune, Maharashtra, India", "partly cloudy", "24.5 °C", "8:45 AM", "Headlines are unavailable right now."} {
		if !strings.Contains(r.Answer, text) {
			t.Fatalf("missing %q in answer: %s", text, r.Answer)
		}
	}
	if !strings.Contains(r.Speech, "Good morning!") || !strings.Contains(r.Speech, "Headlines are unavailable right now.") || utf8.RuneCountInString(r.Speech) > maxSpeechChars {
		t.Fatalf("speech invalid: %s", r.Speech)
	}
	if r.Timezone != "Asia/Kolkata" || r.DataTime != "2026-11-03T08:45:00+05:30" || r.LookedUpAt != "2026-11-03T03:30:00Z" || r.DataTime == s.clock().Format("2006-01-02T15:04:05Z07:00") {
		t.Fatalf("briefing replaced the observation time with the lookup clock: %+v", r)
	}
	if len(r.Sources) != 1 || r.Sources[0].Publisher != "Open-Meteo" {
		t.Fatalf("missing weather attribution or invented news sources: %+v", r.Sources)
	}
}

func TestLookupBriefingRequiresCityWithoutInferringFromTimezone(t *testing.T) {
	for _, timezone := range []string{"Asia/Kolkata", "America/New_York"} {
		for _, place := range []string{"", "near me", "here"} {
			t.Run(timezone+"/"+place, func(t *testing.T) {
				s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
					t.Fatalf("a missing city must not call any provider: %s", r.URL)
					return nil, nil
				})
				outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: place, Today: true}, "guest", timezone)
				if err != nil || outcome.Result != nil || outcome.Question != "Which city?" || outcome.Pending == nil {
					t.Fatalf("briefing guessed a city from the browser timezone: %+v %v", outcome, err)
				}
				if outcome.Pending.Query.Kind != "briefing" || !outcome.Pending.Query.Today || outcome.Pending.Query.Place != place {
					t.Fatalf("lost the pending briefing: %+v", outcome.Pending)
				}
			})
		}
	}
}

func TestLookupBriefingHindi(t *testing.T) {
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Host {
		case "geocoding-api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
		case "api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		default:
			t.Fatalf("unexpected provider: %s", r.URL)
			return nil, nil
		}
	})
	s.tavilyKey = ""

	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "Pune", Today: true, ReplyLanguage: "hi"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil || outcome.Result.Status != "answered" || outcome.Result.Kind != "briefing" {
		t.Fatalf("Hindi briefing lookup failed: %+v %v", outcome, err)
	}
	r := outcome.Result
	for _, text := range []string{"शुभ प्रभात!", "03-11-2026", "हल्के बादल", "24.5 °C", "अभी समाचार उपलब्ध नहीं हैं।"} {
		if !strings.Contains(r.Answer, text) {
			t.Fatalf("missing %q in Hindi answer: %s", text, r.Answer)
		}
	}
	if !strings.Contains(r.Speech, "शुभ प्रभात!") || !strings.Contains(r.Speech, "अभी समाचार उपलब्ध नहीं हैं।") || strings.Contains(r.Speech, "Headlines") || utf8.RuneCountInString(r.Speech) > maxSpeechChars {
		t.Fatalf("invalid Hindi speech: %s", r.Speech)
	}
	if r.DataTime != "2026-11-03T08:45:00+05:30" || len(r.Sources) != 1 || r.Sources[0].Publisher != "Open-Meteo" {
		t.Fatalf("Hindi briefing lost weather provenance: %+v", r)
	}
}

func TestLookupBriefingAmbiguousPlaceAsksBeforeWeatherOrNews(t *testing.T) {
	calls := 0
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		calls++
		switch r.URL.Host {
		case "geocoding-api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-ambiguous.json")), nil
		case "api.groq.com":
			return lookupPlaceResponse(`{"candidate_index":null}`), nil
		default:
			t.Fatalf("ambiguous briefing fetched weather or news before clarification: %s", r.URL)
			return nil, nil
		}
	})
	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "Springfield", Today: true}, "guest", "Asia/Kolkata")
	if err != nil || calls != 2 || outcome.Result != nil || outcome.Pending == nil || !strings.HasPrefix(outcome.Question, "Which place:") {
		t.Fatalf("ambiguous briefing did not ask: %+v %v", outcome, err)
	}
	for _, label := range []string{"Springfield, Illinois, United States", "Springfield, Massachusetts, United States"} {
		if !strings.Contains(outcome.Question, label) {
			t.Fatalf("clarification omitted a provider candidate: %s", outcome.Question)
		}
	}
	continued, err := withLookupPlace(*outcome.Pending, "Massachusetts, United States")
	if err != nil || continued.Kind != "briefing" || !continued.Today || continued.Place != "Springfield, Massachusetts, United States" {
		t.Fatalf("region continuation lost the original briefing: %+v %v", continued, err)
	}
}

func TestLookupBriefingUnresolvableOrCountryRequiresCity(t *testing.T) {
	for _, tc := range []struct{ name, place, body, question string }{
		{"unresolvable", "Unknown city", `{"results":[]}`, "I couldn't resolve that place. Which city and country?"},
		{"single-zone country", "India", `{"results":[{"name":"India","country":"India","country_code":"IN","timezone":"Asia/Kolkata","feature_code":"PCLI","latitude":20,"longitude":77}]}`, "Which city?"},
		{"multi-zone country", "United States", `{"results":[{"name":"United States","country":"United States","country_code":"US","timezone":"America/New_York","feature_code":"PCLI","latitude":38,"longitude":-97}]}`, "Which city?"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Host != "geocoding-api.open-meteo.com" {
					t.Fatalf("a briefing without a resolved city fetched weather or news: %s", r.URL)
				}
				return lookupJSONResponse(200, tc.body), nil
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: tc.place, Today: true}, "guest", "Asia/Kolkata")
			if err != nil || calls != 1 || outcome.Result != nil || outcome.Question != tc.question || outcome.Pending == nil || outcome.Pending.Query.Kind != "briefing" || !outcome.Pending.Query.Today {
				t.Fatalf("briefing answered without a city: %+v %v", outcome, err)
			}
		})
	}
}

func TestLookupBriefingUsesSelectedProviderRecordAndQualifiedCityForNews(t *testing.T) {
	places := placeChoiceCandidates()
	geocoding, _ := json.Marshal(map[string]any{"results": places})
	chosen := places[1]
	const qualifiedPlace = "New Delhi, Illinois, United States"
	news := strings.NewReplacer(
		"India launches a technology research centre", "New Delhi opens a research centre",
		"2026-11-02T10:00:00Z", "2026-11-02T05:59:59Z",
	).Replace(fixture(t, "tavily-news.json"))
	choiceCalls, weatherCalls, newsCalls, evidenceCalls := 0, 0, 0, 0
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Host {
		case "geocoding-api.open-meteo.com":
			if r.URL.Query().Get("name") != "New Delhi" {
				t.Fatal("geocoding lost the original city query")
			}
			return lookupJSONResponse(200, string(geocoding)), nil
		case "api.open-meteo.com":
			weatherCalls++
			args := r.URL.Query()
			if choiceCalls != 1 || args.Get("latitude") != fmt.Sprint(chosen["latitude"]) || args.Get("longitude") != fmt.Sprint(chosen["longitude"]) || args.Get("timezone") != chosen["timezone"] || args.Get("timeformat") != "unixtime" || args.Get("temperature_unit") != "celsius" {
				t.Fatal("briefing weather did not use the selected original provider record")
			}
			var weather map[string]any
			_ = json.Unmarshal([]byte(fixture(t, "open-meteo-current.json")), &weather)
			weather["timezone"] = chosen["timezone"]
			body, _ := json.Marshal(weather)
			return lookupJSONResponse(200, string(body)), nil
		case "mcp.tavily.com":
			if weatherCalls != 1 {
				t.Fatal("briefing searched news before resolving and validating weather")
			}
			return fixtureMCP(t, r, news, func(args map[string]any) {
				newsCalls++
				if args["query"] != "news "+qualifiedPlace || args["topic"] != "news" || args["time_range"] != "d" {
					t.Fatalf("news did not use the resolved qualified city: %v", args)
				}
			}), nil
		case "api.groq.com":
			var payload struct {
				Messages       []struct{ Content string }
				ResponseFormat struct {
					JSONSchema struct{ Name string } `json:"json_schema"`
				} `json:"response_format"`
			}
			if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload.Messages) != 2 {
				t.Fatal("invalid place-choice or evidence request")
			}
			switch payload.ResponseFormat.JSONSchema.Name {
			case "morning_lookup_place_choice":
				choiceCalls++
				return lookupPlaceResponse(`{"candidate_index":1}`), nil
			case "morning_lookup_evidence":
				evidenceCalls++
				var data struct {
					Query   lookupQuery
					Sources []lookupSource
				}
				if json.Unmarshal([]byte(payload.Messages[1].Content), &data) != nil || data.Query.Kind != "news" || data.Query.Place != qualifiedPlace || !data.Query.Today || len(data.Sources) != 1 || data.Sources[0].PublishedAt != "2026-11-03T02:00:00Z" {
					t.Fatalf("news evidence lost the selected city or included old/undated stories: %+v", data)
				}
				return evidenceResponse("", evidenceItem(0, "Research centre", "New Delhi opens a research centre.")), nil
			default:
				t.Fatalf("unexpected Groq schema: %s", payload.ResponseFormat.JSONSchema.Name)
				return nil, nil
			}
		default:
			t.Fatalf("unexpected briefing provider: %s", r.URL)
			return nil, nil
		}
	})
	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "New Delhi", Today: true}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil || outcome.Pending != nil || choiceCalls != 1 || weatherCalls != 1 || newsCalls != 1 || evidenceCalls != 1 {
		t.Fatalf("selected briefing failed: %+v %v", outcome, err)
	}
	r := outcome.Result
	if outcome.ResolvedPlace != qualifiedPlace || r.Kind != "briefing" || r.Status != "answered" || r.Timezone != "America/Chicago" || r.DataTime != "2026-11-02T21:15:00-06:00" || r.WindowStart != "2026-11-02T06:00:00Z" || r.WindowEnd != "2026-11-03T03:30:00Z" {
		t.Fatalf("briefing used the browser timezone or unselected place: %+v", outcome)
	}
	for _, text := range []string{qualifiedPlace, "Monday, 2 November 2026", "24.5 °C", "New Delhi opens a research centre"} {
		if !strings.Contains(r.Answer, text) {
			t.Fatalf("missing selected-place fact %q: %s", text, r.Answer)
		}
	}
	if len(r.Sources) != 2 || r.Sources[0].Publisher != "Open-Meteo" || r.Sources[1].PublishedAt != "2026-11-03T02:00:00Z" || !strings.Contains(r.Speech, "Headlines are included below.") {
		t.Fatalf("missing weather/news provenance: %+v", r)
	}
	encoded, _ := json.Marshal(outcome)
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(encoded, &fields)
	if len(fields) != 1 || fields["lookup"] == nil {
		t.Fatalf("internal resolved place leaked into the response: %s", encoded)
	}
}

func TestLookupBriefingCapsHeadlinesAtTwoAlongsideWeather(t *testing.T) {
	items := []tavilyItem{
		{Title: "Pune opens a library", URL: "https://news.example/library", Content: "Pune opens a library.", PublishedDate: "2026-11-03T03:00:00Z"},
		{Title: "Pune adds a bus route", URL: "https://news.example/bus", Content: "Pune adds a bus route.", PublishedDate: "2026-11-03T02:00:00Z"},
		{Title: "Pune hosts a science fair", URL: "https://news.example/fair", Content: "Pune hosts a science fair.", PublishedDate: "2026-11-03T01:00:00Z"},
	}
	news, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 2, "result": map[string]any{"structuredContent": map[string]any{"results": items}}})
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Host {
		case "geocoding-api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
		case "api.open-meteo.com":
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		case "mcp.tavily.com":
			return fixtureMCP(t, r, string(news), nil), nil
		case "api.groq.com":
			return evidenceResponse("",
				evidenceItem(0, items[0].Title, items[0].Content),
				evidenceItem(1, items[1].Title, items[1].Content),
				evidenceItem(2, items[2].Title, items[2].Content)), nil
		default:
			t.Fatalf("unexpected briefing provider: %s", r.URL)
			return nil, nil
		}
	})
	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "Pune", Today: true}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil || outcome.Result.Status != "answered" {
		t.Fatalf("briefing with headlines failed: %+v %v", outcome, err)
	}
	r := outcome.Result
	if len(r.Sources) != 3 || r.Sources[0].Publisher != "Open-Meteo" || r.Sources[1].URL != items[0].URL || r.Sources[2].URL != items[1].URL || r.Sources[1].PublishedAt != items[0].PublishedDate || r.Sources[2].PublishedAt != items[1].PublishedDate {
		t.Fatalf("briefing must retain weather plus at most two dated headlines: %+v", r.Sources)
	}
	if r.WindowStart != "2026-11-02T18:30:00Z" || r.WindowEnd != "2026-11-03T03:30:00Z" || !strings.Contains(r.Answer, items[0].Title) || strings.Contains(r.Answer, items[2].Title) {
		t.Fatalf("wrong headline window or answer: %+v", r)
	}
}

func TestLookupBriefingNewsFailuresKeepWeatherAndStateUnavailable(t *testing.T) {
	for _, language := range []string{"en", "hi"} {
		for _, tc := range []struct {
			name, stage string
			status      int
			network     error
		}{
			{name: "missing key"},
			{name: "search outage", stage: "search", status: 503},
			{name: "search timeout", stage: "search", network: context.DeadlineExceeded},
			{name: "search quota", stage: "search", status: 429},
			{name: "search credits", stage: "search", status: 432},
			{name: "malformed search response", stage: "search", status: 200},
			{name: "evidence outage", stage: "evidence", status: 503},
			{name: "evidence timeout", stage: "evidence", network: context.DeadlineExceeded},
			{name: "evidence quota", stage: "evidence", status: 429},
		} {
			t.Run(language+"/"+tc.name, func(t *testing.T) {
				failedCalls := 0
				s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
					switch r.URL.Host {
					case "geocoding-api.open-meteo.com":
						return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
					case "api.open-meteo.com":
						return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
					case "mcp.tavily.com", "api.groq.com":
						if tc.name == "missing key" {
							t.Fatalf("missing news key must not call news providers: %s", r.URL)
						}
						if r.URL.Host == "mcp.tavily.com" && tc.stage == "evidence" {
							return fixtureMCP(t, r, fixture(t, "tavily-news.json"), nil), nil
						}
						if tc.stage == "search" && r.URL.Host != "mcp.tavily.com" {
							t.Fatal("failed news search must not reach evidence selection")
						}
						failedCalls++
						if tc.network != nil {
							return nil, tc.network
						}
						return lookupJSONResponse(tc.status, `{"message":"fixture-tavily-secret private transcript"}`), nil
					default:
						t.Fatalf("unexpected briefing provider: %s", r.URL)
						return nil, nil
					}
				})
				if tc.name == "missing key" {
					s.tavilyKey = ""
				}
				outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "Pune", Today: true, ReplyLanguage: language}, "guest", "Asia/Kolkata")
				if err != nil || outcome.Result == nil || outcome.Result.Kind != "briefing" || outcome.Result.Status != "answered" || outcome.Pending != nil {
					t.Fatalf("optional news failure discarded valid weather: %+v %v", outcome, err)
				}
				wantFailedCalls := 1
				if tc.name == "missing key" {
					wantFailedCalls = 0
				}
				r := outcome.Result
				unavailable := "Headlines are unavailable right now."
				if language == "hi" {
					unavailable = "अभी समाचार उपलब्ध नहीं हैं।"
				}
				if failedCalls != wantFailedCalls || !strings.Contains(r.Answer, "24.5 °C") || !strings.Contains(r.Answer, unavailable) || !strings.Contains(r.Speech, unavailable) || utf8.RuneCountInString(r.Speech) > maxSpeechChars {
					t.Fatalf("news failure was hidden or weather was lost: %+v", r)
				}
				if len(r.Sources) != 1 || r.Sources[0].Publisher != "Open-Meteo" || r.DataTime != "2026-11-03T08:45:00+05:30" || r.WindowStart != "" || r.WindowEnd != "" {
					t.Fatalf("failed news invented provenance or replaced observation time: %+v", r)
				}
				encoded, _ := json.Marshal(outcome)
				if strings.Contains(string(encoded), "fixture-tavily-secret") || strings.Contains(string(encoded), "private transcript") || strings.Contains(r.Speech, "Headlines are included") || strings.Contains(r.Speech, "समाचार नीचे") {
					t.Fatalf("provider failure leaked data or claimed headlines: %s", encoded)
				}
			})
		}
	}
}

func TestLookupBriefingUnconfirmedNewsDoesNotInventHeadlines(t *testing.T) {
	for _, language := range []string{"en", "hi"} {
		for _, tc := range []struct{ name, date string }{
			{"malformed publication time", "not-a-date"},
			{"old publication time", "2026-11-02T10:00:00Z"},
			{"undated", ""},
			{"future publication time", "2026-11-03T04:00:00Z"},
		} {
			t.Run(language+"/"+tc.name, func(t *testing.T) {
				news := strings.ReplaceAll(fixture(t, "tavily-news.json"), "Tue, 03 Nov 2026 02:00:00 GMT", tc.date)
				s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
					switch r.URL.Host {
					case "geocoding-api.open-meteo.com":
						return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
					case "api.open-meteo.com":
						return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
					case "mcp.tavily.com":
						return fixtureMCP(t, r, news, nil), nil
					default:
						t.Fatalf("unconfirmed or out-of-window news must not reach synthesis: %s", r.URL)
						return nil, nil
					}
				})
				outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "Pune", Today: true, ReplyLanguage: language}, "guest", "Asia/Kolkata")
				if err != nil || outcome.Result == nil || outcome.Result.Status != "answered" || outcome.Result.Kind != "briefing" {
					t.Fatalf("unconfirmed news discarded valid weather: %+v %v", outcome, err)
				}
				r := outcome.Result
				answer := "I found no relevant stories with a confirmed publication time in the requested window."
				speech := "No confirmed headlines were found for today."
				if language == "hi" {
					answer = "इस समय अवधि में प्रकाशन समय वाली कोई संबंधित खबर नहीं मिली।"
					speech = "आज की पुष्टि वाली कोई खबर नहीं मिली।"
				}
				if !strings.Contains(r.Answer, answer) || !strings.Contains(r.Speech, speech) || !strings.Contains(r.Answer, "24.5 °C") || utf8.RuneCountInString(r.Speech) > maxSpeechChars {
					t.Fatalf("briefing did not honestly distinguish no confirmed news from an outage: %+v", r)
				}
				if len(r.Sources) != 1 || r.Sources[0].Publisher != "Open-Meteo" || r.DataTime != "2026-11-03T08:45:00+05:30" || r.WindowStart != "2026-11-02T18:30:00Z" || r.WindowEnd != "2026-11-03T03:30:00Z" || strings.Contains(r.Answer, "India launches") {
					t.Fatalf("unconfirmed headlines escaped into the briefing: %+v", r)
				}
			})
		}
	}
}

func TestLookupBriefingWeatherFailuresPropagateRetryableErrors(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		status     int
		network    error
	}{
		{"outage", "lookup_unavailable", 503, nil},
		{"timeout", "lookup_timeout", 0, context.DeadlineExceeded},
		{"quota", "lookup_quota_limited", 429, nil},
		{"malformed response", "lookup_invalid_response", 200, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				calls++
				switch r.URL.Host {
				case "geocoding-api.open-meteo.com":
					return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
				case "api.open-meteo.com":
					if tc.network != nil {
						return nil, tc.network
					}
					response := lookupJSONResponse(tc.status, `{"message":"private weather provider failure"}`)
					response.Header.Set("Retry-After", "37")
					return response, nil
				default:
					t.Fatalf("failed weather must not fetch news or synthesize success: %s", r.URL)
					return nil, nil
				}
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "Pune", Today: true}, "guest", "Asia/Kolkata")
			var failure *lookupError
			if !errors.As(err, &failure) || failure.Code != tc.code || !failure.Retryable || outcome.Result != nil || outcome.Pending != nil || calls != 2 {
				t.Fatalf("weather failure was hidden by a successful briefing: %+v %v", outcome, err)
			}
			if tc.status == 429 && failure.RetryAfter != 37 || strings.Contains(failure.Message, "private weather") {
				t.Fatalf("weather retry metadata or error redaction lost: %+v", failure)
			}
		})
	}
}

func TestLookupBriefingPendingContinuationKeepsToday(t *testing.T) {
	for _, language := range []string{"en", "hi"} {
		t.Run(language, func(t *testing.T) {
			extractionCalls, weatherCalls := 0, 0
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				switch r.URL.Host {
				case "api.groq.com":
					extractionCalls++
					return lookupPlaceResponse(`{"place":"Pune, Maharashtra, India"}`), nil
				case "geocoding-api.open-meteo.com":
					if r.URL.Query().Get("name") != "Pune, Maharashtra, India" {
						t.Fatal("continuation dropped the spoken city qualifiers")
					}
					return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
				case "api.open-meteo.com":
					weatherCalls++
					return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
				default:
					t.Fatalf("unexpected continuation provider: %s", r.URL)
					return nil, nil
				}
			})
			s.tavilyKey = ""
			pending, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Today: true, ReplyLanguage: language}, "guest", "Asia/Kolkata")
			if err != nil || pending.Pending == nil || pending.Result != nil || extractionCalls != 0 || weatherCalls != 0 {
				t.Fatalf("missing-city briefing did not stay pending: %+v %v", pending, err)
			}
			continued, err := s.spokenLookupPlace(context.Background(), *pending.Pending, "Pune, Maharashtra, India", "guest")
			if err != nil || continued.Kind != "briefing" || !continued.Today || continued.Terms != "" || continued.Place != "Pune, Maharashtra, India" || continued.ReplyLanguage != language {
				t.Fatalf("spoken continuation changed the pending briefing: %+v %v", continued, err)
			}
			outcome, err := s.lookup(context.Background(), continued, "guest", "Asia/Kolkata")
			if err != nil || outcome.Result == nil || outcome.Result.Kind != "briefing" || outcome.Result.Status != "answered" || outcome.Pending != nil || extractionCalls != 1 || weatherCalls != 1 {
				t.Fatalf("city reply failed to complete today's briefing: %+v %v", outcome, err)
			}
		})
	}
}
