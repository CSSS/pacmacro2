package api

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
)

type recordingAdminConnection struct {
	messages [][]byte
	closed   bool
}

type recordingGameSocket struct {
	closeMessageType int
	closeData        []byte
	closed           bool
}

func (c *recordingGameSocket) ReadMessage() (int, []byte, error) {
	return 0, nil, errors.New("not implemented")
}

func (c *recordingGameSocket) WriteMessage(int, []byte) error {
	return nil
}

func (c *recordingGameSocket) WriteControl(messageType int, data []byte, _ time.Time) error {
	c.closeMessageType = messageType
	c.closeData = append([]byte(nil), data...)
	return nil
}

func (c *recordingGameSocket) SetWriteDeadline(time.Time) error {
	return nil
}

func (c *recordingGameSocket) Close() error {
	c.closed = true
	return nil
}

func (c *recordingAdminConnection) WriteMessage(_ int, data []byte) error {
	c.messages = append(c.messages, append([]byte(nil), data...))
	return nil
}

func (c *recordingAdminConnection) Close() error {
	c.closed = true
	return nil
}

func newAdminTestState(t *testing.T, password string) (*Players, *Admin) {
	t.Helper()
	players := new(Players)
	sockets := new(Sockets)
	admin := new(Admin)
	players.Init()
	sockets.Init(players)
	admin.Init(players, sockets, password)
	return players, admin
}

func registerTestAdmin(t *testing.T, admin *Admin, password string) *http.Cookie {
	t.Helper()
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/register",
		AdminRegistrationRequest{Pass: password},
	)
	request.Header.Set("X-Forwarded-Proto", "https")
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("admin registration status = %d, want %d", response.Code, http.StatusNoContent)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("admin registration cookies = %d, want 1", len(cookies))
	}
	return cookies[0]
}

func TestAdminRegistrationSetsSecureHTTPOnlyCookieWithoutPlayer(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")

	if cookie.Name != adminCookieName {
		t.Errorf("cookie name = %q, want %q", cookie.Name, adminCookieName)
	}
	if !cookie.HttpOnly {
		t.Error("admin cookie must be HttpOnly")
	}
	if !cookie.Secure {
		t.Error("admin cookie must be Secure behind HTTPS")
	}
	if cookie.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie SameSite = %d, want Strict", cookie.SameSite)
	}
	if cookie.Path != "/api/admin" {
		t.Errorf("cookie path = %q, want /api/admin", cookie.Path)
	}
	if len(players.players) != 0 {
		t.Errorf("player count = %d, want 0 after admin registration", len(players.players))
	}
}

func TestAdminRegistrationRejectsWrongPasswordAndAllowsSessionRenewal(t *testing.T) {
	_, admin := newAdminTestState(t, "top-secret")

	wrongRequest := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/register",
		AdminRegistrationRequest{Pass: "wrong"},
	)
	wrongResponse := httptest.NewRecorder()
	admin.ServeHTTP(wrongResponse, wrongRequest)
	if wrongResponse.Code != http.StatusUnauthorized {
		t.Errorf("wrong password status = %d, want %d", wrongResponse.Code, http.StatusUnauthorized)
	}

	registerTestAdmin(t, admin, "top-secret")
	renewalRequest := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/register",
		AdminRegistrationRequest{Pass: "top-secret"},
	)
	renewalResponse := httptest.NewRecorder()
	admin.ServeHTTP(renewalResponse, renewalRequest)
	if renewalResponse.Code != http.StatusNoContent {
		t.Errorf("session renewal status = %d, want %d", renewalResponse.Code, http.StatusNoContent)
	}
}

