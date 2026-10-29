// Items that cast an official spell with numbers of their own (src/compiler/item-casts.js), at the table (the spell features audit, batch F5,
// 2026-10-05): the spellhearts, and the weapons and charms that cast one spell; and the Spell Reservoir rune, which stores a spell and releases it on a
// hit with the item's DC.
//   - The item's card offers its casts. A cast goes through PF2e like any other — the module's cards, spellshapes and riders all follow it — from an
//     innate entry of the item's own, its DC and attack the item's: an NPC's entry states them (PF2e's spelldc); a character's is pinned by a PF2e
//     SpecialStatistic the entry is proficient with, calibrated to the item's number as each cast is made.
//   - After the cast, the spellheart's benefit where it's affixed (armor, weapon), when the spell qualifies: PF2e's Effect (its grade and weapon
//     picked), else one from the text (extra dice on the weapon's Strikes, Concealed), else a note Effect for the duration.
import { readItemCasts } from "../src/compiler/item-casts.js";
import { loadNativeEffectTemplate, prepareNativeEffectSource, createNativeEffect } from "./native-outcome-effects.js";
import { shapeEffect, timedConditions } from "./spellshape-runtime.js";
import { loseSpell } from "./casting-rules-runtime.js";
import { MODULE_ID, activeGM, escapeHTML, gmIds, isCastMessage, ownerIds, randomID } from "./runtime-utils.js";
import { changedSpellSource, itemSpellChanges } from "./item-spell-changes.js";
export { changedSpellSource, itemSpellChanges } from "./item-spell-changes.js";
import { rememberCastSpell } from "./cast-spell.js";

const unlink = text => String(text ?? "").replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, "$1").replace(/@(?:Damage|Check|Template)\[([^\]]+)\](?:\{([^}]+)\})?/g, (all, inner, label) => label ?? inner.split("|")[0]);

/** The cast's rank: stated, else the spell's own — a cantrip at half the item's level. */
function castRank(read, cast, spellSource) {
    if (cast.rank) return cast.rank;
    return (spellSource.system?.traits?.value ?? []).includes("cantrip") ? read.cantripRank : Number(spellSource.system?.level?.value ?? 1);
}

/** The item's numbers for this cast: { attack, dc } — the wielder's Strike with the item when the text says so. */
function itemNumbers(actor, item, read) {
    let { attack, dc } = read.numbers;
    if (attack === "strike") {
        const strike = (actor.system?.actions ?? []).find(action => action.item?.id === item.id || action.item?.id === item.parentItem?.id);
        attack = Number.isFinite(Number(strike?.totalModifier)) ? Number(strike.totalModifier) : null;
    }
    if (attack == null && dc != null) attack = dc - 10;
    if (dc == null && attack != null) dc = attack + 10;
    return { attack, dc };
}

/** The item's innate entry on the actor, its DC and attack the item's. */
async function itemEntry(actor, item, tradition, numbers, autoHeighten) {
    const flag = entry => entry.flags?.[MODULE_ID]?.itemCastEntry?.itemUuid === item.uuid;
    let entry = (actor.itemTypes?.spellcastingEntry ?? []).find(flag);
    const slug = `item-cast-${item.id}`.toLowerCase();
    if (!entry) {
        const system = { tradition: { value: tradition }, prepared: { value: "innate" }, autoHeightenLevel: { value: autoHeighten } };
        if (actor.type === "npc") system.spelldc = { dc: numbers.dc ?? 10, value: numbers.attack ?? 0 };
        else system.proficiency = { slug, value: 0 };
        [entry] = await actor.createEmbeddedDocuments("Item", [{ name: `${item.name} (item spells)`, type: "spellcastingEntry", system, flags: { [MODULE_ID]: { itemCastEntry: { itemUuid: item.uuid } } } }]);
    }
    if (actor.type === "npc") {
        if (numbers.dc != null && (Number(entry.system.spelldc?.dc) !== numbers.dc || Number(entry.system.spelldc?.value) !== numbers.attack))
            await entry.update({ "system.spelldc.dc": numbers.dc, "system.spelldc.value": numbers.attack });
        return actor.items.get(entry.id);
    }
    // (A character's entry: proficient with the item's own statistic; its modifier set so the entry's attack is the item's.)
    let stat = (actor.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.itemCastStat === item.uuid);
    if (!stat) [stat] = await actor.createEmbeddedDocuments("Item", [{ name: `${item.name}: its spells' numbers`, type: "effect", img: item.img ?? "icons/svg/book.svg",
        flags: { [MODULE_ID]: { itemCastStat: item.uuid } },
        system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false },
            rules: [{ key: "SpecialStatistic", slug, label: item.name, type: "attack-roll", itemCasting: { tradition } }, { key: "FlatModifier", selector: slug, value: 0, label: item.name }] } }]);
    if (numbers.attack != null) {
        const current = Number(actor.items.get(entry.id)?.statistic?.check?.mod ?? NaN);
        const rules = foundry.utils.deepClone(stat.system.rules);
        const flat = rules.find(rule => rule.key === "FlatModifier");
        if (Number.isFinite(current) && current !== numbers.attack) {
            flat.value = Number(flat.value) + numbers.attack - current;
            await stat.update({ "system.rules": rules });
        }
    }
    return actor.items.get(entry.id);
}

