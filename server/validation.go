package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

func decodeObject(body []byte, dst any) error {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' || !utf8.Valid(body) {
		return errors.New("expected a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("expected only one JSON object")
	}
	return nil
}

func validCommandID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func validateRequest(request commandRequest) (time.Time, *time.Location, error) {
	if !validCommandID(request.CommandID) {
		return time.Time{}, nil, errors.New("command_id must contain 1 to 128 letters, digits, hyphens or underscores.")
	}
	if strings.TrimSpace(request.Transcript) == "" || len(request.Transcript) > 8192 {
		return time.Time{}, nil, errors.New("transcript must contain 1 to 8192 bytes of text.")
	}
	if request.LookupContext != nil {
		pending := request.LookupContext
		if validateLookup(pending.Query) != nil || (pending.Query.Kind != "hotels" && pending.Query.Kind != "weather" && pending.Query.Kind != "time") ||
			(pending.ReplyLanguage != "" && pending.ReplyLanguage != "en" && pending.ReplyLanguage != "hi") ||
			(pending.City != "" && !validText(pending.City, 100)) || len(request.Contacts) > 0 || request.SelectedContactID != nil ||
			request.ReminderContext != nil || request.SelectedReminderID != nil || request.DraftContext != nil || request.SelectedDraftID != nil {
			return time.Time{}, nil, errors.New("lookup_context must contain only a pending place lookup, without action context.")
		}
	}
	now, err := time.Parse(time.RFC3339Nano, request.Now)
	if err != nil {
		return time.Time{}, nil, errors.New("now must be an RFC 3339 timestamp with a timezone offset or Z.")
	}
	if request.Timezone == "" || request.Timezone == "Local" || len(request.Timezone) > 100 {
		return time.Time{}, nil, errors.New("timezone must be an IANA timezone such as Asia/Kolkata.")
	}
	location, err := time.LoadLocation(request.Timezone)
	if err != nil {
		return time.Time{}, nil, errors.New("timezone must be an IANA timezone such as Asia/Kolkata.")
	}
	if err := validateContacts(request); err != nil {
		return time.Time{}, nil, err
	}
	if reminder := request.ReminderContext; reminder != nil {
		if !validCommandID(reminder.ID) || reminder.ID == request.CommandID || reminder.DueAt.IsZero() {
			return time.Time{}, nil, errors.New("reminder_context requires a saved reminder ID distinct from command_id and its RFC 3339 due_at.")
		}
	}
	if selected := request.SelectedReminderID; selected != nil {
		if !validCommandID(*selected) || request.ReminderContext == nil || *selected != request.ReminderContext.ID {
			return time.Time{}, nil, errors.New("selected_reminder_id must match reminder_context.id.")
		}
	}
	if draft := request.DraftContext; draft != nil {
		id := strings.TrimPrefix(draft.ID, "draft:")
		if !validCommandID(id) || id == request.CommandID || !validText(draft.Subject, 200) || !validDraftBody(draft.Body) || !validText(draft.Recipient, 254) || !validText(draft.To, 254) {
			return time.Time{}, nil, errors.New("draft_context requires an existing draft ID, recipient, subject and message.")
		}
	}
	if selected := request.SelectedDraftID; selected != nil && (request.DraftContext == nil || *selected != request.DraftContext.ID) {
		return time.Time{}, nil, errors.New("selected_draft_id must match draft_context.id.")
	}
	return now.In(location), location, nil
}

func validText(value string, maxLength int) bool {
	if value == "" || value != strings.TrimSpace(value) || utf8.RuneCountInString(value) > maxLength {
		return false
	}
	for _, c := range value {
		if unicode.IsControl(c) {
			return false
		}
	}
	return true
}

const offsetTimestamp = "2006-01-02T15:04:05.999999999-07:00"

