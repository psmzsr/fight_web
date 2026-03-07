// 大厅页运行时状态。
const state = {
  // 当前 WebSocket 实例。
  ws: null,
  // 服务器返回的房间列表。
  rooms: [],
  // 当前显示名。
  name: "",
  // 重连定时器句柄，避免重复重连。
  reconnectTimer: null,
  // 房间搜索关键字。
  filter: "",
  // 跳转到对战页前临时缓存的私密房密码。
  pendingPassword: "",
};

// 常用 DOM 引用。
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

// 文案集中管理。
const TEXT = {
  connected: "\u5df2\u8fde\u63a5",
  reconnecting: "\u5df2\u65ad\u5f00\uff0c\u6b63\u5728\u91cd\u8fde...",
  joiningError: "\u64cd\u4f5c\u5931\u8d25",
  noRooms: "\u6682\u65e0\u623f\u95f4\uff0c\u8bf7\u5148\u521b\u5efa\u4e00\u4e2a\u3002",
  enterName: "\u8bf7\u8f93\u5165\u663e\u793a\u540d",
  privateNeedPwd: "\u79c1\u5bc6\u623f\u95f4\u9700\u8981\u5bc6\u7801",
  statusWaiting: "\u7b49\u5f85\u4e2d",
  statusCountdown: "\u5012\u8ba1\u65f6",
  statusPlaying: "\u5bf9\u6218\u4e2d",
  statusFinished: "\u5df2\u7ed3\u675f",
  privateBadge: "\u79c1\u5bc6",
  trainingBadge: "\u8bad\u7ec3",
  roomLabelStatus: "\u72b6\u6001",
  roomLabelPlayers: "\u73a9\u5bb6",
  roomLabelSpectators: "\u89c2\u6218",
  roomLabelId: "ID",
  joinBtn: "\u52a0\u5165",
  watchBtn: "\u89c2\u6218",
  trainingRoomSuffix: " \u8bad\u7ec3\u623f",
  roomSuffix: "\u7684\u623f\u95f4",
  promptPrivateRoom: "\u8be5\u623f\u95f4\u4e3a\u79c1\u5bc6\u623f\uff0c\u8bf7\u8f93\u5165\u5bc6\u7801\uff1a",
  fallbackCharacter: "\u9ed8\u8ba4",
  defaultPlayerPrefix: "\u73a9\u5bb6",
};

