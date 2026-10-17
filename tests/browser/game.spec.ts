import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
async function create(page:Page,name:string,bots='1'){
  await page.goto('/');await page.getByLabel('你的代号').fill(name);await page.getByLabel('电脑囚友').selectOption(bots);await page.getByRole('button',{name:'创建我的房间'}).click();await expect(page.getByRole('heading',{name:'计划已就位，等囚友集结。'})).toBeVisible();
}
test('创建、规则弹窗、完整操作、刷新、断网和恢复',async({page,context},testInfo)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await mkdir('artifacts',{recursive:true});
  await page.goto('/');await expect(page.getByRole('heading',{name:'掘地出笼',exact:true})).toBeVisible();
  await page.screenshot({path:`artifacts/lobby-${testInfo.project.name}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.getByRole('button',{name:'游戏规则'}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'计划明白了，开始挖'}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  await create(page,`试玩${testInfo.project.name}`);
  await page.getByRole('button',{name:'开始越狱'}).click();await expect(page.getByText('轮到你了，离自由再近一点。')).toBeVisible();
  await page.getByRole('button',{name:'谨慎移动'}).click();await page.getByRole('button',{name:'食堂，移动到这里',exact:true}).click();
  await expect(page.getByText('轮到你了，离自由再近一点。')).toBeVisible({timeout:15000});
  await page.getByRole('button',{name:'偷取汤匙'}).click();await expect(page.locator('.hand-card').filter({hasText:'汤匙'})).toHaveCount(1);
  await page.getByRole('button',{name:'偷取汤匙'}).click();await expect(page.locator('.hand-card').filter({hasText:'汤匙'})).toHaveCount(2);
  await expect(page.getByText('轮到你了，离自由再近一点。')).toBeVisible({timeout:15000});
  await page.getByRole('button',{name:'谨慎移动'}).click();await page.getByRole('button',{name:'牢房，移动到这里',exact:true}).click();
  await expect(page.getByText('轮到你了，离自由再近一点。')).toBeVisible({timeout:15000});
  await page.locator('.hand-card').filter({hasText:'汤匙'}).first().click();await page.getByRole('button',{name:'挖掘地道'}).click();
  await expect(page.locator('.player-card.self .tunnel-caption>b')).toHaveText('1 / 12');
  await page.screenshot({path:`artifacts/table-${testInfo.project.name}.png`,fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  if(testInfo.project.name==='mobile')expect((await page.locator('.turn-info').boundingBox())!.width).toBeGreaterThan(200);
  const hand=await page.locator('.hand-card').count();await page.reload();await expect(page.locator('.hand-card')).toHaveCount(hand);await expect(page.locator('.player-card.self .tunnel-caption>b')).toHaveText('1 / 12');
  await context.setOffline(true);await expect(page.getByText('连接中断，操作暂时停用。恢复连接后自动同步最新进度。')).toBeVisible({timeout:35000});
  await expect(page.getByRole('button',{name:'普通移动'})).toBeDisabled();await context.setOffline(false);await page.getByRole('button',{name:'立即重连'}).click();await expect(page.getByText('已连接',{exact:true})).toBeVisible();
  await expect(page.locator('.hand-card')).toHaveCount(hand);expect(errors).toEqual([]);
});
test('两个独立浏览器会话加入同一房间并同步',async({page,browser},testInfo)=>{
  await create(page,`房主${testInfo.project.name}`,'0');const code=await page.locator('.room-code>b').innerText();
  const guestContext=await browser.newContext(testInfo.project.name==='mobile'?{viewport:{width:393,height:851},isMobile:true,hasTouch:true}:{viewport:{width:1280,height:900}});const guest=await guestContext.newPage();
  try{
    await guest.goto(new URL(`/?room=${code}`,page.url()).href);await guest.getByLabel('你的代号').fill('好友');await guest.getByRole('button',{name:'进入房间',exact:true}).click();await expect(page.getByText('好友',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'开始越狱'}).click();await expect(guest.getByText(`房主${testInfo.project.name} 正在行动`,{exact:true})).toBeVisible();await expect(guest.getByRole('button',{name:'搜刮物资'})).toBeDisabled();
    await page.getByRole('button',{name:'结束回合',exact:true}).click();await expect(guest.getByText('轮到你了，离自由再近一点。')).toBeVisible();await guest.getByRole('button',{name:'搜刮物资'}).click();await expect(guest.locator('.hand-card')).toHaveCount(4);await expect(page.locator('.player-card').filter({hasText:'好友'}).locator('.player-stats>span').first()).toHaveText('4');
    await guest.reload();await expect(guest.locator('.player-card.self .player-top b')).toHaveText('好友你');await expect(guest.locator('.hand-card')).toHaveCount(4);
  }finally{await guestContext.close();}
});
