package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/iotest"
	"time"
	"unicode/utf8"
)

func wikiSummaryFixture(t *testing.T, title, description, extract, page string) string {
	t.Helper()
	data := wikiSummaryResponse{Type: "standard", Title: title, Description: description, Extract: extract}
	data.ContentURLs.Desktop.Page = page
	body, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestLookupWikiReturnsGroundedSummaryAndWikipediaSource(t *testing.T) {
	calls := 0
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("User-Agent") != "Morning/1.0 (https://morning.atuls.me; contact@atuls.me)" || r.Header.Get("Accept") != "application/json" {
			t.Fatal("missing Wikipedia request headers")
		}
		if r.URL.Host != "en.wikipedia.org" || r.URL.Path != "/api/rest_v1/page/summary/Adolf_Hitler" || r.URL.RawQuery != "" {
			t.Fatalf("expected exact summary before search, got %s", r.URL)
		}
		if deadline, ok := r.Context().Deadline(); !ok || time.Until(deadline) > lookupTimeout {
			t.Fatal("Wikipedia request needs the lookup deadline")
		}
		return lookupJSONResponse(200, wikiSummaryFixture(t, "Adolf Hitler", "Dictator of Germany from 1933 to 1945",
			"Adolf Hitler was an Austrian-born German politician who was dictator of Germany in the Nazi era from 1933 until his suicide in 1945. Germany's invasion of Poland on 1 September 1939 marked the outbreak of World War II.",
			"https://en.wikipedia.org/wiki/Adolf_Hitler")), nil
	})

	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "Adolf Hitler"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil {
		t.Fatalf("wiki lookup failed: %v", err)
	}
	r := outcome.Result
	if calls != 1 || r.Kind != "wiki" || r.Status != "answered" || r.Query != "Adolf Hitler" || r.LookedUpAt != s.clock().UTC().Format(time.RFC3339) {
		t.Fatalf("wrong result or request count %d: %+v", calls, r)
	}
	if !strings.Contains(r.Answer, "Adolf Hitler (Dictator of Germany from 1933 to 1945)") || !strings.Contains(r.Answer, "Austrian-born") {
		t.Fatalf("missing extract facts: %s", r.Answer)
	}
	if len(r.Sources) != 1 || r.Sources[0].Publisher != "Wikipedia" || r.Sources[0].URL != "https://en.wikipedia.org/wiki/Adolf_Hitler" {
		t.Fatalf("wrong source: %+v", r.Sources)
	}
	if !validText(r.Speech, maxSpeechChars) || !strings.Contains(r.Speech, "Austrian-born") {
		t.Fatalf("speech invalid: %s", r.Speech)
	}
}

