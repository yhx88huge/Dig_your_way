import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { createApplication } from '../server/app.js';
import { Store } from '../server/store.js';
import { applyAction, makeRoom } from '../server/engine.js';
import type { Session, Snapshot, Reply, Action } from '../shared/game.js';

test('HTTP + Socket.IO + PostgreSQL 持久化端到端验证', {timeout:90000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'digout-test-'));let server=await createApplication({dataDir:dir,production:true,tickMs:50});
  let port=await server.listen(0),base=`http://127.0.0.1:${port}`;const sockets:Socket[]=[];
  const post=async(path:string,body:unknown)=>{const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:res.status,body:await res.json()};};
  const connect=async(session:Session)=>{const socket=io(base,{auth:session,autoConnect:false,reconnection:false});sockets.push(socket);const view=await new Promise<Snapshot>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('snapshot timeout')),8000);socket.once('snapshot',(view:Snapshot)=>{clearTimeout(timer);resolve(view);});socket.once('connect_error',reject);socket.connect();});return{socket,view};};
  const submit=(socket:Socket,view:Snapshot,action:Action,id=randomUUID())=>new Promise<Reply>((resolve,reject)=>socket.timeout(5000).emit('command',{id,revision:view.revision,action},(e:Error|null,r:Reply)=>e?reject(e):resolve(r)));
  try{
    await t.test('健康状态与非法输入拒绝',async()=>{
      assert.equal((await(await fetch(base+'/api/health')).json()).storage,'pglite');assert.equal((await post('/api/rooms',{name:'',bots:12})).status,400);
      assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://untrusted.example'}})).status,403);
      const bad=await fetch(base+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'});assert.equal(bad.status,400);
      assert.equal((await fetch(base+'/api/unknown')).status,404);
    });
    await t.test('同一份本地存档拒绝第二个写入进程', async()=>{
      await assert.rejects(Store.open({dataDir:dir}), /另一个游戏进程/);
    });
    await t.test('事务中事件插入失败时，已执行的快照更新也会回滚', async()=>{
      const {room,session}=makeRoom('TEST24','事务测试',0,Date.now());await server.store.create(room);
      const next=applyAction(room,session.playerId,{type:'addBot'}),id=randomUUID();
      await server.store.save(room,next,session.playerId,id,'addBot',{});
      const failed=applyAction(next,session.playerId,{type:'start'});
      await assert.rejects(server.store.save(next,failed,session.playerId,id,'start',{}));
      assert.deepEqual((await server.store.loadRooms()).find(r=>r.code===room.code),next);
      assert.equal((await server.store.events(room.code)).length,1);
    });
    const creation=await post('/api/rooms',{name:'房主',bots:0});assert.equal(creation.status,201);const host:Session=creation.body.session;
    const joining=await post(`/api/rooms/${host.room}/join`,{name:'好友'});const guest:Session=joining.body.session;
    const a=await connect(host),b=await connect(guest);
    let hostView=a.view; a.socket.on('snapshot',view=>{hostView=view;});
    await t.test('私有快照无身份密钥和对手手牌；伪造身份无法连接',async()=>{
      assert.ok(!JSON.stringify(a.view).includes('tokenHash'));assert.ok(a.view.players.every(p=>!('hand'in p)));
      const invalid=io(base,{auth:{...host,token:'x'.repeat(43)},reconnection:false});sockets.push(invalid);
      const message=await new Promise<string>((resolve,reject)=>{invalid.once('connect_error',e=>resolve(e.message));setTimeout(()=>reject(Error('authentication timeout')),5000).unref();});assert.match(message,/身份验证/);
    });
    await t.test('开始、重复请求幂等、过期版本和非回合动作拒绝',async()=>{
      const started=await submit(a.socket,hostView,{type:'start'});assert.ok(started.ok);
      await new Promise<void>(resolve=>{if(hostView.status==='playing')resolve();else a.socket.once('snapshot',()=>resolve());});
      const revision=hostView.revision,id=randomUUID(),command={id,revision,action:{type:'search'} as Action};
      const r=await server.command(host,command);assert.ok(r.ok);const applied=server.rooms.get(host.room)!;assert.equal(applied.revision,revision+1);
      const repeat=await server.command(host,command);assert.ok(repeat.ok);assert.equal(server.rooms.get(host.room)!.revision,revision+1);
      const stale=await server.command(host,{id:randomUUID(),revision,action:{type:'rollMove'}});assert.ok(!stale.ok&&stale.code==='STALE_STATE');
      const other=await server.command(guest,{id:randomUUID(),revision:revision+1,action:{type:'search'}});assert.ok(!other.ok);assert.equal(server.rooms.get(host.room)!.revision,revision+1);
      const raw=await server.command(host,{id:randomUUID(),revision:revision+1,action:{type:'dig',card:'forged'}});assert.ok(!raw.ok&&raw.code==='BAD_REQUEST');
    });
    await t.test('同版本并发请求只应用一次，持久化失败不广播或改变状态',async()=>{
      let room=server.rooms.get(host.room)!;const [one,two]=await Promise.all([server.command(host,{id:randomUUID(),revision:room.revision,action:{type:'rollMove'}}),server.command(host,{id:randomUUID(),revision:room.revision,action:{type:'endTurn'}})]);assert.equal([one,two].filter(r=>r.ok).length,1);
      room=server.rooms.get(host.room)!;const before=structuredClone(room),original=server.store.save.bind(server.store);server.store.save=async()=>{throw Error('simulated storage outage');};
      const result=await server.command(host,{id:randomUUID(),revision:room.revision,action:room.moveChoices.length?{type:'move',destination:room.moveChoices[0]}:{type:'search'}});server.store.save=original;assert.ok(!result.ok&&result.code==='SERVER_ERROR');assert.deepEqual(server.rooms.get(host.room),before);
    });
    await t.test('Socket 断线重连恢复自己的座位和手牌',async()=>{
      a.socket.disconnect();const reconnection=await connect(host);assert.equal(reconnection.view.selfId,host.playerId);assert.deepEqual(reconnection.view.hand,server.rooms.get(host.room)!.players[0].hand);assert.equal(reconnection.view.revision,server.rooms.get(host.room)!.revision);
    });
    await t.test('服务重启恢复相同快照、事件和重连身份',async()=>{
      for(const socket of sockets)socket.disconnect();const expected=structuredClone(server.rooms.get(host.room));await server.close();
      server=await createApplication({dataDir:dir,production:true,tickMs:50});port=await server.listen(0);base=`http://127.0.0.1:${port}`;
      assert.deepEqual(server.rooms.get(host.room),expected);const reconnected=await connect(host);assert.equal(reconnected.view.revision,expected!.revision);
      const response=await fetch(`${base}/api/rooms/${host.room}/history`,{headers:{'X-Player-Id':host.playerId,Authorization:`Bearer ${host.token}`}});assert.equal(response.status,200);assert.ok((await response.json()).events.length>=3);
    });
    await t.test('并发入房限制为 6 人，已开始房间禁止中途加入',async()=>{
      assert.equal((await post(`/api/rooms/${host.room}/join`,{name:'迟到'})).status,400);
      const fresh=(await post('/api/rooms',{name:'新房主',bots:0})).body.session as Session;
      const joins=await Promise.all(Array.from({length:9},(_,i)=>post(`/api/rooms/${fresh.room}/join`,{name:`玩家${i}`})));assert.equal(joins.filter(r=>r.status===200).length,5);assert.equal(server.rooms.get(fresh.room)!.players.length,6);
    });
    await t.test('完整结算及结果与事件在同一事务落库',async()=>{
      const fresh=(await post('/api/rooms',{name:'终局测试',bots:1})).body.session as Session;
      let r=await server.command(fresh,{id:randomUUID(),revision:0,action:{type:'start'}});assert.ok(r.ok);const room=server.rooms.get(fresh.room)!;
      // 只在测试夹具中安排终局前快照，随后仍走真实事务提交。
      room.players[0].hand.push('shovel');room.supply.shovel--;room.players[0].tunnel=room.target-3;
      r=await server.command(fresh,{id:randomUUID(),revision:room.revision,action:{type:'dig',card:'shovel'}});assert.ok(r.ok);
      const results=await server.store.results(fresh.room);assert.equal(results.length,1);assert.equal((results[0] as any).winner_id,fresh.playerId);
    });
  }finally{for(const socket of sockets)socket.disconnect();await server.close();await rm(dir,{recursive:true,force:true});}
});
