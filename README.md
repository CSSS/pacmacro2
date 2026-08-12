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

Players assigned a Leader role can open `/leader`.
The page authenticates with the readable `id` cookie used by the game client.
Generic Leaders have read-only access, AntiPac Leaders can choose a connected Ghost, Edible, or Antipac as the single Antipac, and Flag Leaders control shared flag-found state.

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

- `POST /api/admin/reset` resets every non-leader to Ghost, clears flag-found state, and clears retained Admin-map locations.
- `POST /api/admin/flag` accepts `{ "isFlagFound": boolean }` from the authenticated Admin.
- `GET /api/leader/state.json` returns `{ leader, players, isFlagFound }` for the leader identified by the `id` cookie.
- `POST /api/leader/update/<ID>` accepts `{ "type": 2|3 }` from an AntiPac Leader.
- `POST /api/leader/flag` accepts `{ "isFlagFound": boolean }` from a Flag Leader.
- `WS /api/leader/ws` provides leader snapshots and live player, self-role, flag, and revocation events.

Game and admin-map sockets send `state` messages whose `data` is
`{ "isFlagFound": boolean }`, including one in every initial snapshot.
The Admin control socket includes `isFlagFound` in its `snapshot` event and
sends `flag` events whenever that shared state changes.
