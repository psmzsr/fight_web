const path = require("path");
const http = require("http");
const fs = require("fs");
const express = require("express");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const clientsById = new Map();
const clientsBySocket = new Map();

const TICK_MS = 33;
const ROOM_EMPTY_TTL_MS = 60 * 1000;

const ATTACKS = {
  punch: {
    damage: 6,
    range: 70,
    activeStart: 0.04,
    activeEnd: 0.12,
    duration: 0.22,
    cooldown: 0.28,
    hitstun: 0.18,
    blockstun: 0.12,
    knockback: 140,
    driveDamage: 10,
    cancelStart: 0.06,
    cancelEnd: 0.12,
  },
  kick: {
    damage: 9,
    range: 95,
    activeStart: 0.05,
    activeEnd: 0.16,
    duration: 0.28,
    cooldown: 0.38,
    hitstun: 0.22,
    blockstun: 0.16,
    knockback: 220,
    driveDamage: 16,
    cancelStart: 0.1,
    cancelEnd: 0.16,
  },
  impact: {
    damage: 14,
    range: 90,
    activeStart: 0.12,
    activeEnd: 0.26,
    duration: 0.5,
    cooldown: 0.75,
    hitstun: 0.38,
    blockstun: 0.26,
    knockback: 320,
    driveDamage: 35,
    cancelStart: null,
    cancelEnd: null,
  },
  rekka1: {
    damage: 5,
    range: 70,
    activeStart: 0.04,
    activeEnd: 0.12,
    duration: 0.22,
    cooldown: 0.24,
    hitstun: 0.16,
    blockstun: 0.1,
    knockback: 120,
    driveDamage: 10,
    cancelStart: 0.06,
    cancelEnd: 0.16,
  },
  rekka2: {
    damage: 6,
    range: 75,
    activeStart: 0.05,
    activeEnd: 0.14,
    duration: 0.24,
    cooldown: 0.24,
    hitstun: 0.18,
    blockstun: 0.12,
    knockback: 150,
    driveDamage: 12,
    cancelStart: 0.06,
    cancelEnd: 0.16,
  },
  rekka3: {
    damage: 7,
    range: 85,
    activeStart: 0.06,
    activeEnd: 0.16,
    duration: 0.28,
    cooldown: 0.35,
    hitstun: 0.24,
    blockstun: 0.16,
    knockback: 220,
    driveDamage: 16,
    cancelStart: null,
    cancelEnd: null,
  },
  bakkai: {
    damage: 10,
    range: 110,
    activeStart: 0.08,
    activeEnd: 0.22,
    duration: 0.4,
    cooldown: 0.6,
    hitstun: 0.26,
    blockstun: 0.2,
    knockback: 240,
    driveDamage: 22,
    cancelStart: null,
    cancelEnd: null,
  },
  divekick: {
    damage: 8,
    range: 70,
    activeStart: 0.02,
    activeEnd: 0.12,
    duration: 0.2,
    cooldown: 0.3,
    hitstun: 0.2,
    blockstun: 0.14,
    knockback: 160,
    driveDamage: 12,
    cancelStart: null,
    cancelEnd: null,
  },
};

const CHAR_PATH = path.join(__dirname, "..", "public", "data", "characters.json");
const DEFAULT_CHAR = {
  id: "default",
  name: "默认",
  color: "#2d6bff",
  stats: { maxHp: 100, speed: 300, jump: -850, gravity: 2000, friction: 0.82 },
};

function loadCharacters() {
  try {
    const raw = fs.readFileSync(CHAR_PATH, "utf8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.characters) && data.characters.length) return data;
  } catch (err) {
    // ignore and fallback
  }
  return { defaultId: DEFAULT_CHAR.id, characters: [DEFAULT_CHAR] };
}

let CHARACTER_DATA = loadCharacters();

function getCharacter(charId) {
  const list = CHARACTER_DATA.characters || [];
  if (!list.length) return DEFAULT_CHAR;
  if (charId) {
    const found = list.find((c) => c.id === charId);
    if (found) return found;
  }
  const defId = CHARACTER_DATA.defaultId;
  return list.find((c) => c.id === defId) || list[0] || DEFAULT_CHAR;
}

function applyCharacter(player, character) {
  const char = character || DEFAULT_CHAR;
  const stats = char.stats || {};
  player.characterId = char.id;
  player.characterName = char.name || char.id;
  player.color = char.color || player.color;
  player.maxHp = typeof stats.maxHp === "number" ? stats.maxHp : 100;
  player.baseStats = {
    speed: typeof stats.speed === "number" ? stats.speed : 300,
    jump: typeof stats.jump === "number" ? stats.jump : -850,
    gravity: typeof stats.gravity === "number" ? stats.gravity : 2000,
    friction: typeof stats.friction === "number" ? stats.friction : 0.82,
  };
  player.stats = { ...player.baseStats };
  if (player.hp > player.maxHp) player.hp = player.maxHp;
}

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function shortId() {
  return randomUUID().slice(0, 6);
}

function defaultInput() {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    punch: false,
    kick: false,
    punchStrength: "",
    kickStrength: "",
    parry: false,
    impact: false,
    rush: false,
    special1: false,
    special2: false,
    special3: false,
    special4: false,
  };
}

