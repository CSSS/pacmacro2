# PacMacro

This repository holds the source code for the PacMacro event typically run during Frosh Week.
Originally forked from [https://github.com/micahdbak/pacmacro](https://github.com/micahdbak/pacmacro)

## Structure

This version of PacMacro consists of a **Go API** accessed under `/api` and two frontend implementations. `htdocs` contains the legacy JavaScript frontend; `frontend` contains the Angular 22 static-site replacement.

## Deployment

1. Create a `pacmacro.service` file and place it in `/etc/systemd/system/`
2. Start the service
```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pacmacro
```


## Building

Install the GoLang toolchain and run `go build -o pacmacro`.

### API

To build the PacMacro API, run `go build ./main.go` from the root directory of this repo.
Start the API in a detachable terminal (e.g., `tmux`), and ensure that it is proxied properly.

### Frontend

Use Node 26.5.1, then build the Angular frontend:

```sh
cd frontend
npm ci
npm test -- --watch=false
npm run build
```

Serve `frontend/dist/frontend/browser` as the site's document root. See [`frontend/README.md`](frontend/README.md) for development and Nginx configuration.
