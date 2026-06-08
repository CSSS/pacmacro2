// player.go

package api

import (
	"fmt"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// zero-value player: froshee, pacman, disconnected
type Player struct {
	// private
	pass string // password

	// public
	Type   uint64 `json:"type"`
	Name   string `json:"name"` // alt.: description
	Reps   uint64 `json:"reps"` // represents
	Status uint64 `json:"status"`
}

// attempts to log in the user with the provided password
func (p *Player) Login(pass string) bool {
	return p.pass == pass
}

func (p *Player) Format(ID string) string {
	return fmt.Sprintf("{\"id\":%q, \"type\":%d, \"name\":%q, \"reps\":%d}\n",
		ID, p.Type, p.Name, p.Reps)
}

type Players struct {
	adminRegistered bool
	players         map[string]*Player
	mutex           sync.Mutex
}

func (p *Players) Init() {
	p.adminRegistered = false
	p.players = make(map[string]*Player)

	fmt.Print("Players handler initialized.\n")
}

func (p *Players) New(t uint64, name string, reps uint64, status uint64, pass string) string {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	var ID string

	for {
		// create random session ID
		ID_r := make([]rune, id_length)
		for i := range ID_r {
			ID_r[i] = id_letters[rand.Intn(len(id_letters))]
		}

		ID = string(ID_r)

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
	player.pass = pass

	return ID
}

func (p *Players) Delete(ID string) {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	delete(p.players, ID)
}

func (p *Players) SetStatus(ID string, status uint64) {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	if player, found := p.players[ID]; found {
		player.Status = status
	}
}

func (p *Players) Get(ID string) *Player {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	if player, found := p.players[ID]; found {
		return player
	} else {
		return nil
	}
}

// /api/player/*
func (p *Players) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path[12:]
	if r.Method == http.MethodOptions {
		return
	}

	// GET /api/player/list.json
	switch path {
	case "list.json":
		p.ServeList(w, r)
		// POST /api/player/register
	case "register":
		p.ServeRegister(w, r)
		// /api/player/*
	default:
		http.Error(w,
			http.StatusText(http.StatusNotFound),
			http.StatusNotFound)
	}
}

// GET /api/player/list.json
func (p *Players) ServeList(w http.ResponseWriter, r *http.Request) {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	var ret strings.Builder
	ret.WriteString("[\n")
	i := 0

	// get list of connected players
	for ID, player := range p.players {
		ret.WriteString(player.Format(ID))
		if i++; i < len(p.players) {
			ret.WriteString(",")
		}
	}

	ret.WriteString("]")

	w.Write([]byte(ret.String()))
}

// POST /api/player/register
// "type": type of user
// "pass": password of user
func (p *Players) ServeRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w,
			http.StatusText(http.StatusBadRequest),
			http.StatusBadRequest)
		return
	}

	t, err := strconv.Atoi(r.FormValue("type"))
	name := r.FormValue("name")
	pass := r.FormValue("pass")

	var ID string

	if err != nil || // invalid form data
		t < 0 || t > TypeAdmin || // validate type
		len(pass) == 0 || len(pass) > MaxPassLength { // validate pass
		http.Error(w,
			http.StatusText(http.StatusBadRequest),
			http.StatusBadRequest)
		return
	}

	switch t {
	case TypeAdmin:
		// registering as admin requires the admin password
		if p.adminRegistered || pass != adminPassword {
			http.Error(w,
				http.StatusText(http.StatusUnauthorized),
				http.StatusUnauthorized)
			return
		}

		// admin is registered successfully
		p.adminRegistered = true

		ID = p.New(TypeAdmin, name, RepsNothing, StatusDisc, pass)
	case TypeLeader:
		// register leader as a froshee watcher;
		// remains invalid until admin changes type to leader.
		ID = p.New(TypeFroshee, name, RepsNothing, StatusDisc, pass)
	default:
		// register froshee into the game
		ID = p.New(TypeFroshee, name, RepsNothing, StatusDisc, pass)
	}

	player := p.Get(ID)
	if player == nil {
		http.Error(w,
			http.StatusText(http.StatusInternalServerError),
			http.StatusInternalServerError)
		return
	}

	fmt.Printf("Players\tServeRegister (/api/player/register/):\tRegistered ID %q (%q) as %s representing %s.\n",
		ID, player.Name, TypeString(player.Type), RepsString(player.Reps))

	// respond with registered ID
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(ID))
}
