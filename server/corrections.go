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
	correctionLead   = regexp.MustCompile(spokenPrefix + `(?:make\s+(?:it|that)|reschedule(?:\s+(?:(?:the|my|that)\s+)?(?:existing\s+)?(?:reminder|task))?|(?:move|change)\s+(?:it|that(?:\s+(?:reminder|task))?|(?:the|my)\s+(?:existing\s+)?(?:reminder|task)))\b[,\s]*(?:to\s+)?`)
	otherTarget      = regexp.MustCompile(spokenPrefix + `(?:move|change|reschedule)\s+(?:(?:the|my|that)\s+other\s+(?:reminder|task|one)|another\s+(?:reminder|task))\b`)
	newCommandLead   = regexp.MustCompile(spokenPrefix + `(?:remind\s+me\b|(?:give|set|create|add|schedule)\s+(?:me\s+)?(?:(?:a|an|new|my)\s+)*(?:reminder|alert)\b|draft\b|write\b|compose\b)`)
	hindiCorrection  = regexp.MustCompile(`(?i)^\s*(?:(?:नहीं|नही|अच्छा|nahi|nahin|achha)[,\s]+)*(?:उसे|उसको|इसे|इसको|usko|use|isko|ise)\s+(.+?)\s+(?:कर\s*दो|कर\s*दें|kar\s*do|kar\s*den)[।.!?\s]*$`)
	hindiOtherTarget = regexp.MustCompile(`(?i)(?:दूसरे\s+रिमाइंडर|दूसरा\s+रिमाइंडर|dusre\s+reminder|doosre\s+reminder)`)
	hindiReminder    = regexp.MustCompile(`(?i)(?:याद\s+दिला|yaad\s+dila|reminder\s+(?:laga|bana)|रिमाइंडर\s+(?:लगा|बना))`)
)

func correctionQuestion(question string) interpretation {
	return interpretation{Actions: []action{}, Clarification: &question}
}

func resolveCorrection(result interpretation, request commandRequest, location *time.Location) (interpretation, error) {
	// Draft updates/deletes are resolved separately in resolveDraftAction.
	if len(result.Actions) > 0 && (result.Actions[0].Type == "update_draft" || result.Actions[0].Type == "delete_draft") {
		return result, nil
	}

	reminders := allReminders(request)
	byID := make(map[string]reminderContextItem, len(reminders))
	for _, r := range reminders {
		byID[r.ID] = r
	}

	// Handle delete_reminder actions (1 or more).
	hasDelete := false
	for _, a := range result.Actions {
		if a.Type == "delete_reminder" {
			hasDelete = true
			break
		}
	}
	if hasDelete {
		if len(reminders) == 0 {
			return correctionQuestion("Which reminder should I delete?"), nil
		}
		for i := range result.Actions {
			if result.Actions[i].Type != "delete_reminder" {
				continue
			}
			if request.SelectedReminderID != nil {
				result.Actions[i].ReminderID = *request.SelectedReminderID
				continue
			}
			if result.Actions[i].ReminderID != "" {
				if _, ok := byID[result.Actions[i].ReminderID]; !ok {
					return interpretation{}, errInvalidProviderOutput
				}
				continue
			}
			if len(reminders) == 1 {
				result.Actions[i].ReminderID = reminders[0].ID
				continue
			}
			return correctionQuestion("Which reminder should I delete?"), nil
		}
		return result, nil
	}

	if (otherTarget.MatchString(request.Transcript) || hindiOtherTarget.MatchString(request.Transcript)) && request.SelectedReminderID == nil && len(reminders) <= 1 {
		return correctionQuestion("Which reminder should I move?"), nil
	}

	lead := correctionLead.FindStringIndex(request.Transcript)
	hindiLead := hindiCorrection.FindStringSubmatch(request.Transcript)
	reschedule := len(result.Actions) == 1 && result.Actions[0].Type == "reschedule_reminder"
	if lead == nil && hindiLead == nil && !reschedule {
		return result, nil
	}
	if reschedule && (newCommandLead.MatchString(request.Transcript) || hindiReminder.MatchString(unquotedCommand(request.Transcript))) {
		return interpretation{}, errInvalidProviderOutput
	}
	if len(reminders) == 0 {
		return correctionQuestion("Which reminder should I move?"), nil
	}
	if len(result.Actions) == 0 {
		return result, nil
	}

	// Bind target reminder from explicit selection, verified model ID, or single saved reminder.
	var target reminderContextItem
	var haveTarget bool
	if request.SelectedReminderID != nil {
		target, haveTarget = byID[*request.SelectedReminderID]
	} else if reschedule && result.Actions[0].ReminderID != "" {
		target, haveTarget = byID[result.Actions[0].ReminderID]
		if !haveTarget {
			return interpretation{}, errInvalidProviderOutput
		}
	} else if len(reminders) == 1 {
		target, haveTarget = reminders[0], true
	}

	if lead != nil || hindiLead != nil {
		var when string
		if hindiLead != nil {
			when = hindiLead[1]
		} else {
			when = request.Transcript[lead[1]:]
		}
		when = strings.ToLower(strings.Trim(when, " \t\r\n.,!?।"))
		if when == "" || when == "later" || when == "earlier" || when == "बाद में" || when == "baad mein" || strings.Contains(when, " or ") || strings.Contains(when, " या ") || strings.Contains(when, " ya ") {
			return correctionQuestion("What time should I move the reminder to?"), nil
		}
		if !reschedule {
			return interpretation{}, errInvalidProviderOutput
		}
		if !haveTarget {
			return correctionQuestion("Which reminder should I move?"), nil
		}
		// A bare clock hour inherits the saved local date and half of the day.
		// Only apply when the user is doing a time-only reschedule (not a title edit).
		if result.Actions[0].DueAt != "" && result.Actions[0].Title == "" {
			if hour, ok := bareClockHour(when); ok {
				old := target.DueAt.In(location)
				due, err := time.Parse(time.RFC3339Nano, result.Actions[0].DueAt)
				wantHour := hour%12 + old.Hour()/12*12
				if err != nil || old.Format(time.DateOnly) != due.In(location).Format(time.DateOnly) ||
					due.Hour() != wantHour || due.Minute() != 0 || due.Second() != 0 || due.Nanosecond() != 0 {
					return interpretation{}, errInvalidProviderOutput
				}
			}
		}
	}

	if !haveTarget {
		return correctionQuestion("Which reminder should I move?"), nil
	}
	result.Actions[0].ReminderID = target.ID
	return result, nil
}

