"""掘地出笼 · 简化版规则引擎。所有规则在服务端验证，无第三方依赖。"""
from __future__ import annotations

import copy
import secrets

VERSION = 1
LOCATIONS = {
    'cell': {'name': '牢房', 'search': 1},
    'cafeteria': {'name': '食堂', 'search': 2},
    'workshop': {'name': '工坊', 'search': 3},
    'yard': {'name': '放风区', 'search': 2},
    'showers': {'name': '淋浴间', 'search': 1},
    'infirmary': {'name': '医务室', 'search': 1},
}
CARDS = {
    'metal': {'name': '金属片', 'kind': 'material', 'value': 2, 'icon': 'metal'},
    'wood': {'name': '木柄', 'kind': 'material', 'value': 1, 'icon': 'wood'},
    'cloth': {'name': '布条', 'kind': 'material', 'value': 1, 'icon': 'cloth'},
    'trinket': {'name': '私藏杂物', 'kind': 'goods', 'value': 3, 'icon': 'box'},
    'bandage': {'name': '急救包', 'kind': 'action', 'value': 2, 'icon': 'heal'},
    'club': {'name': '铁棍', 'kind': 'weapon', 'value': 2, 'icon': 'club'},
    'knife': {'name': '小刀', 'kind': 'weapon', 'value': 2, 'icon': 'knife', 'price': 2},
    'spoon': {'name': '汤匙', 'kind': 'tool', 'value': 1, 'icon': 'spoon', 'points': 1},
    'pickaxe': {'name': '镐头', 'kind': 'tool', 'value': 4, 'icon': 'pickaxe', 'points': 2, 'price': 6},
    'shovel': {'name': '铁锹', 'kind': 'tool', 'value': 5, 'icon': 'shovel', 'points': 3, 'price': 8},
}
RECIPES = {
    'knife': {'metal': 1, 'cloth': 1},
    'pickaxe': {'metal': 1, 'wood': 1},
    'shovel': {'metal': 2, 'wood': 1, 'cloth': 1},
}
INITIAL_SUPPLY = {'spoon': 24, 'knife': 18, 'pickaxe': 12, 'shovel': 12}
DECK_COUNTS = {'metal': 18, 'wood': 18, 'cloth': 12, 'trinket': 12, 'bandage': 6, 'club': 6}
BOT_NAMES = ['老钟', '乌鸦', '螺丝', '阿墨', '独眼']


class RuleError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise RuleError(message)


def clean_name(value):
    require(isinstance(value, str), '请输入昵称。')
    value = ''.join(c for c in value.strip() if c.isprintable())[:16]
    require(bool(value), '昵称不能为空。')
    return value


def new_player(name, bot=False):
    return {'id': secrets.token_hex(8), 'token': secrets.token_urlsafe(24),
            'name': clean_name(name), 'bot': bot}


def new_room(code, name, bots=3):
    require(type(bots) is int and 0 <= bots <= 5, '电脑数量应为 0–5。')
    owner = new_player(name)
    room = {'version': VERSION, 'code': code, 'owner': owner['id'], 'revision': 0,
            'status': 'waiting', 'players': [owner], 'receipts': [], 'logs': [],
            'game': None}
    for i in range(bots):
        room['players'].append(new_player(BOT_NAMES[i], True))
    return room, owner['token']


def player_for_token(room, token):
    return next((p for p in room['players'] if secrets.compare_digest(p['token'], token)), None)


def add_log(room, message):
    room['logs'].append({'round': room['game']['round'] if room['game'] else 0, 'text': message})
    room['logs'] = room['logs'][-100:]


def random_number(game, maximum):
    # 可存档的伪随机数状态：重启服务不改变已经提交的行动。
    game['rng'] = (1664525 * game['rng'] + 1013904223) & 0xffffffff
    return (game['rng'] >> 8) % maximum


def shuffle(game, cards):
    for i in range(len(cards) - 1, 0, -1):
        j = random_number(game, i + 1)
        cards[i], cards[j] = cards[j], cards[i]


