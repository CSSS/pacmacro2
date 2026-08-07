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
)

type Game struct {
	// private
	players *Players
	mutex   sync.Mutex

	// public
	Min    Coordinate `json:"min"`
	Max    Coordinate `json:"max"`
	Width  uint64     `json:"width"`
	Height uint64     `json:"height"`
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

	fmt.Print("Game handler initialized.\n")
	return nil
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

	writeJSON(w, http.StatusOK, g)
}
