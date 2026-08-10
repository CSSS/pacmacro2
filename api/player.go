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
	Name string `json:"name"`
}

type PlayerRegistrationResponse struct {
	ID PlayerID `json:"id"`
}

type PlayerResponse struct {
	ID     PlayerID   `json:"id"`
	Name   string     `json:"name"`
	Type   PlayerType `json:"type"`
	Status uint64     `json:"status"`
}

type Player struct {
	Name   string     `json:"name"` // alt.: description
	Type   PlayerType `json:"type"`
	Status uint64     `json:"status"`
}

func (p *Player) Format(ID PlayerID) string {
	JSON, _ := json.Marshal(newPlayerResponse(ID, p))
	return string(JSON)
}

func newPlayerResponse(ID PlayerID, player *Player) PlayerResponse {
	return PlayerResponse{
		ID:     ID,
		Name:   player.Name,
		Type:   player.Type,
		Status: player.Status,
	}
}

type Players struct {
	players          map[PlayerID]*Player
	mutex            sync.Mutex
	observers        []func(PlayerResponse)
	removalObservers []func(PlayerID)
}

func (p *Players) Init() {
	p.players = make(map[PlayerID]*Player)

	fmt.Print("Players handler initialized.\n")
}

func (p *Players) SetObserver(observer func(PlayerResponse)) {
	p.mutex.Lock()
	p.observers = nil
	if observer != nil {
		p.observers = append(p.observers, observer)
	}
	p.mutex.Unlock()
}

func (p *Players) AddObserver(observer func(PlayerResponse)) {
	if observer == nil {
		return
	}
	p.mutex.Lock()
	p.observers = append(p.observers, observer)
	p.mutex.Unlock()
}

func (p *Players) AddRemovalObserver(observer func(PlayerID)) {
	if observer == nil {
		return
	}
	p.mutex.Lock()
	p.removalObservers = append(p.removalObservers, observer)
	p.mutex.Unlock()
}

func (p *Players) notify(response PlayerResponse) {
	p.mutex.Lock()
	observers := append([]func(PlayerResponse){}, p.observers...)
	p.mutex.Unlock()
	for _, observer := range observers {
		observer(response)
	}
}

func (p *Players) notifyRemoval(ID PlayerID) {
	p.mutex.Lock()
	observers := append([]func(PlayerID){}, p.removalObservers...)
	p.mutex.Unlock()
	for _, observer := range observers {
		observer(ID)
	}
}

func (p *Players) New(playerType PlayerType, name string, status uint64) PlayerID {
	if !playerType.Valid() {
		return ""
	}
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
	player.Name = name
	player.Type = playerType
	player.Status = status
	response := newPlayerResponse(ID, player)
	p.mutex.Unlock()
	p.notify(response)

	return ID
}

func (p *Players) Delete(ID PlayerID) {
	p.mutex.Lock()
	_, found := p.players[ID]
	if found {
		delete(p.players, ID)
	}
	p.mutex.Unlock()
	if found {
		p.notifyRemoval(ID)
	}
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
		copy := *player
		return &copy
	} else {
		return nil
	}
}

