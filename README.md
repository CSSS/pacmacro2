# PacMacro

This repository holds the source code for the PacMacro event typically run during Frosh Week.
Originally forked from [https://github.com/micahdbak/pacmacro](https://github.com/micahdbak/pacmacro)

## Structure

This version of PacMacro consists of a **Go API** accessed under `/api` and two frontend implementations. `htdocs` contains the legacy JavaScript frontend; `frontend` contains the Angular 22 static-site replacement.

## Deployment

The backend requires `ADMIN_PASSWORD` and the map bounds shown below.
For local development, add them to the ignored `.env` file in the repository root (see `.env.example`):

```dotenv
ADMIN_PASSWORD=replace-with-a-long-random-password
# These are the boundaries for UniverCity
MIN_LAT=49.27462710773634
MIN_LON=-122.91628624024605
MAX_LAT=49.28099313727333
MAX_LON=-122.90273076431673
```

The binary loads `.env` from its working directory when present. For the production systemd service, put the same variables in `/etc/pacmacro/pacmacro.env` and retain this service setting:

```systemd
EnvironmentFile=/etc/pacmacro/pacmacro.env
```

Restrict that file to root and the deployment group because it contains the administrator secret. Then reload and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pacmacro
```

## Building

Install the GoLang toolchain and run `go build -o pacmacro`.

### Backend

To build the PacMacro server, run `go build -o pacmacro .` from the root directory.
The backend refuses to start when `ADMIN_PASSWORD` or any map bound is missing or invalid.

### Frontend

Use Node 26.5.1, then build the Angular frontend:

```sh
cd frontend
npm ci
npm test -- --watch=false
npm run build
```

Serve `frontend/dist/frontend/browser` as the site's document root.
See [`frontend/README.md`](frontend/README.md) for development and Nginx configuration.

The admin control panel includes a read-only live map at `/admin/map`.
Its WebSocket endpoint is `WS /api/admin/map/ws`; it uses the HttpOnly admin cookie and must be proxied with WebSocket upgrade headers in production.

Players assigned a Leader role see Leader controls alongside the live map on the
main game page (`/`). The controls use the readable `id` cookie shared with the
game client to identify the Leader. The panel lists Ghost and Hidden players;
AntiPac Leaders also see Antipac players. Every leader can switch listed
players between Ghost and Hidden, including disconnected players. AntiPac
Leaders can additionally select a Ghost as the single Antipac. Flag Leaders
can control the shared flag-found state.

## Player types

Player responses and live `inform` messages use one numeric `type` field: Hidden (`0`), Pacman (`1`), Antipac (`2`), Ghost (`3`), Edible (`4`), Leader (`5`), AntiPac Leader (`6`), or Flag Leader (`7`).
New player registrations accept `{ "name": string }` and start as Ghost. Authenticated updates use `{ "type": number }` with `POST /api/admin/update/<ID>`.
Pacman and Antipac are independently unique; selecting either changes every
other player of that type to Ghost. AntiPac Leader and Flag Leader are also
independently unique, with the previous holder demoted to generic Leader.

### Live-map visibility

| Role | Ordinary player maps | The role owner's map | Authenticated Admin map |
| --- | --- | --- | --- |
| Pacman, Ghost, Edible, Leader | Visible | Visible | Visible |
| Antipac, AntiPac Leader, Flag Leader | Hidden | Own marker only | Visible |
| Hidden | Hidden | Hidden | Hidden |

“Owner” means every game-socket connection using the same player ID. Private
roles never receive one another's marker or location. Hidden is intentionally
excluded from every map, including the Admin map.

Game sockets use `inform` for player metadata plus a location, `move` for later
locations, and `remove` with only the player ID in `data` to invalidate a
cached marker. A `remove` frame intentionally has no `coordinate` field.

On final disconnect, player maps remove the marker. The Admin map retains the
last received coordinate in memory, displays the marker dimmed with `Offline`
in its label, and includes it in later Admin-map snapshots. Reconnecting clears
the retained marker and requires a fresh GPS update before the current marker
returns. `POST /api/admin/reset` clears all retained offline locations while
leaving connected players' live coordinates intact.

## Control APIs

- `GET /api/player/verify` returns `204 No Content` when the `id` cookie belongs
  to a current player (including a leader), otherwise `401 Unauthorized`.
- `POST /api/admin/start` accepts an optional `{ "durationMinutes": whole minutes }` to start a game timer of that length for the authenticated Admin. An empty body, `null`, or `{}` starts the 20-minute default. There is no minimum or maximum; any positive whole minutes are accepted. Fractional, nonnumeric, or non-positive values return `400 Bad Request`. It returns `409 Conflict` if the game has already started and has not been reset.
- `POST /api/admin/reset` cancels the game timer, resets every non-leader to Ghost, clears flag-found state, and clears retained Admin-map locations.
- `POST /api/admin/flag` accepts `{ "isFlagFound": boolean }` from the authenticated Admin.
- `POST /api/admin/kick/<ID>` removes a player, clears their map state, and closes
  active game sockets with policy code `1008`. The removed player must register again.
- `POST /api/admin/antipac/empower` reduces an active game's remaining time to ten minutes for the authenticated Admin. If ten minutes or less remain, it leaves the timer unchanged. It returns `409 Conflict` when the game is not active.
- Capturing the flag through `POST /api/admin/flag` or `POST /api/leader/flag` empowers Pacman. If more than ten minutes remain in an active game, it reduces the timer to ten minutes remaining.
- `GET /api/leader/state.json` returns `{ leader, players, isFlagFound }` for the leader identified by the `id` cookie; `players` contains Ghost and Hidden roles, plus Antipac only for an AntiPac Leader.
- `POST /api/leader/update/<ID>` accepts `{ "type": 0|3 }` from any Leader for a
  Ghost, Hidden, or Antipac target (regardless of connection status). `{ "type": 2 }`
  is available only to an AntiPac Leader and only when the target is currently Ghost;
  assigning it atomically demotes the previous Antipac to Ghost.
- `POST /api/leader/flag` accepts `{ "isFlagFound": boolean }` from a Flag Leader.
- `WS /api/leader/ws` provides leader snapshots and live player, self-role, flag, and revocation events.

Game and admin-map sockets send `state` messages whose `data` contains `isFlagFound`, `phase`, `startTime`, `endTime`, and `serverTime`, including one in every initial snapshot. The Admin control socket includes the same game state in its `snapshot` event and sends `upsert`, `remove`, and `state` events as roster and shared state change, while retaining the existing `isFlagFound` and `flag` messages for compatibility. All player, leader, and Admin views display the synchronized countdown.