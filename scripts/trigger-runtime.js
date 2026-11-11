// Spells answering a trigger (trigger-cards.js), and the later triggers the module watches:
//   - the life link (Bound in Death): each time the caster takes damage, the linked foe's Will save — half the damage moved to it, a round without it,
//     or the spell ending; the leash's distance and 0 Hit Points end it;
//   - the sacrifice (Love's Sacrifice): the ally's save, its move beside the caster, its share of the damage the caster just took, the caster's Hit
//     Points given back (at least 1), the ally's death at 0 on a failure;
//   - the fury (Blinding Fury): the creature can't observe the caster until the end of its turn; its lasting curse reacts to the damage it deals;
//   - the leech (Divinity Leech): the target's divine casts heal the caster and call for its save;
//   - the mimic (Mimic Spell): the counteract check against the triggering spell, then the copy the caster can cast once;
//   - the word of death (Touch of Death): the mark after the Strike, then the word's Fortitude save;
//   - the emblem (Unblinking Flame Emblem): the target's Effect, the strikers' fire, the caster's Off-Guard against other enemies.
// Damage a creature took is read from PF2e's damage-taken message: its amount, the types its item names, and its origin (the attacker's signature).
import { applyDamageWithReceipt } from "./native-damage-receipt.js";
import { isDying, recoverFromDying } from "./dying-recovery.js";
import { ONGOING_FLAG } from "./ongoing-core.js";
import { counteracts } from "./affliction-care-core.js";
import { findStrikeMessage } from "./strike-prelude-runtime.js";
import { freeSpaceBeside, teleportToken } from "./teleport-runtime.js";
import { tokenDistance } from "./token-distance.js";
import { lastDamageOf } from "./climb-aid-runtime.js";
import { DEGREES, DamageRollClass, MODULE_ID, activeGM, escapeHTML } from "./runtime-utils.js";

import { noticeImmunity } from "./immunity-notice.js";
const tokenOf = actor => actor?.getActiveTokens?.(true, true)?.[0] ?? null;
const say = (actor, content, whisper = false) => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content, ...(whisper ? { whisper: game.users.filter(user => user.isGM).map(user => user.id) } : {}) }).catch(() => null);
const recordOf = (ongoing, castId) => { const journal = castId ? ongoing.find(castId) : null; const record = journal?.getFlag(MODULE_ID, ONGOING_FLAG); return record?.status === "active" ? { journal, record } : null; };

/** A creature's save against the spell's DC (a forced degree when the GM rules it). */
export async function rollSave(actor, statistic, dc, spell, { degree = null, traits = [] } = {}) {
    if (degree) { if (!DEGREES.includes(degree)) throw new Error(`${degree} isn't a degree of success.`); return degree; }
    const roll = await actor.saves?.[statistic]?.roll({ dc: { value: Number(dc) }, item: spell ?? undefined, skipDialog: true, ...(traits.length ? { extraRollOptions: traits.map(trait => `item:trait:${trait}`) } : {}) });
    const value = Number(roll?.degreeOfSuccess ?? -1);
    if (value < 0) throw new Error(`${actor.name}'s ${statistic} save wasn't rolled.`);
    return DEGREES[value];
}

/** The latest damage-taken message for the creature (within a few seconds): its damage types (from its item) and the attacker's signature. */
export function recentDamage(actor, withinMs = 8000) {
    const now = Date.now();
    const message = game.messages.contents.slice(-60).reverse().find(entry => entry.flags?.pf2e?.appliedDamage?.uuid === actor.uuid && !entry.flags.pf2e.appliedDamage.isHealing
        && now - Number(entry.timestamp ?? 0) < withinMs);
    const options = message?.flags?.pf2e?.context?.options ?? [];
    const types = [...new Set(options.map(option => /^item:damage:type:([a-z]+)$/.exec(option)?.[1]).filter(Boolean))];
    const signature = options.map(option => /^origin:signature:(.+)$/.exec(option)?.[1]).find(Boolean) ?? null;
    return { message, types, signature };
}

/**
 * The damage-taken message PF2e posts for damage just taken. A hook on the creature's update runs before PF2e posts it, and how long that takes
 * varies (other modules' hooks run in between), so it's waited for — up to 3 seconds — instead of read after a fixed pause, which could find no
 * message yet: no attacker, no damage type, and the GM asked for one.
 */