/** The spell on the item's entry at the rank (made from PF2e's compendium the first time, or from the source given — `uuid` then only its key). */
async function entrySpell(actor, entry, uuid, rank, cantrip, given = null) {
    const existing = (actor.itemTypes?.spell ?? []).find(spell => spell.system?.location?.value === entry.id && spell.flags?.[MODULE_ID]?.itemCastSpell === uuid
        && (cantrip || Number(spell.system.location.heightenedLevel ?? 0) === rank));
    if (existing) return existing;
    const source = given ? foundry.utils.deepClone(given) : (await fromUuid(uuid))?.toObject();
    if (!source) throw new Error(`The item's spell (${uuid}) isn't in PF2e's compendium.`);
    delete source._id;
    source.system.location = { value: entry.id, ...(cantrip ? {} : { heightenedLevel: rank }) };
    foundry.utils.setProperty(source, `flags.${MODULE_ID}.itemCastSpell`, uuid);
    const [made] = await actor.createEmbeddedDocuments("Item", [source]);
    return made;
}

/** The item's card: a button for each spell it casts, its rank and numbers. */
export async function offerItemCasts(item, { whisper = true } = {}) {
    const read = item ? readItemCasts(item.toObject()) : null;
    const actor = item?.actor;
    if (!read || !actor) return null;
    const numbers = itemNumbers(actor, item, read);
    const stats = [numbers.dc != null ? `DC ${numbers.dc}` : null, numbers.attack != null ? `attack +${numbers.attack}` : null].filter(Boolean).join(", ");
    const buttons = read.casts.map((cast, index) => `<button type="button" data-pf2e-auto-item-cast="${index}">${escapeHTML(`Cast ${cast.name}${cast.rank ? ` (${cast.rank}${["st", "nd", "rd"][cast.rank - 1] ?? "th"} rank)` : ""}${cast.frequency ? ` — ${cast.frequency}` : ""}`)}</button>`).join("");
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), ...(whisper ? { whisper: [...new Set([...gmIds(), ...ownerIds(actor)])] } : {}),
        flags: { [MODULE_ID]: { kind: "item-cast-card", itemCast: { itemUuid: item.uuid, actorUuid: actor.uuid } } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(item.name)}</strong>: its spells${stats ? ` (${escapeHTML(stats)})` : ""}. Target the creatures first.</p>${buttons}</section>` });
}

/** Where a spellheart is affixed: "armor", "melee weapon" / "ranged weapon" (and "weapon"), or null — and the host item. */
function affixedTo(item) {
    const host = item.parentItem ?? null;
    if (!host) return { host: null, places: [] };
    if (host.type === "armor" || host.type === "shield") return { host, places: ["armor"] };
    if (host.type === "weapon") return { host, places: ["weapon", host.isRanged ? "ranged weapon" : "melee weapon"] };
    return { host, places: [] };
}

/** An item's spell cast: through PF2e, from the item's entry; then its benefit where it's affixed. Returns { message, benefits }. */
export async function castFromItem(item, index = 0, { host: hostOverride = null } = {}) {
    const read = readItemCasts(item.toObject());
    const actor = item.actor;
    const cast = read?.casts?.[index];
    if (!cast || !actor) throw new Error(`${item?.name ?? "The item"} casts no such spell.`);
    const spellSource = (await fromUuid(cast.uuid))?.toObject();
    if (!spellSource) throw new Error(`${cast.name} isn't in PF2e's compendium.`);
    const cantrip = (spellSource.system?.traits?.value ?? []).includes("cantrip");
    const rank = castRank(read, cast, spellSource);
    const tradition = cast.tradition ?? (spellSource.system?.traits?.traditions ?? [])[0] ?? "arcane";
    const numbers = itemNumbers(actor, item, read);
    const entry = await itemEntry(actor, item, tradition, numbers, read.cantripRank);
    const spell = await entrySpell(actor, entry, cast.uuid, rank, cantrip);
    const mark = game.messages.size;
    await entry.cast(spell, { rank, consume: false });
    let message = null;
    for (let i = 0; i < 40 && !message; i++) { message = game.messages.contents.slice(mark).find(entry => isCastMessage(entry) && entry.actor === actor); if (!message) await new Promise(resolve => setTimeout(resolve, 250)); }
    const notes = [];
    if (cast.note) notes.push(`${item.name}: ${unlink(cast.note)}.`);
    if (cast.casterImmune) notes.push(`${item.name}: ${actor.name} is immune to the ${cast.name}'s effect, though allies are not.`);
    if (cast.centeredOn) notes.push(`${item.name}: the ${cast.name} is centered on the ${cast.centeredOn}.`);
    if (notes.length) try { await ChatMessage.create({ whisper: gmIds(), content: notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note)} (GM)</p>`).join("") }); } catch (_) {}
    const benefits = await afterCast(actor, item, read, spell, message, hostOverride);
    // (Geojibom's Guidance: the caster's light after the cast, and its detection.)
    if (cast.selfLight) {
        const made = await shapeEffect(actor, actor, `${item.name}: light`, [{ key: "TokenLight", value: { bright: cast.selfLight.bright, dim: cast.selfLight.dim } }], { rounds: cast.selfLight.minutes * 10 });
        await made?.update({ "system.description.value": `<p>${escapeHTML(cast.selfLight.text)}</p>` });
        benefits.push({ label: `${item.name}: bright light ${cast.selfLight.bright} feet, dim ${cast.selfLight.dim} feet`, effectUuid: made?.uuid ?? null });
    }
    return { message, benefits, rank, numbers };
}

/** "After you cast a cold spell by activating the crystal, …": the benefit where the spellheart is affixed, when the spell qualifies. */
async function afterCast(actor, item, read, spell, message, hostOverride) {
    const { host, places } = hostOverride ? { host: hostOverride, places: hostOverride.type === "weapon" ? ["weapon", hostOverride.isRanged ? "ranged weapon" : "melee weapon"] : ["armor"] } : affixedTo(item);
    const traits = spell?.system?.traits?.value ?? [];
    const results = [];
    for (const benefit of read.after ?? []) {
        if (!places.includes(benefit.where)) continue;
        const when = benefit.when ?? {};
        if (when.nonCantrip && traits.includes("cantrip")) continue;
        if (when.anyTraits && !when.anyTraits.some(trait => traits.includes(trait))) continue;
        if (benefit.effect) {
            const template = await loadNativeEffectTemplate(benefit.effect);
            if (!template) continue;
            const source = prepareNativeEffectSource(template, { castInstanceId: message?.id ?? null, castRank: Number(message?.flags?.pf2e?.origin?.castRank ?? 1), sourceActorUuid: actor.uuid,
                sourceItemUuid: item.uuid, sourceItemName: item.name, resolutionKind: "save", targetActorUuid: actor.uuid });
            // (PF2e's choices: the spellheart's grade — the choice predicated on its slug — and the weapon it's affixed to.)
            for (const rule of source.system?.rules ?? []) {
                if (rule.key !== "ChoiceSet") continue;
                if (Array.isArray(rule.choices)) {
                    const grade = rule.choices.find(choice => JSON.stringify(choice.predicate ?? []).includes(`parent:origin:item:slug:${item.slug}"`));
                    if (grade) rule.selection = grade.value;
                } else if ((rule.choices?.types ?? []).includes("weapon") && host?.type === "weapon") {
                    rule.selection = host.id;
                }
            }
            const made = await createNativeEffect(actor, source);
            results.push({ label: `${item.name}: ${template.name}`, effectUuid: made?.uuid ?? null });
        } else if (benefit.built?.type === "strike-dice" && host?.type === "weapon") {
            const made = await shapeEffect(actor, actor, `${item.name}: +${benefit.built.diceNumber}${benefit.built.dieSize} ${benefit.built.damageType} on ${host.name}`,
                [{ key: "DamageDice", selector: `${host.id}-damage`, diceNumber: benefit.built.diceNumber, dieSize: benefit.built.dieSize, damageType: benefit.built.damageType }], { rounds: 1, until: benefit.built.until });
            results.push({ label: `${item.name}: ${host.name}'s Strikes +${benefit.built.diceNumber}${benefit.built.dieSize} ${benefit.built.damageType}`, effectUuid: made?.uuid ?? null });
        } else if (benefit.built?.type === "conditions") {
            const made = await timedConditions(actor, benefit.built.list, item.name, { caster: actor });
            results.push(...made.map(entry => ({ label: entry.label, effectUuid: entry.effectUuid ?? null })));
        } else {
            // (The rest — "your next Strike causes the target to be Deafened …": a note Effect for its duration, the GM's to apply.)
            const made = await shapeEffect(actor, actor, `${item.name} (${benefit.where})`, [], { rounds: 1, until: "caster-next-turn-end" });
            await made?.update({ "system.description.value": `<p>${escapeHTML(unlink(benefit.text))}</p>` });
            results.push({ label: `${item.name}: note — ${unlink(benefit.text).slice(0, 80)}`, effectUuid: made?.uuid ?? null, note: true });
        }
    }
    return results;
}

