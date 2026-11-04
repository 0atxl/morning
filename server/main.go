package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"
)

func main() {
	deepgramKey, groqKey := os.Getenv("DEEPGRAM_API_KEY"), os.Getenv("GROQ_API_KEY")
	if deepgramKey == "" || groqKey == "" {
		log.Fatal("Set DEEPGRAM_API_KEY and GROQ_API_KEY in the server environment.")
	}
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	p := &providers{
		client:      &http.Client{Timeout: 20 * time.Second},
		deepgramKey: deepgramKey,
		groqKey:     groqKey,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	mailbox := newReminderMailbox()
	go mailbox.run(ctx)
	server := &http.Server{
		Addr:              addr,
		Handler:           newAPIWithMailbox(p, time.Now, mailbox),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      35 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			log.Print("Morning API shutdown timed out.")
		}
	}()
	log.Printf("Morning API listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-shutdownDone
}
