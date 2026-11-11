// The "+" modules' passive features run as their text says (src/compiler/plus-feature-rules.js): pf2e-resolution-core's rules patch runs this module's
// rewriter (main.js) as PF2e prepares an item's rule elements, so an item whose text a form reads gets, in memory only, the module's rules the text
// contradicts dropped and the text's added — nothing is saved to the item. Official PF2e items are left as PF2e made them.
import { readTextRules, rulesWithText, readFocusRegain, readActionCast } from "../src/compiler/plus-feature-rules.js";
import { loadNativeEffectTemplate, prepareNativeEffectSource, createNativeEffect } from "./native-outcome-effects.js";
import { levelDC } from "../src/compiler/check-helpers.js";
import { timedTempHp, riderChoice } from "./spellshape-runtime.js";
import { MODULE_ID } from "./runtime-utils.js";

import { noticeImmunity } from "./immunity-notice.js";
const cache = new Map();

/** The item's text reading, kept while its description and rules are unchanged. */
export function textRulesFor(item) {
    const source = item?._source;
    if (!source || item.type === "spell") return null;
    const origin = String(source._stats?.compendiumSource ?? source.flags?.core?.sourceId ?? "");
    if (origin.startsWith("Compendium.pf2e.")) return null;
    const description = String(source.system?.description?.value ?? "");
    const key = `${item.uuid}|${description.length}|${description.slice(0, 64)}|${JSON.stringify(source.system?.rules ?? []).length}`;
    if (!cache.has(key)) {
        let read = null;
        try { read = readTextRules(source); } catch (error) { console.warn(`${MODULE_ID} | ${item.name}'s text couldn't be read for its rules.`, error); }
        cache.set(key, read);
    }
    return cache.get(key);
}

/** The rules PF2e prepares for an item, its text's dropped and added (the core's rules patch asks for every item), or null to leave them as they are. */
export function rulesFromText(item, rules) {
    const read = textRulesFor(item);
    return read?.add || read?.drop ? rulesWithText(rules, read) : null;
}

/**
 * An Arcane Cascade stance's damage type (every cascade Effect's "stanceArcaneCascade" choice), from the actor's most recent spell:
 *   - PF2e's Arcane Cascade: "If you Cast a Spell and then enter Arcane Cascade on the same turn, you can change the damage from the stance to any one damage type that spell
 *     could deal instead of force." — force, or one of that spell's types (asked), only after a cast on the same turn;
 *   - Magus+'s cascades: "If your most recent spell before entering the stance was one that can deal damage, the damage from the stance is instead the same type that spell could
 *     deal (or one type of your choice if the spell could deal multiple types of damage)." — that type, asked among the spell's when several; force otherwise.
 * One type: chosen; several: PF2e's question offers only those. Returns the source to create.
 */
export function cascadeTypeAhead(entry, actor) {
    const source = typeof entry?.toObject === "function" ? entry.toObject() : entry;
    if (!actor || source?.type !== "effect") return entry;
    const rules = foundry.utils.deepClone(source.system?.rules ?? []);
    const rule = rules.find(candidate => candidate.key === "ChoiceSet" && candidate.flag === "stanceArcaneCascade" && candidate.selection == null && Array.isArray(candidate.choices));
    if (!rule) return entry;
    const cast = game.messages.contents.slice(-80).reverse().find(entry => entry.flags?.pf2e?.casting && entry.actor === actor && entry.item);
    const types = [...new Set(Object.values(cast?.item?.system?.damage ?? {}).filter(entry => ![...(entry.kinds ?? ["damage"])].every(kind => kind === "healing")).map(entry => entry.type).filter(type => type && type !== "untyped"))];
    const official = String(source._stats?.compendiumSource ?? source.flags?.core?.sourceId ?? "").startsWith("Compendium.pf2e.");
    const turn = cast?.getFlag(MODULE_ID, "castTurn") ?? null;
    const combat = game.combat?.started ? game.combat : null;
    const sameTurn = Boolean(cast) && (!combat || (turn && turn.combatId === combat.id && turn.round === combat.round && turn.turn === combat.turn));
    let allowed = official ? (sameTurn && types.length ? ["force", ...types] : ["force"]) : (types.length ? types : ["force"]);
    const values = rule.choices.map(choice => choice.value);
    allowed = allowed.filter(value => values.includes(value));
    if (!allowed.length) return entry;
    if (allowed.length === 1) rule.selection = allowed[0];
    else rule.choices = rule.choices.filter(choice => allowed.includes(choice.value));
    return { ...source, system: { ...source.system, rules } };
}

/**
 * Wayward Gifts' primal gift: "you gain temporary Hit Points each time you Sustain a hex equal to its rank that last until the beginning of your next turn" —
 * on PF2e's Sustain action from a witch whose Wayward Gifts is primal, the rank of a sustained hex it cast (asked when it sustains several).
 */
export async function waywardSustain(message) {
    if (!game.users.activeGM?.isSelf || message?.item?.slug !== "sustain") return null;
    const actor = message.actor;
    if (!actor || !actor.rollOptions?.all?.["wayward-gifts-primal"]) return null;
    const hexes = [];
    for (const holder of new Set([actor, ...(canvas?.scene?.tokens ?? []).map(token => token.actor).filter(Boolean)])) {
        for (const effect of holder.itemTypes?.effect ?? []) {
            const origin = effect.system?.context?.origin;
            if (origin?.actor !== actor.uuid || !effect.system?.duration?.sustained) continue;
            const spell = origin.item ? fromUuidSync(origin.item) : null;
            if (!(spell?.system?.traits?.value ?? []).includes("hex")) continue;
            hexes.push({ value: effect.uuid, label: `${spell.name} (rank ${Number(effect.system?.level?.value ?? spell.rank ?? 1)})`, rank: Number(effect.system?.level?.value ?? spell.rank ?? 1) });
        }
    }
    if (!hexes.length) return null;
    const picked = hexes.length === 1 ? hexes[0].value : await riderChoice({ name: "Wayward Gifts", choice: null }, "Which hex did you Sustain?", hexes);
    const hex = hexes.find(entry => entry.value === picked);
    return hex ? timedTempHp(actor, hex.rank, "Wayward Gifts", 1) : null;
}

