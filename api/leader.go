package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	ws "github.com/gorilla/websocket"
)

const leaderCookieName = "id"

const (
	LeaderEventSnapshot = "snapshot"
	LeaderEventUpsert   = "upsert"
	LeaderEventRemove   = "remove"
	LeaderEventSelf     = "self"
	LeaderEventFlag     = "flag"
	LeaderEventRevoked  = "revoked"
)

type LeaderStateResponse struct {
	Leader      PlayerResponse   `json:"leader"`
	Players     []PlayerResponse `json:"players"`
	IsFlagFound bool             `json:"isFlagFound"`
}

type LeaderUpdateRequest struct {
	Type *PlayerType `json:"type"`
}

type LeaderFlagRequest struct {
	IsFlagFound *bool `json:"isFlagFound"`
}

type LeaderSocketMessage struct {
	Event       string           `json:"event"`
	Leader      *PlayerResponse  `json:"leader,omitempty"`
	Players     []PlayerResponse `json:"players"`
	Player      *PlayerResponse  `json:"player,omitempty"`
	PlayerID    PlayerID         `json:"playerId,omitempty"`
	IsFlagFound *bool            `json:"isFlagFound,omitempty"`
	Reason      string           `json:"reason,omitempty"`
}

type leaderSocketConnection interface {
	WriteMessage(messageType int, data []byte) error
	Close() error
}

type Leader struct {
	players *Players
	game    *Game
	sockets *Sockets

	connections map[leaderSocketConnection]PlayerID
	socketMutex sync.Mutex
}

func (l *Leader) Init(players *Players, game *Game, sockets *Sockets) {
	l.players = players
	l.game = game
	l.sockets = sockets
	l.connections = make(map[leaderSocketConnection]PlayerID)
	players.AddObserver(l.BroadcastPlayer)
	players.AddRemovalObserver(l.BroadcastRemoval)
	game.AddObserver(l.BroadcastFlag)
}

func (l *Leader) authenticatedState(r *http.Request) (LeaderStateResponse, bool) {
	cookie, err := r.Cookie(leaderCookieName)
	if err != nil || cookie.Value == "" {
		return LeaderStateResponse{}, false
	}
	leader, players, authorized := l.players.LeaderState(PlayerID(cookie.Value))
	if !authorized {
		return LeaderStateResponse{}, false
	}
	return LeaderStateResponse{
		Leader:      leader,
		Players:     players,
		IsFlagFound: l.game.State().IsFlagFound,
	}, true
}

// /api/leader/*
func (l *Leader) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestPath := strings.TrimPrefix(r.URL.Path, "/api/leader/")
	switch {
	case requestPath == "state.json":
		l.ServeState(w, r)
	case requestPath == "flag":
		l.ServeFlag(w, r)
	case requestPath == "ws":
		l.ServeSocket(w, r)
	case strings.HasPrefix(requestPath, "update/"):
		l.ServeUpdate(w, r)
	default:
		writeJSONError(w, http.StatusNotFound)
	}
}

