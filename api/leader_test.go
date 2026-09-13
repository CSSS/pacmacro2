package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type recordingLeaderConnection struct {
	mutex    sync.Mutex
	messages [][]byte
	closed   bool
}

func (c *recordingLeaderConnection) WriteMessage(_ int, data []byte) error {
	c.mutex.Lock()
	c.messages = append(c.messages, append([]byte(nil), data...))
	c.mutex.Unlock()
	return nil
}

func (c *recordingLeaderConnection) Close() error {
	c.mutex.Lock()
	c.closed = true
	c.mutex.Unlock()
	return nil
}

func (c *recordingLeaderConnection) decoded(t *testing.T) []LeaderSocketMessage {
	t.Helper()
	c.mutex.Lock()
	defer c.mutex.Unlock()
	messages := make([]LeaderSocketMessage, len(c.messages))
	for index, raw := range c.messages {
		if err := json.Unmarshal(raw, &messages[index]); err != nil {
			t.Fatalf("decode leader message: %v", err)
		}
	}
	return messages
}

func newLeaderTestState() (*Players, *Game, *Sockets, *Leader) {
	players := new(Players)
	players.Init()
	game := new(Game)
	sockets := new(Sockets)
	sockets.Init(players, game)
	leader := new(Leader)
	leader.Init(players, game, sockets)
	return players, game, sockets, leader
}

func addLeaderCookie(request *http.Request, ID PlayerID) {
	request.AddCookie(&http.Cookie{Name: leaderCookieName, Value: string(ID)})
}

func TestLeaderStateAuthenticationAndFiltering(t *testing.T) {
	players, game, _, leaderAPI := newLeaderTestState()
	leaderID := players.New(TypeAntiPacLeader, "Alice", StatusDisc)
	players.New(TypeLeader, "Generic", StatusDisc)
	players.New(TypeFlagLeader, "Flag", StatusDisc)
	playerID := players.New(TypeGhost, "Player", StatusConn)
	players.New(TypeHidden, "Hidden", StatusDisc)
	players.New(TypeAntipac, "Antipac", StatusDisc)
	players.New(TypePacman, "Pacman", StatusConn)
	players.New(TypeEdible, "Edible", StatusConn)
	game.SetFlagFound(true)

	unauthorized := httptest.NewRecorder()
	leaderAPI.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/api/leader/state.json", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Errorf("missing cookie status = %d, want 401", unauthorized.Code)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/leader/state.json", nil)
	addLeaderCookie(request, leaderID)
	response := httptest.NewRecorder()
	leaderAPI.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("state status = %d, want 200", response.Code)
	}
	var state LeaderStateResponse
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	if state.Leader.ID != leaderID || len(state.Players) != 3 || !state.IsFlagFound {
		t.Errorf("leader state = %#v", state)
	}
	foundGhost := false
	for _, player := range state.Players {
		if !IsLeaderPanelRole(player.Type) {
			t.Errorf("unlisted role in state: %#v", player)
		}
		foundGhost = foundGhost || player.ID == playerID
	}
	if !foundGhost {
		t.Error("Ghost missing from state")
	}

	genericID := players.New(TypeLeader, "Second generic", StatusDisc)
	genericRequest := httptest.NewRequest(http.MethodGet, "/api/leader/state.json", nil)
	addLeaderCookie(genericRequest, genericID)
	genericResponse := httptest.NewRecorder()
	leaderAPI.ServeHTTP(genericResponse, genericRequest)
	var genericState LeaderStateResponse
	if genericResponse.Code != http.StatusOK || json.NewDecoder(genericResponse.Body).Decode(&genericState) != nil {
		t.Fatalf("generic state response = %d", genericResponse.Code)
	}
	for _, player := range genericState.Players {
		if player.Type == TypeAntipac {
			t.Errorf("generic Leader received Antipac: %#v", genericState.Players)
		}
	}
}

func TestLeaderSocketHidesAntipacFromNonAntiPacLeaders(t *testing.T) {
	players, _, _, leaderAPI := newLeaderTestState()
	antiLeaderID := players.New(TypeAntiPacLeader, "Anti", StatusDisc)
	genericLeaderID := players.New(TypeLeader, "Generic", StatusDisc)
	playerID := players.New(TypeGhost, "Player", StatusDisc)
	antiConnection := new(recordingLeaderConnection)
	genericConnection := new(recordingLeaderConnection)
	if !leaderAPI.addConnection(antiConnection, antiLeaderID) ||
		!leaderAPI.addConnection(genericConnection, genericLeaderID) {
		t.Fatal("add leader connections")
	}

	players.Update(playerID, TypeAntipac)
	antiMessages := antiConnection.decoded(t)
	genericMessages := genericConnection.decoded(t)
	if antiMessages[len(antiMessages)-1].Event != LeaderEventUpsert ||
		antiMessages[len(antiMessages)-1].Player == nil ||
		antiMessages[len(antiMessages)-1].Player.Type != TypeAntipac {
		t.Fatalf("AntiPac Leader messages = %#v", antiMessages)
	}
	if genericMessages[len(genericMessages)-1].Event != LeaderEventRemove ||
		genericMessages[len(genericMessages)-1].PlayerID != playerID {
		t.Fatalf("generic Leader messages = %#v", genericMessages)
	}
}

