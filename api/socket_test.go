package api

import (
	"encoding/json"
	"testing"
	"time"
)

func TestPlayerStaysConnectedUntilLastSocketDisconnects(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypeGhost, "Test", StatusDisc)
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

func TestGameStateSnapshotAndBroadcastDoNotChangePlayerConnectionCounts(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypePacman, "Player", StatusDisc)
	game := &Game{IsFlagFound: true}
	hub := NewHub(players, game)
	playerConnection := newTestConnection(playerID)
	hub.registerConnection(playerConnection)

	var snapshotState GameState
	foundState := false
	for range 2 {
		message := receiveTestMessage(t, playerConnection)
		if message.Command != CMD_STATE {
			continue
		}
		if err := json.Unmarshal([]byte(message.Data), &snapshotState); err != nil {
			t.Fatal(err)
		}
		foundState = true
	}
	if !foundState || !snapshotState.IsFlagFound {
		t.Errorf("snapshot state = %#v, found = %v", snapshotState, foundState)
	}

	viewer := newTestViewerConnection()
	hub.registerConnection(viewer)
	drainTestMessages(viewer)
	hub.broadcastState(GameState{IsFlagFound: false})
	message := receiveTestMessage(t, viewer)
	if message.Command != CMD_STATE {
		t.Fatalf("state command = %q, want %q", message.Command, CMD_STATE)
	}
	var state GameState
	if err := json.Unmarshal([]byte(message.Data), &state); err != nil || state.IsFlagFound {
		t.Errorf("broadcast state = %#v, error = %v", state, err)
	}
	if player := players.Get(playerID); player == nil || player.Status != StatusConn {
		t.Errorf("player after viewer state = %#v, want connected", player)
	}
}

func TestRegisterConnectionSendsSnapshotAndJoinAnnouncement(t *testing.T) {
	players := new(Players)
	players.Init()
	firstPlayerID := players.New(TypePacman, "First", StatusDisc)
	secondPlayerID := players.New(TypeLeader, "Second", StatusDisc)
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
	playerID := players.New(TypePacman, "Player", StatusDisc)
	observerID := players.New(TypeLeader, "Observer", StatusDisc)
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
	firstPlayerID := players.New(TypePacman, "First", StatusDisc)
	secondPlayerID := players.New(TypeGhost, "Second", StatusDisc)
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
	playerID := players.New(TypePacman, "Slow", StatusDisc)
	hub := NewHub(players)
	connection := &Conn{
		playerID: playerID,
		role:     playerConnection,
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

func TestViewerReceivesActivePlayerSnapshotWithoutChangingPlayerState(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypePacman, "Player", StatusDisc)
	hub := NewHub(players)
	playerConnection := newTestConnection(playerID)
	hub.registerConnection(playerConnection)
	drainTestMessages(playerConnection)
	coordinate := Coordinate{Latitude: 49.27, Longitude: -122.91}
	hub.handleMove(moveEvent{connection: playerConnection, coord: coordinate})
	drainTestMessages(playerConnection)

	viewer := newTestViewerConnection()
	hub.registerConnection(viewer)
	snapshot := receiveTestMessage(t, viewer)
	if informed := informPlayer(t, snapshot); informed.ID != playerID {
		t.Errorf("viewer snapshot player ID = %q, want %q", informed.ID, playerID)
	}
	if snapshot.Coord != coordinate {
		t.Errorf("viewer snapshot coordinate = %#v, want %#v", snapshot.Coord, coordinate)
	}
	if player := players.Get(playerID); player == nil || player.Status != StatusConn {
		t.Errorf("player after viewer connect = %#v, want connected", player)
	}
	if hub.coordinates[playerID] != coordinate {
		t.Errorf("coordinate after viewer connect = %#v, want %#v", hub.coordinates[playerID], coordinate)
	}

	hub.unregisterConnection(viewer)
	if player := players.Get(playerID); player == nil || player.Status != StatusConn {
		t.Errorf("player after viewer disconnect = %#v, want connected", player)
	}
	if hub.coordinates[playerID] != coordinate {
		t.Errorf("coordinate after viewer disconnect = %#v, want %#v", hub.coordinates[playerID], coordinate)
	}
	if !hub.hasConnectionForID(playerID) {
		t.Error("viewer disconnect removed the active player connection")
	}
}

func TestViewersReceiveMovementAndMetadataBroadcasts(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypeGhost, "Player", StatusDisc)
	hub := NewHub(players)
	playerConnection := newTestConnection(playerID)
	hub.registerConnection(playerConnection)
	drainTestMessages(playerConnection)

	firstViewer := newTestViewerConnection()
	secondViewer := newTestViewerConnection()
	hub.registerConnection(firstViewer)
	hub.registerConnection(secondViewer)
	drainTestMessages(firstViewer)
	drainTestMessages(secondViewer)

	coordinate := Coordinate{Latitude: 49.28, Longitude: -122.90}
	hub.handleMove(moveEvent{connection: playerConnection, coord: coordinate})
	for index, viewer := range []*Conn{firstViewer, secondViewer} {
		message := receiveTestMessage(t, viewer)
		if message.Command != CMD_MOVE || message.Data != string(playerID) || message.Coord != coordinate {
			t.Errorf("viewer %d movement = %#v", index+1, message)
		}
	}
	drainTestMessages(playerConnection)

	updated, _, found := players.Update(playerID, TypeEdible)
	if !found || updated.Status != StatusConn {
		t.Fatal("update connected player")
	}
	hub.broadcastInform(playerID, nil)
	for index, viewer := range []*Conn{firstViewer, secondViewer} {
		informed := informPlayer(t, receiveTestMessage(t, viewer))
		if informed.Type != TypeEdible {
			t.Errorf("viewer %d metadata = %#v", index+1, informed)
		}
	}

	hub.unregisterConnection(firstViewer)
	hub.broadcastInform(playerID, nil)
	if informed := informPlayer(t, receiveTestMessage(t, secondViewer)); informed.ID != playerID {
		t.Errorf("remaining viewer update player ID = %q, want %q", informed.ID, playerID)
	}
}