export async function damageMessageSince(actor, since, withinMs = 8000) {
    for (let i = 0; i < 20; i++) {
        const found = recentDamage(actor, withinMs);
        if (found.message && Number(found.message.timestamp ?? 0) >= since - 1000) return found;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    return recentDamage(actor, withinMs);
}

/** The triggering damage's type: PF2e's record of it, else the GM's pick (user decision 2026-10-05), or a given one. */
async function damageType(types, label, given = null) {
    if (given) return given;
    if (types.length) return types[0];
    const choices = ["untyped", ...Object.keys(CONFIG.PF2E?.damageTypes ?? {}).filter(type => type !== "untyped")];
    const picked = await foundry.applications.api.DialogV2.prompt({ window: { title: label }, rejectClose: false,
        content: `<p>Which type was the damage? (PF2e didn't record it; the creature's resistances and weaknesses use it.)</p><select name="type">${choices.map(type => `<option value="${type}">${type}</option>`).join("")}</select>`,
        ok: { callback: (_event, button) => button.form.elements.type.value } });
    return picked || "untyped";
}

/** Damage of the stated amount, of the triggering damage's type (PF2e's record, else the GM's pick), with the creature's IWR. */
async function typedDamage(actor, amount, types, spell, { label = "Damage type", given = null } = {}) {
    if (!(amount > 0)) return { damage: 0 };
    const type = await damageType(types, label, given);
    const roll = await new (DamageRollClass())(`${amount}[${type}]`).evaluate();
    const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: tokenOf(actor) ?? undefined, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, foundry.utils.randomID());
    return { damage: receipt.damage, type };
}

/** "Until the end of its turn": the turn running now when it's that creature's, else its next turn; a round's time out of combat. */
export function untilEndOfTurn(actor) {
    const combat = game.combat;
    if (!combat?.started) return { worldTime: game.time.worldTime + 6 };
    if (combat.combatant?.actor?.uuid === actor.uuid) return { combatId: combat.id, round: combat.round, turn: combat.turn };
    return { actorUuid: actor.uuid, combatId: combat.id, startedAt: { round: combat.round, turn: combat.turn } };
}

// ---- The life link ----