func TestAdminStartBeginsTwentyMinuteGame(t *testing.T) {
	players := new(Players)
	players.Init()
	game := new(Game)
	sockets := new(Sockets)
	sockets.Init(players, game)
	admin := new(Admin)
	admin.Init(players, sockets, "top-secret", game)
	cookie := registerTestAdmin(t, admin, "top-secret")
	connection := new(recordingAdminConnection)
	if !admin.addConnection(connection) {
		t.Fatal("add admin socket connection")
	}
	defer admin.removeConnection(connection)

	request := httptest.NewRequest(http.MethodPost, "/api/admin/start", nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("start game status = %d, want %d", response.Code, http.StatusNoContent)
	}
	state := game.State()
	if state.Phase != GamePhaseInProgress || state.StartTime == nil || state.EndTime == nil {
		t.Fatalf("game state after start = %#v, want an active deadline", state)
	}
	if got := *state.EndTime - *state.StartTime; got != (20 * time.Minute).Milliseconds() {
		t.Errorf("game duration = %dms, want %dms", got, (20 * time.Minute).Milliseconds())
	}
	if len(connection.messages) != 3 {
		t.Fatalf("Admin socket messages = %d, want snapshot, flag, and state", len(connection.messages))
	}
	var stateUpdate AdminSocketMessage
	if err := json.Unmarshal(connection.messages[2], &stateUpdate); err != nil {
		t.Fatal(err)
	}
	if stateUpdate.Event != AdminEventState || stateUpdate.State == nil ||
		stateUpdate.State.Phase != GamePhaseInProgress {
		t.Errorf("Admin timer socket update = %#v", stateUpdate)
	}

	duplicate := httptest.NewRequest(http.MethodPost, "/api/admin/start", nil)
	duplicate.AddCookie(cookie)
	duplicateResponse := httptest.NewRecorder()
	admin.ServeHTTP(duplicateResponse, duplicate)
	if duplicateResponse.Code != http.StatusConflict {
		t.Errorf("duplicate start status = %d, want %d", duplicateResponse.Code, http.StatusConflict)
	}
	game.Reset()
}

func TestAdminStartRequiresPostAndAuthentication(t *testing.T) {
	_, admin := newAdminTestState(t, "top-secret")

	unauthorizedRequest := httptest.NewRequest(http.MethodPost, "/api/admin/start", nil)
	unauthorizedResponse := httptest.NewRecorder()
	admin.ServeHTTP(unauthorizedResponse, unauthorizedRequest)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Errorf("unauthorized start status = %d, want %d", unauthorizedResponse.Code, http.StatusUnauthorized)
	}

	cookie := registerTestAdmin(t, admin, "top-secret")
	getRequest := httptest.NewRequest(http.MethodGet, "/api/admin/start", nil)
	getRequest.AddCookie(cookie)
	getResponse := httptest.NewRecorder()
	admin.ServeHTTP(getResponse, getRequest)
	if getResponse.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET start status = %d, want %d", getResponse.Code, http.StatusMethodNotAllowed)
	}
}

func TestAdminFlagCaptureStartsPacmanEmpowermentTimer(t *testing.T) {
	players := new(Players)
	players.Init()
	game := new(Game)
	sockets := new(Sockets)
	sockets.Init(players, game)
	admin := new(Admin)
	admin.Init(players, sockets, "top-secret", game)
	cookie := registerTestAdmin(t, admin, "top-secret")
	game.StartGame()
	started := game.State()

	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/flag",
		AdminFlagRequest{IsFlagFound: new(true)},
	)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("capture flag status = %d, want %d", response.Code, http.StatusNoContent)
	}
	state := game.State()
	if !state.IsFlagFound || state.Phase != GamePhaseInProgress || state.StartTime == nil || state.EndTime == nil {
		t.Fatalf("game state after flag capture = %#v, want Pacman empowered with an active deadline", state)
	}
	if started.StartTime == nil || *state.StartTime != *started.StartTime {
		t.Errorf("start time after flag capture = %v, want %v", state.StartTime, started.StartTime)
	}
	remaining := *state.EndTime - state.ServerTime
	if remaining > (10*time.Minute).Milliseconds() || remaining < (10*time.Minute-time.Second).Milliseconds() {
		t.Errorf("flag capture remaining time = %dms, want approximately ten minutes", remaining)
	}
	game.Reset()
}

