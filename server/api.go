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

const websocketURL = "wss://api.deepgram.com/v1/listen?model=nova-3&language=multi&language_hint=en&language_hint=hi&interim_results=true&smart_format=true"

type commandRequest struct {
	CommandID          string                `json:"command_id"`
	Transcript         string                `json:"transcript"`
	Now                string                `json:"now"`
	Timezone           string                `json:"timezone"`
	Contacts           []contact             `json:"contacts,omitempty"`
	SelectedContactID  *string               `json:"selected_contact_id,omitempty"`
	ReminderContext    *reminderContext      `json:"reminder_context,omitempty"`
	RemindersContext   []reminderContextItem `json:"reminders_context,omitempty"`
	SelectedReminderID *string               `json:"selected_reminder_id,omitempty"`
	DraftContext       *draftContext         `json:"draft_context,omitempty"`
	DraftsContext      []draftContext        `json:"drafts_context,omitempty"`
	SelectedDraftID    *string               `json:"selected_draft_id,omitempty"`
	LookupContext      *lookupContext        `json:"lookup_context,omitempty"`
	PreviousTurn       *previousTurnContext  `json:"previous_turn,omitempty"`
	RecentTurns        []recentTurnContext   `json:"recent_turns,omitempty"`
}

type previousTurnContext struct {
	Transcript string `json:"transcript,omitempty"`
	Topic      string `json:"topic,omitempty"`
	Answer     string `json:"answer,omitempty"`
	Reply      string `json:"reply,omitempty"`
}

// Optional memory fields must be strings, not explicit JSON null values.
func (p *previousTurnContext) UnmarshalJSON(data []byte) error {
	type fields previousTurnContext
	var value fields
	if err := decodeObject(data, &value); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(data, &raw)
	for _, field := range raw {
		if string(field) == "null" {
			return errors.New("previous_turn fields must be strings")
		}
	}
	*p = previousTurnContext(value)
	return nil
}

type recentTurnContext struct {
	Transcript   string `json:"transcript,omitempty"`
	Reply        string `json:"reply,omitempty"`
	Kind         string `json:"kind,omitempty"`
	Topic        string `json:"topic,omitempty"`
	Answer       string `json:"answer,omitempty"`
	PriorSession bool   `json:"prior_session,omitempty"`
}

