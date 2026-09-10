package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
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
* POST  /api/admin/update/<ID> Update a player's type.
* POST  /api/admin/flag        Update shared flag-found state.
* POST  /api/admin/reset       Reset all non-leader players and game state.
* WS    /api/admin/ws          Receive authenticated live player status updates.
* WS    /api/admin/map/ws      View authenticated live game updates without a player.
* GET   /api/leader/state.json Get the authenticated leader panel state.
* POST  /api/leader/update/<ID> Update an eligible player as AntiPac Leader.
* POST  /api/leader/flag       Update flag state as Flag Leader.
* WS    /api/leader/ws         Receive authenticated live leader-panel updates.
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
		players   api.Players
		game      api.Game
		admin     api.Admin
		leader    api.Leader
		sock      api.Sockets
		lifecycle = api.NewLifecycle()
	)

	players.Init() // initialize players handler
	if err := game.Init(&players); err != nil {
		log.Fatalf("initialize game: %v", err)
	}
	sock.Init(&players, lifecycle, &game)                        // initialize sockets handler
	admin.Init(&players, &sock, adminPassword, lifecycle, &game) // initialize admin handler
	leader.Init(&players, &game, &sock, lifecycle)               // initialize leader handler

	mux := http.NewServeMux()
	mux.Handle("/api/player/", corsMiddleware(&players)) // /api/player/register; /api/player/list.json
	mux.Handle("/api/admin/", corsMiddleware(&admin))    // registration and authenticated admin operations
	mux.Handle("/api/leader/", corsMiddleware(&leader))  // authenticated leader operations
	mux.Handle("/api/game/", corsMiddleware(&game))      // /api/game/map.json
	mux.Handle("/api/ws/", corsMiddleware(&sock))        // /api/ws/<ID>

	port := ":49152"
	server := &http.Server{Addr: port, Handler: mux}

	// print to terminal that server started
	fmt.Printf("Started PacMacro; listening on localhost%s...\n", port)

	// PacMacro API is served on port 49152.
	// this should be proxied inside the web server used.
	serverErr := make(chan error, 1)
	go func() {
		serverErr <- server.ListenAndServe()
	}()

	// Block until SIGINT (Ctrl+C) or SIGTERM (systemd stop/restart).
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-serverErr:
		if err != nil && err != http.ErrServerClosed {
			shutdownWebSockets(lifecycle)
			log.Fatalf("listen and serve: %v", err)
		}
		return
	case <-ctx.Done():
	}

	fmt.Println("Shutdown signal received. Notifying players...")
	shutdown(server, lifecycle)
	fmt.Println("Server exiting.")
}

func shutdownWebSockets(lifecycle *api.Lifecycle) {
	if !lifecycle.Shutdown(time.Now().Add(api.WebsocketCloseWriteTimeout)) {
		fmt.Println("Shutdown timed out waiting for WebSocket workers.")
	}
}

func shutdown(server *http.Server, lifecycle *api.Lifecycle) {
	// Close listeners immediately so no new HTTP or WebSocket connections are
	// accepted while existing connections drain.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), api.ShutdownTimeout)
	defer cancel()

	httpDone := make(chan struct{})
	go func() {
		_ = server.Shutdown(shutdownCtx)
		close(httpDone)
	}()

	// Notify WebSocket clients concurrently with HTTP draining. All close
	// frames share one absolute deadline so stalled clients share the budget.
	wsDone := make(chan bool, 1)
	wsDeadline := time.Now().Add(api.WebsocketCloseWriteTimeout)
	go func() {
		wsDone <- lifecycle.Shutdown(wsDeadline)
	}()

	<-httpDone
	websocketsClean := <-wsDone
	if !websocketsClean {
		fmt.Println("Shutdown timed out waiting for WebSocket workers.")
	}
}
