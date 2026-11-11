import {MODULE_ID} from './effect-runtime.js';
import {clone} from './runtime-utils.js';
import {turnAdvance,boundaryKey,addObligation} from './ongoing-core.js';
import { noticeImmunity } from "./immunity-notice.js";
const state=j=>j.getFlag(MODULE_ID,'ongoingCast');

export async function finalizeParalysis(runtime,journal,card,saveState) {
 const record=clone(state(journal)),obligation=record.obligations.find(o=>o.cardId===card.id);
 record.status='applying';obligation.status='applying';await runtime.ongoing.save(journal,record);
 try{
  for(const target of saveState.targets.filter(t=>!t.excluded&&t.eligible!==false)){
   const recipient=record.recipients.find(r=>r.actorUuid===target.actorUuid),actor=await fromUuid(target.actorUuid);
   if(!recipient||!actor)throw Error('Paralyze recipient unavailable.');
   if(obligation.recovery){
    const entry=record.entries.find(e=>e.uuid===recipient.conditionUuid&&!e.detached),effect=entry&&await fromUuid(entry.uuid);
    if(!effect)throw Error('This paralysis ended or was detached.');
    if(target.degree==='criticalSuccess'){await effect.delete();entry.status='ended';recipient.value=0;}
    else if(target.degree==='success')await effect.update({'system.duration.value':Math.max(0,effect.system.duration.value-1)});
    target.conditionResults=[{label:target.degree==='criticalSuccess'?'Paralysis ended':target.degree==='success'?'Paralysis shortened by one round':'Paralysis duration unchanged',status:'applied',effectUuid:effect.uuid}];
   }else{
    const rounds={failure:1,criticalFailure:4}[target.degree]??0;
    if(rounds&&actor.isImmuneTo('paralyzed'))noticeImmunity({actor,blocked:`Paralyzed (${rounds} round${rounds===1?'':'s'})`,why:'immune to paralyzed',source:'Paralyze'});
    if(!rounds||actor.isImmuneTo('paralyzed'))continue;
    const template=game.pf2e.ConditionManager.getCondition('paralyzed');
    const [effect]=await actor.createEmbeddedDocuments('Item',[{name:'Paralyze: Paralyzed',type:'effect',img:template.img,system:{
     duration:{value:rounds,unit:'rounds',expiry:'turn-start'},
     context:{origin:{actor:record.sourceActorUuid,item:record.sourceItemUuid},target:{actor:actor.uuid},roll:null},
     rules:[{key:'GrantItem',uuid:template._stats.compendiumSource,flag:'paralyzed',allowDuplicate:true,onDeleteActions:{granter:'cascade',grantee:'cascade'}}]}}]);
    if(!effect)throw Error('Native paralysis was not confirmed.');
    recipient.conditionUuid=effect.uuid;recipient.value=1;recipient.recurring=target.degree==='criticalFailure';
    record.entries.push({uuid:effect.uuid,actorUuid:actor.uuid,status:'active',permanent:false});
    target.conditionResults=[{label:`Paralyzed for ${rounds} round${rounds===1?'':'s'}${recipient.recurring?' — recovery save at each turn end':''}`,status:'applied',effectUuid:effect.uuid}];
   }
  }
  obligation.status='completed';record.status=record.entries.some(e=>e.status==='active'&&!e.detached)?'active':'ended';
  if(record.status==='ended')record.endedAt=game.time.worldTime;
  await runtime.ongoing.save(journal,record);
 }catch(error){await runtime.ongoing.review(journal,`Paralyze resolution interrupted: ${error.message}`);throw error;}
}
export async function reconcileParalysis(runtime,journal,record,{recover=false,clockEvent=false}={}) {
 const clock=runtime.ongoing.clock(),advance=turnAdvance(record.clock,clock);
 if(record.entries.length&&record.entries.every(e=>e.status==='ended'||e.detached)){
  record.status='ended';record.endedAt=clock.worldTime;
  for(const o of record.obligations.filter(o=>o.recovery&&o.status==='pending'))o.status='completed';
  await runtime.ongoing.save(journal,record);return;
 }
 if((recover||clockEvent)&&record.clock?.started&&!['same','next'].includes(advance))return runtime.ongoing.review(journal,'Review missed Paralyze recovery saves after this turn-order change. No save was replayed.',{resumable:true});
 if(advance==='next')for(const recipient of record.recipients.filter(r=>r.recurring&&r.actorUuid===record.clock.actorUuid)){
  if(!record.entries.some(e=>e.uuid===recipient.conditionUuid&&e.status==='active'&&!e.detached))continue;
  addObligation(record,{key:boundaryKey(record.clock,recipient.actorUuid,'paralyze-recovery'),kind:'save',recovery:true,actorUuid:recipient.actorUuid,status:'pending',label:'Paralyze: optional Will recovery save at turn end'});
 }
 record.clock=clock;record.lastWorldTime=clock.worldTime;await runtime.ongoing.save(journal,record);
}
export async function paralysisControls(runtime,journal,record) {
 const controls=[];
 for(const obligation of record.obligations.filter(o=>o.recovery&&['pending','collecting'].includes(o.status))){
  const recipient=record.recipients.find(r=>r.actorUuid===obligation.actorUuid),actor=recipient&&await fromUuid(recipient.actorUuid);
  if(!actor||(!game.user.isGM&&!actor.isOwner)||!record.entries.some(e=>e.uuid===recipient.conditionUuid&&!e.detached&&e.status==='active'))continue;
  controls.push({action:`paralyze-${journal.id}-${obligation.key}`,label:`${actor.name}: Paralyze recovery Will save`,callback:async()=>{
   const {cardId}=obligation.cardId?obligation:await runtime.ongoing.request('roll',{castId:record.castId,revision:record.revision,actorUuid:actor.uuid,obligationKey:obligation.key});
   const card=game.messages.get(cardId);if(!card)throw Error('Recovery card unavailable.');
   for(const target of card.getFlag(MODULE_ID,'basicSaveState').targets)if(!target.degree)await runtime.saves.rollSave(card,target.id);
  }});
 }
 return controls;
}