func (p *Players) Response(ID PlayerID) (PlayerResponse, bool) {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	player, found := p.players[ID]
	if !found {
		return PlayerResponse{}, false
	}
	return newPlayerResponse(ID, player), true
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

// Update changes a player's type whether or not the player is connected and
// atomically applies the demotion rule for every unique role.
func (p *Players) Update(
	playerID PlayerID,
	playerType PlayerType,
) (PlayerResponse, []PlayerResponse, bool) {
	if !playerType.Valid() {
		return PlayerResponse{}, nil, false
	}
	p.mutex.Lock()
	player, found := p.players[playerID]
	if !found {
		p.mutex.Unlock()
		return PlayerResponse{}, nil, false
	}

	demoted := make([]PlayerResponse, 0)
	demotionType, unique := uniqueRoleDemotion(playerType)
	if unique {
		for otherID, otherPlayer := range p.players {
			if otherID == playerID || otherPlayer.Type != playerType {
				continue
			}
			otherPlayer.Type = demotionType
			demoted = append(demoted, newPlayerResponse(otherID, otherPlayer))
		}
	}

	player.Type = playerType
	response := newPlayerResponse(playerID, player)
	p.mutex.Unlock()
	for _, demotedPlayer := range demoted {
		p.notify(demotedPlayer)
	}
	p.notify(response)
	return response, demoted, true
}

func uniqueRoleDemotion(playerType PlayerType) (PlayerType, bool) {
	switch playerType {
	case TypePacman, TypeAntipac:
		return TypeGhost, true
	case TypeAntiPacLeader, TypeFlagLeader:
		return TypeLeader, true
	default:
		return 0, false
	}
}

type LeaderUpdateResult uint8

const (
	LeaderUpdateOK LeaderUpdateResult = iota
	LeaderUpdateUnauthorized
	LeaderUpdateForbidden
	LeaderUpdateNotFound
	LeaderUpdateConflict
)

// UpdateByAntiPacLeader performs authorization, eligibility checks, and the
// single-Antipac transition while holding the player lock.
func (p *Players) UpdateByAntiPacLeader(
	leaderID PlayerID,
	targetID PlayerID,
	playerType PlayerType,
) ([]PlayerResponse, LeaderUpdateResult) {
	p.mutex.Lock()
	leader, found := p.players[leaderID]
	if !found || !IsLeaderType(leader.Type) {
		p.mutex.Unlock()
		return nil, LeaderUpdateUnauthorized
	}
	if leader.Type != TypeAntiPacLeader {
		p.mutex.Unlock()
		return nil, LeaderUpdateForbidden
	}
	target, found := p.players[targetID]
	if !found {
		p.mutex.Unlock()
		return nil, LeaderUpdateNotFound
	}
	if target.Status != StatusConn ||
		(target.Type != TypeGhost && target.Type != TypeEdible && target.Type != TypeAntipac) {
		p.mutex.Unlock()
		return nil, LeaderUpdateConflict
	}

	changed := make([]PlayerResponse, 0, 2)
	if playerType == TypeAntipac {
		for otherID, other := range p.players {
			if otherID == targetID || other.Type != TypeAntipac {
				continue
			}
			other.Type = TypeGhost
			changed = append(changed, newPlayerResponse(otherID, other))
		}
	}
	if target.Type != playerType {
		target.Type = playerType
		changed = append(changed, newPlayerResponse(targetID, target))
	}
	p.mutex.Unlock()

	for _, response := range changed {
		p.notify(response)
	}
	return changed, LeaderUpdateOK
}

// ResetNonLeaders changes every non-leader role to Ghost and returns the
// affected players. Generic and specialized leaders are preserved.
func (p *Players) ResetNonLeaders() []PlayerResponse {
	p.mutex.Lock()
	changed := make([]PlayerResponse, 0)
	for ID, player := range p.players {
		if IsLeaderType(player.Type) || player.Type == TypeGhost {
			continue
		}
		player.Type = TypeGhost
		changed = append(changed, newPlayerResponse(ID, player))
	}
	p.mutex.Unlock()
	for _, response := range changed {
		p.notify(response)
	}
	return changed
}

// LeaderState returns an authorization-checked, consistent leader panel
// snapshot. All leader roles are excluded from the player list.
func (p *Players) LeaderState(ID PlayerID) (PlayerResponse, []PlayerResponse, bool) {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	leader, found := p.players[ID]
	if !found || !IsLeaderType(leader.Type) {
		return PlayerResponse{}, nil, false
	}
	players := make([]PlayerResponse, 0, len(p.players)-1)
	for playerID, player := range p.players {
		if IsLeaderType(player.Type) {
			continue
		}
		players = append(players, newPlayerResponse(playerID, player))
	}
	return newPlayerResponse(ID, leader), players, true
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
// JSON "name": player display name
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
	name := request.Name
	ID := p.New(TypeGhost, name, StatusDisc)

	player := p.Get(ID)
	if player == nil {
		writeJSONError(w, http.StatusInternalServerError)
		return
	}

	fmt.Printf("Players\tServeRegister (/api/player/register/):\tRegistered ID %q (%q) as %s.\n",
		ID, player.Name, TypeString(player.Type))

	writeJSON(w, http.StatusOK, PlayerRegistrationResponse{ID: ID})
}
