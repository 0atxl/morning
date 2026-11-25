package main

import (
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"unicode"
)

type contact struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type contactOption struct {
	ContactID string `json:"contact_id"`
	Name      string `json:"name"`
	Email     string `json:"email"`
}

var errInvalidSelection = errors.New("selected_contact_id must belong to the matching contacts.")

func validateContacts(request commandRequest) error {
	if len(request.Contacts) > 20 {
		return errors.New("contacts must contain at most 20 relevant contacts.")
	}
	ids := make(map[string]bool)
	for _, c := range request.Contacts {
		if !validCommandID(c.ID) || strings.Contains(c.ID, ":") || ids[c.ID] {
			return errors.New("contacts must have valid, unique IDs.")
		}
		ids[c.ID] = true
		address, err := mail.ParseAddress(c.Email)
		if !validText(c.Name, 200) || nameWords(c.Name) == "" || !validText(c.Email, 254) || err != nil || address.Address != c.Email || address.Name != "" {
			return errors.New("each contact needs a name and a plain email address.")
		}
	}
	if request.SelectedContactID != nil && !ids[*request.SelectedContactID] {
		return errInvalidSelection
	}
	return nil
}

// Compare complete name words, preserving combining marks while ignoring case
// and punctuation. A spoken "Priya" matches both Priya Shah and Priya Rao.
func nameWords(value string) string {
	return strings.ToLower(strings.Join(strings.FieldsFunc(value, func(c rune) bool {
		return !unicode.IsLetter(c) && !unicode.IsNumber(c) && !unicode.IsMark(c)
	}), " "))
}

func containsName(value, name string) bool {
	if name == "" {
		return false
	}
	return strings.Contains(" "+nameWords(value)+" ", " "+name+" ")
}

func findSuppliedContact(contacts []contact, ref string) (contact, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return contact{}, false
	}
	for _, c := range contacts {
		if c.ID == ref {
			return c, true
		}
	}
	lower := strings.ToLower(ref)
	for _, c := range contacts {
		if strings.ToLower(c.Email) == lower {
			return c, true
		}
	}
	query := nameWords(ref)
	if query != "" {
		var exact []contact
		for _, c := range contacts {
			if nameWords(c.Name) == query {
				exact = append(exact, c)
			}
		}
		if len(exact) == 1 {
			return exact[0], true
		}
	}
	return contact{}, false
}

// spokenSubset extracts the words from name that actually appeared in text.
// This forgives models returning the saved full name ("Priya Shah") when the
// user only spoke the first name ("Priya"), while preserving disambiguation
// whenever multiple contacts share that spoken word.
func spokenSubset(text, name string) string {
	words := strings.Fields(nameWords(name))
	var kept []string
	for _, w := range words {
		if containsName(text, w) {
			kept = append(kept, w)
		}
	}
	return strings.Join(kept, " ")
}

func historyText(request commandRequest) string {
	var b strings.Builder
	for _, t := range request.RecentTurns {
		b.WriteString(t.Transcript)
		b.WriteByte(' ')
		b.WriteString(t.Topic)
		b.WriteByte(' ')
		b.WriteString(t.Reply)
		b.WriteByte(' ')
	}
	if pt := request.PreviousTurn; pt != nil {
		b.WriteString(pt.Transcript)
		b.WriteByte(' ')
		b.WriteString(pt.Topic)
		b.WriteByte(' ')
		b.WriteString(pt.Reply)
	}
	return b.String()
}

