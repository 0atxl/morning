package main

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"
)

func timezoneCity(timezone string) string {
	parts := strings.Split(timezone, "/")
	if len(parts) == 0 {
		return ""
	}
	city := parts[len(parts)-1]
	city = strings.ReplaceAll(city, "_", " ")
	return strings.TrimSpace(city)
}

func (s *lookupService) lookupBriefing(ctx context.Context, q lookupQuery, visitor, timezone string) (lookupOutcome, error) {
	location, err := time.LoadLocation(timezone)
	if err != nil || timezone == "" || timezone == "Local" {
		return lookupOutcome{}, fmt.Errorf("a valid IANA timezone is required")
	}
	now := s.clock().In(location)
	targetPlace := strings.TrimSpace(q.Place)
	if targetPlace == "" {
		targetPlace = timezoneCity(timezone)
	}
	if targetPlace == "" {
		targetPlace = "Kolkata"
	}

	places, err := s.geocode(ctx, targetPlace)
	if err != nil {
		return lookupOutcome{}, err
	}
	if len(places) == 0 {
		return lookupQuestion(q, "Which city would you like your morning briefing for?"), nil
	}
	place := places[0]

	args := url.Values{
		"latitude":         {fmt.Sprint(*place.Latitude)},
		"longitude":        {fmt.Sprint(*place.Longitude)},
		"current":          {"temperature_2m,weather_code"},
		"temperature_unit": {"celsius"},
		"timezone":         {place.Timezone},
		"timeformat":       {"unixtime"},
	}
	var weather struct {
		Current struct {
			Time        *int64   `json:"time"`
			Temperature *float64 `json:"temperature_2m"`
			Code        *int     `json:"weather_code"`
		} `json:"current"`
	}
	if err := s.lookupGET(ctx, openMeteoWeatherURL, args, &weather); err != nil {
		return lookupOutcome{}, err
	}
	if weather.Current.Temperature == nil || weather.Current.Code == nil || math.Abs(*weather.Current.Temperature) > 100 {
		return lookupOutcome{}, errInvalidProviderOutput
	}

	condition, ok := weatherConditions[*weather.Current.Code]
	if !ok {
		condition = "Clear"
	}
	temp := *weather.Current.Temperature

	sources := []lookupSource{
		{
			Title:     "Weather by Open-Meteo",
			URL:       openMeteoWeatherURL + "?" + args.Encode(),
			Publisher: "Open-Meteo",
		},
	}

	var headlines []string
	if s.tavilyKey != "" {
		newsArgs := map[string]any{
			"query":          place.Name + " news",
			"topic":          "news",
			"search_depth":   "advanced",
			"max_results":    2,
			"time_range":     "d",
			"include_images": false,
		}
		if newsSources, err := s.tavilySearch(ctx, newsArgs); err == nil && len(newsSources) > 0 {
			for _, ns := range newsSources {
				if validText(ns.Title, 200) {
					headlines = append(headlines, ns.Title)
					sources = append(sources, ns)
				}
				if len(headlines) == 2 {
					break
				}
			}
		}
	}

	dateStr := now.Format("Monday, 2 January 2006")
	timeStr := now.Format("3:04 PM")

	var answerText, spokenText string
	if q.ReplyLanguage == "hi" {
		hindiCond := hindiWeatherConditions[*weather.Current.Code]
		if hindiCond == "" {
			hindiCond = "साफ़"
		}
		spokenText = fmt.Sprintf("शुभ प्रभात! %s में अभी तापमान %.1f डिग्री सेल्सियस और %s है। आपका दिन शुभ हो!", place.Name, temp, hindiCond)
		answerText = fmt.Sprintf("शुभ प्रभात! %s के लिए आपका दैनिक ब्रीफिंग (%s):\n\nमौसम: %s, %.1f °C (%s बजे के अनुसार)। स्रोत: Open-Meteo।",
			place.label(), dateStr, hindiCond, temp, hindiClock(now))
		if len(headlines) > 0 {
			answerText += "\n\nप्रमुख समाचार:\n"
			for _, h := range headlines {
				answerText += "• " + h + "\n"
			}
		}
	} else {
		if len(headlines) > 0 {
			spokenText = fmt.Sprintf("Good morning! In %s it's %.1f degrees Celsius and %s. Top news: %s. Have a great day!", place.Name, temp, strings.ToLower(condition), headlines[0])
		} else {
			spokenText = fmt.Sprintf("Good morning! In %s it's currently %.1f degrees Celsius and %s. Have a great day!", place.Name, temp, strings.ToLower(condition))
		}
		if len([]rune(spokenText)) > maxSpeechChars {
			spokenText = fmt.Sprintf("Good morning! In %s it's currently %.1f degrees Celsius and %s. Have a great day!", place.Name, temp, strings.ToLower(condition))
		}
		if len([]rune(spokenText)) > maxSpeechChars {
			spokenText = fmt.Sprintf("Good morning! Here is your daily briefing for %s.", place.Name)
		}
		answerText = fmt.Sprintf("Good morning! Here is your daily briefing for %s (%s, %s):\n\nWeather: %s, %.1f °C\nLocal time: %s",
			place.label(), dateStr, timeStr, condition, temp, timeStr)
		if len(headlines) > 0 {
			answerText += "\n\nTop Headlines:\n"
			for _, h := range headlines {
				answerText += "• " + h + "\n"
			}
		}
		answerText += "\nWeather provided by Open-Meteo."
	}

	result := &lookupResult{
		Kind:       "briefing",
		Query:      q.Place,
		Status:     "answered",
		Answer:     strings.TrimSpace(answerText),
		Speech:     lookupSentence(spokenText),
		Sources:    sources,
		LookedUpAt: now.Format(time.RFC3339),
		Timezone:   place.Timezone,
		DataTime:   now.Format(time.RFC3339),
	}
	if result.Query == "" {
		result.Query = place.Name
	}

	return lookupOutcome{Result: result}, nil
}
