package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

const fixtureCommand = `{"command_id":"5db11242-ecba-4acf-876a-f92c4fae4b86","transcript":"Remind me in ten minutes to check the oven","now":"2026-11-03T09:00:00+05:30","timezone":"Asia/Kolkata"}`

// All provider traffic uses this transport. These tests cannot reach the network.
type fixtureTransport func(*http.Request) (*http.Response, error)

func (f fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type timeoutReader struct{}

func (timeoutReader) Read([]byte) (int, error) { return 0, context.DeadlineExceeded }

func fixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func providerResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func fixtureAPI(t *testing.T, transport fixtureTransport) http.Handler {
	t.Helper()
	p := &providers{
		client:      &http.Client{Transport: transport},
		deepgramKey: "fixture-permanent-deepgram-key",
		groqKey:     "fixture-permanent-groq-key",
	}
	now, err := time.Parse(time.RFC3339, "2026-11-03T09:00:00+05:30")
	if err != nil {
		t.Fatal(err)
	}
	return newAPI(p, func() time.Time { return now })
}

func requestAPI(handler http.Handler, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.10:12345"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestReminderContract(t *testing.T) {
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != groqCommandURL || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer fixture-permanent-groq-key" {
			t.Fatalf("unexpected Groq request: %s %s", r.Method, r.URL)
		}
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
			ResponseFormat struct {
				Type       string `json:"type"`
				JSONSchema struct {
					Strict bool `json:"strict"`
				} `json:"json_schema"`
			} `json:"response_format"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Model != "openai/gpt-oss-20b" || body.ResponseFormat.Type != "json_schema" || !body.ResponseFormat.JSONSchema.Strict {
			t.Fatal("expected the requested model and strict schema")
		}
		if len(body.Messages) != 2 || body.Messages[0].Role != "system" || body.Messages[1].Role != "user" {
			t.Fatal("expected separate system instructions and transcript data")
		}
		var data map[string]string
		if err := json.Unmarshal([]byte(body.Messages[1].Content), &data); err != nil {
			t.Fatal(err)
		}
		if data["now"] != "2026-11-03T09:00:00+05:30" || data["timezone"] != "Asia/Kolkata" || data["transcript"] != "Remind me in ten minutes to check the oven" {
			t.Fatalf("wrong time context: %v", data)
		}
		if _, exists := data["command_id"]; exists {
			t.Fatal("the model must not supply command IDs")
		}
		return providerResponse(http.StatusOK, fixture(t, "groq-reminder.json")), nil
	})
	w := requestAPI(handler, "/api/commands", fixtureCommand)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var result commandResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.CommandID != "5db11242-ecba-4acf-876a-f92c4fae4b86" || result.Clarification != nil || len(result.Actions) != 1 {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
	if got := result.Actions[0]; got.Type != "create_reminder" || got.Title != "Check the oven" || got.DueAt != "2026-11-03T09:10:00+05:30" {
		t.Fatalf("wrong reminder: %+v", got)
	}
	var envelope map[string]json.RawMessage
	_ = json.Unmarshal(w.Body.Bytes(), &envelope)
	var actions []map[string]json.RawMessage
	_ = json.Unmarshal(envelope["actions"], &actions)
	if len(envelope) != 3 || len(actions[0]) != 3 {
		t.Fatalf("single reminder shape changed: %s", w.Body.String())
	}
}

func TestMissingTimeClarifiesWithoutActions(t *testing.T) {
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		return providerResponse(http.StatusOK, fixture(t, "groq-clarification.json")), nil
	})
	w := requestAPI(handler, "/api/commands", strings.Replace(fixtureCommand, "in ten minutes ", "", 1))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var result commandResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Actions == nil || len(result.Actions) != 0 || result.Clarification == nil || *result.Clarification != "When should I remind you to check the oven?" {
		t.Fatalf("expected an empty array and question: %s", w.Body.String())
	}
}

func TestProviderFailuresAreDisplayableAndRedacted(t *testing.T) {
	for _, tc := range []struct {
		name, path, request, code string
		status                    int
		transport                 fixtureTransport
	}{
		{"groq outage", "/api/commands", fixtureCommand, "command_provider_unavailable", 502, func(*http.Request) (*http.Response, error) {
			return providerResponse(503, fixture(t, "groq-unavailable.json")), nil
		}},
		{"groq rate limit", "/api/commands", fixtureCommand, "command_provider_rate_limited", 429, func(*http.Request) (*http.Response, error) {
			return providerResponse(429, "private provider body"), nil
		}},
		{"deepgram rate limit", "/api/voice/token", `{}`, "voice_provider_rate_limited", 429, func(*http.Request) (*http.Response, error) {
			return providerResponse(429, "private provider body"), nil
		}},
		{"groq timeout", "/api/commands", fixtureCommand, "command_provider_timeout", 504, func(*http.Request) (*http.Response, error) {
			return nil, context.DeadlineExceeded
		}},
		{"groq body timeout", "/api/commands", fixtureCommand, "command_provider_timeout", 504, func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(timeoutReader{})}, nil
		}},
		{"deepgram outage", "/api/voice/token", `{}`, "voice_provider_unavailable", 502, func(*http.Request) (*http.Response, error) {
			return providerResponse(403, `{"message":"fixture-permanent-deepgram-key"}`), nil
		}},
		{"malformed Groq body", "/api/commands", fixtureCommand, "command_provider_invalid_response", 502, func(*http.Request) (*http.Response, error) {
			return providerResponse(200, `{not JSON}`), nil
		}},
		{"oversized Groq body", "/api/commands", fixtureCommand, "command_provider_invalid_response", 502, func(*http.Request) (*http.Response, error) {
			return providerResponse(200, strings.Repeat("x", maxProviderBody+1)), nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := requestAPI(fixtureAPI(t, tc.transport), tc.path, tc.request)
			var result apiError
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if w.Code != tc.status || result.Error.Code != tc.code || !result.Error.Retryable || result.Error.Message == "" {
				t.Fatalf("unexpected error: %d %s", w.Code, w.Body.String())
			}
			if tc.path == "/api/commands" && result.CommandID != "5db11242-ecba-4acf-876a-f92c4fae4b86" {
				t.Fatal("failed command must echo its ID")
			}
			for _, forbidden := range []string{"permanent", "Synthetic", "server.", "oven"} {
				if strings.Contains(w.Body.String(), forbidden) {
					t.Fatalf("provider data leaked: %s", w.Body.String())
				}
			}
		})
	}
}

func TestTokenGrantExpiry(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		wantExpiry int
	}{
		{"explicit expiry", fixture(t, "deepgram-grant.json"), 30},
		{"omitted expiry", fixture(t, "deepgram-grant-no-expiry.json"), 30},
		{"shorter explicit expiry", `{"access_token":"fixture-temporary-token","expires_in":15}`, 15},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
				var body map[string]int
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["ttl_seconds"] != 30 {
					t.Fatal("expected a 30-second grant request")
				}
				return providerResponse(200, tc.body), nil
			})
			w := requestAPI(handler, "/api/voice/token", `{}`)
			var result tokenResponse
			if err := decodeObject(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || result.AccessToken != "fixture-temporary-token" || result.ExpiresIn != tc.wantExpiry || result.WebsocketURL != websocketURL {
				t.Fatalf("unexpected token response: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestTemporaryTokenAndIssuanceLimit(t *testing.T) {
	calls := 0
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != deepgramGrantURL || r.Header.Get("Authorization") != "Token fixture-permanent-deepgram-key" {
			t.Fatalf("unexpected Deepgram request: %s", r.URL)
		}
		var body map[string]int
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["ttl_seconds"] != 30 {
			t.Fatal("expected a 30-second grant")
		}
		return providerResponse(200, fixture(t, "deepgram-grant.json")), nil
	})
	for i := 0; i < 31; i++ {
		// Changing an untrusted forwarding header must not bypass the IP limit.
		r := httptest.NewRequest(http.MethodPost, "/api/voice/token", strings.NewReader(`{}`))
		r.RemoteAddr = fmt.Sprintf("192.0.2.10:%d", 1000+i)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", i))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if i == 30 {
			if w.Code != 429 || w.Header().Get("Retry-After") != "60" || calls != 30 {
				t.Fatalf("rate limit failed: %d %s, calls=%d", w.Code, w.Body.String(), calls)
			}
			continue
		}
		var result tokenResponse
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || result.AccessToken != "fixture-temporary-token" || result.ExpiresIn != 30 || result.WebsocketURL != websocketURL {
			t.Fatalf("unexpected token response: %d %s", w.Code, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "permanent") {
			t.Fatal("tokens must not be cached or expose permanent keys")
		}
	}
}

func TestRejectsInvalidRequestsBeforeCallingProviders(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"empty transcript", strings.Replace(fixtureCommand, "Remind me in ten minutes to check the oven", " ", 1), 400},
		{"long transcript", strings.Replace(fixtureCommand, "Remind me in ten minutes to check the oven", strings.Repeat("a", 8193), 1), 400},
		{"bad ID", strings.Replace(fixtureCommand, "5db11242-ecba-4acf-876a-f92c4fae4b86", "id with spaces", 1), 400},
		{"bad timezone", strings.Replace(fixtureCommand, "Asia/Kolkata", "not-a-timezone", 1), 400},
		{"host timezone", strings.Replace(fixtureCommand, "Asia/Kolkata", "Local", 1), 400},
		{"no timestamp offset", strings.Replace(fixtureCommand, "09:00:00+05:30", "09:00:00", 1), 400},
		{"extra field", strings.TrimSuffix(fixtureCommand, "}") + `,"unsupported_context":[]}`, 400},
		{"null", "null", 400},
		{"two objects", fixtureCommand + `{}`, 400},
		{"large body", strings.Repeat(" ", 64<<10) + fixtureCommand, 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				t.Fatal("invalid requests must not call providers")
				return nil, nil
			})
			w := requestAPI(handler, "/api/commands", tc.body)
			if w.Code != tc.status {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestJSONOnlyPostRoutes(t *testing.T) {
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid routes must not call providers")
		return nil, nil
	})
	for _, tc := range []struct {
		method, path, contentType, body string
		status                          int
	}{
		{http.MethodGet, "/api/voice/token", "application/json", `{}`, 405},
		{http.MethodPost, "/api/unknown", "application/json", `{}`, 404},
		{http.MethodPost, "/api/voice/token", "text/plain", `{}`, 415},
		{http.MethodPost, "/api/voice/token", "application/json", `{"ttl_seconds":3600}`, 400},
		{http.MethodPost, "/api/voice/token", "application/json", `null`, 400},
	} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		r.Header.Set("Content-Type", tc.contentType)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}
