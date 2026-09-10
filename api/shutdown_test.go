package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
)

func newShutdownTestAPI() (*Players, *Sockets, *Admin, *Leader, *Lifecycle) {
	players := new(Players)
	players.Init()
	lifecycle := NewLifecycle()
	sockets := new(Sockets)
	sockets.Init(players, lifecycle)
	game := new(Game)
	admin := new(Admin)
	admin.Init(players, sockets, "top-secret", lifecycle, game)
	leader := new(Leader)
	leader.Init(players, game, sockets, lifecycle)
	return players, sockets, admin, leader, lifecycle
}

func dialTestSocket(t *testing.T, url string, cookie *http.Cookie) *ws.Conn {
	t.Helper()
	header := http.Header{}
	if cookie != nil {
		header.Set("Cookie", cookie.Name+"="+cookie.Value)
	}
	connection, _, err := ws.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	return connection
}

func expectGoingAwayClose(t *testing.T, connection *ws.Conn) {
	t.Helper()
	_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, _, err := connection.ReadMessage()
		if err == nil {
			// Snapshot or gameplay frame queued before shutdown; keep reading.
			continue
		}
		closeErr, ok := err.(*ws.CloseError)
		if !ok {
			t.Fatalf("read error = %#v, want CloseError", err)
		}
		if closeErr.Code != ws.CloseGoingAway {
			t.Fatalf("close code = %d, want %d", closeErr.Code, ws.CloseGoingAway)
		}
		return
	}
}

func TestShutdownNotifiesAllWebSocketEndpoints(t *testing.T) {
	players, sockets, admin, leader, lifecycle := newShutdownTestAPI()
	playerID := players.New(TypeGhost, "Player", StatusDisc)
	leaderID := players.New(TypeAntiPacLeader, "Leader", StatusDisc)

	mux := http.NewServeMux()
	mux.Handle("/api/ws/", sockets)
	mux.Handle("/api/admin/ws", http.HandlerFunc(admin.ServeSocket))
	mux.Handle("/api/admin/map/ws", http.HandlerFunc(admin.ServeMapSocket))
	mux.Handle("/api/leader/ws", http.HandlerFunc(leader.ServeSocket))
	server := httptest.NewServer(mux)
	defer server.Close()
	wsBase := "ws" + strings.TrimPrefix(server.URL, "http")

	adminCookie := registerTestAdmin(t, admin, "top-secret")
	player := dialTestSocket(t, wsBase+"/api/ws/"+string(playerID), nil)
	defer player.Close()
	viewer := dialTestSocket(t, wsBase+"/api/admin/map/ws", adminCookie)
	defer viewer.Close()
	status := dialTestSocket(t, wsBase+"/api/admin/ws", adminCookie)
	defer status.Close()
	leaderConn := dialTestSocket(t, wsBase+"/api/leader/ws", &http.Cookie{Name: leaderCookieName, Value: string(leaderID)})
	defer leaderConn.Close()

	// Wait until every endpoint registered its connection worker.
	admissionDeadline := time.Now().Add(2 * time.Second)
	for lifecycle.ConnectionCount() != 4 {
		if time.Now().After(admissionDeadline) {
			t.Fatalf("tracked connections = %d, want 4", lifecycle.ConnectionCount())
		}
		time.Sleep(time.Millisecond)
	}

	done := make(chan bool, 1)
	go func() {
		done <- lifecycle.Shutdown(time.Now().Add(WebsocketCloseWriteTimeout))
	}()
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("shutdown did not complete before deadline")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for shutdown")
	}

	for index, connection := range []*ws.Conn{player, viewer, status, leaderConn} {
		expectGoingAwayClose(t, connection)
		_ = index
	}

	if lifecycle.ConnectionCount() != 0 {
		t.Errorf("tracked connections after shutdown = %d, want 0", lifecycle.ConnectionCount())
	}
	if !lifecycle.ShuttingDown() {
		t.Error("ShuttingDown = false after shutdown")
	}
	racing := &recordingShutdownConnection{}
	if lifecycle.Track(racing) {
		t.Error("Track succeeded after shutdown")
		lifecycle.Untrack(racing)
	}
}

func TestShutdownCompletesWithZeroConnections(t *testing.T) {
	_, _, _, _, lifecycle := newShutdownTestAPI()
	if !lifecycle.Shutdown(time.Now().Add(WebsocketCloseWriteTimeout)) {
		t.Error("zero-connection shutdown did not complete")
	}
}
