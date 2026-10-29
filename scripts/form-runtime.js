import { waitForNativeFormUpdate } from './form-native-guards.js';
import { MODULE_ID } from './effect-runtime.js';
import { clone, randomID, escapeHTML as esc, confirmAction, tempHPSourceId } from './runtime-utils.js';
import { formDigestVerified } from './form-baseline.js';
import { canonicalFormMechanics, FORM_PROFILES, validateFormRank, formSize, prepareFormSource, rechargeReady } from './form-core.js';
const state = journal => journal.getFlag(MODULE_ID, 'ongoingCast');
const formFlag = item => item?.getFlag(MODULE_ID, 'formCastId');
export class FormRuntime {
    constructor(ongoing, saves, families) { this.ongoing = ongoing; this.saves = saves; this.families = families; }
    supports(item) { return Object.hasOwn(FORM_PROFILES, item?.slug ?? item?.system?.slug); }
    async verify(item) {
        const kind = item.slug, profile = FORM_PROFILES[kind];
        const native = profile && await fromUuid(`Compendium.pf2e.spells-srd.Item.${profile.id}`);
        const plain = s => String(s).replace(/<hr\s*\/?\s*>/gi, '<hr>').replace(/@UUID\[[^\]]+\]/g, '@UUID').replace(/\s+/g, ' ').trim();
        if (!native || plain(native.system.description.value) !== plain(item.system.description.value)) throw Error('This spell differs from the verified form profile.');
        for (const key of ['traits','duration','target','range','heightening']) if (JSON.stringify(native.system[key]) !== JSON.stringify(item.system[key])) throw Error(`Changed form ${key} requires review.`);
        // (PF2e 8.5 and 8.6: verified live on 8.5.0 and 8.6.1, 2026-10-29 — the native spell's text and fields above and its Effect's digest
        // below still refuse anything changed from those.)
        if (!/^8\.[56]\./.test(String(game.system.version))) throw Error('Form integration requires verification for this PF2e version.');
        return kind;
    }
    async choices(kind) {
        if (kind === 'animal-form') {
            const pack = game.packs.get('pf2e.spell-effects'), index = await pack.getIndex();
            return index.filter(e => /^Spell Effect: Animal Form \(/.test(e.name)).map(e => ({value:e._id,label:e.name.replace('Spell Effect: Animal Form ', '')})).sort((a,b)=>a.label.localeCompare(b.label));
        }
        if (kind === 'pest-form') return [{value:'ground',label:'Ground animal — Tiny; Speed 20; no Strikes'}, {value:'flying',label:'Flying animal — rank 4+; fly 20; no Strikes'}];
        const effect = await fromUuid(`Compendium.pf2e.spell-effects.Item.${FORM_PROFILES[kind].effectId}`);
        return effect.system.rules.find(r => r.key === 'ChoiceSet').choices.filter(c => c.value.dragonType !== 'sovereign').map(c => ({ value:c.value.dragonType, label:`${game.i18n.localize(c.label)} — ${c.value.tradition}; ${c.value.breathShape}; ${c.value.damageType}; ${c.value.dragonType==='despair'?'will':c.value.saveType}` }));
    }
    summary(template,kind,rank,choice,actor){
        const source=prepareFormSource(template.toObject(),{kind,rank,choice,flying:choice==='flying'});
        const rule=source.system.rules.find(r=>r.key==='BattleForm');
        const stats=foundry.utils.mergeObject(clone(rule.overrides),rule.brackets?.findLast(b=>b.start<=rank)?.value??{}, {inplace:false});
        const ac=String(stats.armorClass.modifier).replace('@actor.level',String(actor.level));
        const speed=Object.entries(stats.speeds).map(([type,value])=>`${type} ${Number(value)+(type==='fly'&&kind==='dragon-form'&&rank>=8?20:0)} feet`).join(', ');
        const attacks=Object.entries(stats.strikes??{}).map(([name,s])=>`${name}: +${s.modifier}; ${s.damage.dice}${s.damage.die}${s.damage.modifier?` + ${s.damage.modifier}`:''} ${s.damage.damageType}; ${(s.traits??[]).join(', ')}`);
        return `<p><strong>AC ${esc(ac)}; ${stats.tempHP??0} temporary HP.</strong> ${esc(speed)}.</p><p>${attacks.length?attacks.map(esc).join('<br>'):'No Strikes.'} Higher eligible own attack/skill modifiers remain available.</p>`;
    }
    async start(item, options = {}) {
        const kind = await this.verify(item), rank = Number(options.castRank ?? item.rank);
        validateFormRank(kind, rank);
        if (!item.actor?.isOfType('character')) throw Error('Native battle forms require a character actor. NPC transformation support remains unverified.');
        if (!game.user.isGM && !item.actor.isOwner) throw Error('You do not own this caster.');
        const choices = (await this.choices(kind)).filter(c => kind !== 'pest-form' || rank >= 4 || c.value !== 'flying');
        const choice = options.choice ?? await foundry.applications.api.DialogV2.prompt({window:{title:`${item.name} — choose form`},content:`<p>Rank ${rank}; ${formSize(kind,rank)}. Native casting resources remain spent if canceled. ${kind==='dragon-form'?'Confirm this dragon is common or the GM has granted access. Sovereign is unavailable pending a conflicting-save source review.':''}</p><select name="choice">${choices.map(c=>`<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('')}</select>`,ok:{label:'Review form',callback:(_e,b)=>b.form.elements.choice.value},rejectClose:false});
        if (choice == null) return {status:'cancelled'};
        if (!choices.some(c => c.value === choice)) throw Error('That form is not legal for this rank.');
        const template = await fromUuid(`Compendium.pf2e.spell-effects.Item.${kind==='animal-form'?choice:FORM_PROFILES[kind].effectId}`);
        if (!options.confirmed && !await confirmAction({title:`${item.name} — review space and restrictions`,content:`<p>${esc(choices.find(c=>c.value===choice).label)}; resulting size ${formSize(kind,rank)}.</p><p>Confirm enough space to expand, including walls and occupied squares, and any required access. No change is applied if canceled. Casting resources remain spent.</p><p>While transformed: no spellcasting, speech or item activation; ${kind==='dragon-form'?'hands permit manipulate actions':'hand-dependent actions require GM adjudication'}. Gear remains absorbed. Use only granted Strikes${kind==='pest-form'?' (this form has none)':''}.</p>${this.summary(template,kind,rank,choice,item.actor)}<details><summary>Full native form rules</summary>${await game.pf2e.TextEditor.enrichHTML(template.system.description.value,{rollData:item.getRollData()})}</details>`,label:'Confirm form and space'})) return {status:'cancelled'};
        return this.ongoing.request('start-form',{itemUuid:item.uuid,rank,choice,sourceMessageId:options.sourceMessageId,confirmed:true});
    }
    async apply(data, user) {
        this.ongoing.assertCoordinator();
        const item = await fromUuid(data.itemUuid), actor = item?.actor;
        if (!actor?.isOfType('character') || (!user.isGM && !actor.testUserPermission(user,'OWNER'))) throw Error('You do not own this character.');
        const kind = await this.verify(item); validateFormRank(kind,data.rank);
        const choices = await this.choices(kind);
        if (!data.confirmed || !choices.some(c=>c.value===data.choice) || (kind==='pest-form'&&data.choice==='flying'&&data.rank<4)) throw Error('Confirm a legal form and space first.');
        const message = data.sourceMessageId && game.messages.get(data.sourceMessageId);
        if (data.sourceMessageId && (!message || message.actor?.uuid!==actor.uuid || message.item?.uuid!==item.uuid)) throw Error('The native source card does not match this caster and spell.');
        if (message?.getFlag(MODULE_ID,'ongoingCastId')) throw Error('This cast has already been resolved.');
        const tokens=actor.getActiveTokens(true,true);
        if(tokens.length!==1)throw Error('A form needs one unambiguous active caster token for space review.');
        const token=tokens[0];
        if(!token.linkToActorSize)throw Error('Enable native Link to Actor Size on the caster token before applying a form. No changes were applied.');
        const tradition=item.spellcasting?.tradition;
        if (!['arcane','divine','occult','primal'].includes(tradition)) throw Error('The native spellcasting tradition is missing.');
        const overlaps = actor.items.filter(e => e.type==='effect' && !e.isExpired && (e.system.rules.some(r=>r.key==='BattleForm') || e.traits.has('polymorph')));
        if(actor.flags.pf2e.polymorphed&&!overlaps.length)throw Error('An existing polymorph could not be identified. The GM must resolve that overlap first.');
        if (overlaps.length) {
            const proceed = await confirmAction({title:'Polymorph overlap — GM ruling',content:`<p>${overlaps.map(e=>esc(e.name)).join(', ')} already affects this actor. Resolve the new polymorph's counteract check with native controls first. Confirm only if it succeeded against each listed effect. Otherwise cancel; the old form remains. Resources are not refunded.</p>`,label:'Confirm counteract success and replacement'});
            if (!proceed) return {status:'cancelled'};
        }
        const template = await fromUuid(`Compendium.pf2e.spell-effects.Item.${kind==='animal-form'?data.choice:FORM_PROFILES[kind].effectId}`);
        const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalFormMechanics(template.toObject())));
        const digest=Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
        if(!formDigestVerified(template.id,digest))throw Error('Native form Effect mechanics changed from the verified baseline. Review before applying.');
        const source=prepareFormSource(template.toObject(),{kind,rank:data.rank,choice:data.choice,flying:data.choice==='flying'});
        const castId=randomID();
        source.flags ??= {}; source.flags[MODULE_ID]={formCastId:castId,runtime:{castInstanceId:castId,sourceActorUuid:actor.uuid,sourceItemUuid:item.uuid,sourceItemName:item.name}};
        source.system.context={origin:{actor:actor.uuid,token:token.uuid,item:item.uuid,spellcasting:{attribute:{type:item.attribute,mod:item.spellcasting.statistic?.attributeModifier?.value??0},tradition},rollOptions:(item.loadVariant({castRank:data.rank})??item).getOriginData().rollOptions},target:{actor:actor.uuid,token:token.uuid},roll:null};
        source.system.start={value:game.time.worldTime,initiative:game.combat?.combatant?.initiative??null};
        source.system.traits.value=[...new Set([...source.system.traits.value,'polymorph'])];
        const journal=await this.ongoing.begin({castId,kind:'form',formKind:kind,name:item.name,rank:data.rank,choice:data.choice,sourceActorUuid:actor.uuid,sourceItemUuid:item.uuid,sourceMessageId:message?.id??null,recipientUuids:[actor.uuid],tradition,dc:item.spellcasting.statistic?.dc?.value,tokenUuid:token.uuid,overlapRuling:overlaps.map(e=>e.uuid)});
        try {
            if(message)await message.setFlag(MODULE_ID,'ongoingCastId',castId);
            for(const old of overlaps){ const oldJournal=this.ongoing.find(formFlag(old)); if(oldJournal)await this.ongoing.end(oldJournal,{reason:'counteracted'}); else await old.delete(); }
            this.ongoing.assertCoordinator();
            const previousTemp=actor.system.attributes.hp.temp;
            const [effect]=await actor.createEmbeddedDocuments('Item',[source]);
            if(!effect || !actor.flags.pf2e.battleForm)throw Error('Native form did not prepare. Review before retrying.');
            const temp=Number(effect.rules.find(r=>r.key==='BattleForm')?.overrides.tempHP)||0;
            if(temp>previousTemp)await waitForNativeFormUpdate(actor,()=>tempHPSourceId(actor.system.attributes.hp)===effect.id&&actor.system.attributes.hp.temp===temp,'Form temporary HP');
            const dimensions=actor.system.traits.size.tokenDimensions;
            token.parent.syncTokenDimensions(token,dimensions);
            await waitForNativeFormUpdate(token,()=>token.width===dimensions.width&&token.height===dimensions.height,'Form token space','updateToken');
            await this.ongoing.attach(journal,effect);
            const record=clone(state(journal));record.effectUuid=effect.uuid;
            const breathId=effect.flags.pf2e.itemGrants?.dragonBreath?.id;
            if(breathId){const breath=actor.items.get(breathId);await breath.setFlag(MODULE_ID,'formCastId',castId);record.breathUuid=breath.uuid;record.dragon=clone(effect.flags.pf2e.rulesSelections.dragonForm);}
            await this.ongoing.save(journal,record);await this.ongoing.activate(journal);
            await ChatMessage.create({speaker:ChatMessage.getSpeaker({actor}),whisper:message?.whisper??[],blind:message?.blind??false,content:`<p><strong>${esc(item.name)}</strong>: ${esc(choices.find(c=>c.value===data.choice).label)}; rank ${data.rank}. Native form applied. Use native Strikes and Dragon Breath controls; Dismiss through Ongoing spells. Resources remain spent.</p>`});
            return{status:'applied',castId,journalId:journal.id,effectUuid:effect.uuid};
        }catch(error){await this.ongoing.review(journal,`Form application interrupted: ${error.message}`);throw error;}
    }
    async reconcile(journal,record){
        try{for(const entry of record.entries.filter(e=>e.status==='ended'&&!e.detached)){
            const actor=await fromUuid(entry.actorUuid);if(!actor)continue;
            await waitForNativeFormUpdate(actor,()=>tempHPSourceId(actor.system.attributes.hp)!==entry.uuid.split('.').at(-1),'Form temporary HP removal');
            const token=await fromUuid(record.tokenUuid),dimensions=actor.system.traits.size.tokenDimensions;
            if(token?.linkToActorSize){token.parent.syncTokenDimensions(token,dimensions);await waitForNativeFormUpdate(token,()=>token.width===dimensions.width&&token.height===dimensions.height,'Reverted token space','updateToken');}
        }}catch(error){await this.ongoing.review(journal,error.message);return;}
        if(record.entries.length && record.entries.every(e=>e.status==='ended'||e.detached)){record.status='ended';record.endedAt=game.time.worldTime;await this.ongoing.save(journal,record);}
    }
    async action(journal,action,data,user){
        const record=clone(state(journal));
        if(record.status!=='active')throw Error('This form is not active.');
        if(action==='form-dismiss')return this.ongoing.end(journal,{reason:'dismissed'});
        if(action==='form-recharge'){
            if(!user.isGM||!data.confirmed)throw Error('Only the GM can confirm recharge after timing review.');
            record.rechargeReviews??=[];record.rechargeReviews.push({userId:user.id,previous:record.breathUse,at:this.ongoing.clock()});record.breathUse=null;await this.ongoing.save(journal,record);return{status:'ready'};
        }
        if(action!=='form-breath')throw Error('Unknown form action.');
        const breath=await fromUuid(record.breathUuid),effect=await fromUuid(record.effectUuid);
        if(!breath||!effect||effect.isExpired)throw Error('This form no longer grants Dragon Breath.');
        if(!rechargeReady(record.breathUse,this.ongoing.clock()))throw Error('Dragon Breath has not recharged. Changed encounter timing requires GM review.');
        if(record.breathCards?.some(id=>!['completed'].includes(game.messages.get(id)?.getFlag(MODULE_ID,'basicSaveState')?.status)))throw Error('Finish or reconcile the previous breath before another use.');
        const targets=await Promise.all((data.targetUuids??[]).map(uuid=>fromUuid(uuid)));
        if(!targets.length||targets.some(t=>!t?.actor?.isOfType('creature')))throw Error('Target all creatures in the breath area.');
        if(!data.confirmed)throw Error('Review breath shape, walls and affected targets first.');
        const plan=this.families.plan({name:breath.name,uuid:breath.uuid,baseRank:record.rank,system:{damage:{breath:{formula:'10d6',type:record.dragon.damageType}},defense:{save:{statistic:record.dragon.saveType}}}},'aura');
        record.status='applying';await this.ongoing.save(journal,record);
        try{
            const recharge=await new Roll('1d4').evaluate();
            record.breathUse={...this.ongoing.clock(),rounds:recharge.total,roll:recharge.toJSON()};
            await this.ongoing.save(journal,record);
            const {card}=await this.saves.start(breath,{sourceActor:breath.actor,plan,targets,castRank:record.rank,dc:record.dc,skipConfirmation:true});
            await card.setFlag(MODULE_ID,'formBreathCastId',record.castId);
            record.breathCards??=[];record.breathCards.push(card.id);record.status='active';await this.ongoing.save(journal,record);
            await recharge.toMessage({speaker:ChatMessage.getSpeaker({actor:breath.actor}),flavor:'Dragon Breath — rounds until recharge'});
            return{status:'prepared',cardId:card.id,rounds:recharge.total};
        }catch(error){await this.ongoing.review(journal,`Breath activation interrupted: ${error.message}`);throw error;}
    }
    assertSave(card){
        const castId=card.getFlag(MODULE_ID,'formBreathCastId');if(!castId)return;
        this.ongoing.assertCoordinator();
        const journal=this.ongoing.find(castId), record=journal&&state(journal), effect=record&&fromUuidSync(record.effectUuid);
        if(record?.status!=='active'||!effect||effect.isExpired||!record.breathCards?.includes(card.id))throw Error('The granting form ended or needs review. Reconcile this pending breath manually.');
    }
    async damage(item){
        if(!formFlag(item)||item.type!=='action')return null;
        const record=state(this.ongoing.find(formFlag(item)));
        if(!record||record.status!=='active'||!await fromUuid(record.effectUuid))throw Error('The granting form is unavailable. Reconcile this breath manually.');
        // PF2e's enrichment prepares inline damage with native modifiers and the
        // granted action's DamageAlteration rules (type and rank-8 dice).
        const html=await game.pf2e.TextEditor.enrichHTML('@Damage[10d6[untyped]]',{rollData:item.getRollData()});
        const root=document.createElement('div');root.innerHTML=html;
        const link=root.querySelector('[data-damage-roll]');
        if(!link?.dataset.baseFormula)throw Error('Native Dragon Breath damage preparation failed.');
        const DamageRoll=CONFIG.Dice.rolls.find(c=>c.name==='DamageRoll');
        const domains=['damage','inline-damage',`${item.id}-inline-damage`,`${item.slug}-inline-damage`];
        return{template:{damage:{roll:new DamageRoll(link.dataset.formula)}},context:{options:new Set([...item.actor.getRollOptions(domains),...item.getRollOptions('item'),...game.pf2e.TextEditor.createActionOptions(item),...item.system.traits.value])}};
    }
    controls(journal,record){
        if(record.status!=='active')return[];
        const actor=fromUuidSync(record.sourceActorUuid);if(!game.user.isGM&&!actor?.isOwner)return[];
        const controls=[{action:`form-dismiss-${journal.id}`,label:`Dismiss ${record.name}`,callback:()=>this.ongoing.request('form-dismiss',{castId:record.castId,revision:record.revision})}];
        if(record.breathUuid)controls.push({action:`form-breath-${journal.id}`,label:`Dragon Breath — ${rechargeReady(record.breathUse,this.ongoing.clock())?'2 actions':'recharging'}`,callback:()=>this.breath(record)});
        if(record.breathUse&&game.user.isGM)controls.push({action:`form-recharge-${journal.id}`,label:'Review Dragon Breath recharge',callback:async()=>{
            if(await confirmAction({title:'Dragon Breath recharge',content:'<p>Confirm the recorded recharge interval has elapsed, accounting for encounter changes and initiative corrections. This records an explicit GM timing correction.</p>',label:'Confirm recharge elapsed'}))return this.ongoing.request('form-recharge',{castId:record.castId,revision:record.revision,confirmed:true});
        }});
        return controls;
    }
    async breath(record){
        const confirmed=await confirmAction({title:'Dragon Breath — review area',content:`<p>${record.dragon.breathShape==='cone'?'30-foot cone':'100-foot line'}; ${esc(record.dragon.damageType)}; basic ${esc(record.dragon.saveType)} save at DC ${record.dc}. Target every affected creature and confirm shape, orientation, walls and eligibility. Activation starts the 1d4-round recharge; reactions and GM finalization precede damage.</p>`,label:'Activate Dragon Breath'});
        if(confirmed)return this.ongoing.request('form-breath',{castId:record.castId,revision:record.revision,confirmed:true,targetUuids:[...game.user.targets].map(t=>t.document.uuid)});
    }
    bindSheet(app,html){
        const root=html instanceof HTMLElement?html:html?.[0];if(!root||!app.actor||root.dataset.formControlsBound)return;
        root.dataset.formControlsBound='true';
        root.addEventListener('click',event=>{
            const link=event.target.closest('a.inline-roll,a.inline-check');if(!link)return;
            const id=link.dataset.itemId??link.closest('[data-item-id]')?.dataset.itemId;
            const item=app.actor.items.get(id),castId=formFlag(item);if(!castId||item.type!=='action')return;
            const journal=this.ongoing.find(castId);
            if(!journal||state(journal).entries.some(e=>e.detached))return;
            event.preventDefault();event.stopImmediatePropagation();
            if(journal&&!state(journal).entries.some(e=>e.detached))void this.breath(state(journal)).catch(e=>ui.notifications.error(e.message));
        },true);
    }
    bind(message,root){
        const item=message.item,castId=formFlag(item);if(!castId||item.type!=='action'||root.querySelector('.pf2e-form-breath'))return;
        const journal=this.ongoing.find(castId),record=journal&&state(journal);if(!record||record.entries.some(e=>e.detached))return;
        for(const link of root.querySelectorAll('a.inline-roll, a.inline-check')){link.removeAttribute('data-formula');link.replaceWith(document.createTextNode(link.textContent));}
        if(!game.user.isGM&&!item.actor.isOwner)return;
        const button=document.createElement('button');button.className='pf2e-form-breath';button.textContent='Use Dragon Breath — 2 actions';button.disabled=record.status!=='active';root.append(button);
        button.addEventListener('click',()=>this.breath(state(journal)).catch(e=>ui.notifications.error(e.message)));
    }
}
