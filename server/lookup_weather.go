package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	openMeteoGeocodingURL = "https://geocoding-api.open-meteo.com/v1/search"
	openMeteoWeatherURL   = "https://api.open-meteo.com/v1/forecast"
)

type lookupPlace struct {
	Name        string   `json:"name"`
	Admin1      string   `json:"admin1"`
	Country     string   `json:"country"`
	CountryCode string   `json:"country_code"`
	Timezone    string   `json:"timezone"`
	FeatureCode string   `json:"feature_code"`
	Population  int      `json:"population"`
	Latitude    *float64 `json:"latitude"`
	Longitude   *float64 `json:"longitude"`
}

func (p lookupPlace) label() string {
	parts := []string{p.Name}
	if p.Admin1 != "" && !strings.EqualFold(p.Admin1, p.Name) {
		parts = append(parts, p.Admin1)
	}
	if p.Country != "" && !strings.EqualFold(p.Country, p.Name) {
		parts = append(parts, p.Country)
	}
	return strings.Join(parts, ", ")
}

func (s *lookupService) geocode(ctx context.Context, place string) ([]lookupPlace, error) {
	parts := strings.Split(place, ",")
	name := strings.Trim(strings.TrimSpace(parts[0]), ".?!")
	args := url.Values{"name": {name}, "count": {"5"}, "language": {"en"}, "format": {"json"}}
	var response struct {
		Results []lookupPlace `json:"results"`
	}
	if err := s.lookupGET(ctx, openMeteoGeocodingURL, args, &response); err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var matches []lookupPlace
	for _, candidate := range response.Results {
		if !validText(candidate.Name, 100) || !validText(candidate.Country, 100) || candidate.Latitude == nil || candidate.Longitude == nil || math.Abs(*candidate.Latitude) > 90 || math.Abs(*candidate.Longitude) > 180 {
			continue
		}
		if !strings.EqualFold(candidate.Name, name) {
			continue
		}
		if _, err := time.LoadLocation(candidate.Timezone); err != nil || candidate.Timezone == "" || candidate.Timezone == "Local" {
			continue
		}
		if candidate.Admin1 != "" && !validText(candidate.Admin1, 100) {
			continue
		}
		label := candidate.label()
		qualified := true
		for _, qualifier := range parts[1:] {
			qualifier = strings.Trim(strings.TrimSpace(qualifier), ".?!")
			if qualifier == "" || !(strings.EqualFold(qualifier, candidate.CountryCode) || strings.EqualFold(qualifier, candidate.Country) || strings.EqualFold(qualifier, candidate.Admin1)) {
				qualified = false
			}
		}
		if qualified && !seen[label] {
			matches = append(matches, candidate)
			seen[label] = true
		}
	}
	// A unique major city such as Tokyo is not ambiguous with a small namesake.
	// Comparable candidates remain a spoken follow-up instead of a guess.
	if len(matches) > 1 && matches[0].Population >= 100000 {
		dominant := true
		for _, candidate := range matches[1:] {
			if matches[0].Population < 20*candidate.Population || candidate.Population == 0 {
				dominant = false
			}
		}
		if dominant {
			matches = matches[:1]
		}
	}
	return matches, nil
}

