package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPlayerRegistrationRejectsAdminType(t *testing.T) {
	players := new(Players)
	players.Init()
	playerType := TypeAdmin
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/player/register",
		PlayerRegistrationRequest{Type: &playerType, Name: "Admin"},
	)
	response := httptest.NewRecorder()
	players.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Errorf("admin player registration status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if len(players.players) != 0 {
		t.Errorf("player count = %d, want 0", len(players.players))
	}
}

func TestPlayerRegistrationUsesJSONRequestAndResponse(t *testing.T) {
	players := new(Players)
	players.Init()
	playerType := TypePlayer
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/player/register",
		PlayerRegistrationRequest{Type: &playerType, Name: "Test"},
	)
	response := httptest.NewRecorder()
	players.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("player registration status = %d, want %d", response.Code, http.StatusOK)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want application/json; charset=utf-8", contentType)
	}

	var body PlayerRegistrationResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode registration response: %v", err)
	}
	if body.ID == "" {
		t.Fatal("registration response contains an empty player ID")
	}
	if player := players.Get(body.ID); player == nil || player.Name != "Test" {
		t.Errorf("registered player %q was not stored correctly", body.ID)
	}
}

func TestPlayerRegistrationAllowsLegacyExtraFields(t *testing.T) {
	players := new(Players)
	players.Init()
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/player/register",
		map[string]any{"type": TypePlayer, "name": "Test", "legacy": "ignored"},
	)
	response := httptest.NewRecorder()
	players.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Errorf("legacy registration status = %d, want %d", response.Code, http.StatusOK)
	}
}

func TestPlayerRegistrationRejectsNonJSONBody(t *testing.T) {
	players := new(Players)
	players.Init()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/player/register",
		strings.NewReader("type=0&name=Test"),
	)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	players.ServeHTTP(response, request)

	if response.Code != http.StatusUnsupportedMediaType {
		t.Errorf("form registration status = %d, want %d", response.Code, http.StatusUnsupportedMediaType)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want application/json; charset=utf-8", contentType)
	}
}

func TestPlayerListUsesJSONArrayResponse(t *testing.T) {
	players := new(Players)
	players.Init()
	playerID := players.New(TypeLeader, "Grace", RepsGhost, StatusConn)
	request := httptest.NewRequest(http.MethodGet, "/api/player/list.json", nil)
	response := httptest.NewRecorder()
	players.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("player list status = %d, want %d", response.Code, http.StatusOK)
	}
	var body []PlayerResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode player list: %v", err)
	}
	if len(body) != 1 || body[0].ID != playerID || body[0].Name != "Grace" {
		t.Errorf("player list = %#v, want player %q", body, playerID)
	}
}
