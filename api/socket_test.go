package api

import "testing"

func TestPlayerStaysConnectedUntilLastSocketDisconnects(t *testing.T) {
	players := new(Players)
	players.Init()
	sockets := new(Sockets)
	sockets.Init(players)
	playerID := players.New(TypePlayer, "Test", RepsNothing, StatusDisc)

	firstConnection := sockets.Connect(nil, playerID)
	secondConnection := sockets.Connect(nil, playerID)
	if firstConnection < 0 || secondConnection < 0 {
		t.Fatal("connect player sockets")
	}
	if player := players.Get(playerID); player == nil || player.Status != StatusConn {
		t.Fatalf("player status after connect = %#v, want connected", player)
	}

	sockets.Disconnect(firstConnection)
	if player := players.Get(playerID); player == nil || player.Status != StatusConn {
		t.Errorf("player status after first disconnect = %#v, want connected", player)
	}

	sockets.Disconnect(secondConnection)
	if player := players.Get(playerID); player == nil || player.Status != StatusDisc {
		t.Errorf("player status after last disconnect = %#v, want disconnected", player)
	}
}
