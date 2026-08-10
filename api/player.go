// player.go

package api

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"path"
	"sync"
)

type PlayerID string

type PlayerRegistrationRequest struct {
	Type *int   `json:"type"`
	Name string `json:"name"`
}

type PlayerRegistrationResponse struct {
	ID PlayerID `json:"id"`
}

type PlayerResponse struct {
	ID     PlayerID `json:"id"`
	Type   uint64   `json:"type"`
	Name   string   `json:"name"`
	Reps   uint64   `json:"reps"`
	Status uint64   `json:"status"`
}

// zero-value player: player, pacman, disconnected
type Player struct {
	Type   uint64 `json:"type"`
	Name   string `json:"name"` // alt.: description
	Reps   uint64 `json:"reps"` // represents
	Status uint64 `json:"status"`
}

func (p *Player) Format(ID PlayerID) string {
	JSON, _ := json.Marshal(newPlayerResponse(ID, p))
	return string(JSON)
}

func newPlayerResponse(ID PlayerID, player *Player) PlayerResponse {
	return PlayerResponse{
		ID:     ID,
		Type:   player.Type,
		Name:   player.Name,
		Reps:   player.Reps,
		Status: player.Status,
	}
}

type Players struct {
	players  map[PlayerID]*Player
	mutex    sync.Mutex
	observer func(PlayerResponse)
}

func (p *Players) Init() {
	p.players = make(map[PlayerID]*Player)

	fmt.Print("Players handler initialized.\n")
}

func (p *Players) SetObserver(observer func(PlayerResponse)) {
	p.observer = observer
}

func (p *Players) notify(response PlayerResponse) {
	if p.observer != nil {
		p.observer(response)
	}
}

func (p *Players) New(t uint64, name string, reps uint64, status uint64) PlayerID {
	p.mutex.Lock()

	var ID PlayerID

	for {
		// create random session ID
		ID_b := make([]byte, id_length)
		for i := range ID_b {
			ID_b[i] = id_letters[rand.Intn(len(id_letters))]
		}

		ID = PlayerID(ID_b)

		// break if this ID isn't in use
		if _, found := p.players[ID]; !found {
			break
		}
		// continue if found
	}

	p.players[ID] = new(Player)
	// no need to check if it was found; we just inserted it
	player, _ := p.players[ID]
	player.Type = t
	player.Name = name
	player.Reps = reps
	player.Status = status
	response := newPlayerResponse(ID, player)
	p.mutex.Unlock()
	p.notify(response)

	return ID
}

func (p *Players) Delete(ID PlayerID) {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	delete(p.players, ID)
}

func (p *Players) SetStatus(ID PlayerID, status uint64) {
	p.mutex.Lock()
	player, found := p.players[ID]
	if found {
		player.Status = status
	}
	var response PlayerResponse
	if found {
		response = newPlayerResponse(ID, player)
	}
	p.mutex.Unlock()

	if found {
		p.notify(response)
	}
}

func (p *Players) Get(ID PlayerID) *Player {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	if player, found := p.players[ID]; found {
		return player
	} else {
		return nil
	}
}

func (p *Players) List() []PlayerResponse {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	players := make([]PlayerResponse, 0, len(p.players))
	for ID, player := range p.players {
		players = append(players, newPlayerResponse(ID, player))
	}
	return players
}

// UpdateConnected updates a connected player. Potential return values are:
//
// (false, false) - player not found
//
// (true, false) - player is found, but not connected
//
// (true, true) - player exists and is found
func (p *Players) UpdateConnected(
	ID PlayerID,
	playerType uint64,
	representation uint64,
) (bool, bool) {
	p.mutex.Lock()
	player, found := p.players[ID]
	if !found {
		p.mutex.Unlock()
		return false, false
	}
	if player.Status != StatusConn {
		p.mutex.Unlock()
		return true, false
	}

	player.Type = playerType
	player.Reps = representation
	response := newPlayerResponse(ID, player)
	p.mutex.Unlock()
	p.notify(response)
	return true, true
}

// /api/player/*
func (p *Players) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		return
	}

	base := path.Base(r.URL.Path)
	// GET /api/player/list.json
	switch base {
	case "list.json":
		p.ServeList(w, r)
		// POST /api/player/register
	case "register":
		p.ServeRegister(w, r)
		// /api/player/*
	default:
		writeJSONError(w, http.StatusNotFound)
	}
}

// GET /api/player/list.json
func (p *Players) ServeList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}

	writeJSON(w, http.StatusOK, p.List())
}

// POST /api/player/register
// JSON "type": type of user
func (p *Players) ServeRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed)
		return
	}

	var request PlayerRegistrationRequest
	// The legacy frontend sends an extra field. Ignore unknown fields here until
	// that client is retired, but do not use them as player credentials.
	if !decodeJSONBodyAllowUnknownFields(w, r, &request) {
		return
	}
	if request.Type == nil {
		writeJSONError(w, http.StatusBadRequest)
		return
	}

	t := *request.Type
	name := request.Name
	var ID PlayerID

	if t < TypePlayer || t > TypeLeader { // admins register separately
		writeJSONError(w, http.StatusBadRequest)
		return
	}

	switch t {
	case TypeLeader:
		// register leader as a player watcher;
		// remains invalid until admin changes type to leader.
		ID = p.New(TypePlayer, name, RepsNothing, StatusDisc)
	default:
		// register player into the game
		ID = p.New(TypePlayer, name, RepsNothing, StatusDisc)
	}

	player := p.Get(ID)
	if player == nil {
		writeJSONError(w, http.StatusInternalServerError)
		return
	}

	fmt.Printf("Players\tServeRegister (/api/player/register/):\tRegistered ID %q (%q) as %s representing %s.\n",
		ID, player.Name, TypeString(player.Type), RepsString(player.Reps))

	writeJSON(w, http.StatusOK, PlayerRegistrationResponse{ID: ID})
}