func parseZonedInstant(value string, location *time.Location) (time.Time, error) {
	instant, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, err
	}
	local := instant.In(location)
	_, suppliedOffset := instant.Zone()
	_, expectedOffset := local.Zone()
	if suppliedOffset != expectedOffset {
		return time.Time{}, fmt.Errorf("timestamp offset does not match %s", location)
	}
	return local, nil
}

func validateInterpretation(result *interpretation, now time.Time, location *time.Location) error {
	if result.Actions == nil || len(result.Actions) > 2 {
		return errors.New("expected zero, one or two actions")
	}
	if len(result.Actions) == 0 {
		if result.Clarification == nil || !validText(*result.Clarification, 500) {
			return errors.New("an empty action list requires a clarification")
		}
		return nil
	}
	if result.Clarification != nil {
		return errors.New("a clarification cannot accompany an action")
	}
	seen := make(map[string]bool)
	for i := range result.Actions {
		action := &result.Actions[i]
		if seen[action.Type] {
			return errors.New("at most one action of each type is supported")
		}
		seen[action.Type] = true
		if action.Type != "reply" && action.Text != "" {
			return errors.New("reply text cannot accompany a saved action")
		}
		switch action.Type {
		case "reply":
			if len(result.Actions) != 1 || !validText(action.Text, maxSpeechChars) || action.Title != "" || action.DueAt != "" || action.ReminderID != "" || action.ToContactID != "" || action.Subject != "" || action.Body != "" || action.Start != "" || action.End != "" || action.StartPhrase != "" || action.EndPhrase != "" || action.Timezone != "" {
				return errors.New("a conversational reply must stand alone without saved actions")
			}
		case "create_reminder", "reschedule_reminder":
			if action.ToContactID != "" || action.Subject != "" || action.Body != "" {
				return errors.New("invalid reminder fields")
			}
			if action.Type == "reschedule_reminder" {
				if len(result.Actions) != 1 || action.Title != "" {
					return errors.New("a correction can only change one reminder time")
				}
			} else if !validText(action.Title, 200) {
				return errors.New("invalid reminder title")
			}
			due, err := parseZonedInstant(action.DueAt, location)
			if err != nil || !due.After(now) {
				return errors.New("due_at must be a future RFC 3339 timestamp")
			}
			// Numeric offsets are explicit even for UTC, returned as +00:00.
			action.DueAt = due.Format(offsetTimestamp)
		case "create_calendar_event":
			if len(result.Actions) != 1 || !validText(action.Title, 200) {
				return errors.New("expected one titled calendar event")
			}
			start, err := parseZonedInstant(action.Start, location)
			if err != nil || !start.After(now) || start.Nanosecond() != 0 {
				return errors.New("invalid calendar start")
			}
			// Resolve a spoken duration in elapsed time, including across an offset change.
			var end time.Time
			if duration, parseErr := time.ParseDuration(action.End); parseErr == nil {
				end = start.Add(duration)
			} else {
				end, err = parseZonedInstant(action.End, location)
			}
			if err != nil || !end.After(start) || end.Nanosecond() != 0 || end.Year() > 9999 {
				return errors.New("invalid calendar end")
			}
			action.Start, action.End = start.Format(offsetTimestamp), end.Format(offsetTimestamp)
			action.Timezone = location.String()
		case "draft_email":
			if !validCommandID(action.ToContactID) || !validText(action.Subject, 200) || !validDraftBody(action.Body) || action.Title != "" || action.DueAt != "" {
				return errors.New("invalid draft fields")
			}
		case "update_draft":
			if len(result.Actions) != 1 || !validText(action.Subject, 200) || !validDraftBody(action.Body) || action.ToContactID != "" || action.Title != "" || action.DueAt != "" || action.DraftID != "" || action.ReminderID != "" {
				return errors.New("a draft update can only replace the existing subject and message")
			}
		default:
			return errors.New("unsupported action")
		}
	}
	return nil
}

