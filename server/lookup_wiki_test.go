package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestLookupWikiReturnsGroundedSummaryAndWikipediaSource(t *testing.T) {
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("User-Agent") != "Morning/1.0 (https://morning.atuls.me; contact@atuls.me)" {
			t.Fatal("missing user agent header on Wikipedia request")
		}
		if strings.Contains(r.URL.Path, "opensearch") {
			return lookupJSONResponse(200, `["Adolf Hitler",["Adolf Hitler"],[""],["https://en.wikipedia.org/wiki/Adolf_Hitler"]]`), nil
		}
		if strings.Contains(r.URL.Path, "page/summary/Adolf_Hitler") {
			body := `{
				"type": "standard",
				"title": "Adolf Hitler",
				"description": "Dictator of Germany from 1933 to 1945",
				"extract": "Adolf Hitler was an Austrian-born German politician who was dictator of Germany in the Nazi era from 1933 until his suicide in 1945. Germany's invasion of Poland on 1 September 1939 marked the outbreak of World War II.",
				"content_urls": {
					"desktop": {
						"page": "https://en.wikipedia.org/wiki/Adolf_Hitler"
					}
				}
			}`
			return lookupJSONResponse(200, body), nil
		}
		t.Fatalf("unexpected Wikipedia endpoint: %s", r.URL)
		return nil, nil
	})

	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "Adolf Hitler"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil {
		t.Fatalf("wiki lookup failed: %v", err)
	}
	r := outcome.Result
	if r.Kind != "wiki" || r.Status != "answered" {
		t.Fatalf("wrong status: %+v", r)
	}
	if !strings.Contains(r.Answer, "Adolf Hitler (Dictator of Germany from 1933 to 1945)") || !strings.Contains(r.Answer, "Austrian-born") {
		t.Fatalf("missing extract facts: %s", r.Answer)
	}
	if len(r.Sources) != 1 || r.Sources[0].Publisher != "Wikipedia" || r.Sources[0].URL != "https://en.wikipedia.org/wiki/Adolf_Hitler" {
		t.Fatalf("wrong source: %+v", r.Sources)
	}
	if len([]rune(r.Speech)) > 240 || !strings.Contains(r.Speech, "Austrian-born") {
		t.Fatalf("speech invalid: %s", r.Speech)
	}
}

func TestLookupWikiHindiTopicUsesHindiWikipediaHost(t *testing.T) {
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "hi.wikipedia.org" {
			t.Fatalf("expected Hindi Wikipedia host, got %s", r.URL.Host)
		}
		if strings.Contains(r.URL.Path, "opensearch") {
			return lookupJSONResponse(200, `["महात्मा गांधी",["महात्मा गांधी"],[""],["https://hi.wikipedia.org/wiki/%E0%A4%AE%E0%A4%B9%E0%A4%BE%E0%A4%A4%E0%A5%8D%E0%A4%AE%E0%A4%BE_%E0%A4%97%E0%A4%BE%E0%A4%82%E0%A4%A7%E0%A5%80"]]`), nil
		}
		body := `{
			"type": "standard",
			"title": "महात्मा गांधी",
			"extract": "मोहनदास करमचन्द गांधी जिन्हें महात्मा गांधी के नाम से भी जाना जाता है, भारत एवं भारतीय स्वतन्त्रता आन्दोलन के एक प्रमुख राजनैतिक एवं आध्यात्मिक नेता थे।",
			"content_urls": {
				"desktop": {
					"page": "https://hi.wikipedia.org/wiki/%E0%A4%AE%E0%A4%B9%E0%A4%BE%E0%A4%A4%E0%A5%8D%E0%A4%AE%E0%A4%BE_%E0%A4%97%E0%A4%BE%E0%A4%82%E0%A4%A7%E0%A5%80"
				}
			}
		}`
		return lookupJSONResponse(200, body), nil
	})

	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "महात्मा गांधी", ReplyLanguage: "hi"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil {
		t.Fatalf("Hindi wiki lookup failed: %v", err)
	}
	r := outcome.Result
	if !strings.Contains(r.Answer, "मोहनदास करमचन्द गांधी") || len(r.Sources) != 1 || r.Sources[0].Publisher != "Wikipedia" {
		t.Fatalf("unexpected Hindi result: %+v", r)
	}
}

func TestLookupWikiNotFoundProducesHonestEmptyResult(t *testing.T) {
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "opensearch") {
			return lookupJSONResponse(200, `["nonexistent topic",[],[],[]]`), nil
		}
		return lookupJSONResponse(404, `{"type":"https://mediawiki.org/wiki/HyperSwitch/errors/not_found"}`), nil
	})

	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "nonexistent topic"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil {
		t.Fatalf("lookup failed: %v", err)
	}
	if outcome.Result.Status != "empty" || len(outcome.Result.Sources) != 0 {
		t.Fatalf("expected empty result: %+v", outcome.Result)
	}
}