/** An item's card posted: its casts offered (a spellheart, a weapon or charm that casts). */
export async function itemCastOnCard(message) {
    const origin = message?.flags?.pf2e?.origin;
    if (!activeGM() || !["equipment", "weapon", "armor", "shield", "consumable"].includes(origin?.type) || message.flags?.[MODULE_ID]) return null;
    const item = await fromUuid(origin.uuid ?? "").catch(() => null);
    if (!item?.actor || !readItemCasts(item.toObject())) return null;
    return offerItemCasts(item);
}

export async function runItemCastButton(message, button) {
    const data = message.flags?.[MODULE_ID]?.itemCast;
    const item = data ? await fromUuid(data.itemUuid).catch(() => null) : null;
    if (!item) throw new Error("The item is gone.");
    return castFromItem(item, Number(button?.dataset?.pf2eAutoItemCast ?? 0));
}

export function bindItemCastButtons(message, html) {
    const root = html instanceof HTMLElement ? html : html?.[0];
    for (const button of root?.querySelectorAll?.("[data-pf2e-auto-item-cast]") ?? []) button.addEventListener("click", async () => {
        try { await runItemCastButton(message, button); } catch (error) { ui.notifications.error(error.message); }
    });
    for (const button of root?.querySelectorAll?.("[data-pf2e-auto-reservoir]") ?? []) button.addEventListener("click", async () => {
        try { await runReservoirButton(message, button.dataset.pf2eAutoReservoir); } catch (error) { ui.notifications.error(error.message); }
    });
}

