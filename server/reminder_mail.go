package main

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The owner explicitly pairs a browser. Neither the request nor the LLM can
// choose a recipient. The persisted queue lives outside deployed releases.
type reminderMailJob struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	DueAt    time.Time `json:"dueAt"`
	Revision int64     `json:"revision"`
}

type mailEntry struct {
	reminderMailJob
	Sent    bool      `json:"sent,omitempty"`
	RetryAt time.Time `json:"retryAt,omitempty"`
}

type reminderMailbox struct {
	mu                                  sync.Mutex
	address, password, token, directory string
}

var mailJobID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func newReminderMailbox() *reminderMailbox {
	address := strings.TrimSpace(os.Getenv("MORNING_GMAIL_ADDRESS"))
	password := strings.Join(strings.Fields(os.Getenv("MORNING_GMAIL_APP_PASSWORD")), "")
	token := os.Getenv("MORNING_REMINDER_OWNER_KEY")
	dir := os.Getenv("MORNING_REMINDER_STATE_DIR")
	if dir == "" {
		dir = "/var/lib/morning/reminder-email"
	}
	if address == "" || password == "" || len(token) < 32 {
		return nil
	}
	addr, err := mail.ParseAddress(address)
	if err != nil || addr.Address != address {
		log.Print("Reminder mail disabled: invalid sender address")
		return nil
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Print("Reminder mail disabled: queue directory unavailable")
		return nil
	}
	return &reminderMailbox{address: address, password: password, token: token, directory: dir}
}

func (m *reminderMailbox) schedule(w http.ResponseWriter, r *http.Request) {
	if m == nil {
		writeError(w, 503, "", "mail_unconfigured", "Reminder email is not configured.", false)
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(m.token)) != 1 {
		writeError(w, 403, "", "owner_required", "Enable your owner browser to schedule reminder emails.", false)
		return
	}
	var job reminderMailJob
	if !readJSON(w, r, &job, 4096) {
		return
	}
	if !mailJobID.MatchString(job.ID) || !utf8.ValidString(job.Title) || strings.TrimSpace(job.Title) == "" || len([]rune(job.Title)) > 240 || strings.ContainsAny(job.Title, "\r\n\x00") || job.DueAt.IsZero() || job.Revision < 1 {
		writeError(w, 400, "", "invalid_reminder", "Provide a valid saved reminder and due time.", false)
		return
	}
	if err := m.upsert(job); err != nil {
		writeError(w, 503, "", "mail_queue_unavailable", "Could not save the email schedule. Please retry.", true)
		return
	}
	writeJSON(w, 200, map[string]string{"status": "scheduled"})
}

func (m *reminderMailbox) upsert(job reminderMailJob) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	path := filepath.Join(m.directory, job.ID+".json")
	entry, err := readMailEntry(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if entry.Revision >= job.Revision {
		return nil
	}
	// Editing the title of an already delivered reminder does not rearm it.
	sent := entry.Sent && entry.DueAt.Equal(job.DueAt)
	return saveMailEntry(path, mailEntry{reminderMailJob: job, Sent: sent})
}

func readMailEntry(path string) (entry mailEntry, err error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return entry, err
	}
	err = json.Unmarshal(b, &entry)
	return
}

func saveMailEntry(path string, entry mailEntry) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".pending-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	err = json.NewEncoder(tmp).Encode(entry)
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp.Name(), path)
}

func (m *reminderMailbox) run(ctx context.Context) {
	if m == nil {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		files, err := filepath.Glob(filepath.Join(m.directory, "*.json"))
		if err == nil {
			for _, file := range files {
				if ctx.Err() != nil {
					return
				}
				m.deliver(file)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (m *reminderMailbox) deliver(path string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, err := readMailEntry(path)
	now := time.Now()
	if err != nil || entry.Sent || entry.DueAt.After(now) || entry.RetryAt.After(now) {
		return
	}
	// Persist a retry delay before contacting SMTP so a crash does not cause
	// a tight resend loop. A stable Message-ID follows retries.
	entry.RetryAt = now.Add(5 * time.Minute)
	if saveMailEntry(path, entry) != nil {
		return
	}
	if err := m.send(entry); err != nil {
		log.Print("Gmail reminder delivery deferred")
		return
	}
	entry.Sent = true
	if err := saveMailEntry(path, entry); err != nil {
		log.Print("Could not record Gmail reminder delivery")
	}
}

func (m *reminderMailbox) send(entry mailEntry) error {
	const host = "smtp.gmail.com"
	conn, err := net.DialTimeout("tcp", host+":587", 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err = conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer client.Close()
	if err = client.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err != nil {
		return err
	}
	if err = client.Auth(smtp.PlainAuth("", m.address, m.password, host)); err != nil {
		return err
	}
	if err = client.Mail(m.address); err != nil {
		return err
	}
	if err = client.Rcpt(m.address); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	subject := mime.QEncoding.Encode("utf-8", "Morning reminder: "+entry.Title)
	message := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s.%d@morning.atuls.me>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n%s\r\nDue: %s\r\n", m.address, m.address, subject, time.Now().Format(time.RFC1123Z), entry.ID, entry.DueAt.UnixMilli(), entry.Title, entry.DueAt.Format(time.RFC1123Z))
	if _, err = writer.Write([]byte(message)); err != nil {
		return err
	}
	return writer.Close()
}