func TestLookupWikiLanguageAppliesToSummarySearchAndSources(t *testing.T) {
	for _, tc := range []struct {
		name, terms, language, host string
	}{
		{"English default", "Gandhi", "", "en.wikipedia.org"},
		{"Hindi requested for Latin terms", "Gandhi", "hi", "hi.wikipedia.org"},
		{"Hindi topic keeps English default", "गांधी", "", "en.wikipedia.org"},
		{"Hindi requested", "गांधी", "hi", "hi.wikipedia.org"},
		{"English overrides Hindi script", "गांधी", "en", "en.wikipedia.org"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			title, extract := "Mahatma Gandhi", "Mohandas Karamchand Gandhi was a leader of the Indian independence movement."
			if tc.host == "hi.wikipedia.org" {
				title, extract = "महात्मा गांधी", "मोहनदास करमचन्द गांधी भारतीय स्वतन्त्रता आन्दोलन के नेता थे।"
			}
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != http.MethodGet || r.URL.Scheme != "https" || r.URL.Host != tc.host || r.Header.Get("User-Agent") != "Morning/1.0 (https://morning.atuls.me; contact@atuls.me)" {
					t.Fatalf("wrong Wikipedia request: %s", r.URL)
				}
				switch calls {
				case 1:
					if r.URL.Path != "/api/rest_v1/page/summary/"+tc.terms {
						t.Fatalf("did not try exact terms: %s", r.URL)
					}
					return lookupJSONResponse(404, `{"type":"not_found"}`), nil
				case 2:
					args := r.URL.Query()
					if r.URL.Path != "/w/api.php" || args.Get("action") != "opensearch" || args.Get("search") != tc.terms || args.Get("namespace") != "0" || args.Get("format") != "json" || args.Get("limit") != "4" {
						t.Fatalf("wrong opensearch endpoint or arguments: %s", r.URL)
					}
					body, _ := json.Marshal([]any{tc.terms, []string{title}, []string{"Not evidence."}, []string{"https://other.example/article"}})
					return lookupJSONResponse(200, string(body)), nil
				case 3:
					if r.URL.Path != "/api/rest_v1/page/summary/"+strings.ReplaceAll(title, " ", "_") {
						t.Fatalf("wrong single candidate summary: %s", r.URL)
					}
					return lookupJSONResponse(200, wikiSummaryFixture(t, title, "", extract, "http://other.example/article")), nil
				default:
					t.Fatalf("unexpected Wikipedia request: %s", r.URL)
					return nil, nil
				}
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: tc.terms, ReplyLanguage: tc.language}, "guest", "Asia/Kolkata")
			if err != nil || outcome.Result == nil || outcome.Result.Status != "answered" || calls != 3 {
				t.Fatalf("language lookup failed after %d calls: %+v, %v", calls, outcome, err)
			}
			if len(outcome.Result.Sources) != 1 || !strings.HasPrefix(outcome.Result.Sources[0].URL, "https://"+tc.host+"/wiki/") || outcome.Result.Answer != extract {
				t.Fatalf("wrong language source or summary: %+v", outcome.Result)
			}
		})
	}
}

func TestLookupWikiSourcesStayOnRequestedHTTPSArticleHost(t *testing.T) {
	for _, tc := range []struct {
		name, raw, want string
	}{
		{"preserve article URL", "https://en.wikipedia.org/wiki/Canonical_Name#History", "https://en.wikipedia.org/wiki/Canonical_Name"},
		{"missing", "", "https://en.wikipedia.org/wiki/Topic_Name"},
		{"external", "https://other.example/wiki/Topic", "https://en.wikipedia.org/wiki/Topic_Name"},
		{"other language", "https://hi.wikipedia.org/wiki/Topic", "https://en.wikipedia.org/wiki/Topic_Name"},
		{"HTTP", "http://en.wikipedia.org/wiki/Topic", "https://en.wikipedia.org/wiki/Topic_Name"},
		{"nonarticle path", "https://en.wikipedia.org/w/api.php", "https://en.wikipedia.org/wiki/Topic_Name"},
		{"empty article path", "https://en.wikipedia.org/wiki/", "https://en.wikipedia.org/wiki/Topic_Name"},
		{"credentials", "https://user@en.wikipedia.org/wiki/Topic", "https://en.wikipedia.org/wiki/Topic_Name"},
		{"port", "https://en.wikipedia.org:8443/wiki/Topic", "https://en.wikipedia.org/wiki/Topic_Name"},
		{"malformed", "https://en.wikipedia.org/wiki/%zz", "https://en.wikipedia.org/wiki/Topic_Name"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				return lookupJSONResponse(200, wikiSummaryFixture(t, "Topic Name", "", "A sourced summary.", tc.raw)), nil
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "Topic Name", ReplyLanguage: "en"}, "guest", "UTC")
			if err != nil || outcome.Result == nil || len(outcome.Result.Sources) != 1 || outcome.Result.Sources[0].URL != tc.want {
				t.Fatalf("wrong source: %+v, %v", outcome, err)
			}
		})
	}
}

