// Spells whose PF2e Effect leaves the rest of the text to the module (support-cards.js), and Heartbolt:
//   - True Target: PF2e's Effect on each attacker, its token mark on the designated creature, used up by the attacker's first attack roll against it
//     (the module's `consumeOn`);
//   - Sacred Covenant: the pact's Effect on each target; the first time one would drop to 0 Hit Points it stays at 1 (`holdCovenant`), then PF2e's
//     Effect (the 50 temporary Hit Points for 1 minute), Wounded +1, and immunity until its next daily preparations (`covenantKept`);
//   - Heartbolt: the bolt (healing, or the save card for undead), then the plume for every other creature within the emanation of the target.
import { applyDamageWithReceipt } from "./native-damage-receipt.js";
import { isDying, recoverFromDying } from "./dying-recovery.js";
import { loadNativeEffectTemplate, prepareNativeEffectSource, createNativeEffect } from "./native-outcome-effects.js";
import { tokenDistance } from "./token-distance.js";
import { DamageRollClass, MODULE_ID, escapeHTML, post as say } from "./runtime-utils.js";

import { noticeImmunity } from "./immunity-notice.js";
const traitsOf = actor => actor.traits ?? new Set(actor.system?.traits?.value ?? []);
const has = (actor, trait) => { const traits = traitsOf(actor); return traits.has?.(trait) ?? traits.includes?.(trait); };
const living = actor => !has(actor, "undead") && !has(actor, "construct");

export async function trueTargetPart({ caster, spell, data, phase, tokens, options }) {
    if (tokens.length > phase.count) throw new Error(`${data.spellName}: at most ${phase.count} creatures.`);
    let designated = options.designatedUuid ? await fromUuid(options.designatedUuid) : null;
    if (!designated) {
        const choices = canvas.scene.tokens.filter(token => token.actor && !tokens.some(entry => (entry.document ?? entry) === token));
        const picked = await foundry.applications.api.DialogV2.prompt({ window: { title: `${data.spellName}: designate a creature` }, rejectClose: false,
            content: `<select name="token">${choices.map(token => `<option value="${token.uuid}">${escapeHTML(token.name)}</option>`).join("")}</select>`,
            ok: { callback: (_event, button) => button.form.elements.token.value } });
        designated = picked ? await fromUuid(picked) : null;
    }
    if (!designated) return { status: "cancelled" };
    const template = await loadNativeEffectTemplate(phase.effectUuid);
    if (!template) throw new Error(`${data.spellName}: PF2e's Effect is unavailable.`);
    const index = (template.system?.rules ?? []).findIndex(rule => rule.key === "TokenMark");
    const made = [];
    for (const token of tokens) {
        const source = prepareNativeEffectSource(template, { castInstanceId: data.lastingCastId ?? foundry.utils.randomID(), castRank: Number(data.castRank), sourceActorUuid: caster.uuid,
            sourceItemUuid: spell.uuid, sourceItemName: data.spellName, resolutionKind: "incarnate", targetActorUuid: token.actor.uuid,
            // (The mark on the designated creature; the first attack roll against it uses the Effect up.)
            ruleOverrides: [{ index, key: "TokenMark", patch: { uuid: designated.uuid } }], consumeOn: { on: "attack-roll", option: `target:mark:${phase.markSlug}` } });
        made.push((await createNativeEffect(token.actor, source)).uuid);
    }
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(tokens.map(token => token.name).join(", "))} see ${escapeHTML(designated.name)}'s futures: the first attack roll each makes against it rolls twice (the better result) and ignores circumstance penalties.</p>`);
    return { made, designated: designated.uuid };
}

