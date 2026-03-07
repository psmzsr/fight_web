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

/**
 * 作用：建立 WebSocket 连接并注册所有网络事件处理器。
 * - 无参数。
 */
function connect() {
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", name: state.name, characterId: state.characterId }));
    // 只有带 roomId 的页面才发起入房请求（直开 game.html 会是空房态）。
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
    // 服务器主状态帧：用于插值渲染和本地预测对齐。
    if (msg.type === "state") {
      state.latest = msg.state;
      state.status = msg.status || "waiting";
      // 仅当包内带 serverTimeMs 时才更新时钟对齐。
      if (typeof msg.serverTimeMs === "number") {
        updateTimeOffset(msg.serverTimeMs);
        pushSnapshot({
          t: msg.serverTimeMs,
          state: msg.state,
          status: state.status,
        });
      }
      // 拿到自己的 clientId 后，才可以定位并更新本地玩家镜像。
      if (state.clientId) {
        const idx = msg.state.players.findIndex((p) => p.clientId === state.clientId);
        // 找不到自己时（如刚进房、角色切换中）跳过本帧自机同步。
        if (idx !== -1) {
          state.selfIndex = idx;
          state.selfServer = clonePlayer(msg.state.players[idx]);
          if (!state.selfPred) {
            state.selfPred = clonePlayer(msg.state.players[idx]);
          }
          const nextFacing = msg.state.players[idx].facing || 1;
          // 朝向发生翻转时清空方向历史，避免误触发搓招序列。
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
        latencyText.textContent = `延迟: ${state.latencyMs} ms`;
      }
      if (typeof msg.serverTimeMs === "number") {
        updateTimeOffset(msg.serverTimeMs);
      }
    }
  });

  ws.addEventListener("close", () => {
    statusText.textContent = "连接断开，正在重连...";
    // 只保留一个重连定时器，避免 close 多次触发导致并发重连。
    if (!state.reconnectTimer) {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        connect();
        state.reconnectDelay = Math.min(8000, state.reconnectDelay * 1.5);
      }, state.reconnectDelay);
    }
  });
}

/**
 * 作用：采集本地输入并发送到服务端。
 * - 无参数。
 */
function sendInput() {
  // 仅玩家身份且连接可用时发送输入，观战不上传输入。
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !isPlayer) return;
  recordDirection();

  const rawPunchStrength = getPunchStrength();
  const rawKickStrength = getKickStrength();

  let punchPressed = state.buttonPulse.lp || state.buttonPulse.mp || state.buttonPulse.hp;
  let kickPressed = state.buttonPulse.lk || state.buttonPulse.mk || state.buttonPulse.hk;
  const parry = state.buttons.mp && state.buttons.mk;
  const impact = (state.buttonPulse.hp && state.buttons.hk) || (state.buttonPulse.hk && state.buttons.hp);

  // MP+MK 招架 / HP+HK 迸发优先级高于普通拳脚，触发后屏蔽普通攻击键。
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

/**
 * 作用：用服务器时间修正客户端时钟偏移。
 * - serverTimeMs：服务器时间戳（毫秒），用于客户端时钟对齐。
 */
function updateTimeOffset(serverTimeMs) {
  const now = performance.now();
  const offset = now - serverTimeMs;
  // 首次对齐直接赋值，后续用平滑滤波避免时钟抖动。
  if (state.timeOffsetMs === null) {
    state.timeOffsetMs = offset;
  } else {
    state.timeOffsetMs = state.timeOffsetMs * 0.9 + offset * 0.1;
  }
}

/**
 * 作用：计算当前估计的服务器时间戳。
 * - 无参数。
 */
function getServerNowMs() {
  // 尚未收到任意带时间戳状态包时，无法估算服务器时间。
  if (state.timeOffsetMs === null) return null;
  return performance.now() - state.timeOffsetMs;
}

/**
 * 作用：把状态快照写入插值缓冲区并做过期清理。
 * - snapshot：状态快照对象，写入插值缓冲区。
 */
function pushSnapshot(snapshot) {
  state.buffer.push(snapshot);
  if (state.buffer.length > 60) state.buffer.shift();
  const latest = snapshot.t;
  while (state.buffer.length && latest - state.buffer[0].t > 5000) {
    state.buffer.shift();
  }
}

/**
 * 作用：把当前方向键转换为相对朝向的数字方向。
 * - 无参数。
 */
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

/**
 * 作用：记录方向历史，供必杀指令识别。
 * - 无参数。
 */
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

/**
 * 作用：检查方向历史是否匹配某个指令序列。
 * - seq：方向序列模式，用于识别指令输入。
 * - maxGapMs：序列识别允许的最大间隔（毫秒）。
 */
