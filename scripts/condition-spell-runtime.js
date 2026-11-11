import {finalizeParalysis,reconcileParalysis,paralysisControls} from './paralysis-runtime.js';
import { MODULE_ID } from './effect-runtime.js';
import { clone, randomID, escapeHTML as esc } from './runtime-utils.js';
import { turnAdvance, addObligation, boundaryKey } from './ongoing-core.js';
import { emptyConditionSavePlan, sickenedAfterRecovery, clingingIceSavePlan } from './condition-spell-core.js';
import { conditionProfileDigest, CONDITION_PROFILE_HASHES, CONDITION_PROFILE_FIELDS, clingingIceEffectMechanics, CLINGING_ICE_EFFECT_MECHANICS } from './condition-spell-baseline.js';
import { castSpellFromUuid, spellFromSource } from './cast-spell.js';
import { noticeImmunity } from "./immunity-notice.js";
const state = j => j.getFlag(MODULE_ID, 'ongoingCast');
const IDS = { 'evil-eye': 'f45JpY7Ph2cAJGW2', fear: '4koZzrnMXhhosn0D', 'clinging-ice':'MraZBLJ4Be3ogmWL', paralyze:'DCQHaLrYXMI37dvW' };

export class ConditionSpellRuntime {
    constructor(ongoing, saves) { this.ongoing = ongoing; this.saves = saves; }
    supports(item) { return Object.hasOwn(IDS, item?.slug ?? item?.system?.slug); }
    visibilityFingerprint(record, recipient) {
        const token=fromUuidSync(recipient.tokenUuid), scene=token?.parent;
        const caster=fromUuidSync(record.sourceActorUuid);
        return JSON.stringify({caster:[...(caster?.statuses??[])].sort(),scene:scene?.id,
            tokens:(scene?.tokens?.contents??[]).filter(t=>t.uuid===recipient.tokenUuid||t.actor?.uuid===record.sourceActorUuid).map(t=>[t.id,t._source.x,t._source.y,t._source.elevation,t._source.hidden,[...(t.actor?.statuses??[])].sort()]),
            walls:(scene?.walls?.contents??[]).map(w=>[w.id,w.c,w.ds,w.sight]),
            darkness:scene?.environment?.darknessLevel});
    }
    currentVisibility(record, recipient) {
        if(recipient?.visibilityFingerprint&&recipient.visibilityFingerprint!==this.visibilityFingerprint(record,recipient))return null;
        return recipient?.visible;
    }
    async start(item, options = {}) {
        this.ongoing.assertCoordinator();
        const original = await fromUuid(`Compendium.pf2e.spells-srd.Item.${IDS[item.slug]}`);
        const fields = CONDITION_PROFILE_FIELDS;
        if (!original) throw Error('The original condition-spell profile is unavailable.');
        if(await conditionProfileDigest(original)!==CONDITION_PROFILE_HASHES[item.slug])throw Error('Condition-spell mechanics changed from the verified PF2e baseline. Review before applying.');
        if(item.slug==='clinging-ice'){
            const effect=await fromUuid('Compendium.pf2e.spell-effects.Item.2sMXAGZfdqiy10kk');
            if(!effect||clingingIceEffectMechanics(effect)!==CLINGING_ICE_EFFECT_MECHANICS)throw Error('Clinging Ice Effect mechanics changed from the verified baseline. Review before applying.');
        }
        const comparable = (document, key) => key === 'description'
            ? document._source.system.description.value.replace(/<hr\s*\/?\s*>/gi,'<hr>').replace(/\s+/g,' ').trim()
            : JSON.stringify(document._source.system[key]);
        // (A heightened copy carries PF2e's own fixed-level values for the cast rank — Fear's 5 targets at 3rd: those match the original's.)
        const atRank = Number(options.castRank ?? item.rank);
        const levels = original._source.system.heightening?.type === 'fixed' ? original._source.system.heightening.levels ?? {} : {};
        const heightenedValue = key => Object.entries(levels).filter(([rank, level]) => Number(rank) <= atRank && level && key in level).sort((a, b) => Number(a[0]) - Number(b[0])).at(-1)?.[1]?.[key];
        const changed = fields.filter(key => comparable(item,key) !== comparable(original,key)
            && !(heightenedValue(key) !== undefined && JSON.stringify(item._source.system[key]) === JSON.stringify(heightenedValue(key))));
        if (changed.length) throw Error(`Changed condition-spell ${changed.join(', ')} requires review.`);
        const targets = [...(options.targets ?? game.user.targets)].map(t => t.document ?? t);
        const castRank = Number(options.castRank ?? item.rank);
        const limit = item.slug==='paralyze'&&castRank>=7?10:item.slug === 'fear' && castRank >= 3 ? 5 : 1;
        if (!targets.length || targets.length > limit || targets.some(t=>!t.actor?.isOfType('creature'))) throw Error(`Target between one and ${limit} creatures for ${item.name}.`);
        const message = options.sourceMessageId && game.messages.get(options.sourceMessageId);
        if (message && (message.actor?.uuid !== item.actor.uuid || message.item?.uuid !== item.uuid)) throw Error('This source card does not match the caster and spell.');
        if (message?.getFlag(MODULE_ID,'ongoingCastId')) throw Error('This source card already has an ongoing cast.');
        const rank = Number(options.castRank ?? item.rank);
        if (!Number.isInteger(rank) || rank < (item.baseRank??item._source.system.level.value) || rank > 10) throw Error('Choose a legal cast rank.');
        const castId = randomID(), clock = this.ongoing.clock();
        const journal = await this.ongoing.begin({ castId, kind:'condition-spell', profile:item.slug, name:item.name, sourceActorUuid:item.actor.uuid,
            sourceItemUuid:item.uuid, recoverySource:item.toObject(), sourceMessageId:message?.id ?? null, rank, recipientUuids:targets.map(t=>t.actor.uuid),
            casterInitiative:game.combat?.combatants.find(c=>c.actor?.uuid===item.actor.uuid)?.initiative??null,
            recipients:targets.map(t=>({actorUuid:t.actor.uuid,tokenUuid:t.uuid,visible:null})), spellActive:['evil-eye','clinging-ice'].includes(item.slug), castRound:clock.round,
            sustainedRound:null, maximumAt:clock.worldTime+60, sustainDueAt:clock.worldTime+12 });
        try {
            if(message)await message.setFlag(MODULE_ID,'ongoingCastId',castId);
            await this.prepare(journal, targets, false);
            await this.ongoing.activate(journal);
            return {status:'prepared',castId,journalId:journal.id};
        } catch(error) { await this.ongoing.review(journal,`Condition spell setup interrupted: ${error.message}`); throw error; }
    }
    async prepare(journal, targets, recovery, pendingKey=null) {
        const record = clone(state(journal)), actor = await fromUuid(record.sourceActorUuid);
        // (A spell cast from a wand or scroll is PF2e's copy for that cast, which no UUID finds afterwards: the copy kept when the cast started.)
        let stored=null;try{stored=record.sourceItemUuid?await castSpellFromUuid(record):null;}catch(_){stored=null;}
        const item = recovery && record.recoverySource && actor
            ? new CONFIG.Item.documentClass(clone(record.recoverySource),{parent:actor})
            : stored?.type==='spell' ? stored : record.recoverySource && actor ? spellFromSource(record.recoverySource,actor) : null;
        if (!item || !actor) throw Error('The original caster or spell is unavailable. Review this cast before rolling.');
        if(record.obligations.some(o=>o.status==='collecting'))throw Error('Finish the pending save before another recovery attempt.');
        const plan = record.profile==='clinging-ice' ? clingingIceSavePlan(item) : emptyConditionSavePlan(item, recovery&&record.profile==='evil-eye'?'fortitude':'will');
        if(record.profile==='paralyze'&&!recovery)plan.resolution.outcomes.success.effects=[{kind:'condition',slug:'stunned',name:'Stunned',value:1,duration:null}];
        if(recovery)plan.resolution.check.purpose='condition-recovery';
        if(recovery)plan.source.name = `${record.name} — ${record.profile==='evil-eye'?'Retch':'Recovery'}`;
        const {card} = await this.saves.start(item,{sourceActor:actor,plan,targets,castRank:record.rank,dc:record.dc,
            recoverySource:recovery?record.recoverySource:null,skipConfirmation:true});
        await card.setFlag(MODULE_ID,'ongoingCastId',record.castId);
        record.dc ??= card.getFlag(MODULE_ID,'basicSaveState').dc;
        const pending=pendingKey&&record.obligations.find(o=>o.key===pendingKey&&o.status==='pending');
        if(pending){pending.cardId=card.id;pending.status='collecting';}
        else addObligation(record,{key:randomID(),kind:'save',label:recovery?'Retch — 1 action':'Initial save',recovery,actorUuid:targets[0].actor.uuid,cardId:card.id,status:'collecting'});
        await this.ongoing.save(journal,record);
        return{cardId:card.id};
    }
    assertSave(journal, cardId) {
        const record=state(journal), obligation=record.obligations.find(o=>o.cardId===cardId);
        if(record.status!=='active'||obligation?.status!=='collecting')throw Error('This condition save is no longer collecting.');
        const save=game.messages.get(cardId)?.getFlag(MODULE_ID,'basicSaveState');
        for(const target of save?.targets??[]){
            if(target.excluded||target.eligible===false)continue;
            const recipient=record.recipients.find(r=>r.actorUuid===target.actorUuid);
            if(recipient?.conditionUuid&&record.entries.some(e=>e.uuid===recipient.conditionUuid&&e.detached))throw Error('This condition was detached; manage its recovery manually.');
            if(!recipient)throw Error('The target roster differs from this ongoing cast. Exclude the added target before finalizing.');
            if(obligation.recovery&&record.profile==='paralyze'){
                const effect=recipient.conditionUuid&&fromUuidSync(recipient.conditionUuid);
                if(!effect||effect.isExpired)throw Error('Paralysis has already ended; no recovery save is needed.');
            }
            if(obligation.recovery&&record.profile==='evil-eye'){
                const condition=fromUuidSync(recipient.conditionUuid);
                sickenedAfterRecovery(condition?._source.system.value.value??0,target.degree,{spellActive:record.spellActive,visible:this.currentVisibility(record,recipient)});
            }
        }
    }
    async finalize(journal, card, saveState) {
        const record = clone(state(journal)), obligation = record.obligations.find(o=>o.cardId===card.id);
        if(record.status!=='active'||obligation?.status!=='collecting')throw Error('This condition save is not awaiting finalization.');
        if(record.profile==='paralyze')return finalizeParalysis(this,journal,card,saveState);
        if(record.profile==='clinging-ice')return this.finalizeIce(journal,card,saveState);
        const changes=[];
        for(const target of saveState.targets) {
            if(target.excluded||target.eligible===false)continue;
            const recipient=record.recipients.find(r=>r.actorUuid===target.actorUuid);
            if(!recipient)throw Error('This target is not part of the ongoing cast.');
            const actor=await fromUuid(recipient.actorUuid),condition=recipient.conditionUuid&&await fromUuid(recipient.conditionUuid);
            if(!actor)throw Error('The condition recipient is unavailable.');
            let value=obligation.recovery ? sickenedAfterRecovery(condition?._source.system.value.value??0,target.degree,{spellActive:record.spellActive,visible:this.currentVisibility(record,recipient)})
                : ((record.profile==='fear'?{success:1,failure:2,criticalFailure:3}:{failure:1,criticalFailure:2})[target.degree]??0);
            if (!obligation.recovery && value && actor.isImmuneTo(record.profile==='fear'?'frightened':'sickened')) { noticeImmunity({ actor, blocked: `${record.profile==='fear'?'Frightened':'Sickened'} ${value}`, why: `immune to ${record.profile==='fear'?'frightened':'sickened'}`, source: record.name ?? null }); value = 0; }
            changes.push({target,recipient,actor,condition,value});
        }
        record.status='applying';obligation.status='applying';await this.ongoing.save(journal,record);
        try {
            for(const {target,recipient,actor,condition,value} of changes){
                if(obligation.recovery){
                    if(value===0){await condition.delete({[MODULE_ID]:{conditionRecovery:true}});const entry=record.entries.find(e=>e.uuid===condition.uuid);if(entry)entry.status='ended';}
                    else await condition.update({'system.value.value':value},{[MODULE_ID]:{conditionRecovery:true}});
                }else if(value){
                    const source=game.pf2e.ConditionManager.getCondition(record.profile==='fear'?'frightened':'sickened').toObject();delete source._id;
                    source.system.value.value=value;
                    source.flags??={};source.flags[MODULE_ID]={conditionCastId:record.castId};
                    const [created]=await actor.createEmbeddedDocuments('Item',[source]);
                    if(!created)throw Error('Native Sickened creation was not confirmed.');
                    recipient.conditionUuid=created.uuid;
                    record.entries.push({uuid:created.uuid,actorUuid:actor.uuid,status:'active',permanent:true});
                }
                if(record.profile==='fear'&&target.degree==='criticalFailure'&&!obligation.recovery){
                    const template=game.pf2e.ConditionManager.getCondition('fleeing');
                    if(actor.isImmuneTo(template)) noticeImmunity({ actor, blocked: 'Fleeing', why: 'immune to fleeing', source: record.name ?? 'Fear' });
                    if(!actor.isImmuneTo(template)){
                        const [effect]=await actor.createEmbeddedDocuments('Item',[{name:'Fear: Fleeing',type:'effect',img:template.img,system:{context:{origin:{actor:record.sourceActorUuid,item:record.sourceItemUuid},target:{actor:actor.uuid},roll:null},duration:{value:1,unit:'rounds',expiry:'turn-start'},start:{value:record.createdAt,initiative:record.casterInitiative??null},rules:[{key:'GrantItem',uuid:template._stats.compendiumSource,flag:'fleeing',allowDuplicate:true,onDeleteActions:{granter:'cascade',grantee:'cascade'}}]}}]);
                        if(!effect)throw Error('Fleeing application was not confirmed.');
                        record.entries.push({uuid:effect.uuid,actorUuid:actor.uuid,status:'active',permanent:false});
                    }
                }
                recipient.value=value;
                target.conditionResults=[{label:value?`${record.profile==='fear'?'Frightened':'Sickened'} ${value}${record.spellActive?' — recovery floor depends on caster sight':''}`:'No remaining condition from this cast',status:'applied',effectUuid:recipient.conditionUuid}];
            }
            obligation.status='completed';record.status='active';
            if(!record.recipients.some(r=>r.value>0)&&record.entries.every(e=>e.permanent||e.status==='ended')){record.spellActive=false;record.status='ended';record.endedAt=game.time.worldTime;}
            await this.ongoing.save(journal,record);
        } catch(error){await this.ongoing.review(journal,`Condition application interrupted: ${error.message}`);throw error;}
    }
    async finalizeIce(journal, card, saveState) {
        const record=clone(state(journal)), obligation=record.obligations.find(o=>o.cardId===card.id);
        const template=await fromUuid('Compendium.pf2e.spell-effects.Item.2sMXAGZfdqiy10kk');
        if(!template)throw Error('The native Clinging Ice effect is unavailable.');
        record.status='applying';obligation.status='applying';await this.ongoing.save(journal,record);
        try {
            for(const target of saveState.targets.filter(t=>!t.excluded&&t.eligible!==false)) {
                const penalty={failure:-5,criticalFailure:-10}[target.degree]??0;
                if(!penalty)continue;
                const recipient=record.recipients.find(r=>r.actorUuid===target.actorUuid), actor=await fromUuid(target.actorUuid);
                if(!recipient||!actor)throw Error('Clinging Ice recipient is unavailable.');
                const source=template.toObject();delete source._id;
                const choice=source.system.rules.find(r=>r.key==='ChoiceSet'&&r.flag==='clingingIce');
                if(!choice?.choices.some(c=>c.value===penalty))throw Error('The native speed penalty choices changed.');
                choice.selection=penalty;
                source.flags??={};source.flags.system??={};source.flags.system.rulesSelections={clingingIce:penalty};
                source.system.context={origin:{actor:record.sourceActorUuid,item:record.sourceItemUuid},target:{actor:actor.uuid},roll:null};
                source.system.level.value=record.rank;
                const [effect]=await actor.createEmbeddedDocuments('Item',[source]);
                if(!effect)throw Error('The native speed penalty was not confirmed.');
                recipient.conditionUuid=effect.uuid;recipient.value=1;
                record.entries.push({uuid:effect.uuid,actorUuid:actor.uuid,status:'active',permanent:false});
                target.conditionResults=[{label:`${penalty}-foot circumstance penalty to Speeds while sustained`,status:'applied',effectUuid:effect.uuid}];
            }
            obligation.status='completed';record.status=record.recipients.some(r=>r.value>0)?'active':'ended';
            if(record.status==='ended'){record.spellActive=false;record.endedAt=game.time.worldTime;}
            await this.ongoing.save(journal,record);
        }catch(error){await this.ongoing.review(journal,`Clinging Ice application interrupted: ${error.message}`);throw error;}
    }
    async end(journal, reason) {
        const record=clone(state(journal));
        if(record.profile!=='evil-eye'){
            record.status='ending';await this.ongoing.save(journal,record);
            try{for(const entry of record.entries.filter(e=>!e.detached)){
                const item=await fromUuid(entry.uuid);if(item)await item.delete();entry.status='ended';
            }record.status='ended';record.spellActive=false;record.endReason=reason;record.endedAt=game.time.worldTime;await this.ongoing.save(journal,record);return{status:'ended'};
            }catch(error){await this.ongoing.review(journal,`Ending ${record.name} interrupted: ${error.message}`);throw error;}
        }
        record.spellActive=false;record.endReason=reason;record.spellEndedAt=game.time.worldTime;
        record.sustainDueAt=null;
        for(const obligation of record.obligations.filter(o=>o.kind==='sustain'))obligation.status='completed';
        // Sickened is independently recoverable; ending the spell releases its
        // floor rather than curing it or deleting unrelated contributions.
        if(!record.recipients.some(r=>r.conditionUuid&&fromUuidSync(r.conditionUuid))){record.status='ended';record.endedAt=game.time.worldTime;}
        await this.ongoing.save(journal,record);
        return{status:record.status,spellActive:false};
    }
    async reconcile(journal, record, {recover=false,clockEvent=false}={}) {
        if(record.profile==='paralyze')return reconcileParalysis(this,journal,record,{recover,clockEvent});
        const clock=this.ongoing.clock();
        for(const recipient of record.recipients){if(record.entries.some(e=>e.uuid===recipient.conditionUuid&&e.detached)){recipient.value=0;continue;}const condition=recipient.conditionUuid&&await fromUuid(recipient.conditionUuid);if(recipient.conditionUuid)recipient.value=record.profile==='clinging-ice'?(condition?1:0):(condition?._source.system.value.value??0);}
        if(record.obligations.every(o=>o.status==='completed')&&!record.recipients.some(r=>r.value>0)&&record.entries.every(e=>e.permanent||e.status==='ended')){record.status='ended';record.spellActive=false;await this.ongoing.save(journal,record);return;}
        if(record.profile==='fear')return this.reconcileFear(journal,record,clock,{recover,clockEvent});
        if(!record.spellActive){await this.ongoing.save(journal,record);return;}
        const caster=await fromUuid(record.sourceActorUuid);
        if(!caster)return this.ongoing.review(journal,'Caster unavailable. Review Sustain and visibility; Sickened is retained.');
        if(caster.hasCondition('unconscious')||caster.statuses.has('dead'))return this.end(journal,'caster-cannot-sustain');
        if(clock.worldTime>=record.maximumAt)return this.end(journal,'maximum-duration');
        const advance=turnAdvance(record.clock,clock);
        if((recover||clockEvent)&&(clock.started||record.clock?.started)&&!['same','next'].includes(advance))return this.ongoing.review(journal,'Turn order changed. Review missed Sustain and visibility before resuming.',{resumable:true});
        if(advance==='next'&&clock.actorUuid===record.sourceActorUuid&&clock.round>record.castRound)addObligation(record,{key:boundaryKey(clock,record.sourceActorUuid,'sustain'),kind:'sustain',label:'Sustain before this turn ends'});
        if(advance==='next'&&record.clock.actorUuid===record.sourceActorUuid&&record.clock.round>record.castRound&&record.sustainedRound!==record.clock.round)return this.end(journal,'missed-sustain');
        if(!clock.started&&clock.worldTime>record.sustainDueAt)return this.ongoing.review(journal,'World time crossed a Sustain deadline. Confirm whether the spell was sustained; Sickened is retained.',{resumable:true});
        record.clock=clock;record.lastWorldTime=clock.worldTime;await this.ongoing.save(journal,record);
    }
    async reconcileFear(journal, record, clock, {recover,clockEvent}) {
        const advance=turnAdvance(record.clock,clock);
        if((clockEvent||recover)&&record.clock?.started&&!['same','next'].includes(advance))return this.ongoing.review(journal,'Turn order changed. Review missed Frightened reductions; none were replayed.',{resumable:true});
        if(advance==='next')for(const recipient of record.recipients.filter(r=>r.actorUuid===record.clock.actorUuid&&r.value>0&&!record.entries.some(e=>e.uuid===r.conditionUuid&&e.detached))){
            const condition=await fromUuid(recipient.conditionUuid);
            if(!condition)continue;
            const key=boundaryKey(record.clock,recipient.actorUuid,'frightened-decay');
            if(record.obligations.some(o=>o.key===key))continue;
            addObligation(record,{key,kind:'decay',status:'applying'});record.status='applying';await this.ongoing.save(journal,record);
            try{
                const value=condition._source.system.value.value-1;
                if(value)await condition.update({'system.value.value':value});else await condition.delete();
                recipient.value=value;record.obligations.find(o=>o.key===key).status='completed';record.status='active';
                if(!value){const entry=record.entries.find(e=>e.uuid===recipient.conditionUuid);if(entry)entry.status='ended';}
            }catch(error){await this.ongoing.review(journal,`Frightened reduction interrupted: ${error.message}`);throw error;}
        }
        record.clock=clock;record.lastWorldTime=clock.worldTime;
        if(record.obligations.every(o=>o.status==='completed')&&!record.recipients.some(r=>r.value>0)&&record.entries.every(e=>e.permanent||e.status==='ended'))record.status='ended';
        await this.ongoing.save(journal,record);
    }
    async action(journal, action, data, user) {
        const record=clone(state(journal));
        if(record.status!=='active')throw Error('Review this cast before continuing.');
        if(action==='sustain'){
            if(!record.spellActive)throw Error('This spell has ended; remaining Sickened must be recovered normally.');
            const clock=this.ongoing.clock();
            record.sustainedRound=clock.round;record.sustainDueAt=clock.worldTime+6;
            for(const o of record.obligations.filter(o=>o.kind==='sustain'&&o.status==='pending'))o.status='completed';
            await this.ongoing.save(journal,record);return{status:'sustained'};
        }
        if(action==='condition-visibility'){
            if(typeof data.visible!=='boolean')throw Error('Confirm whether the caster can see the target.');
            const recipient=record.recipients.find(r=>r.actorUuid===data.actorUuid);if(!recipient)throw Error('Unknown recipient.');
            recipient.visible=data.visible;recipient.visibilityFingerprint=this.visibilityFingerprint(record,recipient);recipient.visibilityReviewedBy=user.id;recipient.visibilityReviewedAt=game.time.worldTime;
            await this.ongoing.save(journal,record);return{status:'reviewed'};
        }
        if(action==='roll'&&record.profile==='paralyze'){
            const recipient=record.recipients.find(r=>r.actorUuid===data.actorUuid),actor=recipient&&await fromUuid(recipient.actorUuid);
            if(!actor||(!user.isGM&&!actor.testUserPermission(user,'OWNER')))throw Error('Only the recipient owner or GM can roll recovery.');
            const pending=record.obligations.find(o=>o.key===data.obligationKey&&o.actorUuid===actor.uuid&&o.recovery&&o.status==='pending');
            if(!pending||!record.entries.some(e=>e.uuid===recipient.conditionUuid&&!e.detached&&e.status==='active'))throw Error('No active Paralyze recovery is due.');
            const token=await fromUuid(recipient.tokenUuid);if(!token)throw Error('Recovery token unavailable.');
            return this.prepare(journal,[token],true,pending.key);
        }
        if(action==='roll'){
            if(record.profile!=='evil-eye')throw Error('This spell does not grant a Retch recovery.');
            const recipient=record.recipients.find(r=>r.actorUuid===data.actorUuid),actor=recipient&&await fromUuid(recipient.actorUuid);
            if(!actor||(!user.isGM&&!actor.testUserPermission(user,'OWNER')))throw Error('Only the recipient owner or GM can Retch.');
            if(record.entries.some(e=>e.uuid===recipient.conditionUuid&&e.detached))throw Error('This condition is managed separately after detachment.');
            if(record.spellActive&&this.currentVisibility(record,recipient)==null)throw Error('The caster or GM must review visibility before recovery.');
            const token=await fromUuid(recipient.tokenUuid);if(!token)throw Error('Recovery token unavailable.');
            return this.prepare(journal,[token],true);
        }
        throw Error('Unknown condition spell action.');
    }
    async controls(journal, record) {
        if(record.status!=='active')return[];
        if(record.profile==='paralyze')return paralysisControls(this,journal,record);
        const result=[],caster=await fromUuid(record.sourceActorUuid),owner=game.user.isGM||caster?.isOwner;
        if(record.spellActive&&owner)result.push({action:`sustain-${journal.id}`,label:`Sustain ${record.name} — 1 action`,callback:()=>this.ongoing.request('sustain',{castId:record.castId,revision:record.revision})});
        for(const recipient of record.recipients){
            const actor=await fromUuid(recipient.actorUuid);if(!actor)continue;
            if(owner&&record.spellActive&&record.profile==='evil-eye')result.push({action:`sight-${journal.id}-${actor.id}`,label:`${actor.name}: review caster sight (${this.currentVisibility(record,recipient)==null?'unreviewed':recipient.visible?'visible':'not visible'})`,callback:async()=>{
                const visible=await foundry.applications.api.DialogV2.wait({window:{title:'Evil Eye — current visibility'},content:`<p>Can the caster currently see ${esc(actor.name)}? Review blindness, concealment and obstructions. Movement, walls, darkness and condition changes invalidate the previous ruling. Update this ruling when other visibility factors change; the Sickened floor applies only while the caster can see this target.</p>`,buttons:[{action:'yes',label:'Caster can see target',callback:()=>true},{action:'no',label:'Caster cannot see target',callback:()=>false}],close:()=>null,rejectClose:false});
                if(visible!=null)return this.ongoing.request('condition-visibility',{castId:record.castId,revision:record.revision,actorUuid:actor.uuid,visible});
            }});
            if(record.profile==='evil-eye'&&(game.user.isGM||actor.isOwner)&&recipient.value>0&&!record.entries.some(e=>e.uuid===recipient.conditionUuid&&e.detached))result.push({action:`retch-${journal.id}-${actor.id}`,label:`${actor.name}: Retch — 1 action`,callback:async()=>{
                const pending=record.obligations.find(o=>o.status==='collecting'&&o.actorUuid===actor.uuid);
                const {cardId}=pending??await this.ongoing.request('roll',{castId:record.castId,revision:record.revision,actorUuid:actor.uuid});
                const card=game.messages.get(cardId);if(!card)throw Error('The recovery card is unavailable.');
                for(const t of card.getFlag(MODULE_ID,'basicSaveState').targets)if(!t.degree)await this.saves.rollSave(card,t.id);
            }});
        }
        return result;
    }
    protectCondition(item, change, options, deleting=false) {
        const castId=item.getFlag(MODULE_ID,'conditionCastId');if(!castId||options?.[MODULE_ID]?.conditionRecovery)return;
        const journal=this.ongoing.find(castId),record=journal&&state(journal);
        if(record?.profile!=='evil-eye'||!record.spellActive||record.status==='ended')return;
        const recipient=record.recipients.find(r=>r.conditionUuid===item.uuid);
        if(!recipient||record.entries?.some(e=>e.uuid===item.uuid&&e.detached))return;
        const value=deleting?0:(change?.['system.value.value']??change?.system?.value?.value);
        if(value!=null&&value<1&&this.currentVisibility(record,recipient)!==false){ui.notifications.warn('Evil Eye protects Sickened 1 while the caster can see this target. Review visibility and use Retch in Ongoing spells.');return false;}
    }
}
