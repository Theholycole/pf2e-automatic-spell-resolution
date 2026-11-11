// The "+" modules' features that give or spare Focus Points (docs/planning/third-party-features-audit.md, focus-pool), read from their texts:
// - Golden Core (Tian Xia+): "whenever you Refocus, you recover 2 Focus Points instead of 1. At 18th level, … whenever you Refocus, completely refill your focus pool."
// - I Am Omnipotent! (Wizards+): Stupefied 1 until the end of the next turn; wizard focus spells cast meanwhile spend no Focus Point; then 10 minutes' immunity.
// - Bargain Soul (Witches): its Effect put on — "you can regain a spell slot at least one rank lower than your highest spell level, and you regain a 1 Focus Point".
// - Revitalizing Bun (Alchemists+): "After eating the bun, you feel revitalized for 1 hour. During this time, you can restore a Focus Point as a single action … After you restore a
//   Focus Point from this effect, you are temporarily immune to its effects for 1 day."
import { shapeEffect, riderChoice, refundSlot } from "./spellshape-runtime.js";
import { MODULE_ID, activeGM, escapeHTML, plainText, say } from "./runtime-utils.js";

import { noticeImmunity } from "./immunity-notice.js";
const STUPEFIED = "Compendium.pf2e.conditionitems.Item.e1XGnhKNSQIm5IXg";

const FORMS = [
    [/whenever you Refocus, you recover (\d+) Focus Points instead of 1\. At (\d+)(?:st|nd|rd|th) level, .*whenever you Refocus, completely refill your focus pool\./,
        m => ({ kind: "refocus-more", points: Number(m[1]), fullAt: Number(m[2]) })],
    [/^Requirements Your last action was to Cast a Spell, and you critically succeeded a spell attack roll against an enemy or a target critically failed a saving throw\. .*You become @UUID\[[^\]]+\]\{Stupefied (\d)\} until the end of your next turn\. As long as you are stupefied from this effect, you can cast (wizard) focus spells without expending a Focus Point (and without needing to roll a flat check from being stupefied)\. After you lose the stupefied condition from this effect, you are temporarily immune to this effect for (\d+) minutes\.$/,
        m => ({ kind: "free-focus", stupefied: Number(m[1]), trait: m[2], table: [`Casting them ${m[3].replace(/^and /, "")}.`], immuneMinutes: Number(m[4]) })],
    [/In exchange, you can regain a spell slot at least one rank lower than your highest spell level, and you regain a 1 Focus Point\. .*@UUID\[([^\]]+)\]\{(Effect: [^}]+)\}$/,
        m => ({ kind: "bargain", effect: { uuid: m[1], name: m[2] }, focus: 1, below: 1 })],
    [/After eating the bun, you feel revitalized for (\d+) hours?\. During this time, you can restore a Focus Point as a single action with the concentrate trait\. After you restore a Focus Point from this effect, you are temporarily immune to its effects for (\d+) days?\. The bun has no effect if you do not have a Focus Pool\./,
        m => ({ kind: "bun", hours: Number(m[1]), immuneDays: Number(m[2]) })]
];
export function readFocusFeature(source) {
    const text = plainText(source?.system?.description?.value);
    for (const [pattern, build] of FORMS) { const m = pattern.exec(text); if (m) return { name: source.name, ...build(m) }; }
    return null;
}
const featureOf = (actor, kind) => [...(actor?.itemTypes?.feat ?? []), ...(actor?.itemTypes?.consumable ?? [])].map(item => ({ item, read: readFocusFeature(item.toObject()) })).find(entry => entry.read?.kind === kind) ?? null;
const pool = actor => actor?.system?.resources?.focus ?? null;
async function gainFocus(actor, amount) {
    const focus = pool(actor);
    if (!focus || !(Number(focus.max) > 0)) return 0;
    const value = Math.min(Number(focus.max), Number(focus.value) + amount);
    await actor.update({ "system.resources.focus.value": value });
    return value - Number(focus.value);
}

/** Golden Core: the Refocus card restores 2 Focus Points (the whole pool from 18th level). */
export async function refocusMoreOnCard(message) {
    if (!activeGM() || message?.item?.slug !== "refocus") return null;
    const actor = message.actor;
    const found = featureOf(actor, "refocus-more");
    if (!found) return null;
    const full = Number(actor.level ?? 1) >= found.read.fullAt;
    const gained = await gainFocus(actor, full ? 99 : found.read.points);
    await say(actor, `<strong>${escapeHTML(found.item.name)}</strong>: Refocus restores ${full ? "the whole focus pool" : `${found.read.points} Focus Points`} (${gained} regained).`);
    return { gained, full };
}