function normalizeStrength(value) {
  if (value === "l" || value === "m" || value === "h") return value;
  return "m";
}

function getInput(room, clientId) {
  const lastAt = room.lastInputAt.get(clientId) || 0;
  if (Date.now() - lastAt > 800) {
    const neutral = defaultInput();
    room.inputs.set(clientId, neutral);
    return neutral;
  }
  return room.inputs.get(clientId) || defaultInput();
}

function createPlayer(slot) {
  const base = {
    slot,
    clientId: null,
    name: slot === 0 ? "P1" : "P2",
    x: 0,
    y: 0,
    w: 60,
    h: 110,
    vx: 0,
    vy: 0,
    hp: 100,
    facing: slot === 0 ? 1 : -1,
    onGround: true,
    attack: null,
    attackCooldown: 0,
    hitstun: 0,
    blockstun: 0,
    drive: 100,
    burnout: false,
    dashTime: 0,
    dashSpeed: 0,
    drinkLevel: 0,
    drinkCooldown: 0,
    downTime: 0,
    action: null,
    actionTimer: 0,
    comboCount: 0,
    comboTimer: 0,
    color: slot === 0 ? "#2d6bff" : "#ff4d4d",
  };
  applyCharacter(base, getCharacter());
  base.hp = base.maxHp;
  return base;
}

function createInitialState() {
  return {
    width: 960,
    height: 540,
    groundY: 420,
    timer: 99,
    message: "",
    winnerId: null,
    countdown: null,
    players: [createPlayer(0), createPlayer(1)],
  };
}

function resetRoomState(room) {
  room.state = createInitialState();
  room.players.forEach((clientId, slot) => {
    if (!clientId) return;
    if (room.ai && room.ai.id === clientId) {
      assignPlayerToSlot(room, clientId, slot, { name: room.ai.name, characterId: room.ai.characterId });
      return;
    }
    assignPlayerToSlot(room, clientId, slot);
  });
}

function createRoom(name, options = {}) {
  const id = shortId();
  const isPrivate = !!options.isPrivate;
  const password = isPrivate ? String(options.password || "").slice(0, 16) : "";
  const room = {
    id,
    name: name && name.trim() ? name.trim() : `房间 ${id}`,
    players: [null, null],
    spectators: new Set(),
    status: "waiting",
    countdown: 3,
    lastTick: Date.now(),
    inputs: new Map(),
    inputSeq: new Map(),
    lastInputAt: new Map(),
    state: createInitialState(),
    emptySince: null,
    isPrivate,
    password,
    serverTimeMs: 0,
    mode: options.mode || "pvp",
    ai: null,
    aiMode: options.aiMode || "basic",
  };
  rooms.set(id, room);
  return room;
}

function assignPlayerToSlot(room, clientId, slot, options = {}) {
  const client = clientsById.get(clientId);
  const player = room.state.players[slot];
  if (!player) return;

  const spawnX = slot === 0 ? 220 : 740;
  player.clientId = clientId;
  const character = getCharacter(options.characterId || client?.characterId);
  applyCharacter(player, character);
  player.name = options.name || client?.name || player.characterName || `P${slot + 1}`;
  player.x = spawnX - player.w / 2;
  player.y = room.state.groundY - player.h;
  player.vx = 0;
  player.vy = 0;
  player.hp = player.maxHp || 100;
  player.facing = slot === 0 ? 1 : -1;
  player.onGround = true;
  player.attack = null;
  player.attackCooldown = 0;
  player.hitstun = 0;
  player.blockstun = 0;
  player.drive = 100;
  player.burnout = false;
  player.dashTime = 0;
  player.dashSpeed = 0;
  player.drinkLevel = 0;
  player.drinkCooldown = 0;
  player.downTime = 0;
  player.action = null;
  player.actionTimer = 0;
  player.comboCount = 0;
  player.comboTimer = 0;
}

function addPlayerToRoom(client, room, preferredSlot, characterId) {
  let slot = -1;
  if (preferredSlot === 0 || preferredSlot === 1) {
    if (!room.players[preferredSlot]) slot = preferredSlot;
  }
  if (slot === -1) {
    slot = room.players.findIndex((p) => !p);
  }
  if (slot === -1) return null;

  room.players[slot] = client.id;
  room.emptySince = null;
  client.roomId = room.id;
  client.role = "player";
  if (characterId) client.characterId = characterId;
  room.inputs.set(client.id, defaultInput());
  room.inputSeq.set(client.id, 0);
  room.lastInputAt.set(client.id, Date.now());
  assignPlayerToSlot(room, client.id, slot);
  return slot;
}

function addSpectatorToRoom(client, room) {
  room.spectators.add(client.id);
  room.emptySince = null;
  client.roomId = room.id;
  client.role = "spectator";
}

