package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	maxSpeechChars = 240
	maxSpeechBody  = 2 << 10
	maxSpeechAudio = 1 << 20
)

type speechService struct {
	key     string
	voiceID string
	client  http.Client
	limiter *rateLimiter
}

type speechHTTPError struct {
	status int
	code   string
}

func (e speechHTTPError) Error() string {
	return "provider HTTP " + strconv.Itoa(e.status) + " (" + e.code + ")"
}

// Only these fixed codes may leave the provider response. Its message can
// contain private request data.
func speechRejection(resp *http.Response) speechHTTPError {
	var body struct{ Detail struct{ Code, Status string } }
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body)
	code := body.Detail.Code
	if code == "" {
		code = body.Detail.Status
	}
	switch code {
	case "invalid_api_key", "missing_permissions", "voice_not_found", "invalid_voice_id",
		"quota_exceeded", "insufficient_credits", "payment_required", "paid_plan_required",
		"model_access_denied", "detected_unusual_activity", "rate_limit_exceeded":
	default:
		code = "unspecified"
	}
	return speechHTTPError{status: resp.StatusCode, code: code}
}

func newSpeechService(transport http.RoundTripper) *speechService {
	return &speechService{
		key:     strings.TrimSpace(os.Getenv("ELEVENLABS_API_KEY")),
		voiceID: strings.TrimSpace(os.Getenv("ELEVENLABS_VOICE_ID")),
		limiter: newRateLimiter(10, 120),
		client: http.Client{
			Transport: transport,
			Timeout:   8 * time.Second,
			// Never forward the custom API-key header or text to a redirect target.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func (a *api) speak(w http.ResponseWriter, r *http.Request) {
	if !a.allow(w, r, a.speech.limiter) {
		return
	}
	var request struct {
		Text string `json:"text"`
	}
	if !readJSON(w, r, &request, maxSpeechBody) {
		return
	}
	if !validText(request.Text, maxSpeechChars) || strings.ContainsAny(request.Text, "\u2028\u2029") {
		writeError(w, http.StatusBadRequest, "", "invalid_request", "Send a single-line confirmation of 1 to 240 characters without surrounding whitespace.", false)
		return
	}
	if a.speech.key == "" || a.speech.voiceID == "" {
		writeError(w, http.StatusServiceUnavailable, "", "speech_not_configured", "The ElevenLabs voice is not configured.", false)
		return
	}

	audio, err := a.speech.synthesize(r.Context(), request.Text)
	if err != nil {
		// synthesize returns only fixed errors or a numeric HTTP status. The
		// proxy can replace a 502 body, so keep the stage in the service log.
		log.Printf("speech synthesis failed: %v", err)
		if rejection, ok := err.(speechHTTPError); ok {
			w.Header().Set("X-Morning-Speech-Provider-Status", strconv.Itoa(rejection.status))
		}
		writeProviderError(w, "", "speech", err)
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	_, _ = w.Write(audio)
}

func (s *speechService) synthesize(ctx context.Context, text string) ([]byte, error) {
	body, _ := json.Marshal(map[string]string{"text": text, "model_id": "eleven_flash_v2_5"})
	endpoint := "https://api.elevenlabs.io/v1/text-to-speech/" + url.PathEscape(s.voiceID) + "?output_format=mp3_44100_128"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, errProviderUnavailable
	}
	req.Header.Set("xi-api-key", s.key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "audio/mpeg")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, providerRequestError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, speechRejection(resp)
	}
	// Buffer the short clip so a stalled or invalid response still yields a JSON error.
	audio, err := io.ReadAll(io.LimitReader(resp.Body, maxSpeechAudio+1))
	if err != nil {
		return nil, providerRequestError(err)
	}
	if len(audio) < 4 || len(audio) > maxSpeechAudio {
		return nil, errInvalidProviderOutput
	}
	// A 44.1 kHz MP3 starts with an ID3 tag or an MPEG-1 Layer III frame header.
	if !bytes.HasPrefix(audio, []byte("ID3")) && !(audio[0] == 0xff && audio[1]&0xfe == 0xfa) {
		return nil, errInvalidProviderOutput
	}
	return audio, nil
}
