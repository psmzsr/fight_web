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

/**
 * HITSTOP：打击停顿时长配置（单位：秒）。
 * 作用：命中瞬间短暂停止对战推进，让打击更“有重量”。
 */
const HITSTOP = {
  hit: 0.08, // 普通命中停顿。
  block: 0.05, // 被防住时停顿（通常比命中短）。
  counter: 0.11, // 反击命中停顿（更强调反击反馈）。
  parry: 0.06, // 招架成功停顿。
  guardBreak: 0.09, // 架势崩溃/燃尽时停顿。
};

/**
 * EFFECT_DURATION：战斗特效持续时长配置（单位：秒）。
 * 作用：控制命中火花与提示文字在前端保留多久。
 */
const EFFECT_DURATION = {
  hit: 0.16, // 普通命中特效持续时间。
  block: 0.14, // 格挡特效持续时间。
  counter: 0.2, // 反击特效持续时间（更长）。
  parry: 0.18, // 招架特效持续时间。
  perfectParry: 0.24, // 蓝防（完美）特效持续时间。
  armor: 0.18, // 护甲吸收特效持续时间。
  wallSplat: 0.24, // 墙反/壁咚特效持续时间。
  rushCancel: 0.2, // 绿冲取消特效持续时间。
  guardBreak: 0.2, // 架势崩溃特效持续时间。
};

/**
 * DRIVE_RULES：驱动系统关键参数。
 * 作用：集中管理蓝防窗口、绿冲消耗、燃尽惩罚等核心数值，便于统一调参。
 */
const DRIVE_RULES = {
  parryDrainPerSec: 16, // 常规招架每秒消耗架势。
  parryCost: 8, // 常规招架成功时的额外固定消耗。
  perfectParryCost: 3, // 完美招架基础消耗（会再叠加返还）。
  perfectParryRefund: 6, // 完美招架成功返还架势值。
  perfectParryWindow: 0.12, // 完美招架判定窗口（秒）。
  rushCost: 20, // 绿冲消耗。
  rushBuffTime: 0.45, // 绿冲取消后帧优势持续时间（秒）。
  rushHitstunBonus: 0.05, // 带优势命中时追加受击硬直。
  rushBlockstunBonus: 0.04, // 带优势被防时追加格挡硬直。
  impactArmorCost: 10, // 迸发护甲吸收一次打击时的额外消耗。
  burnoutMoveScale: 0.88, // 燃尽时移动速度倍率。
  burnoutDamageTaken: 1.1, // 燃尽时受到伤害倍率。
  burnoutHitstunBonus: 0.03, // 燃尽时额外受击硬直。
  regenDelayAfterParryHold: 0.7, // 蓝防持续期间与结束后的恢复锁定时间。
  regenDelayOnDriveSpend: 1.0, // 使用驱动动作后的恢复锁定时间。
  regenDelayOnCombat: 1.1, // 发生攻防接触后的恢复锁定时间。
  wallMargin: 28, // 墙边判定边距。
  wallBounceVx: 280, // 墙反后横向弹开速度。
  wallBounceVy: -120, // 墙反后竖向弹开速度。
};

/**
 * ATTACK_ROOT_MOTION：招式内置位移速度（单位：px/s）。
 * 作用：让不同招式在起手/生效/收招阶段产生符合动作的推进感。
 */
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

// nextEffectId：战斗特效自增 ID，用于客户端区分多次特效事件。
let nextEffectId = 1;

/**
 * ATTACKS：招式基础配置表（单位均为“秒”或“游戏坐标单位”）。
 * 使用方式：`startAttack -> getAttackConfig` 会基于这里的基础值，再叠加轻/中/重缩放。
 * 字段说明：
 * - damage：命中基础伤害。
 * - range：攻击覆盖前方距离（会参与默认判定框推导）。
 * - activeStart：生效帧起点（从出招计时 t=0 开始）。
 * - activeEnd：生效帧终点（t 在该区间内可命中）。
 * - duration：整招总时长（起手+生效+收招）。
 * - cooldown：招式结束后再次出招的冷却时间。
 * - hitstun：命中后对手受击硬直时长。
 * - blockstun：被防住后对手格挡硬直时长。
 * - knockback：命中或防御后对手水平击退力度。
 * - driveDamage：对方架势条（drive）扣减量。
 * - cancelStart：允许取消（连携）窗口起点；为 null 表示不可取消。
 * - cancelEnd：允许取消（连携）窗口终点；为 null 表示不可取消。
 */
const ATTACKS = {
  // 普通拳：起手快、范围中等，作为近身压制与连段起手。
  punch: {
    damage: 6, // 命中基础伤害。
    range: 70, // 前方有效距离。
    activeStart: 0.04, // 生效开始时间。
    activeEnd: 0.12, // 生效结束时间。
    duration: 0.22, // 整招总时长。
    cooldown: 0.28, // 招式后摇冷却。
    hitstun: 0.18, // 命中硬直。
    blockstun: 0.12, // 被防硬直。
    knockback: 140, // 命中/防御击退。
    driveDamage: 10, // 架势条削减量。
    cancelStart: 0.06, // 可取消窗口开始。
    cancelEnd: 0.12, // 可取消窗口结束。
  },
  // 普通脚：伤害更高、范围更长，但启动与恢复都更慢。
  kick: {
    damage: 9, // 命中基础伤害。
    range: 95, // 前方有效距离。
    activeStart: 0.05, // 生效开始时间。
    activeEnd: 0.16, // 生效结束时间。
    duration: 0.28, // 整招总时长。
    cooldown: 0.38, // 招式后摇冷却。
    hitstun: 0.22, // 命中硬直。
    blockstun: 0.16, // 被防硬直。
    knockback: 220, // 命中/防御击退。
    driveDamage: 16, // 架势条削减量。
    cancelStart: 0.1, // 可取消窗口开始。
    cancelEnd: 0.16, // 可取消窗口结束。
  },
  // 迸发（impact）：高压制招式，伤害与架势削减都高，不可取消。
  impact: {
    damage: 14, // 命中基础伤害。
    range: 90, // 前方有效距离。
    activeStart: 0.12, // 生效开始时间。
    activeEnd: 0.26, // 生效结束时间。
    duration: 0.5, // 整招总时长。
    cooldown: 0.75, // 招式后摇冷却。
    hitstun: 0.38, // 命中硬直。
    blockstun: 0.26, // 被防硬直。
    knockback: 320, // 命中/防御击退。
    driveDamage: 35, // 架势条削减量。
    cancelStart: null, // 不允许取消。
    cancelEnd: null, // 不允许取消。
  },
  // 杰米 236P 第一段：连段起手，可在窗口内派生第二段。
  rekka1: {
    damage: 5, // 命中基础伤害。
    range: 70, // 前方有效距离。
    activeStart: 0.04, // 生效开始时间。
    activeEnd: 0.12, // 生效结束时间。
    duration: 0.22, // 整招总时长。
    cooldown: 0.24, // 招式后摇冷却。
    hitstun: 0.16, // 命中硬直。
    blockstun: 0.1, // 被防硬直。
    knockback: 120, // 命中/防御击退。
    driveDamage: 10, // 架势条削减量。
    cancelStart: 0.06, // 派生/取消窗口开始。
    cancelEnd: 0.16, // 派生/取消窗口结束。
  },
  // 杰米 236P 第二段：连段中段，继续维持压制并可派生第三段。
  rekka2: {
    damage: 6, // 命中基础伤害。
    range: 75, // 前方有效距离。
    activeStart: 0.05, // 生效开始时间。
    activeEnd: 0.14, // 生效结束时间。
    duration: 0.24, // 整招总时长。
    cooldown: 0.24, // 招式后摇冷却。
    hitstun: 0.18, // 命中硬直。
    blockstun: 0.12, // 被防硬直。
    knockback: 150, // 命中/防御击退。
    driveDamage: 12, // 架势条削减量。
    cancelStart: 0.06, // 派生/取消窗口开始。
    cancelEnd: 0.16, // 派生/取消窗口结束。
  },
  // 杰米 236P 第三段：终段收尾，伤害和击退较高，不可再派生。
  rekka3: {
    damage: 7, // 命中基础伤害。
    range: 85, // 前方有效距离。
    activeStart: 0.06, // 生效开始时间。
    activeEnd: 0.16, // 生效结束时间。
    duration: 0.28, // 整招总时长。
    cooldown: 0.35, // 招式后摇冷却。
    hitstun: 0.24, // 命中硬直。
    blockstun: 0.16, // 被防硬直。
    knockback: 220, // 命中/防御击退。
    driveDamage: 16, // 架势条削减量。
    cancelStart: null, // 终段不允许取消。
    cancelEnd: null, // 终段不允许取消。
  },
  // 杰米 214K（倒立旋踢）：中距离压制技，覆盖面大、击退高。
  bakkai: {
    damage: 10, // 命中基础伤害。
    range: 110, // 前方有效距离。
    activeStart: 0.13, // 生效开始时间（放慢起手，便于被对手惩罚）。
    activeEnd: 0.31, // 生效结束时间。
    duration: 0.72, // 整招总时长（延长收招，体现高风险）。
    cooldown: 0.92, // 招式后摇冷却。
    hitstun: 0.26, // 命中硬直。
    blockstun: 0.2, // 被防硬直。
    knockback: 240, // 命中/防御击退。
    driveDamage: 22, // 架势条削减量。
    cancelStart: null, // 不允许取消。
    cancelEnd: null, // 不允许取消。
  },
  // 杰米 空中2K（下劈）：空中突进下压，起手快、收招短。
  divekick: {
    damage: 8, // 命中基础伤害。
    range: 70, // 前方有效距离。
    activeStart: 0.02, // 生效开始时间。
    activeEnd: 0.12, // 生效结束时间。
    duration: 0.2, // 整招总时长。
    cooldown: 0.3, // 招式后摇冷却。
    hitstun: 0.2, // 命中硬直。
    blockstun: 0.14, // 被防硬直。
    knockback: 160, // 命中/防御击退。
    driveDamage: 12, // 架势条削减量。
    cancelStart: null, // 不允许取消。
    cancelEnd: null, // 不允许取消。
  },
};