export async function startLink({ ongoing, data, caster, spell, phase, token }) {
    const found = recordOf(ongoing, data.lastingCastId);
    if (!found) throw new Error(`${data.spellName}: the spell has ended.`);
    const dc = Number(spell.spellcasting?.statistic?.dc?.value ?? NaN);
    const [effect] = await caster.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: linked to ${token.name}`, type: "effect", img: spell.img ?? "icons/svg/chain.svg",
        flags: { [MODULE_ID]: { boundLink: { castId: data.lastingCastId, targetUuid: token.actor.uuid, statistic: phase.statistic, dc, immunityRounds: phase.immunityRounds, range: phase.range,
            spell: data.spellName, sourceItemUuid: spell.uuid, immuneUntil: null } } },
        system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true },
            description: { value: `<p>Each time ${escapeHTML(caster.name)} takes damage, ${escapeHTML(token.name)} attempts a ${escapeHTML(phase.statistic)} save (DC ${dc}); the link ends beyond ${phase.range} feet or at 0 Hit Points.</p>` } } }]);
    await ongoing.attach(found.journal, effect);
    return { effectUuid: effect.uuid };
}

/** The caster took damage: the linked foe's save and the damage moved. */
export async function linkOnDamage({ ongoing, actor, amount }) {
    if (!activeGM() || !(amount > 0)) return null;
    const since = Date.now();
    const effect = (actor.itemTypes?.effect ?? []).find(entry => entry.flags?.[MODULE_ID]?.boundLink);
    if (!effect) return null;
    const link = effect.flags[MODULE_ID].boundLink;
    const found = recordOf(ongoing, link.castId);
    if (!found) return null;
    const target = await fromUuid(link.targetUuid);
    const end = async reason => { await ongoing.end(found.journal, { reason }); return { ended: reason }; };
    if (!target) return end("target-missing");
    const casterToken = tokenOf(actor), targetToken = tokenOf(target);
    if (casterToken && targetToken && tokenDistance(casterToken, targetToken) > link.range) { await say(actor, `<p><strong>${escapeHTML(link.spell)}</strong> ends: ${escapeHTML(target.name)} is more than ${link.range} feet away.</p>`); return end("out-of-range"); }
    if (link.immuneUntil != null && game.time.worldTime < link.immuneUntil) { noticeImmunity({ actor: target, blocked: link.spell, why: `temporarily immune for ${link.immunityRounds} round${link.immunityRounds === 1 ? "" : "s"} after its last save` }); return { immune: true }; }
    const { types } = await damageMessageSince(actor, since);
    const spell = await fromUuid(link.sourceItemUuid);
    const result = await rollSave(target, link.statistic, link.dc, spell);
    const out = { degree: result, moved: 0 };
    if (result === "criticalSuccess") { await say(actor, `<p><strong>${escapeHTML(link.spell)}</strong>: ${escapeHTML(target.name)} critically succeeds; the spell ends.</p>`); return { ...out, ...(await end("critical-success")) }; }
    if (result !== "success") {
        // "The target takes half the damage of the effect instead of you": half back to the caster, half to the foe (its own IWR).
        const half = Math.floor(amount / 2);
        const wasDying = isDying(actor);
        await applyDamageWithReceipt(actor, { damage: -half, token: casterToken ?? undefined, item: spell ?? undefined, rollOptions: new Set(), skipIWR: true }, foundry.utils.randomID());
        await recoverFromDying(actor, wasDying, { keepWounded: true });
        out.moved = half; out.dealt = (await typedDamage(target, half, types, spell, { label: `${link.spell}: the damage ${target.name} takes` })).damage;
        await say(actor, `<p><strong>${escapeHTML(link.spell)}</strong>: ${escapeHTML(target.name)} ${result === "failure" ? "fails" : "critically fails"} its save and takes ${half} of the ${amount} damage instead.</p>`);
    }
    if (result !== "criticalFailure") await effect.setFlag(MODULE_ID, "boundLink", { ...link, immuneUntil: game.time.worldTime + 6 * link.immunityRounds });
    // "If either you or the target is reduced to 0 Hit Points, any damage from this spell is resolved, and then the spell ends."
    if (Number(actor.hitPoints?.value ?? 1) <= 0 || Number(target.hitPoints?.value ?? 1) <= 0) return { ...out, ...(await end("zero-hit-points")) };
    return out;
}

// ---- The sacrifice ----

export async function sacrificePart({ caster, spell, data, phase, token, options }) {
    if (token.actor === caster) throw new Error(`${data.spellName}: target another creature.`);
    const taken = Number(options.taken ?? lastDamageOf(caster)?.amount ?? NaN);
    let amount = Number(options.damage ?? taken);
    if (!(amount > 0)) amount = Number(await foundry.applications.api.DialogV2.prompt({ window: { title: data.spellName }, rejectClose: false,
        content: `<p>How much damage did ${escapeHTML(caster.name)} take?</p><input type="number" name="amount" min="1" value="1">`, ok: { callback: (_event, button) => Number(button.form.elements.amount.value) } }));
    if (!(amount > 0)) return { status: "cancelled" };
    const loves = options.loves ?? await foundry.applications.api.DialogV2.confirm({ window: { title: data.spellName }, content: `<p>${escapeHTML(phase.question)}</p>`, rejectClose: false });
    const dc = Number(spell.spellcasting?.statistic?.dc?.value ?? NaN);
    const degree = loves ? "failure" : await rollSave(token.actor, phase.statistic, dc, spell, { degree: options.degree ?? null });
    if (degree === "criticalSuccess") { await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(token.name)} is unaffected.</p>`); return { degree }; }
    const share = degree === "success" ? Math.floor(amount / 2) : amount;
    // (The creature moves beside the caster, beyond its Speed if need be.)
    const casterToken = tokenOf(caster), allyDoc = token.document ?? token;
    if (casterToken && tokenDistance(casterToken, allyDoc) > 5) { const space = freeSpaceBeside(casterToken, allyDoc, 3); if (space) await teleportToken(allyDoc, { destination: space, label: data.spellName }); }
    // (The caster's Hit Points before the damage, less the rest it takes — at least 1.)
    const before = Number(caster.hitPoints?.value ?? 0) + (Number.isFinite(taken) ? taken : amount);
    const wasDying = isDying(caster);
    await caster.update({ "system.attributes.hp.value": Math.min(Number(caster.hitPoints?.max ?? before), Math.max(1, before - (amount - share))) });
    await recoverFromDying(caster, wasDying, { keepWounded: true });
    // (It never reached 0 Hit Points: no Dead or Unconscious left from the damage.)
    if (caster.statuses?.has?.("dead")) await caster.toggleStatusEffect("dead", { active: false });
    for (const slug of ["dying", "unconscious"]) if (caster.hasCondition?.(slug)) await caster.decreaseCondition(slug, { forceRemove: true });
    const { types } = recentDamage(caster, 60000);
    const dealt = await typedDamage(token.actor, share, types, spell, { label: `${data.spellName}: the damage ${token.name} takes`, given: options.damageType ?? null });
    let died = false;
    if (degree !== "success" && Number(token.actor.hitPoints?.value ?? 1) <= 0) {
        // "If the damage reduces them to 0 Hit Points, they immediately die; this is a death effect."
        if (!token.actor.statuses?.has?.("dead")) await token.actor.toggleStatusEffect("dead", { active: true });
        for (const slug of ["dying", "unconscious"]) if (token.actor.hasCondition?.(slug)) await token.actor.decreaseCondition(slug, { forceRemove: true });
        died = true;
    }
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(token.name)} ${degree === "success" ? "succeeds" : "fails"} — it takes ${share} of the ${amount} damage; ${escapeHTML(caster.name)} keeps ${Number(caster.hitPoints?.value)} Hit Points.${died ? ` ${escapeHTML(token.name)} dies.` : ""}</p>`);
    return { degree, share, dealt: dealt.damage, casterHp: Number(caster.hitPoints?.value), died };
}

// ---- The fury ----

async function cantObserve(actor, observed, spellName, uuidHidden) {
    const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${spellName}: can't observe ${observed.name}`, type: "effect", img: "icons/svg/blind.svg",
        flags: { [MODULE_ID]: { turnBound: untilEndOfTurn(actor), furyBlind: { observedUuid: observed.uuid } } },
        system: { duration: { value: 1, unit: "rounds", expiry: "turn-end", sustained: false }, tokenIcon: { show: true },
            description: { value: `<p>It can't @UUID[Compendium.pf2e.conditionitems.Item.1wQY3JYyhMYeeV2G]{Observe} ${escapeHTML(observed.name)} until the end of its turn: ${escapeHTML(observed.name)} is @UUID[${uuidHidden}]{Hidden} to it if it was observed.</p>` } } }]);
    return effect;
}

