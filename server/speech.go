package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
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
		return nil, errProviderUnavailable
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