/**
 * BASE_STRENGTH_PROFILE：轻/中/重强度缩放配置。
 * 作用：把同一招式的基础参数扩展为 l/m/h 三种强度表现。
 * 字段说明：
 * - startup/active/recovery：起手、生效、收招时长缩放。
 * - damage：伤害缩放。
 * - hitstun/blockstun：命中硬直、格挡硬直缩放。
 * - knockback：击退缩放。
 * - driveDamage：架势削减缩放。
 * - range：攻击距离缩放。
 * - cooldown：攻击冷却缩放。
 * - hitboxForward：判定框前探距离缩放（offsetX）。
 * - hitboxSize：判定框尺寸缩放（w/h）。
 */
const BASE_STRENGTH_PROFILE = {
  // 轻攻击：更快、压制更灵活，但伤害和击退偏低。
  l: {
    startup: 0.9, // 起手更快。
    active: 0.92, // 生效段略短。
    recovery: 0.86, // 收招更短。
    damage: 0.86, // 伤害降低。
    hitstun: 0.9, // 命中硬直略低。
    blockstun: 0.86, // 被防硬直略低。
    knockback: 0.88, // 击退略低。
    driveDamage: 0.9, // 架势削减略低。
    range: 0.9, // 距离略短。
    cooldown: 0.92, // 冷却略短。
    hitboxForward: 0.92, // 判定前探略短。
    hitboxSize: 0.9, // 判定框略小。
  },
  // 中攻击：基准档位，等于 ATTACKS 的原始设计。
  m: {
    startup: 1, // 起手基准。
    active: 1, // 生效基准。
    recovery: 1, // 收招基准。
    damage: 1, // 伤害基准。
    hitstun: 1, // 命中硬直基准。
    blockstun: 1, // 格挡硬直基准。
    knockback: 1, // 击退基准。
    driveDamage: 1, // 架势削减基准。
    range: 1, // 距离基准。
    cooldown: 1, // 冷却基准。
    hitboxForward: 1, // 判定前探基准。
    hitboxSize: 1, // 判定框大小基准。
  },
  // 重攻击：更重更痛，但起手与恢复更慢，风险更高。
  h: {
    startup: 1.12, // 起手更慢。
    active: 1.08, // 生效段略长。
    recovery: 1.2, // 收招更长。
    damage: 1.22, // 伤害更高。
    hitstun: 1.14, // 命中硬直更长。
    blockstun: 1.1, // 被防硬直更长。
    knockback: 1.2, // 击退更强。
    driveDamage: 1.14, // 架势削减更高。
    range: 1.1, // 距离更长。
    cooldown: 1.14, // 冷却更长。
    hitboxForward: 1.08, // 判定前探更长。
    hitboxSize: 1.08, // 判定框更大。
  },
};

/**
 * ATTACK_STRENGTH_OVERRIDES：按“招式 + 强度”覆盖缩放规则。
 * 作用：修正 BASE_STRENGTH_PROFILE 的通用规律，处理特殊招式手感。
 * 说明：仅写需要覆盖的字段，未写字段自动继承基础档位配置。
 */
const ATTACK_STRENGTH_OVERRIDES = {
  // impact 不区分轻重强度，保证该系统技手感稳定。
  impact: {
    l: { startup: 1, active: 1, recovery: 1, damage: 1, cooldown: 1 }, // 轻版强制回到中版手感。
    h: { startup: 1, active: 1, recovery: 1, damage: 1, cooldown: 1 }, // 重版强制回到中版手感。
  },
  // 空中下劈：轻版更快更灵活，重版更压制更重。
  divekick: {
    l: { startup: 0.95, recovery: 0.92, knockback: 0.9 }, // 轻版：快进快出，击退弱。
    h: { startup: 1.08, recovery: 1.08, knockback: 1.15 }, // 重版：起手慢一点，但压制更强。
  },
  // 倒立旋踢：轻版更顺滑，重版更重更痛。
  bakkai: {
    l: { startup: 0.98, active: 0.98, recovery: 1.05 }, // 轻版：仍可用，但不再是“快出快收”。
    h: { startup: 1.18, active: 1.12, recovery: 1.35, damage: 1.16, cooldown: 1.18 }, // 重版：高收益也高硬直。
  },
};

/**
 * ATTACK_HITBOXES：每个招式在三相位的判定框模板。
 * 字段说明：
 * - startup / active / recovery：对应起手、生效、收招三段。
 * - offsetX：判定框相对角色前方偏移（会根据朝向自动翻转）。
 * - offsetY：判定框相对角色顶部偏移。
 * - w / h：判定框宽高。
 * 备注：这里只是中强度模板，轻重强度会在运行时做缩放。
 */
const ATTACK_HITBOXES = {
  // 普通拳：生效段前探明显，收招缩回。
  punch: {
    startup: { offsetX: 8, offsetY: 22, w: 34, h: 48 }, // 起手：小判定，防止提前判中。
    active: { offsetX: 14, offsetY: 20, w: 66, h: 48 }, // 生效：前探增大，主命中区。
    recovery: { offsetX: 10, offsetY: 22, w: 44, h: 48 }, // 收招：判定回收。
  },
  // 普通脚：覆盖更大，尤其是 active 阶段。
  kick: {
    startup: { offsetX: 12, offsetY: 24, w: 46, h: 52 }, // 起手：抬腿阶段。
    active: { offsetX: 20, offsetY: 20, w: 92, h: 56 }, // 生效：踢出最大覆盖。
    recovery: { offsetX: 14, offsetY: 24, w: 62, h: 54 }, // 收招：回腿后缩。
  },
  // 迸发：纵向覆盖更高，防跳效果更明显。
  impact: {
    startup: { offsetX: 8, offsetY: 18, w: 34, h: 64 }, // 起手：前探小，高度较高。
    active: { offsetX: 14, offsetY: 16, w: 96, h: 72 }, // 生效：大范围冲击区。
    recovery: { offsetX: 10, offsetY: 18, w: 56, h: 66 }, // 收招：缩小但仍保留纵向体积。
  },
  // 236P 第一段：短中距离推进拳。
  rekka1: {
    startup: { offsetX: 10, offsetY: 20, w: 36, h: 52 }, // 起手：小前探。
    active: { offsetX: 18, offsetY: 18, w: 72, h: 54 }, // 生效：命中主区域。
    recovery: { offsetX: 12, offsetY: 20, w: 48, h: 52 }, // 收招：判定收回。
  },
  // 236P 第二段：比第一段更向前。
  rekka2: {
    startup: { offsetX: 11, offsetY: 20, w: 40, h: 52 }, // 起手：略增前探。
    active: { offsetX: 20, offsetY: 18, w: 78, h: 54 }, // 生效：覆盖略增。
    recovery: { offsetX: 13, offsetY: 20, w: 52, h: 52 }, // 收招：回收。
  },
  // 236P 第三段：终段冲势最强，active 最大。
  rekka3: {
    startup: { offsetX: 14, offsetY: 20, w: 44, h: 54 }, // 起手：更靠前。
    active: { offsetX: 24, offsetY: 18, w: 86, h: 56 }, // 生效：终段最大命中区。
    recovery: { offsetX: 15, offsetY: 20, w: 58, h: 54 }, // 收招：缩回但仍偏大。
  },
  // 倒立旋踢：前探大、纵向覆盖大。
  bakkai: {
    startup: { offsetX: 12, offsetY: 16, w: 46, h: 64 }, // 起手：准备翻身阶段。
    active: { offsetX: 28, offsetY: 10, w: 116, h: 84 }, // 生效：大范围旋踢覆盖。
    recovery: { offsetX: 16, offsetY: 16, w: 68, h: 70 }, // 收招：回到中等覆盖。
  },
  // 空中下劈：低位压下判定。
  divekick: {
    startup: { offsetX: 10, offsetY: 30, w: 34, h: 34 }, // 起手：空中准备动作。
    active: { offsetX: 18, offsetY: 28, w: 72, h: 48 }, // 生效：下压主命中区。
    recovery: { offsetX: 12, offsetY: 30, w: 44, h: 40 }, // 收招：判定缩回。
  },
};

