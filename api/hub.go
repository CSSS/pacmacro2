package api

import (
	"encoding/json"
	"fmt"
)

// Hub owns the connections and handles communication.
// Active coordinates and disconnected last-known coordinates
// are deliberately stored separately so regular player maps can
// never retain an offline marker.
type Hub struct {
	players            *Players
	game               *Game
	connections        map[*Conn]struct{}
	coordinates        map[PlayerID]Coordinate
	offlineCoordinates map[PlayerID]Coordinate
	awaitingFresh      map[PlayerID]bool

	register     chan *Conn
	unregister   chan *Conn
	move         chan moveEvent
	inform       chan PlayerID
	state        chan GameState
	clearOffline chan chan struct{}
}

func NewHub(players *Players, games ...*Game) *Hub {
	hub := &Hub{
		players:            players,
		connections:        make(map[*Conn]struct{}),
		coordinates:        make(map[PlayerID]Coordinate),
		offlineCoordinates: make(map[PlayerID]Coordinate),
		awaitingFresh:      make(map[PlayerID]bool),
		register:           make(chan *Conn),
		unregister:         make(chan *Conn),
		move:               make(chan moveEvent),
		inform:             make(chan PlayerID),
		state:              make(chan GameState),
		clearOffline:       make(chan chan struct{}),
	}
	if len(games) > 0 {
		hub.game = games[0]
	}
	return hub
}

func (h *Hub) Run() {
	for {
		select {
		case connection := <-h.register:
			h.registerConnection(connection)
		case connection := <-h.unregister:
			h.unregisterConnection(connection)
		case event := <-h.move:
			h.handleMove(event)
		case playerID := <-h.inform:
			h.broadcastInform(playerID, nil)
		case state := <-h.state:
			h.broadcastState(state)
		case done := <-h.clearOffline:
			h.clearOfflineLocations()
			close(done)
		}
	}
}

func isPrivateMapRole(playerType PlayerType) bool {
	return playerType == TypeAntipac ||
		playerType == TypeAntiPacLeader ||
		playerType == TypeFlagLeader
}

func isMapVisibleRole(playerType PlayerType) bool {
	return playerType != TypeHidden
}

func (h *Hub) connectionCanSee(
	connection *Conn,
	playerID PlayerID,
	playerType PlayerType,
) bool {
	if !isMapVisibleRole(playerType) {
		return false
	}
	if connection.role == viewerConnection {
		return true
	}
	return !isPrivateMapRole(playerType) || connection.playerID == playerID
}

func (h *Hub) hasConnectionForID(id PlayerID) bool {
	for connection := range h.connections {
		if connection.role == playerConnection && connection.playerID == id {
			return true
		}
	}
	return false
}

func (h *Hub) registerConnection(connection *Conn) {
	if _, exists := h.connections[connection]; exists {
		return
	}

	if connection.role == viewerConnection {
		h.connections[connection] = struct{}{}
		if !h.sendSnapshot(connection) {
			h.unregisterConnection(connection)
		}
		return
	}

	firstConnection := !h.hasConnectionForID(connection.playerID)
	if firstConnection {
		// Reconnection invalidates the old Admin marker. No active coordinate is
		// created until the player sends a fresh GPS update.
		if _, retained := h.offlineCoordinates[connection.playerID]; retained {
			delete(h.offlineCoordinates, connection.playerID)
			h.awaitingFresh[connection.playerID] = true
			h.broadcastRemove(connection.playerID, onlyViewers, nil)
		}
	}

	h.connections[connection] = struct{}{}
	if firstConnection {
		h.players.SetStatus(connection.playerID, StatusConn)
	}

	if !h.sendSnapshot(connection) {
		h.unregisterConnection(connection)
		return
	}

	if firstConnection {
		h.broadcastInform(connection.playerID, connection)
	}
}

