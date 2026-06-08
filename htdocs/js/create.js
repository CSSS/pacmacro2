// create.js
// programming for the Create Utilities page (create.html)

import {
  WS,
  URL_ROOT,
  EXPAND_X,
  EXPAND_Y,
  pacmacro_init,
  watchLocation,
  stopWatchLocation,
  convertCoords,
} from "./pacmacro.js";

window.onload = async () => {
  pacmacro_init();

  /* ADMIN INFORMATION */

  let admin_id = document.getElementById("admin-id");
  let admin_pass = document.getElementById("admin-pass");

  /*
	document.getElementById("load-id").onclick = () => {
		admin_id.value = getID();
	}
	*/

  /* REGISTRATION */

  let register_button = document.getElementById("register-button");
  let register_status = document.getElementById("register-status");

  register_button.onclick = async () => {
    const form = new FormData();

    form.append("type", "2"); // TypeAdmin
    form.append("pass", admin_pass.value);

    let resp;

    // attempt to register admin
    try {
      resp = await fetch("/api/player/register", {
        method: "POST",
        body: form,
      });
    } catch {
      // on fetch error
      register_status.innerHTML = "Error";
    }

    if (resp.ok) {
      let ID = await resp.text();

      // store ID in cookie
      document.cookie = `id=${ID}`;

      register_status.innerHTML = ID;
    } else
      // on form error
      register_status.innerHTML = `${resp.status}`;
  };

  /* LOCATION */

  let lopen_button = document.getElementById("location-open-button");
  let lwrite_button = document.getElementById("location-write-button");
  let lclose_button = document.getElementById("location-close-button");
  let location_status = document.getElementById("location-status");

  // on connection opened
  let set_ws_open = () => {
    location_status.innerHTML = "Connected.";

    // on server message
    window.pacmacro_set_ws.addEventListener("message", (e) => {
      // show server message in status
      location_status.innerHTML = e.data;
    });

    let log_in = {
      coordinate: {
        latitude: 0,
        longitude: 0,
      },
      command: "password",
      data: admin_pass.value,
    };

    // send log-in information
    window.pacmacro_set_ws.send(JSON.stringify(log_in));

    // watch location and pass it along to the server
    watchLocation((p) => {
      let msg = {
        coordinate: {
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
        },
        command: "location",
        data: "",
      };

      window.pacmacro_set_ws.send(JSON.stringify(msg));
    });
  }; // set_ws_open

  // on connection closed
  let set_ws_close = () => {
    location_status.innerHTML = "Closed.";

    // stop watching location
    stopWatchLocation();

    if (window.pacmacro_set_ws !== undefined) {
      // close connection ourselves (on lclose_button.onclick())
      window.pacmacro_set_ws.close();
      window.pacmacro_set_ws = undefined;
    }
  }; // set_ws_close

  // on prompt to start map setting
  lopen_button.onclick = () => {
    if (window.pacmacro_set_ws !== undefined) return; // websocket is already opened

    location_status.innerHTML = "Connecting...";

    // try to open connection
    window.pacmacro_set_ws = new WebSocket(
      `${WS}://${URL_ROOT}/api/admin/set/${admin_id.value}`,
    );
    window.pacmacro_set_ws.onopen = set_ws_open;
    window.pacmacro_set_ws.onclose = set_ws_close;
  }; // location_button.onclick

  // on prompt to write collected location data to server
  lwrite_button.onclick = () => {
    if (window.pacmacro_set_ws === undefined) return; // there isn't an open connection

    let msg = {
      coordinate: {
        latitude: 0,
        longitude: 0,
      },
      command: "write",
      data: "",
    };

    // send command to write data
    window.pacmacro_set_ws.send(JSON.stringify(msg));
  }; // lwrite_button.onclick

  lclose_button.onclick = set_ws_close;

  /* POPULATE */

  let pgenerate_button = document.getElementById("populate-generate-button");
  let pdrawpath_button = document.getElementById("populate-draw-path-button");
  let pstopdraw_button = document.getElementById("populate-stop-draw-button");
  let psubmit_button = document.getElementById("populate-submit-button");
  let populate_status = document.getElementById("populate-status");
  let pacmacro_map = document.getElementById("pacmacro-map");

  // generate table for filling map data
  pgenerate_button.onclick = async () => {
    try {
      window.pacmacro_map = await fetch("/api/game/map.json");
    } catch {
      populate_status.innerHTML = "Error";
    }

    window.pacmacro_map = await window.pacmacro_map.json();
    console.log(window.pacmacro_map);

    window.pacmacro_ctx = pacmacro_map.getContext("2d");
    let ctx = window.pacmacro_ctx;

    ctx.canvas.width = window.pacmacro_map.width * EXPAND_X;
    ctx.canvas.height = window.pacmacro_map.height * EXPAND_Y;
    ctx.fillStyle = "silver";
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    let start_tile = 0,
      tile = 0;
    let n = window.pacmacro_map.width * window.pacmacro_map.height;

    // fill map with grid
    for (let i = 0; i < n; i++) {
      let x = i % window.pacmacro_map.width;
      let y = Math.floor(i / window.pacmacro_map.width);

      tile = tile == 1 ? 0 : 1;

      if (x == 0) {
        tile = start_tile;
        start_tile = start_tile == 1 ? 0 : 1;
      }

      let rendx = x * EXPAND_X;
      let rendy = y * EXPAND_Y;

      ctx.fillStyle = tile == 1 ? "gray" : "silver";
      ctx.fillRect(rendx, rendy, rendx + EXPAND_X, rendy + EXPAND_Y);
    }
  };

  pdrawpath_button.onclick = () => {
    watchLocation((p) => {
      let plot = convertCoords(
        window.pacmacro_map,
        p.coords.latitude,
        p.coords.longitude,
      );

      let ctx = window.pacmacro_ctx;
      let rendx = plot.x * EXPAND_X;
      let rendy = plot.y * EXPAND_Y;

      ctx.fillStyle = "black";
      ctx.fillRect(rendx, rendy, rendx + 1, rendy + 1);
    });
  };

  pstopdraw_button.onclick = () => {
    stopWatchLocation();
  };

  psubmit_button.onclick = async () => {
    // do nothing
  };
};