export async function furyPart({ caster, spell, data, phase, token, options }) {
    const dc = Number(spell.spellcasting?.statistic?.dc?.value ?? NaN);
    const degree = await rollSave(token.actor, phase.statistic, dc, spell, { degree: options.degree ?? null });
    if (degree === "criticalSuccess") { await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(token.name)} is unaffected.</p>`); return { degree }; }
    await cantObserve(token.actor, caster, data.spellName, phase.hidden.uuid);
    let curse = null;
    if (degree !== "success") {
        const unlimited = degree === "criticalFailure";
        [curse] = await token.actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: ${unlimited ? "blinding curse" : `curse (${phase.minutes} minute${phase.minutes === 1 ? "" : "s"})`}`, type: "effect", img: spell.img ?? "icons/svg/blind.svg",
            flags: { [MODULE_ID]: { furyCurse: { casterUuid: caster.uuid, mode: unlimited ? "any" : "caster", spellName: data.spellName, hiddenUuid: phase.hidden.uuid, lastRound: null } } },
            system: { duration: unlimited ? { value: -1, unit: "unlimited", expiry: null, sustained: false } : { value: phase.minutes, unit: "minutes", expiry: "turn-start", sustained: false },
                start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                description: { value: unlimited ? "<p>The first time each round it damages a creature, it can't observe that creature until the end of its turn (the module applies it).</p>"
                    : `<p>Every time it damages ${escapeHTML(caster.name)}, it can't observe ${escapeHTML(caster.name)} until the end of its turn (the module applies it).</p>` } } }]);
    }
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(token.name)} ${degree === "success" ? "succeeds" : degree === "failure" ? "fails" : "critically fails"}: it can't observe ${escapeHTML(caster.name)} until the end of its turn (${escapeHTML(caster.name)} is Hidden to it if it was observed).</p>`);
    return { degree, curse: curse?.uuid ?? null };
}

