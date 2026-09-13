// socket.go

package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	ws "github.com/gorilla/websocket"
)

const (
	socketSendQueueSize      = 256
	socketWriteTimeout       = 10 * time.Second
	playerRemovedCloseReason = "Removed by an administrator."
)

type moveEvent struct {
	connection *Conn
	coord      Coordinate
}

type connectionRole uint8

const (
	playerConnection connectionRole = iota
	viewerConnection
)

type gameSocketConnection interface {
	ReadMessage() (messageType int, data []byte, err error)
	WriteMessage(messageType int, data []byte) error
	WriteControl(messageType int, data []byte, deadline time.Time) error
	SetWriteDeadline(deadline time.Time) error
	Close() error
}

type Sockets struct {
	// private
	players *Players
	hub     *Hub

	// rosterMutationMutex keeps role changes and their hub notifications in
	// the same order as kicks. Without this boundary, a kick can observe a new
	// private role before the hub has removed the player's old public marker.
	rosterMutationMutex sync.Mutex
}

func (s *Sockets) Init(players *Players, games ...*Game) {
	s.players = players
	s.hub = NewHub(players, games...)

	go s.hub.Run()
	if len(games) > 0 && games[0] != nil {
		games[0].AddObserver(s.BroadcastState)
	}

	fmt.Print("Sockets handler initialized.\n")
}

func (s *Sockets) BroadcastState(state GameState) {
	s.hub.state <- state
}

func (s *Sockets) Inform(playerID PlayerID) {
	s.hub.inform <- playerID
}

// UpdatePlayer changes an administrator-managed role and synchronizes every
// affected map marker before a concurrent kick can delete the player.
func (s *Sockets) UpdatePlayer(
	playerID PlayerID,
	playerType PlayerType,
) (PlayerResponse, []PlayerResponse, bool) {
	s.rosterMutationMutex.Lock()
	defer s.rosterMutationMutex.Unlock()

	updated, demoted, found := s.players.Update(playerID, playerType)
	if !found {
		return updated, demoted, false
	}
	for _, player := range demoted {
		s.Inform(player.ID)
	}
	s.Inform(playerID)
	return updated, demoted, true
}

// UpdatePlayerByLeader applies a leader-authorized role change and synchronizes
// its map effects before a concurrent kick can run.
func (s *Sockets) UpdatePlayerByLeader(
	leaderID PlayerID,
	targetID PlayerID,
	playerType PlayerType,
) ([]PlayerResponse, LeaderUpdateResult) {
	s.rosterMutationMutex.Lock()
	defer s.rosterMutationMutex.Unlock()

	changed, result := s.players.UpdateByLeader(leaderID, targetID, playerType)
	if result != LeaderUpdateOK {
		return changed, result
	}
	for _, player := range changed {
		s.Inform(player.ID)
	}
	return changed, result
}

// ResetNonLeaders synchronizes reset role changes with the map hub before a
// concurrent kick can run.
func (s *Sockets) ResetNonLeaders() []PlayerResponse {
	s.rosterMutationMutex.Lock()
	defer s.rosterMutationMutex.Unlock()

	changed := s.players.ResetNonLeaders()
	for _, player := range changed {
		if player.Status == StatusConn {
			s.Inform(player.ID)
		}
	}
	return changed
}

// ClearOfflineLocations removes all retained last-known locations while
// leaving coordinates for currently connected players untouched.
func (s *Sockets) ClearOfflineLocations() {
	done := make(chan struct{})
	s.hub.clearOffline <- done
	<-done
}

// KickPlayer removes a player and all of their game-hub state in the same
// serialized operation that closes their active sockets.
func (s *Sockets) KickPlayer(playerID PlayerID) bool {
	s.rosterMutationMutex.Lock()
	defer s.rosterMutationMutex.Unlock()

	result := make(chan bool)
	s.hub.kick <- KickRequest{playerID: playerID, result: result}
	return <-result
}

type Conn struct {
	socket   gameSocketConnection
	playerID PlayerID
	role     connectionRole
	send     chan []byte

	unregisterOnce sync.Once
}

func (c *Conn) unregister(hub *Hub) {
	c.unregisterOnce.Do(func() {
		hub.unregister <- c
	})
}

func (c *Conn) closeWithPolicy(reason string) {
	if c.socket == nil {
		return
	}
	_ = c.socket.WriteControl(
		ws.CloseMessage,
		ws.FormatCloseMessage(ws.ClosePolicyViolation, reason),
		time.Now().Add(socketWriteTimeout),
	)
	_ = c.socket.Close()
}

// writePump the only goroutine that writes to a WebSocket
func (c *Conn) writePump(hub *Hub) {
	defer func() {
		_ = c.socket.Close()
		c.unregister(hub)
	}()

	for message := range c.send {
		_ = c.socket.SetWriteDeadline(time.Now().Add(socketWriteTimeout))
		if err := c.socket.WriteMessage(
			ws.TextMessage,
			message,
		); err != nil {
			return
		}
	}
}

// readPump the only goroutine that reads from a Websocket
func (c *Conn) readPump(hub *Hub) error {
	defer c.unregister(hub)

	for {
		messageType, data, err := c.socket.ReadMessage()
		if err != nil {
			return err
		}

		if messageType == ws.CloseMessage {
			return nil
		}
		if c.role == viewerConnection {
			// Map viewers are a receive-only participant in the game hub.
			continue
		}

		var coordinate Coordinate
		if err := json.Unmarshal(data, &coordinate); err != nil {
			continue
		}

		hub.move <- moveEvent{
			connection: c,
			coord:      coordinate,
		}
	}
}

// WS /api/ws/<ID>
// ServeHTTP upgrades the connection to a websocket connection
func (s *Sockets) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}

	playerID := PlayerID(strings.TrimPrefix(r.URL.Path, "/api/ws/"))
	if s.players.Get(playerID) == nil {
		writeJSONError(w, http.StatusBadRequest)
		return
	}

	// attempt to upgrade connection to websocket connection
	socket, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	connection := &Conn{
		socket:   socket,
		playerID: playerID,
		role:     playerConnection,
		send:     make(chan []byte, socketSendQueueSize),
	}

	go connection.writePump(s.hub)
	s.hub.register <- connection

	fmt.Printf("Sockets\tServeHTTP (/api/ws/):\tID %q: Connection opened.\n", playerID)

	if err := connection.readPump(s.hub); err != nil {
		fmt.Printf("Sockets\tServeHTTP (/api/ws/):\tID %q: Connection closed by error: %v.\n", playerID, err)
	} else {
		fmt.Printf("Sockets\tServeHTTP (/api/ws/):\tID %q: Connection closed by user.\n", playerID)
	}
}

// ServeViewer upgrades an already-authorized admin request to a read-only
// connection on the game hub.
func (s *Sockets) ServeViewer(w http.ResponseWriter, r *http.Request) {
	socket, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	connection := &Conn{
		socket: socket,
		role:   viewerConnection,
		send:   make(chan []byte, socketSendQueueSize),
	}

	go connection.writePump(s.hub)
	s.hub.register <- connection

	fmt.Print("Sockets\tServeViewer (/api/admin/map/ws):\tConnection opened.\n")

	if err := connection.readPump(s.hub); err != nil {
		fmt.Printf("Sockets\tServeViewer (/api/admin/map/ws):\tConnection closed by error: %v.\n", err)
	} else {
		fmt.Print("Sockets\tServeViewer (/api/admin/map/ws):\tConnection closed by user.\n")
	}
}
