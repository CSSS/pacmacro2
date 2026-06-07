package main

import (
	"fmt"
	"log"
	"net/http"

	"pacmacro/api"
)

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

/* LIST OF API CALLS AND THEIR DESCRIPTIONS
  ----------------------------------------
* POST  /api/player/register   Register as a player; gives ID and sets password.
* GET   /api/player/list.json  List players.
* WS    /api/admin/set/<ID>    Stream coordinate information of playable area to
                           the server; sets the minimum and maximum latitude and
                           longitude values after full traversal.
* POST  /api/admin/scale       Set the scale of horizontal and vertical components
                           of the map; these are used for internal coordinate
                           processing, and for pellet placement.
* POST  /api/admin/populate    Populate the map with pellets.
* GET   /api/game/map.json     Get map information; size and pellet location.
* WS    /api/ws/<ID>           Connect to the server; expects coordinates to be
                           streamed so your location is displayed on the map. */

func main() {
	var (
		players api.Players
		game    api.Game
		admin   api.Admin
		sock    api.Sockets
	)

	players.Init()                     // initialize players handler
	game.Init(&players)                // initialize game handler
	sock.Init(&players)                // initialize sockets handler
	admin.Init(&players, &game, &sock) // initialize admin handler

	http.Handle("/api/player/", corsMiddleware(&players)) // /api/player/register; /api/player/list.json
	http.Handle("/api/admin/", corsMiddleware(&admin))    // /api/admin/set/<ID>; /api/admin/scale; /api/admin/populate
	http.Handle("/api/game/", corsMiddleware(&game))      // /api/game/map.json
	http.Handle("/api/ws/", corsMiddleware(&sock))        // /api/ws/<ID>

	// print to terminal that server started
	fmt.Printf("Started PacMacro; listening on localhost:8000...\n")

	// note: PacMacro API is served on port 8000 by default.
	// this should be proxied inside the web server used.
	log.Fatal(http.ListenAndServe(":8000", nil))
}
