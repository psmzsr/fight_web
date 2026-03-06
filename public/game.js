const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const roomLabel = document.getElementById("roomLabel");
const roleLabel = document.getElementById("roleLabel");
const leaveBtn = document.getElementById("leaveBtn");
const statusText = document.getElementById("statusText");
const latencyText = document.getElementById("latencyText");

const params = new URLSearchParams(window.location.search);
const roomId = params.get("roomId");
const role = params.get("role") || "spectator";
const mode = params.get("mode") || "pvp";
const isPlayer = role === "player";

const state = {
  ws: null,
  latest: null,
  status: "waiting",
  name: localStorage.getItem("fight_name") || "Player",
  characterId: localStorage.getItem("fight_character") || "",
  clientId: null,
  buffer: [],
  timeOffsetMs: null,
  inputSeq: 0,
  latencyMs: null,
  interpDelayMs: isPlayer ? 80 : 120,
  selfPred: null,
  selfServer: null,
  selfIndex: null,
  lastFrameTs: null,
  localFacing: 1,
  localOnGround: true,
  dirHistory: [],
  lastDir: 5,
  lastForwardTap: 0,
  input: {
    left: false,
    right: false,
    up: false,
    down: false,
  },
  buttons: {
    lp: false,
    mp: false,
    hp: false,
    lk: false,
    mk: false,
    hk: false,
  },
  buttonPulse: {
    lp: false,
    mp: false,
    hp: false,
    lk: false,
    mk: false,
    hk: false,
  },
  pulse: {
    rush: false,
  },
  reconnectTimer: null,
  reconnectDelay: 1000,
};

roomLabel.textContent = roomId ? `房间 ${roomId}` : "房间";
roleLabel.textContent = isPlayer ? "玩家" : "观战";

function connect() {
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", name: state.name, characterId: state.characterId }));
    if (roomId) {
      const password = sessionStorage.getItem(`room_pwd_${roomId}`) || "";
      ws.send(
        JSON.stringify({
          type: "join_room",
          roomId,
          asSpectator: !isPlayer,
          password,
          forcePlayer: mode === "training",
          characterId: state.characterId,
        })
      );
    }
    state.reconnectDelay = 1000;
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "welcome") {
      state.clientId = msg.id || null;
    }
    if (msg.type === "state") {
      state.latest = msg.state;
      state.status = msg.status || "waiting";
      if (typeof msg.serverTimeMs === "number") {
        updateTimeOffset(msg.serverTimeMs);
        pushSnapshot({
          t: msg.serverTimeMs,
          state: msg.state,
          status: state.status,
        });
      }
      if (state.clientId) {
        const idx = msg.state.players.findIndex((p) => p.clientId === state.clientId);
        if (idx !== -1) {
          state.selfIndex = idx;
          state.selfServer = clonePlayer(msg.state.players[idx]);
          if (!state.selfPred) {
            state.selfPred = clonePlayer(msg.state.players[idx]);
          }
          const nextFacing = msg.state.players[idx].facing || 1;
          if (nextFacing !== state.localFacing) {
            state.dirHistory = [];
            state.lastDir = 5;
          }
          state.localFacing = nextFacing;
          state.localOnGround = !!msg.state.players[idx].onGround;
        }
      }
    }
    if (msg.type === "finished") {
      if (msg.reason) statusText.textContent = msg.reason;
    }
    if (msg.type === "error") {
      statusText.textContent = msg.message || "服务器错误";
    }
    if (msg.type === "pong") {
      if (typeof msg.t === "number") {
        const rtt = Math.max(0, performance.now() - msg.t);
        state.latencyMs = Math.round(rtt / 2);
        latencyText.textContent = `延迟：${state.latencyMs} ms`;
      }
      if (typeof msg.serverTimeMs === "number") {
        updateTimeOffset(msg.serverTimeMs);
      }
    }
  });

  ws.addEventListener("close", () => {
    statusText.textContent = "连接断开，正在重连...";
    if (!state.reconnectTimer) {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        connect();
        state.reconnectDelay = Math.min(8000, state.reconnectDelay * 1.5);
      }, state.reconnectDelay);
    }
  });
}