func TestPromotedAntiPacLeaderReceivesCurrentAntipac(t *testing.T) {
	players, _, _, leaderAPI := newLeaderTestState()
	leaderID := players.New(TypeLeader, "Leader", StatusDisc)
	antipacID := players.New(TypeAntipac, "Antipac", StatusDisc)
	connection := new(recordingLeaderConnection)
	if !leaderAPI.addConnection(connection, leaderID) {
		t.Fatal("add leader connection")
	}

	players.Update(leaderID, TypeAntiPacLeader)
	messages := connection.decoded(t)
	if len(messages) != 4 || messages[1].Event != LeaderEventSelf ||
		messages[1].Leader == nil || messages[1].Leader.Type != TypeAntiPacLeader ||
		messages[2].Event != LeaderEventUpsert || messages[2].Player == nil ||
		messages[2].Player.ID != antipacID || messages[2].Player.Type != TypeAntipac ||
		messages[3].Event != LeaderEventRemove || messages[3].PlayerID != leaderID {
		t.Fatalf("promotion messages = %#v", messages)
	}
}

func TestAntiPacLeaderUpdateEligibilityAuthorizationAndUniqueness(t *testing.T) {
	players, _, _, leaderAPI := newLeaderTestState()
	leaderID := players.New(TypeAntiPacLeader, "Anti", StatusDisc)
	wrongLeaderID := players.New(TypeFlagLeader, "Flag", StatusDisc)
	existingID := players.New(TypeAntipac, "Existing", StatusConn)
	targetID := players.New(TypeGhost, "Target", StatusConn)
	offlineID := players.New(TypeGhost, "Offline", StatusDisc)

	request := newJSONRequest(t, http.MethodPost, "/api/leader/update/"+string(targetID), LeaderUpdateRequest{Type: new(TypeAntipac)})
	addLeaderCookie(request, leaderID)
	response := httptest.NewRecorder()
	leaderAPI.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("update status = %d, want 204", response.Code)
	}
	if player := players.Get(existingID); player == nil || player.Type != TypeGhost {
		t.Errorf("existing Antipac = %#v, want Ghost", player)
	}
	if player := players.Get(targetID); player == nil || player.Type != TypeAntipac {
		t.Errorf("target = %#v, want Antipac", player)
	}

	wrong := newJSONRequest(t, http.MethodPost, "/api/leader/update/"+string(targetID), LeaderUpdateRequest{Type: new(TypeGhost)})
	addLeaderCookie(wrong, wrongLeaderID)
	wrongResponse := httptest.NewRecorder()
	leaderAPI.ServeHTTP(wrongResponse, wrong)
	if wrongResponse.Code != http.StatusNoContent {
		t.Errorf("all-leader Ghost status = %d, want 204", wrongResponse.Code)
	}

	offline := newJSONRequest(t, http.MethodPost, "/api/leader/update/"+string(offlineID), LeaderUpdateRequest{Type: new(TypeAntipac)})
	addLeaderCookie(offline, leaderID)
	offlineResponse := httptest.NewRecorder()
	leaderAPI.ServeHTTP(offlineResponse, offline)
	if offlineResponse.Code != http.StatusNoContent {
		t.Errorf("offline target status = %d, want 204", offlineResponse.Code)
	}

	missing := newJSONRequest(t, http.MethodPost, "/api/leader/update/NOPE", LeaderUpdateRequest{Type: new(TypeGhost)})
	addLeaderCookie(missing, leaderID)
	missingResponse := httptest.NewRecorder()
	leaderAPI.ServeHTTP(missingResponse, missing)
	if missingResponse.Code != http.StatusNotFound {
		t.Errorf("missing target status = %d, want 404", missingResponse.Code)
	}

	malformed := newJSONRequest(t, http.MethodPost, "/api/leader/update/"+string(targetID), map[string]any{"type": 99})
	addLeaderCookie(malformed, leaderID)
	malformedResponse := httptest.NewRecorder()
	leaderAPI.ServeHTTP(malformedResponse, malformed)
	if malformedResponse.Code != http.StatusBadRequest {
		t.Errorf("invalid type status = %d, want 400", malformedResponse.Code)
	}
}