/** A creature took damage: an attacker under the fury's curse can't observe it (the caster each time, or anyone the first time each round). */
export async function furyOnDamage(actor) {
    if (!activeGM()) return null;
    const { signature } = await damageMessageSince(actor, Date.now());
    if (!signature) return null;
    const attacker = canvas.scene?.tokens.find(token => token.actor?.signature === signature)?.actor ?? game.actors.find(entry => entry.signature === signature);
    const curse = (attacker?.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.furyCurse);
    if (!curse) return null;
    const data = curse.flags[MODULE_ID].furyCurse;
    if (data.mode === "caster" && actor.uuid !== data.casterUuid) return null;
    if (data.mode === "any") {
        const round = game.combat?.started ? `${game.combat.id}:${game.combat.round}` : `t${Math.floor(game.time.worldTime / 6)}`;
        if (data.lastRound === round) return null;
        await curse.setFlag(MODULE_ID, "furyCurse", { ...data, lastRound: round });
    }
    await cantObserve(attacker, actor, data.spellName, data.hiddenUuid);
    return { attacker: attacker.uuid, observed: actor.uuid };
}

// ---- The leech ----

export async function leechPart({ ongoing, caster, spell, data, phase, token, options }) {
    const healRoll = await new (DamageRollClass())(`${phase.heal}[healing]`).evaluate();
    await healRoll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(caster.name)} regains Hit Points` }).catch(() => null);
    const wasDying = isDying(caster);
    await applyDamageWithReceipt(caster, { damage: -healRoll.total, token: tokenOf(caster) ?? undefined, item: spell, rollOptions: new Set(), skipIWR: false }, foundry.utils.randomID());
    await recoverFromDying(caster, wasDying);
    const dc = Number(spell.spellcasting?.statistic?.dc?.value ?? NaN);
    const degree = await rollSave(token.actor, phase.statistic, dc, spell, { degree: options.degree ?? null });
    // (PF2e adds the value to an existing condition: the difference raises it to the stated value.)
    const stunnedNow = Number(token.actor.getCondition?.("stunned")?.value ?? 0);
    if (degree === "failure" && stunnedNow < phase.stunned.value) await token.actor.increaseCondition("stunned", { value: phase.stunned.value - stunnedNow });
    if (degree === "criticalFailure") await token.actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: Stunned for ${phase.stunned.criticalRounds} round${phase.stunned.criticalRounds === 1 ? "" : "s"}`, type: "effect", img: "icons/svg/daze.svg",
        system: { duration: { value: phase.stunned.criticalRounds, unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
            rules: [{ key: "GrantItem", uuid: phase.stunned.uuid, onDeleteActions: { grantee: "restrict" } }], description: { value: `<p>Stunned for ${phase.stunned.criticalRounds} round: it can't act.</p>` } } }]);
    const notes = { criticalSuccess: "", success: "Each target of the divine spell has an outcome one degree of success better than the result it rolled (the GM adjusts them).",
        failure: "The divine spell is lost: the GM undoes it.", criticalFailure: "The divine spell is lost: the GM undoes it." };
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(caster.name)} regains ${healRoll.total} Hit Points; ${escapeHTML(token.name)}'s Will save: ${degree.replace(/([A-Z])/g, " $1").toLowerCase()}.</p>${notes[degree] ? `<p class="pf2e-auto-gm-reminder"><strong>GM:</strong> ${notes[degree]}</p>` : ""}`);
    return { degree, healed: healRoll.total };
}

/** A creature cast a spell: a leech on it (this card's targets) presses the card's leech part when the spell is of the leech's tradition. */
export async function leechOnCast(api, message) {
    if (!activeGM()) return null;
    const origin = message?.flags?.pf2e?.origin;
    if (origin?.type !== "spell" || !message.actor) return null;
    const item = await fromUuid(origin.uuid ?? "").catch(() => null);
    const tradition = message.flags.pf2e.casting?.tradition ?? item?.spellcasting?.tradition ?? null;
    for (const journal of api.ongoing.records()) {
        const record = journal.getFlag(MODULE_ID, ONGOING_FLAG);
        if (record?.status !== "active" || !record.leech?.targets?.includes(message.actor.uuid) || tradition !== record.leech.tradition) continue;
        const card = game.messages.get(record.leech.messageId);
        const token = tokenOf(message.actor);
        if (card && token) return api.incarnatePhase(card, record.leech.partKey, { targets: [token] });
    }
    return null;
}

