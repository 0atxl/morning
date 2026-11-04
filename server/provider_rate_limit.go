package main

import (
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	defaultProviderRetryAfter = 60
	maxProviderRetryAfter     = 7 * 24 * 60 * 60
)

// Retain safe timing metadata, never the provider body or raw headers. Unwrap
// preserves existing rate-limit classification and prevents generation repair.
type providerRateLimitError struct{ retryAfter int }

func (e *providerRateLimitError) Error() string { return errProviderRateLimited.Error() }
func (e *providerRateLimitError) Unwrap() error { return errProviderRateLimited }

func providerRetryAfter(err error) int {
	var limited *providerRateLimitError
	if errors.As(err, &limited) && limited != nil && limited.retryAfter > 0 && limited.retryAfter <= maxProviderRetryAfter {
		return limited.retryAfter
	}
	return defaultProviderRetryAfter
}

func providerRetrySeconds(value string, now time.Time) int {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && !math.IsNaN(seconds) && !math.IsInf(seconds, 0) && seconds >= 0 && seconds <= maxProviderRetryAfter {
		return max(1, int(math.Ceil(seconds)))
	}
	if date, err := http.ParseTime(value); err == nil {
		seconds := date.Sub(now).Seconds()
		if seconds > 0 && seconds <= maxProviderRetryAfter {
			return int(math.Ceil(seconds))
		}
	}
	// No valid upstream reset was supplied. This is a conservative retry
	// fallback, not a claim that the account's quota resets in one minute.
	return defaultProviderRetryAfter
}
