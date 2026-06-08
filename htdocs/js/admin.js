// admin.js
// for admin.html

import { NTYPE, NREPS, type, reps } from "./pacmacro.js";

window.onload = () => {
  let stat = document.getElementById("status");
  let load = document.getElementById("load");
  let list = document.getElementById("list");

  stat.innerHTML = "--"; // no status

  document.getElementById("all_edible").onclick = async () => {
    let players;
    try {
      players = await fetch("/api/player/list.json");
      if (!players.ok) {
        throw "Response not OK.";
      }

      players = await players.json();
    } catch {
      list.innerHTML = `
				<p>There was a problem contacting the API.</p>
			`;
      return;
    }

    let id = document.getElementById("id");
    let pass = document.getElementById("pass");

    for (const p of players) {
      if (p.reps != 3 || p.type == 2) continue;

      let form = new FormData();

      form.append("id", id.value);
      form.append("pass", pass.value);
      form.append("type", p.type);
      form.append("reps", 4); // 4 is RepsEdible

      try {
        let resp = await fetch(`/api/admin/update/${p.id}`, {
          method: "POST",
          body: form,
        });
        if (resp.ok) {
          stat.innerHTML = `Success ${p.id}`;
        }
      } catch {}
    }
    list.innerHTML = "Please load players again.";
  };

  document.getElementById("all_nothing").onclick = async () => {
    let players;
    try {
      players = await fetch("/api/player/list.json");
      if (!players.ok) {
        throw "Response not OK.";
      }

      players = await players.json();
    } catch {
      list.innerHTML = `
				<p>There was a problem contacting the API.</p>
			`;
      return;
    }

    let id = document.getElementById("id");
    let pass = document.getElementById("pass");

    for (const p of players) {
      // don't change admin
      if (p.type == 2) continue;

      let form = new FormData();

      form.append("id", id.value);
      form.append("pass", pass.value);
      form.append("type", p.type);
      form.append("reps", 0); // 0 is RepsNothing

      try {
        let resp = await fetch(`/api/admin/update/${p.id}`, {
          method: "POST",
          body: form,
        });
        if (resp.ok) {
          stat.innerHTML = `Success ${p.id}`;
        }
      } catch {}
    }
    list.innerHTML = "Please load players again.";
  };

  load.onclick = async () => {
    list.innerHTML = ""; // clear list

    let players;
    try {
      players = await fetch("/api/player/list.json");
      if (!players.ok) {
        throw "Response not OK.";
      }

      players = await players.json();
    } catch {
      list.innerHTML = `
				<p>There was a problem contacting the API.</p>
			`;
      return;
    }
    // players is a list of all online players

    for (let i = 0; i < players.length; i++) {
      const p = players[i];

      let types = "";
      for (let j = 0; j < NTYPE; j++) {
        types += `<option value=${j}
					${p.type == j ? "selected" : ""}>
					${type(j)}
				</option>`;
      }

      let reps_ = "";
      for (let j = 0; j < NREPS; j++) {
        reps_ += `<option value=${j}
					${p.reps == j ? "selected" : ""}>
					${reps(j)}
				</option>`;
      }

      let player = document.createElement("div");
      player.classList.add("player");

      if (p.type == 3)
        // TypeHidden
        player.classList.add("hidden");

      player.innerHTML = `
				<h1>${p.name} (${p.id})</h1>
				<select id="type${i}">${types}</select>
				<select id="reps${i}">${reps_}</select>
			`;

      let submit = document.createElement("button");
      submit.onclick = eval(`
				async () => {
					let id    = document.getElementById("id");
					let pass  = document.getElementById("pass");
					let stat  = document.getElementById("status");
					let _type = document.getElementById("type${i}");
					let _reps = document.getElementById("reps${i}");

					let form = new FormData();

					form.append("id",   id.value);
					form.append("pass", pass.value);
					form.append("type", _type.value);
					form.append("reps", _reps.value);

					try {
						let resp = await fetch("/api/admin/update/${p.id}", {
							method: "POST",
							body: form
						});
						if (!resp.ok) {
							stat.innerHTML = "Response not OK.";
						} else {
							stat.innerHTML = "Success.";
							setTimeout(() => {
								stat.innerHTML = "--";
							}, 2000); // after two seconds, update status
						}
					} catch {
						stat.innerHTML = "Error: couldn't contact API.";
					}
				}
			`);
      submit.innerHTML = `Update ${p.id}`;

      player.appendChild(submit);
      list.appendChild(player);
    }
  };
};