func TestAdminCookieAuthorizesPlayerUpdate(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	playerID := players.New(TypeGhost, "Player", StatusConn)
	gameConnection := newTestConnection(playerID)
	admin.sockets.hub.registerConnection(gameConnection)
	_ = receiveTestMessage(t, gameConnection) // initial player snapshot

	playerType := TypeEdible
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/update/"+string(playerID),
		AdminUpdateRequest{Type: &playerType},
	)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("authorized update status = %d, want %d", response.Code, http.StatusNoContent)
	}
	player := players.Get(playerID)
	if player.Type != TypeEdible {
		t.Errorf("updated player type = %d, want %d", player.Type, TypeEdible)
	}

	updatedPlayer := informPlayer(t, receiveTestMessage(t, gameConnection))
	if updatedPlayer.ID != playerID || updatedPlayer.Type != TypeEdible {
		t.Errorf("informed player = %#v, want updated player %q", updatedPlayer, playerID)
	}
}

func TestAdminResetPreservesLeadersAndClearsFlag(t *testing.T) {
	players := new(Players)
	players.Init()
	game := new(Game)
	sockets := new(Sockets)
	sockets.Init(players, game)
	admin := new(Admin)
	admin.Init(players, sockets, "top-secret", game)
	cookie := registerTestAdmin(t, admin, "top-secret")
	for _, playerType := range []PlayerType{TypeLeader, TypeAntiPacLeader, TypeFlagLeader} {
		players.New(playerType, TypeString(playerType), StatusDisc)
	}
	for _, playerType := range []PlayerType{TypePacman, TypeAntipac, TypeEdible, TypeHidden} {
		players.New(playerType, TypeString(playerType), StatusDisc)
	}
	game.SetFlagFound(true)
	game.StartGame()

	request := httptest.NewRequest(http.MethodPost, "/api/admin/reset", nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("reset status = %d, want 204", response.Code)
	}
	state := game.State()
	if state.IsFlagFound || state.Phase != GamePhaseNotStarted || state.StartTime != nil || state.EndTime != nil {
		t.Errorf("game state after reset = %#v, want initial state", state)
	}
	for _, player := range players.List() {
		if !IsLeaderType(player.Type) && player.Type != TypeGhost {
			t.Errorf("non-leader after reset = %#v", player)
		}
	}
}

func TestAdminFlagUpdatesSharedStateAndSocketClients(t *testing.T) {
	players := new(Players)
	players.Init()
	game := new(Game)
	sockets := new(Sockets)
	sockets.Init(players, game)
	admin := new(Admin)
	admin.Init(players, sockets, "top-secret", game)
	cookie := registerTestAdmin(t, admin, "top-secret")
	connection := new(recordingAdminConnection)
	if !admin.addConnection(connection) {
		t.Fatal("add admin socket connection")
	}
	defer admin.removeConnection(connection)

	var snapshot AdminSocketMessage
	if err := json.Unmarshal(connection.messages[0], &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Event != AdminEventSnapshot || snapshot.IsFlagFound == nil ||
		*snapshot.IsFlagFound || snapshot.State == nil || snapshot.State.Phase != GamePhaseNotStarted {
		t.Fatalf("initial Admin snapshot = %#v", snapshot)
	}

	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/flag",
		AdminFlagRequest{IsFlagFound: new(true)},
	)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("Admin flag status = %d, want 204", response.Code)
	}
	if !game.State().IsFlagFound {
		t.Error("Admin flag update did not change shared game state")
	}
	if len(connection.messages) != 3 {
		t.Fatalf("Admin socket messages = %d, want snapshot, flag, and state", len(connection.messages))
	}
	var update AdminSocketMessage
	if err := json.Unmarshal(connection.messages[1], &update); err != nil {
		t.Fatal(err)
	}
	if update.Event != AdminEventFlag || update.IsFlagFound == nil || !*update.IsFlagFound {
		t.Errorf("Admin flag socket update = %#v", update)
	}
	var stateUpdate AdminSocketMessage
	if err := json.Unmarshal(connection.messages[2], &stateUpdate); err != nil {
		t.Fatal(err)
	}
	if stateUpdate.Event != AdminEventState || stateUpdate.State == nil ||
		!stateUpdate.State.IsFlagFound {
		t.Errorf("Admin state socket update = %#v", stateUpdate)
	}

	unauthorized := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/flag",
		AdminFlagRequest{IsFlagFound: new(false)},
	)
	unauthorizedResponse := httptest.NewRecorder()
	admin.ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Errorf("unauthorized Admin flag status = %d, want 401", unauthorizedResponse.Code)
	}
}

