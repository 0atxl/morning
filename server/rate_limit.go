package main

import (
	"math"
	"net"
	"sync"
	"time"
)

// Counters reset each UTC minute. The global cap also bounds the IP map's size.
// Only RemoteAddr is trusted; forwarding headers supplied by guests are ignored.
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