function isHumanId(room, id) {
  if (!id) return false;
  if (room.ai && id === room.ai.id) return false;
  return true;
}

function getHumanCount(room) {
  return room.players.filter((id) => isHumanId(room, id)).length;
}

function getHumanIds(room) {
  return room.players.filter((id) => isHumanId(room, id));
}

function removePlayerId(room, playerId) {
  const slot = room.players.indexOf(playerId);
  if (slot !== -1) room.players[slot] = null;
  room.inputs.delete(playerId);
  room.inputSeq.delete(playerId);
  room.lastInputAt.delete(playerId);
}

function isHumanActive(room, playerId) {
  const client = clientsById.get(playerId);
  if (!client) return false;
  const lastAt = room.lastInputAt.get(playerId) || 0;
  return Date.now() - lastAt < 1500;
}

function removeClientFromRoom(client, room) {
  if (!room) return;
  if (client.role === "player") {
    const slot = room.players.indexOf(client.id);
    if (slot !== -1) room.players[slot] = null;
    room.inputs.delete(client.id);
    room.inputSeq.delete(client.id);
    room.lastInputAt.delete(client.id);
    if (room.status === "playing" || room.status === "countdown") {
      finishMatch(room, room.players.find((id) => id), "对手离开");
    }
  } else if (client.role === "spectator") {
    room.spectators.delete(client.id);
  }

  client.roomId = null;
  client.role = null;

  const humanCount = getHumanCount(room);
  if (room.mode === "training" && humanCount === 0) {
    room.status = "waiting";
    room.emptySince = Date.now();
    resetRoomState(room);
    broadcastRoomList();
    return;
  }

  if (humanCount === 0 && room.spectators.size === 0) {
    room.emptySince = Date.now();
    room.status = "waiting";
    room.state = createInitialState();
    broadcastRoomList();
  }
}

function roomSummary(room) {
  const playerCount = getHumanCount(room);
  return {
    id: room.id,
    name: room.name,
    status: room.status,
    playerCount,
    spectatorCount: room.spectators.size,
    isPrivate: room.isPrivate,
    mode: room.mode || "pvp",
  };
}

function broadcastRoomList() {
  const roomsList = Array.from(rooms.values()).map(roomSummary);
  wss.clients.forEach((ws) => safeSend(ws, { type: "room_list", rooms: roomsList }));
}

function broadcastToRoom(room, payload) {
  const ids = room.players.filter(Boolean).concat(Array.from(room.spectators));
  ids.forEach((id) => {
    const client = clientsById.get(id);
    if (client) safeSend(client.ws, payload);
  });
}

function addAIToRoom(room, options = {}) {
  const aiId = `ai-${room.id}`;
  room.ai = {
    id: aiId,
    slot: options.slot ?? 1,
    name: options.name || "训练机器人",
    characterId: options.characterId || getCharacter().id,
    mode: options.mode || "basic",
    think: 0,
    mood: 0,
  };
  room.players[room.ai.slot] = aiId;
  room.inputs.set(aiId, defaultInput());
  room.inputSeq.set(aiId, 0);
  room.lastInputAt.set(aiId, Date.now());
  assignPlayerToSlot(room, aiId, room.ai.slot, { name: room.ai.name, characterId: room.ai.characterId });
}

function updateAI(room, dt) {
  if (!room.ai) return;
  const ai = room.ai;
  if (ai.mode === "dummy") {
    const input = room.inputs.get(ai.id) || defaultInput();
    input.left = false;
    input.right = false;
    input.up = false;
    input.down = false;
    input.parry = false;
    input.impact = false;
    input.rush = false;
    input.punch = false;
    input.kick = false;
    room.inputs.set(ai.id, input);
    room.lastInputAt.set(ai.id, Date.now());
    return;
  }
  const aiPlayer = room.state.players[ai.slot];
  const target = room.state.players[ai.slot === 0 ? 1 : 0];
  if (!aiPlayer || !target) return;
  const input = room.inputs.get(ai.id) || defaultInput();
  const dx = target.x - aiPlayer.x;
  const dist = Math.abs(dx);

  input.left = dx < -40;
  input.right = dx > 40;
  input.up = false;
  input.parry = false;
  input.impact = false;
  input.rush = false;
  input.punch = false;
  input.kick = false;

  ai.think += dt;
  if (ai.think > 0.2) {
    ai.think = 0;
    const roll = Math.random();
    if (dist < 140 && roll < 0.4) {
      input.punch = true;
    } else if (dist < 160 && roll < 0.55) {
      input.kick = true;
    }
    if (dist > 220 && roll > 0.9 && aiPlayer.drive >= 20) {
      input.rush = true;
    }
  }

  room.inputs.set(ai.id, input);
  room.lastInputAt.set(ai.id, Date.now());
  room.inputSeq.set(ai.id, (room.inputSeq.get(ai.id) || 0) + 1);
}

function statePayload(room) {
  return {
    type: "state",
    state: room.state,
    status: room.status,
    roomId: room.id,
    serverTimeMs: Math.round(room.serverTimeMs),
  };
}