func TestAllLeadersCanHideNonLeadersRegardlessOfStatus(t *testing.T) {
	players, _, _, leaderAPI := newLeaderTestState()
	leaders := []struct {
		name       string
		playerType PlayerType
	}{
		{"generic", TypeLeader},
		{"anti-pac", TypeAntiPacLeader},
		{"flag", TypeFlagLeader},
	}
	targets := []struct {
		name       string
		playerType PlayerType
		status     PlayerStatus
	}{
		{"connected Antipac", TypeAntipac, StatusConn},
		{"disconnected Ghost", TypeGhost, StatusDisc},
		{"connected Hidden", TypeHidden, StatusConn},
	}

	for index, leader := range leaders {
		leaderID := players.New(leader.playerType, leader.name, StatusDisc)
		target := targets[index]
		targetID := players.New(target.playerType, target.name, target.status)
		for range 2 {
			request := newJSONRequest(t, http.MethodPost, "/api/leader/update/"+string(targetID), LeaderUpdateRequest{Type: new(TypeHidden)})
			addLeaderCookie(request, leaderID)
			response := httptest.NewRecorder()
			leaderAPI.ServeHTTP(response, request)
			if response.Code != http.StatusNoContent {
				t.Errorf("%s leader hide status = %d, want 204", leader.name, response.Code)
			}
		}
		if player := players.Get(targetID); player == nil || player.Type != TypeHidden {
			t.Errorf("%s target = %#v, want Hidden", leader.name, player)
		}
	}
}

func TestLeadersCannotHideLeaderTargets(t *testing.T) {
	players, _, _, leaderAPI := newLeaderTestState()
	requesterID := players.New(TypeLeader, "Requester", StatusDisc)
	for _, targetType := range []PlayerType{TypeLeader, TypeAntiPacLeader, TypeFlagLeader} {
		targetID := players.New(targetType, TypeString(targetType), StatusDisc)
		request := newJSONRequest(t, http.MethodPost, "/api/leader/update/"+string(targetID), LeaderUpdateRequest{Type: new(TypeHidden)})
		addLeaderCookie(request, requesterID)
		response := httptest.NewRecorder()
		leaderAPI.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Errorf("hide %s status = %d, want 403", TypeString(targetType), response.Code)
		}
		if player := players.Get(targetID); player == nil || player.Type != targetType {
			t.Errorf("%s target = %#v, want unchanged", TypeString(targetType), player)
		}
	}
}

func TestFlagLeaderUpdatesAreCapabilityCheckedAndIdempotent(t *testing.T) {
	players, game, _, leaderAPI := newLeaderTestState()
	flagLeaderID := players.New(TypeFlagLeader, "Flag", StatusDisc)
	genericID := players.New(TypeLeader, "Generic", StatusDisc)
	updates := 0
	game.AddObserver(func(GameState) { updates++ })

	for range 2 {
		request := newJSONRequest(t, http.MethodPost, "/api/leader/flag", LeaderFlagRequest{IsFlagFound: new(true)})
		addLeaderCookie(request, flagLeaderID)
		response := httptest.NewRecorder()
		leaderAPI.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("flag status = %d, want 204", response.Code)
		}
	}
	if !game.State().IsFlagFound || updates != 1 {
		t.Errorf("flag state = %#v, updates = %d; want true and 1", game.State(), updates)
	}

	wrong := newJSONRequest(t, http.MethodPost, "/api/leader/flag", LeaderFlagRequest{IsFlagFound: new(false)})
	addLeaderCookie(wrong, genericID)
	wrongResponse := httptest.NewRecorder()
	leaderAPI.ServeHTTP(wrongResponse, wrong)
	if wrongResponse.Code != http.StatusForbidden {
		t.Errorf("generic leader flag status = %d, want 403", wrongResponse.Code)
	}
}

