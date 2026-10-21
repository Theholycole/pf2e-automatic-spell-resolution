import { MODULE_ID } from './effect-runtime.js';
import { mythicCastCheck, spendMythicCast } from './mythic-cost.js';
export function activeManagedForm(actor) {
    if(!actor?.flags?.pf2e?.battleForm)return null;
    return actor?.items?.find(item => item.type === 'effect' && item.getFlag(MODULE_ID, 'formCastId') && !item.isExpired && item.system.rules.some(r => r.key === 'BattleForm'));
}
/**
 * Wraps through libWrapper when it's active, so PF2e Dailies' and Magic+'s wrappers of the same methods are ordered with ours and
 * libWrapper doesn't warn about a direct wrap (2026-10-11); directly otherwise (the core's scripts/wrap.js does the same for its
 * patches). wrapper(wrapped, ...args), `this` the caller's; "MIXED" when it may stop before the native method.
 */
const registered=new Set();
function wrapMethod(target,wrapper,type='WRAPPER'){
    const path=target.split('.'),key=path.pop(),owner=path.reduce((object,part)=>object?.[part],globalThis);
    const original=owner?.[key];
    if(typeof original!=='function'||original.pf2eFormGuard)return;
    if(game.modules?.get?.('lib-wrapper')?.active&&typeof globalThis.libWrapper?.register==='function'){
        if(registered.has(target))return;
        registered.add(target);
        try{globalThis.libWrapper.register(MODULE_ID,target,wrapper,type);}catch(error){console.warn(`${MODULE_ID} | ${target} could not be wrapped.`,error);}
        return;
    }
    const wrapped=function(...args){return wrapper.call(this,(...inner)=>original.apply(this,inner),...args);};
    wrapped.pf2eFormGuard=true;owner[key]=wrapped;
}
/** Scoped to module-managed forms; delegate unchanged actors to native methods. */
export function installFormGuards() {
    wrapMethod('game.pf2e.RuleElements.builtin.BattleForm.prototype.onDelete',function(onDelete,updates){
        if(this.item.getFlag(MODULE_ID,'formCastId'))new game.pf2e.RuleElements.builtin.TempHP({key:'TempHP',value:1},{parent:this.item}).onDelete(updates);
        return onDelete(updates);
    });
    wrapMethod('CONFIG.PF2E.Actor.documentClasses.character.prototype.prepareData',function(prepare,...args){
        const result=prepare(...args), effect=activeManagedForm(this);
        const battle=effect?.rules.find(r=>r.key==='BattleForm'&&!r.ignored);
        if(battle){
            const allowed=new Set(Object.keys(battle.overrides.speeds));
            for(const rule of effect.rules)if(rule.key==='BaseSpeed'&&!rule.ignored&&rule.test())allowed.add(rule.selector);
            for(const type of ['land','burrow','climb','fly','swim'])if(!allowed.has(type))this.system.movement.speeds[type]=null;
        }
        return result;
    });
    wrapMethod('CONFIG.PF2E.Item.documentClasses.spellcastingEntry.prototype.cast',function(cast,...args){
        if(activeManagedForm(this.actor))throw Error('This battle form prevents spellcasting. Dismiss it before casting. No resource was spent.');
        // (A mythic spell costs a Mythic Point — or a Hero Point with the item module's setting —: refused here when the caster has none; the GM's Shift-click
        // passes. mythic-cost.js.)
        const due=mythicCastCheck(this.actor,args[0],{bypass:game.user?.isGM===true&&globalThis.event?.shiftKey===true});
        if(!due)return cast(...args);
        const actor=this.actor,spell=args[0];
        return Promise.resolve(cast(...args)).then(async result=>{await spendMythicCast(actor,spell,due);return result;});
    },'MIXED');
    wrapMethod('CONFIG.PF2E.Item.documentClasses.consumable.prototype.consume',function(consume,...args){
        if(activeManagedForm(this.actor))throw Error('Gear is absorbed in this battle form; item activation is unavailable.');
        return consume(...args);
    },'MIXED');
}
/** Item onCreate/onDelete dispatch native actor updates without awaiting them. */
export async function waitForNativeFormUpdate(actor, predicate, label, hookName = 'updateActor') {
    if(predicate())return;
    await new Promise((resolve,reject)=>{
        const finish=()=>{clearTimeout(timer);clearInterval(poll);Hooks.off(hookName,hook);resolve();};
        const check=()=>{if(predicate())finish();};
        const hook=Hooks.on(hookName,changed=>{if(changed.uuid===actor.uuid)queueMicrotask(check);});
        // Token animation may finish after updateToken, without another hook.
        const poll=setInterval(check,50);
        const timer=setTimeout(()=>{clearInterval(poll);Hooks.off(hookName,hook);predicate()?resolve():reject(Error(`${label} did not receive a confirmed native actor update. Review before retrying.`));},5000);
        check();
    });
}