/** I Am Omnipotent!'s card: its requirement (the caster's last spell card: a critical hit, or a critical failure on a save), then Stupefied 1 to the end of the next turn. */
export async function freeFocusOnCard(message) {
    if (!activeGM() || message?.flags?.pf2e?.context?.type || !["feat", "action"].includes(message?.flags?.pf2e?.origin?.type)) return null;
    const item = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    const read = item ? readFocusFeature(item.toObject()) : null;
    const actor = item?.actor;
    if (read?.kind !== "free-focus" || !actor) return null;
    if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.freeFocusImmune === item.name)) { noticeImmunity({ actor, blocked: item.name, why: "temporarily immune" }); await say(actor, `<strong>${escapeHTML(item.name)}</strong>: ${escapeHTML(actor.name)} is temporarily immune.`); return { refused: "immune" }; }
    const card = game.messages.contents.slice(-30).reverse().find(entry => entry.getFlag(MODULE_ID, "basicSaveState")?.sourceActorUuid === actor.uuid);
    const state = card?.getFlag(MODULE_ID, "basicSaveState");
    const attack = state?.saveStatistic === "spell-attack";
    const met = (state?.targets ?? []).some(target => target.degree === (attack ? "criticalSuccess" : "criticalFailure"));
    if (!met) { await say(actor, `<strong>${escapeHTML(item.name)}</strong>: the last spell had no critical hit or critically failed save.`); return { refused: "requirement" }; }
    const made = await shapeEffect(actor, actor, `${item.name}: stupefied`, [{ key: "GrantItem", uuid: STUPEFIED, onDeleteActions: { grantee: "cascade" }, alterations: [{ mode: "override", property: "badge-value", value: read.stupefied }] }],
        { until: "caster-next-turn-end", rounds: 1, flags: { freeFocus: { name: item.name, trait: read.trait, immuneMinutes: read.immuneMinutes } },
            description: `${read.trait[0].toUpperCase()}${read.trait.slice(1)} focus spells spend no Focus Point while this lasts. ${read.table.join(" ")} (the table's)` });
    return { effect: made?.uuid ?? null };
}

/** A wizard focus spell cast under I Am Omnipotent!: its Focus Point given back. */
export async function freeFocusOnCast(message) {
    if (!activeGM() || !message?.flags?.pf2e?.casting) return null;
    const actor = message.actor, spell = message.item;
    const effect = (actor?.itemTypes?.effect ?? []).find(entry => entry.flags?.[MODULE_ID]?.freeFocus);
    const traits = spell?.system?.traits?.value ?? [];
    if (!effect || !traits.includes("focus") || !traits.includes(effect.flags[MODULE_ID].freeFocus.trait)) return null;
    await new Promise(resolve => setTimeout(resolve, 400));
    const gained = await gainFocus(actor, 1);
    await say(actor, `<strong>${escapeHTML(effect.flags[MODULE_ID].freeFocus.name)}</strong>: ${escapeHTML(spell.name)} spends no Focus Point.`);
    return { gained };
}

/** I Am Omnipotent!'s stupefaction gone: immune for 10 minutes. */
export async function freeFocusEnded(item) {
    const data = item?.flags?.[MODULE_ID]?.freeFocus;
    if (!activeGM() || item.type !== "effect" || !data || !item.actor) return null;
    return item.actor.createEmbeddedDocuments("Item", [{ name: `${data.name}: temporarily immune`, type: "effect", img: item.img,
        flags: { [MODULE_ID]: { freeFocusImmune: data.name } },
        system: { duration: { value: data.immuneMinutes, unit: "minutes", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false } } }]);
}

