package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const testUser = "test"

type recordingAdminConnection struct {
	messages [][]byte
	closed   bool
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
		AdminRegistrationRequest{Name: testUser, Pass: password},
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
		AdminRegistrationRequest{Name: testUser, Pass: "wrong"},
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
		AdminRegistrationRequest{Name: "Grace", Pass: "top-secret"},
	)
	renewalResponse := httptest.NewRecorder()
	admin.ServeHTTP(renewalResponse, renewalRequest)
	if renewalResponse.Code != http.StatusNoContent {
		t.Errorf("session renewal status = %d, want %d", renewalResponse.Code, http.StatusNoContent)
	}
}

func TestAdminCookieAuthorizesPlayerUpdate(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	playerID := players.New(TypePlayer, "Player", RepsGhost, StatusConn)

	playerType := TypeLeader
	representation := RepsEdible
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/update/"+playerID,
		AdminUpdateRequest{Type: &playerType, Reps: &representation},
	)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("authorized update status = %d, want %d", response.Code, http.StatusNoContent)
	}
	player := players.Get(playerID)
	if player.Type != TypeLeader || player.Reps != RepsEdible {
		t.Errorf("updated player = type %d reps %d, want type %d reps %d", player.Type, player.Reps, TypeLeader, RepsEdible)
	}
}

func TestAdminUpdateRejectsDisconnectedPlayer(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	playerID := players.New(TypePlayer, "Player", RepsGhost, StatusDisc)
	playerType := TypeLeader
	representation := RepsEdible
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/update/"+playerID,
		AdminUpdateRequest{Type: &playerType, Reps: &representation},
	)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)

	if response.Code != http.StatusConflict {
		t.Errorf("disconnected update status = %d, want %d", response.Code, http.StatusConflict)
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

func TestAdminSocketReceivesPlayerRegistrationAndStatus(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	connection := new(recordingAdminConnection)
	if !admin.addConnection(connection) {
		t.Fatal("add admin test connection")
	}
	defer admin.removeConnection(connection)

	playerID := players.New(TypePlayer, "Test", RepsNothing, StatusDisc)
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
		registered.Player.ID != playerID || registered.Player.Status != StatusDisc {
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

func TestAdminUpdateRequiresCookieAndRejectsAdminPlayerType(t *testing.T) {
	players, admin := newAdminTestState(t, "top-secret")
	cookie := registerTestAdmin(t, admin, "top-secret")
	playerID := players.New(TypePlayer, "Player", RepsNothing, StatusDisc)
	playerType := TypeAdmin
	representation := RepsNothing
	requestBody := AdminUpdateRequest{Type: &playerType, Reps: &representation}

	unauthorizedRequest := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/update/"+playerID,
		requestBody,
	)
	unauthorizedResponse := httptest.NewRecorder()
	admin.ServeHTTP(unauthorizedResponse, unauthorizedRequest)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Errorf("update without cookie status = %d, want %d", unauthorizedResponse.Code, http.StatusUnauthorized)
	}

	adminTypeRequest := newJSONRequest(
		t,
		http.MethodPost,
		"/api/admin/update/"+playerID,
		requestBody,
	)
	adminTypeRequest.AddCookie(cookie)
	adminTypeResponse := httptest.NewRecorder()
	admin.ServeHTTP(adminTypeResponse, adminTypeRequest)
	if adminTypeResponse.Code != http.StatusBadRequest {
		t.Errorf("admin player type status = %d, want %d", adminTypeResponse.Code, http.StatusBadRequest)
	}
}
