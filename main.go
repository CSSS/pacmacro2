package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

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
* POST  /api/admin/update/<ID> Update a connected player's type and representation.
* WS    /api/admin/ws          Receive authenticated live player status updates.
* GET   /api/player/list.json  List players.
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
		sock    api.Sockets
	)

	players.Init()                             // initialize players handler
	game.Init(&players)                        // initialize game handler
	sock.Init(&players)                        // initialize sockets handler
	admin.Init(&players, &sock, adminPassword) // initialize admin handler

	http.Handle("/api/player/", corsMiddleware(&players)) // /api/player/register; /api/player/list.json
	http.Handle("/api/admin/", corsMiddleware(&admin))    // registration and authenticated admin operations
	http.Handle("/api/game/", corsMiddleware(&game))      // /api/game/map.json
	http.Handle("/api/ws/", corsMiddleware(&sock))        // /api/ws/<ID>

	port := ":49152"

	// print to terminal that server started
	fmt.Printf("Started PacMacro; listening on localhost%s...\n", port)

	// PacMacro API is served on port 49152.
	// this should be proxied inside the web server used.
	log.Fatal(http.ListenAndServe(port, nil))
}
