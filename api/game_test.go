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

func TestGameStartGameUsesTwentyMinuteDeadline(t *testing.T) {
	game := new(Game)
	if !game.StartGame(DefaultGameDurationMinutes) {
		t.Fatal("initial game start was rejected")
	}
	state := game.State()
	if state.StartTime == nil || state.EndTime == nil {
		t.Fatalf("started game state = %#v, want a deadline", state)
	}
	if got := *state.EndTime - *state.StartTime; got != (20 * time.Minute).Milliseconds() {
		t.Errorf("game duration = %dms, want %dms", got, (20 * time.Minute).Milliseconds())
	}
	if game.StartGame(DefaultGameDurationMinutes) {
		t.Error("duplicate game start was accepted")
	}
	game.Reset()
}

func TestGameFlagCaptureCapsDeadlineAndPreservesStartTime(t *testing.T) {
	game := new(Game)
	game.StartGame(DefaultGameDurationMinutes)
	started := game.State()
	before := time.Now().UnixMilli()
	changed := game.SetFlagFound(true)
	after := time.Now().UnixMilli()
	if !changed {
		t.Fatal("flag capture reported unchanged")
	}
	state := game.State()
	if !state.IsFlagFound || state.StartTime == nil || state.EndTime == nil {
		t.Fatalf("flag capture state = %#v, want an empowered flag and deadline", state)
	}
	if started.StartTime == nil || *state.StartTime != *started.StartTime {
		t.Errorf("start time after flag capture = %v, want %v", state.StartTime, started.StartTime)
	}
	wantDuration := (10 * time.Minute).Milliseconds()
	if *state.EndTime < before+wantDuration || *state.EndTime > after+wantDuration {
		t.Errorf("flag capture deadline = %d, want between %d and %d", *state.EndTime, before+wantDuration, after+wantDuration)
	}
	game.Reset()
}

func TestGameFlagCaptureDoesNotShortenDeadlineAtOrBelowTenMinutes(t *testing.T) {
	for _, duration := range []time.Duration{10 * time.Minute, 5 * time.Minute} {
		game := new(Game)
		updates := 0
		game.AddObserver(func(GameState) { updates++ })
		game.Start(duration)
		before := game.State()

		if !game.SetFlagFound(true) {
			t.Errorf("duration %v flag capture reported unchanged", duration)
		}
		after := game.State()
		if !after.IsFlagFound || before.StartTime == nil || before.EndTime == nil || after.StartTime == nil || after.EndTime == nil ||
			*before.StartTime != *after.StartTime || *before.EndTime != *after.EndTime {
			t.Errorf("duration %v changed deadline from %#v to %#v", duration, before, after)
		}
		if updates != 2 {
			t.Errorf("duration %v published %d updates, want start and flag capture", duration, updates)
		}
		game.Reset()
	}
}

func TestGameFlagCaptureOutsideActiveGameDoesNotChangeTimer(t *testing.T) {
	game := new(Game)
	if !game.SetFlagFound(true) {
		t.Fatal("pre-game flag capture reported unchanged")
	}
	beforeStart := game.State()
	if !beforeStart.IsFlagFound || beforeStart.Phase != GamePhaseNotStarted || beforeStart.EndTime != nil {
		t.Errorf("pre-game flag capture state = %#v", beforeStart)
	}

	game.SetFlagFound(false)
	game.Start(time.Minute)
	game.mutex.RLock()
	version := game.deadlineVersion
	game.mutex.RUnlock()
	game.expire(version)
	ended := game.State()
	if !game.SetFlagFound(true) {
		t.Fatal("post-game flag capture reported unchanged")
	}
	afterEnd := game.State()
	if !afterEnd.IsFlagFound || afterEnd.Phase != GamePhaseEnded || ended.EndTime == nil || afterEnd.EndTime == nil || *ended.EndTime != *afterEnd.EndTime {
		t.Errorf("post-game flag capture changed timer from %#v to %#v", ended, afterEnd)
	}
	game.Reset()
}

func TestGameFlagCaptureEndsElapsedDeadlineBeforeTimerCallback(t *testing.T) {
	game := new(Game)
	updates := make([]GameState, 0, 2)
	game.AddObserver(func(state GameState) { updates = append(updates, state) })
	game.Start(time.Minute)

	game.mutex.Lock()
	game.state.EndTime = timestamp(time.Now().Add(-time.Second).UnixMilli())
	game.mutex.Unlock()

	if !game.SetFlagFound(true) {
		t.Fatal("elapsed flag capture reported unchanged")
	}
	state := game.State()
	if !state.IsFlagFound || state.Phase != GamePhaseEnded || state.StartTime == nil || state.EndTime == nil {
		t.Errorf("elapsed state = %#v, want ended with retained timestamps", state)
	}
	if len(updates) != 2 || updates[1].Phase != GamePhaseEnded {
		t.Errorf("elapsed updates = %#v, want start followed by ended", updates)
	}
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