func TestLeaderSocketSnapshotSelfRoleAndRevocation(t *testing.T) {
	players, game, _, leaderAPI := newLeaderTestState()
	leaderID := players.New(TypeAntiPacLeader, "Leader", StatusDisc)
	players.New(TypeLeader, "Excluded", StatusDisc)
	playerID := players.New(TypeGhost, "Player", StatusConn)
	game.SetFlagFound(true)
	connection := new(recordingLeaderConnection)
	if !leaderAPI.addConnection(connection, leaderID) {
		t.Fatal("add leader connection")
	}
	messages := connection.decoded(t)
	if len(messages) != 1 || messages[0].Event != LeaderEventSnapshot ||
		messages[0].Leader == nil || messages[0].Leader.ID != leaderID ||
		len(messages[0].Players) != 1 || messages[0].Players[0].ID != playerID ||
		messages[0].IsFlagFound == nil || !*messages[0].IsFlagFound {
		t.Fatalf("snapshot = %#v", messages)
	}

	players.Update(leaderID, TypeLeader)
	messages = connection.decoded(t)
	if len(messages) != 3 || messages[1].Event != LeaderEventSelf ||
		messages[1].Leader == nil || messages[1].Leader.Type != TypeLeader ||
		messages[2].Event != LeaderEventRemove {
		t.Fatalf("role messages = %#v", messages)
	}
	if connection.closed {
		t.Fatal("generic Leader connection was closed")
	}

	players.Update(leaderID, TypeGhost)
	messages = connection.decoded(t)
	if messages[len(messages)-1].Event != LeaderEventRevoked || !connection.closed {
		t.Fatalf("revocation messages = %#v, closed = %v", messages, connection.closed)
	}
}

func TestLeaderSocketSupportsMultipleConnectionsAndLiveFlag(t *testing.T) {
	players, game, _, leaderAPI := newLeaderTestState()
	leaderID := players.New(TypeFlagLeader, "Flag", StatusDisc)
	first := new(recordingLeaderConnection)
	second := new(recordingLeaderConnection)
	if !leaderAPI.addConnection(first, leaderID) || !leaderAPI.addConnection(second, leaderID) {
		t.Fatal("add connections")
	}
	game.SetFlagFound(true)
	for index, connection := range []*recordingLeaderConnection{first, second} {
		messages := connection.decoded(t)
		if len(messages) != 2 || messages[1].Event != LeaderEventFlag ||
			messages[1].IsFlagFound == nil || !*messages[1].IsFlagFound {
			t.Errorf("connection %d messages = %#v", index, messages)
		}
	}
}

func TestPlayerRemovalRevokesKickedLeaderAndUpdatesOtherLeaderPanels(t *testing.T) {
	players, _, _, leaderAPI := newLeaderTestState()
	kickedID := players.New(TypeLeader, "Kicked", StatusDisc)
	otherID := players.New(TypeLeader, "Other", StatusDisc)
	kicked := new(recordingLeaderConnection)
	other := new(recordingLeaderConnection)
	if !leaderAPI.addConnection(kicked, kickedID) || !leaderAPI.addConnection(other, otherID) {
		t.Fatal("add leader connections")
	}

	players.Delete(kickedID)

	kickedMessages := kicked.decoded(t)
	if kickedMessages[len(kickedMessages)-1].Event != LeaderEventRevoked || !kicked.closed {
		t.Errorf("kicked leader messages = %#v, closed = %v", kickedMessages, kicked.closed)
	}
	otherMessages := other.decoded(t)
	if len(otherMessages) != 2 || otherMessages[1].Event != LeaderEventRemove ||
		otherMessages[1].PlayerID != kickedID || other.closed {
		t.Errorf("other leader messages = %#v, closed = %v", otherMessages, other.closed)
	}
}

func TestPlayerRemovalNotifiesEveryAuthorizedLeader(t *testing.T) {
	players, _, _, leaderAPI := newLeaderTestState()
	antiLeaderID := players.New(TypeAntiPacLeader, "Anti", StatusDisc)
	genericLeaderID := players.New(TypeLeader, "Generic", StatusDisc)
	flagLeaderID := players.New(TypeFlagLeader, "Flag", StatusDisc)
	targetID := players.New(TypeAntipac, "Antipac", StatusDisc)

	antiConnection := new(recordingLeaderConnection)
	genericConnection := new(recordingLeaderConnection)
	flagConnection := new(recordingLeaderConnection)
	for ID, connection := range map[PlayerID]*recordingLeaderConnection{
		antiLeaderID:    antiConnection,
		genericLeaderID: genericConnection,
		flagLeaderID:    flagConnection,
	} {
		if !leaderAPI.addConnection(connection, ID) {
			t.Fatalf("add leader connection for %q", ID)
		}
	}

	players.Delete(targetID)

	for label, connection := range map[string]*recordingLeaderConnection{
		"AntiPac": antiConnection,
		"generic": genericConnection,
		"flag":    flagConnection,
	} {
		messages := connection.decoded(t)
		if len(messages) != 2 || messages[1].Event != LeaderEventRemove ||
			messages[1].PlayerID != targetID {
			t.Errorf("%s Leader messages = %#v", label, messages)
		}
	}
}
