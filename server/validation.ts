import { z } from 'zod';
import { CARDS, LOCATIONS } from '../shared/game.js';
const card = z.enum(Object.keys(CARDS) as [keyof typeof CARDS, ...(keyof typeof CARDS)[]]);
const location = z.enum(Object.keys(LOCATIONS) as [keyof typeof LOCATIONS, ...(keyof typeof LOCATIONS)[]]);
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['start','addBot','restart','search','rollMove','stealSpoon','heal','bandage','endTurn']) }).strict(),
  z.object({ type: z.literal('move'), destination: location, cautious: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('dig'), card: z.enum(['spoon','pickaxe','shovel']) }).strict(),
  z.object({ type: z.enum(['craft','buy']), card: z.enum(['knife','pickaxe','shovel']) }).strict(),
  z.object({ type: z.enum(['sell','discard']), cards: z.array(card).min(1).max(30) }).strict(),
  z.object({ type: z.literal('extort'), target: z.uuid(), tool: z.enum(['spoon','pickaxe','shovel']), weapon: z.enum(['knife','club']) }).strict(),
  z.object({ type: z.literal('combat'), response: z.enum(['give','surrender','knife','club']) }).strict(),
]);
export const commandSchema = z.object({ id: z.string().min(8).max(80).regex(/^[a-zA-Z0-9_-]+$/), revision: z.number().int().min(0), action: actionSchema }).strict();
export const sessionSchema = z.object({ room: z.string().regex(/^[A-Z2-9]{6}$/), playerId: z.uuid(), token: z.string().min(32).max(100) }).strict();
export const createSchema = z.object({ name: z.string().min(1).max(32), bots: z.number().int().min(0).max(5).default(3) }).strict();
export const joinSchema = z.object({ name: z.string().min(1).max(32) }).strict();
