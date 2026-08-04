package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMapUsesJSONObjectResponse(t *testing.T) {
	players := new(Players)
	players.Init()
	game := new(Game)
	game.Init(players)
	request := httptest.NewRequest(http.MethodGet, "/api/game/map.json", nil)
	response := httptest.NewRecorder()
	game.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("map status = %d, want %d", response.Code, http.StatusOK)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want application/json; charset=utf-8", contentType)
	}

	var body Game
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode map response: %v", err)
	}
	if body.Width != game.Width || body.Height != game.Height || body.Min != game.Min || body.Max != game.Max {
		t.Errorf("map response = %#v, want %#v", body, game)
	}
}