// GET /api/leader/state.json
func (l *Leader) ServeState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}
	state, authorized := l.authenticatedState(r)
	if !authorized {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// POST /api/leader/update/<ID>
func (l *Leader) ServeUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}
	cookie, err := r.Cookie(leaderCookieName)
	if err != nil || cookie.Value == "" {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}
	requestLeader, found := l.players.Response(PlayerID(cookie.Value))
	if !found || !IsLeaderType(requestLeader.Type) {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}
	if requestLeader.Type != TypeAntiPacLeader {
		writeJSONError(w, http.StatusForbidden)
		return
	}

	var request LeaderUpdateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Type == nil || (*request.Type != TypeGhost && *request.Type != TypeAntipac) {
		writeJSONError(w, http.StatusBadRequest)
		return
	}

	targetID := PlayerID(strings.TrimPrefix(r.URL.Path, "/api/leader/update/"))
	changed, result := l.players.UpdateByAntiPacLeader(
		PlayerID(cookie.Value),
		targetID,
		*request.Type,
	)
	switch result {
	case LeaderUpdateUnauthorized:
		writeJSONError(w, http.StatusUnauthorized)
		return
	case LeaderUpdateForbidden:
		writeJSONError(w, http.StatusForbidden)
		return
	case LeaderUpdateNotFound:
		writeJSONError(w, http.StatusNotFound)
		return
	case LeaderUpdateConflict:
		writeJSONError(w, http.StatusConflict)
		return
	}
	for _, player := range changed {
		l.sockets.Inform(player.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/leader/flag
func (l *Leader) ServeFlag(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}
	state, authorized := l.authenticatedState(r)
	if !authorized {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}
	if state.Leader.Type != TypeFlagLeader {
		writeJSONError(w, http.StatusForbidden)
		return
	}

	var request LeaderFlagRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.IsFlagFound == nil {
		writeJSONError(w, http.StatusBadRequest)
		return
	}
	// Revalidate the capability after decoding the request.
	leader, found := l.players.Response(state.Leader.ID)
	if !found || !IsLeaderType(leader.Type) {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}
	if leader.Type != TypeFlagLeader {
		writeJSONError(w, http.StatusForbidden)
		return
	}
	l.game.SetFlagFound(*request.IsFlagFound)
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/leader/ws
func (l *Leader) ServeSocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}
	state, authorized := l.authenticatedState(r)
	if !authorized {
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
	if !l.addConnection(connection, state.Leader.ID) {
		return
	}
	defer l.removeConnection(connection)

	for {
		if _, _, err := connection.ReadMessage(); err != nil {
			return
		}
		leader, found := l.players.Response(state.Leader.ID)
		if !found || !IsLeaderType(leader.Type) {
			l.revokeConnection(connection, "Leader access was revoked.")
			return
		}
	}
}

func (l *Leader) addConnection(connection leaderSocketConnection, ownerID PlayerID) bool {
	l.socketMutex.Lock()
	defer l.socketMutex.Unlock()
	leader, players, authorized := l.players.LeaderState(ownerID)
	if !authorized {
		_ = connection.Close()
		return false
	}
	flag := l.game.State().IsFlagFound
	message := LeaderSocketMessage{
		Event: LeaderEventSnapshot, Leader: &leader, Players: players, IsFlagFound: &flag,
	}
	l.connections[connection] = ownerID
	if !writeLeaderSocketMessage(connection, message) {
		delete(l.connections, connection)
		_ = connection.Close()
		return false
	}
	return true
}

func (l *Leader) removeConnection(connection leaderSocketConnection) {
	l.socketMutex.Lock()
	delete(l.connections, connection)
	l.socketMutex.Unlock()
	_ = connection.Close()
}

func (l *Leader) revokeConnection(connection leaderSocketConnection, reason string) {
	l.socketMutex.Lock()
	if _, exists := l.connections[connection]; !exists {
		l.socketMutex.Unlock()
		return
	}
	writeLeaderSocketMessage(connection, LeaderSocketMessage{Event: LeaderEventRevoked, Reason: reason})
	delete(l.connections, connection)
	closeLeaderConnection(connection, reason)
	l.socketMutex.Unlock()
}

func closeLeaderConnection(connection leaderSocketConnection, reason string) {
	if controller, ok := connection.(interface {
		WriteControl(messageType int, data []byte, deadline time.Time) error
	}); ok {
		_ = controller.WriteControl(
			ws.CloseMessage,
			ws.FormatCloseMessage(ws.ClosePolicyViolation, reason),
			time.Now().Add(socketWriteTimeout),
		)
	}
	_ = connection.Close()
}

func (l *Leader) BroadcastPlayer(player PlayerResponse) {
	l.socketMutex.Lock()
	defer l.socketMutex.Unlock()
	for connection, ownerID := range l.connections {
		owner, found := l.players.Response(ownerID)
		if !found || !IsLeaderType(owner.Type) {
			writeLeaderSocketMessage(connection, LeaderSocketMessage{
				Event: LeaderEventRevoked, Reason: "Leader access was revoked.",
			})
			delete(l.connections, connection)
			closeLeaderConnection(connection, "Leader access was revoked.")
			continue
		}

		if player.ID == ownerID {
			self := player
			if !writeLeaderSocketMessage(connection, LeaderSocketMessage{
				Event: LeaderEventSelf, Leader: &self,
			}) {
				delete(l.connections, connection)
				_ = connection.Close()
				continue
			}
		}

		var message LeaderSocketMessage
		if IsLeaderType(player.Type) {
			message = LeaderSocketMessage{Event: LeaderEventRemove, PlayerID: player.ID}
		} else {
			upsert := player
			message = LeaderSocketMessage{Event: LeaderEventUpsert, Player: &upsert}
		}
		if !writeLeaderSocketMessage(connection, message) {
			delete(l.connections, connection)
			_ = connection.Close()
		}
	}
}

func (l *Leader) BroadcastRemoval(playerID PlayerID) {
	l.socketMutex.Lock()
	defer l.socketMutex.Unlock()
	for connection, ownerID := range l.connections {
		if ownerID == playerID {
			writeLeaderSocketMessage(connection, LeaderSocketMessage{
				Event: LeaderEventRevoked, Reason: "Leader access was revoked.",
			})
			delete(l.connections, connection)
			closeLeaderConnection(connection, "Leader access was revoked.")
			continue
		}
		if !writeLeaderSocketMessage(connection, LeaderSocketMessage{
			Event: LeaderEventRemove, PlayerID: playerID,
		}) {
			delete(l.connections, connection)
			_ = connection.Close()
		}
	}
}

func (l *Leader) BroadcastFlag(state GameState) {
	l.socketMutex.Lock()
	defer l.socketMutex.Unlock()
	for connection, ownerID := range l.connections {
		owner, found := l.players.Response(ownerID)
		if !found || !IsLeaderType(owner.Type) {
			writeLeaderSocketMessage(connection, LeaderSocketMessage{
				Event: LeaderEventRevoked, Reason: "Leader access was revoked.",
			})
			delete(l.connections, connection)
			closeLeaderConnection(connection, "Leader access was revoked.")
			continue
		}
		flag := state.IsFlagFound
		if !writeLeaderSocketMessage(connection, LeaderSocketMessage{
			Event: LeaderEventFlag, IsFlagFound: &flag,
		}) {
			delete(l.connections, connection)
			_ = connection.Close()
		}
	}
}

func writeLeaderSocketMessage(
	connection leaderSocketConnection,
	message LeaderSocketMessage,
) bool {
	JSON, err := json.Marshal(message)
	if err != nil {
		return false
	}
	if deadlineWriter, ok := connection.(interface {
		SetWriteDeadline(time.Time) error
	}); ok {
		if err := deadlineWriter.SetWriteDeadline(time.Now().Add(socketWriteTimeout)); err != nil {
			return false
		}
	}
	return connection.WriteMessage(ws.TextMessage, JSON) == nil
}