def draw(room, player, count):
    game = room['game']
    drawn = 0
    for _ in range(count):
        if not game['deck'] and game['discard']:
            game['deck'], game['discard'] = game['discard'], []
            shuffle(game, game['deck'])
            add_log(room, '搜寻牌堆已耗尽，弃牌重新洗入牌堆。')
        if not game['deck']:
            break
        player['hand'].append(game['deck'].pop())
        drawn += 1
    return drawn


def take_supply(game, player, kind):
    require(kind in game['supply'] and game['supply'][kind] > 0, '该物品暂时缺货。')
    game['supply'][kind] -= 1
    game['next_id'] += 1
    player['hand'].append({'id': 't' + str(game['next_id']), 'type': kind})


def discard_card(game, player, card):
    player['hand'].remove(card)
    if card['type'] in game['supply']:
        game['supply'][card['type']] += 1
    else:
        game['discard'].append(card)


def start_game(room, seed=None):
    require(2 <= len(room['players']) <= 6, '需要 2–6 位玩家，可以添加电脑。')
    n = len(room['players'])
    game = {'rng': secrets.randbits(32) if seed is None else seed & 0xffffffff,
            'deck': [], 'discard': [], 'supply': dict(INITIAL_SUPPLY), 'next_id': 0,
            'turn': 0, 'round': 1, 'ap': 2, 'searched': False, 'extorted': False,
            'goal': 12 if n <= 3 else 10 if n == 4 else 8, 'winner': None}
    for kind, count in DECK_COUNTS.items():
        for i in range(count):
            game['deck'].append({'id': f'{kind}-{i}', 'type': kind})
    shuffle(game, game['deck'])
    room['game'], room['status'], room['logs'] = game, 'playing', []
    for player in room['players']:
        player.update(location='cell', hand=[], used=[], cigarettes=2, injury=0, score=0)
        draw(room, player, 3)
    add_log(room, f'越狱计划开始。率先达到 {game["goal"]} 隧道点获胜！')


def advance(room):
    game = room['game']
    game['turn'] = (game['turn'] + 1) % len(room['players'])
    if game['turn'] == 0:
        game['round'] += 1
    game.update(ap=2, searched=False, extorted=False)


def card_by_id(player, card_id):
    card = next((c for c in player['hand'] if c['id'] == card_id), None)
    require(card is not None, '这张牌已不在你的手牌中，请刷新后重试。')
    return card


def selected_cards(player, ids):
    require(isinstance(ids, list) and 1 <= len(ids) <= 200 and all(isinstance(x, str) for x in ids), '请选择手牌。')
    require(len(set(ids)) == len(ids), '不能重复选择同一张牌。')
    return [card_by_id(player, x) for x in ids]


def can_craft(player, kind):
    return kind in RECIPES and all(sum(c['type'] == k for c in player['hand']) >= n for k, n in RECIPES[kind].items())


