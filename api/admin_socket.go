package api

import (
	"encoding/json"
	"net/http"

	ws "github.com/gorilla/websocket"
)

const (
	AdminEventSnapshot = "snapshot"
	AdminEventUpsert   = "upsert"
	AdminEventFlag     = "flag"
)

type AdminSocketMessage struct {
	Event       string           `json:"event"`
	Players     []PlayerResponse `json:"players"`
	Player      *PlayerResponse  `json:"player,omitempty"`
	IsFlagFound *bool            `json:"isFlagFound,omitempty"`
}

type adminSocketConnection interface {
	WriteMessage(messageType int, data []byte) error
	Close() error
}

// GET /api/admin/ws
func (a *Admin) ServeSocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}
	if !a.authorize(r) {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}
	if !ws.IsWebSocketUpgrade(r) {
		writeJSONError(w, http.StatusBadRequest)
		return
	}

	connection, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	if !a.addConnection(connection) {
		return
	}
	defer a.removeConnection(connection)

	for {
		if _, _, err := connection.ReadMessage(); err != nil {
			return
		}
	}
}

// GET /api/admin/map/ws
func (a *Admin) ServeMapSocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}
	if !a.authorize(r) {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}
	if !ws.IsWebSocketUpgrade(r) {
		writeJSONError(w, http.StatusBadRequest)
		return
	}

	a.sockets.ServeViewer(w, r)
}

func (a *Admin) addConnection(connection adminSocketConnection) bool {
	a.socketMutex.Lock()
	defer a.socketMutex.Unlock()

	a.connections[connection] = struct{}{}
	flagFound := false
	if a.game != nil {
		flagFound = a.game.State().IsFlagFound
	}
	message := AdminSocketMessage{
		Event:       AdminEventSnapshot,
		Players:     a.players.List(),
		IsFlagFound: &flagFound,
	}
	if !writeAdminSocketMessage(connection, message) {
		delete(a.connections, connection)
		_ = connection.Close()
		return false
	}
	return true
}

func (a *Admin) BroadcastFlagState(state GameState) {
	flagFound := state.IsFlagFound
	a.broadcastSocketMessage(AdminSocketMessage{
		Event:       AdminEventFlag,
		IsFlagFound: &flagFound,
	})
}

func (a *Admin) removeConnection(connection adminSocketConnection) {
	a.socketMutex.Lock()
	delete(a.connections, connection)
	a.socketMutex.Unlock()
	_ = connection.Close()
}

func (a *Admin) BroadcastPlayer(player PlayerResponse) {
	a.broadcastSocketMessage(AdminSocketMessage{
		Event:  AdminEventUpsert,
		Player: &player,
	})
}

func (a *Admin) broadcastSocketMessage(message AdminSocketMessage) {
	JSON, err := json.Marshal(message)
	if err != nil {
		return
	}

	a.socketMutex.Lock()
	defer a.socketMutex.Unlock()
	for connection := range a.connections {
		if err := connection.WriteMessage(ws.TextMessage, JSON); err != nil {
			delete(a.connections, connection)
			_ = connection.Close()
		}
	}
}

func writeAdminSocketMessage(connection adminSocketConnection, message AdminSocketMessage) bool {
	JSON, err := json.Marshal(message)
	if err != nil {
		return false
	}
	return connection.WriteMessage(ws.TextMessage, JSON) == nil
}