const CHAR_PATH = path.join(__dirname, "..", "public", "data", "characters.json");
const DEFAULT_CHAR = {
  id: "default",
  name: "默认",
  color: "#2d6bff",
  stats: { maxHp: 100, speed: 300, jump: -850, gravity: 2000, friction: 0.82 },
};

/**
 * 作用：读取并解析角色配置文件，失败时回落到默认角色配置。
 * - 无参数。
 */
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

/**
 * 作用：根据角色 ID 从配置表中查找角色，找不到时返回默认角色。
 * - charId：角色 ID，用于定位角色配置。
 */
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

/**
 * 作用：把角色属性应用到玩家对象，并初始化可参与战斗的基础属性。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - character：角色配置对象，包含颜色、生命、移动等基础属性。
 */
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

/**
 * 作用：在连接可用时安全发送消息，避免对关闭连接写入报错。
 * - ws：WebSocket 连接对象，用于向客户端发送或接收消息。
 * - payload：要发送给客户端的消息对象，最终会被序列化为 JSON。
 */
function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * 作用：生成短房间 ID，便于在大厅展示和手动输入。
 * - 无参数。
 */
function shortId() {
  return randomUUID().slice(0, 6);
}

/**
 * 作用：构造中立输入对象，作为输入缓存和超时回退的标准结构。
 * - 无参数。
 */
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

/**
 * 作用：规范化强度输入，保证只存在 l/m/h 三种合法值。
 * - value：待裁剪的数值。
 */
function normalizeStrength(value) {
  if (value === "l" || value === "m" || value === "h") return value;
  return "m";
}

/**
 * 作用：获取某个攻击类型在指定强度下的缩放参数（含覆盖规则）。
 * - type：攻击类型或效果类型字符串。
 * - strength：攻击强度（l/m/h），用于帧数据与伤害修正。
 */
function getStrengthProfile(type, strength) {
  const base = BASE_STRENGTH_PROFILE[strength] || BASE_STRENGTH_PROFILE.m;
  const override = ATTACK_STRENGTH_OVERRIDES[type]?.[strength];
  if (!override) return base;
  return { ...base, ...override };
}

/**
 * 作用：把基础帧参数拆分为 startup/active/recovery，并重算取消窗口。
 * - base：基础配置对象，作为缩放前的原始数据。
 * - profile：强度缩放配置，用于修正帧数据、伤害、判定框等。
 */
function buildFrameData(base, profile) {
  const startup = Math.max(0.02, base.activeStart * profile.startup);
  const active = Math.max(0.03, (base.activeEnd - base.activeStart) * profile.active);
  const recovery = Math.max(0.05, (base.duration - base.activeEnd) * profile.recovery);
  const duration = startup + active + recovery;
  const activeStart = startup;
  const activeEnd = startup + active;

  let cancelStart = null;
  let cancelEnd = null;
  if (base.cancelStart !== null && base.cancelEnd !== null) {
    const startRatio = base.cancelStart / base.duration;
    const endRatio = base.cancelEnd / base.duration;
    cancelStart = clamp(duration * startRatio, 0.01, duration - 0.02);
    cancelEnd = clamp(duration * endRatio, cancelStart + 0.01, duration - 0.005);
  }

  return {
    startup,
    active,
    recovery,
    duration,
    activeStart,
    activeEnd,
    cancelStart,
    cancelEnd,
  };
}

/**
 * 作用：当攻击未配置专用判定框时，自动生成默认判定框模板。
 * - base：基础配置对象，作为缩放前的原始数据。
 */
function defaultHitboxTemplate(base) {
  const activeW = Math.max(30, Math.round(base.range));
  return {
    startup: { offsetX: 8, offsetY: 20, w: Math.max(20, Math.round(activeW * 0.55)), h: 52 },
    active: { offsetX: 14, offsetY: 18, w: activeW, h: 58 },
    recovery: { offsetX: 10, offsetY: 20, w: Math.max(24, Math.round(activeW * 0.65)), h: 54 },
  };
}

/**
 * 作用：按强度缩放单帧判定框的尺寸和前探距离。
 * - frame：单帧判定框模板对象。
 * - profile：强度缩放配置，用于修正帧数据、伤害、判定框等。
 */
function scaleHitboxFrame(frame, profile) {
  return {
    offsetX: Math.max(0, Math.round(frame.offsetX * profile.hitboxForward)),
    offsetY: Math.max(0, Math.round(frame.offsetY)),
    w: Math.max(8, Math.round(frame.w * profile.hitboxSize)),
    h: Math.max(8, Math.round(frame.h * profile.hitboxSize)),
  };
}

/**
 * 作用：构建完整三相位判定框（起手/生效/收招）。
 * - type：攻击类型或效果类型字符串。
 * - base：基础配置对象，作为缩放前的原始数据。
 * - profile：强度缩放配置，用于修正帧数据、伤害、判定框等。
 */
function buildHitbox(type, base, profile) {
  const template = ATTACK_HITBOXES[type] || defaultHitboxTemplate(base);
  return {
    startup: scaleHitboxFrame(template.startup, profile),
    active: scaleHitboxFrame(template.active, profile),
    recovery: scaleHitboxFrame(template.recovery, profile),
  };
}

/**
 * 作用：生成本次攻击实例最终参数（帧数据、伤害、硬直、判定框等）。
 * - type：攻击类型或效果类型字符串。
 * - strength：攻击强度（l/m/h），用于帧数据与伤害修正。
 */
function getAttackConfig(type, strength) {
  const base = ATTACKS[type];
  if (!base) return null;

  const strengthId = normalizeStrength(strength);
  const profile = getStrengthProfile(type, strengthId);
  const frame = buildFrameData(base, profile);

  return {
    type,
    strength: strengthId,
    startup: frame.startup,
    active: frame.active,
    recovery: frame.recovery,
    duration: frame.duration,
    activeStart: frame.activeStart,
    activeEnd: frame.activeEnd,
    cancelStart: frame.cancelStart,
    cancelEnd: frame.cancelEnd,
    damage: Math.max(1, Math.round(base.damage * profile.damage)),
    range: Math.max(24, Math.round(base.range * profile.range)),
    hitstun: Math.max(0.05, base.hitstun * profile.hitstun),
    blockstun: Math.max(0.04, base.blockstun * profile.blockstun),
    knockback: Math.max(40, base.knockback * profile.knockback),
    driveDamage: Math.max(1, Math.round(base.driveDamage * profile.driveDamage)),
    cooldown: Math.max(0.08, base.cooldown * profile.cooldown),
    hitbox: buildHitbox(type, base, profile),
  };
}

/**
 * 作用：根据攻击计时判断当前处于哪一个动作相位。
 * - attack：业务参数，具体含义请结合调用处传入值理解。
 */
function getAttackPhase(attack) {
  if (!attack) return "recovery";
  if (attack.t < attack.activeStart) return "startup";
  if (attack.t <= attack.activeEnd) return "active";
  return "recovery";
}

/**
 * 作用：把攻击实例判定框转换为世界坐标矩形，供碰撞检测使用。
 * - attacker：进攻方玩家对象。
 * - attack：业务参数，具体含义请结合调用处传入值理解。
 * - phaseOverride：可选相位覆盖值（startup/active/recovery）。
 */