// Spell Reservoir: "A spellcaster can spend 1 minute to cast a spell of 3rd rank or lower into the weapon. The spell must require 2 actions or fewer to
// cast and must be able to target a creature other than the caster. … Make a Strike with the weapon. … If the Strike hits, the spell targets the target
// of the attack. If the spell requires a spell attack roll, the result of your attack roll with the weapon determines the degree of success of the
// spell, and if the spell requires a saving throw, the DC is 30."
const RESERVOIR = { maxRank: 3, maxActions: 2, dc: 30 };
/** The actor's Spell Reservoir runes, with the weapon each is etched onto. */
function reservoirs(actor) {
    const found = [];
    for (const weapon of actor?.itemTypes?.weapon ?? []) for (const sub of weapon.subitems ?? []) if (sub.slug === "spell-reservoir") found.push({ rune: sub, weapon });
    return found;
}
const stored = (actor, weapon) => actor.getFlag(MODULE_ID, `spellReservoir.${weapon.id}`) ?? null;

/** A spell cast by a creature with an empty Spell Reservoir weapon, when it fits: the card to store it. */
export async function reservoirOnCast(message) {
    if (!activeGM() || !isCastMessage(message)) return null;
    const actor = message.actor, spell = message.item;
    const empty = reservoirs(actor).filter(entry => !stored(actor, entry.weapon));
    if (!empty.length || !spell) return null;
    const rank = Number(message.flags?.pf2e?.origin?.castRank ?? spell.rank ?? 1);
    const actions = Number(String(spell.system?.time?.value ?? "").replace(/[^0-9]/g, "")) || null;
    const targets = String(spell.system?.target?.value ?? "");
    if (rank > RESERVOIR.maxRank || !actions || actions > RESERVOIR.maxActions || !targets || /^you$/i.test(targets.trim())) return null;
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: [...new Set([...gmIds(), ...ownerIds(actor)])],
        flags: { [MODULE_ID]: { kind: "item-cast-card", reservoir: { actorUuid: actor.uuid, castId: message.id, weaponId: empty[0].weapon.id, spell: { source: spell.toObject(), rank, name: spell.name } } } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>Spell Reservoir</strong>: cast ${escapeHTML(spell.name)} (rank ${rank}) into ${escapeHTML(empty[0].weapon.name)} instead — it has no effect now.</p><button type="button" data-pf2e-auto-reservoir="store">Store it in the weapon</button></section>` });
}

/** A Strike with a Spell Reservoir weapon that hits, with a spell stored: the card to release it at the target. */
export async function reservoirOnStrike(message) {
    const context = message?.flags?.pf2e?.context;
    if (!activeGM() || context?.type !== "attack-roll" || !["success", "criticalSuccess"].includes(context.outcome)) return null;
    const actor = message.actor;
    const itemId = message.item?.id ?? null;
    const entry = reservoirs(actor).find(found => found.weapon.id === itemId && stored(actor, found.weapon));
    if (!entry) return null;
    const data = stored(actor, entry.weapon);
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: [...new Set([...gmIds(), ...ownerIds(actor)])],
        flags: { [MODULE_ID]: { kind: "item-cast-card", reservoir: { actorUuid: actor.uuid, weaponId: entry.weapon.id, targetUuid: context.target?.token ?? null, degree: context.outcome, release: true } } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>Spell Reservoir</strong> (Channeled Release): ${escapeHTML(data.name)} at the creature hit — saves against DC ${RESERVOIR.dc}${data.attack ? `; the Strike's ${escapeHTML(context.outcome)} is the spell attack's result` : ""}.</p><button type="button" data-pf2e-auto-reservoir="release">Release ${escapeHTML(data.name)}</button></section>` });
}

