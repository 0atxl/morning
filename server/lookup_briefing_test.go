package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestLookupBriefingWithExplicitPlace(t *testing.T) {
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Host, "geocoding-api.open-meteo.com") {
			return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
		}
		if strings.Contains(r.URL.Host, "api.open-meteo.com") {
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		}
		t.Fatalf("unexpected host: %s", r.URL)
		return nil, nil
	})

	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "Pune", Today: true}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil {
		t.Fatalf("briefing lookup failed: %v", err)
	}
	r := outcome.Result
	if r.Kind != "briefing" || r.Status != "answered" {
		t.Fatalf("unexpected result: %+v", r)
	}
	if !strings.Contains(r.Answer, "Good morning!") || !strings.Contains(r.Answer, "Pune") {
		t.Fatalf("missing morning greeting or place in answer: %s", r.Answer)
	}
	if !strings.Contains(r.Speech, "Good morning!") || len([]rune(r.Speech)) > 240 {
		t.Fatalf("speech invalid: %s", r.Speech)
	}
	if len(r.Sources) < 1 || r.Sources[0].Publisher != "Open-Meteo" {
		t.Fatalf("missing Open-Meteo source: %+v", r.Sources)
	}
}

func TestLookupBriefingDerivesCityFromTimezone(t *testing.T) {
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Host, "geocoding-api.open-meteo.com") {
			name := r.URL.Query().Get("name")
			if !strings.Contains(name, "Kolkata") {
				t.Fatalf("expected geocoding for Kolkata from timezone, got: %s", name)
			}
			body := `{"results":[{"name":"Kolkata","country":"India","country_code":"IN","timezone":"Asia/Kolkata","latitude":22.57,"longitude":88.36,"feature_code":"PPLA"}]}`
			return lookupJSONResponse(200, body), nil
		}
		if strings.Contains(r.URL.Host, "api.open-meteo.com") {
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		}
		t.Fatalf("unexpected host: %s", r.URL)
		return nil, nil
	})

	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "", Today: true}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil {
		t.Fatalf("briefing lookup failed: %v", err)
	}
	r := outcome.Result
	if r.Kind != "briefing" || r.Status != "answered" {
		t.Fatalf("unexpected result: %+v", r)
	}
	if !strings.Contains(r.Answer, "Kolkata") {
		t.Fatalf("expected derived city Kolkata in answer: %s", r.Answer)
	}
}

func TestLookupBriefingHindi(t *testing.T) {
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Host, "geocoding-api.open-meteo.com") {
			return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
		}
		if strings.Contains(r.URL.Host, "api.open-meteo.com") {
			return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
		}
		t.Fatalf("unexpected host: %s", r.URL)
		return nil, nil
	})

	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "briefing", Place: "Pune", Today: true, ReplyLanguage: "hi"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil {
		t.Fatalf("hindi briefing lookup failed: %v", err)
	}
	r := outcome.Result
	if !strings.Contains(r.Answer, "शुभ प्रभात!") || !strings.Contains(r.Speech, "शुभ प्रभात!") {
		t.Fatalf("missing hindi morning greeting: %s", r.Answer)
	}
}