function getAttackHitboxRect(attacker, attack, phaseOverride) {
  if (!attacker || !attack) return null;
  const phase = phaseOverride || getAttackPhase(attack);
  const hb = attack.hitbox?.[phase] || attack.hitbox?.active;
  if (!hb) return null;
  const width = Math.max(8, hb.w || attack.range || 30);
  const height = Math.max(8, hb.h || attacker.h - 40);
  const offsetX = hb.offsetX || 0;
  const offsetY = hb.offsetY || 0;
  return {
    x: attacker.facing === 1 ? attacker.x + attacker.w + offsetX : attacker.x - offsetX - width,
    y: attacker.y + offsetY,
    w: width,
    h: height,
  };
}

/**
 * 作用：触发或刷新 hitstop，让对战逻辑短暂停顿以强化命中反馈。
 * - room：房间对象，内部会修改 `room.state.hitstop`。
 * - duration：本次希望施加的停顿时长（秒）。
 */
function triggerHitstop(room, duration) {
  if (!room || !room.state || !duration) return;
  room.state.hitstop = Math.max(room.state.hitstop || 0, duration);
}

/**
 * 作用：向状态中追加一个短生命周期战斗特效事件，供前端渲染命中火花与提示字。
 * - room：房间对象，内部会写入 `room.state.effects`。
 * - type：特效类型（hit/block/counter/parry/guardBreak）。
 * - x：特效中心点横坐标（世界坐标）。
 * - y：特效中心点纵坐标（世界坐标）。
 * - text：可选浮字文本（例如 `COUNTER`）。
 */
function addCombatEffect(room, type, x, y, text = "") {
  if (!room || !room.state) return;
  if (!Array.isArray(room.state.effects)) room.state.effects = [];
  const duration = EFFECT_DURATION[type] || 0.16;
  room.state.effects.push({
    id: nextEffectId++,
    type,
    x: Math.round(x),
    y: Math.round(y),
    t: 0,
    ttl: duration,
    duration,
    text,
  });
  if (room.state.effects.length > 24) room.state.effects.shift();
}

/**
 * 作用：推进每个战斗特效的生命周期，并移除已过期特效。
 * - state：房间状态对象，包含 `effects` 列表。
 * - dt：本帧时间步长（秒）。
 */
function updateCombatEffects(state, dt) {
  if (!state) return;
  if (!Array.isArray(state.effects)) {
    state.effects = [];
    return;
  }
  state.effects.forEach((effect) => {
    effect.t += dt;
    effect.ttl -= dt;
  });
  state.effects = state.effects.filter((effect) => effect.ttl > 0);
}

/**
 * 作用：读取玩家输入；若超时未上报输入则回退到中立输入。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - clientId：客户端唯一标识，用于索引输入和玩家状态。
 */
function getInput(room, clientId) {
  const lastAt = room.lastInputAt.get(clientId) || 0;
  if (Date.now() - lastAt > 800) {
    const neutral = defaultInput();
    room.inputs.set(clientId, neutral);
    return neutral;
  }
  return room.inputs.get(clientId) || defaultInput();
}

/**
 * 作用：创建玩家初始状态对象（位置、速度、资源条、动作状态等）。
 * - slot：玩家槽位编号，0 为左侧（P1），1 为右侧（P2）。
 */
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
    parryTimer: 0,
    parryHolding: false,
    rushBuffTimer: 0,
    driveRegenLock: 0,
    comboCount: 0,
    comboTimer: 0,
    counterTimer: 0,
    color: slot === 0 ? "#2d6bff" : "#ff4d4d",
  };
  applyCharacter(base, getCharacter());
  base.hp = base.maxHp;
  return base;
}

/**
 * 作用：创建房间对战初始状态（场地、计时器、玩家对象等）。
 * - 无参数。
 */
function createInitialState() {
  return {
    width: 960,
    height: 540,
    groundY: 420,
    timer: 99,
    message: "",
    winnerId: null,
    countdown: null,
    hitstop: 0,
    effects: [],
    players: [createPlayer(0), createPlayer(1)],
  };
}

/**
 * 作用：重置房间对战状态并重新把玩家/AI 放到对应槽位。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 */
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

/**
 * 作用：创建房间数据结构并注册到房间表。
 * - name：名称字符串，通常是房间名或显示名。
 * - options：可选参数对象，用于扩展创建流程（如私密房、模式、AI 配置等）。
 */
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

/**
 * 作用：将客户端绑定到指定槽位并完成出生点、状态和资源重置。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - clientId：客户端唯一标识，用于索引输入和玩家状态。
 * - slot：玩家槽位编号，0 为左侧（P1），1 为右侧（P2）。
 * - options：可选参数对象，用于扩展创建流程（如私密房、模式、AI 配置等）。
 */
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
  player.parryTimer = 0;
  player.parryHolding = false;
  player.rushBuffTimer = 0;
  player.driveRegenLock = 0;
  player.comboCount = 0;
  player.comboTimer = 0;
  player.counterTimer = 0;
}

/**
 * 作用：把客户端以玩家身份加入房间。
 * - client：客户端对象，包含连接、昵称、房间归属和身份信息。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - preferredSlot：期望加入的玩家槽位（0/1），若不可用会自动分配。
 * - characterId：角色 ID 字符串，表示当前玩家选择的角色。
 */
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

/**
 * 作用：把客户端以观战者身份加入房间。
 * - client：客户端对象，包含连接、昵称、房间归属和身份信息。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 */
function addSpectatorToRoom(client, room) {
  room.spectators.add(client.id);
  room.emptySince = null;
  client.roomId = room.id;
  client.role = "spectator";
}

/**
 * 作用：判断一个 ID 是否为真人玩家而非 AI。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - id：通用 ID 参数（玩家 ID / 房间 ID / 客户端 ID）。
 */
function isHumanId(room, id) {
  if (!id) return false;
  if (room.ai && id === room.ai.id) return false;
  return true;
}

/**
 * 作用：统计房间中的真人玩家数量。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 */
function getHumanCount(room) {
  return room.players.filter((id) => isHumanId(room, id)).length;
}

/**
 * 作用：获取房间中所有真人玩家 ID。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 */
function getHumanIds(room) {
  return room.players.filter((id) => isHumanId(room, id));
}

/**
 * 作用：从房间玩家槽移除指定玩家并清理输入缓存。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - playerId：玩家唯一标识，用于移除玩家或清理输入映射。
 */
function removePlayerId(room, playerId) {
  const slot = room.players.indexOf(playerId);
  if (slot !== -1) room.players[slot] = null;
  room.inputs.delete(playerId);
  room.inputSeq.delete(playerId);
  room.lastInputAt.delete(playerId);
}

/**
 * 作用：根据最近输入时间判断真人玩家是否仍在线活跃。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - playerId：玩家唯一标识，用于移除玩家或清理输入映射。
 */
function isHumanActive(room, playerId) {
  const client = clientsById.get(playerId);
  if (!client) return false;
  const lastAt = room.lastInputAt.get(playerId) || 0;
  return Date.now() - lastAt < 1500;
}

/**
 * 作用：处理离房逻辑，包含对战中退出、房间清空和重置策略。
 * - client：客户端对象，包含连接、昵称、房间归属和身份信息。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 */
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

/**
 * 作用：生成大厅列表所需的房间摘要信息。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 */
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

/**
 * 作用：向所有连接广播最新房间列表。
 * - 无参数。
 */
function broadcastRoomList() {
  const roomsList = Array.from(rooms.values()).map(roomSummary);
  wss.clients.forEach((ws) => safeSend(ws, { type: "room_list", rooms: roomsList }));
}

/**
 * 作用：向房间内所有玩家与观战者广播消息。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - payload：要发送给客户端的消息对象，最终会被序列化为 JSON。
 */
function broadcastToRoom(room, payload) {
  const ids = room.players.filter(Boolean).concat(Array.from(room.spectators));
  ids.forEach((id) => {
    const client = clientsById.get(id);
    if (client) safeSend(client.ws, payload);
  });
}

/**
 * 作用：向训练房添加 AI 玩家并占据一个槽位。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - options：可选参数对象，用于扩展创建流程（如私密房、模式、AI 配置等）。
 */
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

/**
 * 作用：更新训练 AI 输入行为（木桩模式或基础对战模式）。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - dt：单帧时间步长（秒），用于所有时间递减与物理更新。
 */
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

/**
 * 作用：构造下发给客户端的统一状态包。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 */
function statePayload(room) {
  return {
    type: "state",
    state: room.state,
    status: room.status,
    roomId: room.id,
    serverTimeMs: Math.round(room.serverTimeMs),
  };
}

/**
 * 作用：进入开局倒计时状态。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 */