func validDraftBody(body string) bool {
	if body == "" || body != strings.TrimSpace(body) || utf8.RuneCountInString(body) > 8000 {
		return false
	}
	for _, c := range body {
		if unicode.IsControl(c) && c != '\n' && c != '\r' && c != '\t' {
			return false
		}
	}
	return true
}

var (
	draftThenReminder = regexp.MustCompile(`(?is)^\s*(?:please\s+)?(?:draft|write|compose)\b.*\be-?mail\b.*\band\s+(?:also\s+)?(?:please\s+)?remind\s+me\b`)
	reminderThenDraft = regexp.MustCompile(`(?is)^\s*(?:please\s+)?remind\s+me\b.*\band\s+(?:also\s+)?(?:please\s+)?(?:draft|write|compose)\b.*\be-?mail\b`)
	scheduleLead      = regexp.MustCompile(spokenPrefix + `(?:schedule|book)\b`)
	reminderLead      = regexp.MustCompile(spokenPrefix + `(?:remind\s+me|(?:set|create|schedule)\s+(?:me\s+)?(?:(?:a|an|my)\s+)?(?:reminder|alert))\b`)
	hindiCompound     = regexp.MustCompile(`(?is)(?:(?:ईमेल|इमेल|e-?mail).*?(?:और|\baur\b).*?(?:याद\s+दिला|yaad\s+dila)|(?:याद\s+दिला|yaad\s+dila).*?(?:और|\baur\b).*?(?:ईमेल|इमेल|e-?mail))`)
)

// Check calendar intent before reminder and contact resolution can turn a misclassified
// event into a question about an unrelated record.
func validateCalendarCommand(result *interpretation, transcript string) error {
	if len(result.Actions) == 0 {
		return nil
	}
	isEvent := result.Actions[0].Type == "create_calendar_event"
	wantsReminder := reminderLead.MatchString(transcript) || hindiReminder.MatchString(unquotedCommand(transcript))
	if isEvent && (wantsReminder || newCommandLead.MatchString(transcript)) {
		return errors.New("a reminder or draft request cannot create a calendar event")
	}
	if scheduleLead.MatchString(transcript) && !wantsReminder && !isEvent {
		return errors.New("a scheduling request requires a calendar event")
	}
	if !isEvent {
		return nil
	}
	event := &result.Actions[0]
	var question string
	before, after, foundStart := strings.Cut(transcript, event.StartPhrase)
	if !validText(event.StartPhrase, 200) || !foundStart {
		question = "When should the event start?"
	} else if !validText(event.EndPhrase, 200) || !(strings.Contains(before, event.EndPhrase) || strings.Contains(after, event.EndPhrase)) {
		question = "How long should the event last?"
	}
	event.StartPhrase, event.EndPhrase = "", ""
	if question != "" {
		*result = interpretation{Actions: []action{}, Clarification: &question}
	}
	return nil
}

// Check explicit coordinated requests against the transcript, independently of
// the provider's actions or recipient evidence. Clarifications remain blocked.
func validateCommandCompleteness(result interpretation, transcript string) error {
	if len(result.Actions) == 0 {
		return nil
	}
	command := unquotedCommand(transcript)
	if !draftThenReminder.MatchString(command) && !reminderThenDraft.MatchString(command) && !hindiCompound.MatchString(command) {
		return nil
	}
	var draft, reminder bool
	for _, action := range result.Actions {
		draft = draft || action.Type == "draft_email"
		reminder = reminder || action.Type == "create_reminder"
	}
	if !draft || !reminder {
		return errors.New("a draft and reminder command requires both actions")
	}
	return nil
}

// Quoted email content can mention another action without requesting it.
func unquotedCommand(transcript string) string {
	var command strings.Builder
	quoted := false
	for _, c := range transcript {
		switch c {
		case '"', '“', '”':
			quoted = !quoted
			command.WriteByte(' ')
		default:
			if !quoted {
				command.WriteRune(c)
			}
		}
	}
	return command.String()
}
