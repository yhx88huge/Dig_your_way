import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, authorize, botAction, makeRoom, snapshot, timeoutRoom } from '../server/engine.js';
import { CARDS, DECK_COUNTS, INITIAL_SUPPLY, type Action, type Card, type Room } from '../shared/game.js';

const now=1_000_000;
function seedRandom(seed:number){let x=seed|0;return(max:number)=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)%max;};}
function setup(bots=1){const data=makeRoom('ABC234','测试囚友',bots,now);return{...data,room:applyAction(data.room,data.session.playerId,{type:'start'},{now,rng:seedRandom(42)})};}
function act(room:Room,action:Action,id=room.players[room.turnIndex].id){return applyAction(room,id,action,{now,rng:()=>0});}
function give(room:Room,card:Card,index=0){room.players[index].hand.push(card);if(card in room.supply)room.supply[card as keyof typeof INITIAL_SUPPLY]--;else{const i=room.deck.indexOf(card);if(i>=0)room.deck.splice(i,1);}}
function conserved(room:Room){
  const all=[...room.deck,...room.discard,...room.players.flatMap(p=>p.hand)];
  for(const [card,n]of Object.entries(DECK_COUNTS))assert.equal(all.filter(c=>c===card).length,n,`搜刮牌守恒 ${card}`);
  for(const [card,n]of Object.entries(INITIAL_SUPPLY))assert.equal(room.supply[card as keyof typeof INITIAL_SUPPLY]+all.filter(c=>c===card).length+room.players.flatMap(p=>p.usedTools).filter(c=>c===card).length,n,`供应牌守恒 ${card}`);
  for(const p of room.players){assert.ok(p.beatings>=0&&p.beatings<=2);assert.ok(p.cigarettes>=0);assert.equal(p.tunnel,p.usedTools.reduce((sum,c)=>sum+CARDS[c].points,0));}
  assert.ok(room.ap>=0&&room.ap<=2);
}
test('开局人数、目标、起始手牌和私人快照',()=>{
  for(const [bots,target]of [[1,12],[2,12],[3,10],[4,8],[5,8]]){const{room,session}=setup(bots);assert.equal(room.target,target);assert.ok(room.players.every(p=>p.hand.length===3));conserved(room);assert.ok(authorize(room,session.playerId,session.token));assert.ok(!authorize(room,session.playerId,'bad-token'));const view=snapshot(room,session.playerId);assert.equal(view.hand.length,3);assert.ok(!('deck'in view));assert.ok(view.players.every(p=>!('tokenHash'in p)&&!('hand'in p)));}
  const {room,session}=makeRoom('ABC234','独行',0,now);assert.throws(()=>act(room,{type:'start'},session.playerId),/至少需要两名/);
});
test('越权、非法地点和材料不足均不改变原状态',()=>{
  const{room}=setup();const before=structuredClone(room);
  assert.throws(()=>act(room,{type:'search'},room.players[1].id),/还没有轮到/);
  assert.throws(()=>act(room,{type:'dig',card:'shovel'}),/手中没有/);
  assert.throws(()=>act(room,{type:'craft',card:'shovel'}),/牢房和淋浴间/);
  assert.throws(()=>act(room,{type:'buy',card:'shovel'}),/放风区/);
  room.players[0].location='workshop';room.players[0].hand=['metal'];const craftBefore=structuredClone(room);
  assert.throws(()=>act(room,{type:'craft',card:'shovel'}),/手中没有/);assert.deepEqual(room,craftBefore);
  room.players[0]=before.players[0];assert.deepEqual(room,before);
});
test('普通移动先扣点后选择；谨慎移动消耗整回合',()=>{
  let{room}=setup();const id=room.players[0].id;
  room=act(room,{type:'rollMove'});assert.equal(room.ap,1);assert.deepEqual(room.moveChoices,['cafeteria']);
  assert.throws(()=>act(room,{type:'search'}),/骰子允许/);
  assert.throws(()=>act(room,{type:'move',destination:'cell'}),/骰子允许/);
  room=act(room,{type:'move',destination:'cafeteria'});assert.equal(room.ap,1);assert.equal(room.players[0].location,'cafeteria');
  room=act(room,{type:'stealSpoon'});assert.equal(room.turnIndex,1);assert.ok(room.players[0].hand.includes('spoon'));
  room=act(room,{type:'move',destination:'yard',cautious:true});assert.equal(room.turnIndex,0);assert.equal(room.players[1].location,'yard');assert.equal(room.players[room.turnIndex].id,id);conserved(room);
});
test('每回合搜刮一次，弃牌堆耗尽时可回收',()=>{
  let{room}=setup();room=act(room,{type:'search'});assert.equal(room.players[0].hand.length,4);assert.throws(()=>act(room,{type:'search'}),/只能搜刮一次/);
  room.searched=false;room.discard.push(...room.deck.splice(0));room=act(room,{type:'search'});assert.ok(room.deck.length>0);conserved(room);
});
test('挖掘只使用一次工具、达标即结算且禁止继续操作',()=>{
  let{room}=setup();give(room,'shovel');room.players[0].tunnel=room.target-3;const supply=room.supply.shovel;
  room=act(room,{type:'dig',card:'shovel'});assert.equal(room.status,'finished');assert.equal(room.winner,room.players[0].id);assert.equal(room.supply.shovel,supply);assert.ok(!room.players[0].hand.includes('shovel'));assert.deepEqual(room.players[0].usedTools,['shovel']);assert.throws(()=>act(room,{type:'search'}),/已经结束/);
});
test('制作、买卖和供应耗尽校验',()=>{
  let{room}=setup();room.players[0].location='workshop';give(room,'metal');give(room,'wood');
  room=act(room,{type:'craft',card:'pickaxe'});assert.ok(room.players[0].hand.includes('pickaxe'));conserved(room);
  room.players[0].location='yard';assert.throws(()=>act(room,{type:'buy',card:'shovel'}),/香烟不足/);
  const sale=room.players[0].hand[0];room=act(room,{type:'sell',cards:[sale]});assert.equal(room.players[0].cigarettes,CARDS[sale].value);conserved(room);
  room.turnIndex=0;room.ap=2;room.players[0].cigarettes=8;room=act(room,{type:'buy',card:'shovel'});assert.equal(room.players[0].cigarettes,0);conserved(room);
  room.supply.shovel=0;room.players[0].cigarettes=10;const before=structuredClone(room);assert.throws(()=>act(room,{type:'buy',card:'shovel'}),/供应不足/);assert.deepEqual(room,before);
});
test('伤势分别限制制作与挖掘，治疗后恢复',()=>{
  let{room}=setup();give(room,'spoon');room.players[0].beatings=2;assert.throws(()=>act(room,{type:'dig',card:'spoon'}),/两层伤势/);
  give(room,'bandage');room=act(room,{type:'bandage'});assert.equal(room.players[0].beatings,1);room=act(room,{type:'dig',card:'spoon'});assert.equal(room.players[0].tunnel,1);conserved(room);
  room.turnIndex=0;room.ap=2;room.players[0].location='workshop';assert.throws(()=>act(room,{type:'craft',card:'pickaxe'}),/受伤/);
  room.players[0].location='infirmary';room=act(room,{type:'heal'});assert.equal(room.players[0].beatings,0);
});
test('勒索交出工具无需受伤，战斗中不能执行普通动作',()=>{
  let{room}=setup();give(room,'knife');give(room,'pickaxe',1);const defender=room.players[1].id;room.ap=1;
  room=act(room,{type:'extort',target:defender,tool:'pickaxe',weapon:'knife'});assert.equal(room.ap,0);assert.equal(room.turnIndex,0);
  assert.throws(()=>act(room,{type:'search'}),/等待交锋/);
  room=act(room,{type:'combat',response:'give'},defender);assert.equal(room.combat,null);assert.equal(room.turnIndex,1);assert.equal(room.players[1].beatings,0);assert.ok(room.players[0].hand.includes('pickaxe'));conserved(room);
});
test('战斗交替出武器，败者受伤并失去牌',()=>{
  let{room}=setup();give(room,'knife');give(room,'club',1);give(room,'shovel',1);const attacker=room.players[0].id,defender=room.players[1].id;
  room=act(room,{type:'extort',target:defender,tool:'shovel',weapon:'knife'});
  room=act(room,{type:'combat',response:'club'},defender);assert.equal(room.combat?.responder,attacker);
  assert.throws(()=>act(room,{type:'combat',response:'club'},defender),/等待交锋/);
  const before=room.players[1].hand.length;
  room=act(room,{type:'combat',response:'surrender'},attacker);assert.equal(room.players[0].beatings,1);assert.equal(room.players[1].hand.length,before+1);conserved(room);
});
test('超过 10 张必须弃牌，选择无效不能重复卖牌或丢牌',()=>{
  let{room}=setup();for(let i=0;i<9;i++)give(room,'metal');room=act(room,{type:'endTurn'});assert.ok(room.needsDiscard);assert.equal(room.turnIndex,0);
  assert.throws(()=>act(room,{type:'discard',cards:['metal']}),/请选择 2 张/);
  assert.throws(()=>act(room,{type:'search'}),/弃置至/);
  room=act(room,{type:'discard',cards:['metal','metal']});assert.equal(room.players[0].hand.length,10);assert.equal(room.turnIndex,1);conserved(room);
});
test('回合、掷骰、战斗及弃牌超时都能推进游戏',()=>{
  let{room}=setup();assert.equal(timeoutRoom(room,room.deadline-1),null);room=act(room,{type:'rollMove'});const next=timeoutRoom(room,room.deadline)!;assert.equal(next.players[0].location,'cafeteria');assert.equal(next.turnIndex,1);
  room=setup().room;give(room,'knife');const defender=room.players[1].id;room=act(room,{type:'extort',target:defender,tool:'shovel',weapon:'knife'});room=timeoutRoom(room,room.combat!.deadline)!;assert.equal(room.combat,null);assert.equal(room.players[1].beatings,1);
  room=setup().room;for(let i=0;i<9;i++)give(room,'wood');room=act(room,{type:'endTurn'});room=timeoutRoom(room,room.deadline)!;assert.equal(room.players[0].hand.length,10);assert.equal(room.turnIndex,1);conserved(room);
});
test('200 局 2–6 人完整模拟：都能结束，卡牌守恒，无非法行动',()=>{
  let actions=0;
  for(let seed=1;seed<=200;seed++){
    const rng=seedRandom(seed),data=makeRoom('ABC234','模拟者',1+(seed%5),now);
    let room=applyAction(data.room,data.session.playerId,{type:'start'},{now,rng});let steps=0;
    while(room.status==='playing'&&steps<1800){const actor=room.combat?.responder??room.players[room.turnIndex].id;const action=botAction(room,actor);room=applyAction(room,actor,action,{now:now+steps*100,rng});conserved(room);steps++;}
    assert.equal(room.status,'finished',`seed ${seed}, turn ${room.turn}`);assert.ok(room.players.find(p=>p.id===room.winner)!.tunnel>=room.target);actions+=steps;
  }
  console.log(`完整对局模拟：200 局，${actions} 次合法行动。`);
});