def _game_action(room, player, action):
    game = room['game']
    require(room['status'] == 'playing', '当前不在游戏中。')
    require(room['players'][game['turn']]['id'] == player['id'], '还没轮到你。')
    kind = action.get('type')
    if kind == 'discard':
        cards = selected_cards(player, action.get('cards'))
        require(len(player['hand']) > 10, '只有超过 10 张手牌时才需要弃牌。')
        require(len(cards) <= len(player['hand']) - 10, '只需弃掉超过上限的牌。')
        for card in cards:
            discard_card(game, player, card)
        add_log(room, f'{player["name"]}弃掉了 {len(cards)} 张牌。')
        if len(player['hand']) <= 10 and game['ap'] == 0:
            advance(room)
        return
    if kind == 'end':
        require(len(player['hand']) <= 10, '回合结束最多保留 10 张牌，请先弃牌。')
        add_log(room, f'{player["name"]}结束了回合。')
        advance(room)
        return
    require(game['ap'] > 0, '行动点已用完，请先把手牌弃至 10 张。')
    name, loc = player['name'], player['location']
    if kind == 'move':
        destination = action.get('location')
        require(isinstance(destination, str) and destination in LOCATIONS, '无效地点。')
        require(destination != loc, '你已经在这里了。')
        player['location'] = destination
        add_log(room, f'{name}前往了{LOCATIONS[destination]["name"]}。')
    elif kind == 'search':
        require(not game['searched'], '每回合只能搜寻一次。')
        require(bool(game['deck'] or game['discard']), '搜寻牌暂时全部在玩家手中。')
        count = draw(room, player, LOCATIONS[loc]['search'])
        game['searched'] = True
        add_log(room, f'{name}搜寻，获得了 {count} 张牌。')
    elif kind == 'spoon':
        require(loc == 'cafeteria', '只能在食堂偷汤匙。')
        take_supply(game, player, 'spoon')
        add_log(room, f'{name}从食堂顺走了一把汤匙。')
    elif kind == 'dig':
        require(loc == 'cell', '只能在牢房挖掘。')
        require(player['injury'] < 2, '两级受伤时不能挖掘，请先治疗。')
        card = card_by_id(player, action.get('card'))
        spec = CARDS[card['type']]
        require(spec['kind'] == 'tool', '请选择汤匙、镐头或铁锹。')
        player['hand'].remove(card)
        player['used'].append(card)
        player['score'] += spec['points']
        add_log(room, f'{name}用{spec["name"]}挖掘，获得 {spec["points"]} 隧道点。')
        if player['score'] >= game['goal']:
            game['winner'], room['status'] = player['id'], 'finished'
            add_log(room, f'{name}挖通了隧道，成功逃离黑门监狱！')
    elif kind == 'craft':
        require(loc not in ('cell', 'showers'), '牢房和淋浴间不能制作工具。')
        require(player['injury'] == 0, '受伤时不能制作，请先治疗。')
        item = action.get('item')
        require(isinstance(item, str) and item in RECIPES, '无效配方。')
        require(can_craft(player, item), '制作材料不足。')
        require(game['supply'][item] > 0, '该工具暂时缺货。')
        for material, count in RECIPES[item].items():
            for _ in range(count):
                discard_card(game, player, next(c for c in player['hand'] if c['type'] == material))
        take_supply(game, player, item)
        add_log(room, f'{name}制作了一把{CARDS[item]["name"]}。')
    elif kind == 'buy':
        require(loc == 'yard', '只能在放风区购买。')
        item = action.get('item')
        require(isinstance(item, str) and item in ('knife', 'pickaxe', 'shovel'), '无效商品。')
        price = CARDS[item]['price']
        require(player['cigarettes'] >= price, '香烟不足。')
        take_supply(game, player, item)
        player['cigarettes'] -= price
        add_log(room, f'{name}花费 {price} 支香烟购买了{CARDS[item]["name"]}。')
    elif kind == 'sell':
        require(loc == 'yard', '只能在放风区出售。')
        cards = selected_cards(player, action.get('cards'))
        value = sum(CARDS[c['type']]['value'] for c in cards)
        for card in cards:
            discard_card(game, player, card)
        player['cigarettes'] += value
        add_log(room, f'{name}出售 {len(cards)} 张牌，获得 {value} 支香烟。')
    elif kind == 'heal':
        require(loc == 'infirmary', '只能在医务室治疗。')
        require(player['injury'] > 0, '你目前没有受伤。')
        player['injury'] -= 1
        add_log(room, f'{name}在医务室治疗，伤势降低一级。')
    elif kind == 'bandage':
        require(player['injury'] > 0, '你目前没有受伤。')
        card = card_by_id(player, action.get('card'))
        require(card['type'] == 'bandage', '请选择急救包。')
        discard_card(game, player, card)
        player['injury'] -= 1
        add_log(room, f'{name}使用急救包，伤势降低一级。')
    elif kind == 'extort':
        require(not game['extorted'], '每回合只能勒索一次。')
        defender = next((p for p in room['players'] if p['id'] == action.get('target')), None)
        require(defender is not None and defender != player, '请选择其他玩家。')
        require(defender['location'] == loc, '只能勒索同一地点的玩家。')
        wanted = action.get('item')
        require(wanted in ('spoon', 'pickaxe', 'shovel'), '请选择要索取的工具。')
        attacker_weapons = [c for c in player['hand'] if CARDS[c['type']]['kind'] == 'weapon']
        defender_weapons = [c for c in defender['hand'] if CARDS[c['type']]['kind'] == 'weapon']
        require(bool(attacker_weapons), '至少需要一张武器才能勒索。')
        # 简化为双方自动出武器；攻击方先出，同数武器时防守方胜。
        attacker_wins = len(attacker_weapons) > len(defender_weapons)
        spent_a = min(len(attacker_weapons), len(defender_weapons) + 1)
        spent_d = min(len(defender_weapons), len(attacker_weapons))
        for card in attacker_weapons[:spent_a]:
            discard_card(game, player, card)
        for card in defender_weapons[:spent_d]:
            discard_card(game, defender, card)
        winner, loser = (player, defender) if attacker_wins else (defender, player)
        loser['injury'] = min(2, loser['injury'] + 1)
        loot = next((c for c in loser['hand'] if c['type'] == wanted), None) if attacker_wins else None
        if not loot and loser['hand']:
            loot = loser['hand'][random_number(game, len(loser['hand']))]
        if loot:
            loser['hand'].remove(loot)
            winner['hand'].append(loot)
        game['extorted'] = True
        add_log(room, f'{name}勒索{defender["name"]}，{winner["name"]}获胜；{loser["name"]}受伤一级。')
    else:
        raise RuleError('未知行动。')
    game['ap'] -= 1
    if room['status'] == 'playing' and game['ap'] == 0 and len(player['hand']) <= 10:
        advance(room)