func TestLookupWikiBoundsLongUnicodeOutput(t *testing.T) {
	title := strings.Repeat("लेख", 200)
	extract := strings.Repeat("जानकारी ", 1500)
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		return lookupJSONResponse(200, wikiSummaryFixture(t, title, strings.Repeat("विवरण ", 500), extract, "https://hi.wikipedia.org/wiki/Article")), nil
	})
	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "लेख", ReplyLanguage: "hi"}, "guest", "UTC")
	if err != nil || outcome.Result == nil || len(outcome.Result.Sources) != 1 {
		t.Fatalf("long summary failed: %+v, %v", outcome, err)
	}
	r := outcome.Result
	for _, field := range []struct {
		name, text string
		limit      int
	}{
		{"query", r.Query, 430}, {"answer", r.Answer, 2000}, {"speech", r.Speech, 240},
		{"source title", r.Sources[0].Title, 200}, {"excerpt", r.Sources[0].Excerpt, 1800},
	} {
		if !utf8.ValidString(field.text) || !validText(field.text, field.limit) {
			t.Errorf("%s exceeds its Unicode bound or is invalid: %d characters", field.name, utf8.RuneCountInString(field.text))
		}
	}
	if r.Status != "answered" || !strings.HasSuffix(r.Sources[0].Title, " - Wikipedia") || !strings.Contains(r.Answer, "जानकारी") || !strings.HasPrefix(extract, r.Sources[0].Excerpt) {
		t.Fatalf("lost source suffix or summary evidence: %+v", r)
	}
	if r.Speech != "उत्तर और स्रोत खोलकर देख सकते हैं।" {
		t.Fatalf("long extract needs localized generic speech, got %q", r.Speech)
	}
}

func TestLookupWikiLongQualifiedSentenceUsesLocalizedSpeechFallback(t *testing.T) {
	for _, tc := range []struct {
		name, language, host, extract, wantSpeech string
	}{
		{
			name: "English default", host: "en.wikipedia.org",
			extract:    "Early reports said the treatment improved outcomes " + strings.Repeat("in preliminary observations ", 12) + "but controlled studies did not confirm that claim.",
			wantSpeech: "The results and their sources are ready to open.",
		},
		{
			name: "Hindi requested", language: "hi", host: "hi.wikipedia.org",
			extract:    "शुरुआती रिपोर्ट में उपचार से लाभ बताया गया " + strings.Repeat("प्रारंभिक अवलोकनों के आधार पर ", 12) + "लेकिन नियंत्रित अध्ययनों ने इस दावे की पुष्टि नहीं की।",
			wantSpeech: "उत्तर और स्रोत खोलकर देख सकते हैं।",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != tc.host {
					t.Fatalf("wrong language host: %s", r.URL)
				}
				return lookupJSONResponse(200, wikiSummaryFixture(t, "Treatment", "", tc.extract, "https://"+tc.host+"/wiki/Treatment")), nil
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "Treatment", ReplyLanguage: tc.language}, "guest", "UTC")
			if err != nil || outcome.Result == nil || outcome.Result.Status != "answered" || len(outcome.Result.Sources) != 1 {
				t.Fatalf("qualified summary failed: %+v, %v", outcome, err)
			}
			r := outcome.Result
			if r.Answer != tc.extract || r.Sources[0].Excerpt != tc.extract {
				t.Fatalf("lost the sentence's qualification in saved evidence: %+v", r)
			}
			if r.Speech != tc.wantSpeech || strings.HasPrefix(tc.extract, r.Speech) {
				t.Fatalf("long qualified sentence must not be spoken as a cropped claim: %q", r.Speech)
			}
		})
	}
}