// ---- The mimic ----

export async function mimicPart({ ongoing, caster, spell, data, phase, token, options }) {
    const found = recordOf(ongoing, data.lastingCastId);
    if (!found) throw new Error(`${data.spellName}: the spell has ended.`);
    // (The spell the triggering creature cast: the GM's pick, else its latest spell card.)
    let triggering = options.spellUuid ? await fromUuid(options.spellUuid) : null;
    if (!triggering) {
        const recent = game.messages.contents.slice(-80).reverse().find(entry => entry.actor === token.actor && entry.flags?.pf2e?.origin?.type === "spell");
        triggering = recent ? await fromUuid(recent.flags.pf2e.origin.uuid).catch(() => null) : null;
    }
    if (triggering?.type !== "spell") throw new Error(`${data.spellName}: pick the spell ${token.name} cast.`);
    const casterTradition = spell.spellcasting?.tradition ?? null;
    const theirs = triggering.spellcasting?.tradition ?? null;
    if (phase.sameTradition && casterTradition && theirs && casterTradition !== theirs) throw new Error(`${data.spellName}: ${triggering.name} isn't of the ${casterTradition} tradition.`);
    const rank = Number(data.castRank), targetRank = Number(triggering.rank ?? triggering.system?.level?.value);
    if (targetRank > rank) throw new Error(`${data.spellName}: ${triggering.name} is above rank ${rank}.`);
    const statistic = spell.spellcasting?.statistic;
    const dc = Number(triggering.spellcasting?.statistic?.dc?.value ?? NaN);
    let degree = options.degree ?? null;
    if (!degree) { const roll = await statistic.check.roll({ dc: { value: dc }, item: spell, extraRollOptions: ["counteract"], skipDialog: true }); degree = DEGREES[Number(roll?.degreeOfSuccess ?? -1)]; }
    if (!degree) throw new Error(`${data.spellName}: the counteract check wasn't rolled.`);
    const success = counteracts(DEGREES.indexOf(degree), rank, targetRank);
    if (!success) { await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: the counteract check (${degree.replace(/([A-Z])/g, " $1").toLowerCase()}) fails against ${escapeHTML(triggering.name)} (rank ${targetRank}).</p>`); await ongoing.end(found.journal, { reason: "failed" }); return { degree, gained: false }; }
    // (The copy: one use, at this spell's rank, in the caster's own tradition — "without expending a slot".)
    const [entry] = await caster.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: ${triggering.name}`, type: "spellcastingEntry",
        flags: { [MODULE_ID]: { mimicCopy: { castId: data.lastingCastId } } },
        system: { tradition: { value: casterTradition ?? "arcane" }, prepared: { value: "innate" }, ability: { value: spell.spellcasting?.attribute ?? "cha" },
            spelldc: { dc: Number(statistic?.dc?.value ?? 10), value: Number(statistic?.check?.mod ?? 0) } } }]);
    const source = triggering.toObject(); delete source._id;
    source.system.location = { value: entry.id, heightenedLevel: rank, uses: { value: 1, max: 1 } };
    source.flags = { ...(source.flags ?? {}), [MODULE_ID]: { ...(source.flags?.[MODULE_ID] ?? {}), mimicCopy: { castId: data.lastingCastId } } };
    const [copy] = await caster.createEmbeddedDocuments("Item", [source]);
    await ongoing.attach(found.journal, copy); await ongoing.attach(found.journal, entry);
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(caster.name)} can cast <strong>${escapeHTML(triggering.name)}</strong> once, at rank ${rank}, by the end of its next turn (Sustain to keep it, up to ${phase.sustainMinutes} minute).</p>`);
    return { degree, gained: true, copyUuid: copy.uuid, entryUuid: entry.uuid };
}

// ---- The word of death ----

const deathMark = (actor, castId) => (actor?.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.deathMark?.castId === castId);
const deathImmune = (actor, key) => (actor?.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.deathImmunity?.key === key && effect.flags[MODULE_ID].deathImmunity.kind === "all");

export async function deathMarkPart({ ongoing, caster, spell, data, token, options }) {
    const found = recordOf(ongoing, data.lastingCastId);
    if (!found) throw new Error(`${data.spellName}: the spell has ended.`);
    const actor = token.actor;
    const key = spell.slug ?? spell.name;
    // "If you hit and the target is alive": the caster's Strike against it hit (its latest Strike), and it lives.
    const strike = options.hit != null ? null : findStrikeMessage({ casterUuid: caster.uuid, targetActorUuid: actor.uuid, targetTokenUuid: (token.document ?? token).uuid });
    const hit = options.hit ?? ["success", "criticalSuccess"].includes(strike?.flags?.pf2e?.context?.outcome);
    if (!hit) throw new Error(`${data.spellName}: ${caster.name}'s melee unarmed Strike hasn't hit ${token.name}.`);
    const traits = actor.traits ?? new Set(actor.system?.traits?.value ?? []);
    const has = trait => traits.has?.(trait) ?? traits.includes?.(trait);
    if (Number(actor.hitPoints?.value ?? 0) <= 0 || actor.statuses?.has?.("dead") || has("undead") || has("construct")) throw new Error(`${data.spellName}: ${token.name} isn't alive.`);
    if (deathImmune(actor, key)) noticeImmunity({ actor, token, blocked: data.spellName, why: "temporarily immune" });
    if (deathImmune(actor, key)) throw new Error(`${data.spellName}: ${token.name} is temporarily immune.`);
    const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: marked by ${caster.name}`, type: "effect", img: spell.img ?? "icons/svg/skull.svg",
        flags: { [MODULE_ID]: { deathMark: { castId: data.lastingCastId } } },
        system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true }, description: { value: `<p>${escapeHTML(caster.name)} can speak the word of death (a single action) for the spell's duration.</p>` } } }]);
    await ongoing.attach(found.journal, effect);
    return { marked: effect.uuid };
}