func (s *lookupService) placeLookup(ctx context.Context, q lookupQuery, now time.Time) (lookupOutcome, error) {
	places, err := s.geocode(ctx, q.Place)
	if err != nil {
		return lookupOutcome{}, err
	}
	if len(places) == 0 {
		return lookupQuestion(q, "I couldn't resolve that place. Which city and country?"), nil
	}
	if len(places) > 1 {
		var labels []string
		for _, place := range places {
			labels = append(labels, place.label())
			if len(labels) == lookupResultCap {
				break
			}
		}
		question := "Which place: " + strings.Join(labels, " or ") + "?"
		if !validText(question, maxSpeechChars) {
			question = "Which region and country is that city in?"
		}
		outcome := lookupQuestion(q, question)
		outcome.Pending.City = places[0].Name
		return outcome, nil
	}
	place := places[0]
	if !strings.HasPrefix(place.FeatureCode, "PPL") {
		// Country geocoding often supplies only a representative timezone. Never
		// use it for countries with multiple zones, such as the US or Australia.
		singleZone := map[string]bool{"IN": true, "JP": true, "SG": true, "NP": true, "LK": true, "BD": true}
		if q.Kind == "weather" || place.FeatureCode != "PCLI" || !singleZone[place.CountryCode] {
			return lookupQuestion(q, "Which city?"), nil
		}
	}
	location, _ := time.LoadLocation(place.Timezone)
	result := &lookupResult{Kind: q.Kind, Query: q.Place, Status: "answered", Timezone: place.Timezone}
	var spoken string
	if q.Kind == "time" {
		local := s.clock().In(location)
		result.DataTime = local.Format(time.RFC3339)
		result.Answer = fmt.Sprintf("It's %s on %s in %s, %s.", local.Format("3:04 PM"), local.Format("2 January"), place.Name, place.Timezone)
		spoken = fmt.Sprintf("It's %s on %s in %s.", local.Format("3:04 PM"), local.Format("2 January"), place.Name)
		result.Sources = []lookupSource{{Title: "IANA time zone database", URL: "https://www.iana.org/time-zones", Publisher: "IANA"}, {Title: "Place resolved by Open-Meteo / GeoNames", URL: "https://open-meteo.com/en/docs/geocoding-api", Publisher: "Open-Meteo / GeoNames"}}
	} else {
		args := url.Values{
			"latitude": {fmt.Sprint(*place.Latitude)}, "longitude": {fmt.Sprint(*place.Longitude)},
			"current": {"temperature_2m,weather_code"}, "temperature_unit": {"celsius"},
			"timezone": {place.Timezone}, "timeformat": {"unixtime"},
		}
		var weather struct {
			Timezone string `json:"timezone"`
			Current  struct {
				Time        *int64   `json:"time"`
				Temperature *float64 `json:"temperature_2m"`
				Code        *int     `json:"weather_code"`
			} `json:"current"`
			Units struct {
				Temperature string `json:"temperature_2m"`
				Time        string `json:"time"`
			} `json:"current_units"`
		}
		if err := s.lookupGET(ctx, openMeteoWeatherURL, args, &weather); err != nil {
			return lookupOutcome{}, err
		}
		if weather.Timezone != place.Timezone || weather.Current.Time == nil || weather.Current.Temperature == nil || weather.Current.Code == nil || weather.Units.Temperature != "°C" || weather.Units.Time != "unixtime" {
			return lookupOutcome{}, errInvalidProviderOutput
		}
		dataTime := time.Unix(*weather.Current.Time, 0).In(location)
		if dataTime.Before(now.Add(-2*time.Hour)) || dataTime.After(now.Add(15*time.Minute)) || math.Abs(*weather.Current.Temperature) > 100 {
			return lookupOutcome{}, errInvalidProviderOutput
		}
		conditions, ok := weatherConditions[*weather.Current.Code]
		if !ok {
			return lookupOutcome{}, errInvalidProviderOutput
		}
		result.DataTime = dataTime.Format(time.RFC3339)
		result.Answer = fmt.Sprintf("%s: %s, %.1f °C, as of %s local time, %s. Weather by Open-Meteo.", place.label(), conditions, *weather.Current.Temperature, dataTime.Format("3:04 PM on 2 January"), place.Timezone)
		spoken = fmt.Sprintf("%s in %s, %.1f degrees Celsius, as of %s local time, from Open-Meteo.", conditions, place.Name, *weather.Current.Temperature, dataTime.Format("3:04 PM"))
		result.Sources = []lookupSource{{Title: "Current weather from Open-Meteo", URL: openMeteoWeatherURL + "?" + args.Encode(), Publisher: "Open-Meteo"}, {Title: "Place data from GeoNames via Open-Meteo", URL: "https://open-meteo.com/en/docs/geocoding-api", Publisher: "Open-Meteo / GeoNames"}}
	}
	result.Speech = lookupSentence(spoken)
	return lookupOutcome{Result: result}, nil
}

func (s *lookupService) lookupGET(ctx context.Context, endpoint string, args url.Values, dst any) error {
	r, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+args.Encode(), nil)
	r.Header.Set("Accept", "application/json")
	response, err := s.client.Do(r)
	if err != nil {
		return providerRequestError(err)
	}
	defer response.Body.Close()
	if err := lookupHTTPError(response.StatusCode); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxLookupBody+1))
	if err != nil {
		return providerRequestError(err)
	}
	if len(data) > maxLookupBody || json.Unmarshal(data, dst) != nil {
		return errInvalidProviderOutput
	}
	return nil
}

var weatherConditions = map[int]string{
	0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "rime fog",
	51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "light freezing drizzle", 57: "heavy freezing drizzle",
	61: "light rain", 63: "rain", 65: "heavy rain", 66: "light freezing rain", 67: "heavy freezing rain",
	71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light rain showers", 81: "rain showers", 82: "heavy rain showers",
	85: "light snow showers", 86: "heavy snow showers", 95: "thunderstorms", 96: "thunderstorms with light hail", 99: "thunderstorms with heavy hail",
}
