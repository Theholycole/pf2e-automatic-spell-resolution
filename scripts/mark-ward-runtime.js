// Mark of Mystery: a creature targeting the caster or the marked ally with a harmful effect — an attack roll on either, or a save card the module starts against
// either — gets the spell's Will save card (Frightened 1 or 2, then immune for the hour), once until its immunity; a creature of a type of the caster's tradition
// (or a dragon or spellcaster of it) holds the module's −1 status penalty Effect for that save. The active GM runs it.
import { escapeHTML, MODULE_ID } from "./runtime-utils.js";
import { createNativeEffect, loadNativeEffectTemplate, prepareNativeEffectSource } from "./native-outcome-effects.js";

import { noticeImmunity } from "./immunity-notice.js";
const wardOf = actor => (actor?.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.markWard && !effect.isExpired);

/** Whether the creature is of the tradition: one of its creature types, or a dragon or spellcaster of it. */
export function ofTradition(actor, tradition, types) {
    const traits = actor?.traits ?? new Set(actor?.system?.traits?.value ?? []);
    if ((types ?? []).some(type => traits.has?.(type))) return true;
    if (traits.has?.("dragon") && traits.has?.(tradition)) return true;
    return (actor?.itemTypes?.spellcastingEntry ?? []).some(entry => (entry.tradition ?? entry.system?.tradition?.value) === tradition);
}

/** A creature targeted a warded one: the save card, unless it's the caster, already asked, or immune. */
export async function markWardTrigger(attacker, targets, start) {
    if (!game.user?.isGM || game.users.activeGM?.id !== game.user.id || !attacker) return [];
    const started = [];
    for (const target of targets) {
        const ward = wardOf(target);
        if (!ward || target === attacker) continue;
        const data = ward.flags[MODULE_ID].markWard;
        if (attacker.uuid === data.casterUuid || (data.asked ?? []).includes(attacker.uuid) || wardOf(attacker)?.flags?.[MODULE_ID]?.markWard?.castId === data.castId) continue;
        const key = data.plan?.resolution?.temporaryImmunity?.key;
        if (key && (attacker.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.spellImmunity?.key === key && !effect.isExpired)) { noticeImmunity({ actor: attacker, blocked: data.plan?.source?.name ?? ward.name ?? "the ward's save", why: "temporarily immune after an earlier save", once: `${data.castId}:${attacker.uuid}:ward` }); continue; }
        // (Asked once — on each warded creature's Effect — until the save's immunity covers it.)
        for (const holder of [ward, ...(await Promise.all((data.holders ?? []).map(uuid => fromUuid(uuid))))].filter(Boolean)) {
            const held = holder.flags?.[MODULE_ID]?.markWard;
            if (held && held.castId === data.castId) await holder.setFlag(MODULE_ID, "markWard", { ...held, asked: [...new Set([...(held.asked ?? []), attacker.uuid])] });
        }
        const caster = await fromUuid(data.casterUuid), spell = await fromUuid(data.spellUuid);
        const token = attacker.getActiveTokens?.(true, true)?.[0];
        if (!caster || !spell || !token) continue;
        if (data.tradition && ofTradition(attacker, data.tradition, data.types)) {
            const template = await loadNativeEffectTemplate(data.penaltyUuid);
            if (template) await createNativeEffect(attacker, prepareNativeEffectSource(template, { castInstanceId: data.castId, castRank: data.castRank, sourceActorUuid: caster.uuid,
                sourceItemUuid: spell.uuid, sourceItemName: spell.name, resolutionKind: "mark-ward", targetActorUuid: attacker.uuid }));
        }
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(spell.name)}</strong>: ${escapeHTML(attacker.name)} targeted ${escapeHTML(target.name)} — it must attempt a ${escapeHTML(data.statistic)} save.</p>` }); } catch (_) {}
        started.push(await start(spell, { plan: foundry.utils.deepClone(data.plan), sourceActor: caster, targets: [token], castRank: data.castRank, dc: data.dc, skipConfirmation: true, markWardTrigger: true }));
    }
    return started;
}

/** An attack roll (PF2e's message) on a warded creature. */
export async function markWardOnAttack(message, start) {
    const context = message?.flags?.pf2e?.context;
    if (!["attack-roll", "spell-attack-roll"].includes(context?.type) || !context.target?.actor) return [];
    const attacker = game.actors.get(String(context.actor ?? message.speaker?.actor ?? "").split(".").pop()) ?? (message.speaker?.token ? canvas.scene?.tokens.get(message.speaker.token)?.actor : null);
    const target = await fromUuid(context.target.actor);
    return markWardTrigger(attacker, target ? [target] : [], start);
}