func TestAdminResetClearsOfflineLocationsButPreservesActiveCoordinates(t *testing.T) {
	players := new(Players)
	players.Init()
	game := new(Game)
	sockets := new(Sockets)
	sockets.Init(players, game)
	admin := new(Admin)
	admin.Init(players, sockets, "top-secret", game)
	cookie := registerTestAdmin(t, admin, "top-secret")

	activeID := players.New(TypeLeader, "Active", StatusDisc)
	offlineID := players.New(TypeFlagLeader, "Offline", StatusDisc)
	active := newTestConnection(activeID)
	sockets.hub.registerConnection(active)
	drainTestMessages(active)
	activeCoordinate := Coordinate{Latitude: 49.275, Longitude: -122.905}
	offlineCoordinate := Coordinate{Latitude: 49.276, Longitude: -122.906}
	sockets.hub.coordinates[activeID] = activeCoordinate
	sockets.hub.offlineCoordinates[offlineID] = offlineCoordinate

	viewer := newTestViewerConnection()
	sockets.hub.registerConnection(viewer)
	drainTestMessages(viewer)

	request := httptest.NewRequest(http.MethodPost, "/api/admin/reset", nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("reset status = %d, want 204", response.Code)
	}
	if len(sockets.hub.offlineCoordinates) != 0 {
		t.Errorf("offline coordinates after reset = %#v", sockets.hub.offlineCoordinates)
	}
	if coordinate := sockets.hub.coordinates[activeID]; coordinate != activeCoordinate {
		t.Errorf("active coordinate after reset = %#v, want %#v", coordinate, activeCoordinate)
	}
	message := receiveTestMessage(t, viewer)
	if message.Command != CMD_REMOVE || message.Data != string(offlineID) {
		t.Errorf("Admin reset location removal = %#v", message)
	}
}

func TestAdminSelectingPacmanDemotesAndBroadcastsExistingPacman(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	existingPacmanID := players.New(TypePacman, "Existing", StatusDisc)
	targetID := players.New(TypeGhost, "Target", StatusDisc)

	existingConnection := newTestConnection(existingPacmanID)
	targetConnection := newTestConnection(targetID)
	admin.sockets.hub.registerConnection(existingConnection)
	admin.sockets.hub.registerConnection(targetConnection)
	drainTestMessages(existingConnection)
	drainTestMessages(targetConnection)

	playerType := TypePacman
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/update/"+string(targetID),
		AdminUpdateRequest{Type: &playerType},
	)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("Pacman update status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if player := players.Get(existingPacmanID); player == nil || player.Type != TypeGhost {
		t.Errorf("existing Pacman = %#v, want Ghost", player)
	}
	if player := players.Get(targetID); player == nil || player.Type != TypePacman {
		t.Errorf("selected player = %#v, want Pacman", player)
	}

	for _, connection := range []*Conn{existingConnection, targetConnection} {
		informedTypes := make(map[PlayerID]PlayerType)
		for range 2 {
			informed := informPlayer(t, receiveTestMessage(t, connection))
			informedTypes[informed.ID] = informed.Type
		}
		if informedTypes[existingPacmanID] != TypeGhost || informedTypes[targetID] != TypePacman {
			t.Errorf("broadcast types = %#v, want existing Ghost and target Pacman", informedTypes)
		}
	}
}

