// admin.go

package api

import (
	"encoding/json"
	"fmt"
	ws "github.com/gorilla/websocket"
	"net/http"
	"strconv"
	"sync"
)

type Admin struct {
	// private
	players *Players
	game    *Game
	sockets *Sockets
	mutex   sync.Mutex
}

func (a *Admin) Init(players *Players, game *Game, sockets *Sockets) {
	a.players = players
	a.game = game
	a.sockets = sockets

	fmt.Print("Admin handler initialized.\n")
}

func (a *Admin) AuthorizePost(r *http.Request) bool {
	if r.Method != "POST" {
		return false
	}

	p := a.players.Get(r.FormValue("id"))
	pass := r.FormValue("pass")

	return p != nil && p.Type == TypeAdmin && pass == adminPassword
}

// /api/admin/*
func (a *Admin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path[11:]

	// POST /api/admin/scale
	if path == "scale" {
		a.ServeScale(w, r)
		// WS /api/admin/set
	} else if len(path) >= 4 && path[:3] == "set" {
		a.ServeSet(w, r)
		// POST /api/admin/bounds
	} else if len(path) >= 4 && path == "bounds" {
		a.ServeBounds(w, r)
		// POST /api/admin/update/<ID>
	} else if len(path) >= 4 && path[:6] == "update" {
		a.ServeUpdate(w, r)
	} else {
		http.Error(w,
			http.StatusText(http.StatusNotFound),
			http.StatusNotFound)
	}
}

// POST /api/admin/scale
// "id": admin ID
// "pass": admin password
// "width": horizontal scale of map
// "height": vertical scale of map
func (a *Admin) ServeScale(w http.ResponseWriter, r *http.Request) {
	if !a.AuthorizePost(r) {
		http.Error(w,
			http.StatusText(http.StatusUnauthorized),
			http.StatusUnauthorized)
		return
	}

	var wi, h int

	wi, err := strconv.Atoi(r.FormValue("width"))
	if err == nil {
		h, err = strconv.Atoi(r.FormValue("height"))
	}

	// ensure that submitted form data is valid
	if err != nil || wi < 0 || h < 0 {
		http.Error(w,
			http.StatusText(http.StatusBadRequest),
			http.StatusBadRequest)
		return
	}

	a.game.mutex.Lock()
	a.game.Width = uint64(wi)
	a.game.Height = uint64(h)
	a.game.mutex.Unlock()

	fmt.Printf("Admin\tServeScale (/api/admin/scale)\tChanged map scale; width: %d, height: %d.\n", wi, h)
}

// POST /api/admin/bounds
// "id": admin ID
// "pass": admin password
// "min": JSON object storing minimum coordinate information
// "max": JSON object storing maximum coordinate information
func (a *Admin) ServeBounds(w http.ResponseWriter, r *http.Request) {
	if !a.AuthorizePost(r) {
		http.Error(w,
			http.StatusText(http.StatusUnauthorized),
			http.StatusUnauthorized)
		return
	}

	var (
		_min, _max Coordinate
		err        error
	)

	if err = json.Unmarshal([]byte(r.FormValue("min")), &_min); err == nil {
		err = json.Unmarshal([]byte(r.FormValue("max")), &_max)
	}
	if err != nil {
		http.Error(w,
			http.StatusText(http.StatusBadRequest),
			http.StatusBadRequest)
		return
	}

	a.game.mutex.Lock()
	a.game.Min = _min
	a.game.Max = _max
	a.game.mutex.Unlock()

	fmt.Printf("Admin\tServeBounds (/api/admin/bounds)\tChanged map bounds; min: %+v, max: %+v.\n", _min, _max)
}

// WS /api/admin/set/<ID>
/* starts a socket connection and expects latitute/longitude values to be streamed;
 * will keep track of the minimum and maximum values received as the player walks
 * throughout the playable area. */
