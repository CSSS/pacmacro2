package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"
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
* POST  /api/player/register   Register as a player and receive an ID.
* POST  /api/admin/register    Register the administrator and set its session cookie.
* GET   /api/admin/verify      Verify the authenticated administrator session.
* POST  /api/admin/start       Start the game; only the administrator can do this. Optional { "durationMinutes": whole minutes }; empty, null, or {} uses the 20 minute default. No min/max.
* POST  /api/admin/update/<ID> Update a player's type.
* POST  /api/admin/kick/<ID>   Remove a player and revoke their session.
* POST  /api/admin/flag        Update shared flag-found state and signal Pacman.
* POST  /api/admin/reset       Reset all non-leader players and game state.
* WS    /api/admin/ws          Receive authenticated live player status updates.
* WS    /api/admin/map/ws      View authenticated live game updates without a player.
* GET   /api/leader/state.json Get the authenticated leader panel state.
* POST  /api/leader/update/<ID> Update an eligible player as AntiPac Leader.
* POST  /api/leader/flag       Capture the flag and empower Pacman as Flag Leader.
* WS    /api/leader/ws         Receive authenticated live leader-panel updates.
* GET   /api/player/list.json  List players.
* GET   /api/player/verify     Verify the authenticated player session.
* GET   /api/game/map.json     Get map information; size and pellet location.
* WS    /api/ws/<ID>           Connect to the server; expects coordinates to be
                           streamed so your location is displayed on the map. */

func main() {
	// A local .env file is convenient for development. In production, systemd's
	// EnvironmentFile exports the same variables before starting the binary.
	_ = godotenv.Load()
	adminPassword := os.Getenv("ADMIN_PASSWORD")
	if adminPassword == "" {
		log.Fatal("ADMIN_PASSWORD is required")
	}

	var (
		players api.Players
		game    api.Game
		admin   api.Admin
		leader  api.Leader
		sock    api.Sockets
	)

	players.Init() // initialize players handler
	if err := game.Init(&players); err != nil {
		log.Fatalf("initialize game: %v", err)
	}
	sock.Init(&players, &game)                        // initialize sockets handler
	admin.Init(&players, &sock, adminPassword, &game) // initialize admin handler
	leader.Init(&players, &game, &sock)               // initialize leader handler
	game.StartSynchronization(30 * time.Second)

	http.Handle("/api/player/", corsMiddleware(&players)) // registration, list, and session verification
	http.Handle("/api/admin/", corsMiddleware(&admin))    // registration and authenticated admin operations
	http.Handle("/api/leader/", corsMiddleware(&leader))  // authenticated leader operations
	http.Handle("/api/game/", corsMiddleware(&game))      // /api/game/map.json
	http.Handle("/api/ws/", corsMiddleware(&sock))        // /api/ws/<ID>

	port := ":49152"

	// print to terminal that server started
	fmt.Printf("Started PacMacro; listening on localhost%s...\n", port)

	// PacMacro API is served on port 49152.
	// this should be proxied inside the web server used.
	log.Fatal(http.ListenAndServe(port, nil))
}
