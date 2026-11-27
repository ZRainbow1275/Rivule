import test from 'node:test';import A from 'node:assert/strict';import {validateCatalog,gateRoute} from '../catalog/capability-gates.mjs';
const row={id:'sample',name:'Provider',type:'enterprise',market:'cn',reviewed:'2026-11-27',
 routes:[{mode:'push',stage:'mock-tested',effect:'research-public-text',liveTested:false}],
 official:['https://example.org/api'],limits:['Dedicated published Agent']};
const binding={product:'sample',mode:'push',verifiedIdentity:true,lane:'s-one',regions:['cn-mainland'],
 regionReviewed:true,costReviewed:true,writeToolsDisabled:true};
const approval={regions:['cn-mainland'],effect:'research-public-text'};
test('catalog evidence cannot authorize production or accept invented live flag',()=>{
 A.throws(()=>validateCatalog([{...row,routes:[{...row.routes[0],liveTested:true}]}]));
 const safe=validateCatalog([row]).get('sample');
 A.deepEqual(gateRoute({row:safe,mode:'push'}),{state:'needs_bound_account'});
 A.deepEqual(gateRoute({row:safe,mode:'push',binding,approval}),{state:'eligible_for_explicit_live_trial'});
});
test('unknown and changed data regions fail closed independently of product market',()=>{
 A.equal(gateRoute({row,mode:'push',binding:{...binding,regions:['sg']},approval}).state,'needs_data_region_review');
 A.equal(gateRoute({row,mode:'push',binding:{...binding,regions:['cn-mainland','unknown']},approval}).state,'needs_data_region_review');
 A.equal(gateRoute({row,mode:'push',binding:{...binding,regions:[]},approval}).state,'needs_data_region_review');
});
test('consumer handoff cannot morph into automatic dispatch through another account',()=>{
 const r={...row,routes:[{mode:'handoff',stage:'documented',effect:'manual-copy',liveTested:false}]};
 A.equal(gateRoute({row:r,mode:'push',binding,approval}).state,'not_automatable');
 A.equal(gateRoute({row:r,mode:'handoff',binding,approval}).state,'not_automatable');
});
test('docs with credentials, duplicate names on one route, or scopes mismatch reject',()=>{
 A.throws(()=>validateCatalog([{...row,official:['https://u:p@example.org']}]));
 A.throws(()=>validateCatalog([{...row,routes:[row.routes[0],row.routes[0]]}]));
 A.equal(gateRoute({row,mode:'push',binding:{...binding,costReviewed:false},approval}).state,'needs_scope_or_budget_review');
});