/** The reservoir's buttons: store the cast spell (it's lost now), or release the stored spell at the Strike's target. */
export async function runReservoirButton(message, action) {
    const data = message.flags?.[MODULE_ID]?.reservoir;
    const actor = data ? await fromUuid(data.actorUuid).catch(() => null) : null;
    const weapon = actor?.items.get(data?.weaponId ?? "");
    if (!actor || !weapon) throw new Error("The Spell Reservoir weapon is gone.");
    if (action === "store") {
        if (stored(actor, weapon)) throw new Error(`${weapon.name} already holds a spell.`);
        const attack = (data.spell.source.system?.traits?.value ?? []).includes("attack") || data.spell.source.system?.defense?.passive?.statistic === "ac";
        await actor.setFlag(MODULE_ID, `spellReservoir.${weapon.id}`, { ...data.spell, attack });
        const cast = game.messages.get(data.castId);
        if (cast) await loseSpell(cast, `cast into ${weapon.name}'s Spell Reservoir`);
        return { stored: data.spell.name };
    }
    if (action === "release") {
        const held = stored(actor, weapon);
        if (!held) throw new Error(`${weapon.name} holds no spell.`);
        const target = data.targetUuid ? await fromUuid(data.targetUuid).catch(() => null) : null;
        target?.object?.setTarget(true, { releaseOthers: true });
        // (The rune's spells: an entry of its own, DC 30.)
        const rune = reservoirs(actor).find(found => found.weapon.id === weapon.id)?.rune ?? weapon;
        const entry = await itemEntry(actor, rune, (held.source.system?.traits?.traditions ?? [])[0] ?? "arcane", { dc: RESERVOIR.dc, attack: RESERVOIR.dc - 10 }, held.rank);
        const source = foundry.utils.deepClone(held.source);
        delete source._id;
        source.system.location = { value: entry.id, heightenedLevel: held.rank };
        const [spell] = await actor.createEmbeddedDocuments("Item", [source]);
        await actor.unsetFlag(MODULE_ID, `spellReservoir.${weapon.id}`);
        await entry.cast(spell, { rank: held.rank, consume: false });
        if (held.attack) try { await ChatMessage.create({ whisper: gmIds(), content: `<p class="pf2e-auto-gm-reminder"><strong>Spell Reservoir</strong> (GM): ${escapeHTML(held.name)}'s spell attack takes the Strike's result — ${escapeHTML(data.degree)}.</p>` }); } catch (_) {}
        return { released: held.name, spellId: spell.id };
    }
    throw new Error(`Unknown Spell Reservoir action ${action}.`);
}