// 读取本地昵称；若不存在则自动生成。
function loadName() {
  const saved = localStorage.getItem("fight_name");
  if (saved) return saved;
  const fallback = `${TEXT.defaultPlayerPrefix}${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem("fight_name", fallback);
  return fallback;
}

// 更新连接状态徽章。
function setStatus(text, ok) {
  connStatus.textContent = text;
  connStatus.style.background = ok ? "rgba(78, 225, 153, 0.2)" : "rgba(255, 128, 128, 0.2)";
}

// 仅在 WebSocket 可用时发送消息。
function safeSend(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(payload));
}

// 获取当前选中的角色 ID。
function getSelectedCharacter() {
  return (characterSelect && characterSelect.value) || localStorage.getItem("fight_character") || "";
}

// 加载角色列表并写入下拉框。
async function loadCharacters() {
  if (!characterSelect) return;
  try {
    const response = await fetch("/data/characters.json");
    const data = await response.json();
    const list = Array.isArray(data.characters) ? data.characters : [];
    const selected = localStorage.getItem("fight_character") || data.defaultId || (list[0] && list[0].id) || "";
    characterSelect.innerHTML = list.map((c) => `<option value="${c.id}">${c.name || c.id}</option>`).join("");
    characterSelect.value = selected;
  } catch (err) {
    characterSelect.innerHTML = `<option value="">${TEXT.fallbackCharacter}</option>`;
  }
}

// 建立 WebSocket 连接并绑定事件。
function connect() {
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.addEventListener("open", () => {
    setStatus(TEXT.connected, true);
    safeSend({ type: "hello", name: state.name, characterId: getSelectedCharacter() });
    safeSend({ type: "list_rooms" });
  });

  ws.addEventListener("close", () => {
    setStatus(TEXT.reconnecting, false);
    // 防止重复创建重连定时器。
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
      return;
    }

    if (msg.type === "room_joined") {
      // 私密房加入成功后缓存密码，供 game 页面自动重连使用。
      if (state.pendingPassword && msg.roomId) {
        sessionStorage.setItem(`room_pwd_${msg.roomId}`, state.pendingPassword);
        state.pendingPassword = "";
      }
      const role = msg.role || "spectator";
      const mode = msg.mode || "pvp";
      const url = `/game.html?roomId=${encodeURIComponent(msg.roomId)}&role=${encodeURIComponent(
        role
      )}&mode=${encodeURIComponent(mode)}`;
      window.location.href = url;
      return;
    }

    if (msg.type === "error") {
      window.alert(msg.message || TEXT.joiningError);
    }
  });
}

// 按当前关键字渲染房间列表。
function renderRooms() {
  const keyword = state.filter.trim().toLowerCase();
  const filtered = keyword
    ? state.rooms.filter((room) => {
        return (room.name || "").toLowerCase().includes(keyword) || (room.id || "").toLowerCase().includes(keyword);
      })
    : state.rooms;

  if (!filtered.length) {
    roomsEl.innerHTML = `<div class="muted">${TEXT.noRooms}</div>`;
    return;
  }

  roomsEl.innerHTML = filtered
    .map((room) => {
      const status = room.status || "waiting";
      const statusMap = {
        waiting: TEXT.statusWaiting,
        countdown: TEXT.statusCountdown,
        playing: TEXT.statusPlaying,
        finished: TEXT.statusFinished,
      };
      const statusText = statusMap[status] || status;
      const privateBadge = room.isPrivate ? `<span class="badge">${TEXT.privateBadge}</span>` : "";
      const trainingBadge = room.mode === "training" ? `<span class="badge">${TEXT.trainingBadge}</span>` : "";
      // 训练房最多只允许 1 名人类玩家，第二人只能观战。
      const disabledJoin = room.mode === "training" && room.playerCount >= 1 ? "disabled" : "";
      return `
        <div class="room-card">
          <div>
            <strong>${room.name}</strong>
            ${privateBadge} ${trainingBadge}
            <div class="room-meta">
              <span>${TEXT.roomLabelStatus}：${statusText}</span>
              <span>${TEXT.roomLabelPlayers}：${room.playerCount}/2</span>
              <span>${TEXT.roomLabelSpectators}：${room.spectatorCount}</span>
              <span>${TEXT.roomLabelId}：${room.id}</span>
            </div>
          </div>
          <div class="room-actions">
            <button class="btn join-btn" data-room-id="${room.id}" data-private="${room.isPrivate ? "1" : "0"}" ${disabledJoin}>${TEXT.joinBtn}</button>
            <button class="btn watch-btn" data-room-id="${room.id}" data-private="${room.isPrivate ? "1" : "0"}">${TEXT.watchBtn}</button>
          </div>
        </div>
      `;
    })
    .join("");
}

// 私密房加入前输入密码。
function resolvePassword(isPrivate) {
  if (!isPrivate) return "";
  const pwd = window.prompt(TEXT.promptPrivateRoom, "") || "";
  return pwd.trim();
}

// 房间列表点击委托：加入或观战。
roomsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const roomId = target.dataset.roomId || "";
  const isPrivate = target.dataset.private === "1";
  if (!roomId) return;

  const password = resolvePassword(isPrivate);
  // 私密房取消输入密码时不发送加入请求。
  if (isPrivate && !password) return;
  state.pendingPassword = password;

  if (target.classList.contains("watch-btn")) {
    safeSend({
      type: "join_room",
      roomId,
      asSpectator: true,
      password,
      characterId: getSelectedCharacter(),
    });
    return;
  }

  if (target.classList.contains("join-btn")) {
    safeSend({
      type: "join_room",
      roomId,
      asSpectator: false,
      password,
      characterId: getSelectedCharacter(),
    });
  }
});

// 保存昵称并通知服务端。
saveNameBtn.addEventListener("click", () => {
  const name = (displayNameInput.value || "").trim().slice(0, 16);
  if (!name) {
    window.alert(TEXT.enterName);
    return;
  }
  state.name = name;
  localStorage.setItem("fight_name", name);
  safeSend({ type: "hello", name, characterId: getSelectedCharacter() });
});

// 创建普通对战房（可公开/私密）。
createRoomBtn.addEventListener("click", () => {
  const roomName = (roomNameInput.value || "").trim() || `${state.name}${TEXT.roomSuffix}`;
  const isPrivate = !!privateToggle.checked;
  const password = (roomPasswordInput.value || "").trim();
  // 私密房必须填写密码。
  if (isPrivate && !password) {
    window.alert(TEXT.privateNeedPwd);
    return;
  }
  state.pendingPassword = isPrivate ? password : "";
  safeSend({
    type: "create_room",
    name: roomName,
    isPrivate,
    password,
    characterId: getSelectedCharacter(),
  });
});

// 创建训练房（木桩/基础 AI）。
trainRoomBtn.addEventListener("click", () => {
  const roomName = (roomNameInput.value || "").trim() || `${state.name}${TEXT.trainingRoomSuffix}`;
  const aiMode = dummyToggle.checked ? "dummy" : "basic";
  safeSend({
    type: "create_training_room",
    name: roomName,
    aiMode,
    characterId: getSelectedCharacter(),
  });
});

// 房间筛选。
roomSearchInput.addEventListener("input", () => {
  state.filter = roomSearchInput.value || "";
  renderRooms();
});

// 私密房开关控制密码输入框。
privateToggle.addEventListener("change", () => {
  roomPasswordInput.disabled = !privateToggle.checked;
  if (!privateToggle.checked) roomPasswordInput.value = "";
});

// 保存角色选择并同步给服务端。
characterSelect.addEventListener("change", () => {
  localStorage.setItem("fight_character", characterSelect.value || "");
  safeSend({ type: "hello", name: state.name, characterId: getSelectedCharacter() });
});

// 页面初始化。
state.name = loadName();
displayNameInput.value = state.name;
roomPasswordInput.disabled = !privateToggle.checked;
setStatus("\u8fde\u63a5\u4e2d...", false);
loadCharacters().finally(connect);