func TestViewerReceivesPlayerJoinAndDisconnect(t *testing.T) {
	players := new(Players)
	players.Init()
	firstPlayerID := players.New(TypePacman, "First", StatusDisc)
	hub := NewHub(players)
	firstPlayerConnection := newTestConnection(firstPlayerID)
	hub.registerConnection(firstPlayerConnection)
	drainTestMessages(firstPlayerConnection)

	viewer := newTestViewerConnection()
	hub.registerConnection(viewer)
	drainTestMessages(viewer)

	secondPlayerID := players.New(TypeLeader, "Second", StatusDisc)
	secondPlayerConnection := newTestConnection(secondPlayerID)
	hub.registerConnection(secondPlayerConnection)
	joined := informPlayer(t, receiveTestMessage(t, viewer))
	if joined.ID != secondPlayerID {
		t.Errorf("joined player ID = %q, want %q", joined.ID, secondPlayerID)
	}

	hub.unregisterConnection(secondPlayerConnection)
	disconnected := receiveTestMessage(t, viewer)
	if disconnected.Command != CMD_REMOVE || disconnected.Data != string(secondPlayerID) {
		t.Errorf("disconnect update = %#v", disconnected)
	}
	if player := players.Get(firstPlayerID); player == nil || player.Status != StatusConn {
		t.Errorf("first player after second disconnect = %#v, want connected", player)
	}
}

func TestViewerMovementIsIgnored(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypePacman, "Player", StatusDisc)
	hub := NewHub(players)
	playerConnection := newTestConnection(playerID)
	hub.registerConnection(playerConnection)
	drainTestMessages(playerConnection)

	viewer := newTestViewerConnection()
	hub.registerConnection(viewer)
	drainTestMessages(viewer)
	coordinate := Coordinate{Latitude: 50, Longitude: -123}
	hub.handleMove(moveEvent{connection: viewer, coord: coordinate})

	if got := hub.coordinates[playerID]; got != (Coordinate{}) {
		t.Errorf("player coordinate after viewer movement = %#v, want zero", got)
	}
	if _, exists := hub.coordinates[""]; exists {
		t.Error("viewer movement created a coordinate record")
	}
	if len(playerConnection.send) != 0 || len(viewer.send) != 0 {
		t.Error("viewer movement produced a broadcast")
	}
}

