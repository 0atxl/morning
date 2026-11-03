package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Recognize explicit follow-ups even if the provider mistakenly proposes a new record.
const spokenPrefix = `(?i)^\s*(?:(?:actually|please|can you|could you)[,\s]+)*`

var (
	correctionLead = regexp.MustCompile(spokenPrefix + `(?:make\s+(?:it|that)|reschedule|(?:move|change)\s+(?:it|that|(?:the|my)\s+reminder))\b[,\s]*(?:to\s+)?`)
	otherTarget    = regexp.MustCompile(spokenPrefix + `(?:move|change|reschedule)\s+(?:(?:the|my|that)\s+other\s+(?:reminder|one)|another\s+reminder)\b`)
	newCommandLead = regexp.MustCompile(spokenPrefix + `(?:remind\s+me\b.+\bto\s+|draft\b|write\b|compose\b)`)
)

func correctionQuestion(question string) interpretation {
	return interpretation{Actions: []action{}, Clarification: &question}
}

func resolveCorrection(result interpretation, request commandRequest, location *time.Location) (interpretation, error) {
	if otherTarget.MatchString(request.Transcript) {
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
