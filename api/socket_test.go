package api

import (
	"encoding/json"
	"testing"
	"time"
)

func TestPlayerStaysConnectedUntilLastSocketDisconnects(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypePlayer, "Test", RepsNothing, StatusDisc)
	hub := NewHub(players)

	firstConnection := newTestConnection(playerID)
	secondConnection := newTestConnection(playerID)
	hub.registerConnection(firstConnection)
	hub.registerConnection(secondConnection)
	if player := players.Get(playerID); player == nil || player.Status != StatusConn {
		t.Fatalf("player status after connect = %#v, want connected", player)
	}

	hub.unregisterConnection(firstConnection)
	if player := players.Get(playerID); player == nil || player.Status != StatusConn {
		t.Errorf("player status after first disconnect = %#v, want connected", player)
	}

	hub.unregisterConnection(secondConnection)
	if player := players.Get(playerID); player == nil || player.Status != StatusDisc {
		t.Errorf("player status after last disconnect = %#v, want disconnected", player)
	}
}

func TestRegisterConnectionSendsSnapshotAndJoinAnnouncement(t *testing.T) {
	players := new(Players)
	players.Init()
	firstPlayerID := players.New(TypePlayer, "First", RepsPacman, StatusDisc)
	secondPlayerID := players.New(TypeLeader, "Second", RepsGhost, StatusDisc)
	hub := NewHub(players)

	firstConnection := newTestConnection(firstPlayerID)
	hub.registerConnection(firstConnection)
	firstSnapshot := receiveTestMessage(t, firstConnection)
	if player := informPlayer(t, firstSnapshot); player.ID != firstPlayerID {
		t.Errorf("first snapshot player ID = %q, want %q", player.ID, firstPlayerID)
	}

	secondConnection := newTestConnection(secondPlayerID)
	hub.registerConnection(secondConnection)

	snapshotPlayers := make(map[PlayerID]PlayerResponse)
	for range 2 {
		message := receiveTestMessage(t, secondConnection)
		player := informPlayer(t, message)
		snapshotPlayers[player.ID] = player
	}
	if len(snapshotPlayers) != 2 {
		t.Fatalf("snapshot players = %d, want 2", len(snapshotPlayers))
	}
	if _, exists := snapshotPlayers[firstPlayerID]; !exists {
		t.Errorf("snapshot does not contain first player %q", firstPlayerID)
	}
	if _, exists := snapshotPlayers[secondPlayerID]; !exists {
		t.Errorf("snapshot does not contain second player %q", secondPlayerID)
	}

	joinMessage := receiveTestMessage(t, firstConnection)
	if player := informPlayer(t, joinMessage); player.ID != secondPlayerID {
		t.Errorf("join announcement player ID = %q, want %q", player.ID, secondPlayerID)
	}
}

func TestSnapshotDeduplicatesMultipleConnectionsForPlayer(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypePlayer, "Player", RepsPacman, StatusDisc)
	observerID := players.New(TypeLeader, "Observer", RepsNothing, StatusDisc)
	hub := NewHub(players)

	firstConnection := newTestConnection(playerID)
	secondConnection := newTestConnection(playerID)
	hub.registerConnection(firstConnection)
	hub.registerConnection(secondConnection)

	observerConnection := newTestConnection(observerID)
	hub.registerConnection(observerConnection)

	snapshotIDs := make(map[PlayerID]int)
	for range 2 {
		player := informPlayer(t, receiveTestMessage(t, observerConnection))
		snapshotIDs[player.ID]++
	}
	if snapshotIDs[playerID] != 1 {
		t.Errorf("player appears in snapshot %d times, want 1", snapshotIDs[playerID])
	}
	if snapshotIDs[observerID] != 1 {
		t.Errorf("observer appears in snapshot %d times, want 1", snapshotIDs[observerID])
	}
}

func TestBroadcastMoveQueuesMessageForEveryConnection(t *testing.T) {
	players := new(Players)
	players.Init()
	firstPlayerID := players.New(TypePlayer, "First", RepsPacman, StatusDisc)
	secondPlayerID := players.New(TypePlayer, "Second", RepsGhost, StatusDisc)
	hub := NewHub(players)
	firstConnection := newTestConnection(firstPlayerID)
	secondConnection := newTestConnection(secondPlayerID)
	hub.registerConnection(firstConnection)
	drainTestMessages(firstConnection)
	hub.registerConnection(secondConnection)
	drainTestMessages(firstConnection)
	drainTestMessages(secondConnection)

	coordinate := Coordinate{Latitude: 49.27, Longitude: -122.91}
	hub.coordinates[firstPlayerID] = coordinate
	hub.broadcastMove(firstPlayerID, coordinate)

	for _, connection := range []*Conn{firstConnection, secondConnection} {
		message := receiveTestMessage(t, connection)
		if message.Command != CMD_MOVE {
			t.Errorf("movement command = %q, want %q", message.Command, CMD_MOVE)
		}
		if message.Data != string(firstPlayerID) {
			t.Errorf("movement player ID = %q, want %q", message.Data, firstPlayerID)
		}
		if message.Coord != coordinate {
			t.Errorf("movement coordinate = %#v, want %#v", message.Coord, coordinate)
		}
	}
}

func TestBroadcastDisconnectsConnectionWithFullQueue(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypePlayer, "Slow", RepsPacman, StatusDisc)
	hub := NewHub(players)
	connection := &Conn{
		playerID: playerID,
		send:     make(chan []byte, 1),
	}
	hub.registerConnection(connection)

	hub.broadcastMove(playerID, Coordinate{Latitude: 49.27, Longitude: -122.91})

	if _, exists := hub.connections[connection]; exists {
		t.Error("slow connection remains registered")
	}
	if _, exists := hub.coordinates[playerID]; exists {
		t.Error("slow player's coordinate remains registered")
	}
	if player := players.Get(playerID); player == nil || player.Status != StatusDisc {
		t.Errorf("slow player status = %#v, want disconnected", player)
	}
}

func newTestConnection(playerID PlayerID) *Conn {
	return &Conn{
		playerID: playerID,
		send:     make(chan []byte, socketSendQueueSize),
	}
}

func receiveTestMessage(t *testing.T, connection *Conn) Message {
	t.Helper()
	select {
	case data, open := <-connection.send:
		if !open {
			t.Fatal("connection message queue is closed")
		}
		var message Message
		if err := json.Unmarshal(data, &message); err != nil {
			t.Fatalf("decode connection message: %v", err)
		}
		return message
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for a connection message")
		return Message{}
	}
}

func informPlayer(t *testing.T, message Message) PlayerResponse {
	t.Helper()
	if message.Command != CMD_INFORM {
		t.Fatalf("message command = %q, want %q", message.Command, CMD_INFORM)
	}
	var player PlayerResponse
	if err := json.Unmarshal([]byte(message.Data), &player); err != nil {
		t.Fatalf("decode informed player: %v", err)
	}
	return player
}

func drainTestMessages(connection *Conn) {
	for {
		select {
		case _, open := <-connection.send:
			if !open {
				return
			}
		default:
			return
		}
	}
}