func TestLookupWikiMissingAndAmbiguousResults(t *testing.T) {
	for _, tc := range []struct {
		name, search, summary, language string
		finalMissing, direct            bool
		wantCalls, wantSources          int
	}{
		{name: "missing search", search: `["Mercury",[],[],[]]`, wantCalls: 2},
		{name: "single candidate also missing", search: `["Mercury",["Mercury (planet)"],["Not evidence."],["https://en.wikipedia.org/wiki/Mercury_(planet)"]]`, finalMissing: true, wantCalls: 3},
		{name: "multiple matches", search: `["Mercury",["Mercury (planet)","Mercury (element)","Mercury (mythology)","Mercury Records"],["Not evidence.","Not evidence.","Not evidence.","Not evidence."],["https://en.wikipedia.org/wiki/Mercury_(planet)","http://other.example/element","https://hi.wikipedia.org/wiki/Mercury","https://en.wikipedia.org/wiki/Mercury_Records"]]`, wantCalls: 2, wantSources: 3},
		{name: "direct disambiguation", direct: true, summary: `{"type":"disambiguation","title":"Mercury","extract":"Not evidence.","content_urls":{"desktop":{"page":"https://en.wikipedia.org/wiki/Mercury"}}}`, wantCalls: 1, wantSources: 1},
		{name: "single candidate disambiguation", search: `["Mercury",["Mercury"],["Not evidence."],["https://en.wikipedia.org/wiki/Mercury"]]`, summary: `{"type":"disambiguation","title":"Mercury","extract":"Not evidence."}`, wantCalls: 3, wantSources: 1},
		{name: "Hindi missing", language: "hi", search: `["Mercury",[],[],[]]`, wantCalls: 2},
		{name: "Hindi disambiguation", language: "hi", direct: true, summary: `{"type":"disambiguation","title":"Mercury","extract":"Not evidence."}`, wantCalls: 1, wantSources: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				calls++
				if calls > tc.wantCalls {
					t.Fatalf("must not pick an ambiguous candidate or retry: %s", r.URL)
				}
				if r.URL.Path == "/w/api.php" && r.URL.Query().Get("action") == "opensearch" {
					return lookupJSONResponse(200, tc.search), nil
				}
				if tc.direct || calls == 3 && !tc.finalMissing {
					return lookupJSONResponse(200, tc.summary), nil
				}
				return lookupJSONResponse(404, `{"type":"not_found"}`), nil
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "Mercury", ReplyLanguage: tc.language}, "guest", "UTC")
			if err != nil || outcome.Result == nil || outcome.Question != "" || outcome.Pending != nil {
				t.Fatalf("expected a saved empty result, got %+v, %v", outcome, err)
			}
			r := outcome.Result
			if r.Status != "empty" || r.Sources == nil || len(r.Sources) != tc.wantSources || calls != tc.wantCalls || r.Query != "Mercury" {
				t.Fatalf("wrong empty result after %d calls: %+v", calls, r)
			}
			if !validText(r.Answer, 2000) || !validText(r.Speech, 240) || strings.Contains(r.Answer+r.Speech, "Not evidence") {
				t.Fatalf("invalid or factual ambiguity message: %+v", r)
			}
			if tc.language == "hi" && (!hindiText(r.Answer) || !hindiText(r.Speech)) {
				t.Fatalf("missing Hindi empty message: %+v", r)
			}
			if tc.wantSources > 0 && tc.language == "" && !strings.Contains(r.Answer, "Please specify") {
				t.Fatalf("ambiguity needs a specific-topic request: %s", r.Answer)
			}
			host := "en.wikipedia.org"
			if tc.language == "hi" {
				host = "hi.wikipedia.org"
			}
			for _, source := range r.Sources {
				if !strings.HasPrefix(source.URL, "https://"+host+"/wiki/") || source.Excerpt != "" || !validText(source.Title, 200) {
					t.Fatalf("unsafe or factual ambiguity source: %+v", source)
				}
			}
		})
	}
}

type wikiTrackingBody struct {
	io.Reader
	read   int
	closed bool
}

func (b *wikiTrackingBody) Read(p []byte) (int, error) {
	n, err := b.Reader.Read(p)
	b.read += n
	return n, err
}

func (b *wikiTrackingBody) Close() error {
	b.closed = true
	return nil
}

