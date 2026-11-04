package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	lookupTimeout   = 16 * time.Second
	lookupResultCap = 3
)

// Groq may propose only these arguments. It never supplies facts, URLs, a clock,
// coordinates or tool names. Keep lookups separate from write actions.
type lookupQuery struct {
	Kind          string `json:"kind"`
	Terms         string `json:"terms"`
	Place         string `json:"place"`
	Today         bool   `json:"today"`
	ReplyLanguage string `json:"-"` // Go-owned; never a search argument.
}

type lookupSource struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	Publisher   string `json:"publisher"`
	Excerpt     string `json:"excerpt,omitempty"`
	PublishedAt string `json:"published_at,omitempty"`
}

// This snapshot belongs to the command's conversation. Display and speech replay
// use it directly; neither operation calls a provider again.
type lookupResult struct {
	Kind        string         `json:"kind"`
	Query       string         `json:"query"`
	Status      string         `json:"status"` // answered or empty
	Answer      string         `json:"answer"`
	Speech      string         `json:"speech"`
	Sources     []lookupSource `json:"sources"`
	LookedUpAt  string         `json:"looked_up_at"`
	Timezone    string         `json:"timezone,omitempty"`
	DataTime    string         `json:"data_time,omitempty"`
	WindowStart string         `json:"window_start,omitempty"`
	WindowEnd   string         `json:"window_end,omitempty"`
}

type lookupOutcome struct {
	ResolvedPlace string         `json:"-"` // Validated city/region/country for briefing news.
	Result        *lookupResult  `json:"lookup,omitempty"`
	Question      string         `json:"clarification,omitempty"`
	Pending       *lookupContext `json:"lookup_context,omitempty"`
}

type lookupContext struct {
	Query lookupQuery `json:"query"`
	// Only an ambiguous city needs a region/country appended to the reply.
	City          string `json:"city,omitempty"`
	ReplyLanguage string `json:"reply_language,omitempty"`
}

type lookupError struct {
	Code       string
	Message    string
	RetryAfter int
	Retryable  bool
}

func (e *lookupError) Error() string { return e.Code }

type lookupService struct {
	client        http.Client
	tavilyKey     string
	groq          *providers
	clock         func() time.Time
	searchLimiter *rateLimiter
	placeLimiter  *rateLimiter
	placeReplies  *rateLimiter
}

func newLookupService(p *providers, clock func() time.Time) *lookupService {
	client := http.Client{
		Transport: p.client.Transport,
		Timeout:   lookupTimeout,
		// A redirect must never receive a key, query or location.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &lookupService{
		client: client, tavilyKey: strings.TrimSpace(os.Getenv("TAVILY_API_KEY")),
		groq: &providers{client: &client, groqKey: p.groqKey}, clock: clock,
		searchLimiter: newRateLimiter(4, 40), placeLimiter: newRateLimiter(4, 40),
		placeReplies: newRateLimiter(4, 40),
	}
}

func normalizeModelLookup(q *lookupQuery) {
	q.Terms = strings.TrimSpace(q.Terms)
	q.Place = strings.TrimSpace(q.Place)
	switch q.Kind {
	case "hotels":
		q.Terms = ""
		q.Today = false
	case "news":
		if q.Terms == "" && q.Place != "" {
			q.Terms = "latest news"
		}
	case "wiki":
		if q.Terms == "" && q.Place != "" {
			q.Terms = q.Place
			q.Place = ""
		}
		q.Today = false
	case "briefing":
		q.Terms = ""
		q.Today = true
	case "web":
		if q.Terms == "" && q.Place != "" {
			q.Terms = q.Place
			q.Place = ""
		}
		if q.Today {
			q.Today = false
			if !strings.Contains(strings.ToLower(q.Terms), "today") && validText(q.Terms+" today", 300) {
				q.Terms += " today"
			}
		}
	}
}

