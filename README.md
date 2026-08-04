# PacMacro

This repository holds the source code for the PacMacro event typically run during Frosh Week.
Originally forked from [https://github.com/micahdbak/pacmacro](https://github.com/micahdbak/pacmacro)

## Structure

This version of PacMacro consists of a **Go API** accessed under `/api` and two frontend implementations. `htdocs` contains the legacy JavaScript frontend; `frontend` contains the Angular 22 static-site replacement.

## Deployment

The backend requires `ADMIN_PASSWORD`. For local development, add it to the ignored `.env` file in the repository root (see `.env.example`):

```dotenv
ADMIN_PASSWORD=replace-with-a-long-random-password
```

The binary loads `.env` from its working directory when present. For the production systemd service, put the same setting in `/etc/pacmacro/pacmacro.env` and retain this service setting:

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
The backend refuses to start when `ADMIN_PASSWORD` is missing.

### Frontend

Use Node 26.5.1, then build the Angular frontend:

```sh
cd frontend
npm ci
npm test -- --watch=false
npm run build
```

Serve `frontend/dist/frontend/browser` as the site's document root. See [`frontend/README.md`](frontend/README.md) for development and Nginx configuration.
