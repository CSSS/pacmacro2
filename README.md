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
MIN_LON=-123.91628624024605
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

Serve `frontend/dist/frontend/browser` as the site's document root. See [`frontend/README.md`](frontend/README.md) for development and Nginx configuration.
