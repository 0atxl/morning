package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strconv"
	"time"
)

const websocketURL = "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&interim_results=true&smart_format=true"

type commandRequest struct {
	CommandID          string           `json:"command_id"`
	Transcript         string           `json:"transcript"`
	Now                string           `json:"now"`
	Timezone           string           `json:"timezone"`
	Contacts           []contact        `json:"contacts,omitempty"`
	SelectedContactID  *string          `json:"selected_contact_id,omitempty"`
	ReminderContext    *reminderContext `json:"reminder_context,omitempty"`
	SelectedReminderID *string          `json:"selected_reminder_id,omitempty"`
	DraftContext       *draftContext    `json:"draft_context,omitempty"`
	SelectedDraftID    *string          `json:"selected_draft_id,omitempty"`
	LookupContext      *lookupContext   `json:"lookup_context,omitempty"`
}

type draftContext struct {
	ID        string `json:"id"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	Recipient string `json:"recipient"`
	To        string `json:"to"`
}

type reminderContext struct {
	ID    string    `json:"id"`
	DueAt time.Time `json:"due_at"`
}

type action struct {
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	ReminderID string `json:"reminder_id,omitempty"`
	DraftID    string `json:"draft_id,omitempty"`
	Title      string `json:"title,omitempty"`
	DueAt      string `json:"due_at,omitempty"`
	Start      string `json:"start,omitempty"`
	End        string `json:"end,omitempty"`
	Timezone   string `json:"timezone,omitempty"`
	// Groq quotes the spoken start and end or duration. Go removes these before responding.
	StartPhrase string `json:"start_phrase,omitempty"`
	EndPhrase   string `json:"end_phrase,omitempty"`
	ToContactID string `json:"to_contact_id,omitempty"`
	Subject     string `json:"subject,omitempty"`
	Body        string `json:"body,omitempty"`
}

type interpretation struct {
	Actions              []action        `json:"actions"`
	Clarification        *string         `json:"clarification"`
	ClarificationOptions []contactOption `json:"clarification_options,omitempty"`
}

type commandResponse struct {
	CommandID string `json:"command_id"`
	interpretation
	Reply         string         `json:"reply,omitempty"`
	Lookup        *lookupResult  `json:"lookup,omitempty"`
	LookupContext *lookupContext `json:"lookup_context,omitempty"`
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
	speech    *speechService
	lookups   *lookupService
}

func newAPI(p *providers, clock func() time.Time) http.Handler {
	return newAPIWithMailbox(p, clock, nil)
}

func newAPIWithMailbox(p *providers, clock func() time.Time, mailbox *reminderMailbox) http.Handler {
	a := &api{
		providers: p,
		clock:     clock,
		tokens:    newRateLimiter(30, 300),
		commands:  newRateLimiter(60, 600),
		speech:    newSpeechService(p.client.Transport),
		lookups:   newLookupService(p, clock),
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
		case "/api/speech":
			handler = a.speak
		case "/api/reminder-email":
			handler = mailbox.schedule
		case "/api/minutes":
			handler = a.minutes
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
	ctx, cancel := context.WithTimeout(r.Context(), 22*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if !a.allow(w, r, a.commands) {
		return
	}
	var request commandRequest
	if !readJSON(w, r, &request, 64<<10) {
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
	if request.LookupContext != nil {
		query, err := withLookupPlace(*request.LookupContext, request.Transcript)
		if err != nil {
			writeError(w, http.StatusBadRequest, request.CommandID, "invalid_request", "Say a city or landmark to finish this search.", false)
			return
		}
		a.answerLookup(w, r, request, query)
		return
	}
	model, err := a.providers.interpret(r.Context(), request, now, location)
	if err != nil {
		writeProviderError(w, request.CommandID, "command", err)
		return
	}
	if model.Lookup != nil {
		if model.Actions == nil || len(model.Actions) != 0 || model.Clarification != nil || model.RecipientName != nil ||
			request.SelectedContactID != nil || request.SelectedReminderID != nil || request.SelectedDraftID != nil || validateLookup(*model.Lookup) != nil {
			writeProviderError(w, request.CommandID, "command", errInvalidProviderOutput)
			return
		}
		a.answerLookup(w, r, request, *model.Lookup)
		return
	}
	result := interpretation{Actions: model.Actions, Clarification: model.Clarification}
	if validateInterpretation(&result, now, location) != nil || validateCalendarCommand(&result, request.Transcript) != nil {
		writeProviderError(w, request.CommandID, "command", errInvalidProviderOutput)
		return
	}
	result, err = resolveCorrection(result, request, location)
	if err != nil {
		writeProviderError(w, request.CommandID, "command", errInvalidProviderOutput)
		return
	}
	result, err = resolveContact(result, model.RecipientName, request)
	if errors.Is(err, errInvalidSelection) {
		writeError(w, http.StatusBadRequest, request.CommandID, "invalid_request", err.Error(), false)
		return
	}
	if err != nil {
		writeProviderError(w, request.CommandID, "command", errInvalidProviderOutput)
		return
	}
	if len(result.Actions) == 1 && result.Actions[0].Type == "update_draft" {
		if request.DraftContext == nil {
			question := "Which draft should I update?"
			result = interpretation{Actions: []action{}, Clarification: &question}
		} else {
			result.Actions[0].DraftID = request.DraftContext.ID
		}
	}
	if len(result.Actions) > 0 && ((request.SelectedReminderID != nil && result.Actions[0].Type != "reschedule_reminder") || (request.SelectedDraftID != nil && result.Actions[0].Type != "update_draft")) {
		writeProviderError(w, request.CommandID, "command", errInvalidProviderOutput)
		return
	}
	if err := validateCommandCompleteness(result, request.Transcript); err != nil {
		writeProviderError(w, request.CommandID, "command", errInvalidProviderOutput)
		return
	}
	if len(result.Actions) == 1 && result.Actions[0].Type == "reply" {
		writeJSON(w, http.StatusOK, commandResponse{CommandID: request.CommandID, interpretation: interpretation{Actions: []action{}}, Reply: result.Actions[0].Text})
		return
	}
	writeJSON(w, http.StatusOK, commandResponse{CommandID: request.CommandID, interpretation: result})
}

func (a *api) allow(w http.ResponseWriter, r *http.Request, limiter *rateLimiter) bool {
	if retryAfter := limiter.allow(clientAddress(r), a.clock()); retryAfter > 0 {
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
	// Provider errors contain fixed categories, never response bodies or credentials.
	log.Printf("%s request failed: %v", stage, err)
	code, message := stage+"_provider_unavailable", "Morning couldn't interpret your command. Please try again."
	if stage == "voice" {
		message = "Morning couldn't start live captions. Please try again."
	} else if stage == "speech" {
		message = "Morning couldn't generate the spoken confirmation."
	} else if stage == "minutes" {
		message = "Morning couldn't prepare the meeting minutes. Please try again."
	}
	status := http.StatusBadGateway
	if errors.Is(err, errProviderRateLimited) {
		status = http.StatusTooManyRequests
		code = stage + "_provider_rate_limited"
		message = "Morning's provider reached its request limit. Please wait and retry."
		w.Header().Set("Retry-After", "60")
	} else if errors.Is(err, errInvalidProviderOutput) {
		code = stage + "_provider_invalid_response"
		message = "Morning received an invalid response. Please try again."
	} else if errors.Is(err, errProviderTimeout) {
		status = http.StatusGatewayTimeout
		code = stage + "_provider_timeout"
		message = "Morning's provider took too long to respond. Please try again."
	}
	writeError(w, status, id, code, message, true)
}
