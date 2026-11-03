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
	for _, contact := range request.Contacts {
		if !validCommandID(contact.ID) || ids[contact.ID] {
			return errors.New("contacts must have valid, unique IDs.")
		}
		ids[contact.ID] = true
		address, err := mail.ParseAddress(contact.Email)
		if !validText(contact.Name, 200) || nameWords(contact.Name) == "" || !validText(contact.Email, 254) || err != nil || address.Address != contact.Email || address.Name != "" {
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
	return strings.Contains(" "+nameWords(value)+" ", " "+name+" ")
}

func resolveContact(result interpretation, recipientName *string, request commandRequest) (interpretation, error) {
	var draft *action
	for i := range result.Actions {
		if result.Actions[i].Type == "draft_email" {
			draft = &result.Actions[i]
		}
	}
	if recipientName == nil {
		if request.SelectedContactID != nil {
			return interpretation{}, errInvalidSelection
		}
		if draft != nil {
			return interpretation{}, errInvalidProviderOutput
		}
		return result, nil
	}
	name := *recipientName
	query := nameWords(name)
	if !validText(name, 200) || query == "" || !containsName(request.Transcript, query) {
		return interpretation{}, errInvalidProviderOutput
	}
	var matches []contactOption
	for _, contact := range request.Contacts {
		if containsName(contact.Name, query) {
			matches = append(matches, contactOption{ContactID: contact.ID, Name: contact.Name, Email: contact.Email})
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
		question := fmt.Sprintf("Which contact should I use for %s? Add the contact and record a complete revised command.", name)
		return interpretation{Actions: []action{}, Clarification: &question}, nil
	}
	if len(matches) > 1 && selected == nil {
		question := fmt.Sprintf("Which %s should I draft the email to?", name)
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
