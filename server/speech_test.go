package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const speechExample = `{"text":"Draft saved. I’ll remind you Friday at ten."}`

func TestSpeechMP3(t *testing.T) {
	t.Setenv("ELEVENLABS_API_KEY", "fixture-speech-key")
	t.Setenv("ELEVENLABS_VOICE_ID", "fixture-voice")
	clip := fixture(t, "speech-silence.mp3")
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.String() != "https://api.elevenlabs.io/v1/text-to-speech/fixture-voice?output_format=mp3_44100_128" {
			t.Fatal("unexpected synthesis endpoint")
		}
		if r.Header.Get("xi-api-key") != "fixture-speech-key" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Accept") != "audio/mpeg" {
			t.Fatal("incorrect synthesis headers")
		}
		if _, ok := r.Context().Deadline(); !ok {
			t.Fatal("expected a provider deadline")
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body) != 2 || body["model_id"] != "eleven_flash_v2_5" || body["text"] != "Draft saved. I’ll remind you Friday at ten." {
			t.Fatal("expected only model_id and the saved confirmation")
		}
		resp := providerResponse(200, clip)
		resp.Header.Set("Content-Type", "audio/mpeg")
		return resp, nil
	})
	w := requestAPI(handler, "/api/speech", speechExample)
	if w.Code != 200 || w.Header().Get("Content-Type") != "audio/mpeg" || w.Header().Get("Cache-Control") != "no-store" || w.Body.String() != clip {
		t.Fatal("expected the original MP3 bytes with no-store headers")
	}
}

func expectSpeechError(t *testing.T, w *httptest.ResponseRecorder, status int, code string, retryable bool) {
	t.Helper()
	var result apiError
	if err := decodeObject(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" || result.CommandID != "" || result.Error.Code != code || result.Error.Message == "" || result.Error.Retryable != retryable {
		t.Fatalf("unexpected speech error: %d %s", w.Code, w.Body.String())
	}
}

func TestSpeechInput(t *testing.T) {
	t.Setenv("ELEVENLABS_API_KEY", "fixture-speech-key")
	t.Setenv("ELEVENLABS_VOICE_ID", "fixture-voice")
	for _, tc := range []struct {
		name, body string
		status     int
		code       string
	}{
		{"empty", `{"text":""}`, 400, "invalid_request"},
		{"blank", `{"text":"  "}`, 400, "invalid_request"},
		{"multiline", `{"text":"Draft saved.\nNext line."}`, 400, "invalid_request"},
		{"long confirmation", `{"text":"` + strings.Repeat("é", 241) + `"}`, 400, "invalid_request"},
		{"oversize JSON", strings.Repeat(" ", 2<<10) + speechExample, 413, "request_too_large"},
		{"transcript", `{"text":"Draft saved.","transcript":"private"}`, 400, "invalid_request"},
		{"draft body", `{"text":"Draft saved.","body":"private"}`, 400, "invalid_request"},
		{"minutes", `{"minutes":"private"}`, 400, "invalid_request"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				t.Fatal("invalid speech input reached the provider")
				return nil, nil
			})
			expectSpeechError(t, requestAPI(handler, "/api/speech", tc.body), tc.status, tc.code, false)
		})
	}
}

func TestSpeechOptional(t *testing.T) {
	for _, missing := range []string{"ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"} {
		t.Run(missing, func(t *testing.T) {
			t.Setenv("ELEVENLABS_API_KEY", "fixture-speech-key")
			t.Setenv("ELEVENLABS_VOICE_ID", "fixture-voice")
			t.Setenv(missing, "")
			handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.String() != groqCommandURL {
					t.Fatal("unconfigured speech must not call ElevenLabs")
				}
				return providerResponse(200, fixture(t, "groq-reminder.json")), nil
			})
			for range 60 {
				expectSpeechError(t, requestAPI(handler, "/api/speech", speechExample), 503, "speech_not_configured", false)
			}
			w := requestAPI(handler, "/api/speech", speechExample)
			expectSpeechError(t, w, 429, "rate_limited", true)
			if w.Header().Get("Retry-After") == "" {
				t.Fatal("missing speech retry interval")
			}
			if w := requestAPI(handler, "/api/commands", fixtureCommand); w.Code != 200 {
				t.Fatalf("missing speech config blocked a command: %d", w.Code)
			}
		})
	}
}

func TestSpeechProviderFailure(t *testing.T) {
	t.Setenv("ELEVENLABS_API_KEY", "fixture-speech-key")
	t.Setenv("ELEVENLABS_VOICE_ID", "fixture-voice")
	for _, tc := range []struct {
		name     string
		response *http.Response
		err      error
		status   int
		code     string
	}{
		{"provider outage", providerResponse(503, "private provider detail"), nil, 502, "speech_provider_unavailable"},
		{"timeout", nil, context.DeadlineExceeded, 504, "speech_provider_timeout"},
		{"non-audio", providerResponse(200, `{"error":"private provider detail"}`), nil, 502, "speech_provider_invalid_response"},
		{"truncated body", providerResponse(200, ""), nil, 502, "speech_provider_invalid_response"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) { return tc.response, tc.err })
			w := requestAPI(handler, "/api/speech", speechExample)
			expectSpeechError(t, w, tc.status, tc.code, true)
			wantUpstream := ""
			if tc.name == "provider outage" {
				wantUpstream = "503"
			}
			if got := w.Header().Get("X-Morning-Speech-Provider-Status"); got != wantUpstream {
				t.Fatalf("upstream status %q, want %q", got, wantUpstream)
			}
			if strings.Contains(w.Body.String(), "private provider detail") {
				t.Fatal("provider response leaked into the JSON error")
			}
		})
	}
}

func TestSpeechRejectionKeepsOnlyKnownCodes(t *testing.T) {
	for _, tc := range []struct{ detail, want string }{
		{`{"code":"voice_not_found","message":"private response detail"}`, "voice_not_found"},
		{`{"status":"invalid_api_key"}`, "invalid_api_key"},
		{`{"code":"private response detail"}`, "unspecified"},
	} {
		resp := providerResponse(401, `{"detail":`+tc.detail+`}`)
		if got := speechRejection(resp); got.Error() != "provider HTTP 401 ("+tc.want+")" {
			t.Error("unexpected speech rejection classification")
		}
		resp.Body.Close()
	}
}

func TestSpeechPlanRequired(t *testing.T) {
	t.Setenv("ELEVENLABS_API_KEY", "fixture-speech-key")
	t.Setenv("ELEVENLABS_VOICE_ID", "fixture-voice")
	handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
		return providerResponse(402, `{"detail":{"code":"paid_plan_required","message":"private provider detail"}}`), nil
	})
	w := requestAPI(handler, "/api/speech", speechExample)
	expectSpeechError(t, w, 503, "speech_plan_required", false)
	if w.Header().Get("X-Morning-Speech-Provider-Status") != "402" || strings.Contains(w.Body.String(), "private provider detail") {
		t.Error("expected only the safe plan error and upstream status")
	}
}