func TestAdminUpdateChangesDisconnectedPlayerWithoutGameBroadcast(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	activePlayerID := players.New(TypePacman, "Active", StatusDisc)
	activeConnection := newTestConnection(activePlayerID)
	admin.sockets.hub.registerConnection(activeConnection)
	drainTestMessages(activeConnection)
	playerID := players.New(TypeGhost, "Player", StatusDisc)
	playerType := TypeLeader
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/update/"+string(playerID),
		AdminUpdateRequest{Type: &playerType},
	)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Errorf("disconnected update status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if player := players.Get(playerID); player == nil || player.Type != TypeLeader {
		t.Errorf("disconnected player = %#v, want Leader type", player)
	}
	if len(activeConnection.send) != 0 {
		t.Error("disconnected player type was broadcast to the game hub")
	}
}

func TestAdminSocketRequiresAuthenticationBeforeUpgrade(t *testing.T) {
	_, admin := newAdminTestState(t, "top-secret")
	request := httptest.NewRequest(http.MethodGet, "/api/admin/ws", nil)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Errorf("unauthorized socket status = %d, want %d", response.Code, http.StatusUnauthorized)
	}

	cookie := registerTestAdmin(t, admin, "top-secret")
	authorizedRequest := httptest.NewRequest(http.MethodGet, "/api/admin/ws", nil)
	authorizedRequest.AddCookie(cookie)
	authorizedResponse := httptest.NewRecorder()
	admin.ServeHTTP(authorizedResponse, authorizedRequest)
	if authorizedResponse.Code != http.StatusBadRequest {
		t.Errorf("authenticated non-upgrade status = %d, want %d", authorizedResponse.Code, http.StatusBadRequest)
	}
}

func TestAdminMapSocketRequiresAuthenticationBeforeUpgrade(t *testing.T) {
	_, admin := newAdminTestState(t, "top-secret")
	request := httptest.NewRequest(http.MethodGet, "/api/admin/map/ws", nil)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Errorf("unauthorized map socket status = %d, want %d", response.Code, http.StatusUnauthorized)
	}

	methodRequest := httptest.NewRequest(http.MethodPost, "/api/admin/map/ws", nil)
	methodResponse := httptest.NewRecorder()
	admin.ServeHTTP(methodResponse, methodRequest)
	if methodResponse.Code != http.StatusMethodNotAllowed {
		t.Errorf("map socket POST status = %d, want %d", methodResponse.Code, http.StatusMethodNotAllowed)
	}

	cookie := registerTestAdmin(t, admin, "top-secret")
	authorizedRequest := httptest.NewRequest(http.MethodGet, "/api/admin/map/ws", nil)
	authorizedRequest.AddCookie(cookie)
	authorizedResponse := httptest.NewRecorder()
	admin.ServeHTTP(authorizedResponse, authorizedRequest)
	if authorizedResponse.Code != http.StatusBadRequest {
		t.Errorf("authenticated non-upgrade map status = %d, want %d", authorizedResponse.Code, http.StatusBadRequest)
	}
}

func TestAdminSocketReceivesPlayerRegistrationAndStatus(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	connection := new(recordingAdminConnection)
	if !admin.addConnection(connection) {
		t.Fatal("add admin test connection")
	}
	defer admin.removeConnection(connection)

	playerID := players.New(TypeGhost, "Test", StatusDisc)
	players.SetStatus(playerID, StatusConn)

	if len(connection.messages) != 3 {
		t.Fatalf("admin socket messages = %d, want snapshot and two updates", len(connection.messages))
	}
	var snapshot AdminSocketMessage
	if err := json.Unmarshal(connection.messages[0], &snapshot); err != nil {
		t.Fatalf("decode socket snapshot: %v", err)
	}
	if snapshot.Event != AdminEventSnapshot || snapshot.Players == nil {
		t.Errorf("initial socket snapshot = %#v, want an empty player array", snapshot)
	}
	var registered AdminSocketMessage
	if err := json.Unmarshal(connection.messages[1], &registered); err != nil {
		t.Fatalf("decode registration update: %v", err)
	}
	if registered.Event != AdminEventUpsert || registered.Player == nil ||
		registered.Player.ID != playerID || registered.Player.Status != StatusDisc ||
		registered.Player.Type != TypeGhost {
		t.Errorf("registration update = %#v", registered)
	}
	var connected AdminSocketMessage
	if err := json.Unmarshal(connection.messages[2], &connected); err != nil {
		t.Fatalf("decode connection update: %v", err)
	}
	if connected.Player == nil || connected.Player.Status != StatusConn {
		t.Errorf("connection update = %#v", connected)
	}
}