function sendInput() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !isPlayer) return;
  recordDirection();

  const rawPunchStrength = getPunchStrength();
  const rawKickStrength = getKickStrength();

  let punchPressed = state.buttonPulse.lp || state.buttonPulse.mp || state.buttonPulse.hp;
  let kickPressed = state.buttonPulse.lk || state.buttonPulse.mk || state.buttonPulse.hk;
  const parry = state.buttons.mp && state.buttons.mk;
  const impact = (state.buttonPulse.hp && state.buttons.hk) || (state.buttonPulse.hk && state.buttons.hp);

  if (parry || impact) {
    punchPressed = false;
    kickPressed = false;
  }

  const specials = detectSpecials(punchPressed, kickPressed);
  const punch = punchPressed && !specials.special1 && !specials.special3;
  const kick = kickPressed && !specials.special2 && !specials.special4;

  const payload = {
    ...state.input,
    punch,
    kick,
    punchStrength: punchPressed ? rawPunchStrength : "",
    kickStrength: kickPressed ? rawKickStrength : "",
    parry,
    impact,
    rush: state.pulse.rush,
    ...specials,
  };
  state.inputSeq += 1;
  state.ws.send(JSON.stringify({ type: "input", seq: state.inputSeq, t: performance.now(), input: payload }));
  state.pulse.rush = false;
  Object.keys(state.buttonPulse).forEach((key) => {
    state.buttonPulse[key] = false;
  });
}

function updateTimeOffset(serverTimeMs) {
  const now = performance.now();
  const offset = now - serverTimeMs;
  if (state.timeOffsetMs === null) {
    state.timeOffsetMs = offset;
  } else {
    state.timeOffsetMs = state.timeOffsetMs * 0.9 + offset * 0.1;
  }
}

function getServerNowMs() {
  if (state.timeOffsetMs === null) return null;
  return performance.now() - state.timeOffsetMs;
}

function pushSnapshot(snapshot) {
  state.buffer.push(snapshot);
  if (state.buffer.length > 60) state.buffer.shift();
  const latest = snapshot.t;
  while (state.buffer.length && latest - state.buffer[0].t > 5000) {
    state.buffer.shift();
  }
}

function getRelativeDir() {
  const facing = state.localFacing || 1;
  const dx = state.input.right ? 1 : state.input.left ? -1 : 0;
  const dy = state.input.down ? 1 : state.input.up ? -1 : 0;
  const relX = dx * facing;
  if (dy > 0) {
    if (relX > 0) return 3;
    if (relX < 0) return 1;
    return 2;
  }
  if (dy < 0) {
    if (relX > 0) return 9;
    if (relX < 0) return 7;
    return 8;
  }
  if (relX > 0) return 6;
  if (relX < 0) return 4;
  return 5;
}

function recordDirection() {
  const dir = getRelativeDir();
  if (dir === state.lastDir) return;
  state.lastDir = dir;
  const now = performance.now();
  state.dirHistory.push({ dir, t: now });
  if (state.dirHistory.length > 24) state.dirHistory.shift();
  const cutoff = now - 800;
  state.dirHistory = state.dirHistory.filter((h) => h.t >= cutoff);
}

