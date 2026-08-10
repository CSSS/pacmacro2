// admin.go

package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

const adminCookieName = "pacmacro_admin"

type AdminRegistrationRequest struct {
	Name string `json:"name"`
	Pass string `json:"pass"`
}

type AdminUpdateRequest struct {
	Type *int `json:"type"`
	Reps *int `json:"reps"`
}

type Admin struct {
	players     *Players
	sockets     *Sockets
	connections map[adminSocketConnection]struct{}

	password    string
	cookieValue string
	name        string
	registered  bool
	stateMutex  sync.RWMutex
	socketMutex sync.Mutex
}

func (a *Admin) Init(players *Players, sockets *Sockets, password string) {
	a.players = players
	a.sockets = sockets
	a.password = password
	a.cookieValue = base64.RawURLEncoding.EncodeToString([]byte(password))
	a.name = ""
	a.registered = false
	a.connections = make(map[adminSocketConnection]struct{})
	players.SetObserver(a.BroadcastPlayer)

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
	case strings.HasPrefix(requestPath, "update/"):
		a.ServeUpdate(w, r)
	default:
		writeJSONError(w, http.StatusNotFound)
	}
}

// POST /api/admin/register
// JSON "name": administrator display name
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

	name := strings.TrimSpace(request.Name)
	if name == "" {
		writeJSONError(w, http.StatusBadRequest)
		return
	}
	if !credentialsMatch(request.Pass, a.password) {
		writeJSONError(w, http.StatusUnauthorized)
		return
	}

	a.stateMutex.Lock()
	a.name = name
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
	fmt.Printf("Admin\tServeRegister (/api/admin/register):\tRegistered administrator %q.\n", name)
}

// POST /api/admin/update/<ID>
// JSON "type": new player type
// JSON "reps": new player representation
func (a *Admin) ServeUpdate(w http.ResponseWriter, r *http.Request) {
	if !a.authorizePost(w, r) {
		return
	}

	var request AdminUpdateRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Type == nil || request.Reps == nil {
		writeJSONError(w, http.StatusBadRequest)
		return
	}

	playerType := *request.Type
	representation := *request.Reps
	validPlayerType := playerType == TypePlayer || playerType == TypeLeader || playerType == TypeHidden
	if !validPlayerType || representation < RepsNothing || representation > RepsEdible {
		writeJSONError(w, http.StatusBadRequest)
		return
	}

	targetID := PlayerID(strings.TrimPrefix(r.URL.Path, "/api/admin/update/"))
	_, found, connected := a.players.UpdateConnected(
		targetID,
		uint64(playerType),
		uint64(representation),
	)
	if !found {
		writeJSONError(w, http.StatusNotFound)
		return
	}
	if !connected {
		writeJSONError(w, http.StatusConflict)
		return
	}

	a.sockets.Inform(targetID)
	w.WriteHeader(http.StatusNoContent)
}
