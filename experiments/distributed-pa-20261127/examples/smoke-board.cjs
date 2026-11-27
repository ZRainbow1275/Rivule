'use strict';
const A=require('node:assert/strict'),{readFileSync}=require('node:fs'),vm=require('node:vm');
const html=readFileSync(process.argv[2]??'Rivule-调度看板演练.html','utf8');
A(html.includes("default-src 'none'"));
const run=html.match(/<script>([\s\S]+)<\/script>/)[1];
const elem=()=>({children:[],attrs:{},append(...x){this.children.push(...x)},replaceChildren(...x){this.children=x},setAttribute(k,v){this.attrs[k]=v}});
const elements=Object.fromEntries(['scenario','steps','clock','caption','cn','foreign','join','first-heading','second-heading','sync-rail'].map(x=>[x,elem()]));
vm.runInNewContext(run,{document:{getElementById:x=>elements[x],createElement:elem},structuredClone});
const check=(step,cn,us,merge)=>{
 elements.steps.children[step].onclick();
 for(const [group,want] of [['cn',cn],['foreign',us],['join',merge]])A.equal(elements[group].children[0].className,want);
 A.equal(elements.steps.children.filter(b=>b.attrs['aria-pressed']==='true').length,1);
};
check(2,'needs_review','leased','blocked');check(3,'needs_review','accepted','blocked');
check(4,'reported','accepted','blocked');check(5,'accepted','accepted','ready');
elements.scenario.onchange({target:{value:'muse'}});
A.equal(elements.foreign.children.length,2);A(elements.steps.children[5].textContent.includes('验收完成'));
elements.steps.children[5].onclick();A.equal(elements.join.children[0].className,'accepted');
elements.scenario.onchange({target:{value:'viktor'}});
check(0,'running','ready','blocked');check(1,'needs_review','ready','blocked');check(2,'needs_review','ready','blocked');check(3,'needs_review','accepted','blocked');
A.equal(elements['first-heading'].textContent,'Viktor · 海外');
A.equal(elements.cn.children[0].children[1].textContent,'待补充资料');
const rails=elements['sync-rail'];
A(rails.hidden);
elements.scenario.onchange({target:{value:'coordinator'}});
function syncStep(step,revA,revB,permit,task,merge){
 check(step,task,'ready',merge);
 A.equal(rails.hidden,false);
 A.equal(rails.children[0].children[2].textContent,'修订 '+revA);
 A.equal(rails.children[1].children[2].textContent,'修订 '+revB);
 A.equal(rails.children[2].children[1].textContent,permit+' 次');
 A.equal(rails.children[0].attrs['data-kind'],revA===revB?'steady':'lag');
}
syncStep(0,4,4,0,'leased','blocked');syncStep(1,4,5,1,'leased','blocked');syncStep(2,4,8,1,'leased','blocked');
syncStep(3,8,8,1,'accepted','ready');syncStep(4,8,8,1,'accepted','ready');syncStep(1,4,5,1,'leased','blocked');
A.equal(elements['first-heading'].textContent,'窗口 A · 当前任务');
elements.scenario.onchange({target:{value:'qwen'}});A(rails.hidden);A.equal(rails.children.length,0);
console.log(JSON.stringify({scenarios:4,noProviderIO:true,canonicalQwenPawReplay:true,canonicalViktorReplay:true,canonicalCoordinatorReplay:true}));
