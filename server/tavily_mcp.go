package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	tavilyMCPURL  = "https://mcp.tavily.com/mcp/"
	maxLookupBody = 256 << 10
)

type mcpEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   json.RawMessage `json:"error"`
}

// This is deliberately a search-only MCP client. It never discovers or executes
// other tools, accepts server requests, or passes MCP instructions to Groq.
func (s *lookupService) tavilySearch(ctx context.Context, args map[string]any) ([]lookupSource, error) {
	if s.tavilyKey == "" {
		return nil, &lookupError{"search_not_configured", "Web search is not configured on Morning's server.", 0, false}
	}
	const version = "2025-06-18"
	init, session, err := s.mcpPost(ctx, "", "", 1, "initialize", map[string]any{
		"protocolVersion": version, "capabilities": map[string]any{},
		"clientInfo": map[string]string{"name": "morning-read-only-search", "version": "1.0"},
	})
	if err != nil {
		return nil, err
	}
	var initialized struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if json.Unmarshal(init, &initialized) != nil {
		return nil, errInvalidProviderOutput
	}
	switch initialized.ProtocolVersion {
	case "2025-03-26", version:
	default:
		return nil, errInvalidProviderOutput
	}
	if _, _, err = s.mcpPost(ctx, session, initialized.ProtocolVersion, 0, "notifications/initialized", nil); err != nil {
		return nil, err
	}
	result, _, err := s.mcpPost(ctx, session, initialized.ProtocolVersion, 2, "tools/call", map[string]any{
		"name": "tavily_search", "arguments": args,
	})
	if err != nil {
		return nil, err
	}
	return parseTavilyResult(result)
}

func (s *lookupService) mcpPost(ctx context.Context, session, version string, id int, method string, params any) (json.RawMessage, string, error) {
	message := map[string]any{"jsonrpc": "2.0", "method": method}
	if id != 0 {
		message["id"] = id
	}
	if params != nil {
		message["params"] = params
	}
	body, _ := json.Marshal(message)
	r, _ := http.NewRequestWithContext(ctx, http.MethodPost, tavilyMCPURL, bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+s.tavilyKey)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	if session != "" {
		r.Header.Set("Mcp-Session-Id", session)
	}
	if version != "" {
		r.Header.Set("MCP-Protocol-Version", version)
	}
	response, err := s.client.Do(r)
	if err != nil {
		return nil, "", providerRequestError(err)
	}
	defer response.Body.Close()
	if err := lookupHTTPError(response.StatusCode, response.Header.Get("Retry-After")); err != nil {
		return nil, "", err
	}
	if id == 0 {
		if response.StatusCode != http.StatusAccepted {
			return nil, "", errInvalidProviderOutput
		}
		return nil, session, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, "", errInvalidProviderOutput
	}
	var result json.RawMessage
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaType == "text/event-stream" {
		result, err = readMCPStream(response.Body, id)
	} else if mediaType == "application/json" {
		var data []byte
		data, err = io.ReadAll(io.LimitReader(response.Body, maxLookupBody+1))
		if err != nil {
			return nil, "", providerRequestError(err)
		}
		if err == nil {
			if len(data) > maxLookupBody {
				return nil, "", errInvalidProviderOutput
			}
			result, err = mcpResult(data, id)
		}
	} else {
		return nil, "", errInvalidProviderOutput
	}
	if err != nil {
		return nil, "", err
	}
	session = response.Header.Get("Mcp-Session-Id")
	if len(session) > 256 || strings.ContainsAny(session, "\r\n") {
		return nil, "", errInvalidProviderOutput
	}
	return result, session, nil
}

func readMCPStream(body io.Reader, id int) (json.RawMessage, error) {
	scanner := bufio.NewScanner(io.LimitReader(body, maxLookupBody+1))
	scanner.Buffer(make([]byte, 4096), maxLookupBody)
	var data strings.Builder
	total := 0
	for scanner.Scan() {
		line := scanner.Text()
		total += len(line) + 1
		if total > maxLookupBody {
			return nil, errInvalidProviderOutput
		}
		if line == "" && data.Len() > 0 {
			var envelope mcpEnvelope
			if json.Unmarshal([]byte(data.String()), &envelope) != nil {
				return nil, errInvalidProviderOutput
			}
			// Ignore progress notifications and server requests. They cannot run code.
			if string(envelope.ID) == jsonID(id) && envelope.JSONRPC == "2.0" {
				return mcpResult([]byte(data.String()), id)
			}
			data.Reset()
		} else if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, providerRequestError(err)
	}
	return nil, errInvalidProviderOutput
}

func jsonID(id int) string { body, _ := json.Marshal(id); return string(body) }

func mcpResult(data []byte, id int) (json.RawMessage, error) {
	var envelope mcpEnvelope
	if json.Unmarshal(data, &envelope) != nil || envelope.JSONRPC != "2.0" || string(envelope.ID) != jsonID(id) {
		return nil, errInvalidProviderOutput
	}
	if len(envelope.Error) > 0 && string(envelope.Error) != "null" {
		return nil, tavilyMCPError(envelope.Error)
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return nil, errInvalidProviderOutput
	}
	return envelope.Result, nil
}

func lookupHTTPError(status int, retryAfterHeader string) error {
	switch status {
	case 401, 403:
		return &lookupError{"lookup_access_denied", "The lookup provider rejected Morning's server credentials or access.", 0, false}
	case 402, 429, 432, 433:
		return &lookupError{"lookup_quota_limited", "The lookup provider's quota or rate limit was reached. Please try later.", providerRetrySeconds(retryAfterHeader, time.Now()), true}
	}
	if status < 200 || status >= 300 {
		return errProviderUnavailable
	}
	return nil
}

