package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	host := "en.wikipedia.org"
	if q.ReplyLanguage == "hi" {
		host = "hi.wikipedia.org"
	}

	summaryEndpoint := "https://" + host + "/api/rest_v1/page/summary/"
	var data wikiSummaryResponse
	missing, err := s.wikiGET(ctx, summaryEndpoint+url.PathEscape(strings.ReplaceAll(terms, " ", "_")), &data)
	if err != nil {
		return lookupOutcome{}, err
	}
	if missing {
		args := url.Values{"action": {"opensearch"}, "search": {terms}, "limit": {fmt.Sprint(lookupResultCap + 1)}, "namespace": {"0"}, "format": {"json"}}
		var search []json.RawMessage
		missing, err = s.wikiGET(ctx, "https://"+host+"/w/api.php?"+args.Encode(), &search)
		if err != nil {
			return lookupOutcome{}, err
		}
		if missing {
			return lookupOutcome{}, errProviderUnavailable
		}
		var query string
		var titles, descriptions, urls []string
		if len(search) != 4 || json.Unmarshal(search[0], &query) != nil || query != terms ||
			json.Unmarshal(search[1], &titles) != nil || titles == nil ||
			json.Unmarshal(search[2], &descriptions) != nil || descriptions == nil ||
			json.Unmarshal(search[3], &urls) != nil || urls == nil ||
			len(titles) != len(descriptions) || len(titles) != len(urls) {
			return lookupOutcome{}, errInvalidProviderOutput
		}
		for _, title := range titles {
			if lookupText(title, 200) == "" {
				return lookupOutcome{}, errInvalidProviderOutput
			}
		}
		if len(titles) == 0 {
			return wikiEmpty(q, now, false, nil), nil
		}
		if len(titles) > 1 {
			sources := make([]lookupSource, 0, lookupResultCap)
			for i, title := range titles {
				source, err := wikiSource(host, title, urls[i], "")
				if err != nil {
					return lookupOutcome{}, err
				}
				sources = append(sources, source)
				if len(sources) == lookupResultCap {
					break
				}
			}
			return wikiEmpty(q, now, true, sources), nil
		}
		data = wikiSummaryResponse{}
		missing, err = s.wikiGET(ctx, summaryEndpoint+url.PathEscape(strings.ReplaceAll(titles[0], " ", "_")), &data)
		if err != nil {
			return lookupOutcome{}, err
		}
		if missing {
			return wikiEmpty(q, now, false, nil), nil
		}
	}

	if lookupText(data.Title, 200) == "" || data.Type != "standard" && data.Type != "disambiguation" {
		return lookupOutcome{}, errInvalidProviderOutput
	}
	if data.Type == "disambiguation" {
		source, err := wikiSource(host, data.Title, data.ContentURLs.Desktop.Page, "")
		if err != nil {
			return lookupOutcome{}, err
		}
		return wikiEmpty(q, now, true, []lookupSource{source}), nil
	}
	extract := lookupText(data.Extract, 1800)
	if extract == "" {
		return lookupOutcome{}, errInvalidProviderOutput
	}
	source, err := wikiSource(host, data.Title, data.ContentURLs.Desktop.Page, extract)
	if err != nil {
		return lookupOutcome{}, err
	}
	answer := extract
	if description := lookupText(data.Description, 200); description != "" {
		answer = fmt.Sprintf("%s (%s) %s", lookupText(data.Title, 200), description, extract)
	}
	speech := firstGroundedSentence(extract)
	if speech == "" {
		speech = "The results and their sources are ready to open."
		if q.ReplyLanguage == "hi" {
			speech = hindiLookupMessage(speech)
		}
	}
	return lookupOutcome{Result: &lookupResult{
		Kind: "wiki", Query: lookupText(data.Title, 430), Status: "answered",
		Answer: lookupText(answer, 2000), Speech: lookupSentence(speech),
		Sources: []lookupSource{source}, LookedUpAt: now.UTC().Format(time.RFC3339),
	}}, nil
}

func wikiSource(host, title, rawURL, extract string) (lookupSource, error) {
	articleURL, ok := safeLookupURL(rawURL)
	if ok {
		u, _ := url.Parse(articleURL)
		ok = u.Scheme == "https" && u.Host == host && strings.HasPrefix(u.Path, "/wiki/") && len(u.Path) > len("/wiki/")
	}
	if !ok {
		articleURL = "https://" + host + "/wiki/" + url.PathEscape(strings.ReplaceAll(strings.TrimSpace(title), " ", "_"))
		if _, ok := safeLookupURL(articleURL); !ok {
			return lookupSource{}, errInvalidProviderOutput
		}
	}
	const suffix = " - Wikipedia"
	return lookupSource{
		Title: lookupText(title, 200-len(suffix)) + suffix,
		URL:   articleURL, Publisher: "Wikipedia", Excerpt: lookupText(extract, 1800),
	}, nil
}

func wikiEmpty(q lookupQuery, now time.Time, ambiguous bool, sources []lookupSource) lookupOutcome {
	message := "I couldn't find a Wikipedia article for that topic."
	hindi := q.ReplyLanguage == "hi"
	if hindi {
		message = "इस विषय पर विकिपीडिया का लेख नहीं मिला।"
	}
	if ambiguous {
		message = "That topic has multiple Wikipedia meanings. Please specify which person, place, or subject you mean."
		if hindi {
			message = "विकिपीडिया पर इस विषय के कई अर्थ हैं। कृपया व्यक्ति, जगह या विषय का पूरा नाम बताएं।"
		}
	}
	outcome := emptyLookup(q, lookupText(q.Terms, 430), message)
	if sources != nil {
		outcome.Result.Sources = sources
	}
	outcome.Result.LookedUpAt = now.UTC().Format(time.RFC3339)
	return outcome
}

// Wikipedia needs its User-Agent and a bounded 404 before trying opensearch.
// Reuse the lookup client so redirects and the caller's deadline stay unchanged.
func (s *lookupService) wikiGET(ctx context.Context, endpoint string, dst any) (bool, error) {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, providerRequestError(err)
	}
	r.Header.Set("Accept", "application/json")
	r.Header.Set("User-Agent", "Morning/1.0 (https://morning.atuls.me; contact@atuls.me)")
	response, err := s.client.Do(r)
	if err != nil {
		return false, providerRequestError(err)
	}
	defer response.Body.Close()
	missing := response.StatusCode == http.StatusNotFound
	if !missing {
		if err := lookupHTTPError(response.StatusCode, response.Header.Get("Retry-After")); err != nil {
			return false, err
		}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxLookupBody+1))
	if err != nil {
		return false, providerRequestError(err)
	}
	if len(body) > maxLookupBody || strings.TrimSpace(string(body)) == "null" || json.Unmarshal(body, dst) != nil {
		return false, errInvalidProviderOutput
	}
	return missing, nil
}