export async function covenantPart({ caster, spell, data, phase, tokens }) {
    if (tokens.length > phase.count) throw new Error(`${data.spellName}: the caster and up to ${phase.count - 1} willing creatures.`);
    const key = spell.slug ?? spell.name;
    const out = [];
    for (const token of tokens) {
        const actor = token.actor;
        if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.covenantImmune?.key === key)) { out.push({ name: token.name, immune: true }); noticeImmunity({ actor, token, blocked: data.spellName, why: "immune until its next daily preparations" }); continue; }
        await actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: the pact`, type: "effect", img: spell.img ?? "icons/svg/angel.svg",
            flags: { [MODULE_ID]: { covenant: { key, spell: data.spellName, hp: phase.hp, wounded: phase.wounded, effectUuid: phase.effectUuid, casterUuid: caster.uuid, rank: Number(data.castRank) } } },
            system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true },
                description: { value: `<p>Until the next daily preparations: the first time it would be reduced to 0 Hit Points (not killed outright), it stays at ${phase.hp} with 50 temporary Hit Points for 1 minute and Wounded +${phase.wounded}. Violating the deity's anathema ends it.</p>` } } }]);
        out.push({ name: token.name, bound: true });
    }
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(out.map(entry => `${entry.name}${entry.immune ? " (immune)" : ""}`).join(", "))}.</p>`);
    return { results: out };
}

/** An update taking a pact-holder to 0 Hit Points: it stays at the pact's Hit Points (the follow-up runs after the update). */
export function holdCovenant(actor, changes, options) {
    const key = "system.attributes.hp.value";
    const flat = key in changes, after = flat ? changes[key] : foundry.utils.getProperty(changes, key);
    const before = Number(actor._source?.system?.attributes?.hp?.value);
    if (typeof after !== "number" || after > 0 || !(before > 0)) return false;
    const pact = (actor.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.covenant);
    if (!pact) return false;
    const hp = Number(pact.flags[MODULE_ID].covenant.hp);
    if (flat) changes[key] = hp; else foundry.utils.setProperty(changes, key, hp);
    options[MODULE_ID] = { ...(options[MODULE_ID] ?? {}), covenantKept: pact.id };
    return true;
}

/** After the held update: PF2e's Effect (its temporary Hit Points), Wounded up, the pact gone and immunity until the next daily preparations. */
export async function covenantKept(actor, options) {
    const id = options?.[MODULE_ID]?.covenantKept;
    if (!id || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return null;
    const pact = actor.items.get(id);
    const data = pact?.flags?.[MODULE_ID]?.covenant;
    if (!data) return null;
    const template = await loadNativeEffectTemplate(data.effectUuid);
    if (template) await createNativeEffect(actor, prepareNativeEffectSource(template, { castInstanceId: foundry.utils.randomID(), castRank: data.rank, sourceActorUuid: data.casterUuid,
        sourceItemUuid: null, sourceItemName: data.spell, resolutionKind: "incarnate", targetActorUuid: actor.uuid }));
    for (const slug of ["dying", "unconscious"]) if (actor.hasCondition?.(slug)) await actor.decreaseCondition(slug, { forceRemove: true });
    await actor.increaseCondition("wounded", { value: data.wounded });
    await pact.delete();
    await actor.createEmbeddedDocuments("Item", [{ name: `${data.spell}: immune until daily preparations`, type: "effect", img: "icons/svg/aura.svg", flags: { [MODULE_ID]: { covenantImmune: { key: data.key } } },
        system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: false }, description: { value: `<p>Immune to ${escapeHTML(data.spell)} until its next daily preparations.</p>` } } }]);
    await say(actor, `<p><strong>${escapeHTML(data.spell)}</strong>: ${escapeHTML(actor.name)} avoids being knocked out — it stays at ${data.hp} Hit Point${data.hp === 1 ? "" : "s"} with 50 temporary Hit Points (Wounded +${data.wounded}).</p>`);
    return { kept: actor.uuid };
}

export async function heartboltPart({ saves, caster, spell, data, phase, token }) {
    const rank = Number(data.castRank), rollData = { item: { rank, level: rank } };
    const heal = async (targets, formula, label) => {
        if (!targets.length) return null;
        const roll = await new (DamageRollClass())(`(${formula})[healing]`, rollData).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(label)}` }).catch(() => null);
        for (const target of targets) {
            const wasDying = isDying(target.actor);
            await applyDamageWithReceipt(target.actor, { damage: -roll.total, token: target.document ?? target, item: spell, rollOptions: new Set(), skipIWR: false }, foundry.utils.randomID());
            await recoverFromDying(target.actor, wasDying);
        }
        return roll.total;
    };
    const out = {};
    const doc = token.document ?? token;
    // (The bolt: a willing living creature healed; an undead creature's basic save against the same amount.)
    if (has(token.actor, "undead")) out.boltCard = await saves.start(spell, { plan: foundry.utils.deepClone(phase.boltPlan), sourceActor: caster, targets: [token], castRank: rank, skipConfirmation: true });
    else if (living(token.actor)) out.boltHealed = await heal([token], phase.boltFormula, `the bolt heals ${token.name}`);
    // (The plume: every other creature within the emanation of the target.)
    const others = canvas.scene.tokens.filter(entry => entry.actor && entry !== doc && !entry.hidden && tokenDistance(doc, entry) <= phase.radius).map(entry => entry.object ?? entry);
    const healed = others.filter(entry => living(entry.actor)), harmed = others.filter(entry => has(entry.actor, "undead"));
    out.plumeHealed = await heal(healed, phase.plumeFormula, "the plume of vital energy");
    if (harmed.length) out.plumeCard = await saves.start(spell, { plan: foundry.utils.deepClone(phase.plumePlan), sourceActor: caster, targets: harmed, castRank: rank, skipConfirmation: true });
    out.healed = healed.map(entry => entry.name); out.harmed = harmed.map(entry => entry.name);
    for (const key of ["boltCard", "plumeCard"]) if (out[key]) out[key] = out[key].card ?? out[key];
    return out;
}
