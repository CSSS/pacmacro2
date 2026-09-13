// admin.go

package api

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

const adminCookieName = "pacmacro_admin"

type AdminRegistrationRequest struct {
	Pass string `json:"pass"`
}

type AdminUpdateRequest struct {
	Type *PlayerType `json:"type"`
}

type AdminFlagRequest struct {
	IsFlagFound *bool `json:"isFlagFound"`
}

type AdminStartRequest struct {
	DurationMinutes *int `json:"durationMinutes"`
}

type Admin struct {
	players     *Players
	sockets     *Sockets
	game        *Game
	connections map[adminSocketConnection]struct{}

	password    string
	cookieValue string
	registered  bool
	stateMutex  sync.RWMutex
	socketMutex sync.Mutex
}

func (a *Admin) Init(players *Players, sockets *Sockets, password string, games ...*Game) {
	a.players = players
	a.sockets = sockets
	a.password = password
	a.cookieValue = base64.RawURLEncoding.EncodeToString([]byte(password))
	a.registered = false
	a.connections = make(map[adminSocketConnection]struct{})
	if len(games) > 0 {
		a.game = games[0]
		a.game.AddObserver(a.BroadcastFlagState)
		a.game.AddObserver(a.BroadcastGameState)
	}
	players.AddObserver(a.BroadcastPlayer)
	players.AddRemovalObserver(a.BroadcastRemoval)

	fmt.Print("Admin handler initialized.\n")
}

func (a *Admin) authorize(r *http.Request) bool {
	cookie, err := r.Cookie(adminCookieName)
	if err != nil {
		return false
	}

	a.stateMutex.RLock()
	defer a.stateMutex.RUnlock()
	return a.registered && credentialsMatch(cookie.Value, a.cookieValue)
}

func (a *Admin) authorizePost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return false
	}
	if !a.authorize(r) {
		writeJSONError(w, http.StatusUnauthorized)
		return false
	}
	return true
}

func credentialsMatch(received, expected string) bool {
	receivedHash := sha256.Sum256([]byte(received))
	expectedHash := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(receivedHash[:], expectedHash[:]) == 1
}

func requestIsSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	forwardedProtocol := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	return strings.EqualFold(forwardedProtocol, "https")
}

// --- ENDPOINTS ---
// /api/admin/*
func (a *Admin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestPath := strings.TrimPrefix(r.URL.Path, "/api/admin/")

	switch {
	case requestPath == "register":
		a.ServeRegister(w, r)
	case requestPath == "ws":
		a.ServeSocket(w, r)
	case requestPath == "map/ws":
		a.ServeMapSocket(w, r)
	case requestPath == "start":
		a.ServeStart(w, r)
	case requestPath == "reset":
		a.ServeReset(w, r)
	case requestPath == "flag":
		a.ServeFlag(w, r)
	case strings.HasPrefix(requestPath, "update/"):
		a.ServeUpdate(w, r)
	case strings.HasPrefix(requestPath, "kick/"):
		a.ServeKickPlayer(w, r)
	case requestPath == "verify":
		a.ServeVerify(w, r)
	default:
		writeJSONError(w, http.StatusNotFound)
	}
}

// POST /api/admin/start starts a game timer with an optional duration.
// Accepts an optional JSON body { "durationMinutes": whole minutes }.
// An empty body, null, or {} starts the 20-minute default. There is no
// minimum or maximum; any positive whole minutes are accepted.
func (a *Admin) ServeStart(w http.ResponseWriter, r *http.Request) {
	if !a.authorizePost(w, r) {
		return
	}
	if a.game == nil {
		writeJSONError(w, http.StatusServiceUnavailable)
		return
	}

	durationMinutes, ok := parseStartDuration(w, r)
	if !ok {
		return
	}

	if !a.game.StartGame(durationMinutes) {
		writeJSONError(w, http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func parseStartDuration(w http.ResponseWriter, r *http.Request) (int, bool) {
	if r.Body == nil {
		return DefaultGameDurationMinutes, true
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBodySize+1))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest)
		return 0, false
	}
	if int64(len(body)) > maxJSONBodySize {
		writeJSONError(w, http.StatusBadRequest)
		return 0, false
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return DefaultGameDurationMinutes, true
	}

	var request AdminStartRequest
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeJSONError(w, http.StatusBadRequest)
		return 0, false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeJSONError(w, http.StatusBadRequest)
		return 0, false
	}
	if request.DurationMinutes == nil {
		return DefaultGameDurationMinutes, true
	}
	if *request.DurationMinutes <= 0 {
		writeJSONError(w, http.StatusBadRequest)
		return 0, false
	}
	return *request.DurationMinutes, true
}

// POST /api/admin/flag updates the shared flag-found and Pacman empowerment state.
func (a *Admin) ServeFlag(w http.ResponseWriter, r *http.Request) {
	if !a.authorizePost(w, r) {
		return
	}

	var request AdminFlagRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.IsFlagFound == nil {
		writeJSONError(w, http.StatusBadRequest)
		return
	}
	if a.game == nil {
		writeJSONError(w, http.StatusServiceUnavailable)
		return
	}

	a.game.SetFlagFound(*request.IsFlagFound)
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/admin/reset resets all non-leaders and shared flag state.
func (a *Admin) ServeReset(w http.ResponseWriter, r *http.Request) {
	if !a.authorizePost(w, r) {
		return
	}
	a.sockets.ResetNonLeaders()
	a.sockets.ClearOfflineLocations()
	if a.game != nil {
		a.game.Reset()
	}
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/admin/register
// JSON "pass": administrator password from ADMIN_PASSWORD
func (a *Admin) ServeRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}

	var request AdminRegistrationRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}

	if !credentialsMatch(request.Pass, a.password) {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}

	a.stateMutex.Lock()
	a.registered = true
	a.stateMutex.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     adminCookieName,
		Value:    a.cookieValue,
		Path:     "/api/admin",
		HttpOnly: true,
		Secure:   requestIsSecure(r),
		SameSite: http.SameSiteStrictMode,
	})
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
	fmt.Print("Admin\tServeRegister (/api/admin/register):\tRegistered administrator.\n")
}

// POST /api/admin/update/<ID>
// JSON "type": new player type
func (a *Admin) ServeUpdate(w http.ResponseWriter, r *http.Request) {
	if !a.authorizePost(w, r) {
		return
	}

	var request AdminUpdateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Type == nil || !request.Type.Valid() {
		writeJSONError(w, http.StatusBadRequest)
		return
	}

	targetID := PlayerID(strings.TrimPrefix(r.URL.Path, "/api/admin/update/"))
	_, _, found := a.sockets.UpdatePlayer(targetID, *request.Type)
	if !found {
		writeJSONError(w, http.StatusNotFound)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GET /api/admin/verify
func (a *Admin) ServeVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}

	cookie, err := r.Cookie(adminCookieName)
	if err != nil || cookie.Value == "" || !credentialsMatch(cookie.Value, a.cookieValue) {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}

	a.stateMutex.Lock()
	a.registered = true
	a.stateMutex.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/admin/kick/<ID>
func (a *Admin) ServeKickPlayer(w http.ResponseWriter, r *http.Request) {
	if !a.authorizePost(w, r) {
		return
	}

	playerID := PlayerID(strings.TrimPrefix(r.URL.Path, "/api/admin/kick/"))
	if !a.sockets.KickPlayer(playerID) {
		writeJSONError(w, http.StatusNotFound)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
