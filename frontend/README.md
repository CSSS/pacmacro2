# PacMacro Angular frontend

This is the Angular 22 replacement for the legacy frontend.
It prerenders the game, registration, and admin routes as static HTML and connects to the existing Go API in the browser.

## Requirements

- Node 26.5.1 (pinned in `.nvmrc` and `.node-version`)
- npm 11
- The PacMacro Go API listening on `127.0.0.1:49152` for local development

## Development

```sh
npm ci
npm start
```

The app is available at `http://localhost:4200`. The Angular development server proxies HTTP and WebSocket requests under `/api` to the Go API.

## Test and build

```sh
npm test -- --watch=false
npm run build
```

The production command prerenders `/`, `/register`, `/admin`, and `/admin/map`.
Deploy the static files from `dist/frontend/browser`.

## Nginx deployment

Point the site root at the build's browser directory and proxy the existing API, including WebSocket upgrades:

```nginx
server {
    server_name pacmacro.sfucsss.org;
    root /path/to/pacmacro2/frontend/dist/frontend/browser;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:49152;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

The frontend derives API and WebSocket addresses from the current hostname, so no production URL substitution is needed.
Player sessions use only the ID returned by registration; the browser stores that ID and reconnects the game WebSocket with it.

## Administrator authentication

Open `/admin` and enter the password configured as `ADMIN_PASSWORD` on the Go backend.
The backend verifies it and returns a session-scoped HttpOnly cookie.
The Angular application cannot read the cookie; the browser sends it automatically to `/api/admin` requests.

The admin control panel opens `/admin/map` in a separate tab. That page connects to the authenticated `/api/admin/map/ws` endpoint and receives the normal live game feed without creating a player or sending coordinates. If the session cookie has expired, register as admin again before reopening the map.

The administrator is maintained separately from players, receives no player ID, and does not appear on the game map or player list.
The Nginx `X-Forwarded-Proto` header shown above allows the backend to mark the cookie `Secure` when the public request uses HTTPS.

## Project conventions

- Standalone, zoneless Angular components using signals and `OnPush` change detection
- SCSS and HTML stored in external files
- `pac` component-selector prefix