func TestSlowViewerIsRemovedWithoutChangingPlayerState(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypePacman, "Player", StatusDisc)
	hub := NewHub(players)
	playerConnection := newTestConnection(playerID)
	hub.registerConnection(playerConnection)
	drainTestMessages(playerConnection)
	coordinate := Coordinate{Latitude: 49.27, Longitude: -122.91}
	hub.coordinates[playerID] = coordinate

	viewer := &Conn{
		role: viewerConnection,
		send: make(chan []byte, 1),
	}
	hub.registerConnection(viewer) // The snapshot fills the deliberately small queue.
	hub.broadcastMove(playerID, coordinate)

	if _, exists := hub.connections[viewer]; exists {
		t.Error("slow viewer remains registered")
	}
	if player := players.Get(playerID); player == nil || player.Status != StatusConn {
		t.Errorf("player after slow viewer cleanup = %#v, want connected", player)
	}
	if hub.coordinates[playerID] != coordinate {
		t.Errorf("coordinate after slow viewer cleanup = %#v, want %#v", hub.coordinates[playerID], coordinate)
	}
	if !hub.hasConnectionForID(playerID) {
		t.Error("slow viewer cleanup removed the player connection")
	}
}

func TestSnapshotsApplyPrivateRoleVisibilityPerRecipient(t *testing.T) {
	players := new(Players)
	players.Init()
	types := []PlayerType{
		TypeGhost,
		TypeLeader,
		TypeAntipac,
		TypeAntiPacLeader,
		TypeFlagLeader,
		TypeHidden,
	}
	IDs := make(map[PlayerType]PlayerID)
	connections := make([]*Conn, 0, len(types))
	hub := NewHub(players)
	for index, playerType := range types {
		playerID := players.New(playerType, TypeString(playerType), StatusDisc)
		IDs[playerType] = playerID
		connection := newTestConnection(playerID)
		connections = append(connections, connection)
		hub.registerConnection(connection)
		for _, existing := range connections {
			drainTestMessages(existing)
		}
		hub.coordinates[playerID] = Coordinate{
			Latitude:  49.27 + float64(index)/1000,
			Longitude: -122.91,
		}
	}

	ordinaryID := players.New(TypeEdible, "Ordinary", StatusDisc)
	ordinary := newTestConnection(ordinaryID)
	hub.registerConnection(ordinary)
	ordinarySnapshot := queuedInformPlayers(t, ordinary)
	for _, publicType := range []PlayerType{TypeGhost, TypeLeader} {
		if _, exists := ordinarySnapshot[IDs[publicType]]; !exists {
			t.Errorf("ordinary snapshot is missing public type %s", TypeString(publicType))
		}
	}
	if _, exists := ordinarySnapshot[ordinaryID]; !exists {
		t.Error("ordinary snapshot is missing self")
	}
	for _, privateType := range []PlayerType{
		TypeAntipac, TypeAntiPacLeader, TypeFlagLeader, TypeHidden,
	} {
		if player, exists := ordinarySnapshot[IDs[privateType]]; exists {
			t.Errorf("ordinary snapshot leaked %s: %#v", TypeString(privateType), player)
		}
	}

	for _, privateType := range []PlayerType{TypeAntipac, TypeAntiPacLeader, TypeFlagLeader} {
		owner := newTestConnection(IDs[privateType])
		hub.registerConnection(owner)
		snapshot := queuedInformPlayers(t, owner)
		if _, exists := snapshot[IDs[privateType]]; !exists {
			t.Errorf("%s owner snapshot is missing self", TypeString(privateType))
		}
		for _, otherPrivateType := range []PlayerType{
			TypeAntipac, TypeAntiPacLeader, TypeFlagLeader,
		} {
			if otherPrivateType == privateType {
				continue
			}
			if player, exists := snapshot[IDs[otherPrivateType]]; exists {
				t.Errorf("%s owner snapshot leaked %s: %#v",
					TypeString(privateType), TypeString(otherPrivateType), player)
			}
		}
		if _, exists := snapshot[IDs[TypeHidden]]; exists {
			t.Errorf("%s owner snapshot leaked Hidden", TypeString(privateType))
		}
	}

	viewer := newTestViewerConnection()
	hub.registerConnection(viewer)
	viewerSnapshot := queuedInformPlayers(t, viewer)
	for _, visibleType := range []PlayerType{
		TypeGhost, TypeLeader, TypeAntipac, TypeAntiPacLeader, TypeFlagLeader,
	} {
		if _, exists := viewerSnapshot[IDs[visibleType]]; !exists {
			t.Errorf("Admin snapshot is missing %s", TypeString(visibleType))
		}
	}
	if _, exists := viewerSnapshot[IDs[TypeHidden]]; exists {
		t.Error("Admin snapshot contains Hidden")
	}
}

