import { LivePlayer, PlayerStatus, PlayerType } from '../../core/game.models';
import { labelForPlayer, opacityForPlayer, spriteNameForType } from './game-canvas.component';

describe('spriteNameForType', () => {
  it.each([
    [PlayerType.Hidden, null],
    [PlayerType.Pacman, 'pacman'],
    [PlayerType.Antipac, 'antipac'],
    [PlayerType.Ghost, 'ghost'],
    [PlayerType.Edible, 'edible'],
    [PlayerType.Leader, 'leader'],
    [PlayerType.AntiPacLeader, 'antiPacLeader'],
    [PlayerType.FlagLeader, 'flagLeader'],
  ] as const)('maps type %s to %s', (playerType, sprite) => {
    expect(spriteNameForType(playerType)).toBe(sprite);
  });

  it('uses the flag sprite only for Pacman when the flag is found', () => {
    expect(spriteNameForType(PlayerType.Pacman, true)).toBe('pacmanFlag');
    expect(spriteNameForType(PlayerType.Pacman, false)).toBe('pacman');
    expect(spriteNameForType(PlayerType.Antipac, true)).toBe('antipac');
  });

  it('displays Ghosts as Edible while the flag is found without affecting other roles', () => {
    expect(spriteNameForType(PlayerType.Ghost, true)).toBe('edible');
    expect(spriteNameForType(PlayerType.Ghost, false)).toBe('ghost');
    expect(spriteNameForType(PlayerType.Edible, true)).toBe('edible');
    expect(spriteNameForType(PlayerType.Antipac, true)).toBe('antipac');
  });
});

describe('player marker presentation', () => {
  const livePlayer: LivePlayer = {
    coordinate: { latitude: 49.27, longitude: -122.91 },
    player: {
      id: 'ABCD',
      name: 'Player',
      type: PlayerType.Antipac,
      status: PlayerStatus.Connected,
    },
  };

  it('labels connected players normally at full opacity', () => {
    expect(labelForPlayer('ABCD', livePlayer, '')).toBe('Player (ABCD)');
    expect(opacityForPlayer(livePlayer)).toBe(1);
  });

  it('dims disconnected players and appends Offline to the label', () => {
    const offline = {
      ...livePlayer,
      player: { ...livePlayer.player, status: PlayerStatus.Disconnected },
    };

    expect(labelForPlayer('ABCD', offline, '')).toBe('Player (ABCD) Offline');
    expect(opacityForPlayer(offline)).toBe(0.45);
  });
});
