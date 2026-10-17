export const LOCATIONS = {
  cell: { name: '牢房', en: 'CELL BLOCK', search: 1, subtitle: '让自由从这里开始', action: '使用工具挖掘地道' },
  cafeteria: { name: '食堂', en: 'CAFETERIA', search: 2, subtitle: '午餐之外，也有收获', action: '偷取一把汤匙' },
  workshop: { name: '工坊', en: 'WORKSHOP', search: 3, subtitle: '废料也能撬开命运', action: '搜刮效率最高' },
  yard: { name: '放风区', en: 'RECREATION', search: 2, subtitle: '每笔交易，都有代价', action: '出售物品、购买工具' },
  showers: { name: '淋浴间', en: 'SHOWERS', search: 1, subtitle: '小心背后的脚步声', action: '搜刮或与同区玩家交锋' },
  infirmary: { name: '医务室', en: 'INFIRMARY', search: 1, subtitle: '喘口气，下一次再赢', action: '治疗一层伤势' },
} as const;
export type Location = keyof typeof LOCATIONS;
export const CARDS = {
  metal: { name: '金属片', kind: 'material', value: 2, points: 0, price: 0, description: '制作工具和武器的材料。' },
  wood: { name: '木柄', kind: 'material', value: 1, points: 0, price: 0, description: '制作镐头与铁锹的材料。' },
  cloth: { name: '布条', kind: 'material', value: 1, points: 0, price: 0, description: '包裹刀柄，也可加固铁锹。' },
  trinket: { name: '私藏杂物', kind: 'goods', value: 3, points: 0, price: 0, description: '在放风区出售，可得 3 支香烟。' },
  bandage: { name: '急救包', kind: 'action', value: 2, points: 0, price: 0, description: '任意地点使用，治疗一层伤势。' },
  club: { name: '铁棍', kind: 'weapon', value: 2, points: 0, price: 0, description: '勒索或战斗时打出，使用后弃置。' },
  knife: { name: '小刀', kind: 'weapon', value: 2, points: 0, price: 2, description: '勒索或战斗时打出，使用后归还供应。' },
  spoon: { name: '汤匙', kind: 'tool', value: 1, points: 1, price: 0, description: '在牢房使用，获得 1 地道分。' },
  pickaxe: { name: '镐头', kind: 'tool', value: 4, points: 2, price: 6, description: '在牢房使用，获得 2 地道分。' },
  shovel: { name: '铁锹', kind: 'tool', value: 5, points: 3, price: 8, description: '在牢房使用，获得 3 地道分。' },
} as const;
export type Card = keyof typeof CARDS;
export type Tool = 'spoon' | 'pickaxe' | 'shovel';
export type Weapon = 'knife' | 'club';
export const RECIPES: Record<'knife'|'pickaxe'|'shovel', Partial<Record<Card, number>>> = {
  knife: { metal: 1, cloth: 1 }, pickaxe: { metal: 1, wood: 1 }, shovel: { metal: 2, wood: 1, cloth: 1 },
};
export const DICE_DESTINATIONS: Record<number, Location[]> = {
  1: ['cell', 'cafeteria'], 2: ['cell', 'yard'], 3: ['cell', 'workshop'],
  4: ['cafeteria', 'showers'], 5: ['yard', 'infirmary'], 6: ['workshop', 'showers'],
};
export const INITIAL_SUPPLY = { spoon: 24, knife: 18, pickaxe: 12, shovel: 12 };
export const DECK_COUNTS: Partial<Record<Card, number>> = { metal: 18, wood: 18, cloth: 12, trinket: 12, bandage: 6, club: 6 };
export type Action =
  | { type: 'start' | 'addBot' | 'restart' | 'search' | 'rollMove' | 'stealSpoon' | 'heal' | 'bandage' | 'endTurn' }
  | { type: 'move'; destination: Location; cautious?: boolean }
  | { type: 'dig'; card: Tool }
  | { type: 'craft' | 'buy'; card: 'knife' | 'pickaxe' | 'shovel' }
  | { type: 'sell' | 'discard'; cards: Card[] }
  | { type: 'extort'; target: string; tool: Tool; weapon: Weapon }
  | { type: 'combat'; response: 'give' | 'surrender' | Weapon };
export interface Player {
  id: string; name: string; tokenHash: string; bot: boolean; location: Location;
  hand: Card[]; cigarettes: number; beatings: number; tunnel: number; usedTools: Tool[];
}
export interface Combat {
  attacker: string; defender: string; responder: string; tool: Tool; stage: 'intimidation' | 'fight'; deadline: number;
}
export interface LogEntry { id: number; text: string; at: number }
export interface Room {
  code: string; revision: number; hostId: string; status: 'lobby'|'playing'|'finished'; players: Player[];
  gameId: string; turnIndex: number; turn: number; ap: number; searched: boolean; extorted: boolean;
  deck: Card[]; discard: Card[]; supply: typeof INITIAL_SUPPLY; logs: LogEntry[];
  moveChoices: Location[]; lastDie: number | null; combat: Combat | null; needsDiscard: boolean;
  winner: string | null; target: number; deadline: number; updatedAt: number; createdAt: number;
}
export interface PublicPlayer extends Omit<Player, 'tokenHash'|'hand'> { handCount: number; online: boolean }
export interface Snapshot extends Omit<Room, 'players'|'deck'|'discard'> {
  players: PublicPlayer[]; deckCount: number; discardCount: number; hand: Card[]; selfId: string;
}
export interface Session { room: string; playerId: string; token: string }
export interface RoomSummary { code: string; status: Room['status']; players: number; host: string; updatedAt: number }
export type Reply = { ok: true; revision: number } | { ok: false; error: string; code?: string };
export const isTool = (card: Card): card is Tool => CARDS[card].kind === 'tool';
export const isWeapon = (card: Card): card is Weapon => CARDS[card].kind === 'weapon';
