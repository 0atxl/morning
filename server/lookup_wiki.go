package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type wikiSummaryResponse struct {
	Type        string `json:"type"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Extract     string `json:"extract"`
	ContentURLs struct {
		Desktop struct {
			Page string `json:"page"`
		} `json:"desktop"`
	} `json:"content_urls"`
}

func (s *lookupService) wikiLookup(ctx context.Context, q lookupQuery, now time.Time) (lookupOutcome, error) {
	terms := strings.TrimSpace(q.Terms)
	if terms == "" {
		return emptyLookup(q, q.Terms, "Please specify a topic, person, or historical event to look up."), nil
	}

	host := "en.wikipedia.org"
	if q.ReplyLanguage == "hi" || hindiText(terms) {
		host = "hi.wikipedia.org"
	}

	title := s.wikiSearchTitle(ctx, host, terms)
	if title == "" {
		title = terms
	}

	summaryURL := fmt.Sprintf("https://%s/api/rest_v1/page/summary/%s", host, url.PathEscape(strings.ReplaceAll(title, " ", "_")))
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, summaryURL, nil)
	if err != nil {
		return lookupOutcome{}, providerRequestError(err)
	}
	r.Header.Set("Accept", "application/json")
	r.Header.Set("User-Agent", "Morning/1.0 (https://morning.atuls.me; contact@atuls.me)")

	response, err := s.client.Do(r)
	if err != nil {
		return lookupOutcome{}, providerRequestError(err)
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusNotFound {
		return emptyLookup(q, terms, "I couldn't find a Wikipedia article for that topic."), nil
	}
	if err := lookupHTTPError(response.StatusCode, response.Header.Get("Retry-After")); err != nil {
		return lookupOutcome{}, err
	}

	var data wikiSummaryResponse
	if err := json.NewDecoder(response.Body).Decode(&data); err != nil || data.Extract == "" {
		return emptyLookup(q, terms, "I couldn't find a summary for that topic on Wikipedia."), nil
	}

	articleURL := data.ContentURLs.Desktop.Page
	if safeURL, ok := safeLookupURL(articleURL); ok {
		articleURL = safeURL
	} else {
		articleURL = fmt.Sprintf("https://%s/wiki/%s", host, url.PathEscape(strings.ReplaceAll(data.Title, " ", "_")))
	}

	displayTitle := data.Title
	if displayTitle == "" {
		displayTitle = title
	}

	answer := data.Extract
	if data.Description != "" {
		answer = fmt.Sprintf("%s (%s)\n\n%s", displayTitle, data.Description, data.Extract)
	}

	speechText := firstGroundedSentence(data.Extract)
	if speechText == "" || len([]rune(speechText)) > maxSpeechChars {
		speechText = lookupText(data.Extract, maxSpeechChars)
	}

	source := lookupSource{
		Title:     displayTitle + " - Wikipedia",
		URL:       articleURL,
		Publisher: "Wikipedia",
		Excerpt:   lookupText(data.Extract, 1800),
	}

	result := &lookupResult{
		Kind:       "wiki",
		Query:      displayTitle,
		Status:     "answered",
		Answer:     lookupText(answer, 2000),
		Speech:     lookupSentence(speechText),
		Sources:    []lookupSource{source},
		LookedUpAt: now.UTC().Format(time.RFC3339),
	}

	return lookupOutcome{Result: result}, nil
}

func (s *lookupService) wikiSearchTitle(ctx context.Context, host, terms string) string {
	searchURL := fmt.Sprintf("https://%s/w/api.php?action=opensearch&search=%s&limit=1&namespace=0&format=json", host, url.QueryEscape(terms))
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, searchURL, nil)
	if err != nil {
		return ""
	}
	r.Header.Set("Accept", "application/json")
	r.Header.Set("User-Agent", "Morning/1.0 (https://morning.atuls.me; contact@atuls.me)")

	response, err := s.client.Do(r)
	if err != nil {
		return ""
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return ""
	}

	var results []any
	if err := json.NewDecoder(response.Body).Decode(&results); err != nil || len(results) < 2 {
		return ""
	}

	titles, ok := results[1].([]any)
	if !ok || len(titles) == 0 {
		return ""
	}

	firstTitle, ok := titles[0].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(firstTitle)
}