/** Bargain Soul's Effect put on: a Focus Point, and a spell slot at least one rank below the highest (asked among the spent ones). */
export async function bargainOnCreate(item) {
    if (!activeGM() || item?.type !== "effect" || !item.actor) return null;
    const found = featureOf(item.actor, "bargain");
    if (!found || item.name !== found.read.effect.name) return null;
    const actor = item.actor;
    const gained = await gainFocus(actor, found.read.focus);
    const entries = (actor.spellcasting?.regular ?? []).filter(entry => entry.isPrepared || entry.isSpontaneous);
    const highest = Math.max(0, ...entries.flatMap(entry => Object.entries(entry.system?.slots ?? {}).filter(([, slot]) => Number(slot.max) > 0).map(([key]) => Number(key.slice(4)))));
    const spent = [];
    for (const entry of entries) for (const [key, slot] of Object.entries(entry.system?.slots ?? {})) {
        const rank = Number(key.slice(4));
        if (!(rank >= 1 && rank <= highest - found.read.below)) continue;
        if (entry.isPrepared) (slot.prepared ?? []).forEach((prepared, index) => { if (prepared.expended && prepared.id) spent.push({ entry, rank, spell: actor.items.get(prepared.id), label: `${actor.items.get(prepared.id)?.name ?? "a spell"} (rank ${rank}, ${entry.name})` }); });
        else if (Number(slot.value) < Number(slot.max)) spent.push({ entry, rank, spell: null, label: `a rank-${rank} slot (${entry.name})` });
    }
    let slotLabel = "no spent slot to regain";
    if (spent.length) {
        const picked = await riderChoice({ name: found.item.name, choice: actor.getFlag(MODULE_ID, "passiveChoices")?.[found.item.name] ?? null }, "Regain which spell slot?", spent.map((entry, index) => ({ value: String(index), label: entry.label }))) ?? String(spent.length - 1);
        const entry = spent[Number(picked)] ?? spent.at(-1);
        if (entry.spell) await refundSlot(actor, entry.spell, entry.rank, found.item.name);
        else await entry.entry.update({ [`system.slots.slot${entry.rank}.value`]: Number(entry.entry.system.slots[`slot${entry.rank}`].value) + 1 });
        slotLabel = `${entry.label} regained`;
    }
    await say(actor, `<strong>${escapeHTML(found.item.name)}</strong>: ${gained} Focus Point regained; ${escapeHTML(slotLabel)}.`);
    return { gained, slot: slotLabel };
}

/** The bun eaten: revitalized for an hour, its button restoring a Focus Point once (then a day's immunity). */
export async function bunOnCard(message) {
    if (!activeGM() || message?.flags?.pf2e?.context?.type || message?.flags?.pf2e?.origin?.type !== "consumable") return null;
    const item = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    const read = item ? readFocusFeature(item.toObject()) : null;
    const actor = item?.actor;
    if (read?.kind !== "bun" || !actor) return null;
    if (!(Number(pool(actor)?.max) > 0)) { await say(actor, `<strong>${escapeHTML(item.name)}</strong>: no effect without a focus pool.`); return { refused: "no pool" }; }
    if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.bunImmune === item.name)) { noticeImmunity({ actor, blocked: item.name, why: "temporarily immune" }); await say(actor, `<strong>${escapeHTML(item.name)}</strong>: ${escapeHTML(actor.name)} is temporarily immune.`); return { refused: "immune" }; }
    const made = await shapeEffect(actor, actor, `${item.name}: revitalized`, [], { rounds: read.hours * 600, flags: { bunRevitalized: { name: item.name, immuneDays: read.immuneDays } }, description: "Restore a Focus Point as a single action (concentrate), once." });
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), flags: { [MODULE_ID]: { kind: "focus-card", bun: { actorUuid: actor.uuid, effectUuid: made?.uuid ?? null } } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(item.name)}</strong>: revitalized for ${read.hours} hour${read.hours === 1 ? "" : "s"}.</p><button type="button" data-pf2e-auto-focus-card="bun">Restore a Focus Point (1 action)</button></section>` });
    return { effect: made?.uuid ?? null };
}

export async function bunRestore(message) {
    const data = message.getFlag(MODULE_ID, "bun");
    const actor = await fromUuid(data?.actorUuid ?? "").catch(() => null);
    const effect = data?.effectUuid ? await fromUuid(data.effectUuid).catch(() => null) : null;
    if (!actor || !effect) throw new Error("No longer revitalized.");
    const { name, immuneDays } = effect.flags[MODULE_ID].bunRevitalized;
    const gained = await gainFocus(actor, 1);
    await effect.delete();
    await actor.createEmbeddedDocuments("Item", [{ name: `${name}: temporarily immune`, type: "effect", img: effect.img, flags: { [MODULE_ID]: { bunImmune: name } },
        system: { duration: { value: immuneDays, unit: "days", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false } } }]);
    await say(actor, `<strong>${escapeHTML(name)}</strong>: ${gained} Focus Point restored.`);
    return { gained };
}

export function bindFocusButtons(message, html) {
    for (const button of html.querySelectorAll?.("[data-pf2e-auto-focus-card]") ?? []) button.addEventListener("click", async () => {
        try { if (button.dataset.pf2eAutoFocusCard === "bun") await bunRestore(message); } catch (error) { ui.notifications.error(error.message); }
    });
}