func validateLookup(q lookupQuery) error {
	switch q.Kind {
	case "hotels", "weather", "news", "web", "time", "wiki", "briefing":
	default:
		return errors.New("unsupported lookup kind")
	}
	if q.Terms != "" && !validText(q.Terms, 300) || q.Place != "" && !validText(q.Place, 120) {
		return errors.New("invalid lookup terms or place")
	}
	if (q.Kind == "web" || q.Kind == "news" || q.Kind == "wiki") && q.Terms == "" {
		return errors.New("search terms are required")
	}
	if q.Today && q.Kind != "news" && q.Kind != "briefing" || (q.Kind == "weather" || q.Kind == "time" || q.Kind == "hotels" || q.Kind == "briefing") && q.Terms != "" || (q.Kind == "wiki" && q.Place != "") {
		return errors.New("irrelevant lookup arguments")
	}
	if q.Kind == "briefing" && !q.Today {
		return errors.New("a briefing requires today=true")
	}
	return nil
}

// A spoken answer to a place question completes this lookup, not a new command.
// The browser carries Pending only while that question is active in this session.
func withLookupPlace(pending lookupContext, spokenPlace string) (lookupQuery, error) {
	if err := validateLookup(pending.Query); err != nil {
		return lookupQuery{}, err
	}
	spokenPlace = strings.TrimSpace(spokenPlace)
	if !validText(spokenPlace, 120) {
		return lookupQuery{}, errors.New("say a city or landmark")
	}
	if pending.City != "" {
		if !validText(pending.City, 100) {
			return lookupQuery{}, errors.New("invalid pending city")
		}
		if !strings.Contains(strings.ToLower(spokenPlace), strings.ToLower(pending.City)) {
			spokenPlace = pending.City + ", " + spokenPlace
		}
	}
	pending.Query.Place = spokenPlace
	pending.Query.ReplyLanguage = pending.ReplyLanguage
	if err := validateLookup(pending.Query); err != nil {
		return lookupQuery{}, err
	}
	return pending.Query, nil
}

func (s *lookupService) lookup(ctx context.Context, q lookupQuery, visitor, timezone string) (lookupOutcome, error) {
	if err := validateLookup(q); err != nil {
		return lookupOutcome{}, err
	}
	location, err := time.LoadLocation(timezone)
	if err != nil || timezone == "" || timezone == "Local" {
		return lookupOutcome{}, errors.New("a valid IANA timezone is required")
	}
	if missingLookupPlace(q.Place) {
		if q.Kind == "briefing" {
			return lookupQuestion(q, "Which city?"), nil
		}
		if q.Kind == "hotels" || q.Kind == "weather" || q.Kind == "time" {
			return lookupQuestion(q, "Which city or landmark?"), nil
		}
	}
	now := s.clock()
	limiter := s.searchLimiter
	if q.Kind == "weather" || q.Kind == "time" {
		limiter = s.placeLimiter
	}
	if retry := limiter.allow(visitor, now); retry > 0 {
		return lookupOutcome{}, &lookupError{"lookup_rate_limited", "Too many lookups. Please wait before retrying.", retry, true}
	}
	ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	var outcome lookupOutcome
	if q.Kind == "briefing" {
		outcome, err = s.lookupBriefing(ctx, q, now)
	} else if q.Kind == "weather" || q.Kind == "time" {
		outcome, err = s.placeLookup(ctx, q, now)
	} else if q.Kind == "wiki" {
		outcome, err = s.wikiLookup(ctx, q, now)
	} else {
		outcome, err = s.searchLookup(ctx, q, now, location)
	}
	if err != nil {
		return lookupOutcome{}, publicLookupError(err)
	}
	if outcome.Result != nil {
		outcome.Result.LookedUpAt = s.clock().UTC().Format(time.RFC3339)
		if q.ReplyLanguage == "hi" {
			outcome.Result.Speech = hindiLookupMessage(outcome.Result.Speech)
		}
	}
	return outcome, nil
}

func lookupQuestion(q lookupQuery, question string) lookupOutcome {
	if q.ReplyLanguage == "hi" {
		question = hindiQuestion(question)
	}
	return lookupOutcome{Question: question, Pending: &lookupContext{Query: q, ReplyLanguage: q.ReplyLanguage}}
}

func missingLookupPlace(place string) bool {
	switch strings.ToLower(strings.Trim(strings.TrimSpace(place), ".?!")) {
	case "", "near me", "me", "here", "my location", "nearby", "current location", "मेरे पास", "आसपास", "मेरी लोकेशन", "mere paas", "aas paas":
		return true
	}
	return false
}