func TestPrivateMovementGoesOnlyToAdminAndEveryOwnerConnection(t *testing.T) {
	players := new(Players)
	players.Init()
	privateID := players.New(TypeAntipac, "Antipac", StatusDisc)
	otherPrivateID := players.New(TypeFlagLeader, "Flag Leader", StatusDisc)
	ordinaryID := players.New(TypeGhost, "Ordinary", StatusDisc)
	hiddenID := players.New(TypeHidden, "Hidden", StatusDisc)
	hub := NewHub(players)

	firstOwner := newTestConnection(privateID)
	secondOwner := newTestConnection(privateID)
	otherPrivate := newTestConnection(otherPrivateID)
	ordinary := newTestConnection(ordinaryID)
	hidden := newTestConnection(hiddenID)
	viewer := newTestViewerConnection()
	for _, connection := range []*Conn{
		firstOwner, secondOwner, otherPrivate, ordinary, hidden, viewer,
	} {
		hub.registerConnection(connection)
	}
	for _, connection := range []*Conn{
		firstOwner, secondOwner, otherPrivate, ordinary, hidden, viewer,
	} {
		drainTestMessages(connection)
	}

	coordinate := Coordinate{Latitude: 49.275, Longitude: -122.905}
	hub.coordinates[privateID] = coordinate
	hub.broadcastMove(privateID, coordinate)
	for _, connection := range []*Conn{firstOwner, secondOwner, viewer} {
		message := receiveTestMessage(t, connection)
		if message.Command != CMD_MOVE || message.Data != string(privateID) ||
			message.Coord != coordinate {
			t.Errorf("private movement = %#v", message)
		}
	}
	for _, connection := range []*Conn{otherPrivate, ordinary, hidden} {
		if len(connection.send) != 0 {
			t.Errorf("private movement leaked to player %q", connection.playerID)
		}
	}

	hub.coordinates[hiddenID] = coordinate
	hub.broadcastMove(hiddenID, coordinate)
	for _, connection := range []*Conn{
		firstOwner, secondOwner, otherPrivate, ordinary, hidden, viewer,
	} {
		if len(connection.send) != 0 {
			t.Errorf("Hidden movement was sent to connection %q", connection.playerID)
		}
	}
}