type draftContext struct {
	ID        string `json:"id"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	Recipient string `json:"recipient"`
	To        string `json:"to"`
}

type reminderContext struct {
	ID     string    `json:"id"`
	Title  string    `json:"title,omitempty"`
	DueAt  time.Time `json:"due_at"`
	Repeat string    `json:"repeat,omitempty"`
}

type reminderContextItem struct {
	ID     string    `json:"id"`
	Title  string    `json:"title,omitempty"`
	DueAt  time.Time `json:"due_at"`
	Repeat string    `json:"repeat,omitempty"`
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
	Repeat     string `json:"repeat,omitempty"`
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
	ReplyLanguage string         `json:"reply_language,omitempty"`
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
	tracer    *langsmithTracer
}

func newAPI(p *providers, clock func() time.Time) http.Handler {
	return newAPIWithMailbox(p, clock, nil)
}

func newAPIWithMailbox(p *providers, clock func() time.Time, mailbox *reminderMailbox) http.Handler {
	if p.cooldowns == nil {
		p.cooldowns = newModelCooldowns()
	}
	tracer := newLangsmithTracer(p.client)
	if p.tracer == nil {
		p.tracer = tracer
	}
	a := &api{
		providers: p,
		clock:     clock,
		tokens:    newRateLimiter(30, 300),
		commands:  newRateLimiter(60, 600),
		speech:    newSpeechService(p.client.Transport),
		lookups:   newLookupService(p, clock),
		tracer:    tracer,
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
	cmdStart := time.Now()
	var cmdErr error
	var cmdOutput any
	var request commandRequest
	defer func() {
		if a.tracer != nil && request.CommandID != "" {
			a.tracer.TraceCommand(request.CommandID, request.Transcript, replyLanguage(request.Transcript), cmdStart, time.Now(), cmdOutput, cmdErr)
		}
	}()
	ctx, cancel := context.WithTimeout(r.Context(), 22*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if !a.allow(w, r, a.commands) {
		return
	}
	if !readJSON(w, r, &request, 64<<10) {
		return
	}
	now, location, err := validateRequest(request)
	if err != nil {
		id := request.CommandID
		if !validCommandID(id) {
			id = ""
		}
		cmdErr = err
		writeError(w, http.StatusBadRequest, id, "invalid_request", err.Error(), false)
		return
	}
	if request.LookupContext != nil {
		a.answerLookup(w, r, request, request.LookupContext.Query)
		return
	}
	language := replyLanguage(request.Transcript)
	// Fast 0-token local handler for greetings, thanks, capabilities, and local time/date.
	if request.SelectedContactID == nil && request.SelectedReminderID == nil && request.SelectedDraftID == nil {
		if reply, ok := smallTalk(request.Transcript, now, location, language); ok {
			resp := commandResponse{
				CommandID:      request.CommandID,
				interpretation: interpretation{Actions: []action{}},
				Reply:          reply,
				ReplyLanguage:  language,
			}
			cmdOutput = resp
			writeJSON(w, http.StatusOK, resp)
			return
		}
	}
	var model modelInterpretation
	var result interpretation
	feedback := ""
	for attempt := 0; attempt < 2; attempt++ {
		model, err = a.providers.interpret(r.Context(), request, now, location, feedback)
		stage := "provider_response"
		invalid := errors.Is(err, errInvalidProviderOutput)
		if err == nil {
			if model.Lookup != nil {
				normalizeModelLookup(model.Lookup)
			}
			result, stage, err = validateCommandModel(model, request, now, location)
			invalid = err != nil && !errors.Is(err, errInvalidSelection)
		}
		if err == nil {
			break
		}
		if errors.Is(err, errInvalidSelection) {
			cmdErr = err
			writeError(w, http.StatusBadRequest, request.CommandID, "invalid_request", err.Error(), false)
			return
		}
		if !invalid {
			// Rate limits, outages and timeouts never cause a second provider repair call.
			cmdErr = err
			writeProviderError(w, request.CommandID, "command", err)
			return
		}
		// These reasons come only from fixed server validation messages. Never log
		// the model response, transcript, contact values or provider response body.
		feedback = stage + ": " + err.Error()
		log.Printf("command output rejected: command_id=%s stage=%s reason=%s attempt=%d", request.CommandID, stage, err.Error(), attempt+1)
		if ctx.Err() != nil {
			cmdErr = errProviderTimeout
			writeProviderError(w, request.CommandID, "command", errProviderTimeout)
			return
		}
		if attempt == 0 {
			continue
		}
		cmdErr = errInvalidProviderOutput
		writeProviderError(w, request.CommandID, "command", errInvalidProviderOutput)
		return
	}
	if model.Lookup != nil {
		model.Lookup.ReplyLanguage = language
		a.answerLookup(w, r, request, *model.Lookup)
		return
	}
	if len(result.Actions) == 1 && result.Actions[0].Type == "reply" {
		resp := commandResponse{CommandID: request.CommandID, interpretation: interpretation{Actions: []action{}}, Reply: result.Actions[0].Text, ReplyLanguage: language}
		cmdOutput = resp
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if language == "hi" && result.Clarification != nil {
		question := hindiQuestion(*result.Clarification)
		result.Clarification = &question
	}
	resp := commandResponse{CommandID: request.CommandID, interpretation: result, ReplyLanguage: language}
	cmdOutput = resp
	writeJSON(w, http.StatusOK, resp)
}

// Every generation attempt passes the same validation before lookup execution
// or a proposed write reaches the browser. Stage names are safe diagnostics.
func validateCommandModel(model modelInterpretation, request commandRequest, now time.Time, location *time.Location) (interpretation, string, error) {
	result := interpretation{Actions: model.Actions, Clarification: model.Clarification}
	if model.Lookup != nil {
		if len(model.Actions) != 0 || model.Clarification != nil || (model.RecipientName != nil && *model.RecipientName != "") ||
			request.SelectedContactID != nil || request.SelectedReminderID != nil || request.SelectedDraftID != nil {
			return result, "lookup_action_boundary", errInvalidProviderOutput
		}
		return result, "lookup_fields", validateLookup(*model.Lookup)
	}
	if err := validateInterpretation(&result, now, location); err != nil {
		return result, "action_fields", err
	}
	if err := validateCalendarCommand(&result, request.Transcript); err != nil {
		return result, "calendar_intent", err
	}
	var err error
	result, err = resolveCorrection(result, request, location)
	if err != nil {
		return result, "reminder_correction", err
	}
	result, err = resolveDraftAction(result, request)
	if err != nil {
		return result, "draft_resolution", err
	}
	result, err = resolveContact(result, model.RecipientName, request)
	if err != nil {
		return result, "contact_resolution", err
	}
	if len(result.Actions) > 0 {
		if request.SelectedReminderID != nil && result.Actions[0].Type != "reschedule_reminder" && result.Actions[0].Type != "delete_reminder" {
			return result, "selected_item_action", errInvalidProviderOutput
		}
		if request.SelectedDraftID != nil && result.Actions[0].Type != "update_draft" && result.Actions[0].Type != "delete_draft" {
			return result, "selected_item_action", errInvalidProviderOutput
		}
	}
	if err := validateCommandCompleteness(result, request.Transcript); err != nil {
		return result, "command_completeness", err
	}
	return result, "", nil
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
		if stage == "command" || stage == "minutes" {
			message = "Groq reached a request or token limit. Your transcript is still available to retry."
		}
		w.Header().Set("Retry-After", strconv.Itoa(providerRetryAfter(err)))
	} else if errors.Is(err, errInvalidProviderOutput) {
		code = stage + "_provider_invalid_response"
		message = "Morning received an invalid response. Please try again."
		if stage == "command" {
			// This is an application validation failure, not a broken gateway.
			// A 422 preserves our JSON message through Cloudflare's 502 pages.
			status = http.StatusUnprocessableEntity
			message = "Morning couldn't interpret that reliably. Please rephrase or retry."
		}
	} else if errors.Is(err, errProviderTimeout) {
		status = http.StatusGatewayTimeout
		code = stage + "_provider_timeout"
		message = "Morning's provider took too long to respond. Please try again."
	}
	writeError(w, status, id, code, message, true)
}
