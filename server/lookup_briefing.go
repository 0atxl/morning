package main

import (
	"context"
	"time"
)

func (s *lookupService) lookupBriefing(ctx context.Context, q lookupQuery, now time.Time) (lookupOutcome, error) {
	// Use the same validated city choice, observation time, units and condition
	// codes as weather. A timezone is not evidence of the guest's city.
	outcome, err := s.placeLookup(ctx, q, now)
	if err != nil || outcome.Result == nil {
		return outcome, err
	}
	result := outcome.Result
	result.Sources = result.Sources[:1] // Leave room for two headline citations.
	location, _ := time.LoadLocation(result.Timezone)
	date := now.In(location).Format("Monday, 2 January 2006")
	newsText := "Headlines are unavailable right now."
	newsSpeech := newsText
	if q.ReplyLanguage == "hi" {
		date = now.In(location).Format("02-01-2006")
		newsText = "अभी समाचार उपलब्ध नहीं हैं।"
		newsSpeech = newsText
	}
	if s.tavilyKey != "" {
		news, newsErr := s.searchLookup(ctx, lookupQuery{
			Kind: "news", Terms: "news", Place: outcome.ResolvedPlace, Today: true, ReplyLanguage: q.ReplyLanguage,
		}, now, location)
		if newsErr == nil && news.Result != nil {
			newsText = news.Result.Answer
			result.WindowStart, result.WindowEnd = news.Result.WindowStart, news.Result.WindowEnd
			if news.Result.Status == "answered" {
				newsSpeech = "Headlines are included below."
				if q.ReplyLanguage == "hi" {
					newsSpeech = "समाचार नीचे दिए गए हैं।"
				}
				for _, source := range news.Result.Sources {
					result.Sources = append(result.Sources, source)
					if len(result.Sources) == lookupResultCap {
						break
					}
				}
			} else {
				newsSpeech = "No confirmed headlines were found for today."
				if q.ReplyLanguage == "hi" {
					newsSpeech = "आज की पुष्टि वाली कोई खबर नहीं मिली।"
				}
			}
		}
	}
	if q.ReplyLanguage == "hi" {
		result.Answer = "शुभ प्रभात! " + date + " की ब्रीफिंग:\n\n" + result.Answer + "\n\nसमाचार: " + newsText
		speech := "शुभ प्रभात! " + result.Speech + " " + newsSpeech
		if !validText(speech, maxSpeechChars) {
			speech = "शुभ प्रभात! मौसम की जानकारी तैयार है। " + newsSpeech
		}
		result.Speech = speech
	} else {
		result.Answer = "Good morning! Your briefing for " + date + ":\n\n" + result.Answer + "\n\nHeadlines: " + newsText
		speech := "Good morning! " + result.Speech + " " + newsSpeech
		if !validText(speech, maxSpeechChars) {
			speech = "Good morning! Your weather briefing is ready. " + newsSpeech
		}
		result.Speech = speech
	}
	return outcome, nil
}
