import { randomInt, randomUUID, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { CARDS, DECK_COUNTS, DICE_DESTINATIONS, INITIAL_SUPPLY, LOCATIONS, RECIPES, isTool, isWeapon, type Action, type Card, type Player, type Room, type Session, type Snapshot, type Tool } from '../shared/game.js';

export class GameError extends Error {
  constructor(message: string, public code = 'INVALID_ACTION') { super(message); }
}
export function requireRule(condition: unknown, message: string): asserts condition { if (!condition) throw new GameError(message); }
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const authorize = (room: Room, id: string, token: string) => {
  const player = room.players.find(p => p.id === id);
  const hash = hashToken(token);
  return !!player && !player.bot && player.tokenHash.length === hash.length && timingSafeEqual(Buffer.from(player.tokenHash), Buffer.from(hash));
};
const cleanName = (name: string) => {
  const cleaned = name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 16);
  requireRule(cleaned, '请输入昵称。'); return cleaned;
};
export function makePlayer(name: string, bot = false): { player: Player; token: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, player: { id: randomUUID(), name: cleanName(name), bot, tokenHash: hashToken(token), location: 'cell', hand: [], cigarettes: 0, beatings: 0, tunnel: 0, usedTools: [] } };
}
const BOT_NAMES = ['老钟', '乌鸦', '螺丝', '阿墨', '独眼'];
export function makeRoom(code: string, name: string, bots: number, now: number): { room: Room; session: Session } {
  requireRule(Number.isInteger(bots) && bots >= 0 && bots <= 5, '电脑数量应为 0–5。');
  const { player, token } = makePlayer(name);
  const room: Room = {
    code, revision: 0, hostId: player.id, status: 'lobby', players: [player], gameId: '',
    turnIndex: 0, turn: 1, ap: 0, searched: false, extorted: false,
    deck: [], discard: [], supply: { ...INITIAL_SUPPLY }, logs: [], moveChoices: [], lastDie: null,
    combat: null, needsDiscard: false, winner: null, target: 12, deadline: 0, updatedAt: now, createdAt: now,
  };
  for (let i = 0; i < bots; i++) room.players.push(makePlayer(BOT_NAMES[i], true).player);
  log(room, `${player.name} 创建了房间，越狱计划正在酝酿。`, now);
  return { room, session: { room: code, playerId: player.id, token } };
}
export function log(room: Room, text: string, now: number) {
  room.logs.push({ id: (room.logs.at(-1)?.id ?? 0) + 1, text, at: now });
  room.logs = room.logs.slice(-100);
}
export const shuffle = <T>(items: T[], rng: (max: number) => number): T[] => {
  for (let i = items.length - 1; i > 0; i--) { const j = rng(i + 1); [items[i], items[j]] = [items[j], items[i]]; }
  return items;
};
function draw(room: Room, player: Player, count: number, rng: (max: number) => number) {
  let actual = 0;
  for (let i = 0; i < count; i++) {
    if (!room.deck.length) room.deck = shuffle(room.discard.splice(0), rng);
    const card = room.deck.pop(); if (!card) break;
    player.hand.push(card); actual++;
  }
  return actual;
}
function remove(player: Player, card: Card) {
  const index = player.hand.indexOf(card);
  requireRule(index >= 0, `手中没有${CARDS[card].name}。`); player.hand.splice(index, 1);
}
function discard(room: Room, player: Player, card: Card) {
  remove(player, card);
  if (card in room.supply) room.supply[card as keyof typeof INITIAL_SUPPLY]++;
  else room.discard.push(card);
}
function supply(room: Room, player: Player, card: keyof typeof INITIAL_SUPPLY) {
  requireRule(room.supply[card] > 0, `${CARDS[card].name}供应不足。`);
  room.supply[card]--; player.hand.push(card);
}
function nextTurn(room: Room, now: number, turnMs: number) {
  room.turnIndex = (room.turnIndex + 1) % room.players.length; room.turn++;
  room.ap = 2; room.searched = false; room.extorted = false; room.moveChoices = [];
  room.needsDiscard = false; room.lastDie = null; room.deadline = now + turnMs;
  log(room, `轮到 ${room.players[room.turnIndex].name}：获得 2 次行动。`, now);
}
function finishTurn(room: Room, now: number, turnMs: number) {
  if (room.status !== 'playing' || room.ap > 0 || room.combat || room.moveChoices.length) return;
  const p = room.players[room.turnIndex];
  if (p.hand.length > 10) { room.needsDiscard = true; room.deadline = now + 30_000; }
  else nextTurn(room, now, turnMs);
}
function start(room: Room, now: number, turnMs: number, rng: (max: number) => number) {
  requireRule(room.players.length >= 2, '至少需要两名玩家，可以添加电脑。');
  room.status = 'playing'; room.gameId = randomUUID(); room.target = room.players.length <= 3 ? 12 : room.players.length === 4 ? 10 : 8;
  room.deck = shuffle(Object.entries(DECK_COUNTS).flatMap(([c, n]) => Array<Card>(n!).fill(c as Card)), rng);
  room.discard = []; room.supply = { ...INITIAL_SUPPLY }; room.turnIndex = 0; room.turn = 1;
  room.ap = 2; room.searched = false; room.extorted = false; room.combat = null;
  room.moveChoices = []; room.lastDie = null; room.needsDiscard = false; room.winner = null; room.logs = [];
  room.deadline = now + turnMs;
  for (const p of room.players) {
    p.location = 'cell'; p.hand = []; p.cigarettes = 0; p.beatings = 0; p.tunnel = 0; p.usedTools = [];
    draw(room, p, 3, rng);
  }
  log(room, `越狱开始！率先达到 ${room.target} 地道分即可逃出黑门监狱。`, now);
}
function resolveCombat(room: Room, loserId: string, now: number, rng: (max: number) => number) {
  const combat = room.combat!;
  const loser = room.players.find(p => p.id === loserId)!;
  const winner = room.players.find(p => p.id === (loserId === combat.attacker ? combat.defender : combat.attacker))!;
  loser.beatings = Math.min(2, loser.beatings + 1);
  const card = loser.id === combat.defender && loser.hand.includes(combat.tool) ? combat.tool : loser.hand[rng(Math.max(1, loser.hand.length))];
  if (card) { remove(loser, card); winner.hand.push(card); }
  log(room, `${winner.name} 赢得交锋，拿走一张牌；${loser.name} 增加一层伤势。`, now);
  room.combat = null;
}
export interface EngineContext { now?: number; turnMs?: number; rng?: (max: number) => number }
export function applyAction(original: Room, playerId: string, action: Action, ctx: EngineContext = {}): Room {
  const room = structuredClone(original), now = ctx.now ?? Date.now(), turnMs = ctx.turnMs ?? 90_000, rng = ctx.rng ?? randomInt;
  const player = room.players.find(p => p.id === playerId);
  requireRule(player, '玩家不存在。');
  if (action.type === 'addBot') {
    requireRule(room.status === 'lobby' && room.hostId === playerId, '只有房主可以在等待中添加电脑。');
    requireRule(room.players.length < 6, '房间已满。');
    room.players.push(makePlayer(BOT_NAMES.find(n => !room.players.some(p => p.name === n)) ?? '囚友', true).player);
    log(room, '一位电脑囚友加入了越狱计划。', now);
  } else if (action.type === 'start' || action.type === 'restart') {
    requireRule(room.hostId === playerId, '只有房主可以开始。');
    requireRule(action.type === 'start' ? room.status === 'lobby' : room.status === 'finished', '当前状态不能开始对局。');
    start(room, now, turnMs, rng);
  } else {
    requireRule(room.status === 'playing', '对局尚未开始或已经结束。');
    if (room.combat) {
      requireRule(action.type === 'combat' && room.combat.responder === playerId, '等待交锋玩家回应。');
      const c = room.combat;
      if (action.response === 'give') {
        requireRule(c.stage === 'intimidation' && playerId === c.defender, '现在不能交出工具。');
        remove(player, c.tool); room.players.find(p => p.id === c.attacker)!.hand.push(c.tool);
        log(room, `${player.name} 交出${CARDS[c.tool].name}，避免了交锋。`, now); room.combat = null;
      } else if (action.response === 'surrender') resolveCombat(room, playerId, now, rng);
      else {
        discard(room, player, action.response); c.stage = 'fight';
        c.responder = playerId === c.attacker ? c.defender : c.attacker; c.deadline = now + 30_000;
        log(room, `${player.name} 打出${CARDS[action.response].name}，继续交锋。`, now);
      }
    } else {
      requireRule(room.players[room.turnIndex].id === playerId, '还没有轮到你。');
      if (room.needsDiscard) {
        requireRule(action.type === 'discard', '请先将手牌弃置至 10 张。');
        requireRule(action.cards.length === player.hand.length - 10, `请选择 ${player.hand.length - 10} 张手牌弃置。`);
        action.cards.forEach(card => discard(room, player, card)); room.needsDiscard = false;
        log(room, `${player.name} 整理了手牌。`, now);
      } else if (room.moveChoices.length) {
        requireRule(action.type === 'move' && !action.cautious && room.moveChoices.includes(action.destination), '请选择骰子允许的目的地。');
        player.location = action.destination; room.moveChoices = [];
        log(room, `${player.name} 前往${LOCATIONS[player.location].name}。`, now);
      } else {
        requireRule(action.type !== 'combat' && action.type !== 'discard', '当前没有待回应的交锋或弃牌。');
        const cost = action.type === 'move' ? 2 : action.type === 'endTurn' ? 0 : 1;
        requireRule(room.ap >= cost, '剩余行动点不足。');
        switch (action.type) {
          case 'search': {
            requireRule(!room.searched, '每回合只能搜刮一次。');
            const count = draw(room, player, LOCATIONS[player.location].search, rng);
            requireRule(count > 0, '牌堆暂时没有可搜刮的物品。'); room.searched = true;
            log(room, `${player.name} 在${LOCATIONS[player.location].name}搜刮了 ${count} 张牌。`, now); break;
          }
          case 'rollMove': {
            room.lastDie = rng(6) + 1;
            room.moveChoices = DICE_DESTINATIONS[room.lastDie].filter(l => l !== player.location);
            log(room, `${player.name} 掷出 ${room.lastDie}，正在选择去向。`, now); break;
          }
          case 'move':
            requireRule(action.cautious && action.destination !== player.location, '谨慎移动必须选择其他地点。');
            player.location = action.destination;
            log(room, `${player.name} 谨慎移动至${LOCATIONS[player.location].name}。`, now); break;
          case 'stealSpoon':
            requireRule(player.location === 'cafeteria', '只能在食堂偷汤匙。'); supply(room, player, 'spoon');
            log(room, `${player.name} 从食堂顺走一把汤匙。`, now); break;
          case 'dig':
            requireRule(player.location === 'cell', '必须回牢房才能挖掘。');
            requireRule(player.beatings < 2, '两层伤势时无法挖掘，请先治疗。');
            remove(player, action.card); player.usedTools.push(action.card); player.tunnel += CARDS[action.card].points;
            log(room, `${player.name} 用${CARDS[action.card].name}挖掘，地道 +${CARDS[action.card].points}。`, now);
            if (player.tunnel >= room.target) {
              room.status = 'finished'; room.winner = playerId; room.deadline = 0;
              log(room, `${player.name} 逃出了黑门监狱！警报响起，本局结束。`, now);
            }
            break;
          case 'craft':
            requireRule(player.location !== 'cell' && player.location !== 'showers', '牢房和淋浴间不能制作。');
            requireRule(player.beatings === 0, '受伤时不能制作，请先治疗。');
            for (const [card, count] of Object.entries(RECIPES[action.card])) {
              for (let i = 0; i < count!; i++) discard(room, player, card as Card);
            }
            supply(room, player, action.card); log(room, `${player.name} 制作了${CARDS[action.card].name}。`, now); break;
          case 'buy':
            requireRule(player.location === 'yard', '只能在放风区交易。');
            requireRule(player.cigarettes >= CARDS[action.card].price, '香烟不足。');
            supply(room, player, action.card); player.cigarettes -= CARDS[action.card].price;
            log(room, `${player.name} 花 ${CARDS[action.card].price} 支香烟购买${CARDS[action.card].name}。`, now); break;
          case 'sell': {
            requireRule(player.location === 'yard', '只能在放风区交易。');
            requireRule(action.cards.length > 0, '请先选择要出售的手牌。');
            let income = 0;
            for (const card of action.cards) { discard(room, player, card); income += CARDS[card].value; }
            player.cigarettes += income; log(room, `${player.name} 出售 ${action.cards.length} 张牌，获得 ${income} 支香烟。`, now); break;
          }
          case 'heal':
            requireRule(player.location === 'infirmary', '只能在医务室治疗。');
            requireRule(player.beatings > 0, '你目前没有受伤。'); player.beatings--;
            log(room, `${player.name} 治疗了一层伤势。`, now); break;
          case 'bandage':
            requireRule(player.beatings > 0, '你目前没有受伤。'); discard(room, player, 'bandage'); player.beatings--;
            log(room, `${player.name} 使用急救包，治疗了一层伤势。`, now); break;
          case 'extort': {
            requireRule(!room.extorted, '每回合只能勒索一次。');
            const target = room.players.find(p => p.id === action.target && p.id !== playerId);
            requireRule(target && target.location === player.location, '只能勒索同一地点的其他玩家。');
            discard(room, player, action.weapon); room.extorted = true;
            room.combat = { attacker: playerId, defender: target.id, responder: target.id, tool: action.tool, stage: 'intimidation', deadline: now + 30_000 };
            log(room, `${player.name} 向 ${target.name} 索要${CARDS[action.tool].name}。`, now); break;
          }
          case 'endTurn': room.ap = 0; log(room, `${player.name} 结束了回合。`, now); break;
        }
        room.ap -= cost;
      }
    }
    finishTurn(room, now, turnMs);
  }
  room.revision++; room.updatedAt = now; return room;
}
export function timeoutRoom(original: Room, now: number, turnMs = 90_000): Room | null {
  if (original.status !== 'playing') return null;
  const room = structuredClone(original);
  if (room.combat) {
    if (room.combat.deadline > now) return null;
    resolveCombat(room, room.combat.responder, now, randomInt);
    finishTurn(room, now, turnMs);
  } else {
    if (room.deadline > now) return null;
    const player = room.players[room.turnIndex];
    if (room.moveChoices.length) { player.location = room.moveChoices[0]; room.moveChoices = []; }
    while (player.hand.length > 10) {
      const card = [...player.hand].sort((a, b) => CARDS[a].value - CARDS[b].value)[0]; discard(room, player, card);
    }
    log(room, `${player.name} 超时，系统自动结束回合。`, now); nextTurn(room, now, turnMs);
  }
  room.revision++; room.updatedAt = now; return room;
}
export function botAction(room: Room, id: string): Action {
  const p = room.players.find(p => p.id === id)!;
  if (room.combat) {
    if (room.combat.stage === 'intimidation' && p.id === room.combat.defender && p.hand.includes(room.combat.tool)) return { type: 'combat', response: 'give' };
    return { type: 'combat', response: p.hand.find(isWeapon) ?? 'surrender' };
  }
  if (room.needsDiscard) return { type: 'discard', cards: [...p.hand].sort((a,b) => CARDS[a].value - CARDS[b].value).slice(0, p.hand.length - 10) };
  if (room.moveChoices.length) return { type: 'move', destination: room.moveChoices.includes('cell') && p.hand.some(isTool) ? 'cell' : room.moveChoices.includes('cafeteria') ? 'cafeteria' : room.moveChoices[0] };
  if (p.beatings && p.hand.includes('bandage')) return { type: 'bandage' };
  if (p.beatings && p.location === 'infirmary') return { type: 'heal' };
  if (p.beatings && room.ap === 2) return { type: 'move', destination: 'infirmary', cautious: true };
  const tool = [...p.hand].filter(isTool).sort((a,b) => CARDS[b].points - CARDS[a].points)[0];
  if (tool && p.beatings < 2) {
    if (p.location === 'cell') return { type: 'dig', card: tool };
    if (room.ap === 2 && (p.hand.filter(isTool).length >= 2 || p.tunnel + CARDS[tool].points >= room.target)) return { type: 'move', destination: 'cell', cautious: true };
  }
  if (p.beatings === 0 && p.location !== 'cell' && p.location !== 'showers') {
    for (const card of ['shovel','pickaxe'] as const) {
      if (room.supply[card] > 0 && Object.entries(RECIPES[card]).every(([c,n]) => p.hand.filter(x => x === c).length >= n!)) return { type: 'craft', card };
    }
  }
  if (p.location === 'yard' && p.cigarettes >= 8 && room.supply.shovel) return { type: 'buy', card: 'shovel' };
  if (p.location === 'yard' && p.cigarettes >= 6 && room.supply.pickaxe) return { type: 'buy', card: 'pickaxe' };
  if (!tool && p.location === 'yard' && p.hand.length) return { type: 'sell', cards: [...p.hand] };
  if (p.location === 'cafeteria' && !tool && room.supply.spoon) return { type: 'stealSpoon' };
  if (p.location === 'cafeteria' && p.hand.filter(isTool).length < 3 && room.supply.spoon && room.ap === 1) return { type: 'stealSpoon' };
  if (tool && room.ap === 2 && p.location !== 'cell') return { type: 'move', destination: 'cell', cautious: true };
  if (!tool && p.location !== 'cafeteria' && room.ap === 2 && room.supply.spoon) return { type: 'move', destination: 'cafeteria', cautious: true };
  if (!tool && !room.supply.spoon && p.location !== 'yard' && room.ap === 2) return { type: 'move', destination: 'yard', cautious: true };
  if (!room.searched && (room.deck.length || room.discard.length) && p.hand.length < 9) return { type: 'search' };
  return { type: 'rollMove' };
}
export function snapshot(room: Room, selfId: string, online: Set<string> = new Set()): Snapshot {
  const { deck, discard, players, ...rest } = room;
  return { ...rest, players: players.map(({ tokenHash: _secret, hand, ...p }) => ({ ...p, handCount: hand.length, online: p.bot || online.has(p.id) })), hand: [...(players.find(p => p.id === selfId)?.hand ?? [])], selfId, deckCount: deck.length, discardCount: discard.length };
}