function hasSequence(seq, maxGapMs) {
  // 没有方向历史时不可能匹配任何搓招序列。
  if (!state.dirHistory.length) return false;
  let idx = state.dirHistory.length - 1;
  let lastTime = Infinity;
  // 外层循环：从指令尾部向前匹配，例如 236 会先找 6 再找 3/2 再找 2。
  for (let s = seq.length - 1; s >= 0; s -= 1) {
    const dirs = Array.isArray(seq[s]) ? seq[s] : [seq[s]];
    let found = false;
    // 内层循环：在历史输入中倒序搜索当前步骤，保证时间顺序正确。
    for (let i = idx; i >= 0; i -= 1) {
      const item = state.dirHistory[i];
      // 超过允许间隔后提前终止，避免跨太久的输入被误判为连招。
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

/**
 * 作用：识别 22P/236P/214K/空中2K 等特殊输入。
 * - punchPressed：当前帧是否触发拳输入。
 * - kickPressed：当前帧是否触发脚输入。
 */
function detectSpecials(punchPressed, kickPressed) {
  const specials = { special1: false, special2: false, special3: false, special4: false };
  // 空中朝下方向 + K：优先识别为空中 2K（下劈）。
  if (!state.localOnGround && kickPressed && [1, 2, 3].includes(getRelativeDir())) {
    specials.special4 = true;
    return specials;
  }
  // 22P 与 236P 都由拳触发，按优先级先判 22P。
  if (punchPressed && hasSequence([2, 2], 300)) {
    specials.special1 = true;
  } else if (punchPressed && hasSequence([2, [3, 2], 6], 450)) {
    specials.special3 = true;
  }
  // 214K 使用脚触发。
  if (kickPressed && hasSequence([2, [1, 2], 4], 450)) {
    specials.special2 = true;
  }
  return specials;
}

/**
 * 作用：根据拳键脉冲计算当前输入强度。
 * - 无参数。
 */
function getPunchStrength() {
  if (state.buttonPulse.hp) return "h";
  if (state.buttonPulse.mp) return "m";
  if (state.buttonPulse.lp) return "l";
  return "";
}

/**
 * 作用：根据脚键脉冲计算当前输入强度。
 * - 无参数。
 */
function getKickStrength() {
  if (state.buttonPulse.hk) return "h";
  if (state.buttonPulse.mk) return "m";
  if (state.buttonPulse.lk) return "l";
  return "";
}

/**
 * 作用：将数值限制在给定区间内。
 * - value：待裁剪的数值。
 * - min：最小边界值。
 * - max：最大边界值。
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 作用：线性插值。
 * - a：矩形 A 或插值起点对象。
 * - b：矩形 B 或插值终点对象。
 * - t：插值比例（0~1）或时间参数。
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 作用：规范化强度输入，保证只存在 l/m/h 三种合法值。
 * - value：待裁剪的数值。
 */
function normalizeStrength(value) {
  if (value === "l" || value === "m" || value === "h") return value;
  return "m";
}

/**
 * 作用：把 l/m/h 强度映射为动作幅度缩放值。
 * - strength：攻击强度（l/m/h），用于帧数据与伤害修正。
 */
function getStrengthScale(strength) {
  if (strength === "l") return 0.85;
  if (strength === "h") return 1.15;
  return 1;
}

const ATTACK_ROOT_MOTION = {
  punch: { startup: 36, active: 86, recovery: 24 },
  kick: { startup: 42, active: 98, recovery: 30 },
  impact: { startup: 64, active: 144, recovery: 28 },
  rekka1: { startup: 104, active: 192, recovery: 84 },
  rekka2: { startup: 122, active: 214, recovery: 96 },
  rekka3: { startup: 140, active: 238, recovery: 108 },
  bakkai: { startup: 88, active: 164, recovery: 38 },
  divekick: { startup: 0, active: 0, recovery: 0 },
};

/**
 * 作用：根据攻击计时判断当前处于哪一个动作相位。
 * - attack：业务参数，具体含义请结合调用处传入值理解。
 */
function getAttackPhase(attack) {
  if (!attack) return null;
  if (attack.t < attack.activeStart) return "startup";
  if (attack.t <= attack.activeEnd) return "active";
  return "recovery";
}

function getAttackRootMotionSpeed(player) {
  const attack = player?.attack;
  if (!attack) return 0;
  const phase = getAttackPhase(attack);
  if (!phase) return 0;
  const phaseSpeed = ATTACK_ROOT_MOTION[attack.type]?.[phase] || 0;
  if (phaseSpeed <= 0) return 0;
  const strength = normalizeStrength(attack.strength);
  const strengthScale = strength === "l" ? 0.92 : strength === "h" ? 1.1 : 1;
  const burnoutScale = player.burnout ? 0.9 : 1;
  return phaseSpeed * strengthScale * burnoutScale;
}

/**
 * 作用：把攻击进度映射为离散动作帧索引。
 * - attack：业务参数，具体含义请结合调用处传入值理解。
 * - frames：将动画总时长离散成多少帧。
 */
function getAttackFrame(attack, frames = 6) {
  if (!attack) return 0;
  const duration = Math.max(0.001, attack.duration || 0.001);
  const ratio = clamp(attack.t / duration, 0, 0.999);
  return Math.floor(ratio * frames);
}

/**
 * 作用：把攻击实例判定框转换为世界坐标矩形，供碰撞检测使用。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - attack：业务参数，具体含义请结合调用处传入值理解。
 * - phaseOverride：可选相位覆盖值（startup/active/recovery）。
 */
function getAttackHitboxRect(player, attack, phaseOverride) {
  if (!player || !attack) return null;
  const phase = phaseOverride || getAttackPhase(attack) || "active";
  const hb = attack.hitbox?.[phase] || attack.hitbox?.active;
  if (hb) {
    const w = Math.max(8, hb.w || 20);
    const h = Math.max(8, hb.h || 20);
    const offsetX = hb.offsetX || 0;
    const offsetY = hb.offsetY || 0;
    const x = player.facing === 1 ? player.x + player.w + offsetX : player.x - offsetX - w;
    return { x, y: player.y + offsetY, w, h, phase };
  }

  const range = attack.type === "kick" || attack.type === "bakkai" ? 90 : 70;
  const x = player.facing === 1 ? player.x + player.w : player.x - range;
  return { x, y: player.y + 20, w: range, h: player.h - 40, phase };
}

/**
 * 作用：浅拷贝玩家对象（含 attack 子对象）。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 */
function clonePlayer(player) {
  return {
    ...player,
    attack: player.attack ? { ...player.attack } : null,
  };
}

function getPlayerPushbox(player) {
  if (!player) return null;
  let wScale = 0.48;
  let hScale = 0.58;
  let bottomInsetScale = 0.015;

  if (!player.onGround) {
    wScale = 0.44;
    hScale = 0.5;
    bottomInsetScale = 0;
  } else if (player.hp <= 0 || player.action === "down") {
    wScale = 0.64;
    hScale = 0.32;
    bottomInsetScale = 0;
  } else if (player.action === "wallSplat") {
    wScale = 0.46;
    hScale = 0.62;
    bottomInsetScale = 0.02;
  }

  if (player.attack?.type === "bakkai") {
    wScale *= 0.9;
    hScale *= 0.9;
  }

  const w = Math.max(18, player.w * wScale);
  const h = Math.max(34, player.h * hScale);
  return {
    x: player.x + (player.w - w) / 2,
    y: player.y + player.h - h - player.h * bottomInsetScale,
    w,
    h,
  };
}

/**
 * 作用：本地预测阶段的玩家重叠修正。
 * - selfPlayer：本地预测玩家对象。
 * - otherPlayer：另一名玩家对象，用于本地碰撞分离。
 * - arena：场地对象，包含宽高、地面高度和边界信息。
 */
function resolveLocalOverlap(selfPlayer, otherPlayer, arena) {
  if (!selfPlayer || !otherPlayer) return selfPlayer;
  const b1 = getPlayerPushbox(selfPlayer);
  const b2 = getPlayerPushbox(otherPlayer);
  if (!b1 || !b2) return selfPlayer;
  const overlapX = Math.min(b1.x + b1.w, b2.x + b2.w) - Math.max(b1.x, b2.x);
  const overlapY = Math.min(b1.y + b1.h, b2.y + b2.h) - Math.max(b1.y, b2.y);
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

/**
 * 作用：在两个快照间插值，得到平滑渲染状态。
 * - a：矩形 A 或插值起点对象。
 * - b：矩形 B 或插值终点对象。
 * - t：插值比例（0~1）或时间参数。
 */
function interpolateState(a, b, t) {
  const result = {
    width: b.width,
    height: b.height,
    groundY: b.groundY,
    timer: lerp(a.timer, b.timer, t),
    message: b.message,
    winnerId: b.winnerId,
    countdown: b.countdown,
    hitstop: b.hitstop || 0,
    effects: Array.isArray(b.effects) ? b.effects.map((e) => ({ ...e })) : [],
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

/**
 * 作用：客户端本地预测的简化物理模拟。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - input：当前帧输入对象，包含方向键与攻击键状态。
 * - dt：单帧时间步长（秒），用于所有时间递减与物理更新。
 * - arena：场地对象，包含宽高、地面高度和边界信息。
 */
function simulatePlayer(player, input, dt, arena) {
  const burnoutScale = player.burnout ? 0.88 : 1;
  const SPEED = (player.stats?.speed ?? 300) * burnoutScale;
  const JUMP = (player.stats?.jump ?? -850) * (player.burnout ? 0.95 : 1);
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
    } else if (p.onGround && p.attack) {
      const attackMotion = getAttackRootMotionSpeed(p);
      if (attackMotion > 0) p.vx = attackMotion * p.facing;
      else if (input.left && !input.right) p.vx = -SPEED;
      else if (input.right && !input.left) p.vx = SPEED;
      else p.vx *= FRICTION;
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

/**
 * 作用：按插值延迟从快照缓冲中取当前渲染状态。
 * - 无参数。
 */
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
  // 在快照队列中找到“刚好包住 renderTimeMs”的两帧，供后续插值平滑显示。
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

/**
 * 作用：把本地预测叠加到渲染状态，降低输入延迟感。
 * - frame：当前渲染帧状态对象（包含 players、场地信息、hitstop、effects）。
 * - dt：单帧时间步长（秒），用于所有时间递减与物理更新。
 */
function applyLocalPrediction(frame, dt) {
  // 观战模式或尚未拿到 clientId 时，不做本地预测。
  if (!isPlayer || !state.clientId) return frame;
  const players = frame.players;
  const idx =
    state.selfIndex !== null && state.selfIndex !== undefined
      ? state.selfIndex
      : players.findIndex((p) => p.clientId === state.clientId);
  // 当前帧没找到自己（极端同步边界）时，直接回退到服务器帧。
  if (idx === -1) return frame;

  // 首帧建立自机预测副本。
  if (!state.selfPred) {
    state.selfPred = clonePlayer(players[idx]);
  }

  // 命中停顿时禁止本地继续模拟，避免出现“服务器停住但本地还在走”的错位。
  if ((frame.hitstop || 0) > 0) {
    if (state.selfServer) {
      state.selfPred = clonePlayer(state.selfServer);
      players[idx] = state.selfPred;
    }
    return frame;
  }

  state.selfPred = simulatePlayer(state.selfPred, state.input, dt, frame);

  if (state.selfServer) {
    const server = state.selfServer;
    const pred = state.selfPred;
    const dx = server.x - pred.x;
    const dy = server.y - pred.y;
    const dist = Math.hypot(dx, dy);
    // 误差过大直接硬同步，误差较小时用缓和靠拢避免瞬移感。
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
    pred.counterTimer = server.counterTimer;
    pred.parryTimer = server.parryTimer;
    pred.rushBuffTimer = server.rushBuffTimer;
  }

  players[idx] = state.selfPred;
  const otherIdx = idx === 0 ? 1 : 0;
  // 叠加本地预测后再做一次玩家间分离，减少自机穿模观感。
  if (players[otherIdx]) {
    players[idx] = resolveLocalOverlap(players[idx], players[otherIdx], frame);
  }
  return frame;
}

/**
 * 作用：绘制场景背景和地面线。
 * - arena：场地对象，包含宽高、地面高度和边界信息。
 */
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

/**
 * 作用：绘制血条、架势条、连击、counter 等 HUD。
 * - arena：场地对象，包含宽高、地面高度和边界信息。
 * - p1：玩家 1 的状态对象。
 * - p2：玩家 2 的状态对象。
 */
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

  if ((p1.rushBuffTimer || 0) > 0) {
    ctx.fillStyle = "#6ee7ff";
    ctx.font = "13px Segoe UI";
    ctx.fillText("绿冲优势", padding, 84);
  }
  if ((p2.rushBuffTimer || 0) > 0) {
    ctx.fillStyle = "#6ee7ff";
    ctx.font = "13px Segoe UI";
    const text = "绿冲优势";
    const width = ctx.measureText(text).width;
    ctx.fillText(text, arena.width - padding - width, 84);
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

  if ((p1.counterTimer || 0) > 0) {
    ctx.fillStyle = "#ffd166";
    ctx.font = "bold 18px Segoe UI";
    ctx.fillText("COUNTER", padding, 114);
  }
  if ((p2.counterTimer || 0) > 0) {
    ctx.fillStyle = "#ffd166";
    ctx.font = "bold 18px Segoe UI";
    const text = "COUNTER";
    const width = ctx.measureText(text).width;
    ctx.fillText(text, arena.width - padding - width, 114);
  }
}

/**
 * 作用：根据长度和角度计算朝向相关的二维向量。
 * - len：业务参数，具体含义请结合调用处传入值理解。
 * - angle：业务参数，具体含义请结合调用处传入值理解。
 * - facing：业务参数，具体含义请结合调用处传入值理解。
 */
function vec(len, angle, facing) {
  return { dx: len * Math.cos(angle) * facing, dy: len * Math.sin(angle) };
}

// 用两段骨骼绘制肢体，提升火柴人动作的层次感。
function drawJointLimb(originX, originY, len, angle, facing, bend) {
  const upperLen = len * 0.56;
  const lowerLen = len - upperLen;
  const upper = vec(upperLen, angle, facing);
  const elbowX = originX + upper.dx;
  const elbowY = originY + upper.dy;
  const lower = vec(lowerLen, angle + bend, facing);
  const endX = elbowX + lower.dx;
  const endY = elbowY + lower.dy;

  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  return { elbowX, elbowY, endX, endY };
}

// 高速移动/攻击时绘制残影线条，增强速度感。
function drawActionTrail(player, facing, timeMs, intensity) {
  if (intensity <= 0.2) return;
  const pulse = Math.sin(timeMs * 0.02) * 4;
  ctx.save();
  ctx.strokeStyle = `rgba(130,210,255,${clamp(0.08 + intensity * 0.12, 0.08, 0.22)})`;
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i += 1) {
    const baseX = player.x + player.w * (0.45 - facing * 0.02) - facing * (12 + i * 10);
    const baseY = player.y + player.h * (0.54 + i * 0.06);
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.lineTo(baseX - facing * (16 + pulse), baseY - 8);
    ctx.stroke();
  }
  ctx.restore();
}

// 攻击阶段绘制挥击弧线，让动作读感更清晰。
function drawAttackSwing(player, shoulderX, shoulderY, facing, phase, timeMs) {
  if (!player.attack || phase === "recovery") return;
  const type = player.attack.type || "";
  const active = phase === "active";
  const progress = clamp(player.attack.t / Math.max(0.001, player.attack.duration || 0.001), 0, 1);
  const pulse = Math.sin((timeMs + progress * 400) * 0.02) * 0.08;

  let color = "120,220,255";
  let radius = 28 + (player.attack.range || 70) * 0.24;
  let sweep = 0.9;
  if (type === "impact") {
    color = "255,168,120";
    radius = 50;
    sweep = 1.35;
  } else if (type === "bakkai" || type === "divekick") {
    color = "255,210,150";
    radius = 46;
    sweep = 1.2;
  } else if (type.startsWith("rekka")) {
    color = "255,190,120";
    radius = 38;
    sweep = 1.05;
  }

  const half = sweep * (active ? 0.55 : 0.38) * (1 + pulse);
  const base = facing === 1 ? -0.18 : Math.PI + 0.18;
  const alpha = active ? 0.38 : 0.22;

  ctx.save();
  ctx.strokeStyle = `rgba(${color},${alpha})`;
  ctx.lineWidth = active ? 4 : 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(shoulderX, shoulderY + 6, radius, base - half, base + half, facing === -1);
  ctx.stroke();
  ctx.restore();
}

const POSE_NUM_FIELDS = [
  "frontArmAngle",
  "backArmAngle",
  "frontLegAngle",
  "backLegAngle",
  "frontArmBend",
  "backArmBend",
  "frontLegBend",
  "backLegBend",
  "torsoLean",
  "torsoDir",
  "offsetX",
  "offsetY",
  "shoulderShift",
  "armBend",
  "legBend",
];

// 逐招式关键帧：每招按 startup/active/recovery 三段定义姿态轨迹。
const ATTACK_POSE_TRACKS = {
  punch: {
    startup: [
      { t: 0, frontArmAngle: -1.68, backArmAngle: -1.72, frontLegAngle: 1.38, backLegAngle: 1.86, torsoLean: -0.12, armBend: 0.56, legBend: -0.58 },
      { t: 0.5, frontArmAngle: -1.45, backArmAngle: -1.58, frontLegAngle: 1.34, backLegAngle: 1.84, torsoLean: -0.08, armBend: 0.52, legBend: -0.58 },
      { t: 1, frontArmAngle: -1.22, backArmAngle: -1.42, frontLegAngle: 1.28, backLegAngle: 1.88, torsoLean: -0.04, armBend: 0.5, legBend: -0.56 },
    ],
    active: [
      { t: 0, frontArmAngle: -0.4, backArmAngle: -1.05, frontLegAngle: 1.22, backLegAngle: 1.9, torsoLean: 0.04, armBend: 0.44, legBend: -0.56 },
      { t: 0.45, frontArmAngle: 0.42, backArmAngle: -0.82, frontLegAngle: 1.18, backLegAngle: 1.96, torsoLean: 0.2, armBend: 0.34, legBend: -0.52 },
      { t: 1, frontArmAngle: 0.08, backArmAngle: -0.92, frontLegAngle: 1.24, backLegAngle: 1.92, torsoLean: 0.1, armBend: 0.36, legBend: -0.54 },
    ],
    recovery: [
      { t: 0, frontArmAngle: -0.3, backArmAngle: -1.02, frontLegAngle: 1.28, backLegAngle: 1.88, torsoLean: 0.08, armBend: 0.4, legBend: -0.56 },
      { t: 0.6, frontArmAngle: -0.62, backArmAngle: -1.24, frontLegAngle: 1.31, backLegAngle: 1.84, torsoLean: 0.05, armBend: 0.48, legBend: -0.58 },
      { t: 1, frontArmAngle: -0.9, backArmAngle: -1.14, frontLegAngle: 1.35, backLegAngle: 1.8, torsoLean: 0.02, armBend: 0.52, legBend: -0.6 },
    ],
  },
  kick: {
    startup: [
      { t: 0, frontArmAngle: -0.82, backArmAngle: -1.42, frontLegAngle: 1.35, backLegAngle: 2.05, torsoLean: -0.1, armBend: 0.48, legBend: -0.52 },
      { t: 0.5, frontArmAngle: -0.62, backArmAngle: -1.28, frontLegAngle: 1.18, backLegAngle: 2.12, torsoLean: -0.04, armBend: 0.46, legBend: -0.46 },
      { t: 1, frontArmAngle: -0.46, backArmAngle: -1.18, frontLegAngle: 1.0, backLegAngle: 2.2, torsoLean: 0.02, armBend: 0.42, legBend: -0.42 },
    ],
    active: [
      { t: 0, frontArmAngle: -0.42, backArmAngle: -1.2, frontLegAngle: 0.5, backLegAngle: 2.26, torsoLean: 0.12, armBend: 0.36, legBend: -0.38 },
      { t: 0.45, frontArmAngle: -0.24, backArmAngle: -1.08, frontLegAngle: 0.12, backLegAngle: 2.35, torsoLean: 0.22, armBend: 0.32, legBend: -0.32 },
      { t: 1, frontArmAngle: -0.36, backArmAngle: -1.14, frontLegAngle: 0.46, backLegAngle: 2.2, torsoLean: 0.14, armBend: 0.34, legBend: -0.36 },
    ],
    recovery: [
      { t: 0, frontArmAngle: -0.46, backArmAngle: -1.22, frontLegAngle: 0.92, backLegAngle: 2.02, torsoLean: 0.1, armBend: 0.42, legBend: -0.46 },
      { t: 0.6, frontArmAngle: -0.62, backArmAngle: -1.26, frontLegAngle: 1.1, backLegAngle: 1.92, torsoLean: 0.06, armBend: 0.46, legBend: -0.54 },
      { t: 1, frontArmAngle: -0.82, backArmAngle: -1.16, frontLegAngle: 1.28, backLegAngle: 1.82, torsoLean: 0.02, armBend: 0.5, legBend: -0.6 },
    ],
  },
  impact: {
    startup: [
      { t: 0, frontArmAngle: -0.62, backArmAngle: -0.84, frontLegAngle: 1.44, backLegAngle: 1.94, torsoLean: -0.08, armBend: 0.52, legBend: -0.56 },
      { t: 0.6, frontArmAngle: -0.4, backArmAngle: -0.62, frontLegAngle: 1.4, backLegAngle: 1.9, torsoLean: -0.02, armBend: 0.46, legBend: -0.54 },
      { t: 1, frontArmAngle: -0.18, backArmAngle: -0.38, frontLegAngle: 1.34, backLegAngle: 1.86, torsoLean: 0.08, armBend: 0.42, legBend: -0.52 },
    ],
    active: [
      { t: 0, frontArmAngle: 0.18, backArmAngle: -0.08, frontLegAngle: 1.32, backLegAngle: 1.86, torsoLean: 0.14, armBend: 0.34, legBend: -0.5 },
      { t: 0.45, frontArmAngle: 0.6, backArmAngle: 0.32, frontLegAngle: 1.3, backLegAngle: 1.84, torsoLean: 0.28, armBend: 0.24, legBend: -0.48 },
      { t: 1, frontArmAngle: 0.32, backArmAngle: 0.18, frontLegAngle: 1.34, backLegAngle: 1.84, torsoLean: 0.18, armBend: 0.3, legBend: -0.5 },
    ],
    recovery: [
      { t: 0, frontArmAngle: -0.02, backArmAngle: -0.18, frontLegAngle: 1.36, backLegAngle: 1.86, torsoLean: 0.12, armBend: 0.36, legBend: -0.52 },
      { t: 0.55, frontArmAngle: -0.26, backArmAngle: -0.46, frontLegAngle: 1.38, backLegAngle: 1.84, torsoLean: 0.08, armBend: 0.42, legBend: -0.54 },
      { t: 1, frontArmAngle: -0.5, backArmAngle: -0.78, frontLegAngle: 1.4, backLegAngle: 1.82, torsoLean: 0.04, armBend: 0.48, legBend: -0.56 },
    ],
  },
  bakkai: {
    startup: [
      { t: 0, frontArmAngle: -0.24, backArmAngle: -0.7, frontLegAngle: 1.64, backLegAngle: 2.3, torsoLean: 0.18, armBend: 0.54, legBend: -0.42 },
      { t: 0.45, frontArmAngle: 0.02, backArmAngle: -0.4, frontLegAngle: 1.2, backLegAngle: 2.46, torsoLean: 0.26, armBend: 0.48, legBend: -0.28 },
      { t: 1, frontArmAngle: 0.28, backArmAngle: -0.04, frontLegAngle: 0.54, backLegAngle: 2.62, torsoLean: 0.34, armBend: 0.4, legBend: -0.1 },
    ],
    active: [
      { t: 0, frontArmAngle: 0.34, backArmAngle: 0.1, frontLegAngle: -0.3, backLegAngle: 0.22, torsoLean: 0.34, armBend: 0.34, legBend: 0.08 },
      { t: 0.45, frontArmAngle: 0.6, backArmAngle: 0.28, frontLegAngle: -0.74, backLegAngle: -0.24, torsoLean: 0.42, armBend: 0.24, legBend: 0.18 },
      { t: 1, frontArmAngle: 0.46, backArmAngle: 0.14, frontLegAngle: -0.42, backLegAngle: 0.04, torsoLean: 0.3, armBend: 0.28, legBend: 0.12 },
    ],
    recovery: [
      { t: 0, frontArmAngle: 0.04, backArmAngle: -0.34, frontLegAngle: 0.64, backLegAngle: 2.22, torsoLean: 0.22, armBend: 0.38, legBend: -0.24 },
      { t: 0.6, frontArmAngle: -0.22, backArmAngle: -0.74, frontLegAngle: 1.06, backLegAngle: 2.02, torsoLean: 0.12, armBend: 0.46, legBend: -0.44 },
      { t: 1, frontArmAngle: -0.4, backArmAngle: -1.02, frontLegAngle: 1.28, backLegAngle: 1.86, torsoLean: 0.06, armBend: 0.52, legBend: -0.56 },
    ],
  },
  divekick: {
    startup: [
      { t: 0, frontArmAngle: -0.62, backArmAngle: -1.22, frontLegAngle: 1.04, backLegAngle: 2.28, torsoLean: 0.12, armBend: 0.5, legBend: -0.34 },
      { t: 0.5, frontArmAngle: -0.78, backArmAngle: -1.36, frontLegAngle: 0.82, backLegAngle: 2.42, torsoLean: 0.2, armBend: 0.44, legBend: -0.2 },
      { t: 1, frontArmAngle: -0.96, backArmAngle: -1.5, frontLegAngle: 0.64, backLegAngle: 2.5, torsoLean: 0.28, armBend: 0.38, legBend: -0.12 },
    ],
    active: [
      { t: 0, frontArmAngle: -1.02, backArmAngle: -1.56, frontLegAngle: 0.42, backLegAngle: 2.56, torsoLean: 0.28, armBend: 0.32, legBend: -0.08 },
      { t: 0.5, frontArmAngle: -1.14, backArmAngle: -1.64, frontLegAngle: 0.12, backLegAngle: 2.62, torsoLean: 0.34, armBend: 0.28, legBend: -0.02 },
      { t: 1, frontArmAngle: -1.06, backArmAngle: -1.58, frontLegAngle: 0.3, backLegAngle: 2.56, torsoLean: 0.3, armBend: 0.3, legBend: -0.06 },
    ],
    recovery: [
      { t: 0, frontArmAngle: -0.82, backArmAngle: -1.4, frontLegAngle: 0.84, backLegAngle: 2.26, torsoLean: 0.18, armBend: 0.38, legBend: -0.24 },
      { t: 0.55, frontArmAngle: -0.64, backArmAngle: -1.2, frontLegAngle: 1.06, backLegAngle: 2.04, torsoLean: 0.1, armBend: 0.44, legBend: -0.44 },
      { t: 1, frontArmAngle: -0.56, backArmAngle: -1.1, frontLegAngle: 1.18, backLegAngle: 1.9, torsoLean: 0.04, armBend: 0.5, legBend: -0.58 },
    ],
  },
  rekka1: {
    startup: [
      { t: 0, frontArmAngle: -1.58, backArmAngle: -1.72, frontLegAngle: 1.3, backLegAngle: 1.98, torsoLean: -0.08, offsetX: 0, shoulderShift: 0, armBend: 0.54, legBend: -0.58 },
      { t: 0.5, frontArmAngle: -1.42, backArmAngle: -1.62, frontLegAngle: 1.24, backLegAngle: 2.0, torsoLean: -0.04, offsetX: 2, shoulderShift: 1.5, armBend: 0.5, legBend: -0.54 },
      { t: 1, frontArmAngle: -1.2, backArmAngle: -1.5, frontLegAngle: 1.18, backLegAngle: 2.04, torsoLean: 0.02, offsetX: 4, shoulderShift: 3, armBend: 0.44, legBend: -0.5 },
    ],
    active: [
      { t: 0, frontArmAngle: 0.18, backArmAngle: -0.94, frontLegAngle: 1.16, backLegAngle: 2.02, torsoLean: 0.12, offsetX: 6, shoulderShift: 4, armBend: 0.32, legBend: -0.48 },
      { t: 0.45, frontArmAngle: 0.46, backArmAngle: -0.78, frontLegAngle: 1.1, backLegAngle: 2.08, torsoLean: 0.22, offsetX: 8, shoulderShift: 5.5, armBend: 0.24, legBend: -0.44 },
      { t: 1, frontArmAngle: 0.28, backArmAngle: -0.86, frontLegAngle: 1.14, backLegAngle: 2.02, torsoLean: 0.16, offsetX: 6.5, shoulderShift: 4.2, armBend: 0.28, legBend: -0.46 },
    ],
    recovery: [
      { t: 0, frontArmAngle: -0.24, backArmAngle: -1.02, frontLegAngle: 1.2, backLegAngle: 1.94, torsoLean: 0.1, offsetX: 4.2, shoulderShift: 2.8, armBend: 0.36, legBend: -0.5 },
      { t: 0.6, frontArmAngle: -0.52, backArmAngle: -1.2, frontLegAngle: 1.26, backLegAngle: 1.88, torsoLean: 0.06, offsetX: 2, shoulderShift: 1.2, armBend: 0.44, legBend: -0.54 },
      { t: 1, frontArmAngle: -0.76, backArmAngle: -1.14, frontLegAngle: 1.3, backLegAngle: 1.84, torsoLean: 0.03, offsetX: 0, shoulderShift: 0, armBend: 0.5, legBend: -0.58 },
    ],
  },
  rekka2: {
    startup: [
      { t: 0, frontArmAngle: -1.56, backArmAngle: -1.68, frontLegAngle: 1.28, backLegAngle: 2.0, torsoLean: -0.1, offsetX: 0, shoulderShift: 0, armBend: 0.54, legBend: -0.58 },
      { t: 0.5, frontArmAngle: -1.38, backArmAngle: -1.54, frontLegAngle: 1.2, backLegAngle: 2.04, torsoLean: -0.02, offsetX: 3, shoulderShift: 2.2, armBend: 0.5, legBend: -0.54 },
      { t: 1, frontArmAngle: -1.14, backArmAngle: -1.4, frontLegAngle: 1.14, backLegAngle: 2.08, torsoLean: 0.06, offsetX: 5.2, shoulderShift: 3.8, armBend: 0.42, legBend: -0.48 },
    ],
    active: [
      { t: 0, frontArmAngle: 0.24, backArmAngle: -0.88, frontLegAngle: 1.1, backLegAngle: 2.08, torsoLean: 0.16, offsetX: 8, shoulderShift: 5.6, armBend: 0.3, legBend: -0.44 },
      { t: 0.45, frontArmAngle: 0.62, backArmAngle: -0.72, frontLegAngle: 1.02, backLegAngle: 2.14, torsoLean: 0.28, offsetX: 10.5, shoulderShift: 7.2, armBend: 0.2, legBend: -0.38 },
      { t: 1, frontArmAngle: 0.4, backArmAngle: -0.8, frontLegAngle: 1.08, backLegAngle: 2.08, torsoLean: 0.2, offsetX: 8.6, shoulderShift: 6, armBend: 0.24, legBend: -0.42 },
    ],
    recovery: [
      { t: 0, frontArmAngle: -0.18, backArmAngle: -0.96, frontLegAngle: 1.18, backLegAngle: 1.98, torsoLean: 0.12, offsetX: 5.6, shoulderShift: 3.8, armBend: 0.34, legBend: -0.48 },
      { t: 0.6, frontArmAngle: -0.46, backArmAngle: -1.16, frontLegAngle: 1.24, backLegAngle: 1.9, torsoLean: 0.06, offsetX: 2.4, shoulderShift: 1.5, armBend: 0.42, legBend: -0.54 },
      { t: 1, frontArmAngle: -0.72, backArmAngle: -1.1, frontLegAngle: 1.3, backLegAngle: 1.84, torsoLean: 0.03, offsetX: 0, shoulderShift: 0, armBend: 0.5, legBend: -0.58 },
    ],
  },
  rekka3: {
    startup: [
      { t: 0, frontArmAngle: -1.52, backArmAngle: -1.64, frontLegAngle: 1.24, backLegAngle: 2.02, torsoLean: -0.12, offsetX: 0, shoulderShift: 0, armBend: 0.54, legBend: -0.58 },
      { t: 0.5, frontArmAngle: -1.28, backArmAngle: -1.44, frontLegAngle: 1.14, backLegAngle: 2.1, torsoLean: 0.0, offsetX: 3.6, shoulderShift: 2.8, armBend: 0.48, legBend: -0.52 },
      { t: 1, frontArmAngle: -1.0, backArmAngle: -1.2, frontLegAngle: 1.06, backLegAngle: 2.16, torsoLean: 0.1, offsetX: 6.5, shoulderShift: 4.8, armBend: 0.4, legBend: -0.44 },
    ],
    active: [
      { t: 0, frontArmAngle: 0.34, backArmAngle: -0.74, frontLegAngle: 1.06, backLegAngle: 2.16, torsoLean: 0.22, offsetX: 10.5, shoulderShift: 7.2, armBend: 0.26, legBend: -0.38 },
      { t: 0.45, frontArmAngle: 0.78, backArmAngle: -0.56, frontLegAngle: 0.96, backLegAngle: 2.24, torsoLean: 0.36, offsetX: 13, shoulderShift: 9.2, armBend: 0.16, legBend: -0.3 },
      { t: 1, frontArmAngle: 0.52, backArmAngle: -0.66, frontLegAngle: 1.04, backLegAngle: 2.16, torsoLean: 0.26, offsetX: 10.8, shoulderShift: 7.6, armBend: 0.2, legBend: -0.36 },
    ],
    recovery: [
      { t: 0, frontArmAngle: -0.12, backArmAngle: -0.9, frontLegAngle: 1.14, backLegAngle: 2.02, torsoLean: 0.14, offsetX: 6.6, shoulderShift: 4.4, armBend: 0.3, legBend: -0.46 },
      { t: 0.6, frontArmAngle: -0.44, backArmAngle: -1.12, frontLegAngle: 1.24, backLegAngle: 1.92, torsoLean: 0.07, offsetX: 2.8, shoulderShift: 1.8, armBend: 0.4, legBend: -0.54 },
      { t: 1, frontArmAngle: -0.68, backArmAngle: -1.06, frontLegAngle: 1.32, backLegAngle: 1.84, torsoLean: 0.04, offsetX: 0, shoulderShift: 0, armBend: 0.5, legBend: -0.58 },
    ],
  },
};

function interpolatePoseFrames(a, b, t) {
  const out = {};
  POSE_NUM_FIELDS.forEach((field) => {
    const av = typeof a[field] === "number" ? a[field] : undefined;
    const bv = typeof b[field] === "number" ? b[field] : undefined;
    if (av === undefined && bv === undefined) return;
    if (av === undefined) out[field] = bv;
    else if (bv === undefined) out[field] = av;
    else out[field] = lerp(av, bv, t);
  });
  return out;
}

function sampleAttackPoseTrack(attackType, phase, progress) {
  const phaseTrack = ATTACK_POSE_TRACKS[attackType]?.[phase];
  if (!Array.isArray(phaseTrack) || !phaseTrack.length) return null;
  if (progress <= phaseTrack[0].t) {
    const { t, ...pose } = phaseTrack[0];
    return pose;
  }
  const last = phaseTrack[phaseTrack.length - 1];
  if (progress >= last.t) {
    const { t, ...pose } = last;
    return pose;
  }
  for (let i = 0; i < phaseTrack.length - 1; i += 1) {
    const a = phaseTrack[i];
    const b = phaseTrack[i + 1];
    if (a.t <= progress && progress <= b.t) {
      const span = Math.max(0.0001, b.t - a.t);
      const localT = (progress - a.t) / span;
      return interpolatePoseFrames(a, b, localT);
    }
  }
  return null;
}

function getPhaseProgressFromAttack(attack, phase) {
  if (!attack) return 0;
  if (phase === "startup") {
    return clamp(attack.t / Math.max(0.001, attack.activeStart || 0.001), 0, 1);
  }
  if (phase === "active") {
    return clamp(
      (attack.t - (attack.activeStart || 0)) / Math.max(0.001, (attack.activeEnd || 0) - (attack.activeStart || 0)),
      0,
      1
    );
  }
  return clamp(
    (attack.t - (attack.activeEnd || 0)) / Math.max(0.001, (attack.duration || 0) - (attack.activeEnd || 0)),
    0,
    1
  );
}

function getAttackPoseByTrack(
  attackType,
  phase,
  phaseProgress,
  strength,
  strengthScale,
  twoDrink,
  frameNudge,
  attackEase,
  facing
) {
  const sampled = sampleAttackPoseTrack(attackType, phase, phaseProgress);
  if (!sampled) return null;

  const pose = { ...sampled };
  const strengthDelta = strengthScale - 1;
  pose.type = attackType.startsWith("rekka") ? "rekka" : attackType;
  pose.frontArmAngle = (pose.frontArmAngle ?? -0.9) + frameNudge * 0.42;
  pose.backArmAngle = (pose.backArmAngle ?? -1.1) + frameNudge * 0.14;

  if (attackType === "punch" || attackType.startsWith("rekka")) {
    pose.torsoLean = (pose.torsoLean ?? 0) + 0.08 * strengthDelta;
  }
  if (attackType === "kick" || attackType === "bakkai" || attackType === "divekick") {
    pose.frontLegAngle = (pose.frontLegAngle ?? 1.2) - 0.2 * strengthDelta;
    pose.backLegAngle = (pose.backLegAngle ?? 1.9) + 0.08 * strengthDelta;
  }
  if (attackType === "bakkai") {
    // 214K（倒立旋踢）：分阶段做“落手支撑 -> 倒立旋转 -> 回身落地”。
    const kickScale = strength === "h" ? 1.1 : strength === "l" ? 0.92 : 1;
    const spin = Math.sin(phaseProgress * Math.PI * 1.35);
    const open = Math.cos(phaseProgress * Math.PI * 1.35);

    const plantedArm = { frontAngle: 1.44, backAngle: 1.66, frontBend: -0.08, backBend: -0.14 };
    const guardArm = { frontAngle: 0.62, backAngle: 0.94, frontBend: -1.12, backBend: -1.36 };

    if (phase === "startup") {
      pose.torsoDir = lerp(1, -0.78, phaseProgress);
      pose.frontArmAngle = lerp(guardArm.frontAngle, plantedArm.frontAngle, phaseProgress);
      pose.backArmAngle = lerp(guardArm.backAngle, plantedArm.backAngle, phaseProgress);
      pose.frontArmBend = lerp(guardArm.frontBend, plantedArm.frontBend, phaseProgress);
      pose.backArmBend = lerp(guardArm.backBend, plantedArm.backBend, phaseProgress);
      pose.frontLegAngle = lerp(pose.frontLegAngle ?? 1.28, -0.26 * kickScale, phaseProgress);
      pose.backLegAngle = lerp(pose.backLegAngle ?? 2.2, -1.74, phaseProgress);
      pose.frontLegBend = lerp(-0.34, 0.28, phaseProgress);
      pose.backLegBend = lerp(-0.22, 0.86, phaseProgress);
      pose.torsoLean = lerp(0.2, twoDrink ? 0.46 : 0.42, phaseProgress);
      pose.offsetX = (pose.offsetX || 0) + 6.2 * phaseProgress * kickScale;
      pose.offsetY = (pose.offsetY || 0) - 13.5 * phaseProgress;
      pose.shoulderShift = (pose.shoulderShift || 0) + 3 * phaseProgress;
    } else if (phase === "active") {
      pose.torsoDir = -0.9;
      pose.frontArmAngle = plantedArm.frontAngle + spin * 0.08;
      pose.backArmAngle = plantedArm.backAngle - spin * 0.08;
      pose.frontArmBend = plantedArm.frontBend;
      pose.backArmBend = plantedArm.backBend;
      pose.frontLegAngle = -0.38 + spin * 0.96 * kickScale;
      pose.backLegAngle = -2.48 + spin * 0.88 * kickScale;
      pose.frontLegBend = 0.1 + open * 0.3;
      pose.backLegBend = 0.18 - open * 0.34;
      pose.torsoLean = (twoDrink ? 0.54 : 0.5) + spin * 0.05;
      pose.offsetX = (pose.offsetX || 0) + (8 + phaseProgress * 5.2) * kickScale;
      pose.offsetY = (pose.offsetY || 0) - 16 + spin * 0.8;
      pose.shoulderShift = (pose.shoulderShift || 0) + 5.4;
    } else {
      pose.torsoDir = lerp(-0.9, 1, phaseProgress);
      pose.frontArmAngle = lerp(plantedArm.frontAngle, guardArm.frontAngle, phaseProgress);
      pose.backArmAngle = lerp(plantedArm.backAngle, guardArm.backAngle, phaseProgress);
      pose.frontArmBend = lerp(plantedArm.frontBend, guardArm.frontBend, phaseProgress);
      pose.backArmBend = lerp(plantedArm.backBend, guardArm.backBend, phaseProgress);
      pose.frontLegAngle = lerp(-0.26, 1.22, phaseProgress);
      pose.backLegAngle = lerp(-1.76, 1.96, phaseProgress);
      pose.frontLegBend = lerp(0.3, -0.46, phaseProgress);
      pose.backLegBend = lerp(0.82, -0.24, phaseProgress);
      pose.torsoLean = lerp(twoDrink ? 0.46 : 0.42, 0.08, phaseProgress);
      pose.offsetX = (pose.offsetX || 0) + (12.4 - phaseProgress * 8.8) * kickScale;
      pose.offsetY = (pose.offsetY || 0) + (-14 + phaseProgress * 14);
      pose.shoulderShift = (pose.shoulderShift || 0) + (3.2 - phaseProgress * 2.2);
    }
  }
  if (attackType === "divekick") {
    // 空中下踢改成“前腿下斩 + 后腿回收 + 双臂抱架”构图。
    const strikeRatio = phase === "startup" ? phaseProgress : phase === "active" ? 1 : 1 - phaseProgress;
    const reachScale = strength === "h" ? 1.08 : strength === "l" ? 0.94 : 1;
    const forwardScale = facing === 1 ? 1 : -1;

    const guardFrontArm = { angle: 0.74, bend: -1.26 };
    const guardBackArm = { angle: 1.04, bend: -1.42 };
    const strikeFrontArm = { angle: 0.62, bend: -1.86 };
    const strikeBackArm = { angle: 0.88, bend: -1.98 };

    pose.frontArmAngle = lerp(guardFrontArm.angle, strikeFrontArm.angle, strikeRatio);
    pose.backArmAngle = lerp(guardBackArm.angle, strikeBackArm.angle, strikeRatio);
    pose.frontArmBend = lerp(guardFrontArm.bend, strikeFrontArm.bend, strikeRatio);
    pose.backArmBend = lerp(guardBackArm.bend, strikeBackArm.bend, strikeRatio);

    pose.frontLegAngle = lerp(pose.frontLegAngle ?? 1.12, 0.92, strikeRatio * reachScale);
    pose.frontLegBend = lerp(-0.2, 0.02, strikeRatio);

    // 后腿向后上方收折，形成你图里“后腿回收”的轮廓。
    pose.backLegAngle = lerp(pose.backLegAngle ?? 2.1, -2.36, strikeRatio);
    pose.backLegBend = lerp(0.32, 1.54, strikeRatio);

    pose.torsoLean = lerp(0.08, 0.36, strikeRatio);
    pose.shoulderShift = (pose.shoulderShift || 0) + 1.8 * strikeRatio;
    pose.offsetX = (pose.offsetX || 0) + 2.2 * strikeRatio * forwardScale;
    pose.offsetY = (pose.offsetY || 0) - 2.8 * strikeRatio;
  }
  if (attackType === "kick" && strength === "l") {
    // 轻腿改为“提膝前抬”的快踢形态：支撑腿更直、踢腿明显上抬。
    const strikeRatio = phase === "startup" ? phaseProgress : phase === "active" ? 1 : 1 - phaseProgress;
    const guardFrontArm = { angle: 0.54, bend: -1.24 };
    const guardBackArm = { angle: 0.9, bend: -1.48 };
    const strikeFrontArm = { angle: 0.46, bend: -1.08 };
    const strikeBackArm = { angle: 0.78, bend: -1.24 };

    pose.frontArmAngle = lerp(guardFrontArm.angle, strikeFrontArm.angle, strikeRatio);
    pose.backArmAngle = lerp(guardBackArm.angle, strikeBackArm.angle, strikeRatio);
    pose.frontArmBend = lerp(guardFrontArm.bend, strikeFrontArm.bend, strikeRatio);
    pose.backArmBend = lerp(guardBackArm.bend, strikeBackArm.bend, strikeRatio);

    pose.frontLegAngle = lerp(pose.frontLegAngle ?? 1.2, -0.38, strikeRatio);
    pose.backLegAngle = lerp(pose.backLegAngle ?? 2.0, 1.56, strikeRatio);
    pose.frontLegBend = lerp(-0.2, 0.06, strikeRatio);
    pose.backLegBend = lerp(0.1, -0.04, strikeRatio);
    pose.torsoLean = lerp(0, -0.04, strikeRatio);
    pose.offsetY = (pose.offsetY || 0) - 2.4 * strikeRatio;
    pose.offsetX = (pose.offsetX || 0) + 1.6 * strikeRatio;
  }
  if (attackType === "kick" && strength === "m") {
    // 中腿改为“中段横踢”：前腿横向打出，后腿蹬地支撑，躯干带明显前压。
    const strikeRatio = phase === "startup" ? phaseProgress : phase === "active" ? 1 : 1 - phaseProgress;
    const guardFrontArm = { angle: 0.54, bend: -1.24 };
    const guardBackArm = { angle: 0.9, bend: -1.48 };
    const strikeFrontArm = { angle: 0.22, bend: -0.44 };
    const strikeBackArm = { angle: 1.44, bend: -1.64 };

    pose.frontArmAngle = lerp(guardFrontArm.angle, strikeFrontArm.angle, strikeRatio);
    pose.backArmAngle = lerp(guardBackArm.angle, strikeBackArm.angle, strikeRatio);
    pose.frontArmBend = lerp(guardFrontArm.bend, strikeFrontArm.bend, strikeRatio);
    pose.backArmBend = lerp(guardBackArm.bend, strikeBackArm.bend, strikeRatio);

    pose.frontLegAngle = lerp(pose.frontLegAngle ?? 1.16, 0.14, strikeRatio);
    pose.backLegAngle = lerp(pose.backLegAngle ?? 2.02, 2.24, strikeRatio);
    pose.frontLegBend = lerp(-0.16, 0.16, strikeRatio);
    pose.backLegBend = lerp(0.08, -0.24, strikeRatio);

    pose.torsoLean = lerp(0.04, 0.22, strikeRatio);
    pose.shoulderShift = (pose.shoulderShift || 0) + 3.2 * strikeRatio;
    pose.offsetY = (pose.offsetY || 0) + 1.6 * strikeRatio;
    pose.offsetX = (pose.offsetX || 0) + 3.4 * strikeRatio;
  }
  if (attackType === "kick" && strength === "h") {
    // 重腿改为中低位重踢：上身前压、双臂后摆、前腿抬高后扫出。
    const strikeRatio = phase === "startup" ? phaseProgress : phase === "active" ? 1 : 1 - phaseProgress;
    const guardFrontArm = { angle: 0.54, bend: -1.24 };
    const guardBackArm = { angle: 0.9, bend: -1.48 };
    // 按你的要求把双手改成向后摆动（反方向甩臂）。
    const strikeFrontArm = { angle: 2.78, bend: -0.18 };
    const strikeBackArm = { angle: 2.52, bend: -0.28 };

    pose.frontArmAngle = lerp(guardFrontArm.angle, strikeFrontArm.angle, strikeRatio);
    pose.backArmAngle = lerp(guardBackArm.angle, strikeBackArm.angle, strikeRatio);
    pose.frontArmBend = lerp(guardFrontArm.bend, strikeFrontArm.bend, strikeRatio);
    pose.backArmBend = lerp(guardBackArm.bend, strikeBackArm.bend, strikeRatio);

    pose.frontLegAngle = lerp(pose.frontLegAngle ?? 1.18, -0.16, strikeRatio);
    pose.backLegAngle = lerp(pose.backLegAngle ?? 2.05, 2.5, strikeRatio);
    pose.frontLegBend = lerp(-0.18, 0.04, strikeRatio);
    pose.backLegBend = lerp(0.08, -0.52, strikeRatio);

    pose.torsoLean = lerp(0.06, 0.34, strikeRatio);
    pose.shoulderShift = (pose.shoulderShift || 0) + 2.2 * strikeRatio;
    pose.offsetY = (pose.offsetY || 0) + 4.8 * strikeRatio;
    pose.offsetX = (pose.offsetX || 0) + 4.8 * strikeRatio;
  }
  if (attackType === "punch") {
    // 轻/中/重拳按“右拳直、左拳直、双拳直”分别塑形。
    const strikeRatio = phase === "startup" ? phaseProgress : phase === "active" ? 1 : 1 - phaseProgress;
    const guardRight = { angle: 0.56, bend: -1.22 };
    const guardLeft = { angle: 0.92, bend: -1.48 };
    let targetRight = { ...guardRight };
    let targetLeft = { ...guardLeft };
    let targetLean = 0.06;
    let targetShoulderShift = 1.5;
    let targetOffsetX = 0;
    let targetFrontLeg = null;
    let targetBackLeg = null;
    let targetLegBend = null;
    let targetOffsetY = 0;

    if (strength === "l") {
      targetRight = { angle: 0.04, bend: 0.01 };
      targetLeft = { ...guardLeft };
      targetLean = 0.08;
      targetShoulderShift = 2.4;
      targetOffsetX = 1.4;
      targetFrontLeg = 1.24;
      targetBackLeg = 1.96;
      targetLegBend = -0.56;
      targetOffsetY = 0.6;
    } else if (strength === "m") {
      // 中拳：明显转体，左拳打直，右拳维持护架回收。
      targetRight = { angle: 1.18, bend: -1.62 };
      targetLeft = { angle: 0.02, bend: 0.02 };
      targetLean = 0.36;
      targetShoulderShift = 12.5;
      targetOffsetX = 4.2;
      // 中拳下盘做“转髋发力”：前脚微前顶，后脚外摆支撑。
      targetFrontLeg = 0.96;
      targetBackLeg = 2.34;
      targetLegBend = -0.3;
      targetOffsetY = 2.4;
    } else {
      // 重拳：双拳同步直线打出，整体前压更明显。
      targetRight = { angle: 0.02, bend: 0.01 };
      targetLeft = { angle: 0.06, bend: 0.01 };
      targetLean = 0.28;
      targetShoulderShift = 10.2;
      targetOffsetX = 7.2;
      // 重拳下盘做“弓步冲拳”：前腿探出，后腿强力蹬地。
      targetFrontLeg = 0.78;
      targetBackLeg = 2.52;
      targetLegBend = -0.1;
      targetOffsetY = 4.2;
    }

    const rightArm = {
      angle: lerp(guardRight.angle, targetRight.angle, strikeRatio),
      bend: lerp(guardRight.bend, targetRight.bend, strikeRatio),
    };
    const leftArm = {
      angle: lerp(guardLeft.angle, targetLeft.angle, strikeRatio),
      bend: lerp(guardLeft.bend, targetLeft.bend, strikeRatio),
    };

    if (facing === 1) {
      pose.frontArmAngle = rightArm.angle;
      pose.frontArmBend = rightArm.bend;
      pose.backArmAngle = leftArm.angle;
      pose.backArmBend = leftArm.bend;
    } else {
      pose.frontArmAngle = leftArm.angle;
      pose.frontArmBend = leftArm.bend;
      pose.backArmAngle = rightArm.angle;
      pose.backArmBend = rightArm.bend;
    }

    pose.torsoLean = lerp(0, targetLean, strikeRatio);
    pose.shoulderShift = (pose.shoulderShift || 0) + targetShoulderShift * strikeRatio;
    pose.offsetX = (pose.offsetX || 0) + targetOffsetX * strikeRatio;
    if (typeof targetFrontLeg === "number") {
      pose.frontLegAngle = lerp(pose.frontLegAngle ?? 1.3, targetFrontLeg, strikeRatio);
    }
    if (typeof targetBackLeg === "number") {
      pose.backLegAngle = lerp(pose.backLegAngle ?? 1.9, targetBackLeg, strikeRatio);
    }
    if (typeof targetLegBend === "number") {
      pose.legBend = lerp(pose.legBend ?? -0.62, targetLegBend, strikeRatio);
    }
    pose.offsetY = (pose.offsetY || 0) + targetOffsetY * strikeRatio;
  }
  if (attackType.startsWith("rekka")) {
    const step = attackType === "rekka3" ? 3 : attackType === "rekka2" ? 2 : 1;
    const phaseScale = phase === "active" ? 1 : phase === "startup" ? 0.65 : 0.4;
    const lunge = (5 + step * 2.8) * strengthScale * attackEase * phaseScale;
    pose.offsetX = (pose.offsetX || 0) + lunge;
    pose.shoulderShift = (pose.shoulderShift || 0) + (3 + step * 1.8) * strengthScale * attackEase * phaseScale;
    pose.torsoLean = (pose.torsoLean || 0) + step * 0.02;
  }

  return pose;
}

/**
 * 作用：根据玩家状态计算火柴人当前姿态参数。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - timeMs：当前渲染时间（毫秒），用于动作摆动与特效动画。
 */
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
    // 喝酒动作：左手叉腰，右手高举举杯，头后仰，双腿保持站立。
    const sip = Math.sin(timeMs * 0.026) * 0.5 + 0.5;
    const rightArm = {
      angle: -1.86 + sip * 0.06,
      bend: 1.62 - sip * 0.08,
    };
    const leftArm = {
      angle: 1.18 - sip * 0.02,
      bend: -1.74 + sip * 0.06,
    };
    const rightIsFront = (player.facing || 1) === 1;
    return {
      type: "drink",
      frontArmAngle: rightIsFront ? rightArm.angle : leftArm.angle,
      backArmAngle: rightIsFront ? leftArm.angle : rightArm.angle,
      frontArmBend: rightIsFront ? rightArm.bend : leftArm.bend,
      backArmBend: rightIsFront ? leftArm.bend : rightArm.bend,
      frontLegAngle: 1.34,
      backLegAngle: 1.82,
      frontLegBend: -0.56,
      backLegBend: 0.52,
      torsoLean: 0.14 + sip * 0.02,
      shoulderShift: 0.6 + sip * 0.6,
      offsetY: 0.2 + sip * 0.3,
      headTilt: 0.98 + sip * 0.08,
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
  if (player.action === "wallSplat") {
    return {
      type: "wallSplat",
      frontArmAngle: -0.05,
      backArmAngle: -0.25,
      frontLegAngle: 1.15,
      backLegAngle: 1.25,
      torsoLean: 0.26,
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
    const phaseProgress = getPhaseProgressFromAttack(attack, attackPhase);
    const trackPose = getAttackPoseByTrack(
      attackType,
      attackPhase,
      phaseProgress,
      strength,
      strengthScale,
      twoDrink,
      frameNudge,
      attackEase,
      player.facing || 1
    );
    if (trackPose) return trackPose;
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
      // 行走时维持“胸前双手护架”，避免出现一只手自然下垂。
      frontArmAngle: 0.56 - swing * 0.26,
      backArmAngle: 0.92 + swing * 0.2,
      frontLegAngle: 1.2 - swing,
      backLegAngle: 2.0 + swing,
      torsoLean: 0,
      frontArmBend: -1.24,
      backArmBend: -1.5,
    };
  }

  return {
    type: "idle",
    // 站立基础姿态：双手都收在胸前护架位。
    frontArmAngle: 0.54,
    backArmAngle: 0.9,
    frontLegAngle: 1.35,
    backLegAngle: 1.8,
    torsoLean: Math.sin(timeMs * 0.004) * 0.02,
    frontArmBend: -1.24,
    backArmBend: -1.52,
  };
}

/**
 * 作用：按姿态参数绘制角色和攻击判定框。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - timeMs：当前渲染时间（毫秒），用于动作摆动与特效动画。
 */
function drawPlayer(player, timeMs) {
  const color = player.color || "#ffffff";
  const facing = player.facing || 1;
  const pose = getPose(player, timeMs);
  const speedNorm = clamp(Math.abs(player.vx || 0) / ((player.stats?.speed || 300) + 1), 0, 1.5);

  const headR = player.w * 0.18;
  const hipY = player.y + player.h * 0.7;
  const torsoLen = player.h * 0.32;
  const armLen = player.h * 0.24;
  const legLen = player.h * 0.3;
  const coreWidth = 5.5;
  const offsetX = (pose.offsetX || 0) * facing;
  const offsetY = pose.offsetY || 0;
  const shoulderShift = (pose.shoulderShift || 0) * facing;

  const groundY = state.latest?.groundY || 420;
  const air = Math.max(0, groundY - (player.y + player.h));
  const shadowScale = clamp(1 - air / 220, 0.3, 1);
  ctx.save();
  ctx.fillStyle = `rgba(5,10,20,${0.22 * shadowScale})`;
  ctx.beginPath();
  ctx.ellipse(
    player.x + player.w * 0.5,
    groundY + 2,
    player.w * (0.32 + 0.18 * shadowScale),
    9 * shadowScale,
    0,
    0,
    Math.PI * 2
  );
  ctx.fill();
  ctx.restore();

  const trailIntensity = clamp(speedNorm + (pose.type === "rush" ? 0.7 : 0) + (player.attack ? 0.45 : 0), 0, 1.5);
  drawActionTrail(player, facing, timeMs, trailIntensity);

  let strokeColor = color;
  if (pose.type === "parry") strokeColor = "#8bffe8";
  else if (pose.type === "hit") strokeColor = "#ffd1c4";
  else if (pose.type === "wallSplat") strokeColor = "#ffd6be";
  else if (pose.type === "rush") strokeColor = "#9ad9ff";

  const renderSkeleton = (xShift, alpha, widthScale, drawFx) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = strokeColor;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = coreWidth * widthScale;
    ctx.shadowColor = pose.type === "parry" ? "rgba(115,255,230,0.55)" : "rgba(120,190,255,0.35)";
    ctx.shadowBlur = 8 * alpha;

    if (pose.type === "down") {
      const bodyY = player.y + player.h * 0.78;
      const bodyX = player.x + player.w / 2 + xShift;
      const bodyLen = player.h * 0.55;
      const headX = bodyX + facing * bodyLen * 0.45;
      const headY = bodyY - headR * 0.3;

      ctx.beginPath();
      ctx.moveTo(bodyX - facing * bodyLen * 0.4, bodyY);
      ctx.lineTo(bodyX + facing * bodyLen * 0.4, bodyY);
      ctx.stroke();

      ctx.fillStyle = `rgba(255,255,255,${0.08 * alpha})`;
      ctx.beginPath();
      ctx.arc(headX, headY, headR, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(headX, headY, headR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(bodyX, bodyY);
      ctx.lineTo(bodyX - facing * bodyLen * 0.2, bodyY - player.h * 0.12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bodyX, bodyY);
      ctx.lineTo(bodyX + facing * bodyLen * 0.2, bodyY - player.h * 0.12);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const torsoLean = pose.torsoLean || 0;
    const torsoDirRaw = typeof pose.torsoDir === "number" ? pose.torsoDir : 1;
    const torsoDir = torsoDirRaw >= 0 ? Math.max(0.2, torsoDirRaw) : Math.min(-0.2, torsoDirRaw);
    const headTilt = typeof pose.headTilt === "number" ? pose.headTilt : 0;
    // 倒立时整体上提一段，避免头部/躯干穿进地面。
    const invertedLift = torsoDir < 0 ? torsoLen * (-torsoDir) * 0.24 + headR * 0.22 : 0;
    const hipX = player.x + player.w / 2 + torsoLean * player.w * facing + offsetX + xShift;
    const hipY2 = hipY + offsetY - invertedLift;
    const shoulderX = hipX + torsoLean * player.w * 0.5 * facing + shoulderShift;
    const shoulderY = hipY2 - torsoLen * torsoDir;
    const headX = shoulderX - facing * headR * 0.5 * headTilt;
    const headY = shoulderY - headR * 1.2 * torsoDir - headR * 0.12 * headTilt;

    ctx.fillStyle = `rgba(255,255,255,${0.08 * alpha})`;
    ctx.beginPath();
    ctx.arc(headX, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(headX, headY, headR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    ctx.lineTo(hipX, hipY2);
    ctx.stroke();

    const armBend = pose.armBend ?? (pose.type === "hit" || pose.type === "block" ? 0.26 : 0.5);
    const frontArmBend = pose.frontArmBend ?? armBend;
    const backArmBend = pose.backArmBend ?? -armBend * 0.85;
    const legBend = pose.legBend ?? (pose.type === "jump" ? -0.45 : -0.62);
    const frontLegBend = pose.frontLegBend ?? legBend;
    const backLegBend = pose.backLegBend ?? -legBend * 0.9;
    const frontArm = drawJointLimb(shoulderX, shoulderY, armLen, pose.frontArmAngle || -0.9, facing, frontArmBend);
    const backArm = drawJointLimb(shoulderX, shoulderY, armLen, pose.backArmAngle || -1.1, facing, backArmBend);
    const frontLeg = drawJointLimb(hipX, hipY2, legLen, pose.frontLegAngle || 1.4, facing, frontLegBend);
    const backLeg = drawJointLimb(hipX, hipY2, legLen, pose.backLegAngle || 1.8, facing, backLegBend);

    ctx.fillStyle = `rgba(255,255,255,${0.15 * alpha})`;
    [frontArm, backArm, frontLeg, backLeg].forEach((joint) => {
      ctx.beginPath();
      ctx.arc(joint.elbowX, joint.elbowY, 1.8 * widthScale, 0, Math.PI * 2);
      ctx.fill();
    });

    if (drawFx && player.attack) {
      const phase = getAttackPhase(player.attack) || "active";
      drawAttackSwing(player, shoulderX, shoulderY, facing, phase, timeMs);
    }

    if (drawFx && pose.type === "drink") {
      const cupHand = facing === 1 ? frontArm : backArm;
      const cupW = player.w * 0.13;
      const cupH = player.h * 0.12;
      ctx.save();
      ctx.translate(cupHand.endX, cupHand.endY);
      ctx.rotate(-facing * 0.28);
      ctx.strokeStyle = "rgba(255, 242, 205, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(-cupW * 0.48, -cupH * 0.92, cupW, cupH * 0.72);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cupW * 0.52, -cupH * 0.56, cupW * 0.24, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      ctx.restore();
    }

    if (drawFx && pose.type === "parry") {
      const t = (Math.sin(timeMs * 0.025) + 1) * 0.5;
      ctx.strokeStyle = `rgba(120,255,230,${0.25 + t * 0.2})`;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(shoulderX, shoulderY + torsoLen * 0.6, player.w * (0.34 + t * 0.06), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  };

  const ghostCount = trailIntensity > 0.9 ? 2 : trailIntensity > 0.45 ? 1 : 0;
  for (let i = ghostCount; i >= 1; i -= 1) {
    renderSkeleton(-facing * (6 + i * 7), 0.09 + i * 0.05, 0.9, false);
  }
  renderSkeleton(0, 1, 1, true);

  if (player.attack) {
    const phase = getAttackPhase(player.attack) || "active";
    const box = getAttackHitboxRect(player, player.attack, phase);
    if (box) {
      const active = phase === "active";
      const startup = phase === "startup";
      ctx.fillStyle = active
        ? "rgba(255,255,255,0.10)"
        : startup
          ? "rgba(120,210,255,0.06)"
          : "rgba(190,200,255,0.05)";
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = active
        ? "rgba(255,255,255,0.30)"
        : startup
          ? "rgba(120,210,255,0.28)"
          : "rgba(190,200,255,0.22)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.lineWidth = 6;
    }
  }
}

/**
 * 作用：根据服务端下发的特效事件绘制命中火花、环形扩散和提示文字。
 * - effects：特效事件数组（每项含 type/x/y/ttl/duration/text）。
 * - now：当前时间戳（毫秒），用于轻微抖动动画和透明度计算。
 */
function drawCombatEffects(effects, now) {
  if (!Array.isArray(effects) || !effects.length) return;
  ctx.save();
  effects.forEach((effect) => {
    const duration = Math.max(0.001, effect.duration || 0.16);
    const progress = clamp((duration - (effect.ttl || 0)) / duration, 0, 1);
    const alpha = 1 - progress;
    const baseR =
      effect.type === "counter"
        ? 20
        : effect.type === "guardBreak" || effect.type === "wallSplat"
          ? 18
          : effect.type === "perfectParry"
            ? 19
            : 14;
    const radius = baseR + progress * 14;
    let color = "255,230,170";
    if (effect.type === "hit") color = "255,186,120";
    else if (effect.type === "block") color = "140,200,255";
    else if (effect.type === "counter") color = "255,125,100";
    else if (effect.type === "parry") color = "120,255,220";
    else if (effect.type === "perfectParry") color = "150,255,245";
    else if (effect.type === "armor") color = "215,210,255";
    else if (effect.type === "rushCancel") color = "110,235,255";
    else if (effect.type === "wallSplat") color = "255,150,120";
    else if (effect.type === "guardBreak") color = "255,110,140";

    ctx.fillStyle = `rgba(${color},${0.22 * alpha})`;
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(${color},${0.6 * alpha})`;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, radius * 0.6, 0, Math.PI * 2);
    ctx.stroke();

    if (effect.text) {
      const dy = Math.sin((now + effect.id * 17) * 0.01) * 2;
      ctx.fillStyle = `rgba(255,240,200,${0.95 * alpha})`;
      ctx.font = "bold 14px Segoe UI";
      ctx.textAlign = "center";
      ctx.fillText(effect.text, effect.x, effect.y - 24 - progress * 10 + dy);
      ctx.textAlign = "left";
    }
  });
  ctx.restore();
}

/**
 * 作用：绘制倒计时、状态提示和 hitstop 叠层。
 * - arena：场地对象，包含宽高、地面高度和边界信息。
 * - status：业务参数，具体含义请结合调用处传入值理解。
 * - stateData：业务参数，具体含义请结合调用处传入值理解。
 */
function drawOverlay(arena, status, stateData) {
  if ((stateData.hitstop || 0) > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(0, 0, arena.width, arena.height);
  }
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

/**
 * 作用：渲染主循环，每帧执行插值、预测和绘制。
 * - 无参数。
 */
function render() {
  requestAnimationFrame(render);
  const renderData = getRenderState();
  // 尚未积累到可插值快照时，不绘制本帧。
  if (!renderData) return;
  const now = performance.now();
  // 首帧没有历史时间戳，用当前时间初始化 dt 基线。
  if (state.lastFrameTs === null) state.lastFrameTs = now;
  const dt = Math.min(0.05, (now - state.lastFrameTs) / 1000);
  state.lastFrameTs = now;

  const frame = applyLocalPrediction(renderData.state, dt);
  drawBackground(frame);
  drawHUD(frame, frame.players[0], frame.players[1]);
  drawPlayer(frame.players[0], now);
  drawPlayer(frame.players[1], now);
  drawCombatEffects(frame.effects, now);
  drawOverlay(frame, renderData.status || state.status, frame);
}

window.addEventListener("keydown", (event) => {
  // 观战角色不处理本地按键输入。
  if (!isPlayer) return;
  // 系统按键连发不计入“按下一次”的脉冲逻辑。
  if (event.repeat) return;
  if (["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(event.key.toLowerCase())) {
    event.preventDefault();
  }
  switch (event.key.toLowerCase()) {
    case "a":
    case "arrowleft":
      state.input.left = true;
      recordDirection();
      // 以“相对前方向”检测双击前冲（绿冲触发）。
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
      // 以“相对前方向”检测双击前冲（绿冲触发）。
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
  // 观战角色不处理本地按键输入。
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
  // 正常通知服务器离房，避免房间残留旧玩家引用。
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "leave_room" }));
  }
  window.location.href = "/lobby.html";
});

connect();
setInterval(sendInput, 50);
setInterval(() => {
  // 周期心跳用于 RTT 与服务器时间轴同步。
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "ping", t: performance.now() }));
  }
}, 2000);
render();