def apply_action(room, player_id, action):
    """事务式执行：失败不会消耗资源或改变原状态。"""
    require(isinstance(action, dict), '行动参数格式错误。')
    result = copy.deepcopy(room)
    player = next((p for p in result['players'] if p['id'] == player_id), None)
    require(player is not None, '玩家不在房间中。')
    _game_action(result, player, action)
    result['revision'] += 1
    validate(result)
    return result


def choose_bot_action(room):
    game = room['game']
    p = room['players'][game['turn']]
    hand, loc = p['hand'], p['location']
    if len(hand) > 10:
        count = len(hand) - 10
        cards = sorted(hand, key=lambda c: (CARDS[c['type']].get('points', 0) * 15 + (3 if c['type'] in ('metal', 'wood') else 0) + CARDS[c['type']]['value']))
        return {'type': 'discard', 'cards': [c['id'] for c in cards[:count]]}
    if game['ap'] == 0:
        return {'type': 'end'}
    if p['injury']:
        aid = next((c for c in hand if c['type'] == 'bandage'), None)
        if aid:
            return {'type': 'bandage', 'card': aid['id']}
        return {'type': 'heal'} if loc == 'infirmary' else {'type': 'move', 'location': 'infirmary'}
    tools = [c for c in hand if CARDS[c['type']]['kind'] == 'tool']
    if tools:
        if loc == 'cell':
            return {'type': 'dig', 'card': max(tools, key=lambda c: CARDS[c['type']]['points'])['id']}
        return {'type': 'move', 'location': 'cell'}
    craft = next((k for k in ('shovel', 'pickaxe') if can_craft(p, k) and game['supply'][k]), None)
    if craft:
        return {'type': 'move', 'location': 'workshop'} if loc in ('cell', 'showers') else {'type': 'craft', 'item': craft}
    purchasable = next((k for k in ('shovel', 'pickaxe') if p['cigarettes'] >= CARDS[k]['price'] and game['supply'][k]), None)
    if purchasable:
        return {'type': 'buy', 'item': purchasable} if loc == 'yard' else {'type': 'move', 'location': 'yard'}
    sellable = [c['id'] for c in hand if c['type'] in ('trinket', 'club', 'bandage', 'cloth')]
    if len(sellable) >= 3:
        return {'type': 'sell', 'cards': sellable} if loc == 'yard' else {'type': 'move', 'location': 'yard'}
    if loc == 'cafeteria' and game['supply']['spoon']:
        return {'type': 'spoon'}
    if loc == 'cell':
        return {'type': 'move', 'location': 'workshop' if len(hand) <= 5 or not game['supply']['spoon'] else 'cafeteria'}
    if not game['searched'] and (game['deck'] or game['discard']):
        return {'type': 'search'}
    if loc != 'cafeteria' and game['supply']['spoon'] and len(hand) >= 5:
        return {'type': 'move', 'location': 'cafeteria'}
    if loc != 'workshop':
        return {'type': 'move', 'location': 'workshop'}
    return {'type': 'end'}