function startCountdown(room) {
  room.status = "countdown";
  room.countdown = 3;
  room.state.message = "准备";
  room.state.countdown = room.countdown;
  room.lastTick = Date.now();
  resetRoomState(room);
}

/**
 * 作用：直接进入对战（无倒计时），用于训练模式的即开即练。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 */
function startPlayingImmediately(room) {
  resetRoomState(room);
  room.status = "playing";
  room.countdown = 0;
  room.state.countdown = null;
  room.state.message = "";
  room.state.timer = room.mode === "training" ? 999 : 99;
  room.lastTick = Date.now();
}

/**
 * 作用：结束对局并广播结果。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - winnerId：获胜者的客户端 ID，为 null 时表示平局。
 * - reason：对战结束文案，显示给客户端。
 */
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
 * 作用：延后架势条恢复时间，避免在攻防中即时回蓝。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - duration：锁定持续时间（秒），会与已有锁定取最大值。
 */
function lockDriveRegen(player, duration) {
  if (!player || !duration) return;
  player.driveRegenLock = Math.max(player.driveRegenLock || 0, duration);
}

/**
 * 作用：计算两个矩形的相交区域，便于取得命中接触点。
 * - a：矩形 A。
 * - b：矩形 B。
 */
function getRectIntersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const w = right - x;
  const h = bottom - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * 作用：按角色相对比例生成一个矩形，可选按朝向做轻微前后偏移。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - xScale：矩形左上角 X 相对角色宽度的比例。
 * - yScale：矩形左上角 Y 相对角色高度的比例。
 * - wScale：矩形宽度相对角色宽度的比例。
 * - hScale：矩形高度相对角色高度的比例。
 * - facingShiftScale：沿朝向的偏移比例，正值向前，负值向后。
 */
function makeRelativeRect(player, xScale, yScale, wScale, hScale, facingShiftScale = 0) {
  const shift = player.facing === 1 ? player.w * facingShiftScale : -player.w * facingShiftScale;
  return {
    x: player.x + player.w * xScale + shift,
    y: player.y + player.h * yScale,
    w: player.w * wScale,
    h: player.h * hScale,
  };
}

/**
 * 作用：获取角色用于相互挤压的 pushbox（小于整个人体框）。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 */
