import { assertSpellNotLost, dropMissedTargets } from './casting-rules-runtime.js';
import { MODULE_ID } from './effect-runtime.js';
import { clone, randomID, escapeHTML as esc, activeUsers, actorOf } from './runtime-utils.js';
import { applyDamageWithReceipt, confirmedDamageSummary } from './native-damage-receipt.js';
import { isDying, recoverFromDying, revivedNote } from './dying-recovery.js';
import { coordinatorId } from './ongoing-core.js';
import { IMMEDIATE_FLAG, PROFILES, DEGREES, degree, effectiveCheck, saveDegree, needsSave, readiness, recordCheck, correctTarget, validateChoices, checkAudience } from './immediate-core.js';
import { castSpellFromUuid } from './cast-spell.js';
import { expectedSpellSystem } from './item-spell-changes.js';
import { shapeDisintegrated } from './spellshape-runtime.js';
const stateOf = card => clone(card.getFlag(MODULE_ID, IMMEDIATE_FLAG));
const tokenOf = target => target.documentName === 'Token' ? target : target.document?.documentName === 'Token' ? target.document : null;
const owns = (user,actor) => user.isGM || actor?.testUserPermission(user,'OWNER');
const gmId = () => coordinatorId(activeUsers());

/** Immediate workflows own sequencing and receipts; PF2e owns checks and application. */
export class ImmediateRuntime {
    #queue = Promise.resolve();
    #pending = new Map();
    supports(item) { return Object.hasOwn(PROFILES, item?.slug ?? item?.system?.slug); }
    async verify(item) {
        const base = item.original ?? item, kind = base.slug ?? base.system.slug;
        const official = await fromUuid(`Compendium.pf2e.spells-srd.Item.${PROFILES[kind]}`);
        const normalized = text => String(text).replace(/<hr\s*\/?\s*>/gi,'<hr>').replace(/\s+/g,' ').trim();
        // (An item's copy of the spell, changed by it through castFromItem — Fan of Soothing Winds' Heal in a cone, with air —: compared with PF2e's
        // own under the same changes, 2026-10-29.)
        const expected = official ? expectedSpellSystem(official, base) : null;
        if (!official || normalized(base.system.description.value) !== normalized(expected.description.value)) throw Error('This spell differs from the verified immediate profile. GM review is required.');
        for (const key of ['damage','defense','heightening','traits','range','target','time','area','overlays']) if (JSON.stringify(base.system[key]) !== JSON.stringify(expected[key])) throw Error(`This spell’s ${key} differs from the verified profile.`);
        return kind;
    }
    enqueue(work) { const p=this.#queue.catch(()=>{}).then(work); this.#queue=p; return p; }
    async request(action,data={}) {
        const coordinator=gmId();
        if (coordinator && coordinator!==game.user.id) {
            const requestId=randomID();
            return new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>{this.#pending.delete(requestId);reject(Error('The GM did not confirm completion. Inspect the cast before retrying.'));},15000);
                this.#pending.set(requestId,{resolve,reject,timer});
                game.socket.emit(`module.${MODULE_ID}`,{type:'immediate-request',action,data,userId:game.user.id,coordinator,requestId});
            });
        }
        return this.enqueue(()=>this.dispatch(action,data,game.user));
    }
    async socket(payload) {
        if (payload?.type==='immediate-response' && payload.userId===game.user.id) {
            const p=this.#pending.get(payload.requestId);if(!p)return;clearTimeout(p.timer);this.#pending.delete(payload.requestId);
            payload.error?p.reject(Error(payload.error)):p.resolve(payload.result);return;
        }
        if(payload?.type!=='immediate-request'||payload.coordinator!==game.user.id||gmId()!==game.user.id)return;
        const user=game.users.get(payload.userId);if(!user?.active)return;
        try { const result=await this.enqueue(()=>this.dispatch(payload.action,payload.data,user));game.socket.emit(`module.${MODULE_ID}`,{type:'immediate-response',userId:user.id,requestId:payload.requestId,result}); }
        catch(error){game.socket.emit(`module.${MODULE_ID}`,{type:'immediate-response',userId:user.id,requestId:payload.requestId,error:error.message});}
    }
    async update(card,state) {
        state.revision=(state.revision??0)+1;
        await card.update({[`flags.${MODULE_ID}.${IMMEDIATE_FLAG}`]:state,whisper:state.audience??[],blind:state.blind??false,content:this.render(state,card.id)});
    }
    render(s,id) {
        const button=(action,label,target='')=>`<button type="button" class="pf2e-immediate-control" data-card="${id}" data-action="${action}" data-target="${target}">${esc(label)}</button>`;
        const summary=confirmedDamageSummary(s);
        return `<section><h3>${esc(s.name)} — ${s.status==='completed'?'Results':'Immediate resolution'}</h3><p>Rank ${s.rank}${s.actions?`, ${s.actions} action(s)`:''} · ${esc(s.status)}</p><p>${esc(s.reviewReason??'Native casting resources remain spent. Resolve reactions before finalizing.')}</p><ul>${s.targets.map(t=>`<li><strong>${esc(t.name)}</strong>${t.shards?` — ${t.shards} shard(s)`:''}${t.mode==='healing'?' — healing':''}${t.excluded?(t.mode==='unaffected'?' — Unaffected: not a valid Heal recipient':' — Excluded'):''}${t.eligibilityOverride?' — GM eligibility override':''}${['attack','save'].map(stage=>t[stage]?`<p>${stage}: ${esc(t[stage].total)} (${esc(t[stage].degree)}) — d20 ${esc(t[stage].natural??'?')}, modifier ${esc(t[stage].modifier??'?')}${t[`${stage}Override`]?` → GM: ${esc(t[`${stage}Override`].degree)}`:''}</p>`:'').join('')}${s.kind==='disintegrate'&&t.save?`<p>Effective Fortitude result: ${saveDegree(s,t)}</p>`:''}${t.disintegrated?'<p>Disintegrated into fine powder; gear remains.</p>':''}${t.objectDestroyed?'<p>Selected object destroyed.</p>':''}${t.formula?`<p>Native roll: ${esc(t.formula)} = ${t.roll.total}${t.multiplier>0?` × ${t.multiplier}`:''}.</p>`:''}${t.receipt?`<p>Applied: ${t.receipt.damage} damage, ${t.receipt.healing} healing.</p>`:''}${t.revived?`<p>${esc(revivedNote(t.revived))}</p>`:''}${s.status==='collecting'?`${s.kind==='disintegrate'&&!t.excluded?button('attack',t.attack?'Reroll attack':'Roll attack',t.id):''}${needsSave(s,t)?button('save',t.save?'Reroll Fortitude':'Roll Fortitude',t.id):''}${button('correct','GM corrections',t.id)}`:''}</li>`).join('')}</ul>${s.status==='collecting'?button('targets',s.kind==='disintegrate'?'Replace with current target':'Add current targets')+button('rank','Correct cast rank')+button('finalize',s.kind==='disintegrate'?'Finalize attack and resolve':'Finalize saves and resolve'):''}${s.status==='completed'||s.status==='review'?`<p>Confirmed totals: ${summary.damage} damage; ${summary.healing} healing${summary.incomplete?' (incomplete)':''}.</p>`:''}</section>`;
    }
    async start(item,options={}) {
        // (A spell lost to a disruption or a counterspell has no effect: casting-rules-runtime.js.)
        assertSpellNotLost(options?.sourceMessageId ?? null);
        // (A concealed or hidden target the spell's flat check missed is left out.)
        if (options?.sourceMessageId) {
            const kept = dropMissedTargets(options.sourceMessageId, options.targets ?? null);
            if (Array.isArray(kept) && !kept.length && (options.targets ?? [...(game.user?.targets ?? [])]).length) throw new Error("The spell's concealed or hidden flat check missed every target; it has no effect on them.");
            options = { ...options, targets: kept ?? options.targets };
        }
        const kind=await this.verify(item), rank=Number(options.castRank??item.rank);
        const source=item.original??item;
        // (Or the actions an item's cast says, Fan of Soothing Winds' 3-action Heal: castFromItem's actions, on its cast's message.)
        const itemActions=options.sourceMessageId?Number(game.messages.get(options.sourceMessageId)?.getFlag(MODULE_ID,'castFromItem')?.actions)||null:null;
        let actions=kind==='disintegrate'?2:Number(options.actions??itemActions??item.system.time.value);
        if(kind!=='disintegrate'&&![1,2,3].includes(actions)) {
            actions=await foundry.applications.api.DialogV2.prompt({window:{title:`${item.name} — casting actions`},content:'<p>How many actions did you spend on the native cast? Canceling does not refund resources.</p><select name="actions"><option value="1">1 action</option><option value="2">2 actions</option><option value="3">3 actions</option></select>',ok:{label:'Continue',callback:(_e,b)=>Number(b.form.elements.actions.value)},rejectClose:false});
            if(actions==null)return{status:'cancelled'};
        }
        let reviewed=false;
        let targets=[...(options.targets??game.user.targets)].map(t=>t.document??t);
        if(kind==='heal'&&actions===3&&!options.confirmed){
            const sourceCard=game.messages.get(options.sourceMessageId);
            const existing=options.sourceMessageId&&canvas.scene?.regions.find(r=>r.flags.pf2e?.messageId===options.sourceMessageId);
            const areaSpell=await this.variant({sourceItemUuid:source.uuid,kind,rank,actions},'healing');
            const region=existing||await areaSpell.placeTemplate(sourceCard);
            if(!region)return{status:'cancelled'};
            try{
                await Promise.all(canvas.tokens.placeables.map(t=>t.animation));
                const suggested=canvas.tokens.placeables.filter(t=>(game.user.isGM||t.isVisible)&&t.actor?.isOfType('creature')&&t.document.testInsideRegion(region)).map(t=>t.document);
                const candidates=[...new Map([...targets,...suggested].map(t=>[t.uuid,t])).values()];
                const selected=await foundry.applications.api.DialogV2.prompt({window:{title:'Heal — review emanation targets'},content:`<p>These are suggestions from the native area and your selected targets. Confirm the 30-foot emanation is centered on the caster; review boundaries, walls, living recipients’ willingness, and exemptions. Uncheck unaffected creatures.</p>${candidates.map((t,i)=>`<label><input type="checkbox" name="target${i}" checked>${esc(t.name)}</label>`).join('<br>')}`,ok:{label:'Use reviewed targets',callback:(_e,b)=>candidates.filter((_,i)=>b.form.elements[`target${i}`].checked)},rejectClose:false});
                if(!selected)return{status:'cancelled'};targets=selected;reviewed=true;
            }finally{if(!existing)await region.delete();}
        }
        let object=options.object??null;
        if(kind==='disintegrate'&&!targets.length&&!object){
            object=await foundry.applications.api.DialogV2.prompt({window:{title:'Disintegrate — explicit object target'},content:'<p>Target a creature first, or enter the exact UUID of an unattended scene Tile or Drawing representing the object. Confirm it is not an artifact or similarly powerful and the destroyed matter fits inside a 10-foot cube. Other geometry requires GM adjudication.</p><label>Object UUID <input name="uuid" required></label><label>GM-confirmed AC <input name="ac" type="number" required></label><label><input name="confirmed" type="checkbox" required>Eligible object and volume confirmed</label>',ok:{label:'Use this object',callback:(_e,b)=>({uuid:b.form.elements.uuid.value,ac:Number(b.form.elements.ac.value),confirmed:b.form.elements.confirmed.checked})},rejectClose:false});
            if(!object)return{status:'cancelled'};
        }
        const snapshots=targets.map(t=>{const actor=actorOf(t);if(!actor?.uuid)throw Error('Select actor-backed targets.');return{actorUuid:actor.uuid,tokenUuid:tokenOf(t)?.uuid??null,name:actor.name,shards:options.allocations?.[actor.uuid]??null};});
        if(new Set(snapshots.map(t=>t.actorUuid)).size!==snapshots.length)throw Error('Select each actor once; allocate multiple shards to that target.');
        if(kind==='force-barrage'&&!options.allocations){
            const total=actions*(1+Math.floor((rank-1)/2));
            const allocations=await foundry.applications.api.DialogV2.prompt({window:{title:'Force Barrage — allocate shards'},content:`<p>Allocate exactly ${total} shards. Confirm each selected creature is visible, within 120 feet, and has line of effect. Damage is combined per target before native adjustments. Native casting resources remain spent.</p>${snapshots.map((t,i)=>`<label>${esc(t.name)} <input name="target${i}" type="number" min="1" step="1" value="${snapshots.length===1?total:1}"></label>`).join('')}`,ok:{label:'Resolve barrage',callback:(_e,b)=>snapshots.map((_,i)=>Number(b.form.elements[`target${i}`].value))},rejectClose:false});
            if(!allocations)return{status:'cancelled'};snapshots.forEach((t,i)=>t.shards=allocations[i]);reviewed=true;
        }
        if(!options.confirmed && !reviewed && !await foundry.applications.api.DialogV2.confirm({window:{title:`${item.name} — confirm targets`},content:`<p>Confirm range, line of effect and eligibility${kind==='heal'?', living recipients’ willingness, and all creatures in the 30-foot emanation for the three-action version':''}. ${object?'Only the explicitly selected object will be destroyed.':snapshots.map(t=>esc(t.name)).join(', ')}</p><p>Native casting resources are already spent; cancellation does not refund them.</p>`,rejectClose:false}))return{status:'cancelled'};
        return this.request('start',{itemUuid:source.uuid,rank,actions,targets:snapshots,object,sourceMessageId:options.sourceMessageId??null});
    }
    async documents(t) {
        const token=t.tokenUuid?await fromUuid(t.tokenUuid):null;
        const actor=token?.actor??await fromUuid(t.actorUuid);
        if(!actor||actor.uuid!==t.actorUuid||(t.tokenUuid&&!token))throw Error(`${t.name}: the snapshotted target is missing or changed.`);
        const active=actor.getActiveTokens?.(false,true)??[];
        const resolved=token??(active.length===1?active[0]:null);
        if(!resolved)throw Error(`${t.name}: a unique native token is required.`);
        return{actor,token:resolved};
    }
    async dispatch(action,data,user) {
        if(game.user.active===false || (gmId()&&gmId()!==game.user.id))throw Error('The coordinating GM changed. Refresh before continuing.');
        if(action==='start')return this.prepare(data,user);
        const card=game.messages.get(data.cardId);if(!card?.getFlag(MODULE_ID,IMMEDIATE_FLAG))throw Error('This cast is unavailable.');
        const s=stateOf(card),t=s.targets.find(t=>t.id===data.targetId);
        if(s.status!=='collecting')throw Error('Applied or uncertain work is locked.');
        if(action==='submit'){
            if(!gmId())throw Error('An active GM is required to record attack/save results.');
            const actor=await fromUuid(data.stage==='attack'?s.sourceActorUuid:t?.actorUuid);
            if(!owns(user,actor))throw Error('You do not own this check.');
            recordCheck(s,data.targetId,data.stage,data.roll,data.revision);s.audience=checkAudience(s.audience,data.roll.visibility,[...game.users].filter(u=>u.isGM).map(u=>u.id),user.id);s.blind ||= data.roll.visibility?.blind===true;await this.update(card,s);return{status:'recorded'};
        }
        if(!user.isGM||gmId()!==game.user.id)throw Error('Only the coordinating GM can finalize or correct this cast.');
        if(action==='rank'){
            if(data.revision!==s.revision)throw Error('This cast changed. Refresh before changing rank.');
            validateChoices(s.kind,data.rank,s.actions,s.targets);s.rank=data.rank;
            for(const target of s.targets){target.attack=null;target.save=null;target.attackOverride=null;target.saveOverride=null;target.revision++;}
            await this.update(card,s);return{status:'updated'};
        }
        if(action==='targets'){
            if(data.revision!==s.revision)throw Error('This cast changed. Refresh before changing targets.');
            const fresh=[];
            for(const uuid of data.targetUuids??[]){const token=await fromUuid(uuid),actor=token?.actor;if(!actor?.isOfType('creature'))throw Error('Select creature tokens.');
                if(fresh.some(t=>t.actorUuid===actor.uuid))continue;
                const mode=s.kind==='heal'?(actor.traits.has('undead')?'damage':actor.traits.has('construct')||actor.system.attributes.negativeHealing?'unaffected':'healing'):'damage';
                fresh.push({id:randomID(),revision:0,name:actor.name,actorUuid:actor.uuid,tokenUuid:token.uuid,mode,excluded:mode==='unaffected',attack:null,save:null,applicationStatus:'pending'});
            }
            if(s.kind==='disintegrate'){if(fresh.length!==1)throw Error('Select exactly one replacement creature.');s.targets=fresh;}
            else if(s.kind==='heal'&&s.actions===3){for(const target of fresh)if(!s.targets.some(t=>t.actorUuid===target.actorUuid))s.targets.push(target);}
            else throw Error('This spell does not permit adding targets.');
            await this.update(card,s);return{status:'updated'};
        }
        if(action==='correct'){correctTarget(s,data.targetId,data.correction,user.id);await this.update(card,s);return{status:'corrected'};}
        if(action==='finalize'){if(data.revision!==s.revision)throw Error('This cast changed. Review it before finalizing.');return this.apply(card,s);}
        throw Error('Unknown immediate control.');
    }
    async prepare(data,user) {
        // (A wand's spell has no item of its own: PF2e's copy of the spell the wand holds, cast-spell.js.)
        const item=await castSpellFromUuid({sourceItemUuid:data.itemUuid});if(!item?.actor||!owns(user,item.actor))throw Error('You do not own the caster.');
        const kind=await this.verify(item);
        const sourceCard=data.sourceMessageId?game.messages.get(data.sourceMessageId):null;
        if(data.sourceMessageId&&!sourceCard)throw Error('The native source card is missing.');
        if(sourceCard && (sourceCard.actor?.uuid!==item.actor.uuid || sourceCard.item?.uuid!==item.uuid))throw Error('The native card does not belong to this caster and spell.');
        if(sourceCard?.getFlag(MODULE_ID,IMMEDIATE_FLAG))throw Error('This native card already has an immediate resolution.');
        const targets=[];
        for(const snapshot of data.targets){
            const {actor,token}=await this.documents(snapshot);
            if(!actor.isOfType('creature'))throw Error('This creature branch needs a creature target; use explicit object selection for objects.');
            const undead=actor.traits.has('undead');
            const mode=kind==='heal'?(undead?'damage':actor.traits.has('construct')||actor.system.attributes.negativeHealing?'unaffected':'healing'):'damage';
            targets.push({...snapshot,tokenUuid:token.uuid,id:randomID(),revision:0,mode,excluded:mode==='unaffected',attack:null,save:null,applicationStatus:'pending'});
        }
        // (An item's hit standing in for the attack roll — Disintegration Bolt through castFromItem's attackDegree: the save is next.)
        const itemHit=sourceCard?.getFlag(MODULE_ID,'castFromItem');
        if(kind==='disintegrate'&&['success','criticalSuccess'].includes(itemHit?.attackDegree))for(const target of targets)target.attack={degree:itemHit.attackDegree,total:`${itemHit.itemName}'s hit`,natural:null,modifier:null,source:'item',userId:user.id};
        if(data.object){
            if(kind!=='disintegrate'||targets.length||!user.isGM||!data.object.confirmed||!Number.isFinite(data.object.ac))throw Error('The GM must explicitly confirm the object and its AC.');
            const object=await fromUuid(data.object.uuid);
            if(!object||!['Tile','Drawing'].includes(object.documentName))throw Error('Choose a scene Tile or Drawing representing the bounded object.');
            targets.push({id:randomID(),revision:0,name:object.name??object.documentName,mode:'object',objectUuid:object.uuid,ac:data.object.ac,attack:null,save:null,excluded:false,applicationStatus:'pending'});
        }
        if(kind==='heal'&&game.user.isGM)for(const target of targets.filter(t=>t.mode==='unaffected')){
            const mode=await foundry.applications.api.DialogV2.wait({window:{title:'Heal — GM eligibility review'},content:`<p>${esc(target.name)} is not an ordinary living or undead Heal recipient. Leave it Unaffected or explicitly override eligibility for this cast. Native casting resources remain spent.</p>`,buttons:[{action:'unaffected',label:'Leave Unaffected',callback:()=> 'unaffected'},{action:'healing',label:'Treat as eligible living recipient',callback:()=> 'healing'},{action:'damage',label:'Treat as eligible undead recipient',callback:()=> 'damage'}],rejectClose:false,close:()=>null});
            if(mode==null)return{status:'cancelled'};
            if(mode!=='unaffected'){target.mode=mode;target.excluded=false;target.eligibilityOverride={mode,userId:game.user.id};}
        }
        validateChoices(kind,data.rank,data.actions,targets);
        const needsGM=kind==='disintegrate'||targets.some(t=>t.mode==='damage'&&kind==='heal');
        if(needsGM&&!gmId())throw Error('An active GM is required for attack/save workflows. No work was applied.');
        if(!user.isGM)for(const t of targets)if(!owns(user,await fromUuid(t.actorUuid))&&!gmId())throw Error('A GM is required for recipients you do not own.');
        const state={schema:1,castId:randomID(),kind,name:item.name,rank:data.rank,actions:data.actions,sourceActorUuid:item.actor.uuid,sourceItemUuid:item.uuid,sourceMessageId:sourceCard?.id??null,revision:0,audience:sourceCard?.whisper?.length?[...sourceCard.whisper]:null,blind:sourceCard?.blind??false,status:needsGM?'collecting':'applying',dc:item.spellcasting?.statistic?.dc?.value,targets};
        if(needsGM&&!Number.isFinite(state.dc))throw Error('The native spellcasting DC is unavailable.');
        const card=await ChatMessage.create({speaker:ChatMessage.getSpeaker({actor:item.actor}),content:`<p>${esc(item.name)} — preparing resolution.</p>`,whisper:state.audience??[],blind:state.blind,flags:{[MODULE_ID]:{[IMMEDIATE_FLAG]:state}}});
        try {
            if(sourceCard)await sourceCard.setFlag(MODULE_ID,IMMEDIATE_FLAG,{cardId:card.id,castId:state.castId});
            await this.update(card,state);
            if(!needsGM){state.status='collecting';return await this.apply(card,state);}
            return{status:'prepared',cardId:card.id,castId:state.castId};
        }catch(error){state.status='review';state.reviewReason=error.message;await this.update(card,state);throw error;}
    }
    async variant(s,mode) {
        const original=await castSpellFromUuid(s);if(!original)throw Error('The original spell is missing.');await this.verify(original);
        let overlayIds=[];
        if(s.kind==='heal'){
            const id=Object.entries(original.system.overlays).find(([,o])=>Number(o.system.time?.value)===s.actions&&(s.actions!==2||(mode==='healing'?o.system.defense===null:o.system.defense!==null)))?.[0];
            if(!id)throw Error('The native Heal variant is unavailable.');overlayIds=[id];
        }
        return original.loadVariant({castRank:s.rank,overlayIds})??original;
    }
    async roll(card,targetId,stage,{skipDialog=false,attackNumber=null}={}) {
        const s=stateOf(card),t=s.targets.find(t=>t.id===targetId);
        if(!gmId())throw Error('An active GM is required.');
        if(s.status!=='collecting'||!t||t.excluded)throw Error('This target is locked or excluded.');
        const caster=await fromUuid(s.sourceActorUuid),spell=await this.variant(s,t.mode);
        const actor=t.mode==='object'?null:(await this.documents(t)).actor;
        if(!owns(game.user,stage==='attack'?caster:actor))throw Error('You do not own this check.');
        let roll,visibility=null;
        const callback=(_roll,_outcome,message)=>{visibility={whisper:[...(message.whisper??[])],blind:message.blind===true};};
        if(stage==='attack'){
            if(s.kind!=='disintegrate')throw Error('This spell does not require an attack.');
            if(attackNumber==null&&!skipDialog){
                attackNumber=await foundry.applications.api.DialogV2.prompt({window:{title:'Spell attack — multiple attack penalty'},content:'<p>Which attack is this on the caster’s turn? PF2e calculates the applicable penalty.</p><select name="number"><option value="1">First attack</option><option value="2">Second attack</option><option value="3">Third or later attack</option></select>',ok:{label:'Open native attack dialog',callback:(_e,b)=>Number(b.form.elements.number.value)},rejectClose:false});
                if(attackNumber==null)return{status:'cancelled'};
            }
            attackNumber??=1;if(![1,2,3].includes(attackNumber))throw Error('Choose a valid attack number.');
            if(t.mode==='object'){
                if(!game.user.isGM)throw Error('The GM rolls attacks against declared objects.');
                const saved=[...game.user.targets];for(const token of saved)token.setTarget(false,{releaseOthers:false});
                try{roll=await spell.spellcasting.statistic.check.roll({item:spell,dc:{value:t.ac},attackNumber,traits:[...spell.traits],skipDialog,createMessage:false,callback});}finally{for(const token of saved)if(canvas.tokens.get(token.id))token.setTarget(true,{releaseOthers:false});}
            }else{
                const tokens=actor.getActiveTokens(false,true);if(tokens.length!==1||tokens[0].uuid!==t.tokenUuid)throw Error('The native attack target is ambiguous or off-scene. Resolve placement first.');
                roll=await spell.rollAttack(null,attackNumber,{target:actor,skipDialog,createMessage:false,callback});
            }
        }else{
            if(!needsSave(s,t))throw Error('The preceding attack must hit before the save.');
            const {token}=await this.documents(t);
            roll=await actor.saves.fortitude.roll({dc:s.dc,token,item:spell,origin:caster,traits:[...spell.traits],skipDialog,createMessage:false,callback});
        }
        if(!roll)return{status:'cancelled'};
        const natural=roll.dice?.flatMap(die=>die.results??[]).find(r=>r.active!==false&&r.discarded!==true)?.result??null;
        const result={visibility,attackNumber:stage==='attack'?attackNumber:null,degree:degree(roll.options?.degreeOfSuccess??roll.degreeOfSuccess),total:roll.total,natural,modifier:roll.options?.totalModifier,roll:clone(roll.toJSON()),userId:game.user.id};
        return this.request('submit',{cardId:card.id,targetId,stage,revision:t.revision,roll:result});
    }
    async apply(card,s) {
        const blocked=readiness(s);if(blocked)throw Error(blocked);
        // Resolve every document before any irreversible application.
        const documents=new Map();for(const t of s.targets.filter(t=>!t.excluded))documents.set(t.id,t.mode==='object'?await fromUuid(t.objectUuid):await this.documents(t));
        for(const t of s.targets.filter(t=>!t.excluded))if(!documents.get(t.id))throw Error(`${t.name}: the object is missing.`);
        if(s.kind==='heal')for(const t of s.targets.filter(t=>!t.excluded)){
            const actor=documents.get(t.id).actor;
            const mode=actor.traits.has('undead')?'damage':actor.traits.has('construct')||actor.system.attributes.negativeHealing?'unaffected':'healing';
            if(mode!==t.mode&&!t.eligibilityOverride)throw Error(`${t.name}: healing eligibility changed. Review this target before applying.`);
        }
        const rolls=new Map();
        for(const t of s.targets.filter(t=>!t.excluded&&t.mode!=='object')){
            if(s.kind==='disintegrate'&&!['success','criticalSuccess'].includes(effectiveCheck(t,'attack')))continue;
            const key=s.kind==='force-barrage'?t.id:s.kind==='heal'&&s.actions!==2?'shared':t.mode;
            if(rolls.has(key))continue;
            let spell=await this.variant(s,t.mode);
            if(s.kind==='force-barrage')spell=spell.clone({'system.damage.0.formula':`${t.shards}d4+${t.shards}`},{keepId:true});
            const prepared=await spell.getDamage({skipDialog:true,target:documents.get(t.id).token});
            const roll=prepared?.template?.damage?.roll;if(!roll)throw Error('PF2e returned no native damage/healing roll.');await roll.evaluate();
            rolls.set(key,{roll,spell,options:[...(prepared.context.options??[])]});
        }
        s.status='applying';await this.update(card,s);
        try{
            for(const t of s.targets){
                if(t.excluded){t.applicationStatus='skipped';continue;}
                if(gmId()&&gmId()!==game.user.id)throw Error('The coordinating GM changed. Review before continuing.');
                t.applicationStatus='applying';await this.update(card,s);
                if(t.mode==='object'){
                    if(['success','criticalSuccess'].includes(effectiveCheck(t,'attack'))){await documents.get(t.id).delete();t.objectDestroyed=true;}
                }else{
                    let multiplier=t.mode==='healing'?-1:1;
                    if(needsSave(s,t))multiplier={criticalFailure:2,failure:1,success:.5,criticalSuccess:0}[saveDegree(s,t)];
                    if(s.kind==='disintegrate'&&!['success','criticalSuccess'].includes(effectiveCheck(t,'attack')))multiplier=0;
                    if(multiplier){
                        const {roll,spell,options}=rolls.get(s.kind==='force-barrage'?t.id:s.kind==='heal'&&s.actions!==2?'shared':t.mode),{actor,token}=documents.get(t.id);
                        t.roll=clone(roll.toJSON());t.formula=roll.formula;t.multiplier=multiplier;await this.update(card,s);
                        const damage=multiplier<0?-roll.total:multiplier===1?roll:roll.alter(multiplier,0);
                        t.hpBefore=actor.hitPoints.value;
                        const wasDying=multiplier<0&&isDying(actor);
                        t.receipt=await applyDamageWithReceipt(actor,{damage,token,item:spell,rollOptions:new Set(options),skipIWR:false},randomID());
                        // Healed back from Dying: Dying and Unconscious end, Wounded rises (dying-recovery.js).
                        if(wasDying)t.revived=await recoverFromDying(actor,true);
                        t.damageResults=[{receipt:t.receipt,formula:t.formula,multiplier}];await this.update(card,s);
                        if(s.kind==='disintegrate'&&t.hpBefore>0&&t.receipt.damage>0&&actor.hitPoints.value===0){await actor.toggleStatusEffect('dead',{active:true});t.disintegrated=true;
                            // A Wand of the Ash Puppet's cast: the powder rises as the caster's sulfur zombie (spellshape-runtime.js).
                            try{t.ashPuppet=await shapeDisintegrated(s,actor,token);}catch(error){t.ashPuppet={error:error.message};}}
                    }
                }
                t.applicationStatus='applied';await this.update(card,s);
            }
            s.status='completed';await this.update(card,s);return{status:'applied',cardId:card.id,castId:s.castId};
        }catch(error){s.status='review';s.reviewReason=`Application may have occurred: ${error.message} Applied steps are locked; reconcile manually.`;await this.update(card,s);throw error;}
    }
    async recover() {
        if(gmId()!==game.user.id)return;
        await this.enqueue(async()=>{for(const card of game.messages.contents){const s=card.getFlag(MODULE_ID,IMMEDIATE_FLAG);if(s?.targets&&s.status==='applying'){const state=clone(s);state.status='review';state.reviewReason='Application was interrupted. Reconcile confirmed receipts manually; no step was replayed.';await this.update(card,state);}}});
    }
    bind(root) {
        for(const b of root.querySelectorAll('.pf2e-immediate-control')){
            if(['correct','finalize','targets','rank'].includes(b.dataset.action))b.hidden=!game.user.isGM;
            if(b.dataset.bound)continue;b.dataset.bound='true';
            b.addEventListener('click',async()=>{b.disabled=true;try{
                const card=game.messages.get(b.dataset.card),s=stateOf(card),t=s.targets.find(t=>t.id===b.dataset.target),action=b.dataset.action;
                if(action==='attack'||action==='save')await this.roll(card,t.id,action);
                else if(action==='targets')await this.request('targets',{cardId:card.id,revision:s.revision,targetUuids:[...game.user.targets].map(t=>t.document.uuid)});
                else if(action==='rank'){
                    const rank=await foundry.applications.api.DialogV2.prompt({window:{title:'Correct cast rank'},content:`<p>Use the rank actually spent on the native cast. This clears dependent rolls and does not spend or refund resources.</p><input name="rank" type="number" min="${s.kind==='disintegrate'?6:1}" max="10" value="${s.rank}">`,ok:{label:'Correct rank',callback:(_e,b)=>Number(b.form.elements.rank.value)},rejectClose:false});
                    if(rank!=null)await this.request('rank',{cardId:card.id,rank,revision:s.revision});
                }
                else if(action==='finalize')await this.request(action,{cardId:card.id,revision:s.revision});
                else{
                    const correction=await foundry.applications.api.DialogV2.wait({window:{title:`${t.name} — GM corrections`},content:'<p>Original rolls remain visible. Attack changes invalidate the dependent save.</p>',buttons:[{action:'exclude',label:t.excluded?'Restore target':'Exclude target',callback:()=>({action:'exclude'})},...(s.kind==='heal'?[{action:'healing',label:'Treat as eligible living recipient',callback:()=>({action:'eligibility',mode:'healing'})},{action:'damage',label:'Treat as eligible undead recipient',callback:()=>({action:'eligibility',mode:'damage'})}]:[]),...['attack','save'].filter(stage=>t[stage]).flatMap(stage=>DEGREES.map(d=>({action:`${stage}-${d}`,label:`${stage}: ${d}`,callback:()=>({action:'degree',stage,degree:d})})))],rejectClose:false,close:()=>null});
                    if(correction)await this.request('correct',{cardId:card.id,targetId:t.id,correction:{...correction,revision:t.revision}});
                }
            }catch(error){ui.notifications.error(error.message);}finally{b.disabled=false;}});
        }
    }
}