/** An Effect whose value is its origin's cursebound value when made (Comfort of Struggle): its level set to it (at least 1). */
export async function textRulesOnCreate(item) {
    if (!game.users.activeGM?.isSelf || item?.type !== "effect") return null;
    const read = textRulesFor(item);
    if (read?.levelFrom !== "origin-cursebound") return null;
    const origin = item.system?.context?.origin?.actor ? fromUuidSync(item.system.context.origin.actor) : null;
    const value = Math.max(1, Number(origin?.getCondition?.("cursebound")?.value ?? 0));
    await item.update({ "system.level.value": value });
    return value;
}

const PERIOD = { PT1M: 60, PT10M: 600, PT1H: 3600, day: 86400, PT24H: 86400 };
/**
 * A feature that regains a Focus Point, its card posted (its use): the point back, up to the pool's maximum — after Emergency Infusion's bleed, or Monastic Practices'
 * check at the level's DC; refused within its frequency ("once per hour", "once per day").
 */
export async function focusRegainOnCard(message) {
    if (!game.users.activeGM?.isSelf || !["feat", "action"].includes(message?.flags?.pf2e?.origin?.type)) return null;
    const item = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    const actor = item?.actor;
    // (The "+" modules' features only: PF2e's own are left as PF2e made them.)
    if (String(item?._source?._stats?.compendiumSource ?? "").startsWith("Compendium.pf2e.")) return null;
    const read = item ? readFocusRegain(item.toObject()) : null;
    if (!read || !actor) return null;
    const say = text => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${item.name}</strong>: ${text}</p>` }).catch(() => null);
    const used = actor.getFlag(MODULE_ID, "focusRegainUsed")?.[item.id] ?? null;
    const period = PERIOD[read.frequency] ?? null;
    if (period && used != null && game.time.worldTime - used < period) { await say(`already used (once per ${read.frequency === "day" ? "day" : "hour"}).`); return { refused: "frequency" }; }
    if (read.bleed) {
        const amount = Math.ceil(Number(actor.level ?? 1) / 2);
        const condition = game.pf2e?.ConditionManager?.getCondition?.("persistent-damage")?.toObject();
        if (condition) { condition.system.persistent = { formula: String(amount), damageType: read.bleed.damageType, dc: 15 }; await actor.createEmbeddedDocuments("Item", [condition]); }
    }
    if (read.check) {
        const roll = await actor.skills?.[read.check.skill]?.roll({ dc: { value: levelDC(actor.level) }, skipDialog: true });
        if (!(Number(roll?.degreeOfSuccess ?? 0) >= 2)) return { regained: 0, check: "failed" };
    }
    const focus = actor.system?.resources?.focus;
    if (!focus || !(Number(focus.max) > 0)) { await say("no focus pool."); return { regained: 0 }; }
    const regained = Math.min(read.amount, Number(focus.max) - Number(focus.value));
    if (regained > 0) await actor.update({ "system.resources.focus.value": Number(focus.value) + regained });
    if (period) await actor.setFlag(MODULE_ID, "focusRegainUsed", { ...(actor.getFlag(MODULE_ID, "focusRegainUsed") ?? {}), [item.id]: game.time.worldTime });
    await say(regained > 0 ? `${actor.name} regains ${regained} Focus Point.` : `${actor.name}'s focus pool is already full.`);
    return { regained };
}

/**
 * The caster's Arcane Cascade stance Effect (the source to create): its Arcane Cascade action's own Effect (PF2e's or Magus+'s) — Havok Cascade's when it has that ("When you would
 * enter your Arcane Cascade stance, you enter a Havok Cascade stance") —, or null.
 */
export async function cascadeStanceFor(actor) {
    const actions = actor?.itemTypes?.action ?? [];
    const action = actions.find(entry => entry.slug === "havok-cascade") ?? actions.find(entry => /^Arcane Cascade\+?$/.test(entry.name) || entry.slug === "arcane-cascade");
    const uuid = action?.system?.selfEffect?.uuid ?? (/@UUID\[([^\]]+)\]\{Stance: Arcane Cascade\+?\}/.exec(action?.system?.description?.value ?? "")?.[1]) ?? null;
    const template = uuid ? await fromUuid(uuid).catch(() => null) : null;
    if (!template) return null;
    const source = template.toObject(); delete source._id;
    foundry.utils.setProperty(source, "_stats.compendiumSource", template.uuid);
    return source;
}

/** The caster's residual energy (Wizards+'s Effect: Residual Energy): {effect, trait}, or null. */
export function residualEnergyOf(actor) {
    const effect = (actor?.itemTypes?.effect ?? []).find(entry => entry.name.startsWith("Effect: Residual Energy"));
    const trait = effect?.flags?.pf2e?.rulesSelections?.energyTrait ?? null;
    return effect && trait ? { effect, trait } : null;
}

/**
 * An action spending residual energy to cast, its card posted: Become Elemental (Elemental Form at 7th of the energy's element, the text's attack +31, damage +14 and
 * +10 feet to the Speeds), Create Elemental (Summon Elemental, arcane, at half the level, an elemental of that trait).
 */
