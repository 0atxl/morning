package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"
)

const websocketURL = "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&interim_results=true&smart_format=true"

type commandRequest struct {
	CommandID  string `json:"command_id"`
	Transcript string `json:"transcript"`
	Now        string `json:"now"`
	Timezone   string `json:"timezone"`
}

type action struct {
	Type  string `json:"type"`
	Title string `json:"title"`
	DueAt string `json:"due_at"`
}

type interpretation struct {
	Actions       []action `json:"actions"`
	Clarification *string  `json:"clarification"`
}

type commandResponse struct {
	CommandID string `json:"command_id"`
	interpretation
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int    `json:"expires_in"`
	WebsocketURL string `json:"websocket_url"`
}

type apiError struct {
	CommandID string      `json:"command_id,omitempty"`
	Error     errorDetail `json:"error"`
}

type errorDetail struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type api struct {
	providers *providers
	clock     func() time.Time
	tokens    *rateLimiter
	commands  *rateLimiter
}

func newAPI(p *providers, clock func() time.Time) http.Handler {
	a := &api{
		providers: p,
		clock:     clock,
		tokens:    newRateLimiter(5, 60),
		commands:  newRateLimiter(10, 120),
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		var handler http.HandlerFunc
		switch r.URL.Path {
		case "/api/voice/token":
			handler = a.voiceToken
		case "/api/commands":
			handler = a.command
		default:
			writeError(w, http.StatusNotFound, "", "not_found", "This endpoint does not exist.", false)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "", "method_not_allowed", "Use POST for this endpoint.", false)
			return
		}
		handler(w, r)
	})
}

func (a *api) voiceToken(w http.ResponseWriter, r *http.Request) {
	if !a.allow(w, r, a.tokens) {
		return
	}
	var body struct{}
	if !readJSON(w, r, &body, 1024) {
		return
	}
	token, err := a.providers.grantToken(r.Context())
	if err != nil {
		writeProviderError(w, "", "voice", err)
		return
	}
	writeJSON(w, http.StatusOK, tokenResponse{
		AccessToken: token.AccessToken, ExpiresIn: token.ExpiresIn, WebsocketURL: websocketURL,
	})
}

func (a *api) command(w http.ResponseWriter, r *http.Request) {
	if !a.allow(w, r, a.commands) {
		return
	}
	var request commandRequest
	if !readJSON(w, r, &request, 16<<10) {
		return
	}
	now, location, err := validateRequest(request)
	if err != nil {
		id := request.CommandID
		if !validCommandID(id) {
			id = ""
		}
		writeError(w, http.StatusBadRequest, id, "invalid_request", err.Error(), false)
		return
	}
	result, err := a.providers.interpret(r.Context(), request, now, location)
	if err != nil {
		writeProviderError(w, request.CommandID, "command", err)
		return
	}
	if err := validateInterpretation(&result, now, location); err != nil {
		writeProviderError(w, request.CommandID, "command", errInvalidProviderOutput)
		return
	}
	writeJSON(w, http.StatusOK, commandResponse{CommandID: request.CommandID, interpretation: result})
}

func (a *api) allow(w http.ResponseWriter, r *http.Request, limiter *rateLimiter) bool {
	if retryAfter := limiter.allow(r.RemoteAddr, a.clock()); retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		writeError(w, http.StatusTooManyRequests, "", "rate_limited", "Too many requests. Please wait before trying again.", true)
		return false
	}
	return true
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "", "unsupported_media_type", "Send an application/json body.", false)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "", "request_too_large", "The request is too large.", false)
		} else {
			writeError(w, http.StatusBadRequest, "", "invalid_request", "Could not read the request body.", false)
		}
		return false
	}
	if err := decodeObject(body, dst); err != nil {
		writeError(w, http.StatusBadRequest, "", "invalid_request", "Send one JSON object with only the documented fields.", false)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, id, code, message string, retryable bool) {
	writeJSON(w, status, apiError{CommandID: id, Error: errorDetail{Code: code, Message: message, Retryable: retryable}})
}

func writeProviderError(w http.ResponseWriter, id, stage string, err error) {
	code, message := stage+"_provider_unavailable", "Morning couldn't interpret your command. Please try again."
	if stage == "voice" {
		message = "Morning couldn't start live captions. Please try again."
	}
	status := http.StatusBadGateway
	if errors.Is(err, errInvalidProviderOutput) {
		code = stage + "_provider_invalid_response"
		message = "Morning received an invalid response. Please try again."
	} else if errors.Is(err, errProviderTimeout) {
		status = http.StatusGatewayTimeout
		code = stage + "_provider_timeout"
		message = "Morning's provider took too long to respond. Please try again."
	}
	writeError(w, status, id, code, message, true)
}
