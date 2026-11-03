package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientAddressTrustsOnlyLoopbackCloudflareHeader(t *testing.T) {
	for _, tc := range []struct{ peer, header, want string }{
		{"127.0.0.1:1234", "198.51.100.10", "198.51.100.10"},
		{"[::1]:1234", "2001:db8::10", "2001:db8::10"},
		{"192.0.2.10:1234", "198.51.100.10", "192.0.2.10:1234"},
		{"127.0.0.1:1234", "198.51.100.10, 198.51.100.11", "127.0.0.1:1234"},
		{"127.0.0.1:1234", "", "127.0.0.1:1234"},
	} {
		r := httptest.NewRequest("POST", "/api/voice/token", nil)
		r.RemoteAddr = tc.peer
		r.Header.Set("CF-Connecting-IP", tc.header)
		r.Header.Set("X-Forwarded-For", "203.0.113.99")
		if got := clientAddress(r); got != tc.want {
			t.Errorf("peer %q, header %q: got %q, want %q", tc.peer, tc.header, got, tc.want)
		}
	}
}

func TestProxyVisitorsHaveSeparateLimitsAndShareGlobalCap(t *testing.T) {
	limiter := newRateLimiter(2, 3)
	now := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)
	request := func(ip string) int {
		r := httptest.NewRequest("POST", "/api/voice/token", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("CF-Connecting-IP", ip)
		return limiter.allow(clientAddress(r), now)
	}
	if request("198.51.100.1") != 0 || request("198.51.100.1") != 0 || request("198.51.100.1") == 0 {
		t.Fatal("expected the first visitor's per-client limit")
	}
	if request("198.51.100.2") != 0 || request("198.51.100.3") == 0 {
		t.Fatal("another visitor should have its own allowance, within the global cap")
	}
	if limiter.allow("198.51.100.1", now.Add(time.Minute)) != 0 {
		t.Fatal("allowances should reset in the next minute")
	}
}
