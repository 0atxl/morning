package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Recognize explicit follow-ups even if the provider mistakenly proposes a new record.
const spokenPrefix = `(?i)^\s*(?:(?:actually|please|can you|could you|no|maybe)[,.\s]+)*`

var (
	correctionLead = regexp.MustCompile(spokenPrefix + `(?:make\s+(?:it|that)|reschedule(?:\s+(?:(?:the|my|that)\s+)?(?:existing\s+)?(?:reminder|task))?|(?:move|change)\s+(?:it|that(?:\s+(?:reminder|task))?|(?:the|my)\s+(?:existing\s+)?(?:reminder|task)))\b[,\s]*(?:to\s+)?`)
	otherTarget    = regexp.MustCompile(spokenPrefix + `(?:move|change|reschedule)\s+(?:(?:the|my|that)\s+other\s+(?:reminder|task|one)|another\s+(?:reminder|task))\b`)
	newCommandLead = regexp.MustCompile(spokenPrefix + `(?:remind\s+me\b|(?:give|set|create|add|schedule)\s+(?:me\s+)?(?:(?:a|an|new|my)\s+)*(?:reminder|alert)\b|draft\b|write\b|compose\b)`)
)

func correctionQuestion(question string) interpretation {
	return interpretation{Actions: []action{}, Clarification: &question}
}

func resolveCorrection(result interpretation, request commandRequest, location *time.Location) (interpretation, error) {
	// The model distinguishes "make that more formal" from a reminder-time
	// correction when both a draft and a reminder are in the conversation.
	if len(result.Actions) == 1 && result.Actions[0].Type == "update_draft" {
		return result, nil
	}
	if otherTarget.MatchString(request.Transcript) && request.SelectedReminderID == nil {
		return correctionQuestion("Which reminder should I move?"), nil
	}
	lead := correctionLead.FindStringIndex(request.Transcript)
	reschedule := len(result.Actions) == 1 && result.Actions[0].Type == "reschedule_reminder"
	if lead == nil && !reschedule {
		return result, nil
	}
	if reschedule && newCommandLead.MatchString(request.Transcript) {
		return interpretation{}, errInvalidProviderOutput
	}
	reminder := request.ReminderContext
	if reminder == nil {
		return correctionQuestion("Which reminder should I move?"), nil
	}
	if len(result.Actions) == 0 {
		return result, nil
	}
	if lead != nil {
		when := strings.ToLower(strings.Trim(request.Transcript[lead[1]:], " \t\r\n.,!?"))
		if when == "" || when == "later" || when == "earlier" || strings.Contains(when, " or ") {
			return correctionQuestion("What time should I move the reminder to?"), nil
		}
		if !reschedule {
			return interpretation{}, errInvalidProviderOutput
		}
		// A bare hour inherits the saved local date and half of the day.
		// Reject a plausible timestamp if the model silently moved either.
		if hour, ok := bareClockHour(when); ok {
			old := reminder.DueAt.In(location)
			due, err := time.Parse(time.RFC3339Nano, result.Actions[0].DueAt)
			wantHour := hour%12 + old.Hour()/12*12
			if err != nil || old.Format(time.DateOnly) != due.In(location).Format(time.DateOnly) ||
				due.Hour() != wantHour || due.Minute() != 0 || due.Second() != 0 || due.Nanosecond() != 0 {
				return interpretation{}, errInvalidProviderOutput
			}
		}
	}
	result.Actions[0].ReminderID = reminder.ID
	return result, nil
}

func bareClockHour(text string) (int, bool) {
	for i, word := range strings.Fields("one two three four five six seven eight nine ten eleven twelve") {
		if text == word {
			return i + 1, true
		}
	}
	hour, err := strconv.Atoi(text)
	return hour, err == nil && hour >= 1 && hour <= 12
}
