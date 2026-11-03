package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestReminderMailEditsAndReplays(t *testing.T) {
	m := &reminderMailbox{directory: t.TempDir()}
	job := reminderMailJob{ID: "reminder-1", Title: "Drink water", DueAt: time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC), Revision: 1}
	path := filepath.Join(m.directory, job.ID+".json")
	if err := saveMailEntry(path, mailEntry{reminderMailJob: job, Sent: true}); err != nil {
		t.Fatal(err)
	}
	edited := job
	edited.Title = "Drink some water"
	edited.Revision++
	if err := m.upsert(edited); err != nil {
		t.Fatal(err)
	}
	entry, err := readMailEntry(path)
	if err != nil || !entry.Sent {
		t.Fatalf("editing title rearmed a delivered reminder: %v", err)
	}
	edited.DueAt = edited.DueAt.Add(time.Minute)
	edited.Revision++
	if err := m.upsert(edited); err != nil {
		t.Fatal(err)
	}
	if err := m.upsert(job); err != nil {
		t.Fatal(err)
	}
	// A replacement process reads the same durable schedule.
	restarted := &reminderMailbox{directory: m.directory}
	entry, err = readMailEntry(filepath.Join(restarted.directory, job.ID+".json"))
	if err != nil || entry.Sent || entry.reminderMailJob != edited {
		t.Fatalf("unexpected edited schedule: %#v, %v", entry, err)
	}
}

func TestGuestCannotScheduleOwnerMail(t *testing.T) {
	m := &reminderMailbox{directory: t.TempDir(), token: "owner-key"}
	response := httptest.NewRecorder()
	m.schedule(response, httptest.NewRequest(http.MethodPost, "/api/reminder-email", nil))
	if response.Code != http.StatusForbidden {
		t.Fatalf("guest was not rejected: %d", response.Code)
	}
}