function hasSequence(seq, maxGapMs) {
  if (!state.dirHistory.length) return false;
  let idx = state.dirHistory.length - 1;
  let lastTime = Infinity;
  for (let s = seq.length - 1; s >= 0; s -= 1) {
    const dirs = Array.isArray(seq[s]) ? seq[s] : [seq[s]];
    let found = false;
    for (let i = idx; i >= 0; i -= 1) {
      const item = state.dirHistory[i];
      if (lastTime !== Infinity && lastTime - item.t > maxGapMs) break;
      if (dirs.includes(item.dir)) {
        found = true;
        idx = i - 1;
        lastTime = item.t;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function detectSpecials(punchPressed, kickPressed) {
  const specials = { special1: false, special2: false, special3: false, special4: false };
  if (!state.localOnGround && kickPressed && [1, 2, 3].includes(getRelativeDir())) {
    specials.special4 = true;
    return specials;
  }
  if (punchPressed && hasSequence([2, 2], 300)) {
    specials.special1 = true;
  } else if (punchPressed && hasSequence([2, [3, 2], 6], 450)) {
    specials.special3 = true;
  }
  if (kickPressed && hasSequence([2, [1, 2], 4], 450)) {
    specials.special2 = true;
  }
  return specials;
}

function getPunchStrength() {
  if (state.buttonPulse.hp) return "h";
  if (state.buttonPulse.mp) return "m";
  if (state.buttonPulse.lp) return "l";
  return "";
}

function getKickStrength() {
  if (state.buttonPulse.hk) return "h";
  if (state.buttonPulse.mk) return "m";
  if (state.buttonPulse.lk) return "l";
  return "";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function normalizeStrength(value) {
  if (value === "l" || value === "m" || value === "h") return value;
  return "m";
}

function getStrengthScale(strength) {
  if (strength === "l") return 0.85;
  if (strength === "h") return 1.15;
  return 1;
}

function getAttackPhase(attack) {
  if (!attack) return null;
  if (attack.t < attack.activeStart) return "startup";
  if (attack.t <= attack.activeEnd) return "active";
  return "recovery";
}

function getAttackFrame(attack, frames = 6) {
  if (!attack) return 0;
  const duration = Math.max(0.001, attack.duration || 0.001);
  const ratio = clamp(attack.t / duration, 0, 0.999);
  return Math.floor(ratio * frames);
}

function clonePlayer(player) {
  return {
    ...player,
    attack: player.attack ? { ...player.attack } : null,
  };
}

function resolveLocalOverlap(selfPlayer, otherPlayer, arena) {
  if (!selfPlayer || !otherPlayer) return selfPlayer;
  const overlapX =
    Math.min(selfPlayer.x + selfPlayer.w, otherPlayer.x + otherPlayer.w) -
    Math.max(selfPlayer.x, otherPlayer.x);
  const overlapY =
    Math.min(selfPlayer.y + selfPlayer.h, otherPlayer.y + otherPlayer.h) -
    Math.max(selfPlayer.y, otherPlayer.y);
  if (overlapX > 0 && overlapY > 0) {
    const push = overlapX + 0.01;
    if (selfPlayer.x < otherPlayer.x) {
      selfPlayer.x -= push;
    } else {
      selfPlayer.x += push;
    }
    selfPlayer.x = clamp(selfPlayer.x, 40, arena.width - 40 - selfPlayer.w);
  }
  return selfPlayer;
}

function interpolateState(a, b, t) {
  const result = {
    width: b.width,
    height: b.height,
    groundY: b.groundY,
    timer: lerp(a.timer, b.timer, t),
    message: b.message,
    winnerId: b.winnerId,
    countdown: b.countdown,
    players: b.players.map((pb, index) => {
      const pa = a.players[index] || pb;
      return {
        ...pb,
        x: lerp(pa.x, pb.x, t),
        y: lerp(pa.y, pb.y, t),
      };
    }),
  };
  return result;
}

function simulatePlayer(player, input, dt, arena) {
  const SPEED = player.stats?.speed ?? 300;
  const JUMP = player.stats?.jump ?? -850;
  const GRAVITY = player.stats?.gravity ?? 2000;
  const FRICTION = player.stats?.friction ?? 0.82;

  const p = { ...player };

  const stunned = p.hitstun > 0 || p.blockstun > 0;
  if (p.hitstun > 0) p.hitstun = Math.max(0, p.hitstun - dt);
  if (p.blockstun > 0) p.blockstun = Math.max(0, p.blockstun - dt);
  if (p.hitstun > 0) p.dashTime = 0;

  if (!stunned) {
    if (p.dashTime > 0) {
      p.dashTime = Math.max(0, p.dashTime - dt);
      p.vx = (p.dashSpeed || 0) * p.facing;
    } else if (input.left && !input.right) {
      p.vx = -SPEED;
    } else if (input.right && !input.left) {
      p.vx = SPEED;
    } else {
      p.vx *= FRICTION;
    }
  } else {
    p.vx *= 0.9;
  }

  if (!stunned && input.up && p.onGround) {
    p.vy = JUMP;
  }

  p.vy += GRAVITY * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;

  if (p.y + p.h >= arena.groundY) {
    p.y = arena.groundY - p.h;
    p.vy = 0;
    p.onGround = true;
  } else {
    p.onGround = false;
  }

  p.x = clamp(p.x, 40, arena.width - 40 - p.w);
  return p;
}

function getRenderState() {
  if (!state.buffer.length) return null;
  const serverNowMs = getServerNowMs();
  if (serverNowMs === null) {
    const latest = state.buffer[state.buffer.length - 1];
    return { state: latest.state, status: latest.status, renderTimeMs: latest.t, serverNowMs: null };
  }

  const renderTimeMs = serverNowMs - state.interpDelayMs;
  let s0 = state.buffer[0];
  let s1 = state.buffer[state.buffer.length - 1];
  for (let i = 0; i < state.buffer.length - 1; i += 1) {
    const a = state.buffer[i];
    const b = state.buffer[i + 1];
    if (a.t <= renderTimeMs && renderTimeMs <= b.t) {
      s0 = a;
      s1 = b;
      break;
    }
  }
  const span = s1.t - s0.t;
  const t = span > 0 ? clamp((renderTimeMs - s0.t) / span, 0, 1) : 0;
  const baseState = interpolateState(s0.state, s1.state, t);

  return { state: baseState, status: s1.status, renderTimeMs, serverNowMs };
}

function applyLocalPrediction(frame, dt) {
  if (!isPlayer || !state.clientId) return frame;
  const players = frame.players;
  const idx =
    state.selfIndex !== null && state.selfIndex !== undefined
      ? state.selfIndex
      : players.findIndex((p) => p.clientId === state.clientId);
  if (idx === -1) return frame;

  if (!state.selfPred) {
    state.selfPred = clonePlayer(players[idx]);
  }

  state.selfPred = simulatePlayer(state.selfPred, state.input, dt, frame);

  if (state.selfServer) {
    const server = state.selfServer;
    const pred = state.selfPred;
    const dx = server.x - pred.x;
    const dy = server.y - pred.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 120) {
      pred.x = server.x;
      pred.y = server.y;
      pred.vx = server.vx;
      pred.vy = server.vy;
    } else {
      pred.x += dx * 0.15;
      pred.y += dy * 0.15;
      pred.vx = lerp(pred.vx, server.vx, 0.1);
      pred.vy = lerp(pred.vy, server.vy, 0.1);
    }
    pred.hp = server.hp;
    pred.hitstun = server.hitstun;
    pred.blockstun = server.blockstun;
    pred.attack = server.attack ? { ...server.attack } : null;
    pred.facing = server.facing;
    pred.onGround = server.onGround;
    pred.name = server.name;
    pred.color = server.color;
    pred.w = server.w;
    pred.h = server.h;
    pred.maxHp = server.maxHp;
    pred.stats = server.stats ? { ...server.stats } : pred.stats;
    pred.drive = server.drive;
    pred.burnout = server.burnout;
    pred.dashTime = server.dashTime;
    pred.dashSpeed = server.dashSpeed;
    pred.drinkLevel = server.drinkLevel;
    pred.characterId = server.characterId;
    pred.characterName = server.characterName;
    pred.action = server.action;
    pred.actionTimer = server.actionTimer;
  }

  players[idx] = state.selfPred;
  const otherIdx = idx === 0 ? 1 : 0;
  if (players[otherIdx]) {
    players[idx] = resolveLocalOverlap(players[idx], players[otherIdx], frame);
  }
  return frame;
}

function drawBackground(arena) {
  const gradient = ctx.createLinearGradient(0, 0, 0, arena.height);
  gradient.addColorStop(0, "#0f1c34");
  gradient.addColorStop(1, "#0b1426");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, arena.width, arena.height);

  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, arena.groundY);
  ctx.lineTo(arena.width, arena.groundY);
  ctx.stroke();
}

function drawHUD(arena, p1, p2) {
  const barW = 300;
  const barH = 16;
  const padding = 30;
  const driveH = 10;

  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(padding, 20, barW, barH);
  ctx.fillRect(arena.width - padding - barW, 20, barW, barH);

  ctx.fillStyle = "#2d6bff";
  ctx.fillRect(padding, 20, barW * (p1.hp / (p1.maxHp || 100)), barH);
  ctx.fillStyle = "#ff4d4d";
  ctx.fillRect(arena.width - padding - barW, 20, barW * (p2.hp / (p2.maxHp || 100)), barH);

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(padding, 20 + barH + 6, barW, driveH);
  ctx.fillRect(arena.width - padding - barW, 20 + barH + 6, barW, driveH);
  ctx.fillStyle = "#57c1ff";
  ctx.fillRect(padding, 20 + barH + 6, barW * (p1.drive / 100), driveH);
  ctx.fillStyle = "#57c1ff";
  ctx.fillRect(arena.width - padding - barW, 20 + barH + 6, barW * (p2.drive / 100), driveH);

  ctx.fillStyle = "#e7ecf5";
  ctx.font = "14px Segoe UI";
  ctx.fillText(p1.name || "P1", padding, 18);
  ctx.fillText(p2.name || "P2", arena.width - padding - barW, 18);

  ctx.fillStyle = "#9fb0cc";
  ctx.font = "12px Segoe UI";
  ctx.fillText("架势", padding, 20 + barH + 20);
  ctx.fillText("架势", arena.width - padding - barW, 20 + barH + 20);

  if (p1.characterId === "jamie") {
    ctx.fillStyle = "#ffb26f";
    ctx.font = "12px Segoe UI";
    ctx.fillText(`酒 ${p1.drinkLevel || 0}`, padding, 62);
  }
  if (p2.characterId === "jamie") {
    ctx.fillStyle = "#ffb26f";
    ctx.font = "12px Segoe UI";
    const text = `酒 ${p2.drinkLevel || 0}`;
    const width = ctx.measureText(text).width;
    ctx.fillText(text, arena.width - padding - width, 62);
  }

  if (p1.burnout) {
    ctx.fillStyle = "#ff8b3d";
    ctx.font = "14px Segoe UI";
    ctx.fillText("燃尽", padding, 70);
  }
  if (p2.burnout) {
    ctx.fillStyle = "#ff8b3d";
    ctx.font = "14px Segoe UI";
    const text = "燃尽";
    const width = ctx.measureText(text).width;
    ctx.fillText(text, arena.width - padding - width, 70);
  }

  if (p1.comboCount >= 2) {
    ctx.fillStyle = "#ffb26f";
    ctx.font = "18px Segoe UI";
    ctx.fillText(`连击 x${p1.comboCount}`, padding, 90);
  }
  if (p2.comboCount >= 2) {
    ctx.fillStyle = "#ffb26f";
    ctx.font = "18px Segoe UI";
    const text = `连击 x${p2.comboCount}`;
    const width = ctx.measureText(text).width;
    ctx.fillText(text, arena.width - padding - width, 90);
  }
}

function vec(len, angle, facing) {
  return { dx: len * Math.cos(angle) * facing, dy: len * Math.sin(angle) };
}

function getPose(player, timeMs) {
  const speed = Math.min(1, Math.abs(player.vx || 0) / (player.stats?.speed || 300));
  const phase = timeMs * 0.008;
  const swing = Math.sin(phase) * 0.45 * speed;

  const hit = player.hitstun > 0;
  const block = player.blockstun > 0;
  const airborne = !player.onGround;
  const attack = player.attack;
  const attackType = attack?.type;
  const knockDown = (hit && player.onGround && Math.abs(player.vx || 0) > 120) || player.hp <= 0;
  const strength = normalizeStrength(attack?.strength);
  const strengthScale = getStrengthScale(strength);
  const attackPhase = getAttackPhase(attack) || "active";
  const attackFrame = getAttackFrame(attack, 6);
  const frameNudge = attack ? (attackFrame % 2 === 0 ? -0.06 : 0.06) : 0;
  const twoDrink = (player.drinkLevel || 0) >= 2;
  const attackProgress = attack ? clamp(attack.t / Math.max(0.001, attack.duration || 0.001), 0, 1) : 0;
  const attackEase = Math.sin(attackProgress * Math.PI);

  if (player.action === "drink") {
    return {
      type: "drink",
      frontArmAngle: -0.4,
      backArmAngle: -1.2,
      frontLegAngle: 1.45,
      backLegAngle: 1.8,
      torsoLean: 0.06,
    };
  }
  if (player.action === "parry") {
    return {
      type: "parry",
      frontArmAngle: -0.2,
      backArmAngle: -0.8,
      frontLegAngle: 1.5,
      backLegAngle: 1.9,
      torsoLean: -0.04,
    };
  }

  if (knockDown) {
    return { type: "down" };
  }

  if (hit) {
    return {
      type: "hit",
      frontArmAngle: -1.2,
      backArmAngle: -1.6,
      frontLegAngle: 1.4,
      backLegAngle: 1.8,
      torsoLean: -0.12,
    };
  }

  if (block) {
    return {
      type: "block",
      frontArmAngle: -0.6,
      backArmAngle: -1.0,
      frontLegAngle: 1.4,
      backLegAngle: 1.8,
      torsoLean: -0.08,
    };
  }

  if (!attackType && player.dashTime > 0 && player.dashSpeed > 0 && !airborne) {
    return {
      type: "rush",
      frontArmAngle: -1.3,
      backArmAngle: -1.7,
      frontLegAngle: 1.05 + swing * 0.15,
      backLegAngle: 2.15 - swing * 0.15,
      torsoLean: 0.22,
    };
  }

  if (attackType) {
    if (attackType === "kick") {
      if (attackPhase === "startup") {
        return {
          type: "kick",
          frontArmAngle: -0.6,
          backArmAngle: -1.3,
          frontLegAngle: 1.25 - 0.1 * strengthScale + frameNudge * 0.3,
          backLegAngle: 2.0 + frameNudge * 0.2,
          torsoLean: -0.05,
        };
      }
      if (attackPhase === "active") {
        return {
          type: "kick",
          frontArmAngle: -0.35,
          backArmAngle: -1.2,
          frontLegAngle: 0.25 - 0.2 * strengthScale + frameNudge * 0.3,
          backLegAngle: 2.25 + frameNudge * 0.2,
          torsoLean: 0.14 * strengthScale,
        };
      }
      return {
        type: "kick",
        frontArmAngle: -0.55,
        backArmAngle: -1.25,
        frontLegAngle: 1.1 + frameNudge * 0.2,
        backLegAngle: 1.9,
        torsoLean: 0.06,
      };
    }
    if (attackType === "bakkai") {
      const spinBoost = twoDrink ? 1.2 : 1;
      if (attackPhase === "startup") {
        return {
          type: "bakkai",
          frontArmAngle: -0.2,
          backArmAngle: -0.6,
          frontLegAngle: 1.6 + frameNudge * 0.2,
          backLegAngle: 2.3,
          torsoLean: 0.2,
        };
      }
      if (attackPhase === "active") {
        return {
          type: "bakkai",
          frontArmAngle: 0.4,
          backArmAngle: -0.1,
          frontLegAngle: -0.6 * strengthScale * spinBoost + frameNudge * 0.2,
          backLegAngle: -0.15 * strengthScale * spinBoost,
          torsoLean: 0.32 * spinBoost,
        };
      }
      return {
        type: "bakkai",
        frontArmAngle: -0.3,
        backArmAngle: -0.8,
        frontLegAngle: 1.1 + frameNudge * 0.2,
        backLegAngle: 2.0,
        torsoLean: 0.12,
      };
    }
    if (attackType === "impact") {
      if (attackPhase === "startup") {
        return {
          type: "impact",
          frontArmAngle: -0.4,
          backArmAngle: -0.6,
          frontLegAngle: 1.4,
          backLegAngle: 1.9,
          torsoLean: -0.02,
        };
      }
      if (attackPhase === "active") {
        return {
          type: "impact",
          frontArmAngle: 0.45,
          backArmAngle: 0.2,
          frontLegAngle: 1.35,
          backLegAngle: 1.85,
          torsoLean: 0.2,
        };
      }
      return {
        type: "impact",
        frontArmAngle: -0.2,
        backArmAngle: -0.4,
        frontLegAngle: 1.4,
        backLegAngle: 1.8,
        torsoLean: 0.08,
      };
    }
    if (attackType === "divekick") {
      if (attackPhase === "startup") {
        return {
          type: "divekick",
          frontArmAngle: -0.7,
          backArmAngle: -1.3,
          frontLegAngle: 0.9,
          backLegAngle: 2.3,
          torsoLean: 0.18,
        };
      }
      if (attackPhase === "active") {
        return {
          type: "divekick",
          frontArmAngle: -0.9,
          backArmAngle: -1.5,
          frontLegAngle: 0.4 - 0.1 * strengthScale,
          backLegAngle: 2.5,
          torsoLean: 0.24,
        };
      }
      return {
        type: "divekick",
        frontArmAngle: -0.7,
        backArmAngle: -1.3,
        frontLegAngle: 1.05,
        backLegAngle: 2.1,
        torsoLean: 0.12,
      };
    }
    if (attackType.startsWith("rekka")) {
      const step =
        attackType === "rekka3" ? 3 : attackType === "rekka2" ? 2 : 1;
      const stepLean = 0.06 * step;
      const stepArm = 0.12 * step;
      const lungeScale = (attackPhase === "active" ? 1 : attackPhase === "startup" ? 0.6 : 0.35) * attackEase;
      const lunge = (5 + step * 2.5) * strengthScale * lungeScale;
      const shoulderShift = (3 + step * 2) * strengthScale * lungeScale;
      if (attackPhase === "startup") {
        return {
          type: "rekka",
          offsetX: lunge,
          shoulderShift,
          frontArmAngle: -1.55 + frameNudge * 0.7,
          backArmAngle: -1.7 + stepArm * 0.2,
          frontLegAngle: 1.25 - 0.04 * step,
          backLegAngle: 1.95 + 0.03 * step,
          torsoLean: -0.08 - stepLean * 0.25,
        };
      }
      if (attackPhase === "active") {
        return {
          type: "rekka",
          offsetX: lunge,
          shoulderShift,
          frontArmAngle: 0.35 + 0.18 * strengthScale + stepArm + frameNudge * 0.7,
          backArmAngle: -0.85 + 0.05 * step,
          frontLegAngle: 1.18 - 0.06 * step,
          backLegAngle: 2.05 + 0.05 * step,
          torsoLean: 0.18 * strengthScale + stepLean,
        };
      }
      return {
        type: "rekka",
        offsetX: lunge,
        shoulderShift,
        frontArmAngle: -0.45 + frameNudge * 0.5,
        backArmAngle: -1.2 + 0.05 * step,
        frontLegAngle: 1.25,
        backLegAngle: 1.85 + 0.05 * step,
        torsoLean: 0.08 + stepLean * 0.4,
      };
    }
    if (attackType === "punch") {
      if (attackPhase === "startup") {
        return {
          type: "punch",
          frontArmAngle: -1.45 + frameNudge * 0.6,
          backArmAngle: -1.6,
          frontLegAngle: 1.35,
          backLegAngle: 1.85,
          torsoLean: -0.06,
        };
      }
      if (attackPhase === "active") {
        return {
          type: "punch",
          frontArmAngle: 0.25 + 0.15 * strengthScale + frameNudge * 0.6,
          backArmAngle: -0.9,
          frontLegAngle: 1.25,
          backLegAngle: 1.9,
          torsoLean: 0.14 * strengthScale,
        };
      }
      return {
        type: "punch",
        frontArmAngle: -0.55 + frameNudge * 0.4,
        backArmAngle: -1.25,
        frontLegAngle: 1.3,
        backLegAngle: 1.8,
        torsoLean: 0.06,
      };
    }
  }

  if (airborne) {
    return {
      type: "jump",
      frontArmAngle: -0.8,
      backArmAngle: -1.0,
      frontLegAngle: 1.0,
      backLegAngle: 2.0,
      torsoLean: 0,
    };
  }

  if (speed > 0.15) {
    return {
      type: "walk",
      frontArmAngle: -0.8 + swing,
      backArmAngle: -1.2 - swing,
      frontLegAngle: 1.2 - swing,
      backLegAngle: 2.0 + swing,
      torsoLean: 0,
    };
  }

  return {
    type: "idle",
    frontArmAngle: -0.9,
    backArmAngle: -1.1,
    frontLegAngle: 1.35,
    backLegAngle: 1.8,
    torsoLean: Math.sin(timeMs * 0.004) * 0.02,
  };
}

function drawPlayer(player, timeMs) {
  const color = player.color || "#ffffff";
  const facing = player.facing || 1;
  const pose = getPose(player, timeMs);

  const headR = player.w * 0.18;
  const hipY = player.y + player.h * 0.7;
  const torsoLen = player.h * 0.32;
  const armLen = player.h * 0.24;
  const legLen = player.h * 0.3;

  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";

  const offsetX = (pose.offsetX || 0) * facing;
  const offsetY = pose.offsetY || 0;
  const shoulderShift = (pose.shoulderShift || 0) * facing;

  if (pose.type === "rush") {
    const pulse = Math.sin(timeMs * 0.02) * 6;
    ctx.save();
    ctx.strokeStyle = "rgba(87,193,255,0.35)";
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i += 1) {
      const baseX = player.x + player.w / 2 - facing * (18 + i * 8);
      const baseY = player.y + player.h * (0.55 + i * 0.06);
      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.lineTo(baseX - facing * (18 + pulse), baseY - 10);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (pose.type === "down") {
    const bodyY = player.y + player.h * 0.78;
    const bodyX = player.x + player.w / 2;
    const dir = facing;
    const bodyLen = player.h * 0.55;
    const headX = bodyX + dir * bodyLen * 0.45;
    const headY = bodyY - headR * 0.3;

    ctx.beginPath();
    ctx.moveTo(bodyX - dir * bodyLen * 0.4, bodyY);
    ctx.lineTo(bodyX + dir * bodyLen * 0.4, bodyY);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(headX, headY, headR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(bodyX, bodyY);
    ctx.lineTo(bodyX - dir * bodyLen * 0.2, bodyY - player.h * 0.12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bodyX, bodyY);
    ctx.lineTo(bodyX + dir * bodyLen * 0.2, bodyY - player.h * 0.12);
    ctx.stroke();
  } else {
    const torsoLean = pose.torsoLean || 0;
    const hipX = player.x + player.w / 2 + torsoLean * player.w * facing + offsetX;
    const hipY2 = hipY + offsetY;
    const shoulderX = hipX + torsoLean * player.w * 0.5 * facing + shoulderShift;
    const shoulderY = hipY2 - torsoLen;
    const headX = shoulderX;
    const headY = shoulderY - headR * 1.2;

    ctx.beginPath();
    ctx.arc(headX, headY, headR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    ctx.lineTo(hipX, hipY2);
    ctx.stroke();

    const frontArm = vec(armLen, pose.frontArmAngle || -0.9, facing);
    const backArm = vec(armLen, pose.backArmAngle || -1.1, facing);
    const frontLeg = vec(legLen, pose.frontLegAngle || 1.4, facing);
    const backLeg = vec(legLen, pose.backLegAngle || 1.8, facing);

    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    ctx.lineTo(shoulderX + frontArm.dx, shoulderY + frontArm.dy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    ctx.lineTo(shoulderX + backArm.dx, shoulderY + backArm.dy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(hipX, hipY2);
    ctx.lineTo(hipX + frontLeg.dx, hipY2 + frontLeg.dy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(hipX, hipY2);
    ctx.lineTo(hipX + backLeg.dx, hipY2 + backLeg.dy);
    ctx.stroke();
  }

  if (
    player.attack &&
    player.attack.t >= player.attack.activeStart &&
    player.attack.t <= player.attack.activeEnd
  ) {
    const range = player.attack.type === "kick" || player.attack.type === "bakkai" ? 90 : 70;
    const atkX = facing === 1 ? player.x + player.w : player.x - range;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(atkX, player.y + 20, range, player.h - 40);
  }
}

function drawOverlay(arena, status, stateData) {
  if (status === "countdown") {
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, arena.width, arena.height);
    ctx.fillStyle = "#fff";
    ctx.font = "64px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText(Math.ceil(stateData.countdown || 0), arena.width / 2, arena.height / 2);
    ctx.textAlign = "left";
  }
  if (status === "waiting") {
    statusText.textContent = "等待玩家加入...";
  } else if (status === "playing") {
    statusText.textContent = "开始对战！";
  } else if (status === "finished") {
    statusText.textContent = stateData.message || "对战结束";
  }
}

function render() {
  requestAnimationFrame(render);
  const renderData = getRenderState();
  if (!renderData) return;
  const now = performance.now();
  if (state.lastFrameTs === null) state.lastFrameTs = now;
  const dt = Math.min(0.05, (now - state.lastFrameTs) / 1000);
  state.lastFrameTs = now;

  const frame = applyLocalPrediction(renderData.state, dt);
  drawBackground(frame);
  drawHUD(frame, frame.players[0], frame.players[1]);
  drawPlayer(frame.players[0], now);
  drawPlayer(frame.players[1], now);
  drawOverlay(frame, renderData.status || state.status, frame);
}

window.addEventListener("keydown", (event) => {
  if (!isPlayer) return;
  if (event.repeat) return;
  if (["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(event.key.toLowerCase())) {
    event.preventDefault();
  }
  switch (event.key.toLowerCase()) {
    case "a":
    case "arrowleft":
      state.input.left = true;
      recordDirection();
      if (getRelativeDir() === 6) {
        const now = performance.now();
        if (now - state.lastForwardTap < 240) state.pulse.rush = true;
        state.lastForwardTap = now;
      }
      break;
    case "d":
    case "arrowright":
      state.input.right = true;
      recordDirection();
      if (getRelativeDir() === 6) {
        const now = performance.now();
        if (now - state.lastForwardTap < 240) state.pulse.rush = true;
        state.lastForwardTap = now;
      }
      break;
    case "w":
    case "arrowup":
      state.input.up = true;
      recordDirection();
      break;
    case "s":
    case "arrowdown":
      state.input.down = true;
      recordDirection();
      break;
    case "j":
      state.buttons.lp = true;
      state.buttonPulse.lp = true;
      break;
    case "k":
      state.buttons.mp = true;
      state.buttonPulse.mp = true;
      break;
    case "l":
      state.buttons.hp = true;
      state.buttonPulse.hp = true;
      break;
    case "o":
      state.buttons.hk = true;
      state.buttonPulse.hk = true;
      break;
    case "u":
      state.buttons.lk = true;
      state.buttonPulse.lk = true;
      break;
    case "i":
      state.buttons.mk = true;
      state.buttonPulse.mk = true;
      break;
    default:
      break;
  }
});

window.addEventListener("keyup", (event) => {
  if (!isPlayer) return;
  if (["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(event.key.toLowerCase())) {
    event.preventDefault();
  }
  switch (event.key.toLowerCase()) {
    case "a":
    case "arrowleft":
      state.input.left = false;
      recordDirection();
      break;
    case "d":
    case "arrowright":
      state.input.right = false;
      recordDirection();
      break;
    case "w":
    case "arrowup":
      state.input.up = false;
      recordDirection();
      break;
    case "s":
    case "arrowdown":
      state.input.down = false;
      recordDirection();
      break;
    case "j":
      state.buttons.lp = false;
      break;
    case "k":
      state.buttons.mp = false;
      break;
    case "l":
      state.buttons.hp = false;
      break;
    case "u":
      state.buttons.lk = false;
      break;
    case "i":
      state.buttons.mk = false;
      break;
    case "o":
      state.buttons.hk = false;
      break;
    default:
      break;
  }
});

window.addEventListener("blur", () => {
  state.input.left = false;
  state.input.right = false;
  state.input.up = false;
  state.input.down = false;
  state.pulse.rush = false;
  Object.keys(state.buttons).forEach((key) => {
    state.buttons[key] = false;
  });
  Object.keys(state.buttonPulse).forEach((key) => {
    state.buttonPulse[key] = false;
  });
  state.dirHistory = [];
  state.lastDir = 5;
});

leaveBtn.addEventListener("click", () => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "leave_room" }));
  }
  window.location.href = "/lobby.html";
});

connect();
setInterval(sendInput, 50);
setInterval(() => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "ping", t: performance.now() }));
  }
}, 2000);
render();
