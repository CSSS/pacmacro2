package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
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

	var body GameSnapshot
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
	if body.State.IsFlagFound {
		t.Error("initial map state has isFlagFound true")
	}
	if body.State.Phase != GamePhaseNotStarted || body.State.StartTime != nil || body.State.EndTime != nil {
		t.Errorf("initial game state = %#v, want not started without a deadline", body.State)
	}
	if body.State.ServerTime <= 0 {
		t.Errorf("initial server time = %d, want a positive Unix timestamp", body.State.ServerTime)
	}
}

func TestGameFlagStateIsSynchronizedAndIdempotent(t *testing.T) {
	game := new(Game)
	updates := make([]GameState, 0)
	game.AddObserver(func(state GameState) { updates = append(updates, state) })
	if !game.SetFlagFound(true) {
		t.Fatal("first flag update reported unchanged")
	}
	if game.SetFlagFound(true) {
		t.Fatal("idempotent flag update reported changed")
	}
	if len(updates) != 1 || !updates[0].IsFlagFound || !game.Snapshot().State.IsFlagFound {
		t.Errorf("updates = %#v, snapshot = %#v", updates, game.Snapshot())
	}
}

func TestGameStartStoresDeadlineAndExpires(t *testing.T) {
	game := new(Game)
	before := time.Now().UnixMilli()
	if !game.Start(time.Minute) {
		t.Fatal("valid start was rejected")
	}
	after := time.Now().UnixMilli()

	state := game.State()
	if state.Phase != GamePhaseInProgress || state.StartTime == nil || state.EndTime == nil {
		t.Fatalf("started state = %#v, want an in-progress deadline", state)
	}
	if *state.StartTime < before || *state.StartTime > after {
		t.Errorf("start time = %d, want between %d and %d", *state.StartTime, before, after)
	}
	if got := *state.EndTime - *state.StartTime; got != time.Minute.Milliseconds() {
		t.Errorf("deadline duration = %dms, want %dms", got, time.Minute.Milliseconds())
	}

	game.mutex.RLock()
	version := game.deadlineVersion
	game.mutex.RUnlock()
	game.expire(version)

	state = game.State()
	if state.Phase != GamePhaseEnded || state.StartTime == nil || state.EndTime == nil {
		t.Errorf("expired state = %#v, want ended with retained timestamps", state)
	}
}

func TestGameNewDeadlineIgnoresOldExpiry(t *testing.T) {
	game := new(Game)
	game.Start(time.Minute)
	game.mutex.RLock()
	oldVersion := game.deadlineVersion
	game.mutex.RUnlock()

	game.Start(2 * time.Minute)
	newState := game.State()
	game.expire(oldVersion)

	state := game.State()
	if state.Phase != GamePhaseInProgress || state.EndTime == nil || newState.EndTime == nil || *state.EndTime != *newState.EndTime {
		t.Errorf("state after stale expiry = %#v, want current deadline %#v", state, newState)
	}
	game.Reset()
}

func TestGameEmpowerAntipacUsesTenMinuteDeadline(t *testing.T) {
	game := new(Game)
	game.EmpowerAntipac()
	state := game.State()
	if state.StartTime == nil || state.EndTime == nil {
		t.Fatalf("Antipac state = %#v, want a deadline", state)
	}
	if got := *state.EndTime - *state.StartTime; got != (10 * time.Minute).Milliseconds() {
		t.Errorf("Antipac duration = %dms, want %dms", got, (10 * time.Minute).Milliseconds())
	}
	game.Reset()
}

func TestGameResetClearsStateAndDeadline(t *testing.T) {
	game := new(Game)
	game.SetFlagFound(true)
	game.Start(time.Minute)
	if !game.Reset() {
		t.Fatal("reset reported no change")
	}

	state := game.State()
	if state.Phase != GamePhaseNotStarted || state.StartTime != nil || state.EndTime != nil || state.IsFlagFound {
		t.Errorf("reset state = %#v, want initial state", state)
	}
}

func TestGameRebroadcastDoesNotChangeDeadline(t *testing.T) {
	game := new(Game)
	updates := make([]GameState, 0, 2)
	game.AddObserver(func(state GameState) {
		updates = append(updates, state)
	})
	game.Start(time.Minute)
	game.RebroadcastState()
	game.Reset()

	if len(updates) < 2 {
		t.Fatalf("state updates = %d, want at least 2", len(updates))
	}
	started, synchronized := updates[0], updates[1]
	if started.StartTime == nil || started.EndTime == nil ||
		synchronized.StartTime == nil || synchronized.EndTime == nil {
		t.Fatalf("started = %#v, synchronized = %#v, want deadlines", started, synchronized)
	}
	if *started.StartTime != *synchronized.StartTime || *started.EndTime != *synchronized.EndTime {
		t.Errorf("synchronization changed deadline: started %#v, synchronized %#v", started, synchronized)
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
