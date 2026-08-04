export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface MapInfo {
  min: Coordinate;
  max: Coordinate;
  width: number;
  height: number;
}

export interface Plot {
  x: number;
  y: number;
}

export enum PlayerType {
  Player = 0,
  Leader = 1,
  Admin = 2,
  Hidden = 3,
}

export enum Representation {
  Nothing = 0,
  Pacman = 1,
  Antipac = 2,
  Ghost = 3,
  Edible = 4,
}

export interface Player {
  id: string;
  type: PlayerType;
  name: string;
  reps: Representation;
}

export interface LivePlayer {
  coordinate: Coordinate;
  player: Player;
}

export interface SocketMessage {
  coordinate: Coordinate;
  command: 'inform' | 'move' | string;
  data: string;
}

export interface Credentials {
  id: string;
}

export interface PlayerRegistrationResponse {
  id: string;
}

export const PLAYER_TYPES: ReadonlyArray<{ value: PlayerType; label: string }> = [
  { value: PlayerType.Player, label: 'Player' },
  { value: PlayerType.Leader, label: 'Leader' },
  { value: PlayerType.Hidden, label: 'Hidden' },
];

export const REPRESENTATIONS: ReadonlyArray<{
  value: Representation;
  label: string;
}> = [
  { value: Representation.Nothing, label: 'Nothing' },
  { value: Representation.Pacman, label: 'Pacman' },
  { value: Representation.Antipac, label: 'Antipac' },
  { value: Representation.Ghost, label: 'Ghost' },
  { value: Representation.Edible, label: 'Edible' },
];

export function representationLabel(value: Representation): string {
  return (
    REPRESENTATIONS.find((representation) => representation.value === value)?.label ?? 'Unknown'
  );
}