export async function wordPart({ ongoing, caster, spell, data, phase, token, options }) {
    const found = recordOf(ongoing, data.lastingCastId);
    if (!found) throw new Error(`${data.spellName}: the spell has ended.`);
    const actor = token.actor, key = spell.slug ?? spell.name;
    if (!deathMark(actor, data.lastingCastId)) throw new Error(`${data.spellName}: ${token.name} isn't marked by this casting.`);
    const dc = Number(spell.spellcasting?.statistic?.dc?.value ?? NaN), rank = Number(data.castRank);
    let degree = await rollSave(actor, phase.statistic, dc, spell, { degree: options.degree ?? null, traits: phase.traits });
    const immunity = async (kind, label) => actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: ${label}`, type: "effect", img: "icons/svg/aura.svg",
        flags: { [MODULE_ID]: { deathImmunity: { key, kind } } },
        system: { duration: { value: phase.immuneHours, unit: "hours", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
            description: { value: `<p>Temporarily immune ${kind === "all" ? "" : "to being killed by it "}for ${phase.immuneHours} hours.</p>` } } }]);
    // ("temporarily immune for 24 hours against being killed": a critical failure then deals the failure's result instead.)
    const killImmune = (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.deathImmunity?.key === key && effect.flags[MODULE_ID].deathImmunity.kind === "death");
    if (degree === "criticalFailure" && killImmune) { degree = "failure"; noticeImmunity({ actor, token, blocked: `${data.spellName}'s critical failure (death)`, why: "temporarily immune to being killed by it; the failure's result instead" }); }
    const hurt = async (row, perRank) => {
        const now = Number(actor.getCondition?.(row.slug)?.value ?? 0);
        if (now < row.value) await actor.increaseCondition(row.slug, { value: row.value - now });
        const roll = await new (DamageRollClass())(`${perRank * rank}`).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(data.spellName)}</strong>: the word of death` }).catch(() => null);
        return (await applyDamageWithReceipt(actor, { damage: roll, token: token.document ?? token, item: spell, rollOptions: new Set(), skipIWR: false }, foundry.utils.randomID())).damage;
    };
    const out = { degree };
    if (degree === "criticalSuccess") { await immunity("all", `immune for ${phase.immuneHours} hours`); await ongoing.end(found.journal, { reason: "critical-success" }); }
    else if (degree === "success") { out.damage = await hurt(phase.success, phase.success.perRank); await immunity("all", `immune for ${phase.immuneHours} hours`); await ongoing.end(found.journal, { reason: "success" }); }
    else if (degree === "failure") { out.damage = await hurt(phase.failure, phase.failure.perRank); if (!killImmune) await immunity("death", `immune to being killed for ${phase.failure.deathImmuneHours} hours`); }
    else {
        if (!actor.statuses?.has?.("dead")) await actor.toggleStatusEffect("dead", { active: true });
        for (const slug of ["dying", "unconscious"]) if (actor.hasCondition?.(slug)) await actor.decreaseCondition(slug, { forceRemove: true });
        out.died = true;
    }
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(token.name)}'s Fortitude save: ${degree.replace(/([A-Z])/g, " $1").toLowerCase()}${out.died ? " — it dies" : ""}.</p>`);
    return out;
}