function getPushbox(player) {
  if (!player) return null;
  let wScale = 0.48;
  let hScale = 0.58;
  let bottomInsetScale = 0.015;

  if (!player.onGround) {
    // 空中 pushbox 更窄更短，避免跳跃交错时像“整个人体框硬撞”。
    wScale = 0.44;
    hScale = 0.5;
    bottomInsetScale = 0;
  } else if (player.hp <= 0 || player.action === "down") {
    // 倒地状态改为低矮横向体积，和站立状态区分开。
    wScale = 0.64;
    hScale = 0.32;
    bottomInsetScale = 0;
  } else if (player.action === "wallSplat") {
    // 壁咚时躯干贴墙，pushbox 稍微变窄，避免墙边“卡体积”过重。
    wScale = 0.46;
    hScale = 0.62;
    bottomInsetScale = 0.02;
  }

  if (player.attack?.type === "bakkai") {
    // 倒立旋踢期间身体更卷，pushbox 再收一点，减少视觉穿模。
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
 * 作用：获取角色受击盒（头/躯干/下肢），替代整人单矩形判定。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 */
function getPlayerHurtboxes(player) {
  if (!player) return [];

  if (player.hp <= 0 || player.action === "down") {
    return [
      makeRelativeRect(player, 0.1, 0.66, 0.8, 0.16),
      makeRelativeRect(player, 0.16, 0.52, 0.68, 0.16),
      makeRelativeRect(player, player.facing === 1 ? 0.62 : 0.14, 0.44, 0.22, 0.14),
    ];
  }

  if (!player.onGround) {
    const aerialLean = player.attack ? 0.04 : 0.02;
    return [
      makeRelativeRect(player, 0.3, 0.1, 0.4, 0.18),
      makeRelativeRect(player, 0.22, 0.32, 0.56, 0.26, aerialLean),
      makeRelativeRect(player, 0.26, 0.6, 0.46, 0.2, aerialLean * 0.7),
    ];
  }

  const wallSplat = player.action === "wallSplat";
  const attacking = !!player.attack;
  const lean = attacking ? 0.05 : wallSplat ? 0.01 : 0;
  const torsoWidthScale = wallSplat ? 0.5 : 0.54;
  const hipWidthScale = Math.min(0.62, torsoWidthScale + 0.08);
  return [
    makeRelativeRect(player, 0.32, 0.05, 0.36, 0.17, lean * 0.2),
    makeRelativeRect(player, 0.24, 0.22, torsoWidthScale, 0.24, lean),
    makeRelativeRect(player, 0.2, 0.46, hipWidthScale, 0.24, lean * 0.7),
    makeRelativeRect(player, 0.28, 0.7, 0.44, 0.24, lean * 0.35),
  ];
}

/**
 * 作用：判断两个矩形是否相交。
 * - a：矩形 A 或插值起点对象。
 * - b：矩形 B 或插值终点对象。
 */
function rectsIntersect(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/**
 * 作用：处理角色身体重叠，防止互相穿模。
 * - p1：玩家 1 的状态对象。
 * - p2：玩家 2 的状态对象。
 * - arena：场地对象，包含宽高、地面高度和边界信息。
 */
function resolvePlayerOverlap(p1, p2, arena) {
  if (!p1 || !p2) return;
  const b1 = getPushbox(p1);
  const b2 = getPushbox(p2);
  if (!b1 || !b2) return;
  const overlapX = Math.min(b1.x + b1.w, b2.x + b2.w) - Math.max(b1.x, b2.x);
  const overlapY = Math.min(b1.y + b1.h, b2.y + b2.h) - Math.max(b1.y, b2.y);
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

/**
 * 作用：判断角色是否处于墙边，可用于触发墙反/壁咚逻辑。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - arena：场地对象，包含宽高、地面高度和边界信息。
 */
function isNearWall(player, arena) {
  const margin = DRIVE_RULES.wallMargin;
  const box = getPushbox(player) || player;
  return box.x <= 40 + margin || box.x + box.w >= arena.width - 40 - margin;
}

/**
 * 作用：判断防守方是否输入了“后方向”以触发格挡。
 * - defender：防守方玩家对象。
 * - input：当前帧输入对象，包含方向键与攻击键状态。
 */
function isBackInput(defender, input) {
  // 没有输入对象时，默认视为未按住后方向。
  if (!input) return false;
  return defender.facing === 1 ? !!input.left : !!input.right;
}

/**
 * 作用：计算角色额外伤害倍率（如杰米饮酒等级加成）。
 * - attacker：进攻方玩家对象。
 */
function getDamageScale(attacker) {
  // 仅杰米受酒等级影响，其他角色固定 1.0 倍伤害。
  if (attacker.characterId === "jamie") {
    const level = attacker.drinkLevel || 0;
    return 1 + level * 0.04;
  }
  return 1;
}

/**
 * 作用：根据杰米酒等级动态调整速度和跳跃参数。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 */
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

/**
 * 作用：判断杰米当前是否允许执行喝酒动作。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 */
function canDrink(player) {
  return player.characterId === "jamie" && player.drinkCooldown <= 0 && player.drinkLevel < 4;
}

/**
 * 作用：执行喝酒：提升酒等级并进入对应动作状态。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 */
function drinkUp(player) {
  player.drinkLevel = Math.min(4, (player.drinkLevel || 0) + 1);
  player.drinkCooldown = 0.7;
  player.action = "drink";
  player.actionTimer = 0.6;
}

/**
 * 作用：开始一次攻击并写入攻击实例参数。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - type：攻击类型或效果类型字符串。
 * - strength：攻击强度（l/m/h），用于帧数据与伤害修正。
 */
function startAttack(player, type, strength) {
  const cfg = getAttackConfig(type, strength);
  // 未命中配置表时不创建攻击实例，防止出现空攻击状态。
  if (!cfg) return false;
  player.attack = {
    type,
    strength: cfg.strength,
    t: 0,
    startup: cfg.startup,
    active: cfg.active,
    recovery: cfg.recovery,
    activeStart: cfg.activeStart,
    activeEnd: cfg.activeEnd,
    duration: cfg.duration,
    cancelStart: cfg.cancelStart,
    cancelEnd: cfg.cancelEnd,
    damage: cfg.damage,
    range: cfg.range,
    hitstun: cfg.hitstun,
    blockstun: cfg.blockstun,
    knockback: cfg.knockback,
    driveDamage: cfg.driveDamage,
    hitbox: cfg.hitbox,
    didHit: false,
    armorUsed: false,
  };
  player.attackCooldown = cfg.cooldown;
  return true;
}

/**
 * 作用：更新连击计数与连击维持计时器。
 * - attacker：进攻方玩家对象。
 */
function registerCombo(attacker) {
  if (attacker.comboTimer > 0) attacker.comboCount += 1;
  else attacker.comboCount = 1;
  attacker.comboTimer = 0.8;
}

/**
 * 作用：根据当前招式相位返回根运动速度（仅地面招式使用）。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 */
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

// processAttack: resolve hit interaction, resource changes, and impact events.
function processAttack(room, attacker, defender, defenderInput) {
  // 进攻方当前没有攻击动作时，不进入命中结算。
  if (!attacker.attack) return;
  const attack = attacker.attack;
  const now = attack.t;
  // 同一段攻击只允许命中一次。
  if (attack.didHit) return;
  // 命中判定仅在 active 帧窗口内生效。
  if (now < attack.activeStart || now > attack.activeEnd) return;
  const box = getAttackHitboxRect(attacker, attack, "active");
  // 没有可用判定框时直接跳过本帧结算。
  if (!box) return;
  const hurtboxes = getPlayerHurtboxes(defender);
  let hitRect = null;
  hurtboxes.forEach((hb) => {
    const inter = getRectIntersection(box, hb);
    if (!inter) return;
    // 命中多个受击盒时，取重叠面积最大的那个作为接触点。
    if (!hitRect || inter.w * inter.h > hitRect.w * hitRect.h) hitRect = inter;
  });

  // 只有攻击框与任一受击盒相交时才会触发伤害/格挡/招架逻辑。
  if (hitRect) {
    attack.didHit = true;
    const fxX = Math.round(hitRect.x + hitRect.w * 0.5);
    const fxY = Math.round(hitRect.y + hitRect.h * 0.5);
    const counterHit = !!defender.attack && defender.attack.t < defender.attack.activeStart;
    const canParry =
      !!defenderInput?.parry &&
      defender.onGround &&
      defender.hitstun <= 0 &&
      defender.blockstun <= 0 &&
      defender.drive > 0;
    const perfectParry = canParry && defender.parryTimer > 0 && defender.parryTimer <= DRIVE_RULES.perfectParryWindow;
    const impactArmorActive =
      !!defender.attack &&
      defender.attack.type === "impact" &&
      !defender.attack.armorUsed &&
      defender.hitstun <= 0 &&
      defender.blockstun <= 0 &&
      defender.attack.t <= defender.attack.activeEnd;
    const rushBuffed = (attacker.rushBuffTimer || 0) > 0;
    const rushHitstunBonus = rushBuffed ? DRIVE_RULES.rushHitstunBonus : 0;
    const rushBlockstunBonus = rushBuffed ? DRIVE_RULES.rushBlockstunBonus : 0;
    const canBlock =
      isBackInput(defender, defenderInput) &&
      defender.onGround &&
      defender.hitstun <= 0 &&
      defender.blockstun <= 0;

    // 招架判断优先于普通格挡：满足条件即消耗架势并打断后续受击流程。
    if (canParry && !defender.burnout) {
      if (perfectParry) {
        defender.drive = clamp(
          defender.drive - DRIVE_RULES.perfectParryCost + DRIVE_RULES.perfectParryRefund,
          0,
          100
        );
        defender.blockstun = 0.03;
        attacker.blockstun = Math.max(attacker.blockstun || 0, 0.2);
        attacker.vx -= attack.knockback * 0.18 * attacker.facing;
        addCombatEffect(room, "perfectParry", fxX, fxY, "JUST");
        triggerHitstop(room, HITSTOP.parry + 0.03);
      } else {
        defender.drive = Math.max(0, defender.drive - DRIVE_RULES.parryCost);
        defender.blockstun = 0.06;
        addCombatEffect(room, "parry", fxX, fxY, "PARRY");
        triggerHitstop(room, HITSTOP.parry);
      }
      if (defender.drive <= 0) defender.burnout = true;
      defender.parryTimer = 0;
      lockDriveRegen(defender, DRIVE_RULES.regenDelayOnCombat);
      lockDriveRegen(attacker, DRIVE_RULES.regenDelayOnCombat);
      if (rushBuffed) attacker.rushBuffTimer = 0;
      return;
    }

    // 迸发在出招中带 1 次护甲，吸收普通打击后仍可继续动作。
    if (impactArmorActive && attack.type !== "impact") {
      defender.attack.armorUsed = true;
      defender.drive = Math.max(0, defender.drive - DRIVE_RULES.impactArmorCost);
      if (defender.drive <= 0) defender.burnout = true;
      defender.vx += attack.knockback * 0.08 * attacker.facing;
      attacker.blockstun = Math.max(attacker.blockstun || 0, 0.12);
      attacker.vx -= attack.knockback * 0.12 * attacker.facing;
      addCombatEffect(room, "armor", fxX, fxY, "ARMOR");
      triggerHitstop(room, HITSTOP.block);
      lockDriveRegen(defender, DRIVE_RULES.regenDelayOnDriveSpend);
      lockDriveRegen(attacker, DRIVE_RULES.regenDelayOnCombat);
      if (rushBuffed) attacker.rushBuffTimer = 0;
      return;
    }

    // 其次判断是否成立格挡。
    if (canBlock) {
      // 燃尽状态下的格挡会触发更重的惩罚（近似 guard break）。
      if (defender.burnout || defender.drive <= 0) {
        const chip = Math.max(1, Math.floor(attack.damage * 0.35));
        defender.hp = Math.max(0, defender.hp - chip);
        defender.blockstun = attack.blockstun + 0.12 + rushBlockstunBonus;
        defender.vx += attack.knockback * 0.25 * attacker.facing;
        addCombatEffect(room, "guardBreak", fxX, fxY, "BURNOUT");
        triggerHitstop(room, HITSTOP.guardBreak);
        lockDriveRegen(defender, DRIVE_RULES.regenDelayOnCombat);
        lockDriveRegen(attacker, DRIVE_RULES.regenDelayOnCombat);
        if (rushBuffed) attacker.rushBuffTimer = 0;
        return;
      }

      defender.drive = Math.max(0, defender.drive - attack.driveDamage);
      const guardBroken = defender.drive <= 0;
      // 架势被打空后进入燃尽，但不直接扣血（符合“有架势时格挡不掉血”）。
      if (guardBroken) {
        defender.burnout = true;
        defender.blockstun = attack.blockstun + 0.24 + rushBlockstunBonus;
        defender.vx += attack.knockback * 0.12 * attacker.facing;
        addCombatEffect(room, "guardBreak", fxX, fxY, "BREAK");
        triggerHitstop(room, HITSTOP.guardBreak);
      } else {
        // 普通格挡：仅扣架势，不扣血，位移也显著减小。
        defender.blockstun = attack.blockstun + rushBlockstunBonus;
        defender.vx += attack.knockback * 0.06 * attacker.facing;
        addCombatEffect(room, "block", fxX, fxY, "BLOCK");
        triggerHitstop(room, HITSTOP.block);
      }
      lockDriveRegen(defender, DRIVE_RULES.regenDelayOnCombat);
      lockDriveRegen(attacker, DRIVE_RULES.regenDelayOnCombat);
      if (rushBuffed) attacker.rushBuffTimer = 0;
      return;
    }

    let damage = Math.round(attack.damage * getDamageScale(attacker));
    if (defender.burnout) damage = Math.round(damage * DRIVE_RULES.burnoutDamageTaken);
    // 对手在招式起手阶段被打中视为 counter，伤害和硬直更高。
    if (counterHit) damage = Math.round(damage * 1.12);
    defender.hp = Math.max(0, defender.hp - damage);
    defender.hitstun =
      (counterHit ? attack.hitstun + 0.06 : attack.hitstun) +
      rushHitstunBonus +
      (defender.burnout ? DRIVE_RULES.burnoutHitstunBonus : 0);
    defender.vx += attack.knockback * attacker.facing;
    defender.vy = -160;
    defender.counterTimer = counterHit ? 0.75 : Math.max(0, defender.counterTimer - 0.03);
    registerCombo(attacker);
    const wallSplat =
      isNearWall(defender, room.state) &&
      (attack.type === "impact" || attack.type === "bakkai" || attack.type === "rekka3");
    if (wallSplat) {
      defender.hitstun = Math.max(defender.hitstun, attack.hitstun + 0.18 + rushHitstunBonus);
      defender.vx = -attacker.facing * DRIVE_RULES.wallBounceVx;
      defender.vy = DRIVE_RULES.wallBounceVy;
      defender.action = "wallSplat";
      defender.actionTimer = 0.22;
      addCombatEffect(room, "wallSplat", fxX, fxY, "WALL");
      triggerHitstop(room, HITSTOP.guardBreak);
    } else {
      addCombatEffect(room, counterHit ? "counter" : "hit", fxX, fxY, counterHit ? "COUNTER" : "");
      triggerHitstop(room, counterHit ? HITSTOP.counter : HITSTOP.hit);
    }
    lockDriveRegen(defender, DRIVE_RULES.regenDelayOnCombat);
    lockDriveRegen(attacker, DRIVE_RULES.regenDelayOnCombat);
    if (rushBuffed) attacker.rushBuffTimer = 0;
  }
}

/**
 * 作用：更新单个玩家的移动与重力物理。
 * - player：玩家状态对象，记录位置、速度、血量、动作等实时信息。
 * - input：当前帧输入对象，包含方向键与攻击键状态。
 * - dt：单帧时间步长（秒），用于所有时间递减与物理更新。
 * - arena：场地对象，包含宽高、地面高度和边界信息。
 */
function updatePlayer(player, input, dt, arena) {
  const burnoutScale = player.burnout ? DRIVE_RULES.burnoutMoveScale : 1;
  const SPEED = (player.stats?.speed ?? 300) * burnoutScale;
  const JUMP = (player.stats?.jump ?? -850) * (player.burnout ? 0.95 : 1);
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
    } else if (player.onGround && player.attack) {
      // 攻击期间使用根运动推进，不再读左右输入直接改速。
      const attackMotion = getAttackRootMotionSpeed(player);
      if (attackMotion > 0) player.vx = attackMotion * player.facing;
      else if (input.left && !input.right) player.vx = -SPEED;
      else if (input.right && !input.left) player.vx = SPEED;
      else player.vx *= FRICTION;
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

/**
 * 作用：房间主循环：输入处理、技能触发、命中判定、胜负判断与资源恢复。
 * - room：房间对象，包含房间成员、输入缓存、状态机和对战状态。
 * - dt：单帧时间步长（秒），用于所有时间递减与物理更新。
 */
function updateRoom(room, dt) {
  const state = room.state;
  updateCombatEffects(state, dt);
  // waiting/finished 状态不推进战斗逻辑，只保留特效衰减。
  if (room.status === "waiting" || room.status === "finished") return;

  // 倒计时阶段仅推进倒计时，不计算移动/攻击。
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

  // 仅 playing 状态进入完整帧更新。
  if (room.status !== "playing") return;

  // 训练机器人存在时先更新 AI 输入，再进入玩家结算。
  if (room.ai) {
    updateAI(room, dt);
  }

  // 训练模式时间固定，普通模式按帧递减并判断超时胜负。
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
  // 任一位置还没分配到玩家时，本帧不推进对战。
  if (!p1.clientId || !p2.clientId) return;

  // 命中停顿期间冻结主要战斗推进，只递减停顿和提示计时。
  if (state.hitstop > 0) {
    state.hitstop = Math.max(0, state.hitstop - dt);
    if (p1.counterTimer > 0) p1.counterTimer = Math.max(0, p1.counterTimer - dt);
    if (p2.counterTimer > 0) p2.counterTimer = Math.max(0, p2.counterTimer - dt);
    return;
  }

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
  if (p1.rushBuffTimer > 0) p1.rushBuffTimer = Math.max(0, p1.rushBuffTimer - dt);
  if (p2.rushBuffTimer > 0) p2.rushBuffTimer = Math.max(0, p2.rushBuffTimer - dt);
  if (p1.driveRegenLock > 0) p1.driveRegenLock = Math.max(0, p1.driveRegenLock - dt);
  if (p2.driveRegenLock > 0) p2.driveRegenLock = Math.max(0, p2.driveRegenLock - dt);

  const p1Stunned = p1.hitstun > 0 || p1.blockstun > 0;
  const p2Stunned = p2.hitstun > 0 || p2.blockstun > 0;

  // 招架仅在“非硬直 + 非燃尽 + 有架势”时可维持，并累计蓝防窗口计时。
  const p1CanParryHold = in1.parry && p1.drive > 0 && !p1Stunned && !p1.burnout;
  if (p1CanParryHold) {
    if (!p1.parryHolding) p1.parryTimer = 0;
    p1.parryHolding = true;
    p1.parryTimer += dt;
    p1.drive = clamp(p1.drive - DRIVE_RULES.parryDrainPerSec * dt, 0, 100);
    lockDriveRegen(p1, DRIVE_RULES.regenDelayAfterParryHold);
    if (p1.drive <= 0) p1.burnout = true;
    if (p1.action !== "drink") {
      p1.action = "parry";
      p1.actionTimer = 0.1;
    }
  } else {
    p1.parryHolding = false;
    p1.parryTimer = 0;
  }

  const p2CanParryHold = in2.parry && p2.drive > 0 && !p2Stunned && !p2.burnout;
  if (p2CanParryHold) {
    if (!p2.parryHolding) p2.parryTimer = 0;
    p2.parryHolding = true;
    p2.parryTimer += dt;
    p2.drive = clamp(p2.drive - DRIVE_RULES.parryDrainPerSec * dt, 0, 100);
    lockDriveRegen(p2, DRIVE_RULES.regenDelayAfterParryHold);
    if (p2.drive <= 0) p2.burnout = true;
    if (p2.action !== "drink") {
      p2.action = "parry";
      p2.actionTimer = 0.1;
    }
  } else {
    p2.parryHolding = false;
    p2.parryTimer = 0;
  }

  // 22P：喝酒动作，受硬直限制。
  if (in1.special1 && canDrink(p1) && !p1Stunned) {
    drinkUp(p1);
  }
  if (in2.special1 && canDrink(p2) && !p2Stunned) {
    drinkUp(p2);
  }

  // 绿冲：消耗 drive，进入短时高速前冲（燃尽中不可用）。
  if (in1.rush && p1.drive >= DRIVE_RULES.rushCost && !p1Stunned && !p1.burnout && !p1.attack) {
    p1.drive = Math.max(0, p1.drive - DRIVE_RULES.rushCost);
    p1.dashTime = 0.22;
    p1.dashSpeed = 650;
    lockDriveRegen(p1, DRIVE_RULES.regenDelayOnDriveSpend);
    if (p1.drive <= 0) p1.burnout = true;
  }
  if (in2.rush && p2.drive >= DRIVE_RULES.rushCost && !p2Stunned && !p2.burnout && !p2.attack) {
    p2.drive = Math.max(0, p2.drive - DRIVE_RULES.rushCost);
    p2.dashTime = 0.22;
    p2.dashSpeed = 650;
    lockDriveRegen(p2, DRIVE_RULES.regenDelayOnDriveSpend);
    if (p2.drive <= 0) p2.burnout = true;
  }

  if (p1.attack) {
    p1.attack.t += dt;
    // 仅在 cancel 窗口内允许派生/取消到下一招。
    if (p1.attack.cancelStart !== null && p1.attack.t >= p1.attack.cancelStart && p1.attack.t <= p1.attack.cancelEnd) {
      // 命中后允许绿冲取消，给下一次命中附加帧优势。
      if (in1.rush && p1.attack.didHit && p1.drive >= DRIVE_RULES.rushCost && !p1.burnout) {
        p1.drive = Math.max(0, p1.drive - DRIVE_RULES.rushCost);
        p1.dashTime = 0.18;
        p1.dashSpeed = 780;
        p1.attack = null;
        p1.attackCooldown = 0.06;
        p1.rushBuffTimer = DRIVE_RULES.rushBuffTime;
        lockDriveRegen(p1, DRIVE_RULES.regenDelayOnDriveSpend);
        addCombatEffect(room, "rushCancel", p1.x + p1.w * 0.5, p1.y + p1.h * 0.45, "CANCEL");
        if (p1.drive <= 0) p1.burnout = true;
      } else if (p1.attack.type === "rekka1" && in1.special3) startAttack(p1, "rekka2", in1.punchStrength);
      else if (p1.attack.type === "rekka2" && in1.special3) startAttack(p1, "rekka3", in1.punchStrength);
      else if (in1.punch || in1.kick)
        startAttack(p1, in1.kick ? "kick" : "punch", in1.kick ? in1.kickStrength : in1.punchStrength);
    }
  } else if (p1.attackCooldown <= 0 && !p1Stunned) {
    // 只有不在攻击中且冷却结束时，才读取新出招指令。
    if (in1.impact && p1.drive >= DRIVE_RULES.rushCost && !p1.burnout) {
      p1.drive = Math.max(0, p1.drive - DRIVE_RULES.rushCost);
      startAttack(p1, "impact", "h");
      lockDriveRegen(p1, DRIVE_RULES.regenDelayOnDriveSpend);
      if (p1.drive <= 0) p1.burnout = true;
    } else if (in1.special4 && !p1.onGround && p1.characterId === "jamie") {
      startAttack(p1, "divekick", in1.kickStrength);
      p1.vy = 680;
    } else if (in1.special2 && p1.characterId === "jamie" && p1.drinkLevel >= 2) {
      startAttack(p1, "bakkai", in1.kickStrength);
    } else if (in1.special3 && p1.characterId === "jamie") {
      startAttack(p1, "rekka1", in1.punchStrength);
    } else if (in1.punch) startAttack(p1, "punch", in1.punchStrength);
    else if (in1.kick) startAttack(p1, "kick", in1.kickStrength);
  }

  if (p2.attack) {
    p2.attack.t += dt;
    // P2 与 P1 共享同一套 cancel 判定规则。
    if (p2.attack.cancelStart !== null && p2.attack.t >= p2.attack.cancelStart && p2.attack.t <= p2.attack.cancelEnd) {
      if (in2.rush && p2.attack.didHit && p2.drive >= DRIVE_RULES.rushCost && !p2.burnout) {
        p2.drive = Math.max(0, p2.drive - DRIVE_RULES.rushCost);
        p2.dashTime = 0.18;
        p2.dashSpeed = 780;
        p2.attack = null;
        p2.attackCooldown = 0.06;
        p2.rushBuffTimer = DRIVE_RULES.rushBuffTime;
        lockDriveRegen(p2, DRIVE_RULES.regenDelayOnDriveSpend);
        addCombatEffect(room, "rushCancel", p2.x + p2.w * 0.5, p2.y + p2.h * 0.45, "CANCEL");
        if (p2.drive <= 0) p2.burnout = true;
      } else if (p2.attack.type === "rekka1" && in2.special3) startAttack(p2, "rekka2", in2.punchStrength);
      else if (p2.attack.type === "rekka2" && in2.special3) startAttack(p2, "rekka3", in2.punchStrength);
      else if (in2.punch || in2.kick)
        startAttack(p2, in2.kick ? "kick" : "punch", in2.kick ? in2.kickStrength : in2.punchStrength);
    }
  } else if (p2.attackCooldown <= 0 && !p2Stunned) {
    if (in2.impact && p2.drive >= DRIVE_RULES.rushCost && !p2.burnout) {
      p2.drive = Math.max(0, p2.drive - DRIVE_RULES.rushCost);
      startAttack(p2, "impact", "h");
      lockDriveRegen(p2, DRIVE_RULES.regenDelayOnDriveSpend);
      if (p2.drive <= 0) p2.burnout = true;
    } else if (in2.special4 && !p2.onGround && p2.characterId === "jamie") {
      startAttack(p2, "divekick", in2.kickStrength);
      p2.vy = 680;
    } else if (in2.special2 && p2.characterId === "jamie" && p2.drinkLevel >= 2) {
      startAttack(p2, "bakkai", in2.kickStrength);
    } else if (in2.special3 && p2.characterId === "jamie") {
      startAttack(p2, "rekka1", in2.punchStrength);
    } else if (in2.punch) startAttack(p2, "punch", in2.punchStrength);
    else if (in2.kick) startAttack(p2, "kick", in2.kickStrength);
  }

  updatePlayer(p1, in1, dt, state);
  updatePlayer(p2, in2, dt, state);
  resolvePlayerOverlap(p1, p2, state);

  if (p1.attack) {
    processAttack(room, p1, p2, in2);
    if (p1.attack.t > p1.attack.duration) p1.attack = null;
  }
  if (p2.attack) {
    processAttack(room, p2, p1, in1);
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
  if (p1.counterTimer > 0) p1.counterTimer = Math.max(0, p1.counterTimer - dt);
  if (p2.counterTimer > 0) p2.counterTimer = Math.max(0, p2.counterTimer - dt);

  // 非招架状态下恢复架势；燃尽状态恢复速度更慢。
  if (!p1CanParryHold && !p1Stunned && p1.driveRegenLock <= 0) {
    const regen = p1.burnout ? 6 : 12;
    p1.drive = clamp(p1.drive + regen * dt, 0, 100);
    if (p1.burnout && p1.drive >= 20) p1.burnout = false;
  }
  if (!p2CanParryHold && !p2Stunned && p2.driveRegenLock <= 0) {
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
    // 训练模式循环：双方血量归零后不结束比赛，而是计时后原地重生。
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
        p.parryTimer = 0;
        p.parryHolding = false;
        p.rushBuffTimer = 0;
        p.driveRegenLock = 0;
        p.counterTimer = 0;
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
    // 非法包或缺少 type 字段时直接丢弃。
    if (!msg || typeof msg.type !== "string") return;

    // 客户端首次握手或更新个人信息。
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

    // 主动请求最新房间列表。
    if (msg.type === "list_rooms") {
      safeSend(ws, { type: "room_list", rooms: Array.from(rooms.values()).map(roomSummary) });
      return;
    }

    // 心跳：回传 RTT 测量戳和服务端房间时间轴。
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
      // 私密房必须设置密码，避免创建出无鉴权私密房。
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
      startPlayingImmediately(room);
      safeSend(ws, { type: "room_joined", roomId: room.id, role: "player", slot: 0, mode: room.mode || "training" });
      broadcastToRoom(room, statePayload(room));
      broadcastRoomList();
      return;
    }

    if (msg.type === "join_room") {
      const room = rooms.get(msg.roomId);
      // 目标房间不存在时直接返回错误。
      if (!room) {
        safeSend(ws, { type: "error", message: "房间不存在" });
        return;
      }
      // 私密房加入前必须通过密码校验。
      if (room.isPrivate) {
        const password = typeof msg.password === "string" ? msg.password.trim() : "";
        if (!password || password !== room.password) {
          safeSend(ws, { type: "error", message: "房间密码错误" });
          return;
        }
      }
      // 先从旧房间退出，避免同一客户端同时挂在多个房间。
      if (client.roomId) {
        const oldRoom = rooms.get(client.roomId);
        removeClientFromRoom(client, oldRoom);
      }

      // 训练房只保留 1 名人类玩家；必要时清理掉无效玩家位。
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
      // 训练房已有玩家时，后续加入者默认转为观战。
      const asSpectator = !!msg.asSpectator || (room.mode === "training" && humanCount >= 1);
      const characterId = typeof msg.characterId === "string" ? msg.characterId : "";
      let slot = null;
      if (!asSpectator) slot = addPlayerToRoom(client, room, null, characterId);
      if (slot === null) addSpectatorToRoom(client, room);

      const role = client.role || "spectator";
      // 训练房始终补齐 AI 对手，保证单人可立即进入训练。
      if (room.mode === "training" && !room.ai) {
        addAIToRoom(room, {
          slot: slot === 0 ? 1 : 0,
          name: room.aiMode === "dummy" ? "木桩" : "训练机器人",
          mode: room.aiMode || "basic",
        });
      }
      if (room.players.filter(Boolean).length === 2 && room.status !== "playing") {
        if (room.mode === "training") startPlayingImmediately(room);
        else startCountdown(room);
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
      // 只有房间内玩家可提交输入；观战或离房包直接忽略。
      if (!client.roomId || client.role !== "player") return;
      const room = rooms.get(client.roomId);
      if (!room) return;
      const seq = typeof msg.seq === "number" ? msg.seq : 0;
      const lastSeq = room.inputSeq.get(client.id) || 0;
      // 丢弃乱序/重复输入包，保证服务端按序推进。
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
  // 逐房间推进对战状态：清理空房、推进状态、向房内广播最新帧。
  rooms.forEach((room) => {
    // 房间长期无人时自动回收，避免内存堆积。
    if (room.emptySince && now - room.emptySince > ROOM_EMPTY_TTL_MS) {
      rooms.delete(room.id);
      broadcastRoomList();
      return;
    }
    const dt = Math.min(0.05, (now - room.lastTick) / 1000);
    room.lastTick = now;
    room.serverTimeMs += dt * 1000;
    updateRoom(room, dt);
    // 仅在倒计时/对战中广播帧，待机与结束状态不必高频下发。
    if (room.status === "playing" || room.status === "countdown") {
      broadcastToRoom(room, statePayload(room));
    }
  });
}, TICK_MS);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Fight server running on http://localhost:${PORT}`);
});
