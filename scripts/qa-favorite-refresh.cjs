// Run after building: electron scripts/qa-favorite-refresh.cjs
// Uses an isolated profile and simulated platform responses; never opens a player.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const qaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'livehub-favorites-ui-'));
app.setPath('userData', path.join(qaDirectory, 'profile'));
process.on('exit', () => { fs.rmSync(qaDirectory, { recursive: true, force: true }); });
const { RoomSearchService } = require(root + '/dist-electron/electron/room-search-service.js');
let status = 2;
let mode = 'normal';
let directoryCalls = 0;
let favoriteCalls = 0;
let session = '123';
let releaseRequest;
const room = { id:'douyin-123', platform:'douyin', title:'QA stream', anchor:'QA Anchor', category:'Games', tags:[], cover:'linear-gradient(135deg, #302155, #7e4da6)', viewers:10, status:'live', updatedAt:'刚刚', checkedAt:Date.now(), webUrl:'https://live.douyin.com/456' };
const service = new RoomSearchService(undefined, {
 fetchHome: async()=>({response:{headers:new Headers({'set-cookie':'ttwid=qa; Path=/'})}}),
 fetchRoom: async()=>{
  if (mode === 'blocked') await new Promise(resolve=>{releaseRequest=resolve;});
  if (mode === 'failure') throw new Error('QA unavailable');
  return {status_code:0,data:{enter_room_id:session,user:{nickname:'QA Anchor'},data:[{id_str:session,status,title:'QA stream',user_count:10}]}};
 }
});
const info = Object.fromEntries(['douyin','douyu','huya','bilibili'].map(p=>[p,{state:'connected',message:'QA ready',roomCount:0,phase:'ready'}]));
ipcMain.handle('rooms:list',()=>{directoryCalls++; if(mode === 'directory-failure') throw new Error('QA directory failure');return [];});
ipcMain.handle('app:info',()=>({version,demoMode:false,platforms:['douyin','douyu','huya','bilibili'],...info}));
ipcMain.handle('favorites:migrate',(_e,ids)=>({ids,migratedCount:0,unresolvedCount:0,mergedCount:0}));
ipcMain.handle('favorites:refresh',(_e,ids)=>{favoriteCalls++;return service.refreshFavorites(ids);});
ipcMain.handle('sync:background:get',()=>false);
ipcMain.handle('danmaku:filter:get',()=>({text:true,gift:true,member:true,like:true,system:true}));
ipcMain.handle('players:state',()=>({players:[],defaultPlayerId:null}));
ipcMain.handle('updates:status',()=>({state:'idle',currentVersion:version}));
let win;
const evaluate = code => win.webContents.executeJavaScript(code);
async function until(code) {
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){if(await evaluate(code))return;await new Promise(r=>setTimeout(r,40));}
 throw new Error('Timed out: '+code);
}
const collection = () => evaluate("JSON.parse(localStorage.getItem('livehub:favorites:v2'))");
const clickRefresh = () => evaluate("document.querySelector('.refresh-button').click()");
async function refreshAndWait(){const before=favoriteCalls;await clickRefresh();await until("!document.querySelector('.refresh-button').disabled");assert.equal(favoriteCalls,before+1);}
app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({show:false,width:1440,height:920,webPreferences:{preload:root+'/dist-electron/electron/preload.js',contextIsolation:true,nodeIntegration:false,sandbox:true}});
  await win.loadFile(root+'/dist/index.html');
  await until("localStorage.getItem('livehub:favorites:v2') !== null && document.querySelector('.refresh-button') && !document.querySelector('.refresh-button').disabled");
  await evaluate(`localStorage.setItem('livehub:favorites:v2', ${JSON.stringify(JSON.stringify({version:2,ids:['douyin-web-456'],rooms:[room]}))})`);
  await win.loadFile(root+'/dist/index.html');
  await until("document.querySelectorAll('.nav-item').length > 1");
  await evaluate("document.querySelectorAll('.nav-item')[1].click()");
  await until("document.querySelector('.room-card') && document.querySelector('.nav-item.active .nav-count')?.textContent === '1' && !document.querySelector('.refresh-button').disabled");
  const initial={directoryCalls,favoriteCalls};
  status=4;
  await refreshAndWait();
  assert.equal((await collection()).rooms[0].status,'offline');
  assert.equal(await evaluate("document.querySelector('.nav-item.active .nav-count') === null"),true);
  assert.equal(directoryCalls,initial.directoryCalls+1);
  await until("document.querySelector('.room-card').textContent.includes('未开播')");
  status=2;session='789';
  await refreshAndWait();
  assert.equal((await collection()).rooms[0].id,'douyin-789');
  assert.equal((await collection()).rooms[0].status,'live');
  await until("document.querySelector('.nav-item.active .nav-count')?.textContent === '1'");
  mode='failure';await refreshAndWait();
  assert.equal((await collection()).rooms[0].status,'unknown');
  assert.equal((await collection()).ids.length,1);
  await until("document.querySelector('.room-card').textContent.includes('状态待确认')");
  mode='directory-failure';await refreshAndWait();
  assert.equal((await collection()).rooms[0].status,'live');
  mode='blocked';await clickRefresh();
  await until("document.querySelector('.refresh-button').disabled && document.querySelector('.refresh-button').textContent.includes('刷新中')");
  // Directory updates used to clear loading early; the refresh button must stay disabled.
  win.webContents.send('rooms:update',{platform:'douyin',rooms:[],status:info.douyin,mode:'featured',trigger:'manual'});
  await new Promise(r=>setTimeout(r,100));
  assert.equal(await evaluate("document.querySelector('.refresh-button').disabled"),true);
  mode='normal';releaseRequest();
  await until("!document.querySelector('.refresh-button').disabled");
  console.log(JSON.stringify({passed:true,initial,directoryCalls,favoriteCalls,checks:['refresh requests favorites and directory','live badge decreases on offline lookup','restart changes session and restores badge','failed lookup shows unknown and preserves favorite','directory failure does not block favorite update','button stays busy until favorite response']},null,2));
 }catch(e){
  process.exitCode=1;
  console.error(e.stack);
  try { console.error('UI', await evaluate("document.body.innerText")); console.error('storage', await collection()); } catch {}
 }
 finally {win?.destroy();app.exit(process.exitCode || 0);}
});