func resolveDraftAction(result interpretation, request commandRequest) (interpretation, error) {
	if len(result.Actions) == 0 {
		return result, nil
	}
	drafts := allDrafts(request)
	byID := make(map[string]draftContext, len(drafts))
	for _, d := range drafts {
		byID[d.ID] = d
	}

	for i := range result.Actions {
		switch result.Actions[i].Type {
		case "update_draft":
			if len(drafts) == 0 {
				return correctionQuestion("Which draft should I update?"), nil
			}
			if request.SelectedDraftID != nil {
				result.Actions[i].DraftID = *request.SelectedDraftID
				continue
			}
			if result.Actions[i].DraftID != "" {
				if _, ok := byID[result.Actions[i].DraftID]; !ok {
					return interpretation{}, errInvalidProviderOutput
				}
				continue
			}
			if len(drafts) == 1 {
				result.Actions[i].DraftID = drafts[0].ID
				continue
			}
			return correctionQuestion("Which draft should I update?"), nil
		case "delete_draft":
			if len(drafts) == 0 {
				return correctionQuestion("Which draft should I delete?"), nil
			}
			if request.SelectedDraftID != nil {
				result.Actions[i].DraftID = *request.SelectedDraftID
				continue
			}
			if result.Actions[i].DraftID != "" {
				if _, ok := byID[result.Actions[i].DraftID]; !ok {
					return interpretation{}, errInvalidProviderOutput
				}
				continue
			}
			if len(drafts) == 1 {
				result.Actions[i].DraftID = drafts[0].ID
				continue
			}
			return correctionQuestion("Which draft should I delete?"), nil
		}
	}
	return result, nil
}

func bareClockHour(text string) (int, bool) {
	text = latinDigits(strings.TrimSpace(text))
	text = strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(text, " बजे"), " baje"))
	for i, word := range strings.Fields("one two three four five six seven eight nine ten eleven twelve") {
		if text == word {
			return i + 1, true
		}
	}
	for i, word := range strings.Fields("एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह") {
		if text == word {
			return i + 1, true
		}
	}
	for i, word := range strings.Fields("ek do teen chaar paanch chhe saat aath nau dus gyarah barah") {
		if text == word {
			return i + 1, true
		}
	}
	hour, err := strconv.Atoi(text)
	return hour, err == nil && hour >= 1 && hour <= 12
}
