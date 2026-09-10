package api

import (
	"sync"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
)

type recordingShutdownConnection struct {
	mutex        sync.Mutex
	writeCalls   int
	closeCalls   int
	code         int
	deadline     time.Time
	writeErr     error
	blockWrite   chan struct{}
	writeStarted chan struct{}
}

func (c *recordingShutdownConnection) WriteControl(messageType int, data []byte, deadline time.Time) error {
	c.mutex.Lock()
	c.writeCalls++
	c.deadline = deadline
	c.mutex.Unlock()
	if c.writeStarted != nil {
		close(c.writeStarted)
	}
	if c.blockWrite != nil {
		<-c.blockWrite
	}
	if messageType == ws.CloseMessage && len(data) >= 2 {
		c.mutex.Lock()
		c.code = int(data[0])<<8 | int(data[1])
		c.mutex.Unlock()
	}
	return c.writeErr
}

func (c *recordingShutdownConnection) Close() error {
	c.mutex.Lock()
	c.closeCalls++
	c.mutex.Unlock()
	return nil
}

func (c *recordingShutdownConnection) counts() (writes, closes, code int) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	return c.writeCalls, c.closeCalls, c.code
}

func TestLifecycleShutdownNotifiesHealthyConnections(t *testing.T) {
	lifecycle := NewLifecycle()
	first := &recordingShutdownConnection{}
	second := &recordingShutdownConnection{}
	if !lifecycle.Track(first) || !lifecycle.Track(second) {
		t.Fatal("track healthy connections")
	}
	before := time.Now()
	deadline := before.Add(WebsocketCloseWriteTimeout)
	done := make(chan bool, 1)
	go func() {
		done <- lifecycle.Shutdown(deadline)
	}()
	// Simulate handler workers finishing after the close frame is written.
	// Untrack must happen after Shutdown snapshots, mirroring production
	// where handlers exit in response to the socket close.
	for _, connection := range []*recordingShutdownConnection{first, second} {
		deadline := time.Now().Add(2 * time.Second)
		for {
			writes, _, _ := connection.counts()
			if writes > 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("timed out waiting for close frame")
			}
			time.Sleep(time.Millisecond)
		}
		lifecycle.Untrack(connection)
	}
	if !<-done {
		t.Fatal("shutdown did not complete before deadline")
	}
	for index, connection := range []*recordingShutdownConnection{first, second} {
		writes, closes, code := connection.counts()
		if writes != 1 || closes != 1 {
			t.Errorf("connection %d writes=%d closes=%d, want 1 and 1", index, writes, closes)
		}
		if code != ws.CloseGoingAway {
			t.Errorf("connection %d close code=%d, want %d", index, code, ws.CloseGoingAway)
		}
		if connection.deadline.Before(before) || connection.deadline.After(deadline.Add(time.Second)) {
			t.Errorf("connection %d deadline=%v, want shared deadline %v", index, connection.deadline, deadline)
		}
	}
}

func TestLifecycleShutdownSharesOneDeadlineAcrossConnections(t *testing.T) {
	lifecycle := NewLifecycle()
	first := &recordingShutdownConnection{}
	second := &recordingShutdownConnection{}
	if !lifecycle.Track(first) || !lifecycle.Track(second) {
		t.Fatal("track connections")
	}
	deadline := time.Now().Add(WebsocketCloseWriteTimeout)
	go func() {
		lifecycle.Untrack(first)
		lifecycle.Untrack(second)
	}()
	if !lifecycle.Shutdown(deadline) {
		t.Fatal("shutdown did not complete")
	}
	if !first.deadline.Equal(deadline) || !second.deadline.Equal(deadline) {
		t.Errorf("deadlines = %v and %v, want shared %v", first.deadline, second.deadline, deadline)
	}
}

func TestLifecycleRejectsNewConnectionsDuringShutdown(t *testing.T) {
	lifecycle := NewLifecycle()
	stuck := &recordingShutdownConnection{}
	if !lifecycle.Track(stuck) {
		t.Fatal("track connection")
	}
	deadline := time.Now().Add(100 * time.Millisecond)
	done := make(chan bool, 1)
	go func() {
		done <- lifecycle.Shutdown(deadline)
	}()
	// Wait until Shutdown has marked the lifecycle so the racing admission
	// observes the shutting-down state.
	admissionDeadline := time.Now().Add(2 * time.Second)
	for !lifecycle.ShuttingDown() {
		if time.Now().After(admissionDeadline) {
			t.Fatal("timed out waiting for shutdown to start")
		}
		time.Sleep(time.Millisecond)
	}
	if lifecycle.Track(&recordingShutdownConnection{}) {
		t.Error("Track succeeded after shutdown started")
	}
	select {
	case result := <-done:
		if result {
			t.Error("shutdown reported success with an unfinished worker")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for shutdown timeout")
	}
	lifecycle.Untrack(stuck)
	racing := &recordingShutdownConnection{}
	if lifecycle.Track(racing) {
		t.Error("Track succeeded after shutdown completed")
		lifecycle.Untrack(racing)
	}
}

func TestLifecycleShutdownWithZeroConnectionsCompletes(t *testing.T) {
	lifecycle := NewLifecycle()
	if !lifecycle.Shutdown(time.Now().Add(WebsocketCloseWriteTimeout)) {
		t.Error("zero-connection shutdown did not complete")
	}
	if !lifecycle.ShuttingDown() {
		t.Error("ShuttingDown = false after shutdown")
	}
}

func TestLifecycleShutdownIsIdempotent(t *testing.T) {
	lifecycle := NewLifecycle()
	connection := &recordingShutdownConnection{}
	if !lifecycle.Track(connection) {
		t.Fatal("track connection")
	}
	deadline := time.Now().Add(WebsocketCloseWriteTimeout)
	done := make(chan bool, 1)
	go func() {
		done <- lifecycle.Shutdown(deadline)
	}()
	writeDeadline := time.Now().Add(2 * time.Second)
	for {
		writes, _, _ := connection.counts()
		if writes > 0 {
			break
		}
		if time.Now().After(writeDeadline) {
			t.Fatal("timed out waiting for close frame")
		}
		time.Sleep(time.Millisecond)
	}
	lifecycle.Untrack(connection)
	if !<-done {
		t.Fatal("first shutdown did not complete")
	}
	if !lifecycle.Shutdown(time.Now().Add(WebsocketCloseWriteTimeout)) {
		t.Error("second shutdown did not complete")
	}
	writes, closes, _ := connection.counts()
	if writes != 1 || closes != 1 {
		t.Errorf("writes=%d closes=%d, want exactly one close attempt per tracked connection", writes, closes)
	}
}