func resolveContact(result interpretation, recipientName *string, request commandRequest) (interpretation, error) {
	var draft *action
	var draftUpdate *action
	for i := range result.Actions {
		switch result.Actions[i].Type {
		case "draft_email":
			draft = &result.Actions[i]
		case "update_draft":
			draftUpdate = &result.Actions[i]
		}
	}

	// Optional recipient change on update_draft.
	if draftUpdate != nil && draftUpdate.ToContactID != "" {
		matched, ok := findSuppliedContact(request.Contacts, draftUpdate.ToContactID)
		if !ok {
			return interpretation{}, errInvalidProviderOutput
		}
		draftUpdate.ToContactID = matched.ID
		return result, nil
	}

	// Normalize recipientName whitespace; treat blank as nil.
	var name string
	if recipientName != nil {
		name = strings.TrimSpace(*recipientName)
	}

	// Ignore stray recipient_name when the model produced a non-draft action
	// (such as a reply, reminder, or delete).
	if draft == nil && len(result.Actions) > 0 {
		if request.SelectedContactID != nil {
			return interpretation{}, errInvalidSelection
		}
		return result, nil
	}

	// Normalize draft.ToContactID if the model passed an email or exact name.
	var draftContact contact
	var hasDraftContact bool
	if draft != nil {
		draftContact, hasDraftContact = findSuppliedContact(request.Contacts, draft.ToContactID)
		if !hasDraftContact {
			return interpretation{}, errInvalidProviderOutput
		}
		draft.ToContactID = draftContact.ID
	}

	if name == "" {
		if draft == nil {
			if request.SelectedContactID != nil {
				return interpretation{}, errInvalidSelection
			}
			return result, nil
		}
		// Model omitted recipient_name but supplied a valid to_contact_id.
		if request.SelectedContactID != nil {
			if draft.ToContactID != *request.SelectedContactID {
				return interpretation{}, errInvalidProviderOutput
			}
			return result, nil
		}
		spoken := spokenSubset(request.Transcript, draftContact.Name)
		if spoken == "" {
			// Check recent conversation history (e.g. "email her about this") or Hindi transliteration.
			spoken = spokenSubset(historyText(request), draftContact.Name)
			if spoken == "" && replyLanguage(request.Transcript) != "hi" && !strings.Contains(strings.ToLower(request.Transcript), strings.ToLower(draftContact.Email)) {
				return interpretation{}, errInvalidProviderOutput
			}
			return result, nil
		}
		var matches []contactOption
		for _, c := range request.Contacts {
			if containsName(c.Name, spoken) {
				matches = append(matches, contactOption{ContactID: c.ID, Name: c.Name, Email: c.Email})
			}
		}
		if len(matches) > 1 {
			question := fmt.Sprintf("Which %s should I draft the email to?", spokenDisplay(draftContact.Name, spoken))
			return interpretation{Actions: []action{}, Clarification: &question, ClarificationOptions: matches}, nil
		}
		return result, nil
	}

	query := nameWords(name)
	if !validText(name, 200) || query == "" {
		return interpretation{}, errInvalidProviderOutput
	}

	displayName := name
	matchQuery := query
	if !containsName(request.Transcript, query) {
		// Forgive full-name recipient_name ("Priya Shah") when the transcript said "Priya".
		if subset := spokenSubset(request.Transcript, name); subset != "" {
			matchQuery = subset
			displayName = spokenDisplay(name, subset)
		} else if historySub := spokenSubset(historyText(request), name); historySub != "" {
			matchQuery = historySub
			displayName = spokenDisplay(name, historySub)
		} else if replyLanguage(request.Transcript) == "hi" && hasDraftContact && containsName(draftContact.Name, query) {
			// Allow Hindi script -> Latin contact name transliteration (e.g. प्रिया -> Priya).
			matchQuery = query
		} else {
			return interpretation{}, errInvalidProviderOutput
		}
	}

	var matches []contactOption
	for _, c := range request.Contacts {
		if containsName(c.Name, matchQuery) {
			matches = append(matches, contactOption{ContactID: c.ID, Name: c.Name, Email: c.Email})
		}
	}

	var selected *contactOption
	if request.SelectedContactID != nil {
		for i := range matches {
			if matches[i].ContactID == *request.SelectedContactID {
				selected = &matches[i]
			}
		}
		if selected == nil {
			return interpretation{}, errInvalidSelection
		}
	}
	if len(matches) == 0 {
		question := fmt.Sprintf("Which contact should I use for %s? Add the contact and record a complete revised command.", displayName)
		return interpretation{Actions: []action{}, Clarification: &question}, nil
	}
	if len(matches) > 1 && selected == nil {
		question := fmt.Sprintf("Which %s should I draft the email to?", displayName)
		return interpretation{Actions: []action{}, Clarification: &question, ClarificationOptions: matches}, nil
	}
	if len(result.Actions) == 0 {
		return result, nil // A missing or ambiguous reminder time still blocks both.
	}
	if selected == nil {
		selected = &matches[0]
	}
	if draft == nil || draft.ToContactID != selected.ContactID {
		return interpretation{}, errInvalidProviderOutput
	}
	return result, nil
}

func spokenDisplay(originalName, subset string) string {
	subsetWords := make(map[string]bool)
	for _, w := range strings.Fields(subset) {
		subsetWords[w] = true
	}
	var kept []string
	for _, w := range strings.Fields(originalName) {
		if subsetWords[nameWords(w)] {
			kept = append(kept, w)
		}
	}
	if len(kept) > 0 {
		return strings.Join(kept, " ")
	}
	return subset
}