type tavilyItem struct {
	Title         string `json:"title"`
	URL           string `json:"url"`
	Content       string `json:"content"`
	PublishedDate string `json:"published_date"`
}

func parseTavilyResult(raw json.RawMessage) ([]lookupSource, error) {
	var result struct {
		IsError           bool            `json:"isError"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		Content           []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return nil, errInvalidProviderOutput
	}
	if result.IsError {
		return nil, tavilyMCPError(raw)
	}
	structuredDates := true
	var payload struct {
		Results []tavilyItem `json:"results"`
	}
	if len(result.StructuredContent) > 0 && string(result.StructuredContent) != "null" {
		if json.Unmarshal(result.StructuredContent, &payload) != nil || payload.Results == nil {
			return nil, errInvalidProviderOutput
		}
	} else {
		var blocks []string
		for _, block := range result.Content {
			if block.Type == "text" {
				blocks = append(blocks, block.Text)
			}
		}
		text := strings.Join(blocks, "\n")
		if json.Unmarshal([]byte(text), &payload) != nil || payload.Results == nil {
			// Detailed Results text has no unambiguous boundary between an
			// excerpt and provider metadata. Keep a source link, but never use
			// dates embedded in that text to establish news freshness.
			structuredDates = false
			var ok bool
			payload.Results, ok = parseTavilyText(text)
			if !ok {
				return nil, errInvalidProviderOutput
			}
		}
	}
	sources := make([]lookupSource, 0, lookupResultCap)
	seen := make(map[string]bool)
	for _, item := range payload.Results {
		link, ok := safeLookupURL(item.URL)
		title := lookupText(item.Title, 200)
		// Ignore tracking parameters for deduplication without altering the link
		// the visitor opens. Fragments have already been removed.
		key := link
		if parsed, parseErr := url.Parse(link); parseErr == nil {
			query := parsed.Query()
			for param := range query {
				if strings.HasPrefix(strings.ToLower(param), "utm_") || param == "fbclid" || param == "gclid" {
					query.Del(param)
				}
			}
			parsed.RawQuery = query.Encode()
			key = parsed.String()
		}
		if !ok || title == "" || seen[key] {
			continue
		}
		seen[key] = true
		source := lookupSource{Title: title, URL: link, Publisher: sourcePublisher(link), Excerpt: lookupText(item.Content, 1800)}
		if published, ok := tavilyPublicationTime(item.PublishedDate); ok && structuredDates {
			source.PublishedAt = published.UTC().Format(time.RFC3339)
		}
		sources = append(sources, source)
		if len(sources) == lookupResultCap {
			break
		}
	}
	return sources, nil
}

func tavilyMCPError(raw []byte) error {
	// Classify only fixed errors. Never forward provider text or a URL in it.
	text := strings.ToLower(string(raw))
	for _, marker := range []string{"quota", "credit", "429", "432", "rate limit", "usage limit", "usage_limit"} {
		if strings.Contains(text, marker) {
			return lookupHTTPError(429, "")
		}
	}
	for _, marker := range []string{"invalid api key", "invalid_api_key", "unauthorized", "401", "403"} {
		if strings.Contains(text, marker) {
			return lookupHTTPError(401, "")
		}
	}
	return errProviderUnavailable
}

var tavilyTitleLine = regexp.MustCompile(`(?m)^[ \t]*Title:[ \t]*`)

func parseTavilyText(text string) ([]tavilyItem, bool) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	_, detailed, ok := strings.Cut(text, "Detailed Results:")
	if !ok {
		return nil, false
	}
	items := []tavilyItem{}
	trimmed := strings.TrimSpace(detailed)
	if trimmed == "" {
		return items, true
	}
	rawBlocks := tavilyTitleLine.Split(trimmed, -1)
	for _, block := range rawBlocks[1:] {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		if len(lines) < 2 {
			continue
		}
		item := tavilyItem{Title: strings.TrimSpace(lines[0])}
		for i, line := range lines[1:] {
			line = strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(line, "URL:") && item.URL == "":
				item.URL = strings.TrimSpace(strings.TrimPrefix(line, "URL:"))
			case strings.HasPrefix(line, "Published Date:") && item.PublishedDate == "":
				item.PublishedDate = strings.TrimSpace(strings.TrimPrefix(line, "Published Date:"))
			case strings.HasPrefix(line, "Content:"):
				contentLines := lines[i+1:]
				item.Content = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(strings.Join(contentLines, "\n")), "Content:"))
				// Everything inside Content is untrusted excerpt data, not metadata.
				if item.URL != "" {
					items = append(items, item)
				}
				// Later Title blocks could be part of this untrusted excerpt.
				// Do not promote them into new citations.
				return items, true
			}
		}
		if item.URL != "" {
			items = append(items, item)
		}
		return items, true
	}
	return items, true
}

func tavilyPublicationTime(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC1123,
		time.RFC1123Z,
		"Mon, _2 Jan 2006 15:04:05 MST",
		"Mon, _2 Jan 2006 15:04:05 -0700",
		time.RFC822,
		time.RFC822Z,
		time.RFC850,
		"2006-01-02 15:04:05Z07:00",
		"2006-01-02 15:04:05 -0700",
		"2006-01-02 15:04:05 MST",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, true
		}
	}
	// A date without a time/offset cannot establish that a story is in today's
	// local window. Keep that uncertainty rather than assigning midnight.
	return time.Time{}, false
}
