// etc.go
// general functions and constants that will be used in multiple files.

package api

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	ws "github.com/gorilla/websocket"
)

type PlayerType uint64

const (
	// commands
	CMD_MOVE   = "move"   // on player movement
	CMD_INFORM = "inform" // inform another player change/connection
	CMD_REMOVE = "remove" // remove a player marker without disclosing a location
	CMD_STATE  = "state"  // inform clients of shared game state

	// player type
	TypeHidden        PlayerType = 0
	TypePacman        PlayerType = 1
	TypeAntipac       PlayerType = 2
	TypeGhost         PlayerType = 3
	TypeEdible        PlayerType = 4
	TypeLeader        PlayerType = 5
	TypeAntiPacLeader PlayerType = 6
	TypeFlagLeader    PlayerType = 7

	// user status
	StatusGone = 0 // zero-value; out-of-game
	StatusDisc = 1 // user is disconnected; await re-connection
	StatusConn = 2 // user is connected

	id_length = 4 // length of a session ID

	maxJSONBodySize = 8 * 1024
)

var id_letters = []byte("0123456789ABCDEF")

var Upgrader = ws.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// /*
	// FOR DEVELOPMENT: ALLOWS SERVER TO CONNECT TO ITSELF.
	// REMOVE FOR PRODUCTION
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
	// */
}

type errorResponse struct {
	Error string `json:"error"`
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, destination any) bool {
	return decodeJSONBodyWithOptions(w, r, destination, true)
}

func decodeJSONBodyAllowUnknownFields(w http.ResponseWriter, r *http.Request, destination any) bool {
	return decodeJSONBodyWithOptions(w, r, destination, false)
}

func decodeJSONBodyWithOptions(
	w http.ResponseWriter,
	r *http.Request,
	destination any,
	rejectUnknownFields bool,
) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeJSONError(w, http.StatusUnsupportedMediaType)
		return false
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodySize)
	decoder := json.NewDecoder(r.Body)
	if rejectUnknownFields {
		decoder.DisallowUnknownFields()
	}

	if err := decoder.Decode(destination); err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			writeJSONError(w, http.StatusRequestEntityTooLarge)
		} else {
			writeJSONError(w, http.StatusBadRequest)
		}
		return false
	}

	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeJSONError(w, http.StatusBadRequest)
		return false
	}

	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if value != nil {
		_ = json.NewEncoder(w).Encode(value)
	}
}

func writeJSONError(w http.ResponseWriter, status int) {
	writeJSON(w, status, errorResponse{Error: http.StatusText(status)})
}

// type Coordinate struct
/* JSON example:
{
	"latitude": 0,
	"longitude": 0
} */
type Coordinate struct {
	// public
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

// type Message struct
/* JSON example: (NOTE: replace ... with above JSON example)
{
	"coordinate": ...,
	"command": "location",
	"data": ""
} */
type Message struct {
	// public
	Coord   Coordinate `json:"coordinate"`
	Command string     `json:"command"`
	Data    string     `json:"data"`
}

func (playerType PlayerType) Valid() bool {
	switch playerType {
	case TypeHidden,
		TypePacman,
		TypeAntipac,
		TypeGhost,
		TypeEdible,
		TypeLeader,
		TypeAntiPacLeader,
		TypeFlagLeader:
		return true
	default:
		return false
	}
}

func TypeString(playerType PlayerType) string {
	switch playerType {
	case TypeHidden:
		return "Hidden"
	case TypePacman:
		return "Pacman"
	case TypeAntipac:
		return "Antipac"
	case TypeGhost:
		return "Ghost"
	case TypeEdible:
		return "Edible"
	case TypeLeader:
		return "Leader"
	case TypeAntiPacLeader:
		return "AntiPac Leader"
	case TypeFlagLeader:
		return "Flag Leader"
	default:
		return "Error"
	}
}

func IsLeaderType(playerType PlayerType) bool {
	return playerType == TypeLeader ||
		playerType == TypeAntiPacLeader ||
		playerType == TypeFlagLeader
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}

	return b
}

func max(a, b float64) float64 {
	if a > b {
		return a
	}

	return b
}
