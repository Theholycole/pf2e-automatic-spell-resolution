// The "+" features that counteract (docs/planning/third-party-features-audit.md, the spell-modifier triage), read from their texts — a card whose button counteracts on the
// creature the GM targets: one of its spell Effects (or illusion or light Effects, or listed conditions), chosen; the feature's modifier against the Effect's caster's DC; its rank
// against the Effect's (PF2e's counteract rule: affliction-care-core.js `counteracts`); the Effect ended on a success.
// - Dismiss Paltry Magic (Magic+): "You attempt to counteract a single spell of your choice active on the target. Your counteract rank is equal to the highest rank spell you can
//   cast, and your counteract check modifier is your spell attack roll modifier."
// - Oracle's Eyes (Oracles+): "Choose an effect with the illusion trait within 30 feet … Alternatively, … counteract one of the following conditions … Blinded, Dazzled, Fascinated, or
//   Invisible. … You use your spell attack roll modifier as your counteract modifier" (no rank stated: half the level, rounded up, as an ability's).
// - Snuff Out (Oracles+): a light Effect, "your spell attack modifier … and … a circumstance bonus … equal to your cursebound value"; or a creature with the light trait or under a
//   light effect: "(level)d6 void damage with a basic Fortitude save … temporarily immune for 1 minute".
// - Spell Pyrophore (Alchemists+): "counteract one active spell effect on the targeted creature with a +8 modifier … dealing 1d4 fire, 1d4 spirit … DC 19 basic Fortitude … The
//   counteract rank is equal to the half the item level rounded up."
import { counteracts } from "./affliction-care-core.js";
import { riderChoice, startShapeCard, highestCastableRank } from "./spellshape-runtime.js";
import { MODULE_ID, activeGM, escapeHTML, plainText } from "./runtime-utils.js";

import { noticeImmunity } from "./immunity-notice.js";
const CONDITION_LINK = /@UUID\[Compendium\.pf2e\.conditionitems\.(?:Item\.)?[A-Za-z0-9]+\]\{([A-Za-z]+)\}/g;

const FORMS = [
    [/You attempt to counteract a single spell of your choice active on the target\. Your counteract rank is equal to the highest rank spell you can cast, and your counteract check modifier is your spell attack roll modifier\./,
        () => ({ pick: ["spell-effect"], modifier: "spell-attack", rank: "highest" })],
    [/Choose an effect with the (illusion) trait within \d+ feet and attempt a counteract check against it .*Alternatively, you can target a creature, and attempt to counteract one of the following conditions affecting that creature: (.+?)\. .*You use your spell attack roll modifier as your counteract modifier/,
        m => ({ pick: [`trait:${m[1]}`], conditions: [...m[2].matchAll(CONDITION_LINK)].map(entry => entry[1].toLowerCase()), modifier: "spell-attack", rank: "half-level" })],
    [/You can immediately attempt to @Check\[counteract\|statistic:spell\] a (light) source within \d+ feet, automatically succeeding if the light source is non-magical\. You use your spell attack modifier for your counteract modifier and you gain a circumstance bonus to your check equal to your cursebound value\. You can choose to target a creature with the light trait or under a light effect instead of a light source, dealing @Damage\[\(@actor\.level\)d(\d+)\[([a-z]+)\]\] damage with a @Check\[(fortitude|reflex|will)\|basic\] save instead of the normal effects\. Creatures targeted by this effect are temporarily immune for (\d+) minutes?\./,
        m => ({ pick: [`trait:${m[1]}`], modifier: "spell-attack", bonus: "cursebound", rank: "half-level", alternative: { faces: Number(m[2]), type: m[3], statistic: m[4], immuneMinutes: Number(m[5]) } })],
    [/The dust automatically attempts to counteract one active spell effect on the targeted creature with a \+(\d+) modifier\. (If the creature is not under an active spell effect, the dust settles on the creature and stays in effect for \d+ minutes?, attempting to counteract the next spell effect the creature is subject to\.) When a spell effect is counteracted by the spell pyrophore, it burns the magic as part of the counteract, dealing @Damage\[((?:[^\[\]]|\[[^\]]*\])+)\] to the creature that was affected by the counteracted spell with a @Check\[(fortitude|reflex|will)\|dc:(\d+)\|basic\] save\./,
        m => ({ pick: ["spell-effect"], modifier: Number(m[1]), rank: "half-item-level", burn: { damage: m[3], statistic: m[4], dc: Number(m[5]) }, table: [m[2]] })]
];
export function readCounteractFeature(source) {
    const text = plainText(source?.system?.description?.value);
    for (const [pattern, build] of FORMS) { const m = pattern.exec(text); if (m) return { name: source.name, ...build(m) }; }
    return null;
}

/** A spell's Effect: PF2e marks it fromSpell, or its origin item is a spell. */
function isSpellEffect(effect) {
    if (effect.system?.fromSpell === true || effect.flags?.[MODULE_ID]?.runtime?.castInstanceId) return true;
    const origin = effect.system?.context?.origin?.item;
    return (origin ? fromUuidSync(origin) : null)?.type === "spell";
}
const hasLight = effect => (effect.system?.rules ?? []).some(rule => rule.key === "TokenLight") || (effect.system?.traits?.value ?? []).includes("light");