function startCountdown(room) {
  room.status = "countdown";
  room.countdown = 3;
  room.state.message = "准备";
  room.state.countdown = room.countdown;
  room.lastTick = Date.now();
  resetRoomState(room);
}

function finishMatch(room, winnerId, reason) {
  room.status = "finished";
  room.state.winnerId = winnerId || null;
  room.state.message = reason || "对战结束";
  room.state.countdown = null;
  broadcastToRoom(room, statePayload(room));
  broadcastToRoom(room, {
    type: "finished",
    winnerId: room.state.winnerId,
    reason: room.state.message,
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rectsIntersect(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function resolvePlayerOverlap(p1, p2, arena) {
  if (!p1 || !p2) return;
  const overlapX = Math.min(p1.x + p1.w, p2.x + p2.w) - Math.max(p1.x, p2.x);
  const overlapY = Math.min(p1.y + p1.h, p2.y + p2.h) - Math.max(p1.y, p2.y);
  if (overlapX > 0 && overlapY > 0) {
    const push = overlapX / 2 + 0.01;
    if (p1.x < p2.x) {
      p1.x -= push;
      p2.x += push;
    } else {
      p1.x += push;
      p2.x -= push;
    }
    p1.x = clamp(p1.x, 40, arena.width - 40 - p1.w);
    p2.x = clamp(p2.x, 40, arena.width - 40 - p2.w);
    if (Math.sign(p1.vx) === Math.sign(p2.vx)) {
      p1.vx *= 0.5;
      p2.vx *= 0.5;
    }
  }
}

function isBackInput(defender, input) {
  if (!input) return false;
  return defender.facing === 1 ? !!input.left : !!input.right;
}

function getDamageScale(attacker) {
  if (attacker.characterId === "jamie") {
    const level = attacker.drinkLevel || 0;
    return 1 + level * 0.04;
  }
  return 1;
}

function updateJamieStats(player) {
  if (player.characterId !== "jamie") return;
  const level = player.drinkLevel || 0;
  const scale = 1 + level * 0.04;
  const jumpScale = 1 + level * 0.02;
  player.stats = {
    speed: (player.baseStats?.speed || 300) * scale,
    jump: (player.baseStats?.jump || -850) * jumpScale,
    gravity: player.baseStats?.gravity || 2000,
    friction: player.baseStats?.friction || 0.82,
  };
}

function canDrink(player) {
  return player.characterId === "jamie" && player.drinkCooldown <= 0 && player.drinkLevel < 4;
}

function drinkUp(player) {
  player.drinkLevel = Math.min(4, (player.drinkLevel || 0) + 1);
  player.drinkCooldown = 0.7;
  player.action = "drink";
  player.actionTimer = 0.6;
}

function startAttack(player, type, strength) {
  const cfg = ATTACKS[type];
  if (!cfg) return false;
  player.attack = {
    type,
    t: 0,
    activeStart: cfg.activeStart,
    activeEnd: cfg.activeEnd,
    duration: cfg.duration,
    cancelStart: cfg.cancelStart,
    cancelEnd: cfg.cancelEnd,
    didHit: false,
    strength: normalizeStrength(strength),
  };
  player.attackCooldown = cfg.cooldown;
  return true;
}

function registerCombo(attacker) {
  if (attacker.comboTimer > 0) attacker.comboCount += 1;
  else attacker.comboCount = 1;
  attacker.comboTimer = 0.8;
}

function processAttack(attacker, defender, defenderInput) {
  if (!attacker.attack) return;
  const attack = attacker.attack;
  const now = attack.t;
  if (attack.didHit) return;
  if (now < attack.activeStart || now > attack.activeEnd) return;

  const cfg = ATTACKS[attack.type];
  const range = cfg.range;
  const box = {
    x: attacker.facing === 1 ? attacker.x + attacker.w : attacker.x - range,
    y: attacker.y + 20,
    w: range,
    h: attacker.h - 40,
  };
  const target = {
    x: defender.x,
    y: defender.y,
    w: defender.w,
    h: defender.h,
  };

  if (rectsIntersect(box, target)) {
    attack.didHit = true;
    const canParry =
      !!defenderInput?.parry &&
      defender.onGround &&
      defender.hitstun <= 0 &&
      defender.blockstun <= 0 &&
      defender.drive > 0;
    const canBlock =
      isBackInput(defender, defenderInput) &&
      defender.onGround &&
      defender.hitstun <= 0 &&
      defender.blockstun <= 0;

    if (canParry && !defender.burnout) {
      defender.drive = Math.max(0, defender.drive - 8);
      defender.blockstun = 0.06;
      if (defender.drive <= 0) defender.burnout = true;
      return;
    }

    if (canBlock) {
      if (defender.burnout || defender.drive <= 0) {
        const chip = Math.max(1, Math.floor(cfg.damage * 0.35));
        defender.hp = Math.max(0, defender.hp - chip);
        defender.blockstun = cfg.blockstun + 0.12;
        defender.vx += cfg.knockback * 0.25 * attacker.facing;
        return;
      }

      defender.drive = Math.max(0, defender.drive - cfg.driveDamage);
      const guardBroken = defender.drive <= 0;
      if (guardBroken) {
        defender.burnout = true;
        const damage = Math.round(cfg.damage * getDamageScale(attacker));
        defender.hp = Math.max(0, defender.hp - damage);
        defender.hitstun = cfg.hitstun + 0.1;
        defender.vx += cfg.knockback * attacker.facing;
        defender.vy = -140;
        registerCombo(attacker);
      } else {
        const damage = Math.round(cfg.damage * getDamageScale(attacker));
        const chip = Math.max(1, Math.floor(damage * 0.2));
        defender.hp = Math.max(0, defender.hp - chip);
        defender.blockstun = cfg.blockstun;
        defender.vx += cfg.knockback * 0.2 * attacker.facing;
      }
      return;
    }

    const damage = Math.round(cfg.damage * getDamageScale(attacker));
    defender.hp = Math.max(0, defender.hp - damage);
    defender.hitstun = cfg.hitstun;
    defender.vx += cfg.knockback * attacker.facing;
    defender.vy = -160;
    registerCombo(attacker);
  }
}

function updatePlayer(player, input, dt, arena) {
  const SPEED = player.stats?.speed ?? 300;
  const JUMP = player.stats?.jump ?? -850;
  const GRAVITY = player.stats?.gravity ?? 2000;
  const FRICTION = player.stats?.friction ?? 0.82;

  const stunned = player.hitstun > 0 || player.blockstun > 0;
  if (player.hitstun > 0) player.hitstun = Math.max(0, player.hitstun - dt);
  if (player.blockstun > 0) player.blockstun = Math.max(0, player.blockstun - dt);
  if (player.hitstun > 0) {
    player.dashTime = 0;
  }

  if (!stunned) {
    if (player.dashTime > 0) {
      player.dashTime = Math.max(0, player.dashTime - dt);
      player.vx = player.dashSpeed * player.facing;
    } else if (input.left && !input.right) {
      player.vx = -SPEED;
    } else if (input.right && !input.left) {
      player.vx = SPEED;
    } else {
      player.vx *= FRICTION;
    }
  } else {
    player.vx *= 0.9;
  }

  if (!stunned && input.up && player.onGround) {
    player.vy = JUMP;
  }

  player.vy += GRAVITY * dt;
  player.x += player.vx * dt;
  player.y += player.vy * dt;

  const groundY = arena.groundY;
  if (player.y + player.h >= groundY) {
    player.y = groundY - player.h;
    player.vy = 0;
    player.onGround = true;
  } else {
    player.onGround = false;
  }

  player.x = clamp(player.x, 40, arena.width - 40 - player.w);
}

function updateRoom(room, dt) {
  const state = room.state;
  if (room.status === "waiting" || room.status === "finished") return;

  if (room.status === "countdown") {
    room.countdown = Math.max(0, room.countdown - dt);
    state.countdown = room.countdown;
    if (room.countdown <= 0) {
      room.status = "playing";
      state.countdown = null;
      state.message = "";
      state.timer = 99;
      room.lastTick = Date.now();
    }
    return;
  }

  if (room.status !== "playing") return;

  if (room.ai) {
    updateAI(room, dt);
  }

  if (room.mode === "training") {
    state.timer = 999;
  } else {
    state.timer = Math.max(0, state.timer - dt);
    if (state.timer <= 0) {
      const p1 = state.players[0];
      const p2 = state.players[1];
      let winnerId = null;
      if (p1.hp > p2.hp) winnerId = p1.clientId;
      if (p2.hp > p1.hp) winnerId = p2.clientId;
      finishMatch(room, winnerId, "时间到");
      return;
    }
  }

  const p1 = state.players[0];
  const p2 = state.players[1];
  if (!p1.clientId || !p2.clientId) return;

  p1.facing = p1.x < p2.x ? 1 : -1;
  p2.facing = -p1.facing;

  const in1 = getInput(room, p1.clientId);
  const in2 = getInput(room, p2.clientId);

  updateJamieStats(p1);
  updateJamieStats(p2);
  if (p1.drinkCooldown > 0) p1.drinkCooldown = Math.max(0, p1.drinkCooldown - dt);
  if (p2.drinkCooldown > 0) p2.drinkCooldown = Math.max(0, p2.drinkCooldown - dt);
  if (p1.actionTimer > 0) {
    p1.actionTimer = Math.max(0, p1.actionTimer - dt);
    if (p1.actionTimer === 0) p1.action = null;
  }
  if (p2.actionTimer > 0) {
    p2.actionTimer = Math.max(0, p2.actionTimer - dt);
    if (p2.actionTimer === 0) p2.action = null;
  }

  if (p1.attackCooldown > 0) p1.attackCooldown = Math.max(0, p1.attackCooldown - dt);
  if (p2.attackCooldown > 0) p2.attackCooldown = Math.max(0, p2.attackCooldown - dt);

  const p1Stunned = p1.hitstun > 0 || p1.blockstun > 0;
  const p2Stunned = p2.hitstun > 0 || p2.blockstun > 0;

  if (in1.parry && p1.drive > 0 && !p1Stunned) {
    p1.drive = clamp(p1.drive - 16 * dt, 0, 100);
    if (p1.drive <= 0) p1.burnout = true;
    if (p1.action !== "drink") {
      p1.action = "parry";
      p1.actionTimer = 0.1;
    }
  }
  if (in2.parry && p2.drive > 0 && !p2Stunned) {
    p2.drive = clamp(p2.drive - 16 * dt, 0, 100);
    if (p2.drive <= 0) p2.burnout = true;
    if (p2.action !== "drink") {
      p2.action = "parry";
      p2.actionTimer = 0.1;
    }
  }

  if (in1.special1 && canDrink(p1) && !p1Stunned) {
    drinkUp(p1);
  }
  if (in2.special1 && canDrink(p2) && !p2Stunned) {
    drinkUp(p2);
  }

  if (in1.rush && p1.drive >= 20 && !p1Stunned) {
    p1.drive = Math.max(0, p1.drive - 20);
    p1.dashTime = 0.22;
    p1.dashSpeed = 650;
    if (p1.drive <= 0) p1.burnout = true;
  }
  if (in2.rush && p2.drive >= 20 && !p2Stunned) {
    p2.drive = Math.max(0, p2.drive - 20);
    p2.dashTime = 0.22;
    p2.dashSpeed = 650;
    if (p2.drive <= 0) p2.burnout = true;
  }

  if (p1.attack) {
    p1.attack.t += dt;
    if (p1.attack.cancelStart !== null && p1.attack.t >= p1.attack.cancelStart && p1.attack.t <= p1.attack.cancelEnd) {
      if (p1.attack.type === "rekka1" && in1.special3) startAttack(p1, "rekka2", in1.punchStrength);
      else if (p1.attack.type === "rekka2" && in1.special3) startAttack(p1, "rekka3", in1.punchStrength);
      else if (in1.punch || in1.kick)
        startAttack(p1, in1.kick ? "kick" : "punch", in1.kick ? in1.kickStrength : in1.punchStrength);
    }
  } else if (p1.attackCooldown <= 0 && !p1Stunned) {
    if (in1.impact && p1.drive >= 20) {
      p1.drive = Math.max(0, p1.drive - 20);
      startAttack(p1, "impact", "h");
      if (p1.drive <= 0) p1.burnout = true;
    } else if (in1.special4 && !p1.onGround && p1.characterId === "jamie") {
      startAttack(p1, "divekick", in1.kickStrength);
      p1.vy = 680;
    } else if (in1.special2 && p1.characterId === "jamie" && p1.drinkLevel >= 2) {
      startAttack(p1, "bakkai", in1.kickStrength);
      p1.dashTime = 0.2;
      p1.dashSpeed = 720;
    } else if (in1.special3 && p1.characterId === "jamie") {
      startAttack(p1, "rekka1", in1.punchStrength);
    } else if (in1.punch) startAttack(p1, "punch", in1.punchStrength);
    else if (in1.kick) startAttack(p1, "kick", in1.kickStrength);
  }

  if (p2.attack) {
    p2.attack.t += dt;
    if (p2.attack.cancelStart !== null && p2.attack.t >= p2.attack.cancelStart && p2.attack.t <= p2.attack.cancelEnd) {
      if (p2.attack.type === "rekka1" && in2.special3) startAttack(p2, "rekka2", in2.punchStrength);
      else if (p2.attack.type === "rekka2" && in2.special3) startAttack(p2, "rekka3", in2.punchStrength);
      else if (in2.punch || in2.kick)
        startAttack(p2, in2.kick ? "kick" : "punch", in2.kick ? in2.kickStrength : in2.punchStrength);
    }
  } else if (p2.attackCooldown <= 0 && !p2Stunned) {
    if (in2.impact && p2.drive >= 20) {
      p2.drive = Math.max(0, p2.drive - 20);
      startAttack(p2, "impact", "h");
      if (p2.drive <= 0) p2.burnout = true;
    } else if (in2.special4 && !p2.onGround && p2.characterId === "jamie") {
      startAttack(p2, "divekick", in2.kickStrength);
      p2.vy = 680;
    } else if (in2.special2 && p2.characterId === "jamie" && p2.drinkLevel >= 2) {
      startAttack(p2, "bakkai", in2.kickStrength);
      p2.dashTime = 0.2;
      p2.dashSpeed = 720;
    } else if (in2.special3 && p2.characterId === "jamie") {
      startAttack(p2, "rekka1", in2.punchStrength);
    } else if (in2.punch) startAttack(p2, "punch", in2.punchStrength);
    else if (in2.kick) startAttack(p2, "kick", in2.kickStrength);
  }

  updatePlayer(p1, in1, dt, state);
  updatePlayer(p2, in2, dt, state);
  resolvePlayerOverlap(p1, p2, state);

  if (p1.attack) {
    processAttack(p1, p2, in2);
    if (p1.attack.t > p1.attack.duration) p1.attack = null;
  }
  if (p2.attack) {
    processAttack(p2, p1, in1);
    if (p2.attack.t > p2.attack.duration) p2.attack = null;
  }

  if (p1.comboTimer > 0) {
    p1.comboTimer = Math.max(0, p1.comboTimer - dt);
    if (p1.comboTimer === 0) p1.comboCount = 0;
  }
  if (p2.comboTimer > 0) {
    p2.comboTimer = Math.max(0, p2.comboTimer - dt);
    if (p2.comboTimer === 0) p2.comboCount = 0;
  }

  if (!in1.parry && !p1Stunned) {
    const regen = p1.burnout ? 6 : 12;
    p1.drive = clamp(p1.drive + regen * dt, 0, 100);
    if (p1.burnout && p1.drive >= 20) p1.burnout = false;
  }
  if (!in2.parry && !p2Stunned) {
    const regen = p2.burnout ? 6 : 12;
    p2.drive = clamp(p2.drive + regen * dt, 0, 100);
    if (p2.burnout && p2.drive >= 20) p2.burnout = false;
  }

  in1.punch = false;
  in1.kick = false;
  in1.punchStrength = "";
  in1.kickStrength = "";
  in1.impact = false;
  in1.rush = false;
  in1.special1 = false;
  in1.special2 = false;
  in1.special3 = false;
  in1.special4 = false;
  in2.punch = false;
  in2.kick = false;
  in2.punchStrength = "";
  in2.kickStrength = "";
  in2.impact = false;
  in2.rush = false;
  in2.special1 = false;
  in2.special2 = false;
  in2.special3 = false;
  in2.special4 = false;

  if (room.mode === "training") {
    [p1, p2].forEach((p) => {
      if (p.hp > 0) {
        p.downTime = 0;
        return;
      }
      if (p.downTime <= 0) p.downTime = 0.001;
      p.downTime += dt;
      p.hp = 0;
      p.vx = 0;
      p.vy = 0;
      p.hitstun = Math.max(p.hitstun, 0.2);
      if (p.downTime >= 2.5) {
        const spawnX = p.slot === 0 ? 220 : 740;
        p.x = spawnX - p.w / 2;
        p.y = state.groundY - p.h;
        p.vx = 0;
        p.vy = 0;
        p.hp = p.maxHp || 100;
        p.drive = 100;
        p.burnout = false;
        p.attack = null;
        p.attackCooldown = 0;
        p.hitstun = 0;
        p.blockstun = 0;
        p.dashTime = 0;
        p.dashSpeed = 0;
        p.downTime = 0;
      }
    });
  } else if (p1.hp <= 0 || p2.hp <= 0) {
    const winnerId = p1.hp <= 0 ? p2.clientId : p1.clientId;
    finishMatch(room, winnerId, "击倒");
  }
}

wss.on("connection", (ws) => {
  const clientId = randomUUID();
  const client = { id: clientId, ws, name: `玩家-${clientId.slice(0, 4)}`, roomId: null, role: null };
  clientsById.set(clientId, client);
  clientsBySocket.set(ws, client);

  safeSend(ws, { type: "welcome", id: clientId, name: client.name });
  broadcastRoomList();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "hello") {
    if (typeof msg.name === "string" && msg.name.trim()) {
      client.name = msg.name.trim().slice(0, 16);
    }
    if (typeof msg.characterId === "string" && msg.characterId) {
      client.characterId = msg.characterId;
    }
    safeSend(ws, { type: "welcome", id: clientId, name: client.name });
    broadcastRoomList();
    return;
  }

    if (msg.type === "list_rooms") {
      safeSend(ws, { type: "room_list", rooms: Array.from(rooms.values()).map(roomSummary) });
      return;
    }

    if (msg.type === "ping") {
      const room = client.roomId ? rooms.get(client.roomId) : null;
      safeSend(ws, {
        type: "pong",
        t: typeof msg.t === "number" ? msg.t : Date.now(),
        serverTimeMs: room ? Math.round(room.serverTimeMs) : 0,
      });
      return;
    }

    if (msg.type === "create_room") {
      const isPrivate = !!msg.isPrivate;
      const password = typeof msg.password === "string" ? msg.password.trim() : "";
      const characterId = typeof msg.characterId === "string" ? msg.characterId : "";
      if (isPrivate && !password) {
        safeSend(ws, { type: "error", message: "私密房间需要密码" });
        return;
      }
      const room = createRoom(msg.name, { isPrivate, password });
      addPlayerToRoom(client, room, null, characterId);
      if (room.players.filter(Boolean).length === 2) startCountdown(room);
      safeSend(ws, {
        type: "room_joined",
        roomId: room.id,
        role: "player",
        slot: room.players.indexOf(client.id),
        mode: room.mode || "pvp",
      });
      broadcastToRoom(room, statePayload(room));
      broadcastRoomList();
      return;
    }

    if (msg.type === "create_training_room") {
      const characterId = typeof msg.characterId === "string" ? msg.characterId : "";
      const aiMode = typeof msg.aiMode === "string" ? msg.aiMode : "basic";
      const room = createRoom(msg.name, { isPrivate: false, password: "", mode: "training", aiMode });
      addPlayerToRoom(client, room, 0, characterId);
      addAIToRoom(room, { slot: 1, name: aiMode === "dummy" ? "木桩" : "训练机器人", mode: aiMode });
      startCountdown(room);
      safeSend(ws, { type: "room_joined", roomId: room.id, role: "player", slot: 0, mode: room.mode || "training" });
      broadcastToRoom(room, statePayload(room));
      broadcastRoomList();
      return;
    }

    if (msg.type === "join_room") {
      const room = rooms.get(msg.roomId);
      if (!room) {
        safeSend(ws, { type: "error", message: "房间不存在" });
        return;
      }
      if (room.isPrivate) {
        const password = typeof msg.password === "string" ? msg.password.trim() : "";
        if (!password || password !== room.password) {
          safeSend(ws, { type: "error", message: "房间密码错误" });
          return;
        }
      }
      if (client.roomId) {
        const oldRoom = rooms.get(client.roomId);
        removeClientFromRoom(client, oldRoom);
      }

      if (room.mode === "training") {
        const humanIds = getHumanIds(room);
        humanIds.forEach((id) => {
          if (msg.forcePlayer) {
            removePlayerId(room, id);
          } else if (!isHumanActive(room, id)) {
            removePlayerId(room, id);
          }
        });
      }

      const humanCount = getHumanCount(room);
      const asSpectator = !!msg.asSpectator || (room.mode === "training" && humanCount >= 1);
      const characterId = typeof msg.characterId === "string" ? msg.characterId : "";
      let slot = null;
      if (!asSpectator) slot = addPlayerToRoom(client, room, null, characterId);
      if (slot === null) addSpectatorToRoom(client, room);

      const role = client.role || "spectator";
      if (room.mode === "training" && !room.ai) {
        addAIToRoom(room, {
          slot: slot === 0 ? 1 : 0,
          name: room.aiMode === "dummy" ? "木桩" : "训练机器人",
          mode: room.aiMode || "basic",
        });
      }
      if (room.players.filter(Boolean).length === 2 && room.status !== "playing") {
        startCountdown(room);
      }
      safeSend(ws, { type: "room_joined", roomId: room.id, role, slot, mode: room.mode || "pvp" });
      broadcastToRoom(room, statePayload(room));
      broadcastRoomList();
      return;
    }

    if (msg.type === "leave_room") {
      if (client.roomId) {
        const room = rooms.get(client.roomId);
        removeClientFromRoom(client, room);
        broadcastRoomList();
      }
      return;
    }

    if (msg.type === "input") {
      if (!client.roomId || client.role !== "player") return;
      const room = rooms.get(client.roomId);
      if (!room) return;
      const seq = typeof msg.seq === "number" ? msg.seq : 0;
      const lastSeq = room.inputSeq.get(client.id) || 0;
      if (seq <= lastSeq) return;
      room.inputSeq.set(client.id, seq);
      room.lastInputAt.set(client.id, Date.now());
      const current = room.inputs.get(client.id) || defaultInput();
      const input = msg.input || {};
      current.left = !!input.left;
      current.right = !!input.right;
      current.up = !!input.up;
      current.down = !!input.down;
      current.punch = !!input.punch;
      current.kick = !!input.kick;
      current.punchStrength = typeof input.punchStrength === "string" ? input.punchStrength : "";
      current.kickStrength = typeof input.kickStrength === "string" ? input.kickStrength : "";
      current.parry = !!input.parry;
      current.impact = !!input.impact;
      current.rush = !!input.rush;
      current.special1 = !!input.special1;
      current.special2 = !!input.special2;
      current.special3 = !!input.special3;
      current.special4 = !!input.special4;
      room.inputs.set(client.id, current);
      return;
    }
  });

  ws.on("close", () => {
    const c = clientsBySocket.get(ws);
    if (!c) return;
    if (c.roomId) {
      const room = rooms.get(c.roomId);
      removeClientFromRoom(c, room);
      broadcastRoomList();
    }
    clientsById.delete(c.id);
    clientsBySocket.delete(ws);
  });
});

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room) => {
    if (room.emptySince && now - room.emptySince > ROOM_EMPTY_TTL_MS) {
      rooms.delete(room.id);
      broadcastRoomList();
      return;
    }
    const dt = Math.min(0.05, (now - room.lastTick) / 1000);
    room.lastTick = now;
    room.serverTimeMs += dt * 1000;
    updateRoom(room, dt);
    if (room.status === "playing" || room.status === "countdown") {
      broadcastToRoom(room, statePayload(room));
    }
  });
}, TICK_MS);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Fight server running on http://localhost:${PORT}`);
});
