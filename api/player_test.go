package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPlayerRegistrationUsesJSONRequestAndResponse(t *testing.T) {
	players := new(Players)
	players.Init()
	request := newJSONRequest(
		t,
		http.MethodPost,
		"/api/player/register",
		PlayerRegistrationRequest{Name: "Test"},
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
	if player := players.Get(body.ID); player == nil ||
		player.Name != "Test" || player.Type != TypeGhost {
		t.Errorf("registered player %q was not stored correctly", body.ID)
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
	playerID := players.New(TypeLeader, "Grace", StatusConn)
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
	if len(body) != 1 || body[0].ID != playerID || body[0].Name != "Grace" ||
		body[0].Type != TypeLeader {
		t.Errorf("player list = %#v, want player %q", body, playerID)
	}
}

func TestPlayerResponseContainsTypeWithoutRepresentationField(t *testing.T) {
	players := new(Players)
	players.Init()
	players.New(TypeAntipac, "Player", StatusDisc)
	request := httptest.NewRequest(http.MethodGet, "/api/player/list.json", nil)
	response := httptest.NewRecorder()
	players.ServeHTTP(response, request)

	var body []map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode player list: %v", err)
	}
	if len(body) != 1 || body[0]["type"] != float64(TypeAntipac) {
		t.Fatalf("player list = %#v, want Antipac type", body)
	}
	if _, exists := body[0]["reps"]; exists {
		t.Error("player response contains legacy reps field")
	}
}

func TestPlayersRejectInvalidTypeInternally(t *testing.T) {
	players := new(Players)
	players.Init()
	invalid := PlayerType(99)
	if playerID := players.New(invalid, "Invalid", StatusDisc); playerID != "" {
		t.Errorf("invalid type player ID = %q, want empty", playerID)
	}
	if len(players.List()) != 0 {
		t.Error("invalid type created a player")
	}

	playerID := players.New(TypeGhost, "Valid", StatusDisc)
	if _, _, updated := players.Update(playerID, invalid); updated {
		t.Error("invalid type updated a player")
	}
	if player := players.Get(playerID); player == nil || player.Type != TypeGhost {
		t.Errorf("player after invalid update = %#v, want Ghost", player)
	}
}

func TestPlayersUpdatePacmanDemotesEveryOtherPacman(t *testing.T) {
	players := new(Players)
	players.Init()
	firstPacmanID := players.New(TypePacman, "First", StatusConn)
	secondPacmanID := players.New(TypePacman, "Second", StatusDisc)
	targetID := players.New(TypeGhost, "Target", StatusConn)

	updated, demoted, found := players.Update(targetID, TypePacman)
	if !found || updated.ID != targetID || updated.Type != TypePacman {
		t.Fatalf("updated player = %#v, want Pacman %q", updated, targetID)
	}
	if len(demoted) != 2 {
		t.Fatalf("demoted players = %#v, want two players", demoted)
	}

	demotedByID := make(map[PlayerID]PlayerResponse, len(demoted))
	for _, player := range demoted {
		demotedByID[player.ID] = player
	}
	if player := demotedByID[firstPacmanID]; player.Type != TypeGhost || player.Status != StatusConn {
		t.Errorf("first demoted player = %#v, want connected Ghost", player)
	}
	if player := demotedByID[secondPacmanID]; player.Type != TypeGhost || player.Status != StatusDisc {
		t.Errorf("second demoted player = %#v, want disconnected Ghost", player)
	}
	if player := players.Get(targetID); player == nil || player.Type != TypePacman {
		t.Errorf("target player = %#v, want Pacman", player)
	}
}
