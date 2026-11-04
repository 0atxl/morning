package main

import (
	"math"
	"net"
	"net/http"
	"sync"
	"time"
)

// The production origin is loopback-only behind nginx and Cloudflare Tunnel.
// Cloudflare overwrites CF-Connecting-IP; nginx forwards it unchanged. Never
// trust it from a direct non-loopback peer, or use a guest's X-Forwarded-For.
func clientAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		peer := net.ParseIP(host)
		if peer != nil && peer.IsLoopback() {
			if client := net.ParseIP(r.Header.Get("CF-Connecting-IP")); client != nil {
				return client.String()
			}
			if client := net.ParseIP(r.Header.Get("X-Real-IP")); client != nil {
				return client.String()
			}
		}
	}
	return r.RemoteAddr
}

// Counters reset each UTC minute. The global cap also bounds the IP map's size.
type rateLimiter struct {
	mu                   sync.Mutex
	window               time.Time
	byIP                 map[string]int
	total                int
	perIPLimit, maxTotal int
}

func newRateLimiter(perIP, total int) *rateLimiter {
	return &rateLimiter{perIPLimit: perIP, maxTotal: total}
}

func (l *rateLimiter) allow(remoteAddr string, now time.Time) int {
	ip, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		ip = remoteAddr
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	window := now.UTC().Truncate(time.Minute)
	if !window.Equal(l.window) {
		l.window, l.total, l.byIP = window, 0, make(map[string]int)
	}
	if l.total >= l.maxTotal || l.byIP[ip] >= l.perIPLimit {
		return int(math.Ceil(window.Add(time.Minute).Sub(now).Seconds()))
	}
	l.total++
	l.byIP[ip]++
	return 0
}