func publicLookupError(err error) error {
	var failure *lookupError
	if errors.As(err, &failure) {
		return failure
	}
	if errors.Is(err, errProviderTimeout) {
		return &lookupError{"lookup_timeout", "The lookup took too long. Your words are still available to retry.", 0, true}
	}
	if errors.Is(err, errProviderRateLimited) {
		return &lookupError{"lookup_quota_limited", "Groq reached a request or token limit. Your transcript is still available to retry.", providerRetryAfter(err), true}
	}
	if errors.Is(err, errInvalidProviderOutput) {
		return &lookupError{"lookup_invalid_response", "The provider returned information Morning couldn't verify. Please retry.", 0, true}
	}
	return &lookupError{"lookup_unavailable", "The lookup is unavailable right now. Please retry.", 0, true}
}

func (a *api) answerLookup(w http.ResponseWriter, r *http.Request, request commandRequest, query lookupQuery) {
	var outcome lookupOutcome
	var err error
	if request.LookupContext != nil {
		query, err = a.lookups.spokenLookupPlace(r.Context(), *request.LookupContext, request.Transcript, clientAddress(r))
	}
	if err == nil {
		outcome, err = a.lookups.lookup(r.Context(), query, clientAddress(r), request.Timezone)
	}
	if err != nil {
		failure, ok := publicLookupError(err).(*lookupError)
		if !ok {
			writeProviderError(w, request.CommandID, "command", errInvalidProviderOutput)
			return
		}
		status := http.StatusBadGateway
		switch failure.Code {
		case "lookup_timeout":
			status = http.StatusGatewayTimeout
		case "lookup_rate_limited", "lookup_quota_limited":
			status = http.StatusTooManyRequests
		case "search_not_configured", "lookup_access_denied":
			status = http.StatusServiceUnavailable
		}
		if failure.RetryAfter > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(failure.RetryAfter))
		}
		writeError(w, status, request.CommandID, failure.Code, failure.Message, failure.Retryable)
		return
	}
	response := commandResponse{CommandID: request.CommandID, interpretation: interpretation{Actions: []action{}}, Lookup: outcome.Result, LookupContext: outcome.Pending, ReplyLanguage: query.ReplyLanguage}
	if outcome.Question != "" {
		response.Clarification = &outcome.Question
	}
	writeJSON(w, http.StatusOK, response)
}

func emptyLookup(q lookupQuery, query, answer string) lookupOutcome {
	if q.ReplyLanguage == "hi" {
		answer = hindiLookupMessage(answer)
	}
	return lookupOutcome{Result: &lookupResult{Kind: q.Kind, Query: query, Status: "empty", Answer: answer, Speech: answer, Sources: []lookupSource{}}}
}

// This validator is also required at the browser boundary. Never fetch returned
// links on the server, render HTML/Markdown snippets, or use them as commands.
func safeLookupURL(raw string) (string, bool) {
	if len(raw) > 2048 || strings.ContainsAny(raw, "\\\r\n\t") {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return "", false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || !strings.Contains(host, ".") && net.ParseIP(host) == nil {
		return "", false
	}
	// Sources use public hostnames. Reject IP literals rather than maintaining
	// two subtly different private-address parsers in Go and the browser.
	if net.ParseIP(host) != nil {
		return "", false
	}
	u.Fragment = ""
	return u.String(), true
}

func lookupText(raw string, limit int) string {
	text := strings.Join(strings.FieldsFunc(raw, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	runes := []rune(text)
	if len(runes) > limit {
		text = string(runes[:limit])
	}
	return strings.TrimSpace(text)
}

func lookupSentence(text string) string {
	if validText(text, maxSpeechChars) && !strings.ContainsAny(text, "\u2028\u2029") {
		return text
	}
	return "The results and their sources are ready to open."
}

func sourcePublisher(raw string) string {
	u, _ := url.Parse(raw)
	return strings.TrimPrefix(u.Hostname(), "www.")
}

func lookupDisplayQuery(q lookupQuery) string {
	if q.Kind == "hotels" {
		return "Hotels near " + q.Place
	}
	if q.Kind == "wiki" {
		return "Wikipedia: " + q.Terms
	}
	if q.Kind == "briefing" {
		if q.Place != "" {
			return "Morning briefing for " + q.Place
		}
		return "Daily Morning Briefing"
	}
	return strings.TrimSpace(fmt.Sprintf("%s %s", q.Terms, q.Place))
}