func TestAdminUpdateRequiresCookieAndRejectsInvalidType(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	playerID := players.New(TypeGhost, "Player", StatusDisc)
	invalidType := PlayerType(99)
	requestBody := AdminUpdateRequest{Type: &invalidType}

	unauthorizedRequest := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/update/"+string(playerID),
		requestBody,
	)
	unauthorizedResponse := httptest.NewRecorder()
	admin.ServeHTTP(unauthorizedResponse, unauthorizedRequest)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Errorf("update without cookie status = %d, want %d", unauthorizedResponse.Code, http.StatusUnauthorized)
	}

	invalidTypeRequest := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/update/"+string(playerID),
		requestBody,
	)
	invalidTypeRequest.AddCookie(cookie)
	invalidTypeResponse := httptest.NewRecorder()
	admin.ServeHTTP(invalidTypeResponse, invalidTypeRequest)
	if invalidTypeResponse.Code != http.StatusBadRequest {
		t.Errorf("invalid type status = %d, want %d", invalidTypeResponse.Code, http.StatusBadRequest)
	}
}

func TestAdminUpdateAcceptsEveryPlayerType(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	playerID := players.New(TypeGhost, "Player", StatusDisc)
	playerTypes := []PlayerType{
		TypeHidden,
		TypePacman,
		TypeAntipac,
		TypeGhost,
		TypeEdible,
		TypeLeader,
	}

	for _, playerType := range playerTypes {
		request := newJSONRequest(
			t,
			http.MethodPost,
			"/api/admin/update/"+string(playerID),
			AdminUpdateRequest{Type: &playerType},
		)
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		admin.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Errorf("type %d status = %d, want %d", playerType, response.Code, http.StatusNoContent)
		}
	}
}

func TestAdminKickAuthorizationMethodMissingAndOfflinePlayer(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	playerID := players.New(TypeGhost, "Offline", StatusDisc)

	wrongMethod := httptest.NewRecorder()
	admin.ServeHTTP(
		wrongMethod,
		httptest.NewRequest(http.MethodGet, "/api/admin/kick/"+string(playerID), nil),
	)
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Errorf("kick GET status = %d, want 405", wrongMethod.Code)
	}

	unauthorized := httptest.NewRecorder()
	admin.ServeHTTP(
		unauthorized,
		httptest.NewRequest(http.MethodPost, "/api/admin/kick/"+string(playerID), nil),
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Errorf("unauthorized kick status = %d, want 401", unauthorized.Code)
	}

	missingRequest := httptest.NewRequest(http.MethodPost, "/api/admin/kick/MISSING", nil)
	missingRequest.AddCookie(cookie)
	missing := httptest.NewRecorder()
	admin.ServeHTTP(missing, missingRequest)
	if missing.Code != http.StatusNotFound {
		t.Errorf("missing kick status = %d, want 404", missing.Code)
	}

	kickRequest := httptest.NewRequest(
		http.MethodPost,
		"/api/admin/kick/"+string(playerID),
		nil,
	)
	kickRequest.AddCookie(cookie)
	kicked := httptest.NewRecorder()
	admin.ServeHTTP(kicked, kickRequest)
	if kicked.Code != http.StatusNoContent {
		t.Fatalf("offline kick status = %d, want 204", kicked.Code)
	}
	if player := players.Get(playerID); player != nil {
		t.Errorf("kicked offline player = %#v, want nil", player)
	}

	verify := httptest.NewRecorder()
	verifyRequest := httptest.NewRequest(http.MethodGet, "/api/player/verify", nil)
	verifyRequest.AddCookie(&http.Cookie{Name: "id", Value: string(playerID)})
	players.ServeHTTP(verify, verifyRequest)
	if verify.Code != http.StatusUnauthorized {
		t.Errorf("kicked player verification status = %d, want 401", verify.Code)
	}
}

