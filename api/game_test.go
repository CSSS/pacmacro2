package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMapUsesJSONObjectResponse(t *testing.T) {
	setGameEnvironment(t)

	players := new(Players)
	players.Init()
	game := new(Game)
	if err := game.Init(players); err != nil {
		t.Fatalf("initialize game: %v", err)
	}
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
		t.Errorf(
			"map response = min %#v, max %#v, width %d, height %d; want min %#v, max %#v, width %d, height %d",
			body.Min,
			body.Max,
			body.Width,
			body.Height,
			game.Min,
			game.Max,
			game.Width,
			game.Height,
		)
	}
}

func TestGameInitUsesEnvironmentBounds(t *testing.T) {
	setGameEnvironment(t)

	game := new(Game)
	if err := game.Init(new(Players)); err != nil {
		t.Fatalf("initialize game: %v", err)
	}

	wantMin := Coordinate{Latitude: 49.27462710773634, Longitude: -122.91628624024605}
	wantMax := Coordinate{Latitude: 49.28099313727333, Longitude: -122.90273076431673}
	if game.Min != wantMin || game.Max != wantMax {
		t.Errorf("bounds = min %#v, max %#v; want min %#v, max %#v", game.Min, game.Max, wantMin, wantMax)
	}
}

func setGameEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("MIN_LAT", "49.27462710773634")
	t.Setenv("MIN_LON", "-122.91628624024605")
	t.Setenv("MAX_LAT", "49.28099313727333")
	t.Setenv("MAX_LON", "-122.90273076431673")
}
