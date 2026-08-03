# PacMacro Angular frontend

This is the Angular 22 replacement for the legacy frontend in `../htdocs`. It prerenders the game, login, registration, and admin routes as static HTML and connects to the existing Go API in the browser.

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

The production command prerenders `/`, `/login`, `/register`, and `/admin`. Deploy the static files from `dist/frontend/browser`; no Node process is required in production.

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

## Project conventions

- Standalone, zoneless Angular components using signals and `OnPush` change detection
- SCSS and HTML stored in external files
- `pac` component-selector prefix
- Angular 2016 filenames such as `game-page.component.ts`
- Angular artifact types included in class names, such as `GamePageComponent` and `ApiService`
