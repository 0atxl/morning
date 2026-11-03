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
		switch action.Type {
		case "create_reminder":
			if !validText(action.Title, 200) || action.ToContactID != "" || action.Subject != "" || action.Body != "" {
				return errors.New("invalid reminder fields")
			}
			due, err := time.Parse(time.RFC3339, action.DueAt)
			if err != nil || !due.After(now) {
				return errors.New("due_at must be a future RFC 3339 timestamp")
			}
			_, suppliedOffset := due.Zone()
			_, expectedOffset := due.In(location).Zone()
			if suppliedOffset != expectedOffset {
				return fmt.Errorf("due_at offset does not match %s", location)
			}
			// Numeric offsets are explicit even for UTC, returned as +00:00.
			action.DueAt = due.In(location).Format("2006-01-02T15:04:05.999999999-07:00")
		case "draft_email":
			if !validCommandID(action.ToContactID) || !validText(action.Subject, 200) || !validDraftBody(action.Body) || action.Title != "" || action.DueAt != "" {
				return errors.New("invalid draft fields")
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
)

// Check explicit coordinated requests against the transcript, independently of
// the provider's actions or recipient evidence. Clarifications remain blocked.
func validateCommandCompleteness(result interpretation, transcript string) error {
	if len(result.Actions) == 0 {
		return nil
	}
	command := unquotedCommand(transcript)
	if !draftThenReminder.MatchString(command) && !reminderThenDraft.MatchString(command) {
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