/** What can be counteracted on the creature: {label, document, dc, rank}. */
function candidates(actor, read) {
    const out = [];
    for (const effect of actor.itemTypes?.effect ?? []) {
        const traits = effect.system?.traits?.value ?? [];
        const fits = read.pick.some(kind => kind === "spell-effect" ? isSpellEffect(effect) : kind === "trait:light" ? hasLight(effect) : kind.startsWith("trait:") && traits.includes(kind.slice(6)));
        if (!fits) continue;
        const originActor = effect.system?.context?.origin?.actor ? fromUuidSync(effect.system.context.origin.actor) : null;
        const sourceActor = originActor ?? (effect.flags?.[MODULE_ID]?.runtime?.sourceActorUuid ? fromUuidSync(effect.flags[MODULE_ID].runtime.sourceActorUuid) : null);
        const dc = Number(sourceActor?.attributes?.classOrSpellDC?.value ?? sourceActor?.system?.attributes?.spellDC?.value ?? NaN);
        const rank = Number(effect.system?.level?.value ?? effect.flags?.[MODULE_ID]?.runtime?.castRank ?? NaN);
        out.push({ label: effect.name, document: effect, dc: Number.isFinite(dc) ? dc : null, rank: Number.isFinite(rank) ? rank : null });
    }
    for (const slug of read.conditions ?? []) {
        const condition = actor.getCondition?.(slug);
        if (!condition) continue;
        // (A condition from an Effect: that Effect's caster and rank; otherwise the GM's numbers.)
        const granter = condition.flags?.pf2e?.grantedBy?.id ? actor.items.get(condition.flags.pf2e.grantedBy.id) : null;
        // (Granted by an Effect already listed: that Effect is the one to counteract.)
        if (granter && out.some(entry => entry.document === granter)) continue;
        const originActor = granter?.system?.context?.origin?.actor ? fromUuidSync(granter.system.context.origin.actor) : null;
        const dc = Number(originActor?.attributes?.classOrSpellDC?.value ?? NaN), rank = Number(granter?.system?.level?.value ?? NaN);
        out.push({ label: condition.name, document: granter ?? condition, dc: Number.isFinite(dc) ? dc : null, rank: Number.isFinite(rank) ? rank : null, condition: true });
    }
    return out;
}

function modifierOf(actor, item, read) {
    if (typeof read.modifier === "number") return read.modifier;
    const attack = Number(actor.spellcasting?.regular?.[0]?.statistic?.check?.mod ?? actor.spellcasting?.regular?.[0]?.statistic?.mod ?? NaN);
    const bonus = read.bonus === "cursebound" ? Number(actor.getCondition?.("cursebound")?.value ?? 0) : 0;
    return (Number.isFinite(attack) ? attack : 0) + bonus;
}
function rankOf(actor, item, read) {
    if (read.rank === "highest") return highestCastableRank(actor) || Math.ceil(Number(actor.level ?? 1) / 2);
    if (read.rank === "half-item-level") return Math.ceil(Number(item.system?.level?.value ?? 1) / 2);
    return Math.ceil(Number(actor.level ?? 1) / 2);
}

