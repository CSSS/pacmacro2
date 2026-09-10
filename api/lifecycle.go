package api

import (
	"sync"
	"time"

	ws "github.com/gorilla/websocket"
)

// Shutdown budgets. CloseWriteTimeout bounds the WebSocket close-frame write
// for every connection sharing one absolute deadline. ShutdownTimeout bounds
// HTTP draining plus WebSocket worker cleanup in main.
const (
	WebsocketCloseWriteTimeout = 1 * time.Second
	ShutdownTimeout            = 5 * time.Second
)

// websocketConn is the subset of Gorilla's API used during shutdown.
// WriteControl and Close are safe for concurrent use with other connection
// methods, which lets shutdown bypass a stalled write pump.
type websocketConn interface {
	WriteControl(messageType int, data []byte, deadline time.Time) error
	Close() error
}

// Lifecycle tracks live WebSocket connections and their handler workers so
// server shutdown can notify every endpoint with a deadline-bounded close
// frame instead of sleeping an arbitrary duration.
type Lifecycle struct {
	mutex        sync.Mutex
	shuttingDown bool
	connections  map[websocketConn]struct{}
	wait         sync.WaitGroup
}

// NewLifecycle returns an idle lifecycle ready to track connections.
func NewLifecycle() *Lifecycle {
	return &Lifecycle{connections: make(map[websocketConn]struct{})}
}

// Track registers a connection worker. It returns false when shutdown has
// started, in which case the caller must close the connection and must not
// call Untrack. Each successful Track requires exactly one Untrack call.
func (l *Lifecycle) Track(connection websocketConn) bool {
	if l == nil || connection == nil {
		return false
	}
	l.mutex.Lock()
	defer l.mutex.Unlock()
	if l.shuttingDown {
		return false
	}
	if l.connections == nil {
		l.connections = make(map[websocketConn]struct{})
	}
	l.connections[connection] = struct{}{}
	l.wait.Add(1)
	return true
}

// Untrack removes one worker registration. It is safe to call for a
// connection that is no longer in the snapshot; the WaitGroup accounting
// still pairs with its Track call.
func (l *Lifecycle) Untrack(connection websocketConn) {
	if l == nil || connection == nil {
		return
	}
	l.mutex.Lock()
	delete(l.connections, connection)
	l.mutex.Unlock()
	l.wait.Done()
}

// ShuttingDown reports whether Shutdown has started. New upgrades must be
// rejected once this returns true.
func (l *Lifecycle) ShuttingDown() bool {
	if l == nil {
		return false
	}
	l.mutex.Lock()
	defer l.mutex.Unlock()
	return l.shuttingDown
}

// ConnectionCount returns the number of distinct tracked connections. It
// exists for tests; production code uses Shutdown.
func (l *Lifecycle) ConnectionCount() int {
	if l == nil {
		return 0
	}
	l.mutex.Lock()
	defer l.mutex.Unlock()
	return len(l.connections)
}

// Shutdown sends a Going Away close frame to every tracked connection using
// one shared absolute deadline, closes the underlying sockets, then waits
// until deadline for tracked workers to finish cleanup. It returns true when
// every worker finished before deadline. It is idempotent.
func (l *Lifecycle) Shutdown(deadline time.Time) bool {
	if l == nil {
		return true
	}
	l.mutex.Lock()
	l.shuttingDown = true
	snapshot := make([]websocketConn, 0, len(l.connections))
	for connection := range l.connections {
		snapshot = append(snapshot, connection)
	}
	l.mutex.Unlock()

	var closeWait sync.WaitGroup
	for _, connection := range snapshot {
		closeWait.Add(1)
		go func(connection websocketConn) {
			defer closeWait.Done()
			_ = connection.WriteControl(
				ws.CloseMessage,
				ws.FormatCloseMessage(ws.CloseGoingAway, "Server shutting down"),
				deadline,
			)
			_ = connection.Close()
		}(connection)
	}
	closeWait.Wait()

	done := make(chan struct{})
	go func() {
		l.wait.Wait()
		close(done)
	}()
	timeout := time.Until(deadline)
	if timeout <= 0 {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}
