import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardText, dashboardProgress } from '../src/owner/dashboard-activity.mjs';
import { readDashboardWatchlist } from '../src/owner/dashboard-read-model.mjs';
const glyphs=['📚','👩🏽‍💻','🇨🇳','e\u0301','1\ufe0f\u20e3'];
for(const glyph of glyphs)test('dashboard clipping preserves whole visible character '+glyph,()=>{
 for(const limit of [40,80,100,120,400,1200]) {
 const prefix='文'.repeat(limit-1),text=prefix+glyph+'尾';
 assert.equal(dashboardText(text,limit),prefix);
 assert.equal(dashboardText(prefix+glyph,limit-1+glyph.length),prefix+glyph);
 assert.equal(dashboardText(text,limit).isWellFormed(),true);
 }
});
test('normal text, redaction and progress unit budgets retain their rules',()=>{
 assert.equal(dashboardText('abcdef',3),'abc');
 assert.equal(dashboardText('中文'), '中文');
 assert.equal(dashboardText('password=do-not-display'+'x'.repeat(1300),120),'[包含私密字段，内容已隐藏]');
 assert.ok(!dashboardText('x'.repeat(119)+' Bearer secret-value',120).includes('secret-value'));
 assert.equal(dashboardProgress({done:1,total:2,unit:'件'.repeat(39)+'📚'}).unit,'件'.repeat(39));
});
test('real watchlist projection preserves task title and summary text boundaries',async()=>{
 const query={project_id:'project',task_id:'task',run_id:'run',branch_id:'main'},at='2026-11-17T00:00:00Z';
 const result=await readDashboardWatchlist({sourceId:'zot-main',watchlist:[query],readSnapshot:async()=>({schema_version:'1.0',source_id:'zot-main',...query,observed_at:at,found:true,snapshot:{source_status:'running',sensitivity:'normal',stale:false,archived:false,last_confirmed_at:at,pending_actions:{stored_pending_count:0},task_name:'文'.repeat(119)+'👩🏽‍💻',summary:'文'.repeat(1199)+'🇨🇳'}})});
 assert.equal(result.state,'connected');assert.equal(result.items[0].task_name,'文'.repeat(119));assert.equal(result.items[0].summary,'文'.repeat(1199));
});
test('runtime without Segmenter uses conservative complete text boundaries',()=>{
 const original=Intl.Segmenter;
 try {
  Intl.Segmenter=undefined;
  assert.equal(dashboardText('abcdef',3),'abc');
  assert.equal(dashboardText('甲乙丙丁',2),'甲乙');
  for(const glyph of glyphs){
   const result=dashboardText('文'.repeat(119)+glyph+'尾',120);
   assert.ok(result.length<=120);assert.ok(result.isWellFormed());assert.match(result,/^文*$/);
   assert.equal(dashboardText(glyph.repeat(120),1),'');
  }
 }finally{Intl.Segmenter=original;}
});
