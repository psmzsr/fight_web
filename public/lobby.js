const state = {
  ws: null,
  rooms: [],
  name: "",
  reconnectTimer: null,
  filter: "",
  pendingPassword: "",
};

const connStatus = document.getElementById("connStatus");
const displayNameInput = document.getElementById("displayName");
const roomNameInput = document.getElementById("roomName");
const privateToggle = document.getElementById("privateToggle");
const roomPasswordInput = document.getElementById("roomPassword");
const roomSearchInput = document.getElementById("roomSearch");
const characterSelect = document.getElementById("characterSelect");
const trainRoomBtn = document.getElementById("trainRoom");
const dummyToggle = document.getElementById("dummyToggle");
const saveNameBtn = document.getElementById("saveName");
const createRoomBtn = document.getElementById("createRoom");
const roomsEl = document.getElementById("rooms");

function loadName() {
  const saved = localStorage.getItem("fight_name");
  if (saved) return saved;
  const fallback = `Player${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem("fight_name", fallback);
  return fallback;
}

function setStatus(text, ok) {
  connStatus.textContent = text;
  connStatus.style.background = ok ? "rgba(78, 225, 153, 0.2)" : "rgba(255, 128, 128, 0.2)";
}

function connect() {
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.addEventListener("open", () => {
    setStatus("已连接", true);
    ws.send(JSON.stringify({ type: "hello", name: state.name, characterId: characterSelect?.value || "" }));
    ws.send(JSON.stringify({ type: "list_rooms" }));
  });

  ws.addEventListener("close", () => {
    setStatus("已断开，正在重连...", false);
    if (!state.reconnectTimer) {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        connect();
      }, 2000);
    }
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "room_list") {
      state.rooms = msg.rooms || [];
      renderRooms();
    }
    if (msg.type === "room_joined") {
      if (state.pendingPassword && msg.roomId) {
        sessionStorage.setItem(`room_pwd_${msg.roomId}`, state.pendingPassword);
        state.pendingPassword = "";
      }
      const role = msg.role || "spectator";
      const mode = msg.mode || "pvp";
      const url = `/game.html?roomId=${encodeURIComponent(msg.roomId)}&role=${encodeURIComponent(role)}&mode=${encodeURIComponent(mode)}`;
      window.location.href = url;
    }
    if (msg.type === "error") {
      window.alert(msg.message || "操作失败");
    }
  });
}

function renderRooms() {
  const filtered = state.filter
    ? state.rooms.filter((room) => {
        const keyword = state.filter.toLowerCase();
        return (
          (room.name || "").toLowerCase().includes(keyword) ||
          (room.id || "").toLowerCase().includes(keyword)
        );
      })
    : state.rooms;

  if (!filtered.length) {
    roomsEl.innerHTML = `<div class="muted">暂无房间，请先创建一个。</div>`;
    return;
  }
  roomsEl.innerHTML = filtered
    .map((room) => {
      const status = room.status || "waiting";
      const statusMap = {
        waiting: "等待中",
        countdown: "倒计时",
        playing: "对战中",
        finished: "已结束",
      };
      const statusText = statusMap[status] || status;
      const privateBadge = room.isPrivate ? `<span class="badge">私密</span>` : "";
      const trainingBadge = room.mode === "training" ? `<span class="badge">训练</span>` : "";
      return `
      <div class="room-card">
        <div>
          <strong>${room.name}</strong>
          ${privateBadge} ${trainingBadge}
          <div class="room-meta">
            <span>状态：${statusText}</span>
            <span>玩家：${room.playerCount}/2</span>
            <span>观战：${room.spectatorCount}</span>
          </div>
        </div>
        <div class="room-actions">
          <button class="btn" data-action="join" data-id="${room.id}" data-private="${room.isPrivate ? "1" : "0"}">加入</button>
          <button class="btn" data-action="spectate" data-id="${room.id}" data-private="${room.isPrivate ? "1" : "0"}">观战</button>
        </div>
      </div>`;
    })
    .join("");
}

roomsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset.action;
  const roomId = target.dataset.id;
  const isPrivate = target.dataset.private === "1";
  if (!action || !roomId || !state.ws) return;
  if (action === "join") {
    let password = "";
    if (isPrivate) {
      password = window.prompt("请输入房间密码") || "";
    }
    if (isPrivate && password) {
      sessionStorage.setItem(`room_pwd_${roomId}`, password);
    }
    state.ws.send(
      JSON.stringify({
        type: "join_room",
        roomId,
        password,
        characterId: characterSelect?.value || "",
      })
    );
  } else if (action === "spectate") {
    let password = "";
    if (isPrivate) {
      password = window.prompt("请输入房间密码") || "";
    }
    if (isPrivate && password) {
      sessionStorage.setItem(`room_pwd_${roomId}`, password);
    }
    state.ws.send(
      JSON.stringify({
        type: "join_room",
        roomId,
        asSpectator: true,
        password,
        characterId: characterSelect?.value || "",
      })
    );
  }
});

saveNameBtn.addEventListener("click", () => {
  const next = displayNameInput.value.trim();
  if (!next) return;
  state.name = next.slice(0, 16);
  localStorage.setItem("fight_name", state.name);
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "hello", name: state.name }));
  }
});

createRoomBtn.addEventListener("click", () => {
  if (!state.ws) return;
  const name = roomNameInput.value.trim();
  const isPrivate = !!privateToggle.checked;
  const password = roomPasswordInput.value.trim();
  if (isPrivate && !password) {
    window.alert("私密房间需要填写密码");
    return;
  }
  if (characterSelect?.value) {
    localStorage.setItem("fight_character", characterSelect.value);
  }
  state.pendingPassword = isPrivate ? password : "";
  state.ws.send(
    JSON.stringify({
      type: "create_room",
      name,
      isPrivate,
      password,
      characterId: characterSelect?.value || "",
    })
  );
});

state.name = loadName();
displayNameInput.value = state.name;
setStatus("连接中...", false);
connect();

privateToggle.addEventListener("change", () => {
  const enabled = privateToggle.checked;
  roomPasswordInput.disabled = !enabled;
  if (!enabled) roomPasswordInput.value = "";
});

roomSearchInput.addEventListener("input", () => {
  state.filter = roomSearchInput.value.trim();
  renderRooms();
});

characterSelect.addEventListener("change", () => {
  if (characterSelect?.value) {
    localStorage.setItem("fight_character", characterSelect.value);
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "hello", name: state.name, characterId: characterSelect.value }));
  }
});

trainRoomBtn.addEventListener("click", () => {
  if (!state.ws) return;
  const name = roomNameInput.value.trim() || "训练房间";
  if (characterSelect?.value) {
    localStorage.setItem("fight_character", characterSelect.value);
  }
  const aiMode = dummyToggle?.checked ? "dummy" : "basic";
  state.ws.send(
    JSON.stringify({
      type: "create_training_room",
      name,
      characterId: characterSelect?.value || "",
      aiMode,
    })
  );
});

async function loadCharacters() {
  try {
    const res = await fetch("/data/characters.json");
    const data = await res.json();
    const list = data.characters || [];
    characterSelect.innerHTML = list
      .map((c) => `<option value="${c.id}">${c.name || c.id}</option>`)
      .join("");
    const saved = localStorage.getItem("fight_character");
    if (saved && list.find((c) => c.id === saved)) {
      characterSelect.value = saved;
    } else if (data.defaultId) {
      characterSelect.value = data.defaultId;
    }
  } catch (err) {
    characterSelect.innerHTML = `<option value="">默认</option>`;
  }
}

loadCharacters();

setInterval(() => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "list_rooms" }));
  }
}, 2000);