/** The feature's card posted: its counteract card. */
export async function counteractFeatureOnCard(message) {
    if (!activeGM() || message?.flags?.pf2e?.context?.type || !["feat", "action", "consumable"].includes(message?.flags?.pf2e?.origin?.type)) return null;
    const item = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    const read = item ? readCounteractFeature(item.toObject()) : null;
    if (!read || !item.actor) return null;
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: item.actor }), flags: { [MODULE_ID]: { kind: "counteract-card", counteractFeature: { actorUuid: item.actor.uuid, itemUuid: item.uuid, read } } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(item.name)}</strong>: counteract (modifier ${modifierOf(item.actor, item, read) >= 0 ? "+" : ""}${modifierOf(item.actor, item, read)}, rank ${rankOf(item.actor, item, read)}).</p>`
            + `<button type="button" data-pf2e-auto-counteract="go">Counteract on the targeted creature</button>${read.alternative ? `<button type="button" data-pf2e-auto-counteract="alternative">${escapeHTML(`${read.alternative.type} damage to the targeted creature instead`)}</button>` : ""}</section>` });
}

/** The button: the targeted creature's candidates; the chosen one counteracted. */
export async function counteractFeature(message, { pickIndex = null, alternative = false } = {}) {
    const data = message.getFlag(MODULE_ID, "counteractFeature");
    const actor = await fromUuid(data?.actorUuid ?? "").catch(() => null), item = await fromUuid(data?.itemUuid ?? "").catch(() => null);
    const target = [...game.user.targets][0]?.actor ?? null;
    if (!actor || !data) throw new Error("This card's creature is gone.");
    if (!target) throw new Error("Target the creature first.");
    const read = data.read;
    const say = text => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${escapeHTML(item?.name ?? "Counteract")}</strong>: ${text}</p>` }).catch(() => null);
    if (alternative && read.alternative) {
        // (Snuff Out's creature: the void damage, basic save; then immune for a minute.)
        const alt = read.alternative;
        if ((target.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.counteractImmune === item?.name)) { noticeImmunity({ actor: target, blocked: item?.name ?? "Snuff Out", why: "temporarily immune" }); await say(`${escapeHTML(target.name)} is temporarily immune.`); return { refused: "immune" }; }
        const level = Number(actor.level ?? 1);
        const token = target.getActiveTokens?.(true, false)?.[0];
        const dc = Number(actor.spellcasting?.regular?.[0]?.statistic?.dc?.value ?? actor.attributes?.classOrSpellDC?.value ?? NaN);
        const card = token ? await startShapeCard({ caster: actor, name: item?.name ?? "Snuff Out", rank: Math.ceil(level / 2), statistic: alt.statistic, damage: { formula: `${level}d${alt.faces}`, type: alt.type }, targets: [token], dc,
            entryId: actor.spellcasting?.regular?.[0]?.id ?? null }).catch(error => ({ error: error.message })) : null;
        await target.createEmbeddedDocuments("Item", [{ name: `${item?.name}: temporarily immune`, type: "effect", img: item?.img ?? "icons/svg/aura.svg", flags: { [MODULE_ID]: { counteractImmune: item?.name } },
            system: { duration: { value: alt.immuneMinutes, unit: "minutes", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false } } }]);
        return { card: card?.error ?? !!card };
    }
    const list = candidates(target, read);
    if (!list.length) { await say(`${escapeHTML(target.name)} has nothing it can counteract.${read.table?.length ? ` ${escapeHTML(read.table.join(" "))} (the table's)` : ""}`); return { none: true }; }
    const index = pickIndex ?? Number(list.length === 1 ? 0 : await riderChoice({ name: item?.name ?? "Counteract", choice: null }, "Counteract which?", list.map((entry, i) => ({ value: String(i), label: entry.label }))) ?? 0);
    const chosen = list[index];
    let dc = chosen.dc, rank = chosen.rank;
    if (dc == null || rank == null) {
        const answer = await foundry.applications.api.DialogV2.prompt({ window: { title: `${item?.name}: ${chosen.label}` }, content: `<label>Its counteract DC <input type="number" name="dc" value="${dc ?? ""}"></label><label>Its counteract rank <input type="number" name="rank" value="${rank ?? ""}"></label>`,
            ok: { label: "Roll", callback: (_event, button) => ({ dc: Number(button.form.elements.dc.value), rank: Number(button.form.elements.rank.value) }) }, rejectClose: false });
        if (!answer) return null;
        ({ dc, rank } = answer);
    }
    const modifier = modifierOf(actor, item, read), counterRank = rankOf(actor, item, read);
    const roll = await new Roll(`1d20 + ${modifier}`).evaluate();
    const natural = roll.dice[0]?.total ?? 10;
    let degree = roll.total >= dc + 10 ? 3 : roll.total >= dc ? 2 : roll.total <= dc - 10 ? 0 : 1;
    degree = Math.max(0, Math.min(3, degree + (natural === 20 ? 1 : natural === 1 ? -1 : 0)));
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(item?.name)}</strong>: counteract ${escapeHTML(chosen.label)} (DC ${dc}, rank ${counterRank} against ${rank})` }).catch(() => null);
    const countered = counteracts(degree, counterRank, rank);
    if (countered) await chosen.document.delete({ [MODULE_ID]: { ongoingCleanup: true } }).catch(() => null);
    // (Spell Pyrophore: the counteracted magic burns the creature.)
    let burn = null;
    if (countered && read.burn) {
        const token = target.getActiveTokens?.(true, false)?.[0];
        const parts = [...read.burn.damage.matchAll(/(\d+d\d+)\[([a-z]+)\]/g)];
        if (token && parts.length) burn = await startShapeCard({ caster: actor, name: item?.name ?? "Spell Pyrophore", rank: rankOf(actor, item, read), statistic: read.burn.statistic,
            damage: { formula: parts[0][1], type: parts[0][2] }, targets: [token], dc: read.burn.dc, riders: parts.slice(1).map(part => ({ type: "extra-damage", formula: part[1], damageType: part[2] })),
            entryId: actor.spellcasting?.regular?.[0]?.id ?? null }).catch(error => ({ error: error.message }));
    }
    await say(`${escapeHTML(chosen.label)} on ${escapeHTML(target.name)}: ${["critical failure", "failure", "success", "critical success"][degree]} — ${countered ? "counteracted" : "not counteracted"}.`);
    return { countered, degree, chosen: chosen.label, burn: burn?.error ?? (burn ? true : null) };
}

export function bindCounteractButtons(message, html) {
    for (const button of html.querySelectorAll?.("[data-pf2e-auto-counteract]") ?? []) button.addEventListener("click", async () => {
        try { await counteractFeature(message, { alternative: button.dataset.pf2eAutoCounteract === "alternative" }); } catch (error) { ui.notifications.error(error.message); }
    });
}
