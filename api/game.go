// game.go

package api

import (
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type GamePhase string

const (
	GamePhaseNotStarted GamePhase = "not_started"
	GamePhaseInProgress GamePhase = "in_progress"
	GamePhaseEnded      GamePhase = "ended"
)

const DefaultGameDurationMinutes = 20

type Game struct {
	// private
	players             *Players
	mutex               sync.RWMutex
	eventMutex          sync.Mutex
	observers           []func(GameState)
	state               GameState
	expiryTimer         *time.Timer
	deadlineVersion     uint64
	synchronizationOnce sync.Once

	// public
	Min    Coordinate `json:"min"`
	Max    Coordinate `json:"max"`
	Width  uint64     `json:"width"`
	Height uint64     `json:"height"`
}

type GameState struct {
	IsFlagFound bool      `json:"isFlagFound"`
	Phase       GamePhase `json:"phase"`
	StartTime   *int64    `json:"startTime"`
	EndTime     *int64    `json:"endTime"`
	ServerTime  int64     `json:"serverTime"`
}

type GameSnapshot struct {
	Min    Coordinate `json:"min"`
	Max    Coordinate `json:"max"`
	Width  uint64     `json:"width"`
	Height uint64     `json:"height"`
	State  GameState  `json:"state"`
}

func (g *Game) Init(players *Players) error {
	minLatitude, err := requiredEnvironmentFloat("MIN_LAT")
	if err != nil {
		return err
	}
	minLongitude, err := requiredEnvironmentFloat("MIN_LON")
	if err != nil {
		return err
	}
	maxLatitude, err := requiredEnvironmentFloat("MAX_LAT")
	if err != nil {
		return err
	}
	maxLongitude, err := requiredEnvironmentFloat("MAX_LON")
	if err != nil {
		return err
	}
	if minLatitude >= maxLatitude {
		return fmt.Errorf("MIN_LAT must be less than MAX_LAT")
	}
	if minLongitude >= maxLongitude {
		return fmt.Errorf("MIN_LON must be less than MAX_LON")
	}

	g.players = players
	g.Min = Coordinate{Latitude: minLatitude, Longitude: minLongitude}
	g.Max = Coordinate{Latitude: maxLatitude, Longitude: maxLongitude}

	// coordinate size of map
	g.Width = 32
	g.Height = 32
	g.state = GameState{Phase: GamePhaseNotStarted}

	fmt.Print("Game handler initialized.\n")
	return nil
}

func (g *Game) Snapshot() GameSnapshot {
	g.mutex.RLock()
	defer g.mutex.RUnlock()
	return GameSnapshot{
		Min: g.Min, Max: g.Max, Width: g.Width, Height: g.Height,
		State: g.stateLocked(time.Now().UnixMilli()),
	}
}

func (g *Game) State() GameState {
	g.mutex.RLock()
	defer g.mutex.RUnlock()
	return g.stateLocked(time.Now().UnixMilli())
}

func (g *Game) stateLocked(serverTime int64) GameState {
	state := g.state
	if state.Phase == "" {
		state.Phase = GamePhaseNotStarted
	}
	state.StartTime = copyTimestamp(state.StartTime)
	state.EndTime = copyTimestamp(state.EndTime)
	state.ServerTime = serverTime
	return state
}

func copyTimestamp(timestamp *int64) *int64 {
	if timestamp == nil {
		return nil
	}
	value := *timestamp
	return &value
}

func timestamp(value int64) *int64 {
	return &value
}

func (g *Game) AddObserver(observer func(GameState)) {
	if observer == nil {
		return
	}
	g.mutex.Lock()
	g.observers = append(g.observers, observer)
	g.mutex.Unlock()
}

func (g *Game) SetFlagFound(isFlagFound bool) bool {
	const flagFoundDuration = 10 * time.Minute

	g.eventMutex.Lock()
	defer g.eventMutex.Unlock()

	now := time.Now()
	g.mutex.Lock()
	if g.state.IsFlagFound == isFlagFound {
		g.mutex.Unlock()
		return false
	}
	g.state.IsFlagFound = isFlagFound
	if isFlagFound && g.state.Phase == GamePhaseInProgress && g.state.EndTime != nil {
		if *g.state.EndTime <= now.UnixMilli() {
			if g.expiryTimer != nil {
				g.expiryTimer.Stop()
			}
			g.deadlineVersion++
			g.state.Phase = GamePhaseEnded
			g.expiryTimer = nil
		} else {
			if g.expiryTimer != nil {
				g.expiryTimer.Stop()
			}
			g.deadlineVersion++
			version := g.deadlineVersion
			newEndTime := now.Add(flagFoundDuration).UnixMilli()
			g.state.EndTime = timestamp(newEndTime)
			g.expiryTimer = time.AfterFunc(flagFoundDuration, func() {
				g.expire(version)
			})
		}
	}
	g.mutex.Unlock()

	g.publishState()
	return true
}

func (g *Game) Start(duration time.Duration) bool {
	return g.start(duration, false)
}

func (g *Game) start(duration time.Duration, requireNotStarted bool) bool {
	if duration <= 0 {
		return false
	}

	g.eventMutex.Lock()
	defer g.eventMutex.Unlock()

	now := time.Now()
	startTime := now.UnixMilli()
	endTime := now.Add(duration).UnixMilli()

	g.mutex.Lock()
	phase := g.state.Phase
	if phase == "" {
		phase = GamePhaseNotStarted
	}
	if requireNotStarted && phase != GamePhaseNotStarted {
		g.mutex.Unlock()
		return false
	}
	if g.expiryTimer != nil {
		g.expiryTimer.Stop()
	}

	g.deadlineVersion++
	version := g.deadlineVersion
	g.state.Phase = GamePhaseInProgress
	g.state.StartTime = timestamp(startTime)
	g.state.EndTime = timestamp(endTime)
	g.expiryTimer = time.AfterFunc(duration, func() {
		g.expire(version)
	})
	g.mutex.Unlock()

	g.publishState()
	return true
}

func (g *Game) StartGame(durationMinutes int) bool {
	if durationMinutes <= 0 {
		return false
	}
	return g.start(time.Duration(durationMinutes)*time.Minute, true)
}

func (g *Game) expire(version uint64) {
	g.eventMutex.Lock()
	defer g.eventMutex.Unlock()

	g.mutex.Lock()
	if version != g.deadlineVersion || g.state.Phase != GamePhaseInProgress {
		g.mutex.Unlock()
		return
	}
	if g.expiryTimer != nil {
		g.expiryTimer.Stop()
	}
	g.state.Phase = GamePhaseEnded
	g.expiryTimer = nil
	g.mutex.Unlock()

	g.publishState()
}

func (g *Game) Reset() bool {
	g.eventMutex.Lock()
	defer g.eventMutex.Unlock()

	g.mutex.Lock()
	phase := g.state.Phase
	if phase == "" {
		phase = GamePhaseNotStarted
	}
	changed := phase != GamePhaseNotStarted ||
		g.state.StartTime != nil ||
		g.state.EndTime != nil ||
		g.state.IsFlagFound
	if !changed {
		g.mutex.Unlock()
		return false
	}

	if g.expiryTimer != nil {
		g.expiryTimer.Stop()
		g.expiryTimer = nil
	}
	g.deadlineVersion++
	g.state = GameState{Phase: GamePhaseNotStarted}
	g.mutex.Unlock()

	g.publishState()
	return true
}

func (g *Game) RebroadcastState() {
	g.eventMutex.Lock()
	defer g.eventMutex.Unlock()
	g.publishState()
}

func (g *Game) StartSynchronization(interval time.Duration) {
	if interval <= 0 {
		return
	}
	g.synchronizationOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(interval)
			for range ticker.C {
				g.RebroadcastState()
			}
		}()
	})
}

func (g *Game) publishState() {
	state := g.State()
	g.mutex.RLock()
	observers := append([]func(GameState){}, g.observers...)
	g.mutex.RUnlock()
	for _, observer := range observers {
		observer(state)
	}
}

func requiredEnvironmentFloat(name string) (float64, error) {
	rawValue := strings.TrimSpace(os.Getenv(name))
	if rawValue == "" {
		return 0, fmt.Errorf("%s is required", name)
	}

	value, err := strconv.ParseFloat(rawValue, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("%s must be a finite number", name)
	}
	return value, nil
}

// /api/game/*
func (g *Game) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/game/")

	// GET /api/game/map.json
	if path == "map.json" {
		g.ServeMap(w, r)
		// /api/game/*
	} else {
		writeJSONError(w, http.StatusNotFound)
	}
}

// GET /api/game/map.json
func (g *Game) ServeMap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}

	writeJSON(w, http.StatusOK, g.Snapshot())
}
