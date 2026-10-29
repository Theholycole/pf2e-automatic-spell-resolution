import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareFormSource,formSize,rechargeReady,validateFormRank} from '../scripts/form-core.js';
const fixture=name=>JSON.parse(readFileSync(new URL(`../.cache/pf2e-test-fixtures/spell-effects/spell-effect-${name}.json`,import.meta.url)));
test('form rank and space tiers reject illegal choices',()=>{assert.throws(()=>validateFormRank('dragon-form',5));assert.throws(()=>validateFormRank('animal-form',2.5));assert.equal(formSize('animal-form',4),'lg');assert.equal(formSize('animal-form',5),'huge');assert.equal(formSize('dragon-form',8),'huge');});
test('Dragon clone corrects Despair, rank-8 status speed and hands without modifying native data',()=>{const native=fixture('dragon-form'),copy=structuredClone(native),source=prepareFormSource(native,{kind:'dragon-form',rank:8,choice:'despair'});assert.deepEqual(native,copy);assert.equal(source.system.rules.find(r=>r.key==='ChoiceSet').selection.saveType,'will');assert.equal(source.system.rules.find(r=>r.key==='BattleForm').hasHands,true);assert.ok(source.system.rules.some(r=>r.key==='FlatModifier'&&r.type==='status'&&r.selector==='fly-speed'&&r.value===20));assert.throws(()=>prepareFormSource(native,{kind:'dragon-form',rank:8,choice:'sovereign'}));assert.throws(()=>prepareFormSource(native,{kind:'dragon-form',rank:8,choice:'invented'}));});
test('Pest heightened flight remains optional',()=>{const native=fixture('pest-form');assert.equal(prepareFormSource(native,{kind:'pest-form',rank:4}).system.rules[0].brackets.length,0);assert.equal(prepareFormSource(native,{kind:'pest-form',rank:4,flying:true}).system.rules[0].brackets[0].value.speeds.fly,20);});
test('recharge follows same turn after full rounds and never opens on backward time or a changed combat',()=>{const use={worldTime:100,combatId:'A',round:3,turn:2,rounds:2};assert.equal(rechargeReady(use,{worldTime:112,started:true,combatId:'A',round:5,turn:1}),false);assert.equal(rechargeReady(use,{worldTime:112,started:true,combatId:'A',round:5,turn:2}),true);assert.equal(rechargeReady(use,{worldTime:200,started:true,combatId:'B',round:10,turn:2}),false);assert.equal(rechargeReady({...use,combatId:null},{worldTime:111}),false);assert.equal(rechargeReady({...use,combatId:null},{worldTime:112}),true);assert.equal(rechargeReady(use,{worldTime:99,started:true,combatId:'A',round:5,turn:2}),false);});
import {installFormGuards} from '../scripts/form-native-guards.js';
test('managed-form guards preserve native methods outside forms and stop spending before cast',()=>{
 class Entry{cast(){this.spent=true;return 'native';}}
 class Consumable{consume(){this.spent=true;}}
 class Character{prepareData(){this.system={movement:{speeds:{land:{value:25},fly:{value:50},swim:{value:20}}}};}}
 class Battle{onDelete(){}}
 class Temp{onDelete(){}}
 const oldGame=globalThis.game;globalThis.game={pf2e:{RuleElements:{builtin:{BattleForm:Battle,TempHP:Temp}}}};
 const previous=globalThis.CONFIG;
 globalThis.CONFIG={PF2E:{Item:{documentClasses:{spellcastingEntry:Entry,consumable:Consumable}},Actor:{documentClasses:{character:Character}}}};
 const effect={type:'effect',isExpired:false,getFlag:()=> 'cast',system:{rules:[{key:'BattleForm'}]},rules:[{key:'BattleForm',overrides:{speeds:{land:30}}}]};
 try{installFormGuards();installFormGuards();const entry=new Entry();entry.actor={items:[],flags:{pf2e:{battleForm:true}}};assert.equal(entry.cast(),'native');entry.spent=false;entry.actor.items=[effect];assert.throws(()=>entry.cast(),/prevents spellcasting/);assert.equal(entry.spent,false);const c=new Character();c.flags={pf2e:{battleForm:true}};c.items=[effect];c.prepareData();assert.equal(c.system.movement.speeds.fly,null);assert.equal(c.system.movement.speeds.swim,null);c.items=[];c.prepareData();assert.equal(c.system.movement.speeds.fly.value,50);}finally{globalThis.CONFIG=previous;globalThis.game=oldGame;}
});
import {createHash} from 'node:crypto';
import {FORM_EFFECT_HASHES} from '../scripts/form-baseline.js';
import {canonicalFormMechanics} from '../scripts/form-core.js';
test('native form mechanical baseline is pinned independently of key ordering',()=>{for(const name of ['animal-form-bear','dragon-form','pest-form']){const source=fixture(name);assert.equal(createHash('sha256').update(canonicalFormMechanics(source)).digest('hex'),FORM_EFFECT_HASHES[source._id]);source.system.duration.value++;assert.notEqual(createHash('sha256').update(canonicalFormMechanics(source)).digest('hex'),FORM_EFFECT_HASHES[source._id]);}});
test('unstarted encounters use elapsed world time for breath recharge',()=>{assert.equal(rechargeReady({combatId:'inactive',started:false,worldTime:100,rounds:3},{worldTime:118,started:false}),true);});
test('expired managed forms still delegate source-aware native temporary HP cleanup',()=>{
 const oldGame=globalThis.game,oldConfig=globalThis.CONFIG;let calls=0;
 class Battle{constructor(item){this.item=item;}onDelete(){return 'native';}}
 class Temp{constructor(_data,{parent}){this.item=parent;}onDelete(updates){calls++;if(updates.source===this.item.id)updates.temp=0;}}
 class Entry{cast(){}}class Consumable{consume(){}}class Character{prepareData(){}}
 globalThis.game={pf2e:{RuleElements:{builtin:{BattleForm:Battle,TempHP:Temp}}}};globalThis.CONFIG={PF2E:{Item:{documentClasses:{spellcastingEntry:Entry,consumable:Consumable}},Actor:{documentClasses:{character:Character}}}};
 try{installFormGuards();const b=new Battle({id:'form',getFlag:()=>true});const own={source:'form',temp:10};assert.equal(b.onDelete(own),'native');assert.equal(own.temp,0);const other={source:'other',temp:40};b.onDelete(other);assert.equal(other.temp,40);assert.equal(calls,2);}finally{globalThis.game=oldGame;globalThis.CONFIG=oldConfig;}
});
test('with libWrapper on, the form guards go through it once, as WRAPPER or MIXED (2026-10-11)',()=>{
 const oldGame=globalThis.game,oldConfig=globalThis.CONFIG,registered=[];
 class Entry{cast(){return 'native';}}class Consumable{consume(){}}class Character{prepareData(){}}class Battle{onDelete(){}}class Temp{onDelete(){}}
 globalThis.libWrapper={register(id,target,fn,type){registered.push([id,target,type]);const path=target.split('.'),key=path.pop(),owner=path.reduce((o,p)=>o[p],globalThis),original=owner[key];owner[key]=function(...args){return fn.call(this,(...inner)=>original.apply(this,inner),...args);};}};
 globalThis.game={modules:new Map([['lib-wrapper',{active:true}]]),pf2e:{RuleElements:{builtin:{BattleForm:Battle,TempHP:Temp}}}};globalThis.CONFIG={PF2E:{Item:{documentClasses:{spellcastingEntry:Entry,consumable:Consumable}},Actor:{documentClasses:{character:Character}}}};
 try{installFormGuards();installFormGuards();
  assert.deepEqual(registered,[['pf2e-automatic-resolution','game.pf2e.RuleElements.builtin.BattleForm.prototype.onDelete','WRAPPER'],['pf2e-automatic-resolution','CONFIG.PF2E.Actor.documentClasses.character.prototype.prepareData','WRAPPER'],['pf2e-automatic-resolution','CONFIG.PF2E.Item.documentClasses.spellcastingEntry.prototype.cast','MIXED'],['pf2e-automatic-resolution','CONFIG.PF2E.Item.documentClasses.consumable.prototype.consume','MIXED']]);
  const entry=new Entry();entry.actor={items:[],flags:{pf2e:{battleForm:true}}};assert.equal(entry.cast(),'native');
 }finally{delete globalThis.libWrapper;globalThis.game=oldGame;globalThis.CONFIG=oldConfig;}
});
import {existsSync} from 'node:fs';
import {formDigestVerified} from '../scripts/form-baseline.js';
// (2026-10-29) PF2e 8.6's installed form Effects, when there: each one's digest verified (8.5.0's or 8.6.1's), and Dragon Form's own rank-8
// fly bonus not doubled by ours.
test('the installed PF2e form Effects are verified, Dragon Form keeping one rank-8 fly bonus',async t=>{
 const packs=`${process.env.HOME}/.local/share/FoundryVTT/Data/systems/pf2e/packs/spell-effects`;
 if(!existsSync(packs))return t.skip('PF2e isn\'t installed here');
 const {readDocuments}=await import('../../pf2e-automatic-ability-resolution/tools/leveldb.mjs');
 const effects=new Map(readDocuments(packs).map(d=>[d._id,d]));
 for(const id of Object.keys(FORM_EFFECT_HASHES)){const d=effects.get(id);assert.ok(d,id);assert.ok(formDigestVerified(id,createHash('sha256').update(canonicalFormMechanics(d)).digest('hex')),d.name);}
 const dragon=effects.get('1pC1qjvCuAKzjYo8'),source=prepareFormSource(dragon,{kind:'dragon-form',rank:8,choice:'despair'});
 assert.equal(source.system.rules.filter(r=>r.key==='FlatModifier'&&r.selector==='fly-speed'&&r.type==='status').length,1);
 assert.equal(source.system.rules.find(r=>r.key==='ChoiceSet').selection.saveType,'will');
});
