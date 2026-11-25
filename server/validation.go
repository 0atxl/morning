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

const maxReplyChars = 500

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
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == ':') {
			return false
		}
	}
	return true
}

func validRepeat(value string) bool {
	return value == "" || value == "daily" || value == "weekly" || value == "weekdays"
}

func allReminders(request commandRequest) []reminderContextItem {
	seen := make(map[string]bool)
	var out []reminderContextItem
	if r := request.ReminderContext; r != nil {
		seen[r.ID] = true
		out = append(out, reminderContextItem{ID: r.ID, Title: r.Title, DueAt: r.DueAt, Repeat: r.Repeat})
	}
	for _, r := range request.RemindersContext {
		if !seen[r.ID] {
			seen[r.ID] = true
			out = append(out, r)
		}
	}
	return out
}

func allDrafts(request commandRequest) []draftContext {
	seen := make(map[string]bool)
	var out []draftContext
	if d := request.DraftContext; d != nil {
		seen[d.ID] = true
		out = append(out, *d)
	}
	for _, d := range request.DraftsContext {
		if !seen[d.ID] {
			seen[d.ID] = true
			out = append(out, d)
		}
	}
	return out
}

func validateRequest(request commandRequest) (time.Time, *time.Location, error) {
	if !validCommandID(request.CommandID) || strings.Contains(request.CommandID, ":") {
		return time.Time{}, nil, errors.New("command_id must contain 1 to 128 letters, digits, hyphens or underscores.")
	}
	if strings.TrimSpace(request.Transcript) == "" || len(request.Transcript) > 8192 {
		return time.Time{}, nil, errors.New("transcript must contain 1 to 8192 bytes of text.")
	}
	if request.LookupContext != nil {
		pending := request.LookupContext
		if validateLookup(pending.Query) != nil || (pending.Query.Kind != "hotels" && pending.Query.Kind != "weather" && pending.Query.Kind != "time" && pending.Query.Kind != "briefing") ||
			(pending.ReplyLanguage != "" && pending.ReplyLanguage != "en" && pending.ReplyLanguage != "hi") ||
			(pending.City != "" && !validText(pending.City, 100)) || len(request.Contacts) > 0 || request.SelectedContactID != nil ||
			request.ReminderContext != nil || len(request.RemindersContext) > 0 || request.SelectedReminderID != nil ||
			request.DraftContext != nil || len(request.DraftsContext) > 0 || request.SelectedDraftID != nil ||
			request.PreviousTurn != nil || len(request.RecentTurns) > 0 {
			return time.Time{}, nil, errors.New("lookup_context must contain only a pending place lookup, without action context.")
		}
	}
	if pt := request.PreviousTurn; pt != nil {
		if len(pt.Transcript) > 8192 || !utf8.ValidString(pt.Transcript) ||
			len(pt.Topic) > 300 || !utf8.ValidString(pt.Topic) ||
			len(pt.Answer) > 4000 || !utf8.ValidString(pt.Answer) ||
			len(pt.Reply) > 1000 || !utf8.ValidString(pt.Reply) {
			return time.Time{}, nil, errors.New("previous_turn fields exceed permitted length or contain invalid text.")
		}
	}
	if len(request.RecentTurns) > 10 {
		return time.Time{}, nil, errors.New("recent_turns must contain at most 10 turns.")
	}
	for _, turn := range request.RecentTurns {
		if len(turn.Transcript) > 8192 || !utf8.ValidString(turn.Transcript) ||
			len(turn.Topic) > 300 || !utf8.ValidString(turn.Topic) ||
			len(turn.Answer) > 4000 || !utf8.ValidString(turn.Answer) ||
			len(turn.Reply) > 1000 || !utf8.ValidString(turn.Reply) ||
			len(turn.Kind) > 40 || !utf8.ValidString(turn.Kind) {
			return time.Time{}, nil, errors.New("recent_turns fields exceed permitted length or contain invalid text.")
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
		if !validCommandID(reminder.ID) || reminder.ID == request.CommandID || reminder.DueAt.IsZero() || !validRepeat(reminder.Repeat) || (reminder.Title != "" && !validText(strings.TrimSpace(reminder.Title), 200)) {
			return time.Time{}, nil, errors.New("reminder_context requires a saved reminder ID distinct from command_id and its RFC 3339 due_at.")
		}
	}
	if len(request.RemindersContext) > 10 {
		return time.Time{}, nil, errors.New("reminders_context must contain at most 10 reminders.")
	}
	remIDs := make(map[string]bool)
	if request.ReminderContext != nil {
		remIDs[request.ReminderContext.ID] = true
	}
	for _, rem := range request.RemindersContext {
		if !validCommandID(rem.ID) || rem.ID == request.CommandID || rem.DueAt.IsZero() || !validRepeat(rem.Repeat) || (rem.Title != "" && !validText(strings.TrimSpace(rem.Title), 200)) {
			return time.Time{}, nil, errors.New("reminders_context requires valid saved reminder IDs and RFC 3339 due_at values.")
		}
		remIDs[rem.ID] = true
	}
	if selected := request.SelectedReminderID; selected != nil {
		if !validCommandID(*selected) || !remIDs[*selected] {
			return time.Time{}, nil, errors.New("selected_reminder_id must match a supplied reminder.")
		}
	}
	validateDraftItem := func(draft draftContext) bool {
		id := strings.TrimPrefix(draft.ID, "draft:")
		return validCommandID(id) && id != request.CommandID &&
			validText(strings.TrimSpace(draft.Subject), 200) &&
			validDraftBody(strings.TrimSpace(draft.Body)) &&
			validText(strings.TrimSpace(draft.Recipient), 254) &&
			validText(strings.TrimSpace(draft.To), 254)
	}
	draftIDs := make(map[string]bool)
	if draft := request.DraftContext; draft != nil {
		if !validateDraftItem(*draft) {
			return time.Time{}, nil, errors.New("draft_context requires an existing draft ID, recipient, subject and message.")
		}
		draftIDs[draft.ID] = true
	}
	if len(request.DraftsContext) > 10 {
		return time.Time{}, nil, errors.New("drafts_context must contain at most 10 drafts.")
	}
	for _, draft := range request.DraftsContext {
		if !validateDraftItem(draft) {
			return time.Time{}, nil, errors.New("drafts_context requires valid existing draft IDs, recipients, subjects and messages.")
		}
		draftIDs[draft.ID] = true
	}
	if selected := request.SelectedDraftID; selected != nil && !draftIDs[*selected] {
		return time.Time{}, nil, errors.New("selected_draft_id must match a supplied draft.")
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
	instant, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
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

func collapseSingleLine(value string) string {
	// Convert newlines/tabs into single spaces while preserving control-char
	// rejection for non-whitespace control runes (like \x00).
	var b strings.Builder
	prevSpace := false
	for _, c := range strings.TrimSpace(value) {
		if c == '\n' || c == '\r' || c == '\t' || c == ' ' {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(c)
		prevSpace = false
	}
	return b.String()
}

func validateInterpretation(result *interpretation, now time.Time, location *time.Location) error {
	if result.Actions == nil || len(result.Actions) > 4 {
		return errors.New("expected zero to four actions")
	}
	if result.Clarification != nil {
		trimmed := collapseSingleLine(*result.Clarification)
		if trimmed == "" {
			result.Clarification = nil
		} else {
			result.Clarification = &trimmed
		}
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
	draftCount := 0
	seenReminders := make(map[string]bool)
	for i := range result.Actions {
		act := &result.Actions[i]
		// Trim whitespace before validating so trailing spaces/newlines from
		// LLMs never cause spurious 422 rejections.
		act.Text = collapseSingleLine(act.Text)
		act.Title = strings.TrimSpace(act.Title)
		act.DueAt = strings.TrimSpace(act.DueAt)
		act.Start = strings.TrimSpace(act.Start)
		act.End = strings.TrimSpace(act.End)
		act.Repeat = strings.TrimSpace(act.Repeat)
		act.ReminderID = strings.TrimSpace(act.ReminderID)
		act.DraftID = strings.TrimSpace(act.DraftID)
		act.ToContactID = strings.TrimSpace(act.ToContactID)
		act.Subject = strings.TrimSpace(act.Subject)
		act.Body = strings.TrimSpace(act.Body)
		act.StartPhrase = strings.TrimSpace(act.StartPhrase)
		act.EndPhrase = strings.TrimSpace(act.EndPhrase)

		if act.Repeat != "" && act.Type != "create_reminder" && act.Type != "reschedule_reminder" {
			return errors.New("repeat belongs only to reminder actions")
		}
		if act.Type != "reply" && act.Text != "" {
			return errors.New("reply text cannot accompany a saved action")
		}
		switch act.Type {
		case "reply":
			if len(result.Actions) != 1 || !validText(act.Text, maxReplyChars) || act.Title != "" || act.DueAt != "" || act.ReminderID != "" || act.DraftID != "" || act.ToContactID != "" || act.Subject != "" || act.Body != "" || act.Start != "" || act.End != "" || act.StartPhrase != "" || act.EndPhrase != "" || act.Timezone != "" {
				return errors.New("a conversational reply must stand alone without saved actions")
			}
		case "create_reminder":
			if act.ToContactID != "" || act.Subject != "" || act.Body != "" || act.ReminderID != "" || act.DraftID != "" {
				return errors.New("invalid reminder fields")
			}
			if !validRepeat(act.Repeat) {
				return errors.New("invalid repeat recurrence")
			}
			if !validText(act.Title, 200) {
				return errors.New("invalid reminder title")
			}
			due, err := parseZonedInstant(act.DueAt, location)
			if err != nil || !due.After(now) {
				return errors.New("due_at must be a future RFC 3339 timestamp")
			}
			act.DueAt = due.Format(offsetTimestamp)
			remKey := strings.ToLower(act.Title) + "|" + act.DueAt
			if seenReminders[remKey] {
				return errors.New("duplicate reminder in the same command")
			}
			seenReminders[remKey] = true
		case "reschedule_reminder":
			if len(result.Actions) != 1 || act.ToContactID != "" || act.Subject != "" || act.Body != "" || act.DraftID != "" {
				return errors.New("a reminder update must stand alone with valid reminder fields")
			}
			if !validRepeat(act.Repeat) {
				return errors.New("invalid repeat recurrence")
			}
			if act.Title != "" && !validText(act.Title, 200) {
				return errors.New("invalid reminder title")
			}
			if act.DueAt != "" {
				due, err := parseZonedInstant(act.DueAt, location)
				if err != nil || !due.After(now) {
					return errors.New("due_at must be a future RFC 3339 timestamp")
				}
				act.DueAt = due.Format(offsetTimestamp)
			}
			if act.DueAt == "" && act.Title == "" && act.Repeat == "" {
				return errors.New("a reminder update requires a new due_at, title, or repeat")
			}
		case "delete_reminder":
			if act.Title != "" || act.DueAt != "" || act.Repeat != "" || act.ToContactID != "" || act.Subject != "" || act.Body != "" || act.DraftID != "" {
				return errors.New("invalid delete_reminder fields")
			}
		case "create_calendar_event":
			if len(result.Actions) != 1 || !validText(act.Title, 200) {
				return errors.New("expected one titled calendar event")
			}
			start, err := parseZonedInstant(act.Start, location)
			if err != nil || !start.After(now) || start.Nanosecond() != 0 {
				return errors.New("invalid calendar start")
			}
			var end time.Time
			if duration, parseErr := time.ParseDuration(act.End); parseErr == nil {
				end = start.Add(duration)
			} else {
				end, err = parseZonedInstant(act.End, location)
			}
			if err != nil || !end.After(start) || end.Nanosecond() != 0 || end.Year() > 9999 {
				return errors.New("invalid calendar end")
			}
			act.Start, act.End = start.Format(offsetTimestamp), end.Format(offsetTimestamp)
			act.Timezone = location.String()
		case "draft_email":
			draftCount++
			if draftCount > 1 || act.ToContactID == "" || !validText(act.Subject, 200) || !validDraftBody(act.Body) || act.Title != "" || act.DueAt != "" || act.ReminderID != "" || act.DraftID != "" {
				return errors.New("invalid draft fields")
			}
		case "update_draft":
			if len(result.Actions) != 1 || !validText(act.Subject, 200) || !validDraftBody(act.Body) || act.Title != "" || act.DueAt != "" || act.ReminderID != "" {
				return errors.New("a draft update requires a valid subject and message")
			}
		case "delete_draft":
			if act.Title != "" || act.DueAt != "" || act.Repeat != "" || act.ToContactID != "" || act.Subject != "" || act.Body != "" || act.ReminderID != "" {
				return errors.New("invalid delete_draft fields")
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
	hindiCompound     = regexp.MustCompile(`(?is)(?:(?:(?:ईमेल|इमेल|e-?mail).*?(?:लिख|ड्राफ्ट|भेज|बना|\b(?:likh(?:o|na)?|draft|bhej(?:o|na)?|bana(?:o|na)?|write|compose)\b)|(?:लिख|ड्राफ्ट|भेज|बना|\b(?:likh(?:o|na)?|draft|bhej(?:o|na)?|bana(?:o|na)?|write|compose)\b).*?(?:ईमेल|इमेल|e-?mail)).*?(?:और|\baur\b).*?(?:याद\s+दिला|yaad\s+dila)|(?:याद\s+दिला|yaad\s+dila).*?(?:और|\baur\b).*?(?:(?:ईमेल|इमेल|e-?mail).*?(?:लिख|ड्राफ्ट|भेज|बना|\b(?:likh(?:o|na)?|draft|bhej(?:o|na)?|bana(?:o|na)?|write|compose)\b)|(?:लिख|ड्राफ्ट|भेज|बना|\b(?:likh(?:o|na)?|draft|bhej(?:o|na)?|bana(?:o|na)?|write|compose)\b).*?(?:ईमेल|इमेल|e-?mail)))`)
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
	for _, act := range result.Actions {
		draft = draft || act.Type == "draft_email"
		reminder = reminder || act.Type == "create_reminder"
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