func TestLookupWikiBoundsBodiesIncludingNotFoundAndSearch(t *testing.T) {
	for _, stage := range []string{"summary", "not found", "search", "fallback summary"} {
		for _, oversized := range []bool{false, true} {
			name := stage + "/at limit"
			if oversized {
				name = stage + "/oversized"
			}
			t.Run(name, func(t *testing.T) {
				calls := 0
				var tracked *wikiTrackingBody
				s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
					calls++
					status := http.StatusOK
					body := wikiSummaryFixture(t, "Topic", "", "A sourced summary.", "https://en.wikipedia.org/wiki/Topic")
					if calls == 1 && stage != "summary" {
						status, body = 404, `{"type":"not_found"}`
					} else if calls == 2 {
						body = `["Topic",["Topic"],[""],["https://en.wikipedia.org/wiki/Topic"]]`
						if stage == "not found" {
							body = `["Topic",[],[],[]]`
						}
					}
					target := stage == "summary" && calls == 1 || stage == "not found" && calls == 1 || stage == "search" && calls == 2 || stage == "fallback summary" && calls == 3
					response := lookupJSONResponse(status, body)
					if target {
						size := maxLookupBody
						if oversized {
							size += 10000
						}
						tracked = &wikiTrackingBody{Reader: strings.NewReader(body + strings.Repeat(" ", size-len(body)))}
						response.Body = tracked
					}
					return response, nil
				})
				outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "Topic"}, "guest", "UTC")
				if tracked == nil || !tracked.closed || tracked.read > maxLookupBody+1 {
					t.Fatalf("body was not bounded and closed: %+v", tracked)
				}
				if oversized {
					var failure *lookupError
					if !errors.As(err, &failure) || failure.Code != "lookup_invalid_response" || !failure.Retryable || outcome.Result != nil {
						t.Fatalf("oversized body became a result: %+v, %v", outcome, err)
					}
					wantCalls := 1
					if stage == "search" {
						wantCalls = 2
					} else if stage == "fallback summary" {
						wantCalls = 3
					}
					if calls != wantCalls || tracked.read != maxLookupBody+1 {
						t.Fatalf("oversized response triggered more work or wrong read cap: calls=%d bytes=%d", calls, tracked.read)
					}
				} else if err != nil || outcome.Result == nil {
					t.Fatalf("valid body at limit rejected: %+v, %v", outcome, err)
				}
			})
		}
	}
}