func TestRoleTransitionsRemoveAndRestoreRegularMarkers(t *testing.T) {
	players := new(Players)
	players.Init()
	targetID := players.New(TypeGhost, "Target", StatusDisc)
	ordinaryID := players.New(TypeLeader, "Ordinary", StatusDisc)
	hub := NewHub(players)
	owner := newTestConnection(targetID)
	ordinary := newTestConnection(ordinaryID)
	viewer := newTestViewerConnection()
	for _, connection := range []*Conn{owner, ordinary, viewer} {
		hub.registerConnection(connection)
	}
	for _, connection := range []*Conn{owner, ordinary, viewer} {
		drainTestMessages(connection)
	}
	hub.coordinates[targetID] = Coordinate{Latitude: 49.275, Longitude: -122.905}

	if _, _, found := players.Update(targetID, TypeAntipac); !found {
		t.Fatal("make target private")
	}
	hub.broadcastInform(targetID, nil)
	if informed := informPlayer(t, receiveTestMessage(t, owner)); informed.Type != TypeAntipac {
		t.Errorf("owner private update = %#v", informed)
	}
	if informed := informPlayer(t, receiveTestMessage(t, viewer)); informed.Type != TypeAntipac {
		t.Errorf("Admin private update = %#v", informed)
	}
	removeJSON := receiveTestData(t, ordinary)
	var removeFields map[string]json.RawMessage
	if err := json.Unmarshal(removeJSON, &removeFields); err != nil {
		t.Fatal(err)
	}
	if _, exists := removeFields["coordinate"]; exists {
		t.Errorf("remove frame disclosed a coordinate: %s", removeJSON)
	}
	var remove Message
	if err := json.Unmarshal(removeJSON, &remove); err != nil ||
		remove.Command != CMD_REMOVE || remove.Data != string(targetID) {
		t.Errorf("remove frame = %s, error = %v", removeJSON, err)
	}

	if _, _, found := players.Update(targetID, TypeGhost); !found {
		t.Fatal("make target public")
	}
	hub.broadcastInform(targetID, nil)
	for _, connection := range []*Conn{owner, ordinary, viewer} {
		if informed := informPlayer(t, receiveTestMessage(t, connection)); informed.ID != targetID || informed.Type != TypeGhost {
			t.Errorf("restored public update = %#v", informed)
		}
	}
}

