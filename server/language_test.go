package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

// Offline fixture definitions. Transport stubs intercept every provider request.
func TestReplyLanguageUsesCurrentCommandRatherThanNamesOrQuotedContent(t *testing.T) {
	for _, tc := range []struct{ transcript, want string }{
		{"Write up a mail to Priya saying that I need slides for the morning meeting.", ""},
		{"Hi, draft Priya an email.", ""},
		{"What's the weather in Pune, Maharashtra, India?", ""},
		{"Draft Priya an email in Hindi asking for slides.", ""},
		{`Draft Priya an email saying "मुझे स्लाइड चाहिए".`, ""},
		{"Priya ko email likho ki mujhe slides chahiye.", "hi"},
		{"Pune mein abhi mausam kaisa hai?", "hi"},
		{"Pune ka mausam batao.", "hi"},
		{"मुझे दस मिनट में पानी पीने की याद दिलाना", "hi"},
		{"उसे ग्यारह बजे कर दो", "hi"},
	} {
		if got := replyLanguage(tc.transcript); got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.transcript, got, tc.want)
		}
	}
}

func TestEnglishDraftIgnoresUnsupportedHindiModelFlag(t *testing.T) {
	request := draftRequest()
	request.Transcript = "Write up a mail to Priya saying that I need slides for the morning meeting."
	request.DraftContext = &draftContext{ID: "draft:earlier", Subject: "पुराना ड्राफ्ट", Body: "मीटिंग की जानकारी", Recipient: "Priya", To: "priya.shah@example.com"}
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		var payload struct{ Messages []struct{ Content string } }
		if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload.Messages) != 2 || !strings.Contains(payload.Messages[0].Content, "For this turn, the response language is English.") {
			t.Fatal("English generation must be explicit on the current turn")
		}
		name := "Priya"
		return lookupIntentResponse(modelInterpretation{ReplyLanguage: "hi", RecipientName: &name, Actions: []action{{Type: "draft_email", ToContactID: "priya-shah", Subject: "Slides for the morning meeting", Body: "Hi Priya,\n\nPlease share the slides for the morning meeting.\n\nThanks!"}}}), nil
	})
	status, body := requestCommand(t, handler, request)
	var result commandResponse
	if json.Unmarshal([]byte(body), &result) != nil || status != 200 || len(result.Actions) != 1 || result.Actions[0].Type != "draft_email" || result.ReplyLanguage != "" || strings.Contains(body, "reply_language") {
		t.Fatalf("English draft must use the English confirmation despite provider drift: %d %s", status, body)
	}
}

func TestHindiAndHinglishReminderEnvelope(t *testing.T) {
	for _, transcript := range []string{"मुझे दस मिनट में पानी पीने की याद दिलाना", "mujhe dus minute mein paani peene ki yaad dilana"} {
		handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
			if r.URL.String() != groqCommandURL {
				t.Fatal("unexpected provider")
			}
			return lookupIntentResponse(modelInterpretation{ReplyLanguage: "hi", Actions: []action{{Type: "create_reminder", Title: "पानी पीना", DueAt: "2026-11-03T09:10:00+05:30"}}}), nil
		})
		request := mustLookupRequest(t)
		request.Transcript = transcript
		status, body := requestCommand(t, handler, request)
		var result commandResponse
		if json.Unmarshal([]byte(body), &result) != nil || status != 200 || result.ReplyLanguage != "hi" || len(result.Actions) != 1 || result.Actions[0].Title != "पानी पीना" {
			t.Fatalf("Hindi reminder failed: %d %s", status, body)
		}
	}
}

func TestHindiCorrectionKeepsSavedDateAndMeridiem(t *testing.T) {
	for _, transcript := range []string{"उसे ग्यारह बजे कर दो", "usko gyarah baje kar do", "उसे ११ बजे कर दो"} {
		for _, due := range []string{"2026-11-06T11:00:00+05:30", "2026-11-13T11:00:00+05:30", "2026-11-06T23:00:00+05:30"} {
			handler := fixtureAPI(t, func(*http.Request) (*http.Response, error) {
				return lookupIntentResponse(modelInterpretation{ReplyLanguage: "hi", Actions: []action{{Type: "reschedule_reminder", DueAt: due}}}), nil
			})
			var request commandRequest
			_ = json.Unmarshal([]byte(correctionRequest), &request)
			request.Transcript = transcript
			status, body := requestCommand(t, handler, request)
			if due == "2026-11-06T11:00:00+05:30" {
				if status != 200 || !strings.Contains(body, `"reminder_id":"draft-follow-up-1"`) {
					t.Fatalf("correction failed: %d %s", status, body)
				}
			} else if status != 422 {
				t.Fatalf("unsafe correction accepted: %d %s", status, body)
			}
		}
	}
}

func TestHindiPlaceQuestionPreservesReplyLanguage(t *testing.T) {
	s := lookupFixtureService(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("missing place must not call a provider")
		return nil, nil
	})
	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "hotels", ReplyLanguage: "hi"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Question != "कौन सा शहर या जगह?" || outcome.Pending.ReplyLanguage != "hi" {
		t.Fatalf("wrong question: %+v %v", outcome, err)
	}
	query, err := withLookupPlace(*outcome.Pending, "Jaipur railway station")
	if err != nil || query.ReplyLanguage != "hi" || query.Place != "Jaipur railway station" {
		t.Fatalf("lost continuation: %+v %v", query, err)
	}
	body, _ := json.Marshal(query)
	if strings.Contains(string(body), "reply_language") {
		t.Fatal("reply language must not become a search argument")
	}
}