func (h *Hub) unregisterConnection(connection *Conn) {
	if _, exists := h.connections[connection]; !exists {
		return
	}

	delete(h.connections, connection)
	if connection.socket != nil {
		_ = connection.socket.Close()
	}
	close(connection.send)
	if connection.role == viewerConnection || h.hasConnectionForID(connection.playerID) {
		return
	}

	coordinate, hasCoordinate := h.coordinates[connection.playerID]
	delete(h.coordinates, connection.playerID)
	delete(h.awaitingFresh, connection.playerID)
	h.players.SetStatus(connection.playerID, StatusDisc)
	player, exists := h.playerResponse(connection.playerID)
	if !exists {
		delete(h.offlineCoordinates, connection.playerID)
		return
	}

	if hasCoordinate {
		h.offlineCoordinates[connection.playerID] = coordinate
	} else {
		delete(h.offlineCoordinates, connection.playerID)
	}

	// Player maps drop disconnected public markers. Private roles were never
	// sent to other players, and no owner connection remains at this point.
	if !isPrivateMapRole(player.Type) && isMapVisibleRole(player.Type) {
		h.broadcastRemove(connection.playerID, onlyPlayers, nil)
	}

	// Admin maps retain only genuine last-known coordinates. A connected
	// placeholder with no GPS update is removed instead.
	if hasCoordinate && isMapVisibleRole(player.Type) {
		message, ok := informMessage(player, coordinate)
		if ok {
			h.broadcast(message, nil, onlyViewers)
		}
	} else {
		h.broadcastRemove(connection.playerID, onlyViewers, nil)
	}
}

// sendSnapshot sends active players according to the recipient's visibility.
// Admin viewers additionally receive retained disconnected locations.
func (h *Hub) sendSnapshot(target *Conn) bool {
	seen := make(map[PlayerID]struct{})
	for connection := range h.connections {
		if connection.role != playerConnection {
			continue
		}
		playerID := connection.playerID
		if _, exists := seen[playerID]; exists {
			continue
		}
		seen[playerID] = struct{}{}

		player, exists := h.playerResponse(playerID)
		if !exists || !h.connectionCanSee(target, playerID, player.Type) {
			continue
		}
		coordinate := h.coordinates[playerID]
		if h.awaitingFresh[playerID] &&
			(target.role != playerConnection || target.playerID != playerID) {
			continue
		}
		message, ok := informMessage(player, coordinate)
		if ok && !h.enqueue(target, message) {
			return false
		}
	}

	if target.role == viewerConnection {
		for playerID, coordinate := range h.offlineCoordinates {
			player, exists := h.playerResponse(playerID)
			if !exists || !isMapVisibleRole(player.Type) {
				continue
			}
			message, ok := informMessage(player, coordinate)
			if ok && !h.enqueue(target, message) {
				return false
			}
		}
	}

	if h.game != nil && !h.enqueue(target, stateMessage(h.game.State())) {
		return false
	}
	return true
}

func stateMessage(state GameState) []byte {
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return nil
	}
	message, err := json.Marshal(Message{Command: CMD_STATE, Data: string(stateJSON)})
	if err != nil {
		return nil
	}
	return message
}

func (h *Hub) broadcastState(state GameState) {
	message := stateMessage(state)
	if message != nil {
		h.broadcast(message, nil, allConnections)
	}
}

func (h *Hub) handleMove(event moveEvent) {
	if _, exists := h.connections[event.connection]; !exists ||
		event.connection.role != playerConnection {
		return
	}

	playerID := event.connection.playerID
	awaitingFresh := h.awaitingFresh[playerID]
	delete(h.awaitingFresh, playerID)
	h.coordinates[playerID] = event.coord
	if awaitingFresh {
		// The first location uses inform so recipients that correctly omitted a
		// coordinate-less join can create the marker and its metadata together.
		h.broadcastInform(playerID, nil)
	} else {
		h.broadcastMove(playerID, event.coord)
	}
}

type connectionFilter func(*Conn) bool

func allConnections(*Conn) bool         { return true }
func onlyPlayers(connection *Conn) bool { return connection.role == playerConnection }
func onlyViewers(connection *Conn) bool { return connection.role == viewerConnection }