const actionCastSeen = new Set();
export async function actionCastOnCard(message) {
    // (An item's card — not a roll or damage message carrying the item as its origin.)
    if (!game.users.activeGM?.isSelf || !["feat", "action"].includes(message?.flags?.pf2e?.origin?.type) || message.flags.pf2e.context?.type) return null;
    // (Once per card.)
    if (actionCastSeen.has(message.id)) return null;
    actionCastSeen.add(message.id);
    const item = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    const actor = item?.actor;
    // (An action the module gave that casts a spell of its creature's — Colossal Summon's Earth-Shatterer: "Frequency once per minute; Effect The summon produces the effects
    // of an Earthquake" — cast from its entry, within its frequency.)
    const given = item?.flags?.[MODULE_ID]?.actionCast;
    if (given && actor) {
        const spell = actor.items.get(given.spellId);
        const last = Number(item.getFlag(MODULE_ID, "actionCastUsed") ?? NaN);
        if (Number.isFinite(last) && game.time.worldTime - last < Number(given.perSeconds ?? 0)) {
            await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${item.name}</strong>: used within the last minute.</p>` }).catch(() => null);
            return { refused: "frequency" };
        }
        if (!spell?.spellcasting) return null;
        await item.setFlag(MODULE_ID, "actionCastUsed", game.time.worldTime);
        await spell.spellcasting.cast(spell, { rank: given.rank, consume: false });
        return { cast: spell.name, rank: given.rank };
    }
    const read = item ? readActionCast(item.toObject()) : null;
    if (!read || !actor) return null;
    const say = text => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${item.name}</strong>: ${text}</p>` }).catch(() => null);
    const residual = residualEnergyOf(actor);
    if (read.spendsResidual && !residual) { await say(`${actor.name} has no residual energy.`); return { refused: "no residual energy" }; }
    if (read.kind === "spell-effects") {
        // (Ferocious Gust: the spell cast through PF2e from the module's temporary entry at the higher of the user's class DC and spell DC — its own card follows, a
        // lingering area's placement too.)
        const dcs = [Number(actor.classDC?.dc?.value ?? actor.system?.attributes?.classDC?.value), ...(actor.spellcasting?.regular ?? []).map(entry => Number(entry.statistic?.dc?.value))].filter(Number.isFinite);
        if (!dcs.length) { await say(`${actor.name} has no class DC or spell DC.`); return { refused: "dc" }; }
        const { castSpellForItem } = await import("./item-cast-runtime.js");
        const cast = await castSpellForItem({ actor, spell: read.spell.uuid, dc: Math.max(...dcs), item });
        return { cast: read.spell.name, dc: Math.max(...dcs), messageId: cast?.message?.id ?? null };
    }
    if (read.kind === "become-form") {
        const sourceSpell = await fromUuid(read.spell.uuid).catch(() => null);
        const link = /@UUID\[([^\]]+)\]\{Spell Effect: [^}]+\}/.exec(sourceSpell?.system?.description?.value ?? "")?.[1];
        const template = link ? await loadNativeEffectTemplate(link) : null;
        const choice = (template?.system?.rules ?? []).find(rule => rule.key === "ChoiceSet");
        if (!template || !choice?.choices?.some(entry => entry.value === residual.trait)) { await say(`no ${read.spell.name} of the ${residual.trait} trait.`); return { refused: "trait" }; }
        await residual.effect.delete();
        const source = prepareNativeEffectSource(template, { castInstanceId: message.id, castRank: read.rank, sourceActorUuid: actor.uuid, sourceItemUuid: item.uuid, sourceItemName: item.name, resolutionKind: "effect", targetActorUuid: actor.uuid });
        source.system.level = { value: read.rank };
        const rules = foundry.utils.deepClone(source.system.rules ?? []);
        const pick = rules.find(rule => rule.key === "ChoiceSet");
        pick.selection = residual.trait; foundry.utils.setProperty(source, `flags.pf2e.rulesSelections.${pick.flag}`, residual.trait);
        // (The form's own numbers at its rank, replaced by the text's: "an attack modifier of +31, and a damage bonus of +14".)
        for (const rule of rules.filter(entry => entry.key === "BattleForm" && JSON.stringify(entry.predicate ?? []).includes(`:${residual.trait}`))) {
            const bracket = [...(rule.brackets ?? [])].filter(entry => Number(entry.start ?? 0) <= read.rank).sort((a, b) => Number(b.start) - Number(a.start))[0];
            for (const strike of Object.values(bracket?.value?.strikes ?? {})) { strike.modifier = read.attack; strike.damage = { ...(strike.damage ?? {}), modifier: read.damage }; }
        }
        rules.push({ key: "FlatModifier", selector: "all-speeds", type: "status", value: read.speedBonus, label: `${item.name}` });
        source.system.rules = rules;
        const made = await createNativeEffect(actor, source);
        await say(`${actor.name} becomes a ${residual.trait} elemental (${read.spell.name} at rank ${read.rank}; attack +${read.attack}, damage +${read.damage}).`);
        return { effectUuid: made?.uuid ?? null, trait: residual.trait };
    }
    if (read.kind === "residual-spellstrike") {
        // (The trigger: the caster's latest Spellstrike, whose Strike got a failure — that cast read from the next Strike instead, at −5 (−4 agile) in place of the multiple
        // attack penalty.)
        const cast = game.messages.contents.slice(-40).reverse().find(entry => entry.actor === actor && entry.flags?.pf2e?.casting && entry.getFlag(MODULE_ID, "strikeDelivery")?.kind === "spellstrike");
        const delivery = cast?.getFlag(MODULE_ID, "strikeDelivery");
        const strike = cast ? game.messages.contents.filter(entry => entry.timestamp >= cast.timestamp && entry.actor === actor && entry.flags?.pf2e?.context?.type === "attack-roll").at(-1) : null;
        if (!delivery || delivery.residual || strike?.flags?.pf2e?.context?.outcome !== "failure") { await say("no Spellstrike whose Strike just got a failure."); return { refused: "trigger" }; }
        await cast.setFlag(MODULE_ID, "strikeDelivery", { ...delivery, residual: { at: Date.now(), from: strike.id } });
        await actor.createEmbeddedDocuments("Item", [{ name: `${item.name}: the Strike`, type: "effect", img: item.img ?? "icons/svg/sword.svg",
            system: { duration: { value: 0, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                description: { value: `<p>Roll this Strike as a first attack (no multiple attack penalty): −${read.penalty} (−${read.agilePenalty} if agile) applies instead.</p>` },
                // (The agile weapon's smaller penalty as the difference, on agile Strikes.)
                rules: [{ key: "FlatModifier", selector: "strike-attack-roll", value: -read.penalty, label: item.name, slug: "residual-spellstrike", removeAfterRoll: "if-enabled" },
                    { key: "FlatModifier", selector: "strike-attack-roll", value: read.penalty - read.agilePenalty, label: `${item.name} (agile)`, slug: "residual-spellstrike-agile", predicate: ["item:trait:agile"] }] } }]);
        await say(`${cast.item?.name ?? "the spell"} goes to the Strike with the other diametric weapon (−${read.penalty}, −${read.agilePenalty} if agile, in place of the multiple attack penalty). ${read.table.join("; ")} (the table's).`);
        return { residual: cast.id };
    }
    if (read.kind === "reverse-spellstrike") {
        // ("you were targeted with a hostile spell you could Spellstrike with": the latest such cast by a creature not allied to the magus that targeted it — 1 or 2 actions,
        // a spell attack or a save.)
        const { castTargetActors, highestCastableRank } = await import("./spellshape-runtime.js");
        const hostile = game.messages.contents.slice(-40).reverse().find(entry => {
            const caster = entry.actor, spell = entry.item;
            if (!entry.flags?.pf2e?.casting || !caster || !spell || caster === actor || (caster.alliance && caster.alliance === actor.alliance)) return false;
            const actions = Number(String(spell.system?.time?.value ?? "").replace(/[^0-9]/g, "")) || null;
            const fits = actions && actions <= 2 && ((spell.system?.traits?.value ?? []).includes("attack") || spell.system?.defense?.passive?.statistic === "ac" || Boolean(spell.system?.defense?.save?.statistic));
            const targeted = entry.getFlag(MODULE_ID, "castTargets");
            return fits && (targeted ? targeted.includes(actor.uuid) : castTargetActors(entry, caster).includes(actor));
        });
        if (!hostile) { await say("no hostile spell that could be Spellstruck targeted you."); return { refused: "trigger" }; }
        // ("You expend a spell slot of your highest level": a spontaneous slot, or a prepared spell, of that rank.)
        const highest = highestCastableRank(actor);
        if (!(highest >= Number(hostile.item.rank ?? hostile.item.system?.level?.value ?? 1))) { await say(`${hostile.item.name} is of a higher rank than you can cast.`); return { refused: "rank" }; }
        const entries = actor.itemTypes.spellcastingEntry;
        const spontaneous = entries.find(entry => (entry.system?.prepared?.value === "spontaneous") && Number(entry.system?.slots?.[`slot${highest}`]?.value ?? 0) > 0);
        const prepared = spontaneous ? null : entries.find(entry => entry.system?.prepared?.value === "prepared" && Object.values(entry.system?.slots?.[`slot${highest}`]?.prepared ?? {}).some(slot => slot?.id && !slot.expended));
        const source = spontaneous ?? prepared;
        if (!source) { await say(`no rank ${highest} slot left to expend.`); return { refused: "slot" }; }
        if (spontaneous) await spontaneous.update({ [`system.slots.slot${highest}.value`]: Number(spontaneous.system.slots[`slot${highest}`].value) - 1 });
        else {
            const slots = foundry.utils.deepClone(prepared.system.slots[`slot${highest}`].prepared);
            const key = Object.keys(slots).find(index => slots[index]?.id && !slots[index].expended);
            slots[key].expended = true;
            await prepared.update({ [`system.slots.slot${highest}.prepared`]: slots });
        }
        // (The spell, borrowed: an innate entry with the expended slot's tradition and statistics, heightened to that rank; both gone at the end of the magus's next turn.)
        const [entry] = await actor.createEmbeddedDocuments("Item", [{ name: `${item.name}: ${hostile.item.name}`, type: "spellcastingEntry",
            system: { tradition: { value: source.system?.tradition?.value ?? "arcane" }, prepared: { value: "innate" }, ability: { value: source.system?.ability?.value ?? "int" },
                proficiency: { value: source.system?.proficiency?.value ?? 1 }, spelldc: foundry.utils.deepClone(source.system?.spelldc ?? {}) } }]);
        const borrowed = hostile.item.toObject(); delete borrowed._id;
        borrowed.system.location = { value: entry.id, heightenedLevel: highest, uses: { value: 1, max: 1 } };
        const [spell] = await actor.createEmbeddedDocuments("Item", [borrowed]);
        const { shapeEffect } = await import("./spellshape-runtime.js");
        await shapeEffect(actor, actor, `${item.name}: ${hostile.item.name}`, [], { until: "caster-next-turn-end", flags: { removesItems: [spell.id, entry.id] },
            description: `${hostile.item.name}, Spellstruck at rank ${highest}.` });
        const mark = game.messages.size;
        await spell.spellcasting.cast(spell, { rank: highest, consume: false });
        let cast = null;
        for (let i = 0; i < 20 && !cast; i++) { cast = game.messages.contents.slice(mark).find(entry => entry.flags?.pf2e?.casting && entry.actor === actor); if (!cast) await new Promise(resolve => setTimeout(resolve, 200)); }
        const attack = (spell.system?.traits?.value ?? []).includes("attack") || spell.system?.defense?.passive?.statistic === "ac";
        if (cast) await cast.setFlag(MODULE_ID, "strikeDelivery", { kind: "spellstrike", name: "Spellstrike", attack, at: Date.now() });
        return { cast: hostile.item.name, rank: highest, from: spontaneous ? "spontaneous slot" : "prepared spell", castId: cast?.id ?? null };
    }
    if (read.kind === "reservoir-of-power") {
        // ("Requirements Your most recent action was to Cast a Spell from a spell slot …": the caster's latest spell, from a prepared or spontaneous slot; "You use Arcane Cascade
        // and you gain an effect depending on the school of your most recent spell" — the stance (its type from that spell) and the module's Effect, its school asked.)
        const cast = game.messages.contents.slice(-30).reverse().find(entry => entry.flags?.pf2e?.casting && entry.actor === actor && entry.item);
        const entry = cast?.item?.spellcasting;
        const fromSlot = Boolean(entry && (entry.isPrepared || entry.isSpontaneous) && !(cast.item.system?.traits?.value ?? []).some(trait => ["cantrip", "focus"].includes(trait)));
        if (!fromSlot) { await say("your most recent spell wasn't cast from a spell slot."); return { refused: "requirement" }; }
        const made = [];
        const stance = await cascadeStanceFor(actor);
        if (stance) made.push(...await actor.createEmbeddedDocuments("Item", [stance]));
        const reservoir = await loadNativeEffectTemplate(read.effect.uuid);
        if (reservoir) { const source = reservoir.toObject(); delete source._id; made.push(...await actor.createEmbeddedDocuments("Item", [source])); }
        // ("Necromancy … regain a number of Hit Points equal to the damage value of your Arcane Cascade": the module's Effect has no healing.)
        const school = made.find(effect => effect.name.startsWith(read.effect.name))?.flags?.pf2e?.rulesSelections?.school ?? null;
        if (school === "necromancy") { const value = Number(actor.flags?.magus?.arcaneCascade?.damageNumber ?? 1); await actor.update({ "system.attributes.hp.value": Math.min(actor.hitPoints.max, actor.hitPoints.value + value) }); }
        return { stance: stance?.name ?? null, reservoir: Boolean(reservoir), school, from: cast.item.name };
    }
    if (read.kind === "puppet-string") {
        // ("Requirements You used your most recent action to Cast a Spell that targeted an enemy within 30 feet or make a melee Spellstrike and the spell you chose had the illusion
        // or mental trait." — the caster's latest spell with one of those traits; the enemy it targeted (or its Spellstrike's target) within 30 feet; the module's two Effects, the
        // required trait the spell's and the weakness by weapon specialization.)
        const cast = game.messages.contents.slice(-30).reverse().find(entry => entry.flags?.pf2e?.casting && entry.actor === actor && entry.item);
        const traits = (cast?.item?.system?.traits?.value ?? []).filter(trait => read.traits.includes(trait));
        if (!traits.length) { await say(`your most recent spell has neither the ${read.traits.join(" nor the ")} trait.`); return { refused: "requirement" }; }
        const { tokenDistance } = await import("./token-distance.js");
        const casterToken = actor.getActiveTokens?.(true, true)?.[0] ?? null;
        const strike = cast.getFlag(MODULE_ID, "strikeDelivery") ? game.messages.contents.filter(entry => entry.timestamp >= cast.timestamp && entry.actor === actor && entry.flags?.pf2e?.context?.type === "attack-roll").at(-1) : null;
        const targetUuids = strike?.flags?.pf2e?.context?.target?.actor ? [strike.flags.pf2e.context.target.actor] : cast.getFlag(MODULE_ID, "castTargets") ?? [];
        const enemies = targetUuids.map(uuid => fromUuidSync(uuid)).filter(other => other && other !== actor && !(other.alliance && other.alliance === actor.alliance))
            .filter(other => { const token = other.getActiveTokens?.(true, true)?.[0]; return token && casterToken && tokenDistance(casterToken, token) <= read.range; });
        if (!enemies.length) { await say(`no enemy the spell targeted is within ${read.range} feet.`); return { refused: "requirement" }; }
        const enemy = enemies.length === 1 ? enemies[0] : fromUuidSync(await riderChoice({ name: item.name, choice: null }, "Which enemy?", enemies.map(other => ({ value: other.uuid, label: other.name }))));
        const trait = traits.length === 1 ? traits[0] : await riderChoice({ name: item.name, choice: null }, "The required trait", traits.map(value => ({ value, label: value })));
        const options = new Set(actor.getRollOptions?.() ?? []);
        const spec = options.has("feature:greater-weapon-specialization") ? read.weakness[2] : options.has("feature:weapon-specialization") ? read.weakness[1] : read.weakness[0];
        const self = await loadNativeEffectTemplate(read.self.uuid), tether = await loadNativeEffectTemplate(read.tether.uuid);
        if (self) { const source = prepareNativeEffectSource(self, { castInstanceId: message.id, castRank: 1, sourceActorUuid: actor.uuid, sourceItemUuid: item.uuid, sourceItemName: item.name, resolutionKind: "effect", targetActorUuid: actor.uuid }); await actor.createEmbeddedDocuments("Item", [source]); }
        let tethered = null;
        if (tether) {
            const source = prepareNativeEffectSource(tether, { castInstanceId: message.id, castRank: 1, sourceActorUuid: actor.uuid, sourceItemUuid: item.uuid, sourceItemName: item.name, resolutionKind: "effect", targetActorUuid: enemy.uuid });
            for (const rule of source.system.rules ?? []) {
                if (rule.key === "ChoiceSet" && rule.flag === "requiredTrait") rule.selection = trait;
                if (rule.key === "ChoiceSet" && rule.flag === "wepSpec") rule.selection = spec;
            }
            [tethered] = await enemy.createEmbeddedDocuments("Item", [source]);
        }
        return { enemy: enemy.name, trait, weakness: spec, tethered: tethered?.uuid ?? null };
    }
    if (read.kind === "consume-item-slot") {
        // (Consume Item Magic: a held magical consumable, consumed; a spent slot of a rank up to half its level — a prepared spell spent today, or a spontaneous rank with a repertoire
        // spell — sharing a trait with it.)
        const held = (actor.itemTypes?.consumable ?? []).filter(entry => entry.system?.equipped?.carryType === "held" && (entry.system?.traits?.value ?? []).includes("magical"));
        if (!held.length) { await say("not holding a magical consumable."); return { refused: "requirement" }; }
        const consumable = held.length === 1 ? held[0] : held[Number(await riderChoice({ name: item.name, choice: null }, "Consume which item?", held.map((entry, index) => ({ value: String(index), label: entry.name }))) ?? 0)];
        const traits = consumable.system?.traits?.value ?? [];
        const maxRank = Math.floor(Number(consumable.system?.level?.value ?? 0) / 2);
        const shares = spell => (spell?.system?.traits?.value ?? []).some(trait => traits.includes(trait) && !["magical", "consumable"].includes(trait));
        const slots = [];
        for (const entry of actor.spellcasting?.regular ?? []) for (const [key, slot] of Object.entries(entry.system?.slots ?? {})) {
            const rank = Number(key.slice(4));
            if (!(rank >= 1 && rank <= maxRank)) continue;
            if (entry.isPrepared) (slot.prepared ?? []).forEach(prepared => { const spell = actor.items.get(prepared.id ?? ""); if (prepared.expended && shares(spell)) slots.push({ spell, rank, label: `${spell.name} (rank ${rank})` }); });
            else if (Number(slot.value) < Number(slot.max)) { const spell = (actor.itemTypes?.spell ?? []).find(entry2 => entry2.system?.location?.value === entry.id && Number(entry2.rank) <= rank && shares(entry2)); if (spell) slots.push({ spell, rank, label: `a rank-${rank} slot (${spell.name}'s traits)` }); }
        }
        if (!slots.length) { await say(`no spent slot of rank ${maxRank} or lower shares a trait with ${consumable.name}.`); return { refused: "no slot" }; }
        const picked = slots.length === 1 ? slots[0] : slots[Number(await riderChoice({ name: item.name, choice: actor.getFlag(MODULE_ID, "passiveChoices")?.[item.name] ?? null }, "Regain which slot?", slots.map((entry, index) => ({ value: String(index), label: entry.label }))) ?? 0)];
        const { refundSlot } = await import("./spellshape-runtime.js");
        const result = await refundSlot(actor, picked.spell, picked.rank, item.name);
        const quantity = Number(consumable.system?.quantity ?? 1);
        if (quantity > 1) await consumable.update({ "system.quantity": quantity - 1 }); else await consumable.delete();
        await say(`${consumable.name} consumed; ${result.label}.`);
        return { consumed: consumable.name, slot: picked.label, status: result.status };
    }
    if (read.kind === "free-heal") {
        // (Vital Pululation: cursebound 2+ and in an encounter; the 3-action Heal at the second highest rank, from the caster's own entry, the caster left out; no slot spent.)
        const cursebound = Number(actor.getCondition?.("cursebound")?.value ?? 0);
        const inCombat = Boolean(game.combat?.started && game.combat.combatants.some(combatant => combatant.actor === actor));
        if (cursebound < read.minCursebound || !inCombat) { await say(`needs cursebound ${read.minCursebound} or more, in an encounter.`); return { refused: "requirement" }; }
        const { highestCastableRank, tokensWithin } = await import("./spellshape-runtime.js");
        const rank = Math.max(1, highestCastableRank(actor) - 1);
        const entry = actor.spellcasting?.regular?.[0];
        const template = await fromUuid(read.spell.uuid).catch(() => null);
        if (!template || !entry) return { refused: "no spell" };
        const source = template.toObject(); source._id = foundry.utils.randomID();
        source.system.location = { value: entry.id, heightenedLevel: rank };
        const heal = new CONFIG.Item.documentClass(source, { parent: actor });
        const overlay = Object.entries(heal._source.system.overlays ?? {}).find(([, o]) => o.system?.time?.value === read.actions)?.[0];
        const variant = overlay ? heal.loadVariant({ castRank: rank, overlayIds: [overlay] }) ?? heal : heal;
        const casterToken = actor.getActiveTokens?.(true, true)?.[0] ?? null;
        const radius = Number(variant.system?.area?.value ?? 30);
        const targets = casterToken ? tokensWithin(casterToken, radius).map(token => token.object ?? token) : [];
        const api = game.modules.get(MODULE_ID).api;
        const plan = await api.compile(variant);
        const result = api.saves.supports(plan) ? await api.saves.start(variant, { plan, sourceActor: actor, targets, castRank: rank, skipConfirmation: true })
            : await api.execute(variant, { plan, sourceActor: actor, targets, castRank: rank, skipConfirmation: true });
        await say(`the ${read.actions}-action ${read.spell.name} at rank ${rank}, no slot spent, ${actor.name} excluded (${targets.length} creatures).`);
        return { rank, targets: targets.length, card: !!result };
    }
    if (read.kind === "regain-last-slot") {
        // (Archmemory: the slot of the caster's last cast this turn given back.)
        const turnStart = game.combat?.started && game.combat.combatant?.actor === actor ? null : game.time.worldTime - 6;
        const cast = game.messages.contents.slice(-30).reverse().find(entry => entry.flags?.pf2e?.casting && entry.actor === actor && entry.item);
        if (!cast || (turnStart != null && Number(cast.flags?.[MODULE_ID]?.castTurn?.worldTime ?? game.time.worldTime) < turnStart)) { await say("no spell cast this turn."); return { refused: "requirement" }; }
        const { refundSlot } = await import("./spellshape-runtime.js");
        const rank = Number(cast.flags.pf2e.casting.castRank ?? cast.item.rank ?? 1);
        const result = await refundSlot(actor, cast.item, rank, item.name);
        await say(`${result.label}.`);
        return { spell: cast.item.name, rank, status: result.status };
    }
    if (read.kind === "eat-slot") {
        // (Spell Eating: a spent-able slot of the archetype's entry — its rank asked — consumed for 1d12 Hit Points per rank.)
        const entries = (actor.spellcasting?.regular ?? []).filter(entry => entry.isSpontaneous || entry.isPrepared);
        const open = entries.flatMap(entry => Object.entries(entry.system?.slots ?? {}).filter(([key, slot]) => Number(key.slice(4)) >= 1 && (entry.isPrepared ? (slot.prepared ?? []).some(prepared => prepared.id && !prepared.expended) : Number(slot.value) > 0))
            .map(([key]) => ({ entry, rank: Number(key.slice(4)) })));
        if (!open.length) { await say("no spell slot to consume."); return { refused: "no slot" }; }
        const picked = open.length === 1 ? 0 : Number(await riderChoice({ name: item.name, choice: actor.getFlag(MODULE_ID, "passiveChoices")?.[item.name] ?? null }, "Consume which slot?", open.map((slot, index) => ({ value: String(index), label: `rank ${slot.rank} (${slot.entry.name})` }))) ?? open.length - 1);
        const { entry, rank } = open[picked] ?? open.at(-1);
        if (entry.isPrepared) { const index = entry.system.slots[`slot${rank}`].prepared.findIndex(prepared => prepared.id && !prepared.expended); await entry.spells.setSlotExpendedState(rank, index, true); }
        else await entry.update({ [`system.slots.slot${rank}.value`]: Number(entry.system.slots[`slot${rank}`].value) - 1 });
        const roll = await new Roll(`${rank}d${read.faces}`).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${item.name}</strong>: healing` }).catch(() => null);
        const before = Number(actor.hitPoints?.value ?? 0);
        // (Healing: PF2e's negative damage.)
        await actor.applyDamage({ damage: -roll.total, token: actor.getActiveTokens?.(true, true)?.[0] ?? undefined }).catch(() => null);
        await say(`a rank-${rank} slot consumed: ${Number(actor.hitPoints?.value ?? 0) - before} Hit Points restored. ${read.table.join(" ")} (the table's)`);
        return { rank, healed: Number(actor.hitPoints?.value ?? 0) - before };
    }
    if (read.kind === "stigmata") {
        // (Stigmata: the bleed on the cleric — PF2e's persistent damage — and the Religion bonus while it bleeds.)
        const dice = Math.max(1, Math.floor(Number(actor.level ?? 1) / 4));
        const [condition] = await actor.createEmbeddedDocuments("Item", [{ name: `Persistent Damage (${dice}d4 bleed)`, type: "condition", img: "systems/pf2e/icons/conditions/persistent-damage.webp",
            system: { slug: "persistent-damage", persistent: { formula: `${dice}d4`, damageType: "bleed", dc: 15 } }, flags: { [MODULE_ID]: { stigmata: true } } }]);
        await actor.createEmbeddedDocuments("Item", [{ name: `${item.name}: bleeding`, type: "effect", img: item.img, flags: { [MODULE_ID]: { stigmataBonus: true } },
            system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
                rules: [{ key: "FlatModifier", selector: "religion", type: "status", value: read.religion, predicate: ["self:condition:persistent-damage"] }],
                description: { value: `<p>${read.table.join(" ")}</p>` } } }]);
        await say(`${dice}d4 persistent bleed; +${read.religion} status to Religion while bleeding. ${read.table.join(" ")} (the table's)`);
        return { condition: condition?.uuid ?? null };
    }
    if (read.kind === "triplicate") {
        // (Triplicate Casting: the next three casts — different non-cantrip spells with a one-action version, cast with one action — this turn spend one slot, the highest rank's.)
        await actor.setFlag(MODULE_ID, "triplicate", { name: item.name, count: read.count, casts: [], at: game.time.worldTime, combat: game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : null });
        await say(`the next ${read.count} one-action casts of different spells spend only the highest rank's slot. ${read.table.join(" ")} (the table's).`);
        return { armed: read.count };
    }
    if (read.kind === "spell-ignition") {
        // (Spell Ignition: the area of the caster's latest spell — its template's region, or the spaces of the creatures it targeted — as a region whose creatures other than the
        // caster ending their turn in it save (basic) against the rank in the stance's damage type, half for a cantrip; 2, 3 or 4 rounds by weapon specialization.)
        const cast = game.messages.contents.slice(-30).reverse().find(entry => entry.flags?.pf2e?.casting && entry.actor === actor && entry.item);
        if (!cast) { await say("you haven't Cast a Spell."); return { refused: "requirement" }; }
        const { castTargetActors, shapeDC } = await import("./spellshape-runtime.js");
        const region = canvas.scene?.regions.find(entry => entry.flags?.pf2e?.messageId === cast.id) ?? null;
        const size = canvas.grid.size;
        const spaces = region ? [] : castTargetActors(cast, actor).filter(other => other !== actor).flatMap(other => other.getActiveTokens?.(true, true) ?? [])
            .map(token => ({ type: "rectangle", x: token.x, y: token.y, width: Number(token.width ?? 1) * size, height: Number(token.height ?? 1) * size, rotation: 0 }));
        const shapes = region ? region.shapes.map(shape => shape.toObject?.() ?? { ...shape }) : spaces;
        if (!shapes.length) { await say(`${cast.item.name} targeted no creature and has no area.`); return { refused: "requirement" }; }
        const has = slug => (actor.itemTypes?.feat ?? []).some(feat => feat.slug === slug);
        const rounds = has("greater-weapon-specialization") ? read.rounds.greater : has("weapon-specialization") ? read.rounds.specialization : read.rounds.base;
        const rank = Number(cast.flags?.pf2e?.casting?.castRank ?? cast.flags?.pf2e?.origin?.castRank ?? cast.item.rank ?? 1);
        const cantrip = (cast.item.system?.traits?.value ?? []).includes("cantrip");
        const amount = cantrip ? Math.max(1, Math.floor(rank / 2)) : rank;
        const stance = (actor.itemTypes?.effect ?? []).find(effect => /^Stance: (?:Arcane|Havok) Cascade/.test(effect.name));
        const type = actor.flags?.pf2e?.arcaneCascade?.damageType || stance?.flags?.pf2e?.rulesSelections?.stanceArcaneCascade || "force";
        const [made] = await canvas.scene.createEmbeddedDocuments("Region", [{ name: `${item.name}: ambient magic`, color: "#c060ff", shapes,
            flags: { [MODULE_ID]: { spellshapeTerrain: { castId: cast.id, casterUuid: actor.uuid, name: item.name, expiresAt: game.time.worldTime + rounds * 6,
                hazard: { per: "turn-end-save", statistic: read.statistic, dc: shapeDC(actor, cast.item), damage: { formula: String(amount), type }, exceptCaster: true } } } } }]);
        await say(`ambient magic burns in ${region ? `${cast.item.name}'s area` : "the target's space"} for ${rounds} rounds: ${amount} ${type} (basic ${read.statistic}) to creatures other than ${actor.name} ending their turn there.`);
        return { region: made?.uuid ?? null, rounds, amount, type };
    }
    if (read.kind === "essence-strike") {
        // (Essence Strike: refused while immune to Sure Strike; the next spell attack roll this turn rolled twice, the better kept; then immune for 10 minutes.)
        if ((actor.itemTypes?.effect ?? []).some(effect => /immune to Sure Strike/i.test(effect.name))) { noticeImmunity({ actor, blocked: item.name, why: "temporarily immune to Sure Strike" }); await say(`${actor.name} is temporarily immune to Sure Strike.`); return { refused: "immune" }; }
        const combat = game.combat?.started ? game.combat : null;
        const start = { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null };
        const made = await actor.createEmbeddedDocuments("Item", [
            { name: `${item.name}: the next spell attack roll`, type: "effect", img: item.img, system: { start, tokenIcon: { show: true },
                duration: { value: 0, unit: "rounds", expiry: "turn-end", sustained: false },
                rules: [{ key: "RollTwice", selector: "spell-attack-roll", keep: "higher", removeAfterRoll: true }],
                description: { value: `<p>${read.table.join(" ")}</p>` } } },
            { name: `${item.name}: temporarily immune to Sure Strike`, type: "effect", img: item.img, system: { start, tokenIcon: { show: false },
                duration: { value: read.immunityMinutes, unit: "minutes", expiry: "turn-start", sustained: false } } }]);
        await say(`the next spell attack roll this turn is rolled twice. ${read.table.join(" ")} (the table's).`);
        return { effects: made.map(effect => effect.uuid) };
    }
    if (read.kind === "don-visage") {
        // ("Requirements You used your most recent action to Cast a Spell or make a melee Spellstrike": the caster's latest spell; then the Arcana check against the level's DC —
        // the visage, the module's Effect, for 3 rounds or 4 on a critical success.)
        const cast = game.messages.contents.slice(-30).reverse().find(entry => entry.flags?.pf2e?.casting && entry.actor === actor && entry.item);
        if (!cast) { await say("you haven't Cast a Spell."); return { refused: "requirement" }; }
        const roll = await actor.skills?.[read.skill]?.roll({ dc: { value: levelDC(actor.level) }, skipDialog: true, label: `${item.name}: don the visage` });
        const degree = Number(roll?.degreeOfSuccess ?? -1);
        if (degree < 2) { await say("the visage isn't donned."); return { degree }; }
        const template = await loadNativeEffectTemplate(read.effect.uuid);
        if (!template) return { degree, effect: null };
        const source = template.toObject(); delete source._id;
        foundry.utils.setProperty(source, "_stats.compendiumSource", read.effect.uuid);
        source.system.duration = { ...(source.system.duration ?? {}), value: degree === 3 ? read.rounds.criticalSuccess : read.rounds.success, unit: "rounds" };
        const [made] = await actor.createEmbeddedDocuments("Item", [source]);
        await say(`the visage is donned for ${source.system.duration.value} rounds. ${read.table.join(" ")} (the table's).`);
        return { degree, effect: made?.uuid ?? null, rounds: source.system.duration.value };
    }
    if (read.kind === "residual-summon") {
        const spell = await fromUuid(read.spell.uuid).catch(() => null);
        const api = game.modules.get(MODULE_ID)?.api;
        if (!spell || !api) return null;
        const rank = Math.max(1, Math.floor(Number(actor.level ?? 1) / 2));
        const summonUuid = message.flags?.[MODULE_ID]?.actionCastChoice?.summonUuid ?? undefined;
        const result = await api.execute(spell, { sourceActor: actor, plan: await api.compile(spell), castRank: rank, tradition: read.tradition, requireTraits: [residual.trait], skipConfirmation: true, targets: [], ...(summonUuid ? { summonUuid } : {}) });
        if (result?.status === "applied") await residual.effect.delete();
        return { ...result, trait: residual.trait, rank };
    }
    return null;
}

/**
 * Triplicate Casting's casts: each of the three (a different non-cantrip spell, its one-action version) noted; the slots given back so only the highest-rank cast's stays spent —
 * the earlier highest given back when a later one is higher. The arming lapses after the third, at another turn, or on a cast that doesn't qualify.
 */
export async function triplicateOnCast(message) {
    if (!game.users.activeGM?.isSelf || !message?.flags?.pf2e?.casting) return null;
    const actor = message.actor, spell = message.item;
    const armed = actor?.getFlag(MODULE_ID, "triplicate");
    if (!armed || !spell) return null;
    const turn = game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : null;
    const { refundSlot } = await import("./spellshape-runtime.js");
    const traits = spell.system?.traits?.value ?? [];
    const time = String(spell.system?.time?.value ?? "");
    const say = text => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${armed.name}</strong>: ${text}</p>` }).catch(() => null);
    if (armed.combat !== turn || traits.includes("cantrip") || traits.includes("focus") || !/^1(?:\b| to | or |-)/.test(time) || armed.casts.some(entry => entry.spellId === spell.id)) {
        await actor.unsetFlag(MODULE_ID, "triplicate");
        await say(`${spell.name} isn't one of its casts (a different non-cantrip spell cast with one action, this turn); ended after ${armed.casts.length}.`);
        return { ended: armed.casts.length };
    }
    const rank = Number(message.flags.pf2e.casting.castRank ?? spell.rank ?? 1);
    const casts = [...armed.casts];
    const highest = casts.reduce((best, entry) => !best || entry.rank > best.rank ? entry : best, null);
    // (The new cast's slot back, unless it is now the highest — then the earlier highest's back.)
    if (highest && rank > highest.rank) {
        const earlier = actor.items.get(highest.spellId);
        await refundSlot(actor, earlier, highest.rank, armed.name);
        highest.refunded = true;
        casts.push({ spellId: spell.id, name: spell.name, rank, refunded: false });
    } else if (highest) {
        await refundSlot(actor, spell, rank, armed.name);
        casts.push({ spellId: spell.id, name: spell.name, rank, refunded: true });
    } else casts.push({ spellId: spell.id, name: spell.name, rank, refunded: false });
    if (casts.length >= armed.count) {
        await actor.unsetFlag(MODULE_ID, "triplicate");
        await say(`${casts.map(entry => `${entry.name} (${entry.rank})`).join(", ")} — one rank-${Math.max(...casts.map(entry => entry.rank))} slot spent.`);
    } else await actor.setFlag(MODULE_ID, "triplicate", { ...armed, casts });
    return { casts };
}