func TestHindiWeatherAndTimeKeepSourcesAndDataTimes(t *testing.T) {
	for _, kind := range []string{"weather", "time"} {
		s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
			switch r.URL.Host {
			case "geocoding-api.open-meteo.com":
				return lookupJSONResponse(200, fixture(t, "open-meteo-pune.json")), nil
			case "api.open-meteo.com":
				return lookupJSONResponse(200, fixture(t, "open-meteo-current.json")), nil
			default:
				t.Fatal("unexpected provider")
				return nil, nil
			}
		})
		outcome, err := s.lookup(context.Background(), lookupQuery{Kind: kind, Place: "Pune", ReplyLanguage: "hi"}, "guest", "Asia/Kolkata")
		if err != nil || outcome.Result == nil {
			t.Fatalf("lookup failed: %v", err)
		}
		result := outcome.Result
		if !hindiText(result.Speech) || utf8.RuneCountInString(result.Speech) > 240 || result.Timezone != "Asia/Kolkata" || result.DataTime == "" || result.LookedUpAt == "" || len(result.Sources) == 0 {
			t.Fatalf("incomplete Hindi snapshot: %+v", result)
		}
		if kind == "weather" && (!strings.Contains(result.Answer, "°C") || !strings.Contains(result.Speech, "Open-Meteo")) {
			t.Fatal("weather lost units or credit")
		}
	}
}

func TestHindiCompoundCannotPartiallySave(t *testing.T) {
	for _, transcript := range []string{"Priya को ईमेल लिखो और मुझे दस मिनट में याद दिलाना", "Priya ko email likho aur mujhe dus minute mein yaad dilana", "Mujhe dus minute mein yaad dilana aur Priya ko email likho"} {
		result := interpretation{Actions: []action{{Type: "create_reminder"}}}
		if validateCommandCompleteness(result, transcript) == nil {
			t.Fatal("partial compound request accepted")
		}
	}
	for _, transcript := range []string{`Priya ko email likho "aur mujhe yaad dilana"`, "मुझे ईमेल और रिपोर्ट के बारे में याद दिलाना"} {
		if validateCommandCompleteness(interpretation{Actions: []action{{Type: "create_reminder"}}}, transcript) != nil {
			t.Fatal("quoted content or an email topic became a second action")
		}
	}
}

func TestHindiTranslationCannotInventVersion(t *testing.T) {
	sources := []lookupSource{{Title: "Go release", Excerpt: "Go 1.99.7 is the latest stable release."}}
	if !translationNumbersSupported("नवीनतम स्थिर Go रिलीज़ 1.99.7 है।", sources) || translationNumbersSupported("नवीनतम स्थिर Go रिलीज़ 1.99.8 है।", sources) {
		t.Fatal("version evidence check failed")
	}
}

func TestHindiSearchTranslatesOnlyTheSupportedAnswer(t *testing.T) {
	const answer = "Go 1.99.2 is the latest stable release."
	const translated = "नवीनतम स्थिर Go रिलीज़ 1.99.2 है।"
	s := lookupFixtureService(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != groqCommandURL {
			return fixtureMCP(t, r, fixture(t, "tavily-go-release.json"), func(args map[string]any) {
				if args["query"] != "latest stable Go release" || args["reply_language"] != nil {
					t.Fatal("search received more than needed")
				}
			}), nil
		}
		var payload struct{ Messages []struct{ Content string } }
		if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload.Messages) != 2 || !strings.Contains(payload.Messages[1].Content, `"reply_language":"hi"`) {
			t.Fatal("missing translation language")
		}
		content, _ := json.Marshal(map[string]any{"answer": answer, "translation": translated, "items": []any{evidenceItem(0, "Go downloads", answer)}})
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(content)}}}})
		return providerResponse(200, string(body)), nil
	})
	outcome, err := s.lookup(context.Background(), lookupQuery{Kind: "web", Terms: "latest stable Go release", ReplyLanguage: "hi"}, "guest", "Asia/Kolkata")
	if err != nil || outcome.Result == nil {
		t.Fatalf("search failed: %v", err)
	}
	result := outcome.Result
	if result.Answer != translated || result.Speech != translated || len(result.Sources) != 1 || result.Sources[0].Excerpt != answer || result.Sources[0].URL != "https://go.dev/dl/" {
		t.Fatalf("lost translated answer or original evidence: %+v", result)
	}
}

func TestHindiSpeechUsesExistingModelAndLanguageCode(t *testing.T) {
	t.Setenv("ELEVENLABS_API_KEY", "fixture-speech-key")
	t.Setenv("ELEVENLABS_VOICE_ID", "fixture-voice")
	handler := fixtureAPI(t, func(r *http.Request) (*http.Response, error) {
		var payload map[string]string
		if json.NewDecoder(r.Body).Decode(&payload) != nil || payload["language_code"] != "hi" || payload["model_id"] != "eleven_flash_v2_5" || payload["text"] != "रिमाइंडर सेव हो गया।" {
			t.Fatal("wrong Hindi speech payload")
		}
		response := providerResponse(200, fixture(t, "speech-silence.mp3"))
		response.Header.Set("Content-Type", "audio/mpeg")
		return response, nil
	})
	response := requestAPI(handler, "/api/speech", `{"text":"रिमाइंडर सेव हो गया।","language":"hi"}`)
	if response.Code != 200 {
		t.Fatalf("Hindi speech failed: %d", response.Code)
	}
}