// broadcast sends a message to matching connections except the origin.
func (h *Hub) broadcast(message []byte, origin *Conn, include connectionFilter) {
	var slowConnections []*Conn
	for connection := range h.connections {
		if connection == origin || !include(connection) {
			continue
		}
		if !h.enqueue(connection, message) {
			slowConnections = append(slowConnections, connection)
		}
	}
	for _, connection := range slowConnections {
		h.unregisterConnection(connection)
	}
}

func (h *Hub) enqueue(connection *Conn, message []byte) bool {
	select {
	case connection.send <- message:
		return true
	default:
		return false
	}
}

func informMessage(player PlayerResponse, coordinate Coordinate) ([]byte, bool) {
	playerJSON, err := json.Marshal(player)
	if err != nil {
		return nil, false
	}
	messageJSON, err := json.Marshal(Message{
		Coord:   coordinate,
		Command: CMD_INFORM,
		Data:    string(playerJSON),
	})
	if err != nil {
		fmt.Printf("Error marshalling inform message: %v\n", err)
		return nil, false
	}
	return messageJSON, true
}

// broadcastInform applies current role visibility to metadata changes. Sending
// remove to ineligible active player connections also clears markers after a
// public-to-private or visible-to-Hidden transition.
func (h *Hub) broadcastInform(playerID PlayerID, origin *Conn) {
	player, exists := h.playerResponse(playerID)
	if !exists {
		return
	}

	coordinate := h.coordinates[playerID]
	if h.hasConnectionForID(playerID) {
		message, ok := informMessage(player, coordinate)
		if !ok {
			return
		}
		var slowConnections []*Conn
		remove := removeMessage(playerID)
		for connection := range h.connections {
			if connection == origin {
				continue
			}
			if h.awaitingFresh[playerID] {
				// Owners still need their current role for the game UI, but map
				// viewers and other players wait for a fresh coordinate.
				if connection.role != playerConnection || connection.playerID != playerID {
					continue
				}
			}
			outgoing := remove
			if h.connectionCanSee(connection, playerID, player.Type) {
				outgoing = message
			}
			if !h.enqueue(connection, outgoing) {
				slowConnections = append(slowConnections, connection)
			}
		}
		for _, connection := range slowConnections {
			h.unregisterConnection(connection)
		}
		return
	}

	// Disconnected metadata is relevant only when an Admin currently has a
	// retained marker for that player.
	coordinate, retained := h.offlineCoordinates[playerID]
	if retained && isMapVisibleRole(player.Type) {
		message, ok := informMessage(player, coordinate)
		if ok {
			h.broadcast(message, nil, onlyViewers)
		}
		return
	}
	if !isMapVisibleRole(player.Type) {
		h.broadcastRemove(playerID, onlyViewers, nil)
	}
}

func (h *Hub) playerResponse(playerID PlayerID) (PlayerResponse, bool) {
	return h.players.Response(playerID)
}

func (h *Hub) broadcastMove(playerID PlayerID, coordinate Coordinate) {
	player, exists := h.playerResponse(playerID)
	if !exists || !isMapVisibleRole(player.Type) {
		return
	}
	message, err := json.Marshal(Message{
		Coord:   coordinate,
		Command: CMD_MOVE,
		Data:    string(playerID),
	})
	if err != nil {
		fmt.Printf("Error marshalling move message: %v\n", err)
		return
	}
	h.broadcast(message, nil, func(connection *Conn) bool {
		return h.connectionCanSee(connection, playerID, player.Type)
	})
}

func removeMessage(playerID PlayerID) []byte {
	message, err := json.Marshal(struct {
		Command string `json:"command"`
		Data    string `json:"data"`
	}{Command: CMD_REMOVE, Data: string(playerID)})
	if err != nil {
		return nil
	}
	return message
}

func (h *Hub) broadcastRemove(playerID PlayerID, include connectionFilter, origin *Conn) {
	h.broadcast(removeMessage(playerID), origin, include)
}

func (h *Hub) clearOfflineLocations() {
	for playerID := range h.offlineCoordinates {
		delete(h.offlineCoordinates, playerID)
		h.broadcastRemove(playerID, onlyViewers, nil)
	}
}
