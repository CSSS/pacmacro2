export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface MapInfo {
  min: Coordinate;
  max: Coordinate;
  width: number;
  height: number;
  isFlagFound: boolean;
}

export interface Plot {
  x: number;
  y: number;
}

export enum PlayerType {
  Hidden = 0,
  Pacman = 1,
  Antipac = 2,
  Ghost = 3,
  Edible = 4,
  Leader = 5,
  AntiPacLeader = 6,
  FlagLeader = 7,
}

export enum PlayerStatus {
  Gone = 0,
  Disconnected = 1,
  Connected = 2,
}

export interface Player {
  id: string;
  name: string;
  type: PlayerType;
  status: PlayerStatus;
}

export type AdminSocketMessage =
  | { event: 'snapshot'; players: Player[]; isFlagFound: boolean }
  | { event: 'upsert'; player: Player }
  | { event: 'flag'; isFlagFound: boolean };

export interface LivePlayer {
  coordinate: Coordinate;
  player: Player;
}

export interface SocketMessage {
  coordinate?: Coordinate;
  command: 'inform' | 'move' | 'remove' | 'state' | string;
  data: string;
}

export type GameSocketMessage = SocketMessage | Coordinate;

export interface GameState {
  isFlagFound: boolean;
}

export interface LeaderState {
  leader: Player;
  players: Player[];
  isFlagFound: boolean;
}

export type LeaderSocketMessage =
  | { event: 'snapshot'; leader: Player; players: Player[]; isFlagFound: boolean }
  | { event: 'upsert'; player: Player }
  | { event: 'remove'; playerId: string }
  | { event: 'self'; leader: Player }
  | { event: 'flag'; isFlagFound: boolean }
  | { event: 'revoked'; reason?: string };

export interface Credentials {
  id: string;
}

export interface PlayerRegistrationResponse {
  id: string;
}

export const PLAYER_TYPES: ReadonlyArray<{
  value: PlayerType;
  label: string;
}> = [
  { value: PlayerType.Pacman, label: 'Pacman' },
  { value: PlayerType.Ghost, label: 'Ghost' },
  { value: PlayerType.Antipac, label: 'Antipac' },
  { value: PlayerType.Leader, label: 'Leader' },
  { value: PlayerType.AntiPacLeader, label: 'AntiPac Leader' },
  { value: PlayerType.FlagLeader, label: 'Flag Leader' },
  { value: PlayerType.Hidden, label: 'Hidden' },
];

export function typeLabel(value: PlayerType): string {
  const labels: Record<PlayerType, string> = {
    [PlayerType.Hidden]: 'Hidden',
    [PlayerType.Pacman]: 'Pacman',
    [PlayerType.Antipac]: 'Antipac',
    [PlayerType.Ghost]: 'Ghost',
    [PlayerType.Edible]: 'Edible',
    [PlayerType.Leader]: 'Leader',
    [PlayerType.AntiPacLeader]: 'AntiPac Leader',
    [PlayerType.FlagLeader]: 'Flag Leader',
  };
  return labels[value] ?? 'Unknown';
}

export function isPlayerType(value: unknown): value is PlayerType {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PlayerType.Hidden &&
    value <= PlayerType.FlagLeader
  );
}

export function isPlayerStatus(value: unknown): value is PlayerStatus {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PlayerStatus.Gone &&
    value <= PlayerStatus.Connected
  );
}

export function isLeaderType(value: PlayerType): boolean {
  return (
    value === PlayerType.Leader ||
    value === PlayerType.AntiPacLeader ||
    value === PlayerType.FlagLeader
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
