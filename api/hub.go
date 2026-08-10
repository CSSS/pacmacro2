package api

import (
	"encoding/json"
	"fmt"
)

// Hub owns the connections and handles communication.
type Hub struct {
	// This map acts like a set.
	// The value is a dummy to test membership in the set.
	players     *Players
	connections map[*Conn]struct{}
	coordinates map[PlayerID]Coordinate

	register   chan *Conn     // adds a connection
	unregister chan *Conn     // removes a connection
	move       chan moveEvent // channel for movement
	inform     chan PlayerID  // channel for other communication
}

func NewHub(players *Players) *Hub {
	return &Hub{
		players:     players,
		connections: make(map[*Conn]struct{}),
		coordinates: make(map[PlayerID]Coordinate),
		register:    make(chan *Conn),
		unregister:  make(chan *Conn),
		move:        make(chan moveEvent),
		inform:      make(chan PlayerID),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case connection := <-h.register:
			h.registerConnection(connection)

		case connection := <-h.unregister:
			h.unregisterConnection(connection)

		case event := <-h.move:
			if _, exists := h.connections[event.connection]; !exists {
				continue
			}
			playerID := event.connection.playerID
			h.coordinates[playerID] = event.coord
			h.broadcastMove(playerID, event.coord)

		case playerID := <-h.inform:
			h.broadcastInform(playerID, nil)
		}
	}
}

func (h *Hub) hasConnectionForID(id PlayerID) bool {
	for connection := range h.connections {
		if connection.playerID == id {
			return true
		}
	}

	return false
}

func (h *Hub) registerConnection(connection *Conn) {
	// Don't register the same connection twice
	if _, exists := h.connections[connection]; exists {
		return
	}

	// Check if the player is creating a separate connection
	// e.g. from opening a new tab
	firstConnection := !h.hasConnectionForID(connection.playerID)
	h.connections[connection] = struct{}{}

	// If it's the player's first connection, give them coordinates
	if firstConnection {
		h.coordinates[connection.playerID] = Coordinate{}
		h.players.SetStatus(connection.playerID, StatusConn)
	}

	if !h.sendSnapshot(connection) {
		h.unregisterConnection(connection)
		return
	}

	// Existing clients only need an announcement when
	// this is the first player's active connection
	if firstConnection {
		h.broadcastInform(connection.playerID, connection)
	}
}

func (h *Hub) unregisterConnection(connection *Conn) {
	// Ensure the connection exists before unregistering
	if _, exists := h.connections[connection]; !exists {
		return
	}

	delete(h.connections, connection)

	if connection.socket != nil {
		_ = connection.socket.Close()
	}
	close(connection.send)

	// The player may still have another connection, don't clean up everything else
	if h.hasConnectionForID(connection.playerID) {
		return
	}

	delete(h.coordinates, connection.playerID)

	h.players.SetStatus(connection.playerID, StatusDisc)

	// When a player's coordinates are (0.0, 0.0) they should be removed
	// from the game map
	h.broadcastMove(connection.playerID, Coordinate{})
}

// sendSnapshot will create a game state to send to new connections
func (h *Hub) sendSnapshot(target *Conn) bool {
	// Players may have multiple connections so we keep track of ones we have seen.
	seen := make(map[PlayerID]struct{})

	// Only iterate through players that have active connections
	for connection := range h.connections {
		playerID := connection.playerID

		// We've already recorded a player's position, so avoid recording it again
		if _, exists := seen[playerID]; exists {
			continue
		}
		seen[playerID] = struct{}{}

		message, ok := h.informMessage(playerID)
		if !ok {
			continue
		}

		if !h.enqueue(target, message) {
			return false
		}
	}

	return true
}

// broadcast sends a message to all connections except the origin.
func (h *Hub) broadcast(message []byte, origin *Conn) {
	var slowConnections []*Conn

	for connection := range h.connections {
		if connection == origin {
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
		// The queue is full, means the connection is slow
		return false
	}
}

// informMessage constructs the message to send.
func (h *Hub) informMessage(playerID PlayerID) ([]byte, bool) {
	player, exists := h.playerResponse(playerID)

	if !exists {
		return nil, false
	}

	playerJSON, err := json.Marshal(player)
	if err != nil {
		return nil, false
	}

	messageJSON, err := json.Marshal(Message{
		Coord:   h.coordinates[playerID],
		Command: CMD_INFORM,
		Data:    string(playerJSON),
	})
	if err != nil {
		fmt.Printf("Error marshalling inform message: %v\n", err)
		return nil, false
	}

	return messageJSON, true
}

// broadcastInform sends a message to all connection except the origin
func (h *Hub) broadcastInform(playerID PlayerID, origin *Conn) {
	message, ok := h.informMessage(playerID)
	if !ok {
		return
	}

	h.broadcast(message, origin)
}

func (h *Hub) playerResponse(playerID PlayerID) (PlayerResponse, bool) {
	for _, player := range h.players.List() {
		if player.ID == playerID {
			return player, true
		}
	}

	return PlayerResponse{}, false
}

func (h *Hub) broadcastMove(playerID PlayerID, coordinate Coordinate) {
	message, err := json.Marshal(Message{
		Coord:   coordinate,
		Command: CMD_MOVE,
		Data:    string(playerID),
	})
	if err != nil {
		fmt.Printf("Error marshalling move message: %v\n", err)
		return
	}

	h.broadcast(message, nil)
}