func TestLookupWikiMalformedResponsesAreRetryableErrors(t *testing.T) {
	for _, tc := range []struct {
		name, stage, body string
		status            int
	}{
		{"invalid JSON", "summary", `{`, 200},
		{"trailing JSON", "summary", `{"type":"standard","title":"Topic","extract":"Fact."}{}`, 200},
		{"missing type", "summary", `{"title":"Topic","extract":"Fact."}`, 200},
		{"unknown type", "summary", `{"type":"unexpected","title":"Topic","extract":"Fact."}`, 200},
		{"missing title", "summary", `{"type":"standard","extract":"Fact."}`, 200},
		{"empty extract", "summary", `{"type":"standard","title":"Topic","extract":"   "}`, 200},
		{"null summary", "summary", `null`, 200},
		{"missing disambiguation title", "summary", `{"type":"disambiguation","extract":"Not evidence."}`, 200},
		{"malformed 404", "summary", `{`, 404},
		{"null 404", "summary", `null`, 404},
		{"malformed search", "search", `{`, 200},
		{"provider search error", "search", `{"error":{"code":"internalerror"}}`, 200},
		{"short search tuple", "search", `["Topic",[]]`, 200},
		{"null titles", "search", `["Topic",null,[],[]]`, 200},
		{"wrong title type", "search", `["Topic",[5],[""],[""]]`, 200},
		{"empty candidate", "search", `["Topic",["  "],[""],[""]]`, 200},
		{"mismatched arrays", "search", `["Topic",["Topic"],[],[]]`, 200},
		{"unexpected search query", "search", `["Other",[],[],[]]`, 200},
		{"malformed fallback summary", "fallback", `{"type":"standard","title":"Topic"}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 && tc.stage != "summary" {
					return lookupJSONResponse(404, `{"type":"not_found"}`), nil
				}
				if calls == 2 && tc.stage == "fallback" {
					return lookupJSONResponse(200, `["Topic",["Topic"],[""],["https://en.wikipedia.org/wiki/Topic"]]`), nil
				}
				return lookupJSONResponse(tc.status, tc.body), nil
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "Topic"}, "guest", "UTC")
			var failure *lookupError
			if !errors.As(err, &failure) || failure.Code != "lookup_invalid_response" || !failure.Retryable || outcome.Result != nil {
				t.Fatalf("malformed response was masked as a result: %+v, %v", outcome, err)
			}
			wantCalls := 1
			if tc.stage == "search" {
				wantCalls = 2
			} else if tc.stage == "fallback" {
				wantCalls = 3
			}
			if calls != wantCalls {
				t.Fatalf("malformed response triggered extra requests: %d", calls)
			}
		})
	}
}

func TestLookupWikiProviderFailuresKeepExistingErrorsAndDeadline(t *testing.T) {
	for _, stage := range []int{1, 2, 3} {
		for _, tc := range []struct {
			name, code string
			status     int
			requestErr error
			bodyErr    error
		}{
			{name: "server failure", code: "lookup_unavailable", status: 503},
			{name: "quota", code: "lookup_quota_limited", status: 429},
			{name: "network failure", code: "lookup_unavailable", requestErr: errors.New("fixture connection failure")},
			{name: "deadline", code: "lookup_timeout", requestErr: context.DeadlineExceeded},
			{name: "body read failure", code: "lookup_unavailable", bodyErr: io.ErrUnexpectedEOF},
			{name: "body deadline", code: "lookup_timeout", bodyErr: context.DeadlineExceeded},
		} {
			t.Run(fmt.Sprintf("%s/request-%d", tc.name, stage), func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				deadline, _ := ctx.Deadline()
				calls := 0
				s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
					calls++
					if got, ok := r.Context().Deadline(); !ok || !got.Equal(deadline) {
						t.Fatalf("Wikipedia reset the existing deadline: %v", got)
					}
					if calls == stage {
						if tc.requestErr != nil {
							return nil, tc.requestErr
						}
						status := tc.status
						if status == 0 {
							status = 200
						}
						response := lookupJSONResponse(status, `{}`)
						response.Header.Set("Retry-After", "7")
						if tc.bodyErr != nil {
							response.Body = io.NopCloser(iotest.ErrReader(tc.bodyErr))
						}
						return response, nil
					}
					if calls == 1 {
						return lookupJSONResponse(404, `{"type":"not_found"}`), nil
					}
					return lookupJSONResponse(200, `["Topic",["Topic"],[""],["https://en.wikipedia.org/wiki/Topic"]]`), nil
				})
				outcome, err := s.lookup(ctx, lookupQuery{Kind: "wiki", Terms: "Topic"}, "guest", "UTC")
				var failure *lookupError
				if !errors.As(err, &failure) || failure.Code != tc.code || !failure.Retryable || outcome.Result != nil || calls != stage {
					t.Fatalf("provider failure was masked after %d calls: %+v, %v", calls, outcome, err)
				}
				if tc.status == 429 && failure.RetryAfter != 7 {
					t.Fatalf("lost provider retry delay: %+v", failure)
				}
			})
		}
	}
}

func TestLookupWikiRejectsRedirectsWithoutFollowingThem(t *testing.T) {
	for _, location := range []string{"https://other.example/collect", "https://en.wikipedia.org/wiki/Other"} {
		t.Run(location, func(t *testing.T) {
			calls := 0
			s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
				calls++
				if calls > 1 {
					t.Fatalf("Wikipedia followed a redirect: %s", r.URL)
				}
				response := lookupJSONResponse(http.StatusFound, `{}`)
				response.Header.Set("Location", location)
				return response, nil
			})
			outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "wiki", Terms: "Topic"}, "guest", "UTC")
			var failure *lookupError
			if !errors.As(err, &failure) || failure.Code != "lookup_unavailable" || !failure.Retryable || outcome.Result != nil || calls != 1 {
				t.Fatalf("redirect became a lookup result: %+v, %v", outcome, err)
			}
		})
	}
}
