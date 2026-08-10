package api

import (
	"sync"
	"testing"
)

func TestPlayerTypeNumericCompatibilityAndLabels(t *testing.T) {
	types := []struct {
		playerType PlayerType
		number     PlayerType
		label      string
	}{
		{TypeHidden, 0, "Hidden"},
		{TypePacman, 1, "Pacman"},
		{TypeAntipac, 2, "Antipac"},
		{TypeGhost, 3, "Ghost"},
		{TypeEdible, 4, "Edible"},
		{TypeLeader, 5, "Leader"},
		{TypeAntiPacLeader, 6, "AntiPac Leader"},
		{TypeFlagLeader, 7, "Flag Leader"},
	}
	for _, test := range types {
		if test.playerType != test.number {
			t.Errorf("%s numeric value = %d, want %d", test.label, test.playerType, test.number)
		}
		if !test.playerType.Valid() {
			t.Errorf("%s is not valid", test.label)
		}
		if label := TypeString(test.playerType); label != test.label {
			t.Errorf("type %d label = %q, want %q", test.playerType, label, test.label)
		}
	}
}

func TestAllUniqueRoleUpdatesUseTheirCorrectDemotion(t *testing.T) {
	tests := []struct {
		name         string
		uniqueType   PlayerType
		demotionType PlayerType
	}{
		{"Pacman", TypePacman, TypeGhost},
		{"Antipac", TypeAntipac, TypeGhost},
		{"AntiPacLeader", TypeAntiPacLeader, TypeLeader},
		{"FlagLeader", TypeFlagLeader, TypeLeader},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			players := new(Players)
			players.Init()
			previousID := players.New(test.uniqueType, "Previous", StatusDisc)
			targetID := players.New(TypeGhost, "Target", StatusConn)

			updated, demoted, found := players.Update(targetID, test.uniqueType)
			if !found || updated.Type != test.uniqueType {
				t.Fatalf("updated player = %#v", updated)
			}
			if len(demoted) != 1 || demoted[0].ID != previousID || demoted[0].Type != test.demotionType {
				t.Fatalf("demoted players = %#v, want %q as type %d", demoted, previousID, test.demotionType)
			}
		})
	}
}

func TestUniqueRoleUpdatesAreAtomic(t *testing.T) {
	for _, uniqueType := range []PlayerType{
		TypePacman, TypeAntipac, TypeAntiPacLeader, TypeFlagLeader,
	} {
		players := new(Players)
		players.Init()
		ids := make([]PlayerID, 32)
		for index := range ids {
			ids[index] = players.New(TypeGhost, "Player", StatusConn)
		}
		var wait sync.WaitGroup
		for _, ID := range ids {
			wait.Add(1)
			go func() {
				defer wait.Done()
				players.Update(ID, uniqueType)
			}()
		}
		wait.Wait()
		count := 0
		for _, player := range players.List() {
			if player.Type == uniqueType {
				count++
			}
		}
		if count != 1 {
			t.Errorf("type %d count = %d, want 1", uniqueType, count)
		}
	}
}

func TestResetPreservesEveryLeaderRole(t *testing.T) {
	players := new(Players)
	players.Init()
	roleIDs := map[PlayerType]PlayerID{}
	for _, playerType := range []PlayerType{TypeLeader, TypeAntiPacLeader, TypeFlagLeader} {
		roleIDs[playerType] = players.New(playerType, TypeString(playerType), StatusDisc)
	}
	for _, playerType := range []PlayerType{TypeHidden, TypePacman, TypeAntipac, TypeEdible} {
		players.New(playerType, TypeString(playerType), StatusDisc)
	}

	changed := players.ResetNonLeaders()
	if len(changed) != 4 {
		t.Fatalf("changed players = %d, want 4", len(changed))
	}
	for playerType, ID := range roleIDs {
		if player := players.Get(ID); player == nil || player.Type != playerType {
			t.Errorf("leader %q = %#v, want type %d", ID, player, playerType)
		}
	}
	for _, player := range players.List() {
		if !IsLeaderType(player.Type) && player.Type != TypeGhost {
			t.Errorf("non-leader after reset = %#v", player)
		}
	}
}

func TestPlayerObserversAreAdditive(t *testing.T) {
	players := new(Players)
	players.Init()
	firstCalls := 0
	secondCalls := 0
	players.AddObserver(func(PlayerResponse) { firstCalls++ })
	players.AddObserver(func(PlayerResponse) { secondCalls++ })
	ID := players.New(TypeGhost, "Player", StatusDisc)
	players.SetStatus(ID, StatusConn)
	if firstCalls != 2 || secondCalls != 2 {
		t.Errorf("observer calls = %d, %d; want 2, 2", firstCalls, secondCalls)
	}
}