func (a *Admin) ServeSet(w http.ResponseWriter, r *http.Request) {
	// /api/admin/set/
	ID := r.URL.Path[15:] // portion after /api/admin/set/

	// only admin users can set the game map
	if player := a.players.Get(ID); player == nil || player.Type != TypeAdmin {
		http.Error(w,
			http.StatusText(http.StatusUnauthorized),
			http.StatusUnauthorized)
		return
	}

	// no gameplay should occur during the setting of the map
	a.mutex.Lock()
	defer a.mutex.Unlock()

	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		// print error
		fmt.Printf("Admin\tServeSet (/api/admin/set/):\tBad connection: %v.\n", err)
		return
	}

	fmt.Print("Admin\tServeSet (/api/admin/set/):\tConnection opened.\n")
	conn.WriteMessage(ws.TextMessage, []byte("Waiting for password authentication..."))

	var (
		authorized   bool
		nattempts    int
		first        bool
		min_c, max_c Coordinate
	)

	// first coordinate should immediately set min/max values
	first = true

	// hold connection open; receive location information
	for {
		// receive message from connection
		msgType, msg, err := conn.ReadMessage()
		if err != nil || msgType == ws.CloseMessage {
			fmt.Print("Admin\tServeSet (/api/admin/set/):\tConnection closed")

			if err != nil {
				fmt.Printf(": %v.\n", err)
			} else {
				fmt.Print(" by user.\n")
			}

			break
		}

		var parsed Message

		if err = json.Unmarshal(msg, &parsed); err != nil {
			fmt.Printf("Admin\tServeSet (/api/admin/set/):\tCouldn't parse message: %v;\n"+
				"----BEGIN MESSAGE\n%s\n----END MESSAGE\n", err, string(msg))
			continue
		}

		if parsed.Command == "password" && parsed.Data == adminPassword {
			fmt.Print("Admin\tServeSet (/api/admin/set/):\tAdmin authorized.\n")
			conn.WriteMessage(ws.TextMessage, []byte("Authorized."))
			authorized = true
			continue
		}

		if !authorized {
			fmt.Printf("Admin\tServeSet (/api/admin/set/):\tFailed authorization attempt; password was %q.\n", parsed.Data)
			nattempts++

			if nattempts > MaxAttempts {
				fmt.Print("Admin\tServeSet (/api/admin/set/):\tExceeded max attempts.\n")
				conn.WriteMessage(ws.CloseMessage, []byte("Exceeded max attempts."))
				break
			}

			continue
		}

		switch parsed.Command {
		case "location":
			if first {
				min_c = parsed.Coord
				max_c = parsed.Coord

				first = false
			} else {
				// find min and max values
				min_c.Latitude = min(min_c.Latitude, parsed.Coord.Latitude)
				min_c.Longitude = min(min_c.Longitude, parsed.Coord.Longitude)
				max_c.Latitude = max(max_c.Latitude, parsed.Coord.Latitude)
				max_c.Longitude = max(max_c.Longitude, parsed.Coord.Longitude)
			}

			fmt.Print("Admin\tServeSet (/api/admin/set/):\tReceived coordinates.\n")
			conn.WriteMessage(ws.TextMessage, []byte("Received coordinates."))
		case "write":
			a.game.Min = min_c
			a.game.Max = max_c

			msg := fmt.Sprintf("Min: %+v\nMax: %+v", a.game.Min, a.game.Max)
			fmt.Printf("Admin\tServeSet (/api/admin/set/):\tUpdated game.Min and game.Max;\n"+
				"----BEGIN SUMMARY\n%s\n----END SUMMARY\n", msg)

			// let admin know the set min/max coordinates
			conn.WriteMessage(ws.TextMessage, []byte(msg))
		default:
			fmt.Printf("Admin\tServeSet (/api/admin/set/):\tReceived strange command: %q; ignoring.\n", parsed.Command)
		}
	}
}

// POST /api/admin/update/<ID>
// id: admin ID
// pass: admin pass
// type: new type
// reps: new reps
func (a *Admin) ServeUpdate(w http.ResponseWriter, r *http.Request) {
	if !a.AuthorizePost(r) {
		http.Error(w,
			http.StatusText(http.StatusUnauthorized),
			http.StatusUnauthorized)
		return
	}

	var (
		p       *Player
		t, reps int
	)

	target_ID := r.URL.Path[18:] // portion after /api/admin/set/
	p = a.players.Get(target_ID)
	if p == nil {
		http.Error(w,
			http.StatusText(http.StatusNotFound),
			http.StatusNotFound)
		return
	}

	t, err := strconv.Atoi(r.FormValue("type"))
	if err == nil {
		reps, err = strconv.Atoi(r.FormValue("reps"))
	}
	if err != nil {
		http.Error(w,
			http.StatusText(http.StatusBadRequest),
			http.StatusBadRequest)
		return
	}

	a.players.mutex.Lock()
	p.Type = uint64(t)
	p.Reps = uint64(reps)
	a.players.mutex.Unlock()

	// check if target is currently connected
	if a.sockets.Find(target_ID) != nil {
		// if yes, inform all connections of updated information
		a.sockets.Inform(target_ID)
	}

	// OK
}