// ---- Another module's item casting a spell (api.castFromItem): the item module's consumables (2026-10-15) ----

const SECONDS = { round: 6, rounds: 6, minute: 60, minutes: 60, hour: 3600, hours: 3600, day: 86400, days: 86400 };
/** A spell's stated duration in seconds ("10 minutes", "until the end of your next turn": a round), 0 when it states none. */
export function spellDurationSeconds(source) {
    const text = String(source?.system?.duration?.value ?? "").toLowerCase();
    const m = /(\d+)\s*(rounds?|minutes?|hours?|days?)/.exec(text);
    if (m) return Number(m[1]) * SECONDS[m[2]];
    return /next turn|1 round/.test(text) ? 12 : 0;
}

/**
 * A spell an item casts for another module (the item module's potions and talismans — scrolls, wands, staves and catalysts stay PF2e's and this module's):
 * cast through PF2e from a temporary innate entry carrying the item's numbers — its DC, its counteract modifier — so this module resolves it like any other
 * cast. `spell` is a spells-srd UUID or a spell source; `rank` the item's, else the spell's own (a cantrip at half the actor's level); `targets` the tokens
 * (the actor's own for "on you"); `item` {name, uuid}. The entry, the spell and its numbers' Effect are temporary: removed once the spell's duration has passed
 * (at least 10 minutes, at most an hour of world time) or as the encounter ends — nothing stays on the sheet.
 * - `attackDegree` ("success" | "criticalSuccess"): the item's own hit stands in for the spell's attack roll — any spell attack spell's card records it on each
 *   target (Spellstrike Ammunition); Disintegrate's card starts with it, a critical hit making the save one degree worse as the spell says (Disintegration Bolt).
 * - `saveFirst` ({statistic, dc}): the item's save before the spell, which has none of its own (Silencing Shot: "… subject to the effects of a 4th-rank Silence
 *   spell unless it succeeds at a DC 25 Will save") — each target rolls it; the spell is cast on those that fail, and not at all when none does.
 * - The item's changes to the spell (2026-10-29, the item module's asks), made to the entry's copy of it only: `withoutTraits` (trait slugs it loses: Ivory
 *   Baton's Dominate without mental, so a mindless creature is affected), `addTraits` (traits it gains: Gate Attenuator's Thunderstrike with metal),
 *   `area` ({type, value}: Fan of Soothing Winds' Heal in a 30-foot cone, its 3-action variant's area too) and `damageType` (every damage instance of the
 *   spell that type: Soulcutter's spirit Weapon Storm, its held weapon's dice too) — itemSpellChanges, scripts/item-spell-changes.js.
 * - `actions` (1–3): the actions of a spell with action variants the item casts (Fan of Soothing Winds' 3-action Heal), so its route doesn't ask.
 * - `growth` ({feet}): how much each step of a growing aura adds (Shining Wayfinder's Bless, 5 feet for each single concentrate action, once a
 *   turn — Bless's own Sustain button, its step the item's).
 */