func TestAdminKickConnectedPlayerCleansHubAndBroadcastsRemoval(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	targetID := players.New(TypeGhost, "Target", StatusDisc)
	observerID := players.New(TypeLeader, "Observer", StatusDisc)
	firstTarget := newTestConnection(targetID)
	secondTarget := newTestConnection(targetID)
	firstSocket := new(recordingGameSocket)
	secondSocket := new(recordingGameSocket)
	firstTarget.socket = firstSocket
	secondTarget.socket = secondSocket
	observer := newTestConnection(observerID)
	viewer := newTestViewerConnection()
	for _, connection := range []*Conn{firstTarget, secondTarget, observer, viewer} {
		admin.sockets.hub.register <- connection
		// Receiving a snapshot also proves that the hub accepted the connection.
		_ = receiveTestMessage(t, connection)
	}
	for _, connection := range []*Conn{firstTarget, secondTarget, observer, viewer} {
		drainTestMessages(connection)
	}
	admin.sockets.hub.move <- moveEvent{
		connection: firstTarget,
		coord:      Coordinate{Latitude: 49.27, Longitude: -122.91},
	}
	admin.sockets.ClearOfflineLocations() // Wait until the preceding move is applied.
	for _, connection := range []*Conn{firstTarget, secondTarget, observer, viewer} {
		drainTestMessages(connection)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/admin/kick/"+string(targetID), nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("connected kick status = %d, want 204", response.Code)
	}
	if player := players.Get(targetID); player != nil {
		t.Errorf("kicked connected player = %#v, want nil", player)
	}
	if admin.sockets.hub.hasConnectionForID(targetID) {
		t.Error("kicked player still has a hub connection")
	}
	if _, exists := admin.sockets.hub.coordinates[targetID]; exists {
		t.Error("kicked player's active coordinate remains")
	}
	if _, exists := admin.sockets.hub.offlineCoordinates[targetID]; exists {
		t.Error("kicked player's offline coordinate remains")
	}
	if _, exists := admin.sockets.hub.awaitingFresh[targetID]; exists {
		t.Error("kicked player's pending-location state remains")
	}
	for index, socket := range []*recordingGameSocket{firstSocket, secondSocket} {
		if !socket.closed || socket.closeMessageType != ws.CloseMessage || len(socket.closeData) < 2 {
			t.Errorf("connection %d close = %#v", index, socket)
			continue
		}
		if code := int(binary.BigEndian.Uint16(socket.closeData[:2])); code != ws.ClosePolicyViolation {
			t.Errorf("connection %d close code = %d, want 1008", index, code)
		}
		if reason := string(socket.closeData[2:]); reason != playerRemovedCloseReason {
			t.Errorf("connection %d close reason = %q", index, reason)
		}
	}
	for label, connection := range map[string]*Conn{"player": observer, "viewer": viewer} {
		message := receiveTestMessage(t, connection)
		if message.Command != CMD_REMOVE || message.Data != string(targetID) {
			t.Errorf("%s removal = %#v", label, message)
		}
	}
}

func TestAdminKickBroadcastsRosterRemovalToEveryAdminTab(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	first := new(recordingAdminConnection)
	second := new(recordingAdminConnection)
	if !admin.addConnection(first) || !admin.addConnection(second) {
		t.Fatal("add Admin connections")
	}
	playerID := players.New(TypeGhost, "Player", StatusDisc)

	if !admin.sockets.KickPlayer(playerID) {
		t.Fatal("kick player")
	}
	for index, connection := range []*recordingAdminConnection{first, second} {
		var message AdminSocketMessage
		if err := json.Unmarshal(connection.messages[len(connection.messages)-1], &message); err != nil {
			t.Fatal(err)
		}
		if message.Event != AdminEventRemove || message.PlayerID != playerID {
			t.Errorf("Admin tab %d removal = %#v", index, message)
		}
	}
}