func TestAdminRetainsOfflineLocationUntilReconnectOrReset(t *testing.T) {
	players := new(Players)
	players.Init()
	targetID := players.New(TypeGhost, "Target", StatusDisc)
	ordinaryID := players.New(TypeLeader, "Ordinary", StatusDisc)
	hub := NewHub(players)
	target := newTestConnection(targetID)
	ordinary := newTestConnection(ordinaryID)
	viewer := newTestViewerConnection()
	for _, connection := range []*Conn{target, ordinary, viewer} {
		hub.registerConnection(connection)
	}
	for _, connection := range []*Conn{target, ordinary, viewer} {
		drainTestMessages(connection)
	}

	lastKnown := Coordinate{Latitude: 49.276, Longitude: -122.906}
	hub.handleMove(moveEvent{connection: target, coord: lastKnown})
	for _, connection := range []*Conn{target, ordinary, viewer} {
		drainTestMessages(connection)
	}
	hub.unregisterConnection(target)
	removed := receiveTestMessage(t, ordinary)
	if removed.Command != CMD_REMOVE || removed.Data != string(targetID) {
		t.Errorf("regular disconnect = %#v", removed)
	}
	offlineMessage := receiveTestMessage(t, viewer)
	offlinePlayer := informPlayer(t, offlineMessage)
	if offlinePlayer.Status != StatusDisc || offlineMessage.Coord != lastKnown {
		t.Errorf("Admin offline update = %#v, player = %#v", offlineMessage, offlinePlayer)
	}
	if retained, exists := hub.offlineCoordinates[targetID]; !exists || retained != lastKnown {
		t.Errorf("retained location = %#v, exists = %v", retained, exists)
	}

	reconnectedViewer := newTestViewerConnection()
	hub.registerConnection(reconnectedViewer)
	foundOfflineSnapshot := false
	for len(reconnectedViewer.send) > 0 {
		message := receiveTestMessage(t, reconnectedViewer)
		if message.Command != CMD_INFORM {
			continue
		}
		player := informPlayer(t, message)
		if player.ID != targetID {
			continue
		}
		foundOfflineSnapshot = true
		if player.Status != StatusDisc || message.Coord != lastKnown {
			t.Errorf("offline Admin snapshot = %#v, player = %#v", message, player)
		}
	}
	if !foundOfflineSnapshot {
		t.Error("new Admin snapshot is missing the offline player")
	}

	if _, _, found := players.Update(targetID, TypeAntipac); !found {
		t.Fatal("update offline role")
	}
	hub.broadcastInform(targetID, nil)
	for _, adminViewer := range []*Conn{viewer, reconnectedViewer} {
		updated := receiveTestMessage(t, adminViewer)
		if player := informPlayer(t, updated); player.Type != TypeAntipac ||
			player.Status != StatusDisc || updated.Coord != lastKnown {
			t.Errorf("offline role update = %#v, player = %#v", updated, player)
		}
	}
	if len(ordinary.send) != 0 {
		t.Error("offline role update leaked to a regular player")
	}

	reconnectedOwner := newTestConnection(targetID)
	hub.registerConnection(reconnectedOwner)
	for _, adminViewer := range []*Conn{viewer, reconnectedViewer} {
		message := receiveTestMessage(t, adminViewer)
		if message.Command != CMD_REMOVE || message.Data != string(targetID) {
			t.Errorf("Admin reconnect removal = %#v", message)
		}
		if len(adminViewer.send) != 0 {
			t.Error("Admin received a current marker before fresh GPS")
		}
	}
	if _, exists := hub.offlineCoordinates[targetID]; exists {
		t.Error("reconnect retained the offline location")
	}
	drainTestMessages(reconnectedOwner)

	fresh := Coordinate{Latitude: 49.277, Longitude: -122.907}
	hub.handleMove(moveEvent{connection: reconnectedOwner, coord: fresh})
	for _, adminViewer := range []*Conn{viewer, reconnectedViewer} {
		message := receiveTestMessage(t, adminViewer)
		if player := informPlayer(t, message); player.Status != StatusConn ||
			message.Coord != fresh {
			t.Errorf("fresh Admin location = %#v, player = %#v", message, player)
		}
	}
	if len(ordinary.send) != 1 {
		t.Errorf("private fresh location produced %d regular messages, want one remove", len(ordinary.send))
	}
	drainTestMessages(ordinary)
	drainTestMessages(reconnectedOwner)

	hub.unregisterConnection(reconnectedOwner)
	drainTestMessages(viewer)
	drainTestMessages(reconnectedViewer)
	if _, exists := hub.offlineCoordinates[targetID]; !exists {
		t.Fatal("fresh coordinate was not retained after disconnect")
	}
	activeID := ordinaryID
	activeCoordinate := Coordinate{Latitude: 49.278, Longitude: -122.908}
	hub.coordinates[activeID] = activeCoordinate
	hub.clearOfflineLocations()
	if len(hub.offlineCoordinates) != 0 {
		t.Errorf("offline coordinates after reset = %#v", hub.offlineCoordinates)
	}
	if coordinate := hub.coordinates[activeID]; coordinate != activeCoordinate {
		t.Errorf("active coordinate after reset = %#v, want %#v", coordinate, activeCoordinate)
	}
	for _, adminViewer := range []*Conn{viewer, reconnectedViewer} {
		message := receiveTestMessage(t, adminViewer)
		if message.Command != CMD_REMOVE || message.Data != string(targetID) {
			t.Errorf("reset removal = %#v", message)
		}
	}
}

func newTestConnection(playerID PlayerID) *Conn {
	return &Conn{
		playerID: playerID,
		role:     playerConnection,
		send:     make(chan []byte, socketSendQueueSize),
	}
}

func newTestViewerConnection() *Conn {
	return &Conn{
		role: viewerConnection,
		send: make(chan []byte, socketSendQueueSize),
	}
}

func receiveTestMessage(t *testing.T, connection *Conn) Message {
	t.Helper()
	data := receiveTestData(t, connection)
	var message Message
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatalf("decode connection message: %v", err)
	}
	return message
}

func receiveTestData(t *testing.T, connection *Conn) []byte {
	t.Helper()
	select {
	case data, open := <-connection.send:
		if !open {
			t.Fatal("connection message queue is closed")
		}
		return data
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for a connection message")
		return nil
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

func queuedInformPlayers(t *testing.T, connection *Conn) map[PlayerID]PlayerResponse {
	t.Helper()
	players := make(map[PlayerID]PlayerResponse)
	for len(connection.send) > 0 {
		message := receiveTestMessage(t, connection)
		if message.Command != CMD_INFORM {
			continue
		}
		player := informPlayer(t, message)
		players[player.ID] = player
	}
	return players
}