export async function castSpellForItem({ actor, token = null, spell, rank = null, dc = null, counteract = null, targets = null, item = null, attackDegree = null, saveFirst = null, withoutTraits = null, addTraits = null, area = null, damageType = null, actions = null, growth = null } = {}) {
    if (growth != null && !(Number(growth.feet) > 0 && Number(growth.feet) < 15)) throw new Error("castFromItem: growth is {feet: 5 or 10}.");
    if (actions != null && ![1, 2, 3].includes(Number(actions))) throw new Error("castFromItem: actions is 1, 2 or 3.");
    if (!actor) throw new Error("castFromItem: the actor is missing.");
    if (attackDegree != null && !["success", "criticalSuccess"].includes(attackDegree)) throw new Error("castFromItem: attackDegree is \"success\" or \"criticalSuccess\" (a hit).");
    let saves = null;
    if (saveFirst != null) {
        const statistic = String(saveFirst.statistic ?? "").toLowerCase(), saveDC = Number(saveFirst.dc);
        if (!["fortitude", "reflex", "will"].includes(statistic) || !(saveDC > 0)) throw new Error("castFromItem: saveFirst is {statistic: fortitude|reflex|will, dc}.");
        if (!(targets ?? []).length) throw new Error("castFromItem: saveFirst needs the targets.");
        saves = [];
        for (const target of targets) {
            const targetActor = target?.actor ?? target?.document?.actor ?? null;
            const roll = targetActor ? await targetActor.saves?.[statistic]?.roll({ dc: { value: saveDC }, skipDialog: true }) : null;
            saves.push({ target, name: targetActor?.name ?? null, degree: Number(roll?.degreeOfSuccess ?? -1) });
        }
        // (Those that fail are subject to the spell; the rest are untouched.)
        targets = saves.filter(entry => entry.degree >= 0 && entry.degree <= 1).map(entry => entry.target);
        if (!targets.length) return { message: null, resisted: true, saves: saves.map(({ name, degree }) => ({ name, degree })) };
    }
    const uuid = typeof spell === "string" ? spell : spell?.uuid ?? spell?._stats?.compendiumSource ?? spell?.flags?.core?.sourceId ?? null;
    const read = typeof spell === "string" ? (await fromUuid(spell))?.toObject() : spell ? foundry.utils.deepClone(spell.toObject?.() ?? spell) : null;
    if (read?.type !== "spell") throw new Error("castFromItem: the spell isn't a spell (a spells-srd UUID or its source).");
    // (The item's changes to its copy of the spell, and a key of its own for that copy: an unchanged one isn't reused for it.)
    const changes = itemSpellChanges({ withoutTraits, addTraits, area, damageType });
    const source = changes ? changedSpellSource(read, changes) : read;
    const cantrip = (source.system?.traits?.value ?? []).includes("cantrip");
    const autoHeighten = Math.max(1, Math.ceil(Number(actor.level ?? 1) / 2));
    const castRank = Number(rank) > 0 ? Number(rank) : cantrip ? autoHeighten : Number(source.system?.level?.value ?? 1);
    // (The item's numbers: its counteract modifier is the entry's check, a stated DC the entry's DC; one gives the other.)
    const numbers = { attack: counteract != null ? Number(counteract) : dc != null ? Number(dc) - 10 : null, dc: dc != null ? Number(dc) : counteract != null ? Number(counteract) + 10 : null };
    const itemUuid = item?.uuid ?? `castFromItem.${source.name}`;
    const holder = { uuid: itemUuid, id: (String(itemUuid).split(".").at(-1).replace(/[^A-Za-z0-9]/g, "") || randomID()).slice(-16), name: item?.name ?? source.name, img: item?.img ?? source.img };
    const tradition = (source.system?.traits?.traditions ?? [])[0] ?? "arcane";
    const entry = await itemEntry(actor, holder, tradition, numbers, autoHeighten);
    // (A character's counteract checks: PF2e builds them from the entry's attribute and proficiency, not its attack — the item's modifier comes from a
    // counteract modifier on the numbers' Effect, only for this entry's spells, calibrated like the attack. An NPC's entry takes the item's number already.)
    if (counteract != null && actor.type !== "npc") {
        const numbersEffect = (actor.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.itemCastStat === itemUuid);
        const base = Number(actor.items.get(entry.id)?.counteraction?.check?.mod ?? NaN);
        if (numbersEffect && Number.isFinite(base)) {
            const rules = foundry.utils.deepClone(numbersEffect.system.rules ?? []).filter(rule => rule.slug !== "item-cast-counteract");
            rules.push({ key: "FlatModifier", slug: "item-cast-counteract", selector: "counteract-check", value: Number(counteract) - base, label: holder.name, predicate: [`spellcasting:id:${entry.id}`] });
            await numbersEffect.update({ "system.rules": rules });
        }
    }
    const made = await entrySpell(actor, entry, `${uuid ?? `castFromItem.${source.name}`}${changes ? `#${changes.key}` : ""}`, castRank, cantrip, uuid && !changes ? null : source);
    // (Temporary: the entry, the spell and the numbers' Effect go once the spell's duration has passed — at least 10 minutes, at most an hour.)
    const until = Number(game.time.worldTime) + Math.min(3600, Math.max(600, spellDurationSeconds(source)));
    const temporary = { until, itemUuid, combatId: game.combat?.started ? game.combat.id : null };
    const stat = (actor.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.itemCastStat === itemUuid);
    for (const document of [entry, made, stat].filter(Boolean)) await document.setFlag(MODULE_ID, "castFromItemTemp", temporary);
    // (The tokens it's cast on: the user's targets as PF2e's cast is made, as for any cast.)
    const tokens = (targets ?? []).map(target => target?.object ?? target?.document?.object ?? target).filter(Boolean);
    // (Foundry 14: the canvas's setTargets — the user's own updateTokenTargets is gone; tokens on another scene can't be targeted.)
    const ids = tokens.map(entry => entry.id ?? entry.document?.id).filter(Boolean);
    if (ids.length && typeof canvas?.tokens?.setTargets === "function") canvas.tokens.setTargets(ids);
    else if (ids.length && typeof game.user?.updateTokenTargets === "function") game.user.updateTokenTargets(ids);
    rememberCastSpell(made);
    const mark = game.messages.size;
    await entry.cast(made, { rank: castRank, consume: false });
    let message = null;
    for (let i = 0; i < 40 && !message; i++) { message = game.messages.contents.slice(mark).find(entry => isCastMessage(entry) && entry.actor === actor); if (!message) await new Promise(resolve => setTimeout(resolve, 250)); }
    if (message) {
        await message.setFlag(MODULE_ID, "castFromItem", { itemName: holder.name, itemUuid, rank: castRank, dc: numbers.dc, counteract: counteract != null ? Number(counteract) : null,
            targets: tokens.map(entry => entry.document?.uuid ?? entry.uuid).filter(Boolean), ...(attackDegree ? { attackDegree } : {}), ...(actions != null ? { actions: Number(actions) } : {}), ...(growth != null ? { growth: { feet: Number(growth.feet) } } : {}) }).catch(() => null);
        // (The card's header names the item.)
        await message.update({ flavor: `<strong>${escapeHTML(holder.name)}</strong>${message.flavor ? ` ${message.flavor}` : ""}` }).catch(() => null);
    }
    return { message, rank: castRank, numbers, spellUuid: made.uuid, until, ...(saves ? { saves: saves.map(({ name, degree }) => ({ name, degree })) } : {}) };
}

/** The temporary items of the casts made for other modules whose time has passed (or all of them, `force`): removed, their spells' sources kept for the casts' records. */
export async function sweepItemCastTemps({ force = false, combatId = null } = {}) {
    if (!activeGM()) return 0;
    const now = Number(game.time.worldTime);
    let removed = 0;
    const actors = [...game.actors, ...(canvas?.scene?.tokens ?? []).filter(token => !token.actorLink).map(token => token.actor).filter(Boolean)];
    for (const actor of actors) {
        const due = actor.items.filter(document => { const temp = document.flags?.[MODULE_ID]?.castFromItemTemp; return temp && (force || Number(temp.until) <= now || (combatId && temp.combatId === combatId)); });
        if (!due.length) continue;
        for (const document of due) if (document.type === "spell") rememberCastSpell(document);
        // (The spells first: PF2e deletes an entry's spells with it.)
        const order = [...due.filter(document => document.type === "spell"), ...due.filter(document => document.type !== "spell")].map(document => document.id).filter(id => actor.items.has(id));
        await actor.deleteEmbeddedDocuments("Item", order).catch(() => null);
        removed += order.length;
    }
    return removed;
}
