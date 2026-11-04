package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestProviderRetryTimingUsesSafeUpstreamValues(t *testing.T) {
	now := time.Date(2026, 11, 4, 4, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		value string
		want  int
	}{
		{"2", 2}, {" 300 ", 300}, {"2.5", 3}, {"0", 1},
		{now.Add(15 * time.Minute).Format(http.TimeFormat), 900},
		{"", 60}, {"invalid", 60}, {"7.66s", 60}, {"-5", 60}, {"NaN", 60}, {"+Inf", 60}, {"99999999999999999999", 60},
		{now.Add(-time.Hour).Format(http.TimeFormat), 60},
	} {
		if got := providerRetrySeconds(tc.value, now); got != tc.want {
			t.Errorf("%q: retry %d, want %d", tc.value, got, tc.want)
		}
	}
}

func TestCommandRateLimitForwardsWaitWithoutRetryingOrLeakingProviderBody(t *testing.T) {
	calls := 0
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != groqCommandURL {
			t.Fatal("unexpected provider")
		}
		response := providerResponse(429, `{"error":{"message":"private transcript fixture-provider-key"}}`)
		response.Header.Set("Retry-After", "7200")
		return response, nil
	})
	response := requestAPI(handler, "/api/commands", fixtureCommand)
	var result apiError
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || response.Code != 429 || result.Error.Code != "command_provider_rate_limited" || response.Header().Get("Retry-After") != "7200" || calls != 1 {
		t.Fatalf("provider timing was lost or retried: %d %s calls=%d", response.Code, response.Body.String(), calls)
	}
	if !strings.Contains(result.Error.Message, "Groq") || strings.Contains(response.Body.String(), "private") || strings.Contains(response.Body.String(), "fixture-provider-key") {
		t.Fatal("the rate-limit error is unclear or exposes provider details")
	}
}

func TestLookupRateLimitRetainsGroqWaitAndLookupScope(t *testing.T) {
	calls := 0
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		calls++
		response := providerResponse(429, "private provider detail")
		response.Header.Set("Retry-After", "12.5")
		return response, nil
	})
	request := mustLookupRequest(t)
	request.Transcript = "New Delhi"
	request.LookupContext = &lookupContext{Query: lookupQuery{Kind: "weather"}}
	payload, _ := json.Marshal(request)
	response := requestAPI(handler, "/api/commands", string(payload))
	var result apiError
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || response.Code != 429 || result.Error.Code != "lookup_quota_limited" || calls != 1 || response.Header().Get("Retry-After") != "13" || strings.Contains(response.Body.String(), "private") {
		t.Fatalf("lookup failure scope or timing was lost or retried: %d %s", response.Code, response.Body.String())
	}
}