def snapshot(room, player_id):
    result = {'code': room['code'], 'owner': room['owner'], 'revision': room['revision'],
              'status': room['status'], 'me': player_id, 'logs': room['logs'], 'players': []}
    game = room['game']
    if game:
        result['game'] = {k: game[k] for k in ('turn', 'round', 'ap', 'searched', 'extorted', 'goal', 'winner', 'supply')}
        result['game']['deckCount'] = len(game['deck'])
        result['game']['discardCount'] = len(game['discard'])
    else:
        result['game'] = None
    for p in room['players']:
        public = {k: p[k] for k in ('id', 'name', 'bot')}
        if game:
            public.update({k: p[k] for k in ('location', 'cigarettes', 'injury', 'score', 'used')})
            public['handCount'] = len(p['hand'])
            if p['id'] == player_id:
                public['hand'] = p['hand']
        result['players'].append(public)
    return copy.deepcopy(result)


def validate(room):
    require(room.get('version') == VERSION, '存档版本不匹配。')
    players = room['players']
    require(1 <= len(players) <= 6 and len({p['id'] for p in players}) == len(players), '玩家数据异常。')
    require(room['owner'] in {p['id'] for p in players}, '房主数据异常。')
    g = room['game']
    if not g:
        require(room['status'] == 'waiting', '房间状态异常。')
        return
    require(room['status'] in ('playing', 'finished'), '对局状态异常。')
    require(0 <= g['turn'] < len(players) and 0 <= g['ap'] <= 2, '回合数据异常。')
    require(g['goal'] == (12 if len(players) <= 3 else 10 if len(players) == 4 else 8), '胜利目标异常。')
    cards = g['deck'] + g['discard']
    for p in players:
        require(p['location'] in LOCATIONS and 0 <= p['injury'] <= 2 and p['cigarettes'] >= 0, '玩家资源异常。')
        require(len(p['hand']) <= 200, '手牌数量异常。')
        require(p['score'] == sum(CARDS[c['type']]['points'] for c in p['used']), '隧道积分异常。')
        cards = cards + p['hand'] + p['used']
    require(all(c['type'] in CARDS for c in cards), '未知卡牌。')
    require(len({c['id'] for c in cards}) == len(cards), '卡牌重复。')
    for kind, count in DECK_COUNTS.items():
        require(sum(c['type'] == kind for c in cards) == count, '搜寻卡牌数量不守恒。')
    for kind, count in INITIAL_SUPPLY.items():
        require(g['supply'][kind] >= 0 and g['supply'][kind] + sum(c['type'] == kind for c in cards) == count, '公共物品数量不守恒。')
    if room['status'] == 'finished':
        require(any(p['id'] == g['winner'] and p['score'] >= g['goal'] for p in players), '胜利状态异常。')
    else:
        require(not any(p['score'] >= g['goal'] for p in players), '游戏应已结束。')