// ---- The emblem ----

export async function emblemPart({ ongoing, caster, spell, data, phase, token }) {
    const found = recordOf(ongoing, data.lastingCastId);
    if (!found) throw new Error(`${data.spellName}: the spell has ended.`);
    const rank = Number(data.castRank), heightened = rank >= phase.heightened.minRank;
    const die = heightened ? phase.heightened.die : phase.die, critDie = heightened ? phase.heightened.critDie : phase.critDie;
    const slug = `${(spell.slug ?? "emblem")}-target`;
    const timed = { duration: { value: phase.rounds, unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null } };
    const made = [];
    // (On the target: attack rolls against it gain the status bonus — a status penalty to its AC.)
    const [mark] = await token.actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: emblem`, type: "effect", img: spell.img ?? "icons/svg/fire.svg",
        system: { slug, ...timed, tokenIcon: { show: true }, rules: [{ key: "FlatModifier", selector: "ac", type: "status", value: -phase.bonus, label: `${data.spellName}: attack rolls against it +${phase.bonus}` }],
            description: { value: `<p>Attack rolls against it gain a +${phase.bonus} status bonus; successful Strikes against it deal 1d${die} ${phase.type} damage (1d${critDie} persistent ${phase.type} on a critical hit).</p>` } } }]);
    made.push(mark);
    // (The strikers: the caster and its allies on the scene — their Strikes against the emblem's target deal the fire.)
    const strikers = new Set([caster, ...canvas.scene.tokens.map(entry => entry.actor).filter(actor => actor && actor !== token.actor && actor.alliance && actor.alliance === caster.alliance)]);
    for (const actor of strikers) {
        const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: Strikes against ${token.name}`, type: "effect", img: spell.img ?? "icons/svg/fire.svg",
            system: { ...timed, rules: [
                { key: "DamageDice", selector: "strike-damage", diceNumber: 1, dieSize: `d${die}`, damageType: phase.type, predicate: [`target:effect:${slug}`], label: data.spellName },
                { key: "DamageDice", selector: "strike-damage", diceNumber: 1, dieSize: `d${critDie}`, damageType: phase.type, category: "persistent", critical: true, predicate: [`target:effect:${slug}`], label: data.spellName }],
                description: { value: `<p>Strikes against the emblem's target deal 1d${die} ${phase.type} (1d${critDie} persistent ${phase.type} on a critical hit).</p>` } } }]);
        made.push(effect);
    }
    // (The caster: Off-Guard against enemies other than the target.)
    const [guard] = await caster.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: Off-Guard against other enemies`, type: "effect", img: "icons/svg/downgrade.svg",
        system: { ...timed, tokenIcon: { show: true }, rules: [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: -2, label: `Off-Guard (${data.spellName})`, predicate: [{ not: `origin:effect:${slug}` }] }],
            description: { value: `<p>@UUID[${phase.offGuard.uuid}]{Off-Guard} against enemies other than ${escapeHTML(token.name)}.</p>` } } }]);
    made.push(guard);
    for (const effect of made) await ongoing.attach(found.journal, effect);
    return { made: made.map(effect => effect.uuid) };
}
