// Spellshape feats and spell-changing wands at the table (src/compiler/spellshape-readers.js):
//   - the cast's spellshapes (PF2e's `spellshape:<feat>` roll options on the cast) and its wand (the caster's wand storing that spell), read into
//     riders and checked against the spell as PF2e shaped it, kept on the cast's message (`shaping`);
//   - PF2e's Spellshape selector switched off once the spell is cast ("If the next action you use is to Cast a Spell …");
//   - the riders applied on each creature after the spell's own outcome (the save card calls `applyShapeRiders`).
import { readSpellshapeFeat, readWand, unmetRequirement } from "../src/compiler/spellshape-readers.js";
import { applyDamageWithReceipt } from "./native-damage-receipt.js";
import { loadNativeEffectTemplate, prepareNativeEffectSource, createNativeEffect } from "./native-outcome-effects.js";
import { tokenDistance } from "./token-distance.js";
import { grantSummonBenefit } from "./summon-benefits.js";
import { forcedMove, adjacentFreeSpace } from "./forced-movement.js";
import { isThrall, destroyThrall } from "./thrall-tokens.js";
import { grantMinionControl } from "./minion-control-runtime.js";
import { armItemSpellshape, itemShapeFor, itemCastRider } from "./item-spellshape-runtime.js";
import { readItemSpellshape } from "../src/compiler/item-spellshape.js";
import { readPassiveCastRider, readActionCast } from "../src/compiler/plus-feature-rules.js";
import { startFollowingAura } from "./form-aura-runtime.js";
import { readActionShape } from "./spell-actions-runtime.js";
import { catalystCastRider, catalystSaveRider, catalystSummoned } from "./catalyst-runtime.js";
import { MODULE_ID, activeGM, escapeHTML, familiarOf } from "./runtime-utils.js";

// (A wand just used: its charge spent moments before or after its spell's card.)
const recentWandUse = new Map();

/** A wand's charge or overcharge spent: remembered briefly to tell apart two wands storing the same spell. */
export function noteWandUse(item, changes) {
    if (item?.type !== "consumable" || item.system?.category !== "wand" || !foundry.utils.hasProperty(changes, "system.uses.value")) return;
    recentWandUse.set(item.uuid, Date.now());
}

/** The facts of the spell as cast, for the requirements. */
export function spellFacts(spell) {
    const system = spell?.system ?? {};
    const traits = [...(system.traits?.value ?? [])];
    const damageTypes = Object.values(system.damage ?? {}).filter(entry => ![...(entry.kinds ?? ["damage"])].every(kind => kind === "healing")).map(entry => entry.type).filter(Boolean);
    const target = String(system.target?.value ?? "").trim();
    return { name: spell?.name ?? null, cantrip: traits.includes("cantrip"), damageTypes, area: system.area?.value ? { type: system.area.type, value: Number(system.area.value) } : null,
        hasDuration: Boolean(String(system.duration?.value ?? "").trim()) || system.duration?.sustained === true, saveStatistic: system.defense?.save?.statistic ?? null,
        singleTarget: /^(?:1|one|a single) (?:[a-z]+ )*(?:creature|enemy|ally|target)\b/i.test(target), traits,
        range: String(system.range?.value ?? "").trim(), targeted: Boolean(target), rank: spell?.rank ?? null, attack: traits.includes("attack") || system.defense?.passive?.statistic === "ac",
        // ("from your spell slots": a prepared or spontaneous entry's non-cantrip.)
        fromSlots: spell?.spellcasting ? Boolean((spell.spellcasting.isPrepared || spell.spellcasting.isSpontaneous) && !traits.includes("cantrip") && !traits.includes("focus")) : spell ? false : null,
        actions: /^[123]$/.test(String(system.time?.value ?? "")) ? Number(system.time.value) : null,
        // (A prepared entry's spell; a spell that heals — its healing trait or healing damage entry.)
        prepared: spell?.spellcasting ? Boolean(spell.spellcasting.isPrepared) : spell ? false : null,
        // (Invoke Infernal Potency: "cast … as an innate spell".)
        innate: spell?.spellcasting ? Boolean(spell.spellcasting.isInnate ?? spell.spellcasting.system?.prepared?.value === "innate") : spell ? false : null,
        healing: spell ? traits.includes("healing") || Object.values(system.damage ?? {}).some(entry => [...(entry.kinds ?? [])].includes("healing")) : null,
        // (The highest rank the caster can cast, for "at least 2 ranks below your maximum rank".)
        highest: spell?.actor ? highestCastableRank(spell.actor) : null,
        // (Storm Spell's "Your cursebound value is 2 or greater and you're in an encounter".)
        cursebound: spell?.actor ? Number(spell.actor.getCondition?.("cursebound")?.value ?? 0) : null,
        // ("Your mystic link is active": Magic+'s Mystic Link Effect on the caster.)
        mysticLink: spell?.actor ? Boolean(mysticLinkEffect(spell.actor)) : null,
        // (A wicket's "while within the area" of its dominion; "from Focus Points or spell slots".)
        inWicketDominion: spell?.actor ? Boolean(wicketDominionOf(spell.actor)) : null,
        fromFocus: traits.includes("focus"),
        // (Magus+: "You're in Arcane Cascade" — the stance's roll option, as the module's own rules read it; "you are wearing heavy armor".)
        inArcaneCascade: spell?.actor ? (spell.actor.getRollOptions?.() ?? []).includes("self:effect:arcane-cascade") : null,
        heavyArmor: spell?.actor ? (spell.actor.wornArmor?.category ?? spell.actor.itemTypes?.armor?.find(item => item.isEquipped)?.category ?? null) === "heavy" : null,
        // (Raging: PF2e's Effect: Rage on the caster.)
        raging: spell?.actor ? (spell.actor.itemTypes?.effect ?? []).some(effect => effect.slug === "effect-rage" || effect.name === "Effect: Rage") : null,
        inEncounter: spell?.actor ? Boolean(game.combat?.started && game.combat.combatants.some(combatant => combatant.actor?.uuid === spell.actor.uuid)) : null };
}

/** A wicketeer's wicket traits: its wicket feat's ("Wicket Traits fire, light"), or the module's flag. */
export function readCasterWicketTraits(actor) {
    const fromFeats = (actor?.itemTypes?.feat ?? []).flatMap(item => { const read = readPassiveCastRider(item.toObject()); return read?.requires?.inWicketDominion ? read.requires.anyTraits ?? [] : []; });
    return [...new Set(fromFeats.length ? fromFeats : Object.values(actor?.flags?.pf2e?.wicketTraits ?? {}).filter(Boolean))];
}

/** Whether a token stands in the caster's wicket dominion. */
export function inDominionOf(caster, token) {
    const doc = token?.document ?? token;
    return Boolean(doc && canvas?.scene?.regions.some(region => region.flags?.[MODULE_ID]?.casterDominion?.casterUuid === caster?.uuid && tokenInRegion(doc, region)));
}

/** The caster's wicket dominion it stands in (Manifest Wicket Dominion's region), or null. */
export function wicketDominionOf(actor) {
    const token = actor?.getActiveTokens?.(true, true)?.[0];
    if (!token || !canvas?.scene) return null;
    return canvas.scene.regions.find(region => region.flags?.[MODULE_ID]?.casterDominion?.casterUuid === actor.uuid && tokenInRegion(token.document ?? token, region)) ?? null;
}

// (Magic+'s Effect: Mystic Link — the link between a caster and its mystic duo.)
const MYSTIC_LINK = "STG8oFxUFAza45zv";
/** An actor's Effect: Mystic Link, or null. */
export function mysticLinkEffect(actor) {
    return (actor?.itemTypes?.effect ?? []).find(effect => String(effect._stats?.compendiumSource ?? effect.sourceId ?? "").endsWith(MYSTIC_LINK) || effect.name === "Effect: Mystic Link") ?? null;
}
/** The caster's mystic duo: the other creature on the scene linked with it — its link made by the caster, or the caster's made by it; with one linked creature, that one. */
export function mysticDuoOf(caster) {
    const own = mysticLinkEffect(caster);
    if (!own) return null;
    const originOf = effect => effect?.system?.context?.origin?.actor ?? effect?.origin?.uuid ?? null;
    const linked = (canvas?.scene?.tokens ?? []).map(token => token.actor).filter(actor => actor && actor !== caster && mysticLinkEffect(actor));
    return linked.find(actor => originOf(mysticLinkEffect(actor)) === caster.uuid) ?? linked.find(actor => originOf(own) === actor.uuid) ?? (linked.length === 1 ? linked[0] : null);
}

/** The wand this cast came from: the caster's wand storing the same spell at the same rank (the one just used, when there are several). */
function castWand(actor, message) {
    const embedded = message.flags?.pf2e?.casting?.embeddedSpell;
    if (!embedded) return null;
    const rank = Number(embedded.system?.location?.heightenedLevel ?? embedded.system?.level?.value);
    const wands = (actor.itemTypes?.consumable ?? []).filter(item => item.system?.category === "wand" && item.system.spell?.name === embedded.name
        && Number(item.system.spell.system?.location?.heightenedLevel ?? item.system.spell.system?.level?.value) === rank);
    if (wands.length <= 1) return wands[0] ?? null;
    return [...wands].sort((a, b) => (recentWandUse.get(b.uuid) ?? 0) - (recentWandUse.get(a.uuid) ?? 0))[0];
}

/**
 * A spellshape feat used — its card posted — arms it for the caster's next spell, an Effect until the end of the turn ("If the next action you use is
 * to Cast a Spell"). The only way for a feat PF2e gives no selector (Knockback Spell, Dizzying Spell); for the others, the same as the selector.
 */
export async function armSpellshape(message) {
    // (A wand for any spell that PF2e keeps no spell in — Wand of Reaching —: its card posted is its activation, for the next spell cast.)
    // (A consumable wand PF2e keeps no spell in — Wand of Caustic Effluence —: the same, its card the activation.)
    const origin = message?.flags?.pf2e?.origin?.type;
    if (!activeGM() || !["feat", "equipment", "consumable", "weapon", "action"].includes(origin)) return null;
    const feat = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    // (An action that changes the next spell — Draw From the Pages: spell-actions-runtime.js readActionShape.)
    if (origin === "action") {
        if (!feat?.actor || !(readActionShape(feat.toObject()) || readSpellshapeFeat(feat.toObject()))) return null;
        if ((feat.actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.pendingSpellshape?.featUuid === feat.uuid)) return null;
        return pendingShapeEffect(feat.actor, feat, "Action");
    }
    // (An item whose activation is a spellshape — a grimoire, ring, tattoo, rune, weapon or potion: item-spellshape-runtime.js.)
    if (feat && origin !== "feat" && !isWandItem(feat)) return armItemSpellshape(message, feat);
    // (A "+" action that casts on its own — Become Elemental: text-rules.js actionCastOnCard —, not the next spell's.)
    if (feat && readActionCast(feat.toObject())) return null;
    if (origin === "consumable" && (feat?.system?.category !== "wand" || feat.system?.spell)) return null;
    const type = origin === "consumable" ? "equipment" : origin;
    const actor = feat?.actor;
    if (!actor) return null;
    // (A feat with no spellshape trait that changes the next spell — River's Reflection: read from its text, as the actions are.)
    if (type === "feat" && !(feat.system?.traits?.value ?? []).includes("spellshape")) {
        // (Or a "+" action read as a spellshape — Slot-Charged Spell: plus-spellshapes.js.)
        if (!(readActionShape(feat.toObject()) || readSpellshapeFeat(feat.toObject())) || (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.pendingSpellshape?.featUuid === feat.uuid)) return null;
        return pendingShapeEffect(actor, feat, "Next spell");
    }
    // (Coven Spell: a reaction to an ally's casting — PF2e's Effect on that ally now, not the caster's next spell.)
    const coven = type === "feat" ? readSpellshapeFeat(feat.toObject())?.riders?.find(rider => rider.type === "coven" && rider.uuid) : null;
    if (coven) {
        const casterToken = actor.getActiveTokens?.(true, true)?.[0];
        const allies = casterToken ? tokensWithin(casterToken, 30).filter(token => token.actor !== actor && token.actor.alliance && token.actor.alliance === actor.alliance) : [];
        // (The trigger — "An ally within 30 feet Casts a Spell": the ally who cast last; asked only when no such cast is found.)
        const lastCaster = game.messages.contents.slice(-20).reverse().find(entry => entry.id !== message.id && entry.flags?.pf2e?.casting && allies.some(token => token.actor === entry.actor))?.actor ?? null;
        const pickedUuid = lastCaster?.uuid ?? await riderChoice({ name: feat.name, choice: null }, "Which ally's spell?", allies.map(token => ({ value: token.actor.uuid, label: token.name })));
        const ally = allies.find(token => token.actor.uuid === pickedUuid)?.actor;
        const template = ally ? await loadNativeEffectTemplate(coven.uuid) : null;
        return template ? createNativeEffect(ally, prepareNativeEffectSource(template, { castInstanceId: message.id, castRank: 1, sourceActorUuid: actor.uuid, sourceItemUuid: feat.uuid, sourceItemName: feat.name, resolutionKind: "save", targetActorUuid: ally.uuid })) : null;
    }
    if (type === "equipment" && !(feat.system?.traits?.value ?? []).includes("wand") || type === "equipment" && !readWand(feat.toObject())) return null;
    if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.pendingSpellshape?.featUuid === feat.uuid)) return null;
    return pendingShapeEffect(actor, feat, type === "feat" ? "Spellshape" : "Wand");
}

/** A wand: a consumable wand, or equipment with the wand trait. */
export const isWandItem = item => item?.type === "consumable" ? item.system?.category === "wand" : item?.type === "equipment" && (item.system?.traits?.value ?? []).includes("wand");

/** The Effect that arms a feat, wand or item for the caster's next spell this turn (its pending data: which activation, what was armed). */
export async function pendingShapeEffect(actor, feat, kind, pending = {}) {
    const combat = game.combat?.started ? game.combat : null;
    const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${kind}: ${feat.name} (next spell)`, type: "effect", img: feat.img ?? "icons/svg/aura.svg",
        flags: { [MODULE_ID]: { pendingSpellshape: { featUuid: feat.uuid, ...pending }, turnBound: combat ? { combatId: combat.id, round: combat.round, turn: combat.turn } : { worldTime: game.time.worldTime + 6 } } },
        system: { duration: { value: 1, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
            description: { value: `<p>${escapeHTML(feat.name)} shapes the next spell ${escapeHTML(actor.name)} casts this turn.</p>` } } }]);
    return effect;
}

/** An Effect from a shape on a creature: its rules, and how long ("until the beginning of your next turn": ended as the caster's turn starts). */
export async function shapeEffect(target, caster, name, rules, { rounds = 1, until = null, thisTurn = false, flags = {}, img = "icons/svg/aura.svg", description = "" } = {}) {
    const combat = game.combat?.started ? game.combat : null;
    const bound = until === "caster-turn-start" && combat ? { turnBound: { untilStartOf: caster.uuid, combatId: combat.id, startedAt: { round: combat.round, turn: combat.turn } } }
        : until === "caster-next-turn-end" && combat ? { turnBound: { actorUuid: caster.uuid, combatId: combat.id, startedAt: { round: combat.round, turn: combat.turn } } } : {};
    const [made] = await target.createEmbeddedDocuments("Item", [{ name, type: "effect", img,
        flags: { [MODULE_ID]: { spellshapeRider: { label: name }, ...bound, ...flags } },
        system: { duration: thisTurn ? { value: 0, unit: "rounds", expiry: "turn-end", sustained: false } : { value: rounds, unit: "rounds", expiry: until === "caster-next-turn-end" ? "turn-end" : "turn-start", sustained: false },
            start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null }, tokenIcon: { show: true }, rules: foundry.utils.deepClone(rules),
            ...(description ? { description: { value: `<p>${escapeHTML(description)}</p>` } } : {}) } }]);
    return made;
}

/** Temporary Hit Points that last a while: the higher of the current and the new (they don't stack), gone with the Effect. */
export async function timedTempHp(actor, amount, label, rounds) {
    const current = Number(actor.system?.attributes?.hp?.temp ?? 0);
    if (!(amount > current)) return { label: `${label}: ${amount} temporary Hit Points (has ${current})`, status: "skipped" };
    await actor.update({ "system.attributes.hp.temp": amount });
    await shapeEffect(actor, actor, `${label}: ${amount} temporary Hit Points`, [], { rounds, flags: { formRiders: { tempExpires: true, tempGranted: amount } } });
    return { label: `${label}: ${amount} temporary Hit Points`, status: "applied" };
}

/** The slot (or prepared spell, or innate use) PF2e spent for the cast, given back. */
export async function refundSlot(actor, spell, rank, label) {
    const entry = spell?.spellcasting ?? actor.spellcasting?.get?.(spell?.system?.location?.value ?? "") ?? null;
    const traits = spell?.system?.traits?.value ?? [];
    if (!entry || traits.includes("cantrip") || traits.includes("focus")) return { label: `${label}: no slot was spent`, status: "skipped" };
    const key = `slot${rank}`;
    if (entry.isPrepared && !entry.isFlexible) {
        const prepared = entry.system?.slots?.[key]?.prepared ?? [];
        const index = prepared.findIndex(slot => slot.id === spell.id && slot.expended);
        if (index < 0) return { label: `${label}: no spent ${spell.name} prepared at rank ${rank}`, status: "manual" };
        await entry.spells.setSlotExpendedState(rank, index, false);
    } else if (entry.isInnate) {
        const owned = actor.items.get(spell.id);
        const uses = owned?.system?.location?.uses;
        if (!uses) return { label: `${label}: no innate uses to give back`, status: "manual" };
        await owned.update({ "system.location.uses.value": Math.min(Number(uses.max ?? uses.value + 1), Number(uses.value) + 1) });
    } else {
        const slot = entry.system?.slots?.[key];
        if (!slot) return { label: `${label}: no rank-${rank} slots`, status: "manual" };
        await entry.update({ [`system.slots.${key}.value`]: Math.min(Number(slot.max), Number(slot.value) + 1) });
    }
    return { label: `${label}: the rank-${rank} slot not spent`, status: "applied" };
}

const ELEMENTS = ["air", "earth", "fire", "metal", "water", "wood"];
/**
 * The riders that act as the spell is cast (family E): the caster's resistance (Energy Ablation, Elemental Defense), PF2e's Effect on the caster
 * (Current Spell, Skeletal Extension), Dualistic Synergy's benefit by tradition, an Effect on the caster or an ally within reach (Familiar's Resolve).
 */
async function applyCastRiders(actor, message, shapes, facts, spell, rank) {
    const results = [];
    for (const shape of shapes) for (const rider of shape.riders ?? []) {
        // (An item's own riders: item-spellshape-runtime.js.)
        const own = await itemCastRider(actor, message, shape, rider, facts, spell, rank);
        if (own) { results.push(...own); continue; }
        // (A catalyst's: catalyst-runtime.js.)
        const catalyst = await catalystCastRider(actor, message, shape, rider, spell, rank);
        if (catalyst) { results.push(...catalyst); continue; }
        if (rider.type === "note" && rider.atCast) {
            // (A catalyst's part the module doesn't carry: the GM's, with the cast.)
            try { await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(shape.name)}</strong> (GM): ${escapeHTML(rider.text)}</p>` }); } catch (_) {}
            results.push({ label: `${shape.name}: the GM's note`, status: "manual" });
            continue;
        }
        if (rider.type === "self-rules") {
            // (Dueling Wand: a bonus for this cast — its value by the caster's level.)
            const rules = foundry.utils.deepClone(rider.rules).map(rule => rule.value?.byLevel ? { ...rule, value: [...rule.value.byLevel].reverse().find(([level]) => Number(actor.level ?? 1) >= level)?.[1] ?? 0 }
                : rule.value === "ringBonus" ? { ...rule, value: powerRingBonus(actor) } : rule);
            if (rules.some(rule => rule.value === 0)) { results.push({ label: `${shape.name}: no bonus (no power ring)`, status: "skipped" }); continue; }
            // (Sacrificial Spell: for that cast's roll only — gone with the spell's next damage or healing roll.)
            // ("until the spell ends": the spell's duration.)
            const spellRounds = rider.forSpell ? shapeSpellFacts(spell)?.durationRounds ?? 10 : 1;
            const made = await shapeEffect(actor, actor, `${shape.name}: ${rider.label}`, rules, { rounds: spellRounds, thisTurn: rider.thisTurn === true, until: rider.until ?? null, description: rider.description ?? "",
                flags: rider.untilRoll && spell ? { spellshapeUntilRoll: { spellUuid: spell.uuid, spellSlug: spell.slug ?? null } } : {} });
            results.push({ label: `${shape.name}: ${rider.label}`, status: "applied", effectUuid: made?.uuid ?? null });
            continue;
        }
        if (rider.type === "self-damage") {
            // (Havok Cascade: damage equal to the level, untyped; "If you resist this damage, remove it, or otherwise avoid taking it, your havok action automatically fails".)
            // (Doubled under Essence Mystic Dedication's Effect: "doubling the damage from your havok cascade until the beginning of your next turn".)
            const doubled = (actor.itemTypes?.effect ?? []).some(effect => effect.name === "Effect: Essence Mystic Dedication");
            // (Black Book Hex: "spirit damage equal to the rank of the hex".)
            const amount = (rider.formula === "level" ? Number(actor.level ?? 1) : rider.formula === "rank" ? Number(rank ?? 1) : Number(rider.formula)) * (doubled && (rider.ifTraits ?? []).includes("havok") ? 2 : 1);
            const hp = () => Number(actor.hitPoints?.value ?? 0) + Number(actor.system?.attributes?.hp?.temp ?? 0);
            const before = hp();
            const DamageRollClass = CONFIG.Dice.rolls.find(cls => cls.name === "DamageRoll"); const roll = await new DamageRollClass(`{${amount}[${rider.damageType ?? "untyped"}]}`).evaluate();
            await actor.applyDamage({ damage: roll, token: actor.getActiveTokens?.(true, true)?.[0] ?? undefined, item: spell ?? undefined, rollOptions: new Set(["havok"]) }).catch(() => null);
            const taken = before - hp();
            if (rider.failsIfAvoided && taken < amount) {
                const { loseSpell } = await import("./casting-rules-runtime.js");
                await loseSpell(message, `fails (${shape.name}: ${taken} of ${amount} damage taken)`);
            }
            results.push({ label: `${shape.name}: ${actor.name} takes ${taken} of ${amount} damage${rider.failsIfAvoided && taken < amount ? " — the action fails" : ""}`, status: "applied", taken, amount });
            continue;
        }
        if (rider.type === "spellstrike") {
            // (Magus+'s "Make a Spellstrike …": the cast delivered by the caster's next Strike, with what the variant adds on that Strike's degree — spell-actions-runtime.js
            // deliveryOnStrike.)
            // (Whirling Wand Strike: a Spellstrike only if the caster says so.)
            if (rider.ask && await riderChoice(shape, rider.ask, [{ value: "yes", label: "Spellstrike" }, { value: "no", label: "Cast and Strike apart" }]) !== "yes") { results.push({ label: `${shape.name}: cast and Strike apart`, status: "skipped" }); continue; }
            const attack = (spell?.system?.traits?.value ?? []).includes("attack") || spell?.system?.defense?.passive?.statistic === "ac";
            // (Whirling Wand Strike's bonus to the Spellstrike's damage — half the spell's rank —, on the caster until that damage roll.)
            if (rider.selfRules) {
                const rules = foundry.utils.deepClone(rider.selfRules).map(rule => rule.value === "halfRank" ? { ...rule, value: Math.floor(Number(rank) / 2) } : rule).filter(rule => rule.value !== 0);
                if (rules.length) { const made = await shapeEffect(actor, actor, `${shape.name}: damage`, rules, { thisTurn: true }); results.push({ label: `${shape.name}: +${rules[0].value} status to the Spellstrike's damage`, status: "applied", effectUuid: made?.uuid ?? null }); }
            }
            // (Eat This!: the module's own toggle for the scatter radius, on for that Strike.)
            let rollOption = null;
            if (rider.rollOption && shape.uuid) {
                const feat = await fromUuid(shape.uuid).catch(() => null);
                if (feat?.actor === actor) { await actor.toggleRollOption("all", rider.rollOption, feat.id, true).catch(() => null); rollOption = { option: rider.rollOption, itemId: feat.id }; }
            }
            if (rider.note) results.push({ label: `${shape.name}: ${rider.note.replace("{rank}", String(rank))}`, status: "note" });
            // (Scissored Assault: the mystic duo's Strike delivers it; Big Shot: the caster's next attack roll with the makeshift spellgun.)
            const duo = rider.striker === "duo" ? mysticDuoOf(actor) : null;
            if (rider.striker === "duo" && !duo) { results.push({ label: `${shape.name}: no mystic duo is linked`, status: "skipped" }); continue; }
            const variant = rider.rows || rider.hit || rider.always ? { name: shape.name, rows: rider.rows ?? null, hit: rider.hit ?? null, always: rider.always ?? null, choice: shape.choice ?? null } : null;
            await message.setFlag(MODULE_ID, "strikeDelivery", { kind: rider.kind ?? "spellstrike", name: rider.kind ? shape.name : "Spellstrike", attack, at: Date.now(),
                ...(duo ? { strikerUuid: duo.uuid } : {}), ...(rider.striker === "spellgun" ? { spellgunId: actor.flags?.pf2e?.trackedItems?.makeshiftSpellgun ?? null } : {}),
                ...(rider.dual ? { dual: rider.dual } : {}), ...(variant ? { variant } : {}), ...(rollOption ? { rollOption } : {}) });
            results.push({ label: `${shape.name}: delivered by ${duo ? `${duo.name}'s Strike` : rider.striker === "spellgun" ? "the spellgun's Activation" : "a Spellstrike"}`, status: "applied" });
            continue;
        }
        if (rider.type === "replace-spell") {
            // (Constructed Spark: "you gain the effects of a Summon Construct spell of the highest rank spell you can cast instead of the normal effects of the spell".)
            const replacement = await fromUuid(rider.replacement.uuid).catch(() => null);
            const api = game.modules.get(MODULE_ID)?.api;
            if (!replacement || !api) { results.push({ label: `${shape.name}: ${rider.replacement.name} is unavailable`, status: "failed" }); continue; }
            const highest = highestCastableRank(actor);
            await message.setFlag(MODULE_ID, "replacedBy", { name: rider.replacement.name, rank: highest });
            const result = await api.execute(replacement, { sourceActor: actor, plan: await api.compile(replacement), castRank: highest, tradition: spell?.spellcasting?.tradition ?? null, skipConfirmation: true, targets: [],
                ...(typeof shape.choice === "string" && shape.choice.startsWith("Compendium.") ? { summonUuid: shape.choice } : {}) }).catch(error => ({ status: "failed", error: error.message }));
            results.push({ label: `${shape.name}: ${rider.replacement.name} at rank ${highest} in place of ${spell?.name}`, status: result?.status === "applied" ? "applied" : "failed", actorUuid: result?.actorUuid ?? null });
            continue;
        }
        if (rider.type === "dominion-creature-effect") {
            // (Fabricator: "choose a specific creature within the area of your wicket's dominion. The creature takes a –2 … or a +2 … while within the area" — the creature and the
            // choice asked; the Effect gone with the dominion.)
            const dominion = wicketDominionOf(actor);
            const tokens = dominion ? canvas.scene.tokens.filter(token => token.actor && tokenInRegion(token, dominion)) : [];
            if (!tokens.length) { results.push({ label: `${shape.name}: no creature in the dominion`, status: "skipped" }); continue; }
            const pickedUuid = await riderChoice({ ...shape, choice: shape.choice?.creature ?? null }, "Which creature in your dominion?", tokens.map(token => ({ value: token.actor.uuid, label: token.name })));
            const target = tokens.find(token => token.actor.uuid === pickedUuid)?.actor;
            const optionValue = await riderChoice({ ...shape, choice: shape.choice?.option ?? null }, `${target?.name ?? "The creature"}: which?`, rider.options.map(entry => ({ value: entry.value, label: entry.label })));
            const option = rider.options.find(entry => entry.value === optionValue);
            if (!target || !option) continue;
            const made = await shapeEffect(target, actor, `${shape.name}: ${option.label}`, option.rules, { rounds: 10, flags: { whileRegionUuid: dominion.uuid } });
            await made?.update({ "system.duration": { value: -1, unit: "unlimited", expiry: null, sustained: false } });
            results.push({ label: `${shape.name}: ${target.name} ${option.label}`, status: "applied", effectUuid: made?.uuid ?? null });
            continue;
        }
        if (rider.type === "magnet-pull") {
            // (Magnetor: "Choose 2 creatures within the area of your wicket's dominion. Both … attempt a Fortitude save … Creatures that fail … are pushed 10 feet towards the other".)
            const dominion = wicketDominionOf(actor);
            const tokens = dominion ? canvas.scene.tokens.filter(token => token.actor && token.actor !== actor && tokenInRegion(token, dominion)) : [];
            const picked = (await riderPickMany({ ...shape, choice: Array.isArray(shape.choice) ? shape.choice : shape.choice?.pick ?? null }, `Which ${rider.count} creatures?`, tokens.map(token => ({ value: token.actor.uuid, label: token.name })))).slice(0, rider.count);
            const chosen = tokens.filter(token => picked.includes(token.actor.uuid));
            if (chosen.length !== rider.count) { results.push({ label: `${shape.name}: choose ${rider.count} creatures in the dominion`, status: "skipped" }); continue; }
            const dc = shapeDC(actor, spell);
            for (const [index, token] of chosen.entries()) {
                const other = chosen[1 - index];
                const roll = await token.actor.saves?.[rider.statistic]?.roll({ dc: { value: dc }, skipDialog: true, extraRollOptions: ["magnetor"] });
                const failed = Number(roll?.degreeOfSuccess ?? 3) <= 1;
                if (!failed) { results.push({ label: `${shape.name}: ${token.name} resists`, status: "applied" }); continue; }
                const size = canvas.grid.size;
                const point = { x: other.x + Number(other.width ?? 1) * size / 2, y: other.y + Number(other.height ?? 1) * size / 2 };
                const moved = await forcedMove(token, { point, direction: "toward", feet: rider.feet, stopAt: other, reason: shape.name }).catch(() => null);
                results.push({ label: `${shape.name}: ${token.name} pulled ${moved?.moved ? moved.squares * 5 : 0} feet toward ${other.name}`, status: moved?.moved ? "applied" : "manual" });
            }
            continue;
        }
        if (rider.type === "self-persistent") {
            // (Power of Blood: "When you Cast a Spell from your spell slots, you take persistent bleed damage equal to the rank of the spell. This persistent bleed
            // damage bypasses any resistances or immunities.")
            // (PF2e's persistent-damage condition made directly, whatever the caster's immunities; its later ticks' resistances the GM's to ignore — a reminder on it.)
            const amount = rankFormula(rider.formula, { castRank: rank }, actor);
            const condition = game.pf2e?.ConditionManager?.getCondition?.("persistent-damage")?.toObject();
            if (!condition) { results.push({ label: `${shape.name}: PF2e's persistent damage condition is unavailable`, status: "failed" }); continue; }
            condition.system.persistent = { formula: String(amount), damageType: rider.damageType, dc: 15 };
            if (rider.bypass) foundry.utils.setProperty(condition, "system.description.value", `<p>${escapeHTML(shape.name)}: this persistent ${escapeHTML(rider.damageType)} damage bypasses ${escapeHTML(actor.name)}'s resistances and immunities.</p>`);
            await actor.createEmbeddedDocuments("Item", [condition]);
            results.push({ label: `${shape.name}: ${actor.name} takes ${amount} persistent ${rider.damageType}${rider.bypass ? " (bypassing resistances and immunities)" : ""}`, status: "applied" });
            continue;
        }
        if (rider.type === "duo-effect") {
            // (Eldritch Resilience: the module's Effect on the duo — its temporary Hit Points the rank times 2, or 1 for a cantrip — gone with the link.)
            const duo = mysticDuoOf(actor);
            if (!duo) { results.push({ label: `${shape.name}: no mystic duo is linked`, status: "skipped" }); continue; }
            const template = await loadNativeEffectTemplate(rider.uuid);
            if (!template) { results.push({ label: `${shape.name}: ${rider.name} is missing`, status: "failed" }); continue; }
            const times = facts.cantrip ? rider.cantripTimes : rider.times;
            const source = prepareNativeEffectSource(template, { castInstanceId: message.id, castRank: rank, sourceActorUuid: actor.uuid, sourceItemUuid: spell?.uuid ?? null, sourceItemName: spell?.name ?? shape.name, resolutionKind: "save", targetActorUuid: duo.uuid });
            source.system.level = { value: rank };
            const choice = (source.system.rules ?? []).find(rule => rule.key === "ChoiceSet");
            if (choice) { choice.selection = times; foundry.utils.setProperty(source, `flags.pf2e.rulesSelections.${choice.flag ?? "mod"}`, times); }
            const link = mysticLinkEffect(duo);
            if (rider.whileLinked && link) foundry.utils.setProperty(source, `flags.${MODULE_ID}.spellshapeTie`, { tiedTo: [link.uuid] });
            const made = await createNativeEffect(duo, source);
            results.push({ label: `${shape.name}: ${duo.name} gains ${times * rank} temporary Hit Points`, status: "applied", effectUuid: made?.uuid ?? null });
            continue;
        }
        if (rider.type === "hp-cost") {
            // (Draining Cast: "reduce your Hit Points by twice the rank of the spell. This is not damage".)
            const amount = Number(rankFormula(rider.formula, { castRank: rank }, actor));
            const hp = actor.system?.attributes?.hp;
            await actor.update({ "system.attributes.hp.value": Math.max(0, Number(hp?.value ?? 0) - amount) });
            results.push({ label: `${shape.name}: ${actor.name} loses ${amount} Hit Points (not damage)`, status: "applied" });
            continue;
        }
        if (rider.type === "self-resistance") {
            const types = rider.fromTraits ? facts.traits.filter(trait => ELEMENTS.includes(trait))
                // (The scepter's "one energy type the spell could deal": of the listed types, the spell's.)
                : [await riderChoice(shape, "Resistance to which damage type?", rider.choice.filter(type => !rider.spellTypesOnly || facts.damageTypes.includes(type)).map(type => ({ value: type, label: type })))].filter(Boolean);
            if (!types.length) continue;
            const value = rider.value === "2rank" ? 2 * rank : rank;
            const made = await shapeEffect(actor, actor, `${shape.name}: resistance ${value} (${types.join(", ")})`, types.map(type => ({ key: "Resistance", type, value })), { until: rider.until });
            results.push({ label: `${shape.name}: resistance ${value} to ${types.join(", ")}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "self-effect") {
            const template = await loadNativeEffectTemplate(rider.uuid);
            if (!template) { results.push({ label: `${shape.name}: ${rider.name} is unavailable`, status: "failed" }); continue; }
            const source = prepareNativeEffectSource(template, { castInstanceId: message.id, castRank: rank, sourceActorUuid: actor.uuid, sourceItemUuid: spell?.uuid ?? null, sourceItemName: spell?.name ?? shape.name, resolutionKind: "save", targetActorUuid: actor.uuid });
            // (Wildblood Infusion's damage type: the spell's — asked when it has several; without damage, the rage damage keeps its type.)
            if (rider.choiceFromDamage) {
                const choiceRule = (source.system?.rules ?? []).find(rule => rule.key === "ChoiceSet");
                const types = [...new Set(shapeSpellFacts(spell).damageTypes)];
                const picked = types.length ? await riderChoice(shape, "Which damage type?", types.map(value => ({ value, label: value }))) : null;
                if (choiceRule && picked) { choiceRule.selection = picked; foundry.utils.setProperty(source, `flags.pf2e.rulesSelections.${choiceRule.flag}`, picked); }
                else source.system.rules = (source.system.rules ?? []).filter(rule => rule !== choiceRule && !(rule.key === "AdjustModifier" && /rulesSelections/.test(String(rule.damageType ?? ""))));
            }
            // (One at a time: a later cast's replaces it.)
            if (rider.replace) for (const old of (actor.itemTypes?.effect ?? []).filter(effect => effect.name === template.name || effect.name.startsWith(`${template.name} (`))) await old.delete();
            // (Current Spell's element: the spell's — asked when it has both.)
            if (rider.choiceFromTraits) {
                const choiceRule = (source.system?.rules ?? []).find(rule => rule.key === "ChoiceSet");
                const offered = (choiceRule?.choices ?? []).map(choice => choice.value).filter(value => facts.traits.includes(value));
                const picked = offered.length === 1 ? offered[0] : offered.length ? await riderChoice(shape, "Which element?", offered.map(value => ({ value, label: value }))) : null;
                if (choiceRule && picked) { choiceRule.selection = picked; foundry.utils.setProperty(source, `flags.system.rulesSelections.${choiceRule.flag ?? "element"}`, picked); }
            }
            const made = await createNativeEffect(actor, source);
            results.push({ label: `${shape.name}: ${template.name}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "tradition-benefit") {
            const tradition = message.flags?.pf2e?.casting?.tradition ?? spell?.spellcasting?.tradition ?? null;
            const both = rider.both && facts.traits.includes(rider.both);
            if (tradition === "arcane" || both) {
                const bonus = rank >= rider.arcane.fromRank ? rider.arcane.higher : rider.arcane.bonus;
                const made = await shapeEffect(actor, actor, `${shape.name}: +${bonus} to Recall Knowledge`, [{ key: "FlatModifier", selector: "skill-check", type: "status", value: bonus, predicate: ["action:recall-knowledge"] }], { thisTurn: true });
                results.push({ label: `${shape.name}: +${bonus} to Recall Knowledge after the spell`, status: "applied", effectUuid: made?.uuid ?? null });
            }
            if (tradition === "primal" || both) results.push(await timedTempHp(actor, rank, shape.name, rider.primal.rounds));
        } else if (rider.type === "damage-material") {
            // ("your choice of cold iron, silver, or steel"; adamantine from 14th level): chosen as the spell is cast.
            const choices = [...rider.choice, ...(rider.byLevel && Number(actor.level ?? 0) >= rider.byLevel.level ? [rider.byLevel.add] : [])];
            rider.chosen = await riderChoice(shape, "Which metal?", choices.map(value => ({ value, label: value.replace(/-/g, " ") }))) ?? null;
            if (rider.chosen) results.push({ label: `${shape.name}: the damage is ${rider.chosen.replace(/-/g, " ")}`, status: "applied" });
        } else if (rider.type === "nonlethal" && rider.optional) {
            // (Wand of Mercy: "can choose to give it the nonlethal trait".)
            rider.chosen = (await riderChoice(shape, "Nonlethal?", [{ value: "yes", label: "Nonlethal" }, { value: "no", label: "Lethal" }])) !== "no";
        } else if (rider.type === "cast-heal") {
            // (Healing Transformation: "restores 1d6 Hit Points per spell rank to that creature" — the spell's one creature: the caster, or the target.)
            const targetToken = facts.targeted ? [...(game.user?.targets ?? [])][0] ?? null : null;
            const healed = targetToken?.actor ?? actor;
            const roll = await new Roll(`${rider.dice * (rider.perRank ? rank : 1)}d${rider.faces}`).evaluate();
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(shape.name)}</strong>: healing for ${escapeHTML(healed.name)}` }).catch(() => null);
            await healed.applyDamage({ damage: -roll.total, token: healed.getActiveTokens?.(true, true)?.[0], skipIWR: true, rollOptions: new Set(["item:trait:healing"]) });
            results.push({ label: `${shape.name}: ${healed.name} regains ${roll.total} Hit Points`, status: "applied" });
        } else if (rider.type === "terrain" && rider.where === "placed-burst") {
            // (Garland Spell: "a garland of plants grows in a 10-foot burst in the spell's range" — grown from its card at the targeted token.)
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), flags: { [MODULE_ID]: { kind: "spellshape-garland", garland: { casterUuid: actor.uuid, name: shape.name, rider } } },
                content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(shape.name)}</strong>: a ${rider.feet}-foot burst of plants in the spell's range.</p><button type="button" data-pf2e-auto-terrain="garland">Grow it at the targeted token</button></section>` }); } catch (_) {}
            results.push({ label: `${shape.name}: the garland's card`, status: "applied" });
        } else if (rider.type === "echo") {
            // (Echoing Spell: "You can Cast the Spell a second time before the end of your next turn without expending a spell slot.")
            const made = await shapeEffect(actor, actor, `${shape.name}: cast ${spell?.name ?? "the spell"} again without a slot`, [], { rounds: 1, until: "caster-next-turn-end",
                flags: { spellshapeEcho: { spellId: spell?.id ?? null, rank } } });
            results.push({ label: `${shape.name}: ${spell?.name ?? "the spell"} can be cast again without a slot before the end of the next turn`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "note" && rider.wandRule) {
            // (A wand's own rule the module doesn't apply: told to the GM once, as the spell is cast.)
            if (shape.notedAtCast) continue;
            shape.notedAtCast = true;
            const lines = (shape.riders ?? []).filter(entry => entry.type === "note" && entry.wandRule).map(entry => entry.text.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, "$1").replace(/@(?:Damage|Check|Template)\[([^\]]+)\](?:\{([^}]+)\})?/g, (all, inner, label) => label ?? inner));
            try { await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(shape.name)}</strong> (GM): ${lines.map(escapeHTML).join(" ")}</p>` }); } catch (_) {}
            results.push({ label: `${shape.name}: the GM's part told`, status: "manual" });
        } else if (rider.type === "mythic-proficiency" && rider.optional) {
            // (Cyrusian Wand: "If you spend 1 Mythic Point as part of this activation, resolve the spell's effects at mythic proficiency.")
            rider.chosen = (await riderChoice(shape, "Spend a Mythic Point (mythic proficiency)?", [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }])) === "yes";
        } else if (rider.type === "counteract-effect" || (rider.type === "counteract-affliction" && rider.anyAffliction)) {
            // (Wand of Mental Purification: "can attempt to counteract one mental effect on the same target", its rank 1 higher; Arboreal Wand: "the lowest
            // level affliction affecting your target", at half the wand's item level: the module's counteract card, on the targeted creature.)
            const target = [...(game.user?.targets ?? [])][0] ?? null;
            if (!target) { results.push({ label: `${shape.name}: target the creature for its counteract`, status: "manual" }); continue; }
            const wandItem = shape.uuid ? await fromUuid(shape.uuid).catch(() => null) : null;
            const operation = rider.type === "counteract-effect" ? { op: "counteract", source: "effect", pick: 1, traits: rider.traits, grantsConditions: [] }
                : { op: "counteract", source: "affliction", pick: 1, traits: [], grantsConditions: [], anyAffliction: true };
            // (The counteract rank: half the wand's item level, or the spell's rank raised by the wand — "Treat the Soothe spell's rank as 1 higher".)
            const careRank = (rider.rank === "half-item-level" ? Math.ceil(Number(wandItem?.level ?? wandItem?.system?.level?.value ?? 1) / 2) : rank) + Number(rider.rankBonus ?? 0);
            const plan = { source: { name: shape.name }, automation: { pendingCapabilities: [] }, resolution: { kind: "affliction-care", recipient: "target", modes: [], operations: [operation] } };
            const choice = shape.choice && typeof shape.choice === "object" ? shape.choice : null;
            await game.modules.get(MODULE_ID).api.care.start(spell, plan, { sourceActor: actor, castRank: careRank, targets: [target], ...(choice ? { choices: choice } : {}) })
                .catch(error => results.push({ label: `${shape.name}: ${error.message}`, status: "failed" }));
            results.push({ label: `${shape.name}: the counteract on ${target.name}`, status: "applied" });
        } else if (rider.type === "turn-start-heal") {
            // (Wand of Overflowing Life: at the start of the caster's next turn, the 1-action Heal at 3rd rank — once a turn however many such wands.)
            for (const old of (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.spellshapeTurnHeal)) await old.delete().catch(() => null);
            const combat = game.combat?.started ? game.combat : null;
            await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: healing as the next turn starts`, type: "effect", img: "icons/svg/regen.svg",
                flags: { [MODULE_ID]: { spellshapeTurnHeal: { rank: rider.rank, spell: rider.spell, actions: rider.actions, label: shape.name, combatId: combat?.id ?? null, startedAt: combat ? { round: combat.round, turn: combat.turn } : null } } },
                system: { duration: { value: 2, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null }, tokenIcon: { show: true } } }]);
            results.push({ label: `${shape.name}: ${rider.spell} (${rider.actions} action, ${rider.rank}${["st", "nd", "rd"][rider.rank - 1] ?? "th"} rank) as the next turn starts`, status: "applied" });
        } else if (["thorns", "haze-orbs", "failed-check-damage", "first-success-worse", "turn-start-barrage", "duration-scale", "echo-recast", "damage-exposes"].includes(rider.type)) {
            results.push(...await wandWatch(actor, message, shape, rider, facts, spell, rank));
        } else if (rider.type === "refract") {
            // (Wand of Refracting Rays: "if you hit the target, the light refracts to another creature within 30 feet of the first target" — the button, after a hit.)
            const first = castTargetActors(message, actor).find(target => target !== actor);
            await postRefractCard(actor, { name: shape.name, rank, rider, spellUuid: spell?.uuid ?? null, spellSource: spell?.toObject?.() ?? null, chain: first ? [first.uuid] : [], from: first?.uuid ?? null });
            results.push({ label: `${shape.name}: it can refract after a hit`, status: "applied" });
        } else if (["granted-burst", "spotlight", "teeming", "image-shards"].includes(rider.type) || (rider.type === "terrain" && rider.where === "placed-square")) {
            const label = { "granted-burst": "Chromatic Armor Burst (the armored creature targeted)", spotlight: "Center of attention", teeming: "Raise the targeted creature's frightened to 2 (ends false vitality)",
                "image-shards": "An image was destroyed by the targeted creature", terrain: "Rolling flames at the targeted token (the sphere's square)" }[rider.type];
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), flags: { [MODULE_ID]: { kind: "spellshape-card", shapeCard: { casterUuid: actor.uuid, castId: message.id, spellUuid: spell?.uuid ?? null, name: shape.name, rank, rider, armoredUuid: rider.type === "granted-burst" ? ([...(game.user?.targets ?? [])][0]?.actor?.uuid ?? actor.uuid) : null } } },
                content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(shape.name)}</strong></p><button type="button" data-pf2e-auto-shape-card="go">${escapeHTML(label)}</button></section>` }); } catch (_) {}
            results.push({ label: `${shape.name}: its card`, status: "applied" });
        } else if (rider.type === "allies-sense") {
            // (Shared Sight: "all affected allies gain your spiritsense for 1 minute" — the allies the spell targets.)
            for (const token of [...(game.user?.targets ?? [])].filter(token => token.actor && token.actor !== actor && token.actor.alliance === actor.alliance)) {
                await shapeEffect(token.actor, actor, `${shape.name}: ${rider.sense}`, [{ key: "Sense", selector: rider.sense }], { rounds: rider.rounds });
                results.push({ label: `${shape.name}: ${token.name} gains ${rider.sense}`, status: "applied" });
            }
        } else if (rider.type === "shroud") {
            // (Spell Shroud: everyone in the 15-foot mist Concealed until the caster's next turn starts.)
            const casterToken = actor.getActiveTokens?.(true, true)?.[0];
            for (const token of casterToken ? [casterToken, ...tokensWithin(casterToken, rider.within)] : []) results.push(...await timedConditions(token.actor, [{ ...rider.condition, until: "caster-turn-start" }], shape.name, { caster: actor }));
        } else if (rider.type === "allies-effect") {
            // (Vigorous Anthem: PF2e's Effect on the caster and every ally in the anthem's area.)
            const template = await loadNativeEffectTemplate(rider.uuid);
            const casterToken = actor.getActiveTokens?.(true, true)?.[0];
            const reach = Number(facts.area?.value ?? 60);
            const recipients = [actor, ...(casterToken ? tokensWithin(casterToken, reach).filter(token => token.actor !== actor && token.actor.alliance && token.actor.alliance === actor.alliance).map(token => token.actor) : [])];
            for (const recipient of template ? recipients : []) {
                await createNativeEffect(recipient, prepareNativeEffectSource(template, { castInstanceId: message.id, castRank: rank, sourceActorUuid: actor.uuid, sourceItemUuid: spell?.uuid ?? null, sourceItemName: spell?.name ?? shape.name, resolutionKind: "save", targetActorUuid: recipient.uuid }));
                results.push({ label: `${shape.name}: ${recipient.name}`, status: "applied" });
            }
        } else if (rider.type === "self-conditions") {
            results.push(...await timedConditions(actor, rider.list, shape.name, { caster: actor }));
        } else if (rider.type === "restore-prepared") {
            // (Arclord's Codex: "You regain access to two spells of 4th rank or lower or one spell of 5th rank or higher that you've prepared and already cast
            // today." — the caster's expended prepared slots, picked: up to the count of one of the two sizes; the slot this cast spent isn't one of them.)
            const slots = [];
            for (const entry of (actor.itemTypes?.spellcastingEntry ?? []).filter(item => item.isPrepared ?? item.system?.prepared?.value === "prepared"))
                for (const [key, slot] of Object.entries(entry.system?.slots ?? {})) (slot.prepared ?? []).forEach((prepared, index) => {
                    const slotRank = Number(key.replace("slot", ""));
                    if (!prepared?.id || !prepared.expended || slotRank < 1 || (prepared.id === spell?.id && slotRank === Number(rank))) return;
                    slots.push({ value: `${entry.id}|${key}|${index}`, rank: slotRank, label: `Rank ${slotRank}: ${actor.items.get(prepared.id)?.name ?? "a prepared spell"} (${entry.name})` });
                });
            const fits = picked => rider.either.some(option => picked.length <= option.count && picked.every(slot => (option.maxRank == null || slot.rank <= option.maxRank) && (option.minRank == null || slot.rank >= option.minRank)));
            if (!slots.length) { results.push({ label: `${shape.name}: no prepared spell already cast today`, status: "skipped" }); continue; }
            const preset = Array.isArray(shape.choice) ? slots.filter(slot => shape.choice.includes(slot.value)) : null;
            const sizes = rider.either.map(option => `${option.count} of ${option.maxRank != null ? `rank ${option.maxRank} or lower` : `rank ${option.minRank} or higher`}`).join(", or ");
            const chosen = preset ?? await foundry.applications.api.DialogV2.prompt({ window: { title: `${shape.name}: spells regained` }, rejectClose: false,
                content: `<p>Pick ${escapeHTML(sizes)}.</p>${slots.map(slot => `<label><input type="checkbox" name="${escapeHTML(slot.value)}"> ${escapeHTML(slot.label)}</label>`).join("<br>")}`,
                ok: { label: "Regain", callback: (_event, button) => slots.filter(slot => button.form.elements[slot.value]?.checked) } });
            if (!chosen?.length) { results.push({ label: `${shape.name}: no spell regained`, status: "skipped" }); continue; }
            if (!fits(chosen)) { results.push({ label: `${shape.name}: pick ${sizes}`, status: "failed" }); continue; }
            for (const slot of chosen) {
                const [entryId, key, index] = slot.value.split("|");
                await actor.items.get(entryId)?.update({ [`system.slots.${key}.prepared.${index}.expended`]: false });
            }
            results.push({ label: `${shape.name}: regained ${chosen.map(slot => slot.label).join("; ")}`, status: "applied" });
        } else if (rider.type === "self-increase") {
            // (Invoke Infernal Potency: "You then increase the value of your doomed condition by 1.")
            const before = Number(actor.getCondition?.(rider.slug)?.value ?? 0);
            for (let step = 0; step < Number(rider.by ?? 1); step++) await actor.increaseCondition(rider.slug).catch(() => null);
            results.push({ label: `${shape.name}: ${rider.slug} ${before} → ${Number(actor.getCondition?.(rider.slug)?.value ?? 0)}`, status: "applied" });
        } else if (["ally-heal", "arrival", "delayed-burst", "surge", "control-card", "landing"].includes(rider.type) || (rider.type === "card" && rider.center !== "target")) {
            results.push(...await castCards(actor, message, shape, rider, facts, spell, rank));
        } else if (rider.type === "slot-refund") {
            // ("you don't expend the spell's slot when you cast it": PF2e spent it as the spell was cast; given back.)
            results.push(await refundSlot(actor, spell, rank, shape.name));
        } else if (rider.type === "ally-effect") {
            const casterToken = actor.getActiveTokens?.(true, true)?.[0] ?? null;
            const allies = [actor, ...(casterToken ? canvas.scene.tokens.filter(token => token.actor && token.actor !== actor && token.actor.alliance === actor.alliance && token.actor.alliance && tokenDistance(casterToken, token) <= rider.within).map(token => token.actor) : [])];
            const pickedUuid = await riderChoice(shape, "Who gains it?", [...new Map(allies.map(ally => [ally.uuid, { value: ally.uuid, label: ally.name }])).values()]);
            const target = allies.find(ally => ally.uuid === pickedUuid);
            if (!target) continue;
            const value = rider.byLevel && Number(actor.level ?? 0) >= rider.byLevel.level ? rider.byLevel.value : null;
            const rules = foundry.utils.deepClone(rider.rules).map(rule => value != null && rule.key === "FlatModifier" ? { ...rule, value } : rule);
            const made = await shapeEffect(target, actor, `${shape.name}: ${value != null ? rider.name.replace(/^\+\d+/, `+${value}`) : rider.name}`, rules, { rounds: rider.rounds });
            results.push({ label: `${shape.name}: ${target.name}`, status: "applied", effectUuid: made?.uuid ?? null });
        }
    }
    return results;
}

/** The spell's own area at the cast rank, before any spellshape: its data, with PF2e's fixed heightening ("a 10-foot burst at 3rd"). */
export function baseArea(spell, rank) {
    const system = spell?._source?.system ?? spell?.system ?? {};
    let area = system.area?.value ? { type: system.area.type, value: Number(system.area.value) } : null;
    if (system.heightening?.type === "fixed") for (const [level, data] of Object.entries(system.heightening.levels ?? {}).sort((a, b) => Number(a[0]) - Number(b[0])))
        if (Number(level) <= Number(rank) && data?.area?.value) area = { type: data.area.type ?? area?.type, value: Number(data.area.value) };
    return area;
}

/** An area grown by a shape's rules — the first that fits ("Add 5 feet to the radius of a burst that normally has a radius of at least 10 feet"). */
export function grownArea(area, grow, { hasDuration = false } = {}) {
    if (!area) return null;
    const rule = grow.find(entry => entry.types.includes(area.type) && (entry.min == null || area.value >= entry.min) && (entry.max == null || area.value <= entry.max)
        && (entry.over == null || area.value > entry.over) && (!entry.withDuration || hasDuration));
    return rule ? { ...area, value: area.value + rule.add } : area;
}

/**
 * A spell-like card's stand-in spell source, for spellFacts — a card that counts as a spell without being one (a kineticist's 2-action impulse:
 * api.castingRules.onSpellLike). `like`: { actor, name, traits, elements, rank, actions, damageTypes, area, range, target, saveStatistic, attack, cantrip }.
 */
export function spellLikeSource(like) {
    const traits = [...new Set([...(like.traits ?? []), ...(like.elements ?? []), ...(like.cantrip ? ["cantrip"] : [])])];
    return { name: like.name ?? null, rank: Number(like.rank ?? 1), actor: like.actor ?? null, spellcasting: null,
        system: { traits: { value: traits }, damage: Object.fromEntries((like.damageTypes ?? []).map((type, index) => [String(index), { type, kinds: ["damage"] }])),
            target: { value: like.target ?? "" }, range: { value: like.range ?? "" }, area: like.area?.value ? { type: like.area.type, value: Number(like.area.value) } : null,
            duration: { value: "" }, time: { value: String(like.actions ?? "") },
            defense: { save: like.saveStatistic ? { statistic: like.saveStatistic } : null, passive: like.attack ? { statistic: "ac" } : null } } };
}

/**
 * A spell cast: its spellshapes and wand read and kept on the message; the Spellshape selector switched off. With `spellLike` (a card that counts
 * as a spell: spellLikeSource's description), the same for that card — its facts from the description, no spell item, wand or slot.
 */
export async function recordShaping(message, { spellLike = null } = {}) {
    // (A cast: PF2e's "spell-cast" card, or — for a spell with no save, attack or damage, such as Pest Form — the card with its casting and no roll.)
    const pf2e = message?.flags?.pf2e;
    const isCast = spellLike || pf2e?.context?.type === "spell-cast" || (!pf2e?.context?.type && pf2e?.origin?.type === "spell" && pf2e?.casting);
    if (!activeGM() || !isCast || message.getFlag(MODULE_ID, "shaping")) return null;
    const actor = spellLike?.actor ?? message.actor;
    if (!actor) return null;
    // (Let PF2e's own wand bookkeeping land first.)
    await new Promise(resolve => setTimeout(resolve, 250));
    const options = spellLike ? [] : message.flags.pf2e.context?.options ?? [];
    // (Without the card's options, the selector as it stands — still on until this cast switches it off.)
    const selector = actor.synthetics?.toggles?.all?.spellshape;
    const selected = (spellLike || !message.flags.pf2e.context) && selector?.checked ? selector.suboptions?.find(entry => entry.selected)?.value ?? null : null;
    const slugs = [...new Set([...options.map(option => /^spellshape:(.+)$/.exec(option)?.[1]), selected].filter(Boolean))];
    const spell = spellLike ? null : message.item ?? null;
    const facts = spellFacts(spellLike ? spellLikeSource(spellLike) : spell);
    // (Cast from a wand — Whirling Wand Strike's "a spell from a wand".)
    facts.fromWand = !spellLike && Boolean(castWand(actor, message));
    const shapes = [];
    // (Echoing Spell's second casting: the slot given back, the echo spent.)
    const echo = (actor.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.spellshapeEcho?.spellId && effect.flags[MODULE_ID].spellshapeEcho.spellId === spell?.id);
    if (echo) {
        const refunded = await refundSlot(actor, spell, Number(message.flags?.pf2e?.origin?.castRank ?? spell?.rank ?? 1), echo.name.replace(/:.*$/, ""));
        await echo.delete().catch(() => null);
        shapes.push({ name: `${echo.name.replace(/:.*$/, "")} (the echo)`, kind: "feat", uuid: null, read: true, riders: [], requires: null, unmet: null, echoed: refunded });
    }
    for (const slug of slugs) {
        // (The feat whose selector set it: its slug, or a feat offering that suboption.)
        // (A "+" module's spellshape may be an action: Bleeding Spell.)
        // (Or a "+" item's selector — Power Ring's "Veracious Spell" —: its activation of that name.)
        const shapers = [...actor.itemTypes.feat, ...(actor.itemTypes.action ?? []), ...(actor.itemTypes.equipment ?? []), ...(actor.itemTypes.weapon ?? []), ...(actor.itemTypes.consumable ?? [])];
        const offers = item => (item.system.rules ?? []).find(rule => rule.key === "RollOption" && rule.option === "spellshape" && (rule.suboptions ?? []).some(entry => entry.value === slug));
        const feat = shapers.find(item => ["feat", "action"].includes(item.type) && item.slug === slug) ?? shapers.find(item => offers(item));
        let read = feat && ["feat", "action"].includes(feat.type) ? readSpellshapeFeat(feat.toObject()) : null;
        if (feat && !["feat", "action"].includes(feat.type)) {
            const label = offers(feat)?.suboptions?.find(entry => entry.value === slug)?.label;
            const activations = readItemSpellshape(feat.toObject())?.activations ?? [];
            const activation = activations.find(entry => entry.label === label) ?? (activations.length === 1 ? activations[0] : null);
            read = activation ? { requires: activation.requires, riders: activation.riders } : null;
        }
        const unmet = read ? unmetRequirement(read.requires, facts) : null;
        shapes.push({ name: feat?.name ?? slug, kind: "feat", uuid: feat?.uuid ?? null, read: !!read, riders: read && !unmet ? read.riders : [], requires: read?.requires ?? null, unmet });
    }
    // (A curse on the caster that changes every spell — Sarenrae's Major Curse: "All attacks you make, spells you cast, and other sources of damage you deal
    // are nonlethal except against fiends and undead … You deal minimum damage except against fiends and undead. All creatures except fiends and undead
    // gain a +4 status bonus to their AC and saving throws against your attacks and other effects.")
    for (const curse of actor.itemTypes?.feat ?? []) {
        const text = String(curse.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        if (!/spells you cast, and other sources of damage you deal are nonlethal except against fiends and undead/.test(text)) continue;
        shapes.push({ name: curse.name, kind: "curse", uuid: curse.uuid, read: true, requires: null, unmet: null,
            riders: [{ type: "nonlethal", exceptTraits: ["fiend", "undead"] }, { type: "note", wandRule: true, text: "You deal minimum damage except against fiends and undead, and all creatures except fiends and undead gain a +4 status bonus to their AC and saving throws against your effects." }] });
    }
    // (A feature's rule on every spell its holder casts — Power of Blood's bleed: plus-feature-rules.js. Silent when the spell isn't one it applies to.)
    // (A rider for some of the spell's traits only — a wicket's fire part —; from a level — Overwhelming Wicket at 11th —; a threaded one once a round.)
    const roundStamp = game.combat?.started ? `${game.combat.id}:${game.combat.round}` : `t${Math.floor(game.time.worldTime / 6)}`;
    // (Wicket Infusion: the spell "still triggers the effects of your tethered magic effects as if it had one of your wicket traits" — the chosen trait, for these only.)
    let passiveFacts = facts;
    for (const effect of (actor.itemTypes?.effect ?? []).filter(entry => entry.flags?.[MODULE_ID]?.pendingSpellshape)) {
        const feat = await fromUuid(effect.flags[MODULE_ID].pendingSpellshape.featUuid).catch(() => null);
        const infuse = feat ? readSpellshapeFeat(feat.toObject())?.riders?.find(rider => rider.type === "infuse-trait") : null;
        if (!infuse) continue;
        // (The wicket's traits: its feat's — "Wicket Traits fire, light" —, or the module's flag.)
        const fromFeats = (actor.itemTypes?.feat ?? []).flatMap(item => { const read = readPassiveCastRider(item.toObject()); return read?.requires?.inWicketDominion ? read.requires.anyTraits ?? [] : []; });
        const traits = [...new Set(fromFeats.length ? fromFeats : Object.values(actor.flags?.pf2e?.wicketTraits ?? {}).filter(Boolean))];
        const picked = traits.length ? await riderChoice({ name: feat.name, choice: effect.flags[MODULE_ID].pendingSpellshape.choice ?? null }, "Which wicket trait do you infuse?", traits.map(trait => ({ value: trait, label: trait }))) : null;
        if (picked) passiveFacts = { ...passiveFacts, traits: [...new Set([...passiveFacts.traits, picked])] };
    }
    // (Worn items too — a power ring's rune: Embodiment.)
    const worn = item => item.system?.equipped?.carryType === "worn" && !((item.system?.traits?.value ?? []).includes("invested") && item.system?.equipped?.invested === false);
    for (const item of [...(actor.itemTypes?.feat ?? []), ...(actor.itemTypes?.effect ?? []), ...(actor.itemTypes?.equipment ?? []).filter(worn)]) {
        const passive = readPassiveCastRider(item.toObject());
        if (!passive || passive.tableOnly || unmetRequirement(passive.requires, passiveFacts)) continue;
        let riders = passive.riders.filter(rider => (!rider.ifTraits || rider.ifTraits.some(trait => passiveFacts.traits.includes(trait))) && (!rider.minLevel || Number(actor.level ?? 0) >= rider.minLevel));
        if (riders.some(rider => rider.threaded)) {
            if (actor.getFlag(MODULE_ID, "threadedRound") === roundStamp) riders = riders.filter(rider => !rider.threaded);
            else if (riders.some(rider => rider.threaded && rider.type !== "table")) await actor.setFlag(MODULE_ID, "threadedRound", roundStamp);
        }
        if (!riders.length) continue;
        // (Essence Mystic Dedication: the conflux spell given the havok trait, if the caster chooses — then a havok spell for the riders after it, with the module's Effect.)
        const havok = riders.find(rider => rider.type === "havok-choice");
        if (havok) {
            const preset = actor.getFlag(MODULE_ID, "passiveChoices")?.[item.name] ?? null;
            const answer = await riderChoice({ name: item.name, choice: preset }, `Give ${spell?.name ?? "the spell"} the havok trait?`, [{ value: "yes", label: "Give it the havok trait" }, { value: "no", label: "No" }]);
            if (answer !== "yes") continue;
            passiveFacts = { ...passiveFacts, traits: [...new Set([...passiveFacts.traits, "havok"])] };
            const template = await loadNativeEffectTemplate(havok.effect.uuid);
            if (template) {
                const source = template.toObject(); delete source._id;
                foundry.utils.setProperty(source, "_stats.compendiumSource", havok.effect.uuid);
                source.system.rules = (source.system.rules ?? []).map(rule => rule.key === "RollOption" && rule.toggleable ? { ...rule, value: true } : rule);
                source.system.duration = { value: 1, unit: "rounds", expiry: "turn-start", sustained: false };
                const combat = game.combat?.started ? game.combat : null;
                source.system.start = { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null };
                await actor.createEmbeddedDocuments("Item", [source]);
            }
            shapes.push({ name: item.name, kind: "passive", uuid: item.uuid, read: true, riders: [{ type: "table", text: `${spell?.name ?? "The spell"} has the havok trait: +1 status to its attacks, Havok Cascade's damage doubled until your next turn.` }], requires: passive.requires, unmet: null });
            continue;
        }
        const dominion = riders.some(rider => rider.whileDominion) ? wicketDominionOf(actor) : null;
        for (const rider of riders) if (rider.whileDominion) rider.whileRegionUuid = dominion?.uuid ?? null;
        shapes.push({ name: item.name, kind: "passive", uuid: item.uuid, read: true, riders, requires: passive.requires, unmet: null, choice: actor.getFlag(MODULE_ID, "passiveChoices")?.[item.name] ?? null });
    }
    // (A spell shaping the caster's casts of another for its duration — Fractal Frosting's Frostbite; Unleash True Power's every other spell.)
    for (const effect of actor.itemTypes?.effect ?? []) {
        const shaper = effect.flags?.[MODULE_ID]?.castShaper;
        // (Unleash True Power: every spell but itself — "*".)
        if (shaper && (shaper.spellSlug === "*" ? spell && spell.slug !== shaper.except : spell?.slug === shaper.spellSlug)) shapes.push({ name: shaper.name, kind: "spell", uuid: effect.uuid, read: true, riders: foundry.utils.deepClone(shaper.riders), requires: null, unmet: null });
    }
    // (A feat armed by its card: used up by this cast — once, if its selector is on too.)
    const armed = (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.pendingSpellshape);
    for (const effect of armed) {
        const feat = await fromUuid(effect.flags[MODULE_ID].pendingSpellshape.featUuid).catch(() => null);
        if (feat && shapes.some(shape => shape.uuid === feat.uuid)) continue;
        const wandItem = isWandItem(feat);
        // (An item's activation: its riders, with the feat it borrows and what its activation armed.)
        const item = feat && (feat.type === "action" || (feat.type === "feat" && !(feat.system?.traits?.value ?? []).includes("spellshape"))) ? readActionShape(feat.toObject())
            : feat && feat.type !== "feat" && !wandItem ? await itemShapeFor(feat, effect.flags[MODULE_ID].pendingSpellshape) : null;
        // (A spellshape feat the feats' reader doesn't know — River's Reflection, an adventure's action — read as the actions are.)
        const read = item ?? (feat ? (wandItem ? readWand(feat.toObject()) : readSpellshapeFeat(feat.toObject()) ?? (feat.type === "feat" ? readActionShape(feat.toObject()) : null)) : null);
        const unmet = read ? unmetRequirement(read.requires, facts) : null;
        shapes.push({ name: feat?.name ?? effect.name, kind: item ? "item" : wandItem ? "wand" : "feat", uuid: feat?.uuid ?? null, read: !!read, riders: read && !unmet ? read.riders : [], requires: read?.requires ?? null, unmet,
            choice: effect.flags[MODULE_ID].pendingSpellshape.choice ?? null });
    }
    // (A wand PF2e gives a toggle — Wand of Widening's "wand-of-widening" —: on for this cast, then off.)
    for (const wandItem of spellLike ? [] : actor.itemTypes?.equipment ?? []) {
        if (!(wandItem.system?.traits?.value ?? []).includes("wand") || shapes.some(shape => shape.uuid === wandItem.uuid)) continue;
        const toggle = (wandItem.system.rules ?? []).find(rule => rule.key === "RollOption" && rule.toggleable && (options.includes(rule.option) || (!message.flags.pf2e.context && actor.rollOptions?.all?.[rule.option])));
        if (!toggle) continue;
        const read = readWand(wandItem.toObject());
        const unmet = read ? unmetRequirement(read.requires, facts) : null;
        shapes.push({ name: wandItem.name, kind: "wand", uuid: wandItem.uuid, read: !!read, riders: read && !unmet ? read.riders : [], requires: read?.requires ?? null, unmet });
        await actor.toggleRollOption("all", toggle.option, wandItem.id, false).catch(() => null);
    }
    if (armed.length) await actor.deleteEmbeddedDocuments("Item", armed.map(effect => effect.id), { [MODULE_ID]: { reason: "spellshape-used" } }).catch(() => null);
    const wand = spellLike ? null : castWand(actor, message);
    if (wand) {
        const read = readWand(wand.toObject());
        if (read) shapes.push({ name: wand.name, kind: "wand", uuid: wand.uuid, read: true, riders: read.riders, unmet: null });
    }
    if (slugs.length) {
        // ("If the next action you use is to Cast a Spell": the selector goes off with this cast.)
        const toggle = actor.synthetics?.toggles?.all?.spellshape;
        // (PF2e merges the feats' selectors: switching off with the selected suboption updates every feat's copy.)
        const selected = toggle?.suboptions?.find(entry => entry.selected)?.value ?? slugs[0];
        if (toggle?.checked && toggle.itemId) await actor.toggleRollOption("all", "spellshape", toggle.itemId, false, selected).catch(() => null);
    }
    // (The Energy ring rune: Gather Power offered after a cast shaped by Veracious Spell that dealt energy damage.)
    if (shapes.some(shape => (shape.riders ?? []).some(rider => rider.veracious))) await offerGatherPower(actor, facts).catch(() => null);
    if (!shapes.length) return null;
    // (Chaotic Spell: the d6 rolled with the cast — its damage type and its rider.)
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "chaotic" && rider.results) {
        const roll = await new Roll(`1d${rider.die}`).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(shape.name)}</strong>: the spell's damage type` }).catch(() => null);
        rider.rolled = roll.total;
    }
    // (Widen, Growth Spell, a Wand of Widening: the area the cast's template must have — grown from the spell's own, so the same whether or not PF2e
    // enlarged it already.)
    let area = null;
    const castRank = spellLike ? Number(spellLike.rank ?? 1) : Number(message.flags?.pf2e?.origin?.castRank ?? spell?.rank ?? 0);
    const base = spellLike ? spellLikeSource(spellLike).system.area : baseArea(spell, castRank);
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "area" && rider.grow?.length) {
        const grown = grownArea(area ?? base, rider.grow, { hasDuration: facts.hasDuration });
        if (grown && base && grown.value > (area ?? base).value) area = grown;
    }
    // (Reach of the Dead: "you cast that spell from one of your thralls within 60 feet. … The thrall is then destroyed.")
    const notes = [];
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "thrall-origin" && rider.destroy) {
        const casterToken = actor.getActiveTokens?.(true, true)?.[0] ?? null;
        const thralls = canvas.scene?.tokens.filter(token => token.actor && isThrall(token.actor) && token.actor.flags?.[MODULE_ID]?.thrall?.casterUuid === actor.uuid
            && (!casterToken || tokenDistance(casterToken, token) <= rider.feet)) ?? [];
        if (!thralls.length) { notes.push(`${shape.name}: no thrall of ${actor.name}'s within ${rider.feet} feet.`); continue; }
        const pickedId = await riderChoice({ name: shape.name, choice: null }, "Which thrall is the spell's origin?", thralls.map(token => ({ value: token.id, label: token.name })));
        const thrall = thralls.find(token => token.id === pickedId) ?? thralls[0];
        await destroyThrall(thrall);
        rider.destroyed = thrall.name;
    }
    // (Split Hex's "reduce its rank by 2", Mythic Heightening's "the highest spell rank that you can cast", Simple Mastery's "1 rank higher, up to the
    // highest": the rank the cast resolves at.)
    let shapedRank = null;
    // (Slot-Charged Spell: a prepared slot spent — the caster's choice — for half its rank more, at least 1, up to the highest.)
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "slot-charge" && rider.by == null) {
        const slots = [];
        for (const entry of actor.spellcasting?.regular ?? []) if (entry.isPrepared) for (const [key, slot] of Object.entries(entry.system?.slots ?? {})) for (const [index, prepared] of Object.entries(slot.prepared ?? {}))
            if (prepared?.id && !prepared.expended && Number(key.replace("slot", "")) > 0 && !(entry.id === spell?.system?.location?.value && prepared.id === spell?.id))
                slots.push({ value: `${entry.id}|${key}|${index}`, label: `Rank ${key.replace("slot", "")}: ${actor.items.get(prepared.id)?.name ?? "a prepared spell"} (${entry.name})`, rank: Number(key.replace("slot", "")) });
        if (!slots.length) { notes.push(`${shape.name}: no prepared slot to expend.`); continue; }
        const picked = await riderChoice(shape, "Which prepared slot do you expend?", slots);
        const slot = slots.find(entry => entry.value === picked);
        if (!slot) continue;
        const [entryId, key, index] = slot.value.split("|");
        await actor.items.get(entryId)?.update({ [`system.slots.${key}.prepared.${index}.expended`]: true });
        rider.by = Math.max(rider.min, Math.floor(slot.rank / rider.divisor));
        rider.spent = slot.label;
        shape.riders.push({ type: "rank-change", by: rider.by, cap: "highest" });
    }
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "rank-change") {
        const highest = highestCastableRank(actor);
        const from = shapedRank ?? castRank;
        // (Draw From the Pages: "automatically heightened to a rank equal to half your level".)
        // (Invoke Infernal Potency: "a rank 1 lower than half your level rounded up" — never below the rank it has.)
        shapedRank = rider.to === "highest" ? Math.max(from, highest) : rider.to === "half-level" ? Math.max(1, Math.ceil(Number(actor.level ?? 1) / 2) + Number(rider.offset ?? 0), rider.offset ? from : 1)
            : Math.max(1, from + Number(rider.by ?? 0));
        if (rider.cap === "highest") shapedRank = Math.min(shapedRank, Math.max(highest, from));
        // ("up to a maximum of 10th-rank")
        else if (Number.isFinite(Number(rider.cap))) shapedRank = Math.min(shapedRank, Math.max(Number(rider.cap), from));
    }
    // (Riders for one named spell — Fury of a Thousand's Murmuration and Song of Strength —: only the cast spell's.)
    for (const shape of shapes) if ((shape.riders ?? []).some(rider => rider.spell)) shape.riders = shape.riders.filter(rider => !rider.spell || rider.spell === spell?.name);
    // (Compressed Spell: "–3 … If the size of the burst, cone, or line is greater than 30 feet, 45 feet, or 60 feet": the size the cast has.)
    const castArea = area ?? base;
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "compress")
        rider.penaltyNow = castArea && Number(castArea.value) > Number(rider.over?.[castArea.type] ?? Infinity) ? rider.bigPenalty : rider.penalty;
    // (Reshaped Spell: "you may alter the area of the spell to a line or a cone respectively" — the template's new shape.)
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "reshape" && castArea) rider.from = castArea.type, rider.to = rider.swap[castArea.type] ?? null;
    // (Transmute Spell: the essence and type chosen as it's used — among those whose damage the spell deals; "change all damage types that meet the
    // requirements"; Mind's additional mental damage a rider of its own.)
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "transmute" && !rider.chosen) {
        const options = rider.essences.filter(essence => essence.from.some(type => facts.damageTypes.includes(type)))
            .flatMap(essence => essence.to.map(type => ({ value: `${essence.name}:${type}`, label: `${essence.name}: ${type}` })));
        if (!options.length) { shape.unmet = "it deals none of the damage the essences change"; shape.riders = []; continue; }
        const picked = await riderChoice(shape, "the essence and damage type", options);
        const essence = rider.essences.find(entry => entry.name === String(picked).split(":")[0]);
        if (!essence) { shape.riders = []; continue; }
        rider.chosen = { essence: essence.name, to: String(picked).split(":")[1], from: facts.damageTypes.filter(type => essence.from.includes(type)), onlyWeakTo: essence.onlyWeakTo ?? null };
        if (essence.extra) shape.riders.push({ type: "flat-damage", when: "damaged", formula: essence.extra.formula, damageType: essence.extra.damageType });
    }
    // (Spell and Steel: "twice the rank of the spell or … the rank of the spell if the spell was a cantrip"; "the same type as your mystic duo's weapon".)
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "extra-damage" && (rider.cantripFormula || rider.damageTypeFrom)) {
        if (rider.cantripFormula && facts.cantrip) rider.formula = rider.cantripFormula;
        if (rider.damageTypeFrom === "duo-weapon" && !rider.damageType) {
            const duo = mysticDuoOf(actor);
            const types = [...new Set((duo?.itemTypes?.weapon ?? []).map(weapon => weapon.system?.damage?.damageType).filter(Boolean))];
            if (!types.length) { shape.unmet = duo ? `${duo.name} has no weapon` : "no mystic duo is linked"; shape.riders = []; continue; }
            rider.damageType = await riderChoice(shape, "the damage type of your mystic duo's weapon", types.map(type => ({ value: type, label: type })));
        }
    }
    // (An optional damage type — a wicket's "you can choose to deal spirit damage instead of fire damage" —: asked; its threaded riders follow it.)
    for (const shape of shapes) for (const rider of [...(shape.riders ?? [])]) if (rider.type === "damage-type" && rider.optional && rider.chosen == null) {
        const deals = facts.damageTypes.includes(rider.from);
        // (A preset answer: the shape's choice, or its `swap` when it holds several — a wicket's swap and its creatures.)
        const preset = shape.choice && typeof shape.choice === "object" && !Array.isArray(shape.choice) ? shape.choice.swap ?? null : shape.choice;
        rider.chosen = deals ? await riderChoice({ ...shape, choice: preset }, `Deal ${rider.to} damage instead of ${rider.from}?`, [{ value: "yes", label: `${rider.to}` }, { value: "no", label: `${rider.from}` }]) === "yes" : false;
        if (!rider.chosen) { shape.riders = shape.riders.filter(entry => entry !== rider); continue; }
        for (const other of shape.riders) if (other.followSwap && other.damageType === rider.from) other.damageType = rider.to;
    }
    // (A terrain's damage equal to the spell's rank, whatever its kind.)
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "terrain" && rider.where !== "area" && rider.hazard?.formula === "rank") rider.hazard.formula = String(shapedRank ?? castRank);
    // (Storm Spell's terrain: its damage the spell's rank, its rounds the cursebound value, its type chosen now — "chosen when you Cast the Spell".)
    for (const shape of shapes) for (const rider of shape.riders ?? []) if (rider.type === "terrain" && rider.where === "area") {
        if (rider.hazard?.formula === "rank") rider.hazard.formula = String(shapedRank ?? castRank);
        if (rider.rounds === "cursebound") rider.rounds = Math.max(1, Number(actor.getCondition?.("cursebound")?.value ?? 0));
        if (rider.hazard?.damageTypes && !rider.hazard.damageType) rider.hazard.damageType = await riderChoice(shape, "the terrain's damage type", rider.hazard.damageTypes.map(type => ({ value: type, label: type })));
    }
    await message.setFlag(MODULE_ID, "shaping", { shapes, ...(area ? { area: { type: area.type, from: base.value, to: area.value } } : {}), ...(shapedRank && shapedRank !== castRank ? { castRank: shapedRank } : {}),
        // (A spell-like card's own facts, for the readers that would read the spell: its damage types.)
        ...(spellLike ? { spellLike: { name: spellLike.name ?? null, rank: castRank, damageTypes: [...facts.damageTypes], traits: [...facts.traits] } } : {}) });
    // (Family E: the caster's — or a chosen ally's — benefits, as the spell is cast.)
    const castResults = await applyCastRiders(actor, message, shapes, facts, spell, castRank).catch(error => [{ label: `Spellshape: ${error.message}`, status: "failed" }]);
    // (With the cast's choices — a metal, nonlethal or not — kept on the riders.)
    await message.setFlag(MODULE_ID, "shaping", { ...message.getFlag(MODULE_ID, "shaping"), shapes, ...(castResults.length ? { castResults } : {}) });
    notes.unshift(...shapes.filter(shape => shape.unmet || !shape.read).map(shape => shape.unmet ? `${shape.name} doesn't apply: ${shape.unmet}.` : `${shape.name}: the module doesn't read this one; the GM applies it.`));
    if (notes.length) try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: game.users.filter(user => user.isGM).map(user => user.id),
        content: notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note)}</p>`).join("") }); } catch (_) {}
    return shapes;
}

/** The riders of the cast's message for a save card's state. */
export function shapeRidersFor(messageId) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    return (shaping?.shapes ?? []).filter(shape => shape.riders?.length).map(shape => ({ name: shape.name, requires: shape.requires ?? null, choice: shaping.choices?.[shape.name] ?? shape.choice ?? null,
        riders: shape.riders.flatMap(rider => rider.type === "chaotic" ? (rider.results?.[shaping.forcedRoll?.[shape.name] ?? rider.rolled]?.riders ?? []) : [rider]) }));
}

/** The damage type a shape changes the spell's to (Chaotic Spell's roll): {from: [types], to}, or null. */
export function shapeTypeSwapFor(messageId) {
    const message = messageId ? game.messages.get(messageId) : null;
    const shaping = message?.getFlag(MODULE_ID, "shaping") ?? null;
    // (The types the cast deals: the spell's, or a spell-like card's own.)
    const castTypes = () => { if (shaping?.spellLike) return shaping.spellLike.damageTypes ?? []; try { return spellFacts(message.item).damageTypes; } catch (_) { return []; } };
    // (Spiritual Secret: "it deals spirit damage instead of its normal type" — every type the spell deals.)
    // (River's Reflection: "All void damage becomes vitality damage and vice versa.")
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "damage-type-swap") {
        const types = castTypes();
        const [a, b] = rider.pair;
        if (types.includes(a)) return { from: [a], to: b, label: shape.name };
        if (types.includes(b)) return { from: [b], to: a, label: shape.name };
    }
    // (Transmute Spell: the chosen essence's types become the chosen one.)
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "transmute" && rider.chosen?.from?.length)
        return { from: rider.chosen.from.filter(type => type !== rider.chosen.to), to: rider.chosen.to, label: shape.name };
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "damage-type") {
        const types = castTypes();
        // (Only the named type — a wicket's "spirit damage instead of fire damage".)
        return { from: rider.from ? types.filter(type => type === rider.from) : types.filter(type => type !== rider.to), to: rider.to, label: shape.name };
    }
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "chaotic" && rider.results) {
        const face = shaping.forcedRoll?.[shape.name] ?? rider.rolled;
        const to = rider.results[face]?.damageType;
        if (to) return { from: [...new Set(Object.values(rider.results).map(entry => entry.damageType))].filter(type => type !== to), to, label: shape.name, face };
    }
    return null;
}

/** Reporting Spell: one enemy the spell affected (not immune), one fact the caster picks, whispered to the caster and the GM; that enemy immune for a day. */
async function reportingSpell(state, entries, shape, rider, caster) {
    const immune = actor => (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.spellshapeImmunity?.name === shape.name);
    const enemies = entries.filter(entry => entry.target.excluded !== true && entry.actor && entry.actor !== caster && !(entry.actor.alliance && entry.actor.alliance === caster.alliance) && !immune(entry.actor));
    if (!enemies.length) return [{ label: `${shape.name}: no enemy the spell affected can be learned about`, status: "skipped" }];
    const pickedUuid = await riderChoice(shape, "Which enemy do you learn about?", enemies.map(entry => ({ value: entry.actor.uuid, label: entry.actor.name })));
    const enemy = (enemies.find(entry => entry.actor.uuid === pickedUuid) ?? enemies[0]).actor;
    const attributes = enemy.attributes ?? enemy.system?.attributes ?? {};
    const weaknesses = attributes.weaknesses ?? [], resistances = attributes.resistances ?? [], immunities = attributes.immunities ?? [];
    const saves = ["fortitude", "reflex", "will"].map(slug => ({ slug, mod: Number(enemy.saves?.[slug]?.mod ?? enemy.system?.saves?.[slug]?.value ?? 0) }));
    const label = entry => `${entry.type}${entry.value != null ? ` ${entry.value}` : ""}`;
    const top = list => [...list].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))[0] ?? null;
    const lowest = [...saves].sort((a, b) => a.mod - b.mod)[0], highest = [...saves].sort((a, b) => b.mod - a.mod)[0];
    const facts = { weakness: top(weaknesses) ? `its highest weakness is ${label(top(weaknesses))}` : "it has no weakness",
        save: `its lowest save is ${lowest.slug} (${lowest.mod >= 0 ? "+" : ""}${lowest.mod})`,
        immunity: immunities.length ? `it is immune to ${label(immunities[0])}` : "it has no immunity",
        resistance: top(resistances) ? `its highest resistance is ${label(top(resistances))}` : "it has no resistance" };
    const pick = await riderChoice(shape, "What do you learn?", [["weakness", "Its highest weakness"], ["save", "Its lowest save"], ["immunity", "One immunity"], ["resistance", "Its highest resistance"]].map(([value, label]) => ({ value, label })));
    const lines = [facts[pick] ?? facts.weakness];
    // ("If your spell dealt damage the creature had an immunity, resistance, or weakness to, you automatically learn that …"; "if your spell targeted a save with the
    // lowest or highest modifier, you learn if it was the weakest or the highest".)
    const dealt = new Set((state.damage?.instances ?? []).map(instance => instance.type).filter(Boolean));
    for (const [list, word] of [[immunities, "immune"], [resistances, "resistant"], [weaknesses, "weak"]]) for (const entry of list) if (dealt.has(entry.type)) lines.push(`it is ${word} to ${label(entry)} (the spell's damage)`);
    const statistic = state.saveStatistic;
    // (By value: a save tied for the lowest is the weakest.)
    const targeted = saves.find(entry => entry.slug === statistic);
    if (targeted && targeted.mod === lowest.mod) lines.push(`${statistic} is ${targeted.mod === highest.mod ? "both its weakest and its highest save (all equal)" : "its weakest save"}`);
    else if (targeted && targeted.mod === highest.mod) lines.push(`${statistic} is its highest save`);
    const owners = game.users.filter(user => user.isGM || caster.testUserPermission?.(user, "OWNER")).map(user => user.id);
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), whisper: owners, content: `<p><strong>${escapeHTML(shape.name)}</strong> — ${escapeHTML(enemy.name)}: ${lines.map(line => escapeHTML(line)).join("; ")}.</p>` }); } catch (_) {}
    await enemy.createEmbeddedDocuments("Item", [{ name: `${shape.name}: immune`, type: "effect", img: "icons/svg/aura.svg", flags: { [MODULE_ID]: { spellshapeImmunity: { name: shape.name } } },
        system: { duration: { value: rider.immunityHours, unit: "hours", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false } } }]);
    return [{ label: `${shape.name}: ${enemy.name} — ${lines.join("; ")}`, status: "applied" }];
}

/** Enlightening Spell: the module's Effect on an ally the spell reached, when the caster is cursebound. */
export async function allyRecipientEffect(caster, actor, shape, rider, castId, rank, spell) {
    if (!caster || !actor || actor === caster || !(actor.alliance && actor.alliance === caster.alliance)) return null;
    if (rider.ifCursebound && !(Number(caster.getCondition?.("cursebound")?.value ?? 0) > 0)) return { label: `${shape.name}: ${caster.name} isn't cursebound (no bonus)`, status: "skipped" };
    const template = await loadNativeEffectTemplate(rider.uuid);
    if (!template) return { label: `${shape.name}: ${rider.name} is missing`, status: "failed" };
    const made = await createNativeEffect(actor, prepareNativeEffectSource(template, { castInstanceId: castId, castRank: rank, sourceActorUuid: caster.uuid, sourceItemUuid: spell?.uuid ?? null, sourceItemName: spell?.name ?? shape.name, resolutionKind: "save", targetActorUuid: actor.uuid }));
    return { label: `${shape.name}: ${actor.name}`, status: "applied", effectUuid: made?.uuid ?? null };
}

/** After an Effect reaches the spell's targets: the riders for each ally it reached (Enlightening Spell). */
export async function shapeRecipientsAfter(messageId, caster, actors, rank, spell) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    const results = [];
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "ally-recipient-effect")
        for (const actor of actors) { const result = await allyRecipientEffect(caster, actor, shape, rider, messageId, rank, spell); if (result) results.push(result); }
    return results;
}

/** The caster's power ring item bonus (Magic+'s Power Rings: their Veracious Spell's bonus), the best of the rings it wears invested; 0 without one. */
export function powerRingBonus(caster) {
    let best = 0;
    for (const item of caster?.itemTypes?.equipment ?? []) {
        if (item.system?.equipped?.carryType !== "worn" || (item.system?.traits?.value ?? []).includes("invested") && item.system?.equipped?.invested === false) continue;
        const veracious = (readItemSpellshape(item.toObject())?.activations ?? []).find(activation => activation.label === "Veracious Spell");
        const rule = veracious?.riders?.find(rider => rider.type === "self-rules")?.rules?.[0];
        if (rule?.type === "item") best = Math.max(best, Number(rule.value) || 0);
    }
    return best;
}

/** A creature a shaped summon brought (Veracious Summon: the ring's bonus to its Strikes, while it's here). */
export async function shapeSummonedAfter(messageId, caster, summoned, context = {}) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    const results = [];
    // (Colossal Summon: the summon's listed abilities — Gargantuan in 6 by 6 squares, +20 feet to its Speeds, Trample, Earth-Shatterer, Megalophobia.)
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "colossal" && summoned) results.push(...await colossalSummon(shape, rider, caster, summoned, context));
    // (Shadow Ash: the undead's shroud of frost.)
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "summoned-shroud" && summoned) results.push(...await catalystSummoned(shape, rider, caster, summoned) ?? []);
    // (Tyrant's Writs: the caster's pick of the undead's benefit — summon-benefits.js.)
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "summon-benefit" && summoned) {
        const dc = Number(context.itemOrSource?.spellcasting?.statistic?.dc?.value ?? context.dc ?? NaN);
        results.push(...await grantSummonBenefit(shape, rider, summoned, { dc, casterUuid: caster?.uuid ?? null, choose: riderChoice }));
    }
    // (Aspect Sage: an aspect ability it doesn't have — the actions in the module's aspect folders — picked (or given as the armed choice: its uuid or name).)
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "aspect-ability" && summoned) {
        const have = new Set(summoned.items.map(item => item.name));
        const offered = [];
        for (const pack of game.packs.filter(entry => entry.documentName === "Item" && entry.folders.some(folder => /\baspects?\b/i.test(folder.name)))) {
            const index = await pack.getIndex({ fields: ["folder", "system.traits.rarity"] });
            for (const entry of index) {
                const folder = pack.folders.get(entry.folder);
                if (entry.type !== "action" || !folder || !/\baspects?\b/i.test(folder.name) || have.has(entry.name) || !["common", undefined, null].includes(entry.system?.traits?.rarity)) continue;
                offered.push({ value: entry.uuid, label: `${entry.name} (${folder.name})`, name: entry.name });
            }
        }
        const preset = offered.find(entry => entry.value === shape.choice || entry.name === shape.choice)?.value ?? null;
        const picked = preset ?? (offered.length ? await foundry.applications.api.DialogV2.prompt({ window: { title: `${shape.name}: an aspect ability` }, rejectClose: false,
            content: `<select name="ability">${offered.map(entry => `<option value="${entry.value}">${escapeHTML(entry.label)}</option>`).join("")}</select>`,
            ok: { label: "Grant", callback: (_event, button) => button.form.elements.ability.value } }) : null);
        const ability = picked ? await fromUuid(picked).catch(() => null) : null;
        if (!ability) { results.push({ label: `${shape.name}: no aspect ability chosen`, status: "skipped" }); continue; }
        const source = ability.toObject(); delete source._id;
        foundry.utils.setProperty(source, `flags.${MODULE_ID}.spellshapeRider`, { label: shape.name });
        const [made] = await summoned.createEmbeddedDocuments("Item", [source]);
        results.push({ label: `${shape.name}: ${summoned.name} gains ${ability.name}`, status: "applied", itemUuid: made?.uuid ?? null });
    }
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "summon-strike-bonus" && summoned) {
        const bonus = powerRingBonus(caster);
        if (!bonus) { results.push({ label: `${shape.name}: ${caster.name} wears no power ring`, status: "skipped" }); continue; }
        const [made] = await summoned.createEmbeddedDocuments("Item", [{ name: `${shape.name}: +${bonus} to Strikes`, type: "effect", img: "icons/svg/aura.svg",
            flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name } } },
            system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
                rules: [{ key: "FlatModifier", selector: "strike-attack-roll", type: "status", value: bonus }] } }]);
        results.push({ label: `${shape.name}: ${summoned.name} +${bonus} status to Strikes`, status: "applied", effectUuid: made?.uuid ?? null });
    }
    return results;
}

// (PF2e's Trample, from its creature-ability glossary: "[Size], [Listed Strike], DC" filled in for the creature.)
const TRAMPLE = "Compendium.pf2e.bestiary-ability-glossary-srd.Item.UNah0bxXxkcZjxO3";
async function colossalSummon(shape, rider, caster, summoned, { ongoing = null, summonEffect = null, castRank = null, durationSeconds = 60, itemOrSource = null } = {}) {
    const results = [];
    // (The DC its abilities use: the casting's spell DC.)
    const dc = Number(itemOrSource?.spellcasting?.statistic?.dc?.value ?? caster.system?.attributes?.spellDC?.value ?? 10);
    const tokenDoc = canvas.scene?.tokens.find(token => token.actorId === summoned.id) ?? null;
    // Colossal: Gargantuan, in 6 by 6 squares; "All of its speeds increase by 20 feet".
    await summoned.createEmbeddedDocuments("Item", [{ name: `${shape.name}: Colossal`, type: "effect", img: "icons/svg/upgrade.svg", flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name } } },
        system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
            description: { value: `<p>Gargantuan, taking up ${rider.squares} by ${rider.squares} squares and 100 feet tall; its Speeds increase by ${rider.speedBonus} feet.</p>` },
            rules: [{ key: "CreatureSize", value: "grg" }, { key: "FlatModifier", selector: "all-speeds", value: rider.speedBonus, label: shape.name }] } }]);
    if (tokenDoc) await tokenDoc.update({ "flags.pf2e.linkToActorSize": false, width: rider.squares, height: rider.squares });
    results.push({ label: `${shape.name}: ${summoned.name} Gargantuan (${rider.squares} by ${rider.squares}), +${rider.speedBonus} feet`, status: "applied" });
    // Trample, or its damage dice one size larger (that size the table's: PF2e's Trample rolls the listed Strike's damage).
    const trample = summoned.itemTypes.action.find(item => item.slug === "trample" || item.name === "Trample");
    if (trample) {
        await summoned.createEmbeddedDocuments("Item", [{ name: `${shape.name}: Trample's damage dice one size larger`, type: "effect", img: "icons/svg/upgrade.svg", flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name } } },
            system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true }, rules: [],
                description: { value: "<p>Its Trample's damage dice are one size larger (roll them so).</p>" } } }]);
        results.push({ label: `${shape.name}: Trample's damage dice one size larger`, status: "applied" });
    } else {
        const glossary = await fromUuid(TRAMPLE).catch(() => null);
        const strike = summoned.itemTypes.melee?.[0]?.name ?? "its Strike";
        if (glossary) {
            const source = glossary.toObject(); delete source._id;
            source.system.description.value = String(source.system.description.value).replace("[Size]", "Huge or smaller").replace("[Listed Strike]", escapeHTML(strike)).replace("@Check[reflex|dc:|basic]", `@Check[reflex|dc:${dc}|basic]`);
            await summoned.createEmbeddedDocuments("Item", [source]);
            results.push({ label: `${shape.name}: ${summoned.name} gains Trample (Huge or smaller, ${strike}, DC ${dc})`, status: "applied" });
        }
    }
    // Earth-Shatterer: its Earthquake, from an innate entry at the casting's DC; the action casts it (text-rules.js actionCastOnCard), once per minute.
    const earthquake = await fromUuid(rider.earthShatterer.spell.uuid).catch(() => null);
    if (earthquake) {
        const tradition = itemOrSource?.spellcasting?.tradition ?? "primal";
        const [entry] = await summoned.createEmbeddedDocuments("Item", [{ name: `${shape.name}: Earth-Shatterer`, type: "spellcastingEntry",
            system: { tradition: { value: tradition }, prepared: { value: "innate" }, spelldc: { dc, value: dc - 10 }, showSlotlessLevels: { value: false } } }]);
        const spellSource = earthquake.toObject(); delete spellSource._id; spellSource.system.location = { value: entry.id };
        const [spell] = await summoned.createEmbeddedDocuments("Item", [spellSource]);
        await summoned.createEmbeddedDocuments("Item", [{ name: "Earth-Shatterer", type: "action", img: earthquake.img,
            flags: { [MODULE_ID]: { actionCast: { spellId: spell.id, rank: earthquake.rank, perSeconds: rider.earthShatterer.perSeconds } } },
            system: { actionType: { value: "action" }, actions: { value: rider.earthShatterer.actions }, frequency: { max: 1, per: "PT1M" }, traits: { value: [] },
                description: { value: `<p><strong>Frequency</strong> once per minute; <strong>Effect</strong> The summon produces the effects of an @UUID[${earthquake.uuid}]{Earthquake}.</p>` } } }]);
        results.push({ label: `${shape.name}: Earth-Shatterer (Earthquake, DC ${dc})`, status: "applied" });
    }
    // Megalophobia: its aura — a Will save on entering or starting a turn in it, then immune for 1 hour.
    if (ongoing && rider.megalophobia) {
        const mega = rider.megalophobia;
        const castId = await startFollowingAura(ongoing, { spellName: `${shape.name}: ${summoned.name}`, sourceActor: summoned, sourceItemUuid: itemOrSource?.uuid ?? null, castRank,
            aura: { key: "megalophobia", label: "Megalophobia", radius: mega.radius, events: ["enter", "turn-start"], oncePerTurn: true,
                save: { statistic: mega.statistic, traits: mega.traits, rows: { failure: { direct: true, conditions: mega.failure }, criticalFailure: { direct: true, conditions: mega.criticalFailure } },
                    immunity: { key: `megalophobia:${summoned.id}`, seconds: mega.immunitySeconds } } },
            dc, durationSeconds });
        if (summonEffect) await summonEffect.setFlag(MODULE_ID, "summon", { ...(summonEffect.flags?.[MODULE_ID]?.summon ?? {}), ongoingCastIds: [...(summonEffect.flags?.[MODULE_ID]?.summon?.ongoingCastIds ?? []), castId] });
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: summoned }), content: `<p><strong>Megalophobia</strong> (aura ${mega.radius} feet, ${escapeHTML(mega.traits.join(", "))}): ${escapeHTML(mega.flavour)} ${escapeHTML(mega.note)}</p>` }); } catch (_) {}
        results.push({ label: `${shape.name}: Megalophobia (${mega.radius}-foot aura, DC ${dc})`, status: "applied", castId });
    }
    return results;
}

/** A cast whose self-only Effect goes elsewhere (Linked Target Spell, Twinned Target Spell: the mystic duo; Ally Form: an adjacent ally): its recipients, or null. */
export async function shapeSelfRecipients(messageId, caster) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "redirect-self") {
        let other = null;
        if (rider.to === "duo") other = mysticDuoOf(caster);
        else if (rider.to === "familiar") {
            // (Monstrous Familiar: "you may cast it on your familiar rather than yourself" — asked.)
            const familiar = game.actors.find(actor => actor.type === "familiar" && (actor.system?.master?.id === caster.id || actor.master === caster));
            if (!familiar) continue;
            const where = rider.optional ? await riderChoice(shape, "Cast the battle form on your familiar?", [{ value: "familiar", label: `On ${familiar.name}` }, { value: "self", label: `On ${caster.name}` }]) : "familiar";
            if (where !== "familiar") continue;
            other = familiar;
        }
        else if (rider.to === "adjacent-ally") {
            const casterToken = caster.getActiveTokens?.(true, true)?.[0] ?? null;
            const allies = casterToken ? canvas.scene.tokens.filter(token => token.actor && token.actor !== caster && token.actor.alliance && token.actor.alliance === caster.alliance && tokenDistance(casterToken, token) <= 5) : [];
            const picked = await riderChoice(shape, "Which adjacent ally takes the form?", allies.map(token => ({ value: token.actor.uuid, label: token.name })));
            other = allies.find(token => token.actor.uuid === picked)?.actor ?? null;
        }
        if (!other) throw new Error(`${shape.name}: ${rider.to === "duo" ? "no mystic duo is linked" : "no adjacent ally"}.`);
        return rider.alsoSelf ? [caster, other] : [other];
    }
    return null;
}

/** After a redirected self Effect is made: the other's copy tied to the mystic link, an earlier Linked Target Spell Effect ended, a battle form held to a minute. */
export async function shapeSelfAfter(messageId, caster, created) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    const rider = (shaping?.shapes ?? []).flatMap(shape => shape.riders ?? []).find(entry => entry.type === "redirect-self");
    if (!rider) return [];
    const others = created.filter(effect => effect?.actor && effect.actor !== caster);
    if (rider.endsPrevious) for (const effect of (caster.flags?.[MODULE_ID]?.linkedTargetEffects ?? [])) {
        const old = await fromUuid(effect).catch(() => null);
        if (old && !created.includes(old)) await old.delete().catch(() => null);
    }
    for (const effect of others) {
        const link = rider.whileLinked ? mysticLinkEffect(effect.actor) : null;
        if (link) await effect.setFlag(MODULE_ID, "spellshapeTie", { tiedTo: [link.uuid] });
        const seconds = { rounds: 6, minutes: 60, hours: 3600, days: 86400 }[effect.system?.duration?.unit] * Number(effect.system?.duration?.value ?? 0);
        if (rider.maxSeconds && (!Number.isFinite(seconds) || seconds > rider.maxSeconds || effect.system?.duration?.unit === "unlimited")) await effect.update({ "system.duration": { value: rider.maxSeconds / 60, unit: "minutes", expiry: "turn-start", sustained: false } });
    }
    if (rider.endsPrevious) await caster.setFlag(MODULE_ID, "linkedTargetEffects", others.map(effect => effect.uuid));
    // (Monstrous Familiar: the module's Effect too — "an additional 4 Hit Points for every level you have".)
    if (rider.alsoEffect) for (const holder of new Set(others.map(effect => effect.actor))) {
        const template = await loadNativeEffectTemplate(rider.alsoEffect.uuid);
        if (template) await createNativeEffect(holder, prepareNativeEffectSource(template, { castInstanceId: messageId, castRank: 1, sourceActorUuid: caster.uuid, sourceItemUuid: null, sourceItemName: rider.alsoEffect.name, resolutionKind: "save", targetActorUuid: holder.uuid }));
    }
    return others.map(effect => effect.uuid);
}

/** A damage or healing roll of the spell a rule waited for (Sacrificial Spell's d12s): that rule's Effect gone. */
export async function shapeRollSpent(message) {
    if (!activeGM() || message?.flags?.pf2e?.context?.type !== "damage-roll") return [];
    const actor = message.actor, item = message.item;
    const spent = (actor?.itemTypes?.effect ?? []).filter(effect => { const wait = effect.flags?.[MODULE_ID]?.spellshapeUntilRoll; return wait && (wait.spellUuid === item?.uuid || (wait.spellSlug && wait.spellSlug === item?.slug)); });
    if (spent.length) await actor.deleteEmbeddedDocuments("Item", spent.map(effect => effect.id)).catch(() => null);
    return spent.map(effect => effect.name);
}

/** Seeking Spell: how much of a target's cover bonus to AC the cast's attack ignores (0 when none). */
export function shapeCoverReduceFor(messageId, target) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    const rider = (shaping?.shapes ?? []).flatMap(shape => (shape.riders ?? []).map(rider => ({ shape, rider }))).find(entry => entry.rider.type === "cover-reduce");
    if (!rider || !target) return null;
    // (PF2e's Effect: Cover — its chosen bonus.)
    const bonus = Math.max(0, ...(target.itemTypes?.effect ?? []).map(effect => Number(effect.flags?.system?.rulesSelections?.cover?.bonus ?? 0)));
    return bonus > 0 ? { value: Math.min(rider.rider.by, bonus), label: rider.shape.name } : null;
}

/** Fury of a Thousand on Murmuration: the damage dealt in full as each of two types ({types, label}), or null. */
export function shapeDualFor(messageId) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "dual-damage") return { types: rider.types, label: shape.name };
    return null;
}

/** An Effect the spell made, its stated value changed by the cast's spellshape (Fury of a Thousand: Song of Strength's +2, Murmuration's −3). */
/** The form's choices a spellshape answers ahead (Colossal Aspect Form: the size), or null. */
export function shapeChoiceSelectionsFor(messageId) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    const selections = Object.assign({}, ...(shaping?.shapes ?? []).flatMap(shape => (shape.riders ?? []).filter(rider => rider.type === "form-choice").map(rider => rider.selections)));
    return Object.keys(selections).length ? selections : null;
}

export async function shapeAdjustEffects(messageId, effects) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    // (Colossal Aspect Form: the caster's token 6 by 6 and Trample while the form lasts — restored and removed as it ends: shapeTieEnded.)
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "colossal-form") {
        const form = effects.find(effect => (effect?.system?.rules ?? []).some(rule => rule.key === "AspectForm"));
        const actor = form?.actor;
        if (!form || !actor) continue;
        const tokenDoc = canvas.scene?.tokens.find(token => token.actorId === actor.id) ?? null;
        // (Back to the creature's own token size when the form ends: its prototype token's, PF2e having already resized this one to the form's.)
        const restore = tokenDoc ? { tokenUuid: tokenDoc.uuid, width: actor.prototypeToken?.width ?? 1, height: actor.prototypeToken?.height ?? 1, link: actor.prototypeToken?.flags?.pf2e?.linkToActorSize ?? true } : null;
        // (After PF2e's own resize to the form's size.)
        await new Promise(resolve => setTimeout(resolve, 300));
        if (tokenDoc) await tokenDoc.update({ "flags.pf2e.linkToActorSize": false, width: rider.squares, height: rider.squares });
        const trample = actor.itemTypes.action.find(item => item.slug === "trample" || item.name === "Trample");
        let given = null;
        // (The text's Trample: the module's aspect Trample; or, the form having one, its damage dice one size larger — that roll the table's.)
        if (trample) await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: Trample's damage dice one size larger`, type: "effect", img: "icons/svg/upgrade.svg",
            flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name }, colossalOf: form.uuid } },
            system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true }, rules: [],
                description: { value: "<p>Its Trample's damage dice are one size larger (roll them so).</p>" } } }]);
        if (!trample) {
            const linked = await fromUuid(rider.trample).catch(() => null);
            if (linked) {
                const source = linked.toObject(); delete source._id;
                foundry.utils.setProperty(source, `flags.${MODULE_ID}.colossalOf`, form.uuid);
                [given] = await actor.createEmbeddedDocuments("Item", [source]);
            }
        }
        // ("your reach increases to 25 feet": the form's size choice's reach, which its AspectForm reads.)
        // (PF2e keeps the choice on its rule and in the flag: both.)
        const shift = form.flags?.pf2e?.rulesSelections?.shift;
        if (shift && typeof shift === "object") {
            const rules = foundry.utils.deepClone(form._source.system.rules ?? []);
            for (const rule of rules) if (rule.key === "ChoiceSet" && rule.flag === "shift" && rule.selection && typeof rule.selection === "object") rule.selection = { ...rule.selection, reach: rider.reach };
            await form.update({ "system.rules": rules, "flags.pf2e.rulesSelections.shift": { ...shift, reach: rider.reach } });
        }
        await form.setFlag(MODULE_ID, "colossalForm", { restore, trampleDice: Boolean(trample) });
    }
    const adjust = (shaping?.shapes ?? []).flatMap(shape => (shape.riders ?? []).filter(rider => rider.type === "effect-value").map(rider => ({ shape, rider })));
    const done = [];
    for (const { shape, rider } of adjust) for (const effect of effects) {
        if (effect?.name !== rider.effectName) continue;
        const rules = foundry.utils.deepClone(effect._source.system.rules ?? []);
        let changed = false;
        for (const rule of rules) if (rule.key === "FlatModifier" && Number(rule.value) === rider.from) { rule.value = rider.to; changed = true; }
        if (changed) { await effect.update({ "system.rules": rules }); done.push({ label: `${shape.name}: ${effect.actor?.name ?? ""} ${rider.effectName} ${rider.to > 0 ? "+" : ""}${rider.to}`, status: "applied" }); }
    }
    return done;
}

/** The two types a cast's damage is split between (The Lurking Storm: "half of the damage as bludgeoning damage and half the damage as electricity"), or null. */
export function shapeSplitFor(messageId) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "damage-split") return { types: rider.types, label: shape.name };
    return null;
}

/** The metal the cast's damage is (Golden Dragon's Bounty), or null. */
export function shapeMaterialFor(messageId) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "damage-material" && rider.chosen) return rider.chosen;
    return null;
}

/** Whether the cast rerolls its damage dice that roll a 1 (Codex of Destruction and Renewal). */
export function shapeRerollOnesFor(messageId) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    return (shaping?.shapes ?? []).some(shape => (shape.riders ?? []).some(rider => rider.type === "reroll-ones"));
}

/** The defense the cast's spell attack is made against instead of AC (Shadow Signet): { statistic, label }, or null. */
export function attackDefenseFor(messageId) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    for (const shape of shaping?.shapes ?? []) for (const rider of shape.riders ?? []) if (rider.type === "attack-defense" && rider.chosen) return { statistic: rider.chosen, label: shape.name };
    return null;
}

/** The resistances the cast ignores an amount of (Overwhelming Energy: the caster's level, to acid, cold, …): [{value, types}]. */
export function shapeResistanceLowersFor(messageId, caster) {
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    return (shaping?.shapes ?? []).flatMap(shape => shape.riders ?? []).filter(rider => rider.type === "ignore-resistance")
        .map(rider => ({ value: rider.value === "level" ? Number(caster?.level ?? 0) : Number(rider.value), types: rider.types }));
}

/** The spell's facts a rider needs on the card: its damage types (persistent ones apart). */
export function shapeSpellFacts(spell) {
    const entries = Object.values(spell?.system?.damage ?? {});
    // (The spell's duration in rounds — "3 rounds", "1 minute" — for "This lasts for the duration of the spell".)
    const lasting = /^(\d+) (round|minute|hour)s?$/.exec(String(spell?.system?.duration?.value ?? "").trim());
    return { damageTypes: entries.filter(entry => entry.category !== "persistent").map(entry => entry.type).filter(Boolean),
        persistentTypes: entries.filter(entry => entry.category === "persistent").map(entry => entry.type).filter(Boolean),
        durationRounds: lasting ? Number(lasting[1]) * { round: 1, minute: 10, hour: 600 }[lasting[2]] : null };
}

const traitsOf = actor => { const traits = actor.traits ?? new Set(actor.system?.traits?.value ?? []); return [...traits]; };
// ("rank", "focus-rank", or a sum of the rank: "2*rank".)
const rankFormula = (formula, state, caster) => formula === "per4levels-d4" ? `${Math.max(1, Math.floor(Number(caster?.level ?? 1) / 4))}d4` : formula === "rank" ? String(Number(state.castRank)) : formula === "focus-rank" ? String(Math.ceil(Number(caster?.level ?? 1) / 2))
    : /^\d+\*rank$/.test(String(formula)) ? String(Number(String(formula).split("*")[0]) * Number(state.castRank))
    // ("1d4 … per spell rank": that many dice for each rank — Painful Spell.)
    : /^\d+\*rank-d\d+$/.test(String(formula)) ? `${Number(String(formula).split("*")[0]) * Number(state.castRank)}d${String(formula).split("-d")[1]}` : formula;
/** Nonlethal damage that brought a creature from above 0 Hit Points to 0: Unconscious, not dying. */
async function knockedOut(actor, before) {
    if (!(before > 0) || Number(actor.hitPoints?.value ?? 1) > 0) return false;
    for (const condition of (actor.itemTypes?.condition ?? []).filter(entry => entry.slug === "dying")) await condition.delete().catch(() => null);
    if (actor.statuses?.has?.("dead")) await actor.toggleStatusEffect?.("dead", { active: false, overlay: true }).catch(() => null);
    if (!actor.hasCondition?.("unconscious")) await actor.increaseCondition("unconscious").catch(() => null);
    return true;
}

/** The caster's choice for a rider: given on the cast's message (`shaping.choices`), else the GM's pick. */
export async function riderChoice(shape, label, choices) {
    if (shape.choice != null && choices.some(choice => choice.value === shape.choice)) return shape.choice;
    if (choices.length === 1) return choices[0].value;
    return foundry.applications.api.DialogV2.wait({ window: { title: `${shape.name}: ${label}` }, rejectClose: false, content: `<p>${escapeHTML(label)}</p>`,
        buttons: choices.map((choice, index) => ({ action: `choice-${index}`, label: choice.label, default: index === 0, callback: () => choice.value })) });
}

export async function timedConditions(actor, list, label, { rank = null, caster = null, dc = null } = {}) {
    // ("for a number of rounds equal to the spell rank"; "until the start of your next turn": an Effect ended as the caster's turn starts.)
    list = list.map(entry => entry.rounds === "rank" ? { ...entry, rounds: Number(rank) } : entry.until === "caster-turn-start" ? { ...entry, rounds: 1, untilCaster: true }
        : entry.until === "caster-next-turn-end" ? { ...entry, rounds: 1, untilCasterEnd: true } : entry);
    // ("Stupefied 1 for as long as they remain frightened": an Effect that goes with the creature's last frightened.)
    const whileList = list.filter(entry => entry.whileCondition);
    list = list.filter(entry => !entry.whileCondition);
    const timed = list.filter(entry => entry.rounds), plainList = list.filter(entry => !entry.rounds);
    const results = [];
    for (const entry of whileList) {
        const [made] = await actor.createEmbeddedDocuments("Item", [{ name: `${label}: ${entry.slug}${entry.value ? ` ${entry.value}` : ""} while ${entry.whileCondition}`, type: "effect", img: "icons/svg/aura.svg",
            flags: { [MODULE_ID]: { spellshapeRider: { label }, spellshapeWhileCondition: entry.whileCondition } },
            system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
                rules: [{ key: "GrantItem", uuid: entry.uuid, onDeleteActions: { grantee: "restrict" }, ...(entry.value ? { alterations: [{ mode: "override", property: "badge-value", value: entry.value }] } : {}) }] } }]);
        results.push({ label: `${label}: ${entry.slug}${entry.value ? ` ${entry.value}` : ""} while ${entry.whileCondition}`, status: "applied", effectUuid: made?.uuid ?? null });
    }
    // (One Effect per duration: "Blinded for 1 round and Dazzled for a number of rounds equal to the spell rank" are two.)
    const groups = new Map();
    for (const entry of timed) {
        const key = JSON.stringify([entry.rounds, !!entry.untilCaster, !!entry.untilCasterEnd, entry.endSave ?? null]);
        groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const timed of groups.values()) {
        const rounds = Math.max(...timed.map(entry => entry.rounds));
        // ("it can attempt a Fortitude saving throw against your spell DC at the end of each of its turns, ending the blinded condition on a success")
        const endSave = timed.find(entry => entry.endSave)?.endSave;
        const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${label}: ${timed.map(entry => `${entry.slug}${entry.value ? ` ${entry.value}` : ""}`).join(", ")}`, type: "effect", img: "icons/svg/aura.svg",
            flags: { [MODULE_ID]: { spellshapeRider: { label }, ...(endSave && dc ? { runtime: { schema: 1, sourceItemName: label, turnEndSave: { statistic: endSave.statistic, dc, endsEffect: true } } } : {}),
                ...(timed.some(entry => entry.untilCaster) && caster && game.combat?.started
                ? { turnBound: { untilStartOf: caster.uuid, combatId: game.combat.id, startedAt: { round: game.combat.round, turn: game.combat.turn } } }
                : timed.some(entry => entry.untilCasterEnd) && caster && game.combat?.started
                ? { turnBound: { actorUuid: caster.uuid, combatId: game.combat.id, startedAt: { round: game.combat.round, turn: game.combat.turn } } } : {}) } },
            system: { duration: { value: rounds, unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                rules: timed.map(entry => ({ key: "GrantItem", uuid: entry.uuid, onDeleteActions: { grantee: "restrict" }, ...(entry.value ? { alterations: [{ mode: "override", property: "badge-value", value: entry.value }] } : {}) })) } }]);
        results.push({ label: `${label}: ${timed.map(entry => `${entry.slug}${entry.value ? ` ${entry.value}` : ""} for ${entry.rounds} round${entry.rounds === 1 ? "" : "s"}`).join(", ")}`, status: "applied", effectUuid: effect?.uuid ?? null });
    }
    for (const entry of plainList) {
        // (PF2e adds the value to an existing condition: the difference raises it to the stated value.)
        const now = Number(actor.getCondition?.(entry.slug)?.value ?? 0);
        if (!actor.hasCondition?.(entry.slug)) await actor.increaseCondition(entry.slug, entry.value ? { value: entry.value } : {});
        else if (entry.value && now < entry.value) await actor.increaseCondition(entry.slug, { value: entry.value - now });
        results.push({ label: `${label}: ${entry.slug}${entry.value ? ` ${entry.value}` : ""}`, status: "applied" });
    }
    return results;
}

const roundsOf = duration => { const value = Number(duration?.value ?? 0); return value > 0 ? value * ({ rounds: 1, minutes: 10, hours: 600, days: 14400 }[duration.unit] ?? 0) : 0; };
/** The spell's own Effects on a creature (its outcome) and the conditions each grants: [{effect, slugs}]. */
export function castGrants(target, actor) {
    const uuids = [...new Set((target.conditionResults ?? []).filter(entry => entry.effectUuid && entry.status === "applied").map(entry => entry.effectUuid))];
    return uuids.map(uuid => fromUuidSync(uuid)).filter(effect => effect?.actor === actor)
        .map(effect => ({ effect, slugs: (actor.itemTypes?.condition ?? []).filter(condition => condition.flags?.pf2e?.grantedBy?.id === effect.id).map(condition => condition.slug) }));
}
/**
 * The caster's Overdrive damage (PF2e's Effect: Overdrive — 1 fire on a failure; half its Intelligence modifier, or all of it on a critical success, plus 1/2/3 from 3rd/7th/15th
 * level, of the spell's type) or Offensive Boost damage (PF2e's die and chosen type on its Strikes), or null without it.
 */
function borrowedDamage(caster, from, spellType) {
    if (from === "overdrive") {
        const effect = (caster.itemTypes?.effect ?? []).find(item => item.slug === "effect-overdrive" || item.name === "Effect: Overdrive");
        const outcome = effect?.flags?.pf2e?.rulesSelections?.baseDamage ?? null;
        if (!outcome) return null;
        if (outcome === "failure") return { formula: "1", type: "fire", label: "Overdrive" };
        const level = Number(caster.level ?? 1);
        const value = Number(caster.flags?.system?.overdriveBaseDamage ?? 0) + (level >= 15 ? 3 : level >= 7 ? 2 : level >= 3 ? 1 : 0);
        return value > 0 ? { formula: String(value), type: spellType, label: "Overdrive" } : null;
    }
    const type = caster.flags?.system?.inventor?.offensiveBoost;
    if (!type) return null;
    const dice = (caster.synthetics?.damageDice?.["strike-damage"] ?? []).find(entry => /offensive.?boost/i.test(`${entry.slug ?? ""} ${entry.label ?? ""}`));
    return { formula: `${dice?.diceNumber ?? 1}${dice?.dieSize ?? "d6"}`, type, label: "Offensive Boost" };
}

/** An Effect tied to the spell's own Effects on the creature: it goes when they do (`shapeTieEnded`). */
async function tiedEffect(actor, name, tiedTo, extraFlags = {}, system = {}) {
    const [made] = await actor.createEmbeddedDocuments("Item", [{ name, type: "effect", img: "icons/svg/aura.svg",
        flags: { [MODULE_ID]: { spellshapeTie: { tiedTo: tiedTo.map(effect => effect.uuid), label: name }, ...foundry.utils.deepClone(extraFlags) } },
        system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true }, ...system } }]);
    return made;
}

/**
 * A creature's riders after the spell's own outcome: its degree (the save or the attack), its damage multiplier, the save's statistic. Extra damage
 * is rolled once for the cast (`state.shapeRolls`).
 */
export async function applyShapeRiders(state, target, actor, token, { DamageRoll, multiplier = 1 } = {}) {
    // (A spell without damage of its own — Sleep — passes none: PF2e's.)
    DamageRoll ??= CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
    const results = [];
    const degree = target.degree;
    const attack = state.saveStatistic === "spell-attack";
    const damaged = (target.damageResults ?? []).reduce((total, entry) => total + Number(entry.receipt?.damage ?? 0), 0) > 0;
    // ("creatures you hit or that fail their saves"; "unless the target is unaffected by the spell": a miss, or a critical success on the save.)
    const hitOrFailed = attack ? ["success", "criticalSuccess"].includes(degree) : ["failure", "criticalFailure"].includes(degree);
    const affected = attack ? ["success", "criticalSuccess"].includes(degree) : degree !== "criticalSuccess";
    const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
    const options = { rank: state.castRank, caster, dc: state.dc ?? null };
    for (const shape of state.shapeRiders ?? []) {
    // ("targets a single undead": only a creature with the trait.)
    if ((shape.requires?.targetTraits ?? []).some(trait => !traitsOf(actor).includes(trait))) continue;
    for (const rider of shape.riders) {
        if (rider.onlySave && state.saveStatistic !== rider.onlySave) continue;
        if (rider.type === "focus-spend") {
            // ("you can expend a Focus Point": once for the cast.)
            state.shapeFocus ??= {};
            if (state.shapeFocus[shape.name] == null) {
                const focus = caster?.system?.resources?.focus;
                state.shapeFocus[shape.name] = Number(focus?.value ?? 0) > 0;
                if (state.shapeFocus[shape.name]) await caster.update({ "system.resources.focus.value": Number(focus.value) - 1 });
                results.push({ label: `${shape.name}: ${state.shapeFocus[shape.name] ? "a Focus Point spent" : "no Focus Point to spend"}`, status: state.shapeFocus[shape.name] ? "applied" : "manual" });
            }
            continue;
        }
        if (rider.needsFocus && !state.shapeFocus?.[shape.name]) continue;
        if (rider.type === "seek-retry") {
            // (Seeking Spell: "if your spell attack roll is a failure, but not a critical failure, … you can Sustain this effect on your next turn to attempt this spell
            // attack roll again" — one more round at 14th level and every 2 levels after.)
            if (!(attack && degree === "failure")) continue;
            const level = Number(caster?.level ?? 1), rounds = rider.rounds.base + (level >= rider.rounds.from ? 1 + Math.floor((level - rider.rounds.from) / rider.rounds.every) : 0);
            results.push({ label: `${shape.name}: the attack missed ${actor.name} — Sustain on your next turn${rounds > 1 ? ` (up to ${rounds} rounds, one attack a round)` : ""} to roll the spell attack again`, status: "manual" });
            continue;
        }
        if (rider.type === "mythic-drain") {
            // (Drain Destiny: "If the spell attack roll is a success, you regain a Mythic Point; if the target of the spell has any Mythic Points, they lose one.")
            if (!(attack && hitOrFailed) || !caster) continue;
            const mine = caster.system?.resources?.mythicPoints, theirs = actor.system?.resources?.mythicPoints;
            const gained = mine && Number(mine.value ?? 0) < Number(mine.max ?? 0) ? 1 : 0;
            if (gained) await caster.update({ "system.resources.mythicPoints.value": Number(mine.value) + gained });
            const lost = theirs && Number(theirs.value ?? 0) > 0 ? 1 : 0;
            if (lost) await actor.update({ "system.resources.mythicPoints.value": Number(theirs.value) - lost });
            results.push({ label: `${shape.name}: ${caster.name} ${gained ? "regains a Mythic Point" : "is at its most Mythic Points"}; ${actor.name} ${lost ? "loses one" : "has none"}`, status: "applied" });
            continue;
        }
        if (rider.type === "flat-damage") {
            if (rider.when === "damaged" && !damaged) continue;
            // (Wemmuth Trinket: "Creatures who fail or critically fail their Reflex saves … also take piercing damage equal to the spell's rank.")
            if (rider.degrees && !rider.degrees.includes(degree)) continue;
            const roll = await new DamageRoll(`${rankFormula(rider.formula, state, caster)}[${rider.damageType}]`).evaluate();
            const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
            results.push({ label: `${shape.name}: ${receipt.damage} ${rider.damageType} more`, status: "applied" });
            continue;
        }
        if (rider.type === "attack-crit") {
            // (Magic+'s power ring runes: on a critical success of the spell attack — or, Perishing's Die!, a natural 20 — a save at the rune's DC.)
            if (!attack || (rider.natural ? Number(target.saveNatural) < rider.natural : degree !== "criticalSuccess")) continue;
            if (rider.persistent) {
                const roll = await new DamageRoll(`${rider.persistent.formula}[persistent,${rider.persistent.damageType}]`).evaluate();
                await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
                results.push({ label: `${shape.name}: ${rider.persistent.formula} persistent ${rider.persistent.damageType}`, status: "applied" });
                continue;
            }
            const targetToken = token?.object ?? token;
            if (!caster || !targetToken) { results.push({ label: `${shape.name}: the rune's save (no token)`, status: "manual" }); continue; }
            const reaction = rider.reaction;
            // (Die!: the caster's reaction — asked.)
            if (reaction && await riderChoice(shape, `${reaction.name} (reaction): a natural 20 against ${actor.name} — use it?`, [{ value: "yes", label: "Use it" }, { value: "no", label: "Not now" }]) !== "yes") {
                results.push({ label: `${shape.name}: ${reaction.name} not used`, status: "applied" });
                continue;
            }
            const conditions = rider.failure?.conditions ?? [];
            const failure = reaction ? "The target dies." : rider.failure?.push ? `The target is pushed ${rider.failure.push} feet away from you.`
                : `The target is ${conditions.map(entry => `@UUID[${entry.uuid}]{${entry.slug.replace(/^./, letter => letter.toUpperCase())}${entry.value ? ` ${entry.value}` : ""}}`).join(" and ")} until the end of your next turn.`;
            const outcomes = { criticalSuccess: "The target is unaffected.", success: "The target is unaffected.", failure, criticalFailure: failure };
            const card = await startShapeCard({ caster, name: reaction ? `${shape.name}: ${reaction.name}` : shape.name, rank: reaction?.rank ?? state.castRank, statistic: rider.save.statistic, outcomes,
                traits: reaction?.traits ?? [], targets: [targetToken], dc: rider.save.dc }).catch(error => ({ error: error.message }));
            results.push({ label: `${shape.name}: DC ${rider.save.dc} ${rider.save.statistic} save for ${actor.name}${card?.error ? ` (${card.error})` : ""}`, status: card?.error ? "failed" : "applied" });
            if (reaction?.note) results.push({ label: `${shape.name}: ${reaction.note}`, status: "manual" });
            continue;
        }
        if (rider.type === "crit-fail-card") {
            // (Defiled Costa: "The first time any creature critically fails its saving throw against a Mask of Terror spell cast using this catalyst, it also takes 6d10 mental damage,
            // with a basic Fortitude save against the spell's DC … Once any creature takes this damage, the defiled costa's effect ends" — once for the cast.)
            if (attack || degree !== "criticalFailure" || state.shapeCritFail?.[shape.name]) continue;
            (state.shapeCritFail ??= {})[shape.name] = true;
            const targetToken = token?.object ?? token;
            if (!caster || !targetToken) continue;
            const card = await startShapeCard({ caster, name: shape.name, rank: state.castRank, statistic: rider.statistic, damage: rider.damage, traits: rider.traits ?? [], targets: [targetToken], dc: state.dc,
                entryId: caster.spellcasting?.regular?.[0]?.id ?? null }).catch(error => ({ error: error.message }));
            results.push({ label: `${shape.name}: ${rider.damage.formula} ${rider.damage.type} (basic ${rider.statistic}) for ${actor.name}${rider.killsOnCriticalFailure ? " — a critical failure kills it (the GM's)" : ""}`, status: card?.error ? "failed" : "applied" });
            continue;
        }
        if (rider.type === "borrowed-damage") {
            // (Arcane Generator, Transmogrification Boost: the caster's Overdrive or Offensive Boost damage on "the first failed save that dealt damage" — twice on a critical
            // failure.)
            if (attack || !["failure", "criticalFailure"].includes(degree) || !caster || state.shapeBorrowed?.[shape.name]) continue;
            const borrowed = borrowedDamage(caster, rider.from, state.shapeSpell?.damageTypes?.[0] ?? "untyped");
            if (!borrowed) { if (rider.whileOverdrive) results.push({ label: `${shape.name}: not under Overdrive`, status: "skipped" }); continue; }
            (state.shapeBorrowed ??= {})[shape.name] = true;
            const formula = degree === "criticalFailure" ? `(${borrowed.formula})*2` : borrowed.formula;
            const roll = await new DamageRoll(`${formula}[${borrowed.type}]`).evaluate();
            const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
            results.push({ label: `${shape.name}: ${formula} ${borrowed.type} (${borrowed.label}) — ${receipt.damage} taken`, status: "applied" });
            continue;
        }
        if (rider.type === "spell-persistent") {
            // (Blue Salt Crystal: "causing the target to take [the spell's rank] persistent acid damage for the duration of the spell" — the persistent damage granted by an
            // Effect lasting the spell's duration (ended with the spell's own Effects on the creature, if it has any), which takes it away when it goes.)
            if (rider.when === "affected" && !affected) continue;
            const spell = state.sourceItemUuid ? await fromUuid(state.sourceItemUuid).catch(() => null) : null;
            const span = /^(\d+) (round|minute|hour)s?$/i.exec(String(spell?.system?.duration?.value ?? "").trim());
            const rounds = span ? Number(span[1]) * { round: 1, minute: 10, hour: 600 }[span[2].toLowerCase()] : null;
            const formula = rankFormula(rider.formula, state, caster);
            const combat = game.combat?.started ? game.combat : null;
            const grants = castGrants(target, actor).map(grant => grant.effect);
            const [holder] = await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: ${formula} persistent ${rider.damageType} (${state.spellName})`, type: "effect", img: "icons/svg/acid.svg",
                flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name }, ...(grants.length ? { spellshapeTie: { tiedTo: grants.map(effect => effect.uuid), label: shape.name } } : {}) } },
                system: { duration: rounds ? { value: rounds, unit: "rounds", expiry: "turn-start", sustained: false } : { value: -1, unit: "unlimited", expiry: null, sustained: false },
                    start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null }, tokenIcon: { show: true } } }]);
            const [condition] = await actor.createEmbeddedDocuments("Item", [{ name: `Persistent Damage (${formula} ${rider.damageType})`, type: "condition", img: "systems/pf2e/icons/conditions/persistent-damage.webp",
                flags: { pf2e: { grantedBy: { id: holder.id, onDelete: "cascade" } } },
                system: { slug: "persistent-damage", persistent: { formula: String(formula), damageType: rider.damageType, dc: 15 } } }]);
            if (condition) await holder.update({ "flags.pf2e.itemGrants": { persistent: { id: condition.id, onDelete: "detach" } } });
            results.push({ label: `${shape.name}: ${formula} persistent ${rider.damageType}${rounds ? ` for ${span[0]}` : ""}`, status: "applied", effectUuid: holder?.uuid ?? null });
            continue;
        }
        if (rider.type === "splash") {
            if (rider.when === "damaged" && !damaged) continue;
            const type = state.shapeSpell?.damageTypes?.[0] ?? "untyped";
            const center = token?.document ?? token;
            const adjacent = center ? canvas.scene.tokens.filter(other => other.actor && other !== center && other.actor !== actor && !other.hidden && tokenDistance(center, other) <= 5) : [];
            for (const other of adjacent) {
                const roll = await new DamageRoll(`${rankFormula(rider.formula, state, caster)}[${type}]`).evaluate();
                const receipt = await applyDamageWithReceipt(other.actor, { damage: roll, token: other, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
                results.push({ label: `${shape.name}: ${other.name} takes ${receipt.damage} ${type} splash`, status: "applied" });
            }
            continue;
        }
        if (rider.type === "persistent-condition") {
            // (Corrosive Engravings: "any creature who takes persistent damage from the spell is also Sickened 2 until the persistent damage ends" — an Effect granting it,
            // removed with that persistent damage (persistent-link-runtime.js); retching's floor the GM's.)
            const types = shape.requires?.damageTypesAny ?? (shape.requires?.damageType ? [shape.requires.damageType] : []);
            const persistent = (actor.itemTypes?.condition ?? []).find(entry => entry.slug === "persistent-damage" && (!types.length || types.includes(entry.system?.persistent?.damageType)));
            if (!persistent) continue;
            const damageType = persistent.system.persistent.damageType;
            const label = rider.list.map(entry => `${entry.slug}${entry.value ? ` ${entry.value}` : ""}`).join(", ");
            const [made] = await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: ${label} while the persistent ${damageType} damage lasts`, type: "effect", img: "icons/svg/acid.svg",
                flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name }, runtime: { schema: 1, kind: "persistent-condition", castInstanceId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemName: shape.name,
                    persistentLink: { damageType } } } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                    description: { value: `<p>${escapeHTML(label)} until the persistent ${escapeHTML(damageType)} damage ends.${rider.floor ? ` Retching can lower it, but not below ${escapeHTML(rider.floor)} until then (lower it by hand).` : ""}</p>` },
                    rules: rider.list.map(entry => ({ key: "GrantItem", uuid: entry.uuid, onDeleteActions: { grantee: "cascade" }, ...(entry.value ? { alterations: [{ mode: "override", property: "badge-value", value: entry.value }] } : {}) })) } }]);
            results.push({ label: `${shape.name}: ${label} while the persistent ${damageType} damage lasts`, status: "applied", effectUuid: made?.uuid ?? null });
            continue;
        }
        if (rider.type === "degree-note") {
            // (Draxie's Recipe Book: "all creatures within the spell's area who don't critically succeed at their save are covered with a spicy red powder" — a note
            // Effect with what it does, until the creature cleans itself.)
            if (!rider.degrees.includes(degree)) continue;
            const [made] = await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: ${rider.label}`, type: "effect", img: "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name } } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                    description: { value: rider.text.map(text => `<p>${escapeHTML(text)}</p>`).join("") }, rules: [] } }]);
            results.push({ label: `${shape.name}: ${rider.label}`, status: "applied", effectUuid: made?.uuid ?? null });
            continue;
        }
        if (rider.type === "conditions") {
            // (A row for a save spell's target or an attack spell's hit only, Tome of Scintillating Sleet's critical rows — 2026-10-29.)
            if ((rider.attackOnly && !attack) || (rider.saveOnly && attack)) continue;
            // (Or not on the rows that give something instead, the same tome's damaged creature on a critical.)
            if ((attack ? rider.insteadOn?.attack : rider.insteadOn?.save)?.includes(degree)) continue;
            // ("If the creature is immune to emotion, fear, or mental effects, it is immune to this frightened condition.")
            const immunities = (actor.attributes?.immunities ?? actor.system?.attributes?.immunities ?? []).map(entry => entry.type ?? entry);
            if ((rider.unlessImmune ?? []).some(type => immunities.includes(type))) continue;
            // ("If the targeted creature is an enemy …": not the caster's allies.)
            if (rider.enemiesOnly && caster && (actor === caster || (actor.alliance && actor.alliance === caster.alliance))) continue;
            // ("As long as your spell attack is successful": a hit.)
            const hit = attack && ["success", "criticalSuccess"].includes(degree);
            const list = rider.when === "damaged" ? (damaged ? rider.list : []) : rider.when === "hit-or-failed" ? (hitOrFailed ? rider.list : []) : rider.when === "hit" ? (hit ? rider.list : []) : rider.degrees?.[degree] ?? [];
            if (list.length) results.push(...await timedConditions(actor, list, shape.name, options));
        } else if (rider.type === "generated") {
            if (rider.when === "damaged" && !damaged) continue;
            if (rider.degrees && !rider.degrees.includes(degree)) continue;
            // ("one target of the spell": the caster's pick, once for the cast.)
            if (rider.oneTarget) {
                state.shapeOne ??= {};
                const key = `${shape.name}:${rider.name}`;
                if (!state.shapeOne[key]) {
                    const choices = (state.targets ?? []).map(entry => ({ value: entry.actorUuid, label: entry.name ?? entry.actorUuid })).filter(choice => choice.value);
                    state.shapeOne[key] = choices.length <= 1 ? choices[0]?.value ?? actor.uuid : await riderChoice(shape, `Which target: ${rider.name}?`, choices) ?? choices[0].value;
                }
                if (state.shapeOne[key] !== actor.uuid) continue;
            }
            const combat = game.combat?.started ? game.combat : null;
            const [made] = await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: ${rider.name}`, type: "effect", img: "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name }, ...(rider.until === "caster-next-turn-end" && combat && caster ? { turnBound: { actorUuid: caster.uuid, combatId: combat.id, startedAt: { round: combat.round, turn: combat.turn } } } : {}) } },
                system: { duration: rider.rounds ? { value: rider.rounds, unit: "rounds", expiry: "turn-start", sustained: false } : { value: 1, unit: "rounds", expiry: "turn-end", sustained: false },
                    start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                    rules: foundry.utils.deepClone(rider.rules), ...(rider.description ? { description: { value: `<p>${escapeHTML(rider.description)}</p>` } } : {}) } }]);
            results.push({ label: `${shape.name}: ${rider.name}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "effect") {
            if (!(rider.when === "affected" ? affected : (rider.degrees ?? []).includes(degree))) continue;
            const template = await loadNativeEffectTemplate(rider.uuid);
            if (!template) { results.push({ label: `${shape.name}: ${rider.name} is unavailable`, status: "failed" }); continue; }
            const made = await createNativeEffect(actor, prepareNativeEffectSource(template, { castInstanceId: state.castId, castRank: state.castRank, sourceActorUuid: state.sourceActorUuid,
                sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, resolutionKind: "save", targetActorUuid: actor.uuid }));
            results.push({ label: `${shape.name}: ${template.name}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "reduce") {
            if (!actor.hasCondition?.(rider.slug)) continue;
            for (let step = 0; step < rider.by; step++) if (actor.hasCondition?.(rider.slug)) await actor.decreaseCondition(rider.slug);
            results.push({ label: `${shape.name}: ${rider.slug} reduced by ${rider.by}`, status: "applied" });
        } else if (rider.type === "mark") {
            if (!rider.degrees.includes(degree)) continue;
            const [mark] = await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: ${rider.label}`, type: "effect", img: "icons/svg/eye.svg",
                flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name }, spellshapeMark: { casterUuid: state.sourceActorUuid } } },
                system: { duration: rider.days ? { value: rider.days, unit: "days", expiry: null, sustained: false } : { value: -1, unit: "unlimited", expiry: null, sustained: false },
                    start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false }, description: { value: rider.text.map(text => `<p>${escapeHTML(text)}</p>`).join("") } } }]);
            results.push({ label: `${shape.name}: ${rider.label}`, status: "applied", effectUuid: mark?.uuid ?? null });
        } else if (rider.type === "persistent") {
            // ("A creature knocked Unconscious by this spell": the condition granted by the spell's own Effect.)
            // ("all targets of the triggering spell take …": every target, whatever its result.)
            // (Stigmata: "Your harm … spells … deal … persistent bleed damage … to targets that fail … If you use the 3-action cast, only targets that critically fail" — while the
            // caster's own stigmata bleed.)
            if (rider.whileCasterBleeding && !(caster?.itemTypes?.condition ?? []).some(entry => entry.slug === "persistent-damage" && entry.system?.persistent?.damageType === "bleed")) continue;
            const degrees = rider.degreesByActions?.[state.shapeSpell?.actions ?? ""] ?? rider.degrees;
            if (rider.whenCondition ? !castGrants(target, actor).some(grant => grant.slugs.includes(rider.whenCondition)) : rider.when === "all" ? false : rider.when === "damaged" ? !damaged : rider.when === "hit-or-failed" ? !hitOrFailed : !degrees.includes(degree)) continue;
            // ("This has no effect if the spell already deals persistent fire damage.")
            if (rider.unlessPersistent && (state.shapeSpell?.persistentTypes ?? []).includes(rider.damageType)) continue;
            // ("if the spell already causes bleed damage, the bleed damage increases by 1d6": the spell's own persistent condition raised.)
            const own = rider.raisesOwn && (state.shapeSpell?.persistentTypes ?? []).includes(rider.damageType)
                ? (actor.itemTypes?.condition ?? []).find(entry => entry.slug === "persistent-damage" && entry.system?.persistent?.damageType === rider.damageType) : null;
            if (own) {
                const formula = `${own.system.persistent.formula} + ${rankFormula(rider.formula, state, caster)}`;
                await own.update({ "system.persistent.formula": formula });
                results.push({ label: `${shape.name}: ${actor.name}'s persistent ${rider.damageType} raised to ${formula}`, status: "applied" });
                continue;
            }
            // (Bleeding Spell's "to one creature of your choice … made when you Cast the Spell": chosen once, among the spell's targets.)
            if (rider.oneTarget) {
                state.shapeOne ??= {};
                if (!state.shapeOne[shape.name]) {
                    const choices = (state.targets ?? []).map(entry => ({ value: entry.actorUuid, label: entry.name }));
                    state.shapeOne[shape.name] = choices.length === 1 ? choices[0].value : await riderChoice(shape, "Which creature bleeds?", choices) ?? choices[0]?.value;
                }
                if (state.shapeOne[shape.name] !== actor.uuid) continue;
            }
            // ("matching the damage type of the spell": its type — asked once when it has several.)
            let damageType = rider.damageType;
            if (damageType === "spell") {
                const types = [...new Set(state.shapeSpell?.damageTypes ?? [])];
                state.shapeTypes ??= {};
                if (!state.shapeTypes[shape.name]) state.shapeTypes[shape.name] = types.length > 1 ? await riderChoice(shape, "Persistent damage of which type?", types.map(type => ({ value: type, label: type }))) ?? types[0] : types[0];
                damageType = state.shapeTypes[shape.name];
                if (!damageType) continue;
            }
            // ("If they critically fail their save or you critically succeed on the attack roll, the persistent damage is doubled.")
            const doubled = rider.critDouble && (attack ? degree === "criticalSuccess" : degree === "criticalFailure");
            const amount = rankFormula(rider.formula, state, caster);
            const formula = doubled ? `(${amount})*2` : amount;
            const roll = await new DamageRoll(`(${formula})[persistent,${damageType}]`).evaluate();
            await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
            results.push({ label: `${shape.name}: ${formula} persistent ${damageType}`, status: "applied" });
        } else if (rider.type === "extra-damage") {
            if (!(multiplier > 0) && !rider.selfEqual) continue;
            state.shapeRolls ??= {};
            // (Consecrate Spell's spirit or vitality: the caster's choice, once for the cast.)
            state.shapeTypes ??= {};
            if (rider.damageTypeChoice && !state.shapeTypes[shape.name]) state.shapeTypes[shape.name] = await riderChoice(shape, "Damage type", rider.damageTypeChoice.map(type => ({ value: type, label: type })));
            const damageType = rider.damageTypeChoice ? state.shapeTypes[shape.name] ?? rider.damageTypeChoice[0] : rider.damageType;
            const key = `${shape.name}:${rider.formula}:${damageType}`;
            state.shapeRolls[key] ??= (await new DamageRoll(`${rankFormula(rider.formula, state, caster)}[${damageType}]`).evaluate()).toJSON();
            const base = DamageRoll.fromData(foundry.utils.deepClone(state.shapeRolls[key]));
            // (Painful Spell: "You take nonlethal mental damage equal to the additional mental damage, which can't be reduced or prevented in any way." — the
            // rolled amount, once for the cast, past the caster's resistances.)
            state.shapeSelf ??= {};
            if (rider.selfEqual && caster && !state.shapeSelf[key]) {
                state.shapeSelf[key] = true;
                const casterToken = caster.getActiveTokens?.(true, true)?.[0];
                const before = Number(caster.hitPoints?.value ?? 0);
                const self = await new DamageRoll(`${base.total}[${damageType}]`).evaluate();
                await applyDamageWithReceipt(caster, { damage: self, token: casterToken ?? undefined, skipIWR: true, rollOptions: new Set(["nonlethal"]) }, foundry.utils.randomID());
                if (rider.selfEqual.nonlethal) await knockedOut(caster, before);
                results.push({ label: `${shape.name}: ${caster.name} takes ${base.total} nonlethal ${damageType}`, status: "applied" });
            }
            if (!(multiplier > 0)) continue;
            const roll = multiplier === 1 ? base : base.alter(multiplier, 0);
            const before = Number(actor.hitPoints?.value ?? 0);
            const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, skipIWR: false, rollOptions: new Set(rider.nonlethal ? ["nonlethal"] : []) }, foundry.utils.randomID());
            // (Nonlethal extra damage that brings the creature to 0 Hit Points knocks it out instead.)
            if (rider.nonlethal) await knockedOut(actor, before);
            results.push({ label: `${shape.name}: ${receipt.damage} ${rider.nonlethal ? "nonlethal " : ""}${damageType} more`, status: "applied" });
        } else if (rider.type === "prone-damage") {
            // (Wand of Caustic Effluence: a creature that fails its Reflex save and falls Prone takes 1d6 acid.)
            if (!["failure", "criticalFailure"].includes(degree) || (rider.statistic && state.saveStatistic !== rider.statistic) || !actor.hasCondition?.("prone")) continue;
            const roll = await new DamageRoll(`${rider.formula}[${rider.damageType}]`).evaluate();
            const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
            results.push({ label: `${shape.name}: ${receipt.damage} ${rider.damageType} (fell Prone)`, status: "applied" });
        } else if (rider.type === "douse") {
            // (Dousing Spell: the target's persistent acid or fire — its DC to end now 10, and a flat check at once.)
            for (const condition of (actor.itemTypes?.condition ?? []).filter(entry => entry.slug === "persistent-damage" && rider.types.includes(entry.system?.persistent?.damageType))) {
                await condition.update({ "system.persistent.dc": rider.dc }).catch(() => null);
                const flat = await new Roll("1d20").evaluate();
                await flat.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(shape.name)}</strong>: DC ${rider.dc} flat check to end ${escapeHTML(condition.name)}` }).catch(() => null);
                if (flat.total >= rider.dc) await condition.delete().catch(() => null);
                results.push({ label: `${shape.name}: ${condition.system?.persistent?.damageType} persistent damage ${flat.total >= rider.dc ? "ended" : `DC ${rider.dc} now`}`, status: "applied" });
            }
        } else if (rider.type === "nonlethal") {
            // ("that spell gains the nonlethal trait": a creature it brings to 0 Hit Points is knocked out — Unconscious — rather than dying or killed.)
            if (rider.chosen === false || !damaged || Number(actor.hitPoints?.value ?? 1) > 0) continue;
            // (Sarenrae's curse: "nonlethal except against fiends and undead".)
            if ((rider.exceptTraits ?? []).some(trait => traitsOf(actor).includes(trait))) continue;
            for (const condition of (actor.itemTypes?.condition ?? []).filter(entry => entry.slug === "dying")) await condition.delete().catch(() => null);
            if (actor.statuses?.has?.("dead")) await actor.toggleStatusEffect?.("dead", { active: false, overlay: true }).catch(() => null);
            if (!actor.hasCondition?.("unconscious")) await actor.increaseCondition("unconscious").catch(() => null);
            results.push({ label: `${shape.name}: knocked out (nonlethal)`, status: "applied" });
        } else if (rider.type === "follow") {
            // ("If the target becomes Frightened by the spell, it also becomes Stupefied with a value 1 higher …. This lasts for the duration of the
            // spell.": watched for the spell's duration; `syncShapeFollow` adds the condition when the spell's own Effect grants the first.)
            if (!affected) continue;
            const rounds = rider.lasting === "spell" ? state.shapeSpell?.durationRounds ?? null : null;
            const combat = game.combat?.started ? game.combat : null;
            await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: ${rider.add.slug} with ${rider.slug}`, type: "effect", img: "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { spellshapeFollow: { castId: state.castId, slug: rider.slug, add: rider.add, offset: rider.offset, label: shape.name, applied: 0 } } },
                system: { duration: rounds ? { value: rounds, unit: "rounds", expiry: "turn-start", sustained: false } : { value: -1, unit: "unlimited", expiry: null, sustained: false },
                    start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null }, tokenIcon: { show: false } } }]);
            await syncShapeFollow(actor);
            results.push({ label: `${shape.name}: ${rider.add.slug} ${rider.offset} above the spell's ${rider.slug}${rounds ? ` (${rounds} rounds)` : ""}`, status: "applied" });
        } else if (rider.type === "on-end") {
            // ("When the spell's duration ends, if the target was forced to dance for 1 minute, it becomes Fatigued.": the spell's Effect lasting that
            // long, ending by running its course.)
            const lasting = castGrants(target, actor).filter(grant => roundsOf(grant.effect.system?.duration) >= rider.minRounds).map(grant => grant.effect);
            if (!lasting.length) continue;
            const made = await tiedEffect(actor, `${shape.name}: ${rider.list.map(entry => entry.slug).join(", ")} when the spell ends`, lasting, { spellshapeTieExpire: { list: rider.list, label: shape.name } }, { tokenIcon: { show: false } });
            results.push({ label: `${shape.name}: ${rider.list.map(entry => entry.slug).join(", ")} when the spell runs its course`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "turn-damage") {
            // ("takes 1d12 electricity damage at the start of its turns while it remains stunned or Paralyzed due to the spell")
            const holding = castGrants(target, actor).filter(grant => grant.slugs.some(slug => rider.whileSlugs.includes(slug))).map(grant => grant.effect);
            if (!holding.length) continue;
            const made = await tiedEffect(actor, `${shape.name}: ${rider.formula} ${rider.damageType} as its turn starts`, holding,
                { runtime: { schema: 1, kind: "spellshape-turn-damage", castInstanceId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemName: shape.name, turnStartDamage: { formula: rider.formula, type: rider.damageType } } });
            results.push({ label: `${shape.name}: ${rider.formula} ${rider.damageType} at the start of its turns while ${rider.whileSlugs.join(" or ")}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "targeted-condition") {
            // (Mortisor: "When a creature within the area of your wicket's dominion below half Hit Points is targeted by one of your death or void spells, it becomes Frightened 2
            // … The creature is then immune to this effect for 1 minute." — its Hit Points as targeted: now plus what this spell took.)
            const taken = (target.damageResults ?? []).reduce((total, entry) => total + Number(entry.receipt?.damage ?? 0), 0);
            const hp = actor.hitPoints ?? actor.system?.attributes?.hp;
            if (rider.belowHalf && !(Number(hp?.value ?? 0) + taken < Number(hp?.max ?? 0) / 2)) continue;
            if (rider.inDominion && !inDominionOf(caster, token)) continue;
            if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.spellshapeImmunity?.name === shape.name)) continue;
            const immunities = (actor.attributes?.immunities ?? actor.system?.attributes?.immunities ?? []).map(entry => entry.type ?? entry);
            if ((rider.unlessImmune ?? []).some(type => immunities.includes(type))) continue;
            results.push(...await timedConditions(actor, rider.list, shape.name, options));
            await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: immune`, type: "effect", img: "icons/svg/aura.svg", flags: { [MODULE_ID]: { spellshapeImmunity: { name: shape.name } } },
                system: { duration: { value: rider.immunityMinutes, unit: "minutes", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false } } }]);
        } else if (rider.type === "target-rules") {
            // (Magnetor: "the creature gains a weakness to electricity damage after you Cast the Spell equal to its rank until the beginning of their next turn".)
            if (rider.singleOnly && (state.targets ?? []).filter(entry => entry.excluded !== true).length !== 1) continue;
            const rules = foundry.utils.deepClone(rider.rules).map(rule => rule.value === "rank" ? { ...rule, value: Number(state.castRank) } : rule);
            const made = await shapeEffect(actor, caster ?? actor, `${shape.name}: ${rider.label}`, rules, { rounds: 1 });
            results.push({ label: `${shape.name}: ${actor.name} ${rider.label}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "degree-rules") {
            // (Erosior: "a –5-foot status penalty to its Speed for 1 round on a failure, or a –10-foot status penalty if it was a critical failure".)
            const rules = attack ? null : rider.degrees?.[degree];
            if (!rules) continue;
            const made = await shapeEffect(actor, caster ?? actor, `${shape.name}: ${rider.label}`, rules, { rounds: rider.rounds ?? 1 });
            results.push({ label: `${shape.name}: ${actor.name} ${rider.label}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "push") {
            // (Propulsor: "when you successfully make a spell attack roll or a creature fails its save": the attack's degrees too.)
            const feet = (attack && rider.attackDegrees ? rider.attackDegrees : rider.degrees)?.[degree];
            if (!feet) continue;
            const from = rider.from?.[state.areaShape ?? ""] ?? "caster";
            // (Knockback Spell: away from the caster, or from the burst's centre — the cast's template — by the module; never ending in another's space.)
            const casterToken = caster?.getActiveTokens?.(true, true)?.[0] ?? null;
            const region = from === "center" && state.sourceMessageId ? canvas.scene?.regions.find(entry => entry.flags?.pf2e?.messageId === state.sourceMessageId) : null;
            const point = from === "center" ? (region?.shapes?.[0] ? { x: Number(region.shapes[0].x), y: Number(region.shapes[0].y) } : null)
                : casterToken ? { x: casterToken.x + Number(casterToken.width ?? 1) * canvas.grid.size / 2, y: casterToken.y + Number(casterToken.height ?? 1) * canvas.grid.size / 2 } : null;
            const moved = point && token ? await forcedMove(token, { point, direction: "away", feet, reason: shape.name }).catch(() => null) : null;
            if (moved?.moved) { results.push({ label: `${shape.name}: pushed ${moved.squares * 5} feet away from ${from === "center" ? "the center of the burst" : "the caster"}${moved.stoppedBy === "occupied" ? ", beside the creature in its way" : ""}`, status: "applied" }); continue; }
            const label = `${shape.name}: pushed ${feet} feet away from ${from === "center" ? "the center of the burst" : "the caster"} (move the token)`;
            try { await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(state.spellName)}</strong> — ${escapeHTML(actor.name)}: ${escapeHTML(label)}.</p>` }); } catch (_) {}
            results.push({ label, status: "manual" });
        } else if ((rider.type === "note" && !rider.wandRule && !rider.atCast) || rider.type === "gm-effect") {
            // (Once for the cast: the GM's part of the feat or wand.)
            state.shapeNoted ??= [];
            const key = `${shape.name}:${rider.text ?? rider.uuid}`;
            if (state.shapeNoted.includes(key)) continue;
            state.shapeNoted.push(key);
            const text = rider.type === "note" ? rider.text.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, "$1") : `PF2e's ${rider.name} for the creatures the feat names.`;
            try { await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(shape.name)}</strong> (GM): ${escapeHTML(text)}</p>` }); } catch (_) {}
        } else {
            // (A catalyst's: catalyst-runtime.js.)
            const own = await catalystSaveRider(state, target, actor, token, shape, rider, { degree, caster }).catch(error => [{ label: `${shape.name}: ${error.message}`, status: "failed" }]);
            if (own) results.push(...own);
        }
    }
    }
    return results;
}

/**
 * After every creature: the riders over the whole cast — a Focus Point back when the spell reduced a creature to 0 Hit Points (once per the stated
 * minutes), and "one creature of your choice that takes damage" (Marked for Rebuke, Forcible Energy).
 */
export async function finishShapeRiders(state, entries) {
    const results = [];
    // (Compressed Spell's penalty: for that save only.)
    if (state.shapeCompress?.effectUuid) { const effect = await fromUuid(state.shapeCompress.effectUuid).catch(() => null); await effect?.delete().catch(() => null); }
    // (Cloaked Casting's save penalty: that save only.)
    for (const uuid of state.shapeTempEffects ?? []) { const effect = uuid ? await fromUuid(uuid).catch(() => null) : null; await effect?.delete().catch(() => null); }
    // (Scholar's Lore: "against the next spell you cast" — its Effects from this caster gone from the creatures this spell reached.)
    for (const shape of state.shapeRiders ?? []) for (const rider of shape.riders) if (rider.type === "consume-target-effect") for (const entry of entries) {
        const spent = (entry.actor?.itemTypes?.effect ?? []).filter(effect => effect.name === rider.effectName && effect.system?.context?.origin?.actor === state.sourceActorUuid);
        if (spent.length) { await entry.actor.deleteEmbeddedDocuments("Item", spent.map(effect => effect.id)).catch(() => null); results.push({ label: `${shape.name}: ${entry.actor.name}'s ${rider.effectName} used`, status: "applied" }); }
    }
    // (Beguiling Feint's Off-Guard: "to your spell" — gone with it.)
    if (state.shapeFeint?.offGuardUuid) { const condition = await fromUuid(state.shapeFeint.offGuardUuid).catch(() => null); await condition?.delete().catch(() => null); }
    const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
    const damagedEntries = entries.filter(entry => (entry.target.damageResults ?? []).reduce((total, result) => total + Number(result.receipt?.damage ?? 0), 0) > 0);
    // (Fury of a Thousand: the card's Effects with their values raised — Murmuration's penalty on a critical failure.)
    const shapeSource = state.sourceMessageId ?? state.shapeMessageId ?? null;
    if ((state.shapeRiders ?? []).some(shape => shape.riders.some(rider => rider.type === "effect-value")) && shapeSource) {
        const made = entries.flatMap(entry => (entry.actor?.itemTypes?.effect ?? []).filter(effect => [effect.flags?.[MODULE_ID]?.runtime?.castInstanceId, effect.flags?.[MODULE_ID]?.outcomeEffect?.castId].includes(state.castId)));
        results.push(...await shapeAdjustEffects(shapeSource, made));
    }
    // (Mortisor: "You gain a +2 status bonus against mental effects for 1 round when you reduce a creature to 0 Hit Points.")
    for (const shape of state.shapeRiders ?? []) for (const rider of shape.riders) if (rider.type === "on-kill-rules" && caster && entries.some(entry => Number(entry.actor?.hitPoints?.value ?? 1) <= 0)) {
        const made = await shapeEffect(caster, caster, `${shape.name}: ${rider.label}`, rider.rules, { rounds: rider.rounds ?? 1 });
        results.push({ label: `${shape.name}: ${caster.name} ${rider.label}`, status: "applied", effectUuid: made?.uuid ?? null });
    }
    // (Reporting Spell: what the caster learns about one enemy the spell affected.)
    for (const shape of state.shapeRiders ?? []) for (const rider of shape.riders) if (rider.type === "report" && caster) results.push(...await reportingSpell(state, entries, shape, rider, caster));
    // (Tempest-Sun Redirection: "Until your next turn, when one of those targets damages you, that damage is reduced by twice the spell's rank.")
    if (state.shapeShielded?.retaliate && state.shapeShielded.actorUuids.length && caster) {
        const signatures = (await Promise.all(state.shapeShielded.actorUuids.map(uuid => fromUuid(uuid).catch(() => null)))).map(actor => actor?.signature).filter(Boolean);
        if (signatures.length) {
            const made = await shapeEffect(caster, caster, `${state.shapeShielded.name}: ${state.shapeShielded.retaliate} less damage from the spared`,
                [{ key: "Resistance", type: "all-damage", value: state.shapeShielded.retaliate, predicate: [{ or: signatures.map(signature => `origin:signature:${signature}`) }] }], { until: "caster-turn-start" });
            results.push({ label: `${state.shapeShielded.name}: ${caster.name} resists ${state.shapeShielded.retaliate} of the spared creatures' damage until the next turn`, status: "applied", effectUuid: made?.uuid ?? null });
        }
    }
    for (const shape of state.shapeRiders ?? []) for (const rider of shape.riders) {
        if (rider.type === "focus-regain") {
            if (!entries.some(entry => Number(entry.actor.hitPoints?.value ?? 1) <= 0) || !caster) continue;
            const last = Number(caster.getFlag(MODULE_ID, "focusRegainedAt")?.[shape.name] ?? -Infinity);
            if (rider.cooldownMinutes && game.time.worldTime - last < rider.cooldownMinutes * 60) { results.push({ label: `${shape.name}: a Focus Point was regained within ${rider.cooldownMinutes} minutes`, status: "skipped" }); continue; }
            const focus = caster.system?.resources?.focus;
            if (focus && Number(focus.value) < Number(focus.max)) await caster.update({ "system.resources.focus.value": Number(focus.value) + 1 });
            await caster.setFlag(MODULE_ID, "focusRegainedAt", { ...(caster.getFlag(MODULE_ID, "focusRegainedAt") ?? {}), [shape.name]: game.time.worldTime });
            results.push({ label: `${shape.name}: a Focus Point regained`, status: "applied" });
        } else if (rider.type === "spread-save") {
            // (Wand of Contagious Frailty: an Enfeebled target releases a 10-foot emanation, not including itself; each creature in it saves as if struck, one
            // degree better.)
            // (The spell as cast — a wand's own spell, from its card, when its item isn't kept.)
            const sourceCard = state.sourceMessageId ? game.messages.get(state.sourceMessageId) : null;
            const spell = (state.sourceItemUuid ? await fromUuid(state.sourceItemUuid).catch(() => null) : null)
                ?? (sourceCard ? (await game.modules.get(MODULE_ID).api.cardSpell(sourceCard).catch(() => null))?.item ?? null : null);
            for (const entry of entries.filter(entry => entry.token && entry.actor.hasCondition?.(rider.ifCondition))) {
                const around = tokensWithin(entry.token.document ?? entry.token, rider.feet).map(other => other.object ?? other);
                if (!around.length || !spell) continue;
                const api = game.modules.get(MODULE_ID).api;
                await api.saves.start(spell, { plan: await api.compile(spell), sourceActor: caster, targets: around, castRank: state.castRank, dc: state.dc, skipConfirmation: true,
                    ...(rider.degreeBetter ? { degreeAdjustment: { predicate: { kind: "everyone" }, map: { criticalFailure: "failure", failure: "success", success: "criticalSuccess", criticalSuccess: "criticalSuccess" }, sourceText: shape.name } } : {}) });
                results.push({ label: `${shape.name}: ${entry.actor.name}'s emanation — ${around.length} creature${around.length === 1 ? "" : "s"}, one degree better`, status: "applied" });
            }
        } else if (rider.type === "ash-puppet") {
            // (Wand of the Ash Puppet: a living creature the spell reduces to powder becomes the caster's sulfur zombie, a minion, for 1 minute.)
            for (const entry of entries.filter(entry => entry.token && Number(entry.actor.hitPoints?.value ?? 1) <= 0 && !traitsOf(entry.actor).some(trait => ["undead", "construct"].includes(trait)))) {
                const made = await ashPuppet(caster, entry, shape, rider, state).catch(error => ({ error: error.message }));
                results.push({ label: made?.error ? `${shape.name}: ${made.error}` : `${shape.name}: ${entry.actor.name}'s ashes rise as ${made.name}`, status: made?.error ? "failed" : "applied" });
            }
        } else if (rider.type === "on-kill-burst") {
            // (Wand of Slaughter: "If the spell slays a living target, the corpse releases grim energy in a 20-foot emanation, dealing 14 void damage.")
            const DamageRoll = CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
            for (const entry of entries.filter(entry => entry.token && Number(entry.actor.hitPoints?.value ?? 1) <= 0 && !(rider.living && traitsOf(entry.actor).some(trait => ["undead", "construct"].includes(trait))))) {
                const others = tokensWithin(entry.token.document ?? entry.token, rider.feet);
                const roll = await new DamageRoll(`${rider.formula}[${rider.damageType}]`).evaluate();
                for (const other of others) await applyDamageWithReceipt(other.actor, { damage: DamageRoll.fromData(roll.toJSON()), token: other, skipIWR: false, rollOptions: new Set(["area-damage"]) }, foundry.utils.randomID());
                results.push({ label: `${shape.name}: ${entry.actor.name}'s corpse — ${rider.formula} ${rider.damageType} to ${others.map(other => other.name).join(", ") || "no one"}`, status: "applied" });
            }
        } else if (rider.type === "shadow-pick") {
            // (Shadow Spell: one creature affected — an enemy only on a hit or a failed save — +2 Stealth or –2 Perception for 1 round; a newer shadow
            // ends the older.)
            const attack = state.saveStatistic === "spell-attack";
            const eligible = entries.filter(entry => !(rider.enemiesIfHitOrFailed && caster && enemyOf(caster, entry.actor))
                || (attack ? ["success", "criticalSuccess"].includes(entry.target.degree) : ["failure", "criticalFailure"].includes(entry.target.degree)));
            if (!eligible.length) continue;
            const pickedUuid = await riderChoice(shape, "Which creature?", eligible.map(entry => ({ value: entry.actor.uuid, label: entry.actor.name })));
            const picked = eligible.find(entry => entry.actor.uuid === pickedUuid) ?? eligible[0];
            const option = rider.options.find(entry => entry.value === (state.shadowOption ?? null)) ?? (enemyOf(caster, picked.actor) ? rider.options.find(entry => entry.modifier < 0) : rider.options.find(entry => entry.modifier > 0)) ?? rider.options[0];
            for (const token of canvas.scene?.tokens ?? []) for (const old of (token.actor?.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.spellshapeShadow === caster?.uuid)) await old.delete().catch(() => null);
            const made = await shapeEffect(picked.actor, caster, `${shape.name}: ${option.label}`, [{ key: "FlatModifier", selector: option.selector, type: "status", value: option.modifier }],
                { rounds: rider.rounds ?? 1, flags: { spellshapeShadow: caster?.uuid ?? null } });
            results.push({ label: `${shape.name}: ${picked.actor.name} ${option.label}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "card" && rider.center === "target") {
            // (Grasping Spirits Spell: "The target must attempt a Fortitude saving throw against your spell DC; on a failure, it is pulled …")
            const spell = state.sourceItemUuid ? await fromUuid(state.sourceItemUuid).catch(() => null) : null;
            const targets = entries.map(entry => entry.token?.object ?? entry.token).filter(Boolean);
            if (targets.length && caster) await startShapeCard({ caster, name: shape.name, rank: state.castRank, statistic: rider.statistic, outcomes: rider.outcomes, targets, dc: shapeDC(caster, spell) });
            results.push({ label: `${shape.name}: its save card`, status: "applied" });
        } else if (rider.type === "damaged-save" && caster) {
            // (Propulsor: "When you damage a creature with a force spell that does not require a saving throw, they must attempt a Fortitude save against your spell DC" —
            // a save card for the creatures it damaged.)
            if (rider.noSave && !["spell-attack", "strike"].includes(state.saveStatistic) && state.saveStatistic) continue;
            const hurt = damagedEntries.filter(entry => entry.token);
            if (!hurt.length) continue;
            const card = await startShapeCard({ caster, name: `${shape.name}: ${state.spellName}`, rank: state.castRank, statistic: rider.statistic, outcomes: rider.outcomes, targets: hurt.map(entry => entry.token.object ?? entry.token), dc: state.dc ?? shapeDC(caster, null) }).catch(error => ({ error: error.message }));
            results.push({ label: `${shape.name}: ${rider.statistic} save for ${hurt.map(entry => entry.actor.name).join(", ")}`, status: card?.error ? "failed" : "applied" });
        } else if (rider.type === "terrain" && rider.where === "around-creature") {
            // (Erosior: only around the creatures hit or failing.)
            const attackCard = state.saveStatistic === "spell-attack";
            const reached = rider.when === "hit-or-failed" ? entries.filter(entry => (attackCard ? ["success", "criticalSuccess"] : ["failure", "criticalFailure"]).includes(entry.target.degree)) : entries;
            const made = reached.length ? await snowAround(state, shape, rider, reached) : null;
            if (made) results.push(made);
        } else if (rider.type === "drain-temp-hp") {
            // ("half the initial damage a single creature takes from this spell; … the creature that took the most damage")
            const most = Math.max(0, ...entries.map(entry => (entry.target.damageResults ?? []).reduce((total, result) => total + Number(result.receipt?.damage ?? 0), 0)));
            const amount = Math.floor(most * rider.fraction);
            if (!amount || !caster) continue;
            results.push(await timedTempHp(caster, amount, shape.name, rider.rounds));
        } else if (rider.type === "choose-one") {
            const type = rider.typeFromSpell ? state.shapeSpell?.damageTypes?.[0] ?? null : null;
            const resists = actor => [...(actor.attributes?.resistances ?? []), ...(actor.attributes?.immunities ?? [])].some(entry => entry.type === type);
            const immune = actor => (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.spellshapeImmunity?.name === shape.name);
            const candidates = damagedEntries.filter(entry => !(rider.unlessResists && resists(entry.actor)) && !immune(entry.actor));
            if (!candidates.length) continue;
            const pickedUuid = await riderChoice(shape, "Which creature?", candidates.map(entry => ({ value: entry.actor.uuid, label: entry.actor.name })));
            const picked = candidates.find(entry => entry.actor.uuid === pickedUuid);
            if (!picked) continue;
            if (rider.generated) {
                const combat = game.combat?.started ? game.combat : null;
                await picked.actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: ${rider.generated.name}`, type: "effect", img: "icons/svg/target.svg",
                    flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name }, ...(combat && caster ? { turnBound: { actorUuid: caster.uuid, combatId: combat.id, startedAt: { round: combat.round, turn: combat.turn } } } : {}) } },
                    system: { duration: { value: 1, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                        rules: foundry.utils.deepClone(rider.generated.rules) } }]);
            } else {
                const template = await loadNativeEffectTemplate(rider.uuid);
                if (!template) continue;
                const source = prepareNativeEffectSource(template, { castInstanceId: state.castId, castRank: state.castRank, sourceActorUuid: state.sourceActorUuid,
                    sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, resolutionKind: "save", targetActorUuid: picked.actor.uuid });
                // (PF2e's choice — the damage type — made from the spell's.)
                if (type) {
                    const choiceRule = (source.system?.rules ?? []).find(rule => rule.key === "ChoiceSet");
                    if (choiceRule) { choiceRule.selection = type; foundry.utils.setProperty(source, `flags.system.rulesSelections.${choiceRule.flag ?? "damageType"}`, type); }
                }
                await createNativeEffect(picked.actor, source);
            }
            if (rider.immunityHours) await picked.actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: immune`, type: "effect", img: "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { spellshapeImmunity: { name: shape.name } } },
                system: { duration: { value: rider.immunityHours, unit: "hours", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false } } }]);
            picked.target.conditionResults = [...(picked.target.conditionResults ?? []), { label: `${shape.name}: ${rider.generated?.name ?? rider.name}${type ? ` (${type})` : ""}`, status: "applied" }];
            results.push({ label: `${shape.name}: ${picked.actor.name}`, status: "applied" });
        }
    }
    return results;
}

/** A template placed for a cast whose wand doubles a line's width (Wand of Crackling Lightning): the line made twice as wide as it's created. */
export function widenCastTemplate(region, data) {
    const messageId = data?.flags?.pf2e?.messageId;
    const shaping = messageId ? game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping") : null;
    const wide = (shaping?.shapes ?? []).flatMap(shape => shape.riders ?? []).find(rider => rider.type === "area" && rider.lineWidth);
    // (Reshaped Spell: a cone made a line twice its length, 5 feet wide; a line made a cone half its length.)
    const reshape = (shaping?.shapes ?? []).flatMap(shape => shape.riders ?? []).find(rider => rider.type === "reshape" && rider.to);
    if (reshape && !data.flags?.[MODULE_ID]?.reshaped) {
        const factor = Number(reshape.lineFactor ?? 2);
        const shapes = (data.shapes ?? []).map(shape => shape.type === "cone" && reshape.to === "line" ? { type: "line", x: shape.x, y: shape.y, rotation: shape.rotation ?? 0, length: Number(shape.radius) * factor, width: canvas.grid.size }
            : shape.type === "line" && reshape.to === "cone" ? { type: "cone", x: shape.x, y: shape.y, rotation: shape.rotation ?? 0, radius: Number(shape.length) / factor, angle: 90 } : shape);
        region.updateSource({ shapes, [`flags.${MODULE_ID}.reshaped`]: reshape.to });
        return true;
    }
    // (The shaped area's size in pixels: PF2e draws 5 feet to a grid square.)
    const size = shaping?.area ? shaping.area.to / 5 * canvas.grid.size : null;
    if (!wide && !size) return false;
    const KEY = { circle: "radius", cone: "radius", emanation: "radius", line: "length" };
    const shapes = (data.shapes ?? []).map(shape => {
        let next = shape;
        if (wide && shape.type === "line" && Number(shape.width) > 0) next = { ...next, width: Number(shape.width) * 2 };
        const key = KEY[shape.type];
        // (Enlarged to the shaped size, never shrunk: a template PF2e already enlarged stays as it is.)
        if (size && key && Number(next[key]) > 0 && Number(next[key]) < size - 0.5) next = { ...next, [key]: size };
        return next;
    });
    region.updateSource({ shapes });
    return true;
}

/** One of the spell's own Effects gone: the rider Effects tied to it go too — with their conditions first when it ran its course (Wand of Wearying Dance). */
export async function shapeTieEnded(item) {
    const actor = item?.actor;
    // (A condition gone — the last frightened: the Effects lasting "for as long as they remain frightened" go too.)
    if (activeGM() && item?.type === "condition" && actor && !actor.hasCondition?.(item.slug)) {
        const ending = (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.spellshapeWhileCondition === item.slug);
        if (ending.length) await actor.deleteEmbeddedDocuments("Item", ending.map(effect => effect.id)).catch(() => null);
        return ending.map(effect => ({ tie: effect.uuid, deleted: true }));
    }
    if (!activeGM() || item?.type !== "effect" || !actor) return [];
    const done = [];
    // (Items an Effect brought with it — Reverse Spellstrike's borrowed spell and its entry — gone with it.)
    const brought = (item.flags?.[MODULE_ID]?.removesItems ?? []).filter(id => actor.items.get(id));
    if (brought.length) { await actor.deleteEmbeddedDocuments("Item", brought).catch(() => null); done.push({ removed: brought.length }); }
    // (Colossal Aspect Form's form gone: the token back to its size, its Trample removed.)
    const colossal = item.flags?.[MODULE_ID]?.colossalForm;
    if (colossal) {
        const tokenDoc = colossal.restore ? await fromUuid(colossal.restore.tokenUuid).catch(() => null) : null;
        if (tokenDoc) await tokenDoc.update({ width: colossal.restore.width, height: colossal.restore.height, "flags.pf2e.linkToActorSize": colossal.restore.link });
        const given = actor.items.filter(entry => entry.flags?.[MODULE_ID]?.colossalOf === item.uuid).map(entry => entry.id);
        if (given.length) await actor.deleteEmbeddedDocuments("Item", given);
        done.push({ colossal: item.uuid, restored: Boolean(tokenDoc), removed: given.length });
    }
    for (const tie of (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.spellshapeTie?.tiedTo?.includes(item.uuid))) {
        const data = tie.flags[MODULE_ID].spellshapeTie, expire = tie.flags[MODULE_ID].spellshapeTieExpire;
        // (Ran its course: no time left when it went.)
        const ran = Number(item.remainingDuration?.remaining ?? 1) <= 0 || item.remainingDuration?.expired === true;
        if (expire && ran) { await timedConditions(actor, expire.list, expire.label); done.push({ tie: tie.uuid, applied: expire.list.map(entry => entry.slug) }); }
        const left = data.tiedTo.filter(uuid => uuid !== item.uuid && fromUuidSync(uuid));
        if (left.length && !(expire && ran)) await tie.setFlag(MODULE_ID, "spellshapeTie", { ...data, tiedTo: left });
        else { await tie.delete(); done.push({ tie: tie.uuid, deleted: true }); }
    }
    return done;
}

// (The cast an Effect came from: an outcome's wrapper, or a runtime Effect.)
const castIdOf = effect => effect?.flags?.[MODULE_ID]?.outcomeEffect?.castId ?? effect?.flags?.[MODULE_ID]?.runtime?.castInstanceId ?? null;
const followQueue = new Map();
/**
 * A creature watched by a follow rider (Wand of Dumbfounding Doom): when the spell's own Effect grants the condition (frightened), the other
 * (stupefied) at that value plus the offset, for the rest of the spell's duration; raised, never lowered, as the first rises.
 */
export function syncShapeFollow(actor) {
    if (!activeGM() || !actor) return Promise.resolve();
    const run = (followQueue.get(actor.uuid) ?? Promise.resolve()).then(async () => {
        for (const follow of (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.spellshapeFollow)) {
            const data = follow.flags[MODULE_ID].spellshapeFollow;
            const fromCast = (actor.itemTypes?.condition ?? []).filter(condition => condition.slug === data.slug
                && castIdOf(actor.items.get(condition.flags?.pf2e?.grantedBy?.id ?? "")) === data.castId);
            const value = Math.max(0, ...fromCast.map(condition => Number(condition.value ?? 1)));
            if (!value || value + data.offset <= Number(data.applied ?? 0)) continue;
            const want = value + data.offset;
            const old = (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.spellshapeFollowChild === follow.id);
            if (old.length) await actor.deleteEmbeddedDocuments("Item", old.map(effect => effect.id));
            await actor.createEmbeddedDocuments("Item", [{ name: `${data.label}: ${data.add.slug} ${want}`, type: "effect", img: "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { spellshapeFollowChild: follow.id, spellshapeTie: { tiedTo: [follow.uuid], label: data.label } } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
                    rules: [{ key: "GrantItem", uuid: data.add.uuid, onDeleteActions: { grantee: "restrict" }, alterations: [{ mode: "override", property: "badge-value", value: want }] }] } }]);
            await follow.setFlag(MODULE_ID, "spellshapeFollow", { ...data, applied: want });
        }
    }).catch(error => console.error(`${MODULE_ID} | spellshape follow`, error));
    followQueue.set(actor.uuid, run);
    return run;
}

/** The cast an applied healing or damage came from (PF2e's \`item:id\` on the message): the latest cast of that spell that a spellshape or wand shaped. */
function shapedCastFor(options) {
    const id = (options ?? []).find(option => /^item:id:/.test(option))?.slice(8);
    if (!id) return null;
    return game.messages.contents.slice(-200).reverse().find(message => String(message.flags?.pf2e?.origin?.uuid ?? "").endsWith(`Item.${id}`)
        && message.getFlag(MODULE_ID, "shaping")) ?? null;
}

/** Once for the cast ("one target of that spell"): true the first time. */
export async function firstForCast(cast, key) {
    const done = cast.getFlag(MODULE_ID, "shapedOnce") ?? {};
    if (done[key]) return false;
    await cast.setFlag(MODULE_ID, "shapedOnce", { ...done, [key]: true });
    return true;
}

/**
 * Healing or damage PF2e applied from a shaped cast (Heal and Harm resolve with PF2e's buttons): the riders on the creature it healed — PF2e's
 * Effect (Defensive Recovery), extra Strike dice (Divine Infusion), the caster's Hit Points given (Martyr), Hit Points more and a counteract
 * (Cleansing Spell, Purifying Spell) — or, for damage, the creature's damaged riders (Cast Down) with its save's degree.
 */
export async function shapeOnApplied(message) {
    const applied = message?.flags?.pf2e?.appliedDamage;
    if (!applied || !activeGM()) return [];
    const options = message.flags.pf2e.context?.options ?? [];
    // (Only what PF2e's own buttons applied: the module's cards carry their application marker, and apply their riders themselves.)
    if (options.some(option => option.startsWith("pf2e-auto-application:"))) return [];
    const cast = shapedCastFor(options);
    if (!cast) return [];
    const actor = await fromUuid(applied.uuid).catch(() => null);
    const caster = cast.actor;
    if (!actor || !caster) return [];
    const spell = cast.item;
    const rank = Number(cast.flags.pf2e.origin?.castRank ?? spell?.rank ?? 1);
    const token = actor.getActiveTokens?.(true, true)?.[0] ?? null;
    const shapes = shapeRidersFor(cast.id);
    const results = [];
    if (!applied.isHealing) {
        // (The creature's save against this cast, for "on a critical failure".)
        const save = game.messages.contents.slice(-100).reverse().find(entry => entry.flags?.pf2e?.context?.type === "saving-throw" && entry.actor === actor
            && entry.flags?.pf2e?.origin?.uuid === cast.flags.pf2e.origin.uuid);
        const degree = save?.flags?.pf2e?.context?.outcome ?? null;
        const state = { shapeRiders: shapes, castRank: rank, castId: cast.id, sourceActorUuid: caster.uuid, sourceItemUuid: spell?.uuid ?? null, spellName: spell?.name ?? "", saveStatistic: spell?.system?.defense?.save?.statistic ?? null, dc: spell?.spellcasting?.statistic?.dc?.value ?? null };
        // (PF2e's message is the damage itself: the creature was damaged by the spell.)
        const target = { degree, damageResults: [{ receipt: { damage: 1 } }], conditionResults: [] };
        results.push(...await applyShapeRiders(state, target, actor, token));
        if (results.length) await postShapeResults(caster, spell, actor, results);
        return results;
    }
    for (const shape of shapes) for (const rider of shape.riders) {
        if (rider.type === "healed-generated") {
            // (Codex of Destruction and Renewal: "The spell grants the target regeneration 20 … The effect lasts for 4 rounds.")
            if (!await firstForCast(cast, `${shape.name}:${actor.uuid}:generated`)) continue;
            const made = await shapeEffect(actor, caster, `${shape.name}: ${rider.name}`, rider.rules, { rounds: rider.rounds });
            results.push({ label: `${shape.name}: ${actor.name} gains ${rider.name} for ${rider.rounds} rounds`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "healed-full-effect") {
            // (Savior: "When a creature within the area of your wicket's dominion is restored to full Hit Points from one of your spells, it gains … The creature is then immune to
            // this effect for 1 minute.")
            const hp = actor.hitPoints ?? actor.system?.attributes?.hp;
            if (Number(hp?.value ?? 0) < Number(hp?.max ?? 1) || (rider.inDominion && !inDominionOf(caster, actor.getActiveTokens?.(true, true)?.[0]))) continue;
            if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.spellshapeImmunity?.name === shape.name)) continue;
            if (!await firstForCast(cast, `${shape.name}:${actor.uuid}:full`)) continue;
            const template = await loadNativeEffectTemplate(rider.effect.uuid);
            const made = template ? await createNativeEffect(actor, prepareNativeEffectSource(template, { castInstanceId: cast.id, castRank: rank, sourceActorUuid: caster.uuid, sourceItemUuid: spell?.uuid ?? null, sourceItemName: spell?.name ?? shape.name, resolutionKind: "save", targetActorUuid: actor.uuid })) : null;
            await actor.createEmbeddedDocuments("Item", [{ name: `${shape.name}: immune`, type: "effect", img: "icons/svg/aura.svg", flags: { [MODULE_ID]: { spellshapeImmunity: { name: shape.name } } },
                system: { duration: { value: rider.immunityMinutes, unit: "minutes", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false } } }]);
            results.push({ label: `${shape.name}: ${actor.name} ${rider.effect.name}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "ally-recipient-effect") {
            if (!await firstForCast(cast, `${shape.name}:${actor.uuid}:ally`)) continue;
            const result = await allyRecipientEffect(caster, actor, shape, rider, cast.id, rank, spell);
            if (result) results.push(result);
        } else if (rider.type === "healed-reduce") {
            // (Soothing Scents: "also causes the spell to reduce the target's Frightened condition value by 1.")
            if (!actor.hasCondition?.(rider.slug) || !await firstForCast(cast, `${shape.name}:${actor.uuid}:reduce`)) continue;
            for (let step = 0; step < rider.by; step++) if (actor.hasCondition?.(rider.slug)) await actor.decreaseCondition(rider.slug);
            results.push({ label: `${shape.name}: ${actor.name}'s ${rider.slug} reduced by ${rider.by}`, status: "applied" });
        } else if (rider.type === "healed-effect") {
            // (Healer's Gel: "to one target healed by the spell" — the first.)
            if (rider.once && !await firstForCast(cast, `${shape.name}:healed-once`)) continue;
            const template = await loadNativeEffectTemplate(rider.uuid);
            if (!template) continue;
            const source = prepareNativeEffectSource(template, { castInstanceId: cast.id, castRank: rank, sourceActorUuid: caster.uuid, sourceItemUuid: spell?.uuid ?? null,
                sourceItemName: spell?.name ?? shape.name, resolutionKind: "save", targetActorUuid: actor.uuid });
            // (Heroic Recovery+'s "At 16th level, the status bonus to speed increases to …": the Effect's rules at the caster's level.)
            if (rider.atLevel && Number(caster.level ?? 0) >= rider.atLevel.level) source.system.rules = foundry.utils.deepClone(rider.atLevel.rules);
            const made = await createNativeEffect(actor, source);
            results.push({ label: `${shape.name}: ${template.name}`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "healed-strike-dice") {
            const number = rider.dice.filter(entry => rank >= entry.rank).at(-1)?.number ?? rider.dice[0].number;
            const damageType = rider.typeBySpell[String(spell?.slug ?? spell?.name ?? "").toLowerCase()] ?? rider.typeBySpell[String(spell?.name ?? "").toLowerCase()] ?? "vitality";
            const made = await shapeEffect(actor, caster, `${shape.name}: +${number}d${rider.faces} ${damageType} on melee Strikes`, [{ key: "DamageDice", selector: "strike-damage", predicate: ["item:melee"], diceNumber: number, dieSize: `d${rider.faces}`, damageType }], { rounds: 1, until: null });
            await made?.update({ "system.duration.expiry": "turn-end" });
            results.push({ label: `${shape.name}: +${number}d${rider.faces} ${damageType} on melee Strikes until the end of its next turn`, status: "applied", effectUuid: made?.uuid ?? null });
        } else if (rider.type === "martyr") {
            if (!await firstForCast(cast, `${shape.name}:martyr`)) continue;
            const roll = await new Roll(`${rider.dice * rank}d${rider.faces}`).evaluate();
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(shape.name)}</strong>: Hit Points given to ${escapeHTML(actor.name)}` }).catch(() => null);
            // ("which can't be reduced or mitigated in any way": straight from the caster's Hit Points.)
            const hp = Number(caster.system?.attributes?.hp?.value ?? 0);
            await caster.update({ "system.attributes.hp.value": Math.max(0, hp - roll.total) });
            await actor.applyDamage({ damage: -roll.total, token: token ?? undefined, skipIWR: true, rollOptions: new Set(["item:trait:healing"]) });
            results.push({ label: `${shape.name}: ${caster.name} loses ${roll.total} Hit Points; ${actor.name} regains them`, status: "applied" });
        } else if (rider.type === "healed-extra") {
            if (!await firstForCast(cast, `${shape.name}:extra`)) continue;
            const amount = rider.amount === "level" ? Number(caster.level ?? 0) : Number(rider.amount);
            await actor.applyDamage({ damage: -amount, token: token ?? undefined, skipIWR: true, rollOptions: new Set(["item:trait:healing"]) });
            results.push({ label: `${shape.name}: ${actor.name} regains ${amount} Hit Points more`, status: "applied" });
        } else if (rider.type === "counteract-affliction") {
            // ("you can attempt to counteract a disease or poison affecting one target": the module's counteract card, against a tracked affliction.)
            const afflicted = (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.["pseudo-afflictions"]?.stages && rider.traits.some(trait => (effect.system?.traits?.value ?? []).includes(trait)));
            if (!afflicted || !await firstForCast(cast, `${shape.name}:counteract`)) continue;
            const plan = { source: { name: shape.name }, automation: { pendingCapabilities: [] }, resolution: { kind: "affliction-care", recipient: "target", modes: [], operations: [{ op: "counteract", source: "affliction", pick: 1, traits: rider.traits, grantsConditions: [] }] } };
            const care = game.modules.get(MODULE_ID).api.care;
            const choice = shape.choice && typeof shape.choice === "object" ? shape.choice : null;
            await care.start(spell, plan, { sourceActor: caster, castRank: rank, targets: token ? [token] : [], ...(choice ? { choices: choice } : {}) }).catch(error => results.push({ label: `${shape.name}: ${error.message}`, status: "failed" }));
            results.push({ label: `${shape.name}: counteract a ${rider.traits.join(" or ")} on ${actor.name}`, status: "applied" });
        } else if (rider.type === "note") {
            if (!await firstForCast(cast, `${shape.name}:${rider.text}`)) continue;
            try { await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(shape.name)}</strong> (GM): ${escapeHTML(rider.text.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, "$1"))}</p>` }); } catch (_) {}
        }
    }
    if (results.length) await postShapeResults(caster, spell, actor, results);
    return results;
}

async function postShapeResults(caster, spell, actor, results) {
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), flags: { [MODULE_ID]: { kind: "spellshape-applied" } },
        content: `<p><strong>${escapeHTML(spell?.name ?? "Spell")}</strong> — ${escapeHTML(actor.name)}</p><ul>${results.map(result => `<li>${escapeHTML(result.label)}</li>`).join("")}</ul>` }); } catch (_) {}
}

/** Several of the choices: given on the cast (an array), else the GM ticks them. */
async function riderPickMany(shape, label, choices) {
    if (Array.isArray(shape.choice)) return choices.filter(choice => shape.choice.includes(choice.value)).map(choice => choice.value);
    if (!choices.length) return [];
    return await foundry.applications.api.DialogV2.wait({ window: { title: `${shape.name}: ${label}` }, rejectClose: false,
        content: `<p>${escapeHTML(label)}</p>${choices.map((choice, index) => `<label><input type="checkbox" name="pick-${index}" value="${escapeHTML(choice.value)}"> ${escapeHTML(choice.label)}</label><br>`).join("")}`,
        buttons: [{ action: "ok", label: "Done", default: true, callback: (event, button) => [...button.form.querySelectorAll("input[type=checkbox]:checked")].map(input => input.value) }] }) ?? [];
}

/**
 * The targets a spellshape singles out on the card, before it's posted: Split Shot's second target (half damage, no effects beyond it) and
 * Tempest-Sun Redirection's shielded targets (the damage less the rank; the caster's resistance against them after).
 */
export async function assignShapeTargets(state) {
    const targets = (state.targets ?? []).filter(target => target.excluded !== true);
    for (const shape of state.shapeRiders ?? []) for (const rider of shape.riders) {
        if (rider.type === "split-target" && targets.length >= 2) {
            const pickedId = await riderChoice(shape, "Which is the second target?", targets.map(target => ({ value: target.actorUuid, label: target.name })));
            const second = targets.find(target => target.actorUuid === pickedId) ?? targets[1];
            if (rider.half) second.shapeHalf = true;
            if (rider.damageOnly) second.shapeDamageOnly = true;
            second.shapeNote = `${shape.name}: the second target`;
        } else if (rider.type === "shield-targets") {
            const picked = await riderPickMany(shape, "Which targets does the spell spare?", targets.map(target => ({ value: target.actorUuid, label: target.name })));
            const amount = rider.reduce === "rank" ? Number(state.castRank) : Number(rider.reduce);
            for (const target of targets.filter(target => picked.includes(target.actorUuid))) { target.shapeReduce = amount; target.shapeNote = `${shape.name}: ${amount} less damage`; }
            state.shapeShielded = { name: shape.name, actorUuids: picked, retaliate: rider.retaliate === "2rank" ? 2 * Number(state.castRank) : null };
        } else if (rider.type === "exclude-allies") {
            // (Safe Spell: "you can designate 2 allies to exclude from the spell's effect", one more at 10th level and every 4 levels after.)
            const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
            const level = Number(caster?.level ?? 1), count = rider.count;
            const most = count.base + (level >= count.from ? 1 + Math.floor((level - count.from) / count.every) : 0);
            const allies = [];
            for (const target of targets) { const actor = await fromUuid(target.actorUuid).catch(() => null); if (actor && caster && actor !== caster && actor.alliance && actor.alliance === caster.alliance) allies.push(target); }
            const picked = (await riderPickMany(shape, `Which allies are excluded (up to ${most})?`, allies.map(target => ({ value: target.actorUuid, label: target.name })))).slice(0, most);
            for (const target of allies.filter(target => picked.includes(target.actorUuid))) Object.assign(target, { excluded: true, eligibilityReason: `${shape.name}: excluded`, shapeNote: `${shape.name}: excluded` });
        } else if (rider.type === "feint-check" && targets.length && !state.shapeFeint) {
            // (Beguiling Feint: the Deception check against the creature's Perception DC, with the module's rule for the Intelligence modifier.)
            const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
            const casterToken = caster?.getActiveTokens?.(true, true)?.[0] ?? null;
            const near = [];
            for (const target of targets) { const token = await fromUuid(target.tokenUuid).catch(() => null); if (!casterToken || !token || tokenDistance(casterToken, token) <= rider.within) near.push(target); }
            if (!near.length || !caster) { state.shapeFeint = { result: "no creature within range" }; continue; }
            const pickedId = await riderChoice(shape, "Which creature do you feint?", near.map(target => ({ value: target.actorUuid, label: target.name })));
            const one = near.find(target => target.actorUuid === pickedId) ?? near[0];
            const actor = await fromUuid(one.actorUuid).catch(() => null);
            const dc = Number(actor?.perception?.dc?.value ?? actor?.system?.perception?.dc ?? (10 + Number(actor?.perception?.mod ?? 0)));
            // ("using your Intelligence modifier instead of your Charisma modifier": the difference added — the module's own rule only adds Intelligence beside it.)
            const abilities = caster.abilities ?? caster.system?.abilities ?? {};
            const swap = Number(abilities.int?.mod ?? 0) - Number(abilities.cha?.mod ?? 0);
            const Modifier = game.pf2e?.Modifier;
            const modifiers = swap && Modifier ? [new Modifier({ slug: "beguiling-feint-intelligence", label: `${shape.name}: Intelligence instead of Charisma`, modifier: swap, type: "untyped" })] : [];
            const roll = await caster.skills?.[rider.skill]?.roll({ dc: { value: dc }, modifiers, skipDialog: true, createMessage: true });
            const degree = ["criticalFailure", "failure", "success", "criticalSuccess"][roll?.degreeOfSuccess ?? -1] ?? null;
            state.shapeFeint = { degree, dc, total: roll?.total ?? null, actorUuid: one.actorUuid };
            if (["success", "criticalSuccess"].includes(degree) && actor) {
                // (Off-Guard to the spell; the caster's concealment to that creature a reminder Effect until the end of its next turn.)
                const condition = actor.hasCondition?.("off-guard") ? null : await actor.increaseCondition?.("off-guard").catch(() => null);
                state.shapeFeint.offGuardUuid = condition?.uuid ?? actor.getCondition?.("off-guard")?.uuid ?? null;
                await shapeEffect(caster, caster, `${shape.name}: concealed to ${actor.name}`, [], { until: "caster-next-turn-end", description: `${rider.concealed}${degree === "success" ? ` (${rider.successNote.replace(/^except /, "")})` : ""}` });
                one.shapeNote = `${shape.name}: Off-Guard to the spell`;
            } else if (degree === "criticalFailure") await timedConditions(caster, [{ slug: "off-guard", uuid: "Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg", value: null, until: "caster-next-turn-end" }], shape.name, { caster });
        } else if (rider.type === "offguard-save-penalty" && targets.length === 1) {
            // (Cloaked Casting: "they also take a –1 circumstance penalty to their saves" when the single enemy is Off-Guard to the caster — that save only.)
            const actor = await fromUuid(targets[0].actorUuid).catch(() => null);
            const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
            if (!actor?.hasCondition?.("off-guard") || !caster || (actor.alliance && actor.alliance === caster.alliance)) continue;
            const made = await shapeEffect(actor, caster, `${shape.name}: –${rider.value} to the save against ${state.spellName}`, [{ key: "FlatModifier", selector: "saving-throw", type: rider.modifierType, value: -rider.value }], { rounds: 1 });
            (state.shapeTempEffects ??= []).push(made?.uuid ?? null);
            targets[0].shapeNote = `${shape.name}: –${rider.value} ${rider.modifierType} to its save (Off-Guard)`;
        } else if (rider.type === "twin-target" && targets.length === 2) {
            // (Ardor: "you can also target another one within it. All numerical effects … are halved. If the spell requires a save, both creatures gain a +2 circumstance bonus to
            // their save …")
            const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
            for (const target of targets) {
                target.shapeHalf = true; target.shapeNote = `${shape.name}: halved; ${rider.note}`;
                const actor = await fromUuid(target.actorUuid).catch(() => null);
                if (actor && state.saveStatistic && state.saveStatistic !== "spell-attack") {
                    const made = await shapeEffect(actor, caster ?? actor, `${shape.name}: +${rider.saveBonus} to the save`, [{ key: "FlatModifier", selector: "saving-throw", type: "circumstance", value: rider.saveBonus }], { rounds: 1 });
                    (state.shapeTempEffects ??= []).push(made?.uuid ?? null);
                }
            }
        } else if (rider.type === "offguard-concealed") {
            // (Extended Cloaking: Concealed to each Off-Guard enemy for the spell's rank in rounds — a reminder Effect on the caster.)
            const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
            for (const target of targets) {
                const actor = await fromUuid(target.actorUuid).catch(() => null);
                if (!caster || !actor?.hasCondition?.("off-guard") || (actor.alliance && actor.alliance === caster.alliance)) continue;
                await shapeEffect(caster, caster, `${shape.name}: concealed to ${actor.name}`, [], { rounds: Number(state.castRank) || 1, description: `Concealed to ${actor.name}. ${rider.note}` });
            }
        } else if (rider.type === "hone" && targets.length) {
            // (Hone Spell: one creature the only one affected; the others out.)
            const pickedId = await riderChoice(shape, "Which creature does the honed spell target?", targets.map(target => ({ value: target.actorUuid, label: target.name })));
            const one = targets.find(target => target.actorUuid === pickedId) ?? targets[0];
            for (const target of targets.filter(target => target !== one)) Object.assign(target, { excluded: true, eligibilityReason: `${shape.name}: not the honed spell's target` });
            one.shapeNote = `${shape.name}: the caster's spell attack against its AC (a miss: no effect; a hit: a failure; a critical hit: a critical failure)`;
            state.shapeHone = { label: shape.name, degrees: rider.degrees, ringBonus: rider.ringBonus === true };
        } else if (rider.type === "compress" && targets.length) {
            // (Compressed Spell: one creature in the area the target, with its penalty to this save; the others out.)
            const pickedId = await riderChoice(shape, "Which creature does the compressed spell target?", targets.map(target => ({ value: target.actorUuid, label: target.name })));
            const one = targets.find(target => target.actorUuid === pickedId) ?? targets[0];
            for (const target of targets.filter(target => target !== one)) Object.assign(target, { excluded: true, eligibilityReason: `${shape.name}: not the compressed spell's target` });
            const actor = await fromUuid(one.actorUuid).catch(() => null);
            const value = Number(rider.penaltyNow ?? rider.penalty);
            const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
            const made = actor ? await shapeEffect(actor, caster ?? actor, `${shape.name}: –${value} to the save against ${state.spellName}`, [{ key: "FlatModifier", selector: "saving-throw", type: "status", value: -value }], { rounds: 1 }) : null;
            one.shapeNote = `${shape.name}: –${value} status to its save`;
            state.shapeCompress = { effectUuid: made?.uuid ?? null, value };
        } else if (rider.type === "transmute" && rider.chosen?.onlyWeakTo?.length) {
            // (Transmute Spell's Spirit: "this spirit damage only damages creatures with a weakness to holy, spirit, or unholy".)
            for (const target of targets) {
                const actor = await fromUuid(target.actorUuid).catch(() => null);
                const weak = (actor?.attributes?.weaknesses ?? actor?.system?.attributes?.weaknesses ?? []).some(entry => rider.chosen.onlyWeakTo.includes(entry.type));
                if (!weak) Object.assign(target, { shapeNoDamage: true, shapeNote: `${shape.name}: no weakness to ${rider.chosen.onlyWeakTo.join(", ")} — no damage` });
            }
        }
    }
}

/** The cast's rank as a spellshape changed it (recorded with the cast), or null. */
export function shapedCastRank(messageId) {
    const rank = game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping")?.castRank;
    return Number.isInteger(rank) && rank > 0 ? rank : null;
}

/** The highest spell rank the caster can cast: its spellcasting's highest slot (half its level, rounded up, without slots). */
export function highestCastableRank(actor) {
    let highest = 0;
    for (const entry of actor?.spellcasting?.regular ?? []) for (let rank = 10; rank >= 1; rank--) if (Number(entry.system?.slots?.[`slot${rank}`]?.max ?? 0) > 0) { highest = Math.max(highest, rank); break; }
    return highest || Math.max(1, Math.ceil(Number(actor?.level ?? 1) / 2));
}

/** "use mythic proficiency to determine your … save DC": the DC with mythic proficiency's bonus (the level + 10) in place of the spell's. */
export function mythicDC(state, caster, spell) {
    if (!(state.shapeRiders ?? []).some(shape => shape.riders.some(rider => rider.type === "mythic-proficiency" && rider.chosen !== false))) return null;
    const statistic = spell?.spellcasting?.statistic;
    const proficiency = (statistic?.dc?.modifiers ?? statistic?.check?.modifiers ?? []).find(modifier => modifier.type === "proficiency");
    if (!proficiency || !Number.isFinite(Number(state.dc))) return null;
    return Number(state.dc) - Number(proficiency.modifier) + Number(caster?.level ?? 0) + 10;
}

// ---- Family H: terrain the spellshape makes (its own Region, kept apart from the cast's template) ----

const DIFFICULT = { walk: 2, travel: 2 };
/** A spellshape's terrain: a Region with its difficult terrain, and its hazard and end on a flag. */
export async function shapeTerrain(scene, shapes, { name, castId, caster, rider, damageType = null, hazardDice = null, until = null }) {
    const now = game.time.worldTime;
    const combat = game.combat?.started ? game.combat : null;
    // (Its difficult terrain made with it: a modifyMovementCost behavior.)
    const behaviors = rider.difficult ? [{ name: `${name}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: DIFFICULT } }] : [];
    const [region] = await scene.createEmbeddedDocuments("Region", [{ name, color: "#7a5230", shapes: foundry.utils.deepClone(shapes), visibility: CONST.REGION_VISIBILITY?.ALWAYS ?? 2, behaviors,
        flags: { [MODULE_ID]: { spellshapeTerrain: { castId, casterUuid: caster.uuid, name, hazard: rider.hazard ? { ...rider.hazard, ...(damageType ? { damageType } : {}), ...(hazardDice ? { formula: hazardDice } : {}) } : null,
            exemptCaster: !!rider.exemptCaster, expiresAt: rider.rounds ? now + rider.rounds * 6 : null, whileRegionUuid: rider.whileRegionUuid ?? null,
            untilCasterTurn: until === "caster-turn-start" ? { combatId: combat?.id ?? null, startedAt: combat ? { round: combat.round, turn: combat.turn } : null, worldTime: now } : null, hits: {} } } } }]);
    if (rider.difficult && !region.behaviors.some(behavior => behavior.type === "modifyMovementCost"))
        await region.createEmbeddedDocuments("RegionBehavior", [{ name: `${name}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: DIFFICULT } }]);
    return region;
}

/** A terrain card for the GM: the hazard's damage for a creature that moved through (or into) it. */
export async function postTerrainCard(caster, region, text) {
    const data = region.flags[MODULE_ID].spellshapeTerrain;
    const button = data.hazard ? `<button type="button" data-pf2e-auto-terrain="move" data-region="${region.uuid}">${data.hazard.per === "square" ? "A creature moved through it (target it; give the squares)" : "A creature moved into it (target it)"}</button>` : "";
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), flags: { [MODULE_ID]: { kind: "spellshape-terrain", regionUuid: region.uuid } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(data.name)}</strong>: ${escapeHTML(text)}</p>${button}</section>` }); } catch (_) {}
}

/** The cast's template placed: a spellshape making the spell's area terrain (Charred Remains) copies it into its own Region. */
export async function shapeTerrainFromTemplate(region) {
    if (!activeGM()) return null;
    const messageId = region?.flags?.pf2e?.messageId;
    const message = messageId ? game.messages.get(messageId) : null;
    const shaping = message?.getFlag(MODULE_ID, "shaping");
    if (!shaping || shaping.terrainMade) return null;
    const entry = (shaping.shapes ?? []).flatMap(shape => (shape.riders ?? []).map(rider => ({ shape, rider }))).find(item => item.rider.type === "terrain" && item.rider.where === "area");
    if (!entry || !message.actor) return null;
    await message.setFlag(MODULE_ID, "shaping", { ...shaping, terrainMade: true });
    const shapes = region.shapes.map(shape => shape.toObject?.() ?? shape);
    // ("for the duration of the spell": the spell's own duration in rounds.)
    const rounds = entry.rider.rounds === "spell" ? shapeSpellFacts(message.item).durationRounds ?? 10 : entry.rider.rounds;
    const terrain = await shapeTerrain(region.parent, shapes, { name: `${entry.shape.name}: terrain`, castId: message.id, caster: message.actor, rider: { ...entry.rider, rounds } });
    const hazard = entry.rider.hazard;
    const what = hazard?.per === "turn-end-save" ? `a creature ending its turn in the area attempts a DC ${hazard.dc} ${hazard.statistic} save` : hazard ? `difficult and hazardous terrain (${hazard.formula} ${hazard.damageType} for each square a creature moves through)` : "difficult terrain";
    await postTerrainCard(message.actor, terrain, `the area: ${what}, for ${rounds / 10 >= 1 ? `${rounds / 10} minute(s)` : `${rounds} round(s)`}.`);
    return terrain;
}

/** "A creature moved through it": the hazard's damage — per square, or once (once per turn when the text says so); the caster exempt when it says so. */
export async function shapeTerrainMove(regionUuid, tokenUuid, squares = 1) {
    const region = await fromUuid(regionUuid), token = await fromUuid(tokenUuid);
    const data = region?.flags?.[MODULE_ID]?.spellshapeTerrain;
    const actor = token?.actor;
    if (!data?.hazard || !actor) throw new Error("The terrain or the creature is gone.");
    if (data.exemptCaster && (actor.uuid === data.casterUuid || actor.system?.master?.uuid === data.casterUuid || actor.master?.uuid === data.casterUuid)) return { exempt: true };
    // (Broken Ram's Thorn: "The first creature that moves into each affected square must succeed at an Acrobatics check … or take …" — the check first; the caltrops spent once they hurt.)
    if (data.hazard.check) {
        const statistic = actor.getStatistic?.(data.hazard.check.skill) ?? actor.skills?.[data.hazard.check.skill];
        const rolled = statistic ? await statistic.roll({ dc: { value: data.hazard.check.dc }, extraRollOptions: ["catalyst:caltrops"], skipDialog: true }) : null;
        if (rolled && Number(rolled.total) >= Number(data.hazard.check.dc)) return { avoided: true, total: rolled.total };
    }
    const count = data.hazard.per === "square" ? Math.max(1, Number(squares) || 1) : 1;
    if (data.hazard.oncePerTurn) {
        const stamp = game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : `t${game.time.worldTime}`;
        if (data.hits?.[actor.id] === stamp) return { already: true };
        await region.setFlag(MODULE_ID, "spellshapeTerrain", { ...data, hits: { ...(data.hits ?? {}), [actor.id]: stamp } });
    }
    const DamageRoll = CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
    let lost = 0;
    for (let square = 0; square < count; square++) {
        const roll = await new DamageRoll(`${data.hazard.formula}[${data.hazard.damageType}]`).evaluate();
        const receipt = await applyDamageWithReceipt(actor, { damage: roll, token, skipIWR: false, rollOptions: new Set(["area-damage"]) }, foundry.utils.randomID());
        lost += Number(receipt?.damage ?? 0);
    }
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${escapeHTML(data.name)}</strong>: ${escapeHTML(actor.name)} — ${count > 1 ? `${count} squares, ` : ""}${lost} ${escapeHTML(data.hazard.damageType)} damage.</p>` }); } catch (_) {}
    if (data.hazard.spentOnHit) await region.delete().catch(() => null);
    return { lost, squares: count };
}

/** A creature's turn ending inside hazardous terrain that hurts "a creature that … ends its turn in one" (Garland Spell). */
export async function shapeTerrainTurnEnd(combat) {
    if (!activeGM() || !combat?.started) return [];
    const previous = combat.previous?.combatantId ? combat.combatants.get(combat.previous.combatantId) : null;
    const token = previous?.token;
    if (!token?.actor) return [];
    const done = [];
    for (const region of token.parent?.regions ?? []) {
        const data = region.flags?.[MODULE_ID]?.spellshapeTerrain;
        if (!["entry-or-turn-end", "turn-end-save"].includes(data?.hazard?.per) || !tokenInRegion(token, region)) continue;
        if (data.hazard.per === "turn-end-save") {
            // (Wand of Hopeless Night: "Each creature that ends its turn within the spell's area must succeed at a DC 20 Will save or become Frightened 1".)
            const caster = await fromUuid(data.casterUuid).catch(() => null);
            // (Spell Ignition: "Creatures other than you … take damage … with a basic Fortitude save".)
            if (data.hazard.exceptCaster && token.actor.uuid === data.casterUuid) continue;
            if (caster) done.push(await startShapeCard({ caster, name: data.name, rank: 1, statistic: data.hazard.statistic, ...(data.hazard.damage ? { damage: data.hazard.damage } : { outcomes: data.hazard.outcomes }),
                targets: [token.object ?? token], dc: data.hazard.dc, entryId: caster.spellcasting?.regular?.[0]?.id ?? null }).catch(() => null));
            continue;
        }
        done.push(await shapeTerrainMove(region.uuid, token.uuid).catch(() => null));
    }
    return done;
}

/** Whether a token stands in a Region: Foundry's own record, or its centre inside one of the Region's shapes (a Region just made isn't recorded at once). */
export function tokenInRegion(token, region) {
    if (token.regions?.has?.(region)) return true;
    const size = canvas.grid.size;
    const x = token.x + Number(token.width ?? 1) * size / 2, y = token.y + Number(token.height ?? 1) * size / 2;
    if (typeof region.object?.testPoint === "function") { try { if (region.object.testPoint({ x, y, elevation: token.elevation ?? 0 })) return true; } catch (_) {} }
    return (region.shapes ?? []).some(shape => shape.type === "circle" || shape.type === "emanation" ? Math.hypot(x - shape.x, y - shape.y) <= Number(shape.radius)
        : shape.type === "rectangle" ? x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height : false);
}

/** Terrain whose time is up — its minute passed, or the caster's next turn begun — removed. */
export async function expireShapeTerrain() {
    if (!activeGM() || !canvas?.scene) return 0;
    const combat = game.combat?.started ? game.combat : null;
    const gone = [];
    for (const region of canvas.scene.regions) {
        const data = region.flags?.[MODULE_ID]?.spellshapeTerrain;
        if (!data) continue;
        // ("as long as your wicket's dominion is in effect": gone with that region.)
        const timeUp = (data.expiresAt != null && game.time.worldTime >= data.expiresAt) || (data.whileRegionUuid && !fromUuidSync(data.whileRegionUuid));
        const turn = data.untilCasterTurn;
        const casterTurn = turn && (combat && turn.combatId === combat.id ? combat.combatant?.actor?.uuid === data.casterUuid && (combat.round > turn.startedAt.round || combat.turn !== turn.startedAt.turn)
            : !combat && game.time.worldTime >= turn.worldTime + 6);
        if (timeUp || casterTurn) gone.push(region.id);
    }
    if (gone.length) await canvas.scene.deleteEmbeddedDocuments("Region", gone);
    // (Fabricator's creature: "while within the area" — its Effect gone with the dominion.)
    for (const token of canvas.scene.tokens) {
        const stale = (token.actor?.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.whileRegionUuid && !fromUuidSync(effect.flags[MODULE_ID].whileRegionUuid));
        if (stale.length) await token.actor.deleteEmbeddedDocuments("Item", stale.map(effect => effect.id)).catch(() => null);
    }
    return gone.length;
}

/** The terrain card's button: the GM targets the creature (and gives the squares). */
export function bindTerrainButtons(message, html) {
    for (const button of html.querySelectorAll?.("[data-pf2e-auto-terrain]") ?? []) button.addEventListener("click", async () => {
        try {
            if (button.dataset.pf2eAutoTerrain === "garland") return await growGarland(message);
            const [target] = [...game.user.targets];
            if (!target || game.user.targets.size !== 1) return ui.notifications.warn("Target the one creature that moved.");
            const region = await fromUuid(button.dataset.region);
            const perSquare = region?.flags?.[MODULE_ID]?.spellshapeTerrain?.hazard?.per === "square";
            const squares = perSquare ? await foundry.applications.api.DialogV2.prompt({ window: { title: "Squares moved through" }, rejectClose: false,
                content: `<input type="number" name="squares" min="1" value="1">`, ok: { callback: (event, b) => Number(b.form.elements.squares.value) } }) : 1;
            if (!squares) return;
            await shapeTerrainMove(button.dataset.region, target.document.uuid, squares);
        } catch (error) { ui.notifications.error(error.message); }
    });
}

/** Garland Spell's burst: grown at the targeted token (thorns or vines), replacing the caster's earlier garland. */
export async function growGarland(message, { choice = null, at = null } = {}) {
    const data = message.getFlag(MODULE_ID, "garland");
    const caster = await fromUuid(data?.casterUuid ?? "");
    const token = at ?? [...game.user.targets][0]?.document ?? null;
    if (!data || !caster || !token) throw new Error("Target the token at the garland's center.");
    const kind = choice ?? await riderChoice({ name: data.name, choice: null }, "Thorns or poisonous vines?", Object.entries(data.rider.hazard.choice).map(([value, type]) => ({ value, label: `${value} (${type})` })));
    const damageType = data.rider.hazard.choice[kind] ?? Object.values(data.rider.hazard.choice)[0];
    for (const old of token.parent.regions.filter(region => region.flags?.[MODULE_ID]?.spellshapeTerrain?.casterUuid === caster.uuid && region.flags[MODULE_ID].spellshapeTerrain.garland))
        await old.delete();
    const level = Number(caster.level ?? 1);
    const number = data.rider.hazard.dice.filter(entry => level >= entry.level).at(-1)?.number ?? 2;
    const center = token.object?.center ?? { x: token.x + token.width * canvas.grid.size / 2, y: token.y + token.height * canvas.grid.size / 2 };
    const region = await shapeTerrain(token.parent, [{ type: "circle", x: center.x, y: center.y, radius: data.rider.feet / 5 * canvas.grid.size }],
        { name: `${data.name}: garland (${kind})`, castId: message.id, caster, rider: data.rider, damageType, hazardDice: `${number}d${data.rider.hazard.faces}` });
    await region.setFlag(MODULE_ID, "spellshapeTerrain", { ...region.flags[MODULE_ID].spellshapeTerrain, garland: true });
    await postTerrainCard(caster, region, `${kind}: difficult and hazardous terrain; ${number}d${data.rider.hazard.faces} ${damageType} to a creature moving in or ending its turn there (once a turn; the caster immune).`);
    return region;
}

/** Snowdrift Spell's snow around a creature the spell affected: its squares and those adjacent, difficult terrain until the caster's next turn. */
async function snowAround(state, shape, rider, entries) {
    const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
    const candidates = entries.filter(entry => entry.token);
    if (!caster || !candidates.length) return null;
    // (Fractal Frosting: "difficult terrain in a 5-foot emanation in the area around each of the targets that lasts for 1 round".)
    if (rider.each) {
        const made = [];
        for (const entry of candidates) {
            const token = entry.token.document ?? entry.token, size = canvas.grid.size, squares = Math.max(1, Math.round(Number(rider.feet ?? 5) / 5));
            const what = rider.hazard ? "hazardous terrain" : "difficult terrain";
            const region = await shapeTerrain(token.parent, [{ type: "rectangle", x: token.x - squares * size, y: token.y - squares * size, width: (token.width + 2 * squares) * size, height: (token.height + 2 * squares) * size }],
                { name: `${shape.name}: ${what} around ${entry.actor.name}`, castId: state.castId, caster, rider: { ...rider, rounds: null }, until: rider.until });
            made.push(region?.uuid ?? null);
            if (region && rider.hazard) await postTerrainCard(caster, region, `hazardous terrain around ${entry.actor.name} (${rider.hazard.formula} ${rider.hazard.damageType} each time a creature passes through)${rider.whileRegionUuid ? ", while the dominion lasts" : ""}.`);
        }
        return { label: `${shape.name}: difficult terrain around ${candidates.map(entry => entry.actor.name).join(", ")} until ${caster.name}'s next turn`, status: "applied", regionUuids: made };
    }
    const pickedUuid = await riderChoice(shape, "Which creature's ground fills with snow?", candidates.map(entry => ({ value: entry.actor.uuid, label: entry.actor.name })));
    const picked = candidates.find(entry => entry.actor.uuid === pickedUuid) ?? candidates[0];
    const token = picked.token.document ?? picked.token;
    const size = canvas.grid.size;
    const shapes = [{ type: "rectangle", x: token.x - size, y: token.y - size, width: (token.width + 2) * size, height: (token.height + 2) * size }];
    const region = await shapeTerrain(token.parent, shapes, { name: `${shape.name}: snow`, castId: state.castId, caster, rider: { ...rider, rounds: null }, until: rider.until });
    return { label: `${shape.name}: snow around ${picked.actor.name} (difficult terrain until ${caster.name}'s next turn)`, status: "applied", regionUuid: region?.uuid ?? null };
}

// ---- A spellshape's own save card (family C): a spell made from the feat's numbers, compiled by the module, at the caster's DC ----

const SAVE_NAME = { fortitude: "Fortitude", reflex: "Reflex", will: "Will" };
/**
 * The feat's save as a spell of its own: "all enemies within 30 feet take spirit damage equal to double the rank of the spell (basic Will save against
 * your spell DC)" — its basic damage, or its four outcome rows — compiled and started on the creatures it names. Riders (a push's reminder) go with it.
 */
export async function startShapeCard({ caster, name, img = "icons/svg/explosion.svg", rank, statistic, damage = null, outcomes = null, area = null, traits = [], targets, dc, riders = [], forcedOrigin = null, entryId = null }) {
    const save = SAVE_NAME[statistic];
    const rows = outcomes ? ["criticalSuccess", "success", "failure", "criticalFailure"].map(degree => `<p><strong>${{ criticalSuccess: "Critical Success", success: "Success", failure: "Failure", criticalFailure: "Critical Failure" }[degree]}</strong> ${outcomes[degree]}</p>`).join("") : "";
    // (The plain wording the compiler reads as a basic save's damage: "All creatures in the area take 3d6 fire damage (basic Reflex save against your spell DC).")
    const text = damage ? `<p>All creatures in the area take ${damage.formula} ${damage.type} damage (basic ${save} save against your spell DC).</p>` : `<p>Each creature in the area must attempt a ${save} save.</p>${rows}`;
    const source = { _id: foundry.utils.randomID(), name, type: "spell", img, system: { slug: null, level: { value: Number(rank) }, traits: { value: [...traits], rarity: "common", traditions: [] },
        description: { value: text }, time: { value: "1" }, duration: { value: "", sustained: false }, target: { value: "" }, range: { value: "" }, area: area ?? null,
        defense: { save: { statistic, basic: !!damage } }, damage: damage ? { shape: { formula: damage.formula, type: damage.type, category: null, materials: [], kinds: ["damage"] } } : {},
        // (A spellcasting entry when one is given: PF2e rolls a spell's damage only through one.)
        heightening: null, location: { value: entryId, heightenedLevel: Number(rank) } } };
    const item = new CONFIG.Item.documentClass(source, { parent: caster });
    const api = game.modules.get(MODULE_ID).api;
    const plan = await api.compile(item);
    if (!api.saves.supports(plan)) throw new Error(`${name}: its save isn't one the module resolves.`);
    if (!targets.length) return null;
    return api.saves.start(item, { plan, sourceActor: caster, targets, castRank: Number(rank), dc, skipConfirmation: true, ...(forcedOrigin ? { forcedOrigin } : {}),
        ...(riders.length ? { shapeRiders: [{ name, requires: null, choice: null, riders }] } : {}) });
}

/** The caster's spell DC for a feat's save (or the higher of its class DC and spell DC, when the text says so). */
export function shapeDC(caster, spell, { classToo = false } = {}) {
    const spellDC = Number(spell?.spellcasting?.statistic?.dc?.value ?? caster?.spellcasting?.regular?.[0]?.statistic?.dc?.value ?? NaN);
    const classDC = Number(caster?.classDC?.value ?? caster?.system?.attributes?.classDC?.value ?? NaN);
    const values = [spellDC, ...(classToo ? [classDC] : [])].filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
}

/** The creatures within a distance of a token (the token itself counted or not), as their tokens. */
export function tokensWithin(center, feet, { includeCenter = false, exclude = [] } = {}) {
    if (!center) return [];
    const doc = center.document ?? center;
    return (doc.parent?.tokens ?? []).filter(token => token.actor && !token.hidden && (includeCenter || token.id !== doc.id) && !exclude.includes(token.actor.uuid) && tokenDistance(doc, token) <= feet);
}

// ---- Family C cards at the cast, and the cards with a button (a token the GM targets) ----

const amountAt = (formula, rank, level) => formula === "2rank" ? 2 * rank : formula === "rank" ? rank : formula === "2level" ? 2 * level : formula === "level" ? level : Number(formula);
const enemyOf = (actor, other) => Boolean(actor.alliance && other.alliance && actor.alliance !== other.alliance);

/** The tokens a card at the cast reaches: within the distance of the caster (or its familiar), all or the enemies. */
function cardTargets(caster, rider) {
    const center = rider.center === "familiar" ? familiarOf(caster)?.getActiveTokens?.(true, true)?.[0] : caster.getActiveTokens?.(true, true)?.[0];
    if (!center) return [];
    return tokensWithin(center, rider.within, { includeCenter: false }).filter(token => token.actor !== caster && (rider.who !== "enemies" || enemyOf(caster, token.actor)))
        .map(token => token.object ?? token);
}

/** A card rider's damage at the cast: its formula, or dice per rank of the chosen (or the spell's) type. */
async function cardDamage(shape, rider, rank, caster, facts) {
    const damage = rider.damage;
    if (!damage) return null;
    if (damage.formula) return { formula: String(amountAt(damage.formula, rank, Number(caster.level ?? 1))), type: damage.type };
    let type = damage.type ?? null;
    if (damage.typeChoice) {
        const fromSpell = damage.preferSpellTrait ? damage.typeChoice.filter(choice => facts.traits.includes(choice)) : [];
        type = fromSpell.length === 1 ? fromSpell[0] : await riderChoice(shape, "Which damage type?", (fromSpell.length ? fromSpell : damage.typeChoice).map(value => ({ value, label: value })));
    }
    return { formula: `${damage.dice * rank}d${damage.faces}`, type: type ?? "untyped" };
}

/** At the cast: Heraldic Proclamation's healing and its enemies' card; Explosive Metamorphosis, Kaleidoscopic Entreaty, Vexing Tempest. Buttons for the rest. */
async function castCards(actor, message, shape, rider, facts, spell, rank) {
    const results = [];
    if (rider.type === "ally-heal") {
        const casterToken = actor.getActiveTokens?.(true, true)?.[0];
        const amount = amountAt(rider.amount, rank, Number(actor.level ?? 1));
        for (const token of casterToken ? tokensWithin(casterToken, rider.within).filter(token => token.actor !== actor && token.actor.alliance && token.actor.alliance === actor.alliance) : []) {
            await token.actor.applyDamage({ damage: -amount, token, skipIWR: true, rollOptions: new Set(["item:trait:healing"]) });
            results.push({ label: `${shape.name}: ${token.name} regains ${amount} Hit Points`, status: "applied" });
        }
    } else if (rider.type === "card" && rider.center !== "target") {
        const targets = cardTargets(actor, rider);
        const damage = await cardDamage(shape, rider, rank, actor, facts);
        const dc = shapeDC(actor, spell, { classToo: rider.classToo });
        if (!targets.length) results.push({ label: `${shape.name}: no creature in reach`, status: "skipped" });
        else {
            // (A push from the familiar's emanation is away from the familiar.)
            const familiarToken = rider.center === "familiar" ? familiarOf(actor)?.getActiveTokens?.(true, true)?.[0] ?? null : null;
            await startShapeCard({ caster: actor, name: shape.name, rank, statistic: rider.statistic, damage, outcomes: rider.outcomes ?? null, targets, dc,
                area: rider.within ? { type: "emanation", value: rider.within } : null, forcedOrigin: familiarToken?.uuid ?? null });
            results.push({ label: `${shape.name}: its save card for ${targets.length} creature${targets.length === 1 ? "" : "s"}`, status: "applied" });
        }
    } else if (["arrival", "delayed-burst", "surge", "control-card", "landing"].includes(rider.type)) {
        // (A token the GM names: the summoned creature, the circle's place, the spell's target.)
        let extra = {};
        if (rider.type === "surge") {
            const flat = await new Roll("1d20").evaluate();
            const degree = flat.total >= rider.flatDC + 10 ? "criticalSuccess" : flat.total >= rider.flatDC ? "success" : flat.total <= rider.flatDC - 10 ? "criticalFailure" : "failure";
            await flat.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(shape.name)}</strong>: DC ${rider.flatDC} flat check` }).catch(() => null);
            const result = rider.results[degree === "criticalFailure" ? "failure" : degree];
            extra = { surge: { degree, result } };
            // (A failure is centred on the caster: resolved now.)
            if (result?.center === "caster") { results.push(...await surgeCard(actor, spell, rank, shape.name, result, actor.getActiveTokens?.(true, true)?.[0])); return results; }
        }
        const label = { arrival: "Explode around the targeted token (the creature summoned)", "delayed-burst": "Place the circle at the targeted token", surge: "Resolve around the targeted token (the spell's target or area)", "control-card": "Resolve on the targeted undead", landing: "Landed (target the caster's token where it lands)" }[rider.type];
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), flags: { [MODULE_ID]: { kind: "spellshape-card", shapeCard: { casterUuid: actor.uuid, castId: message.id, spellUuid: spell?.uuid ?? null, name: shape.name, rank, rider, ...extra } } },
            content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(shape.name)}</strong></p><button type="button" data-pf2e-auto-shape-card="go">${escapeHTML(label)}</button></section>` }); } catch (_) {}
        results.push({ label: `${shape.name}: its card`, status: "applied" });
    }
    return results;
}

/** Thundering Surge's result: its burst's creatures, basic Fortitude against the higher DC, Prone by the stated save result. */
async function surgeCard(caster, spell, rank, name, result, centerToken) {
    if (!result || !centerToken) return [{ label: `${name}: no centre`, status: "skipped" }];
    const doc = centerToken.document ?? centerToken;
    const targets = tokensWithin(doc, result.feet, { includeCenter: result.center === "target" }).filter(token => token.actor !== caster && (result.who !== "enemies" || enemyOf(caster, token.actor))).map(token => token.object ?? token);
    if (!targets.length) return [{ label: `${name}: no creature in the burst`, status: "skipped" }];
    const prone = { uuid: "Compendium.pf2e.conditionitems.Item.j91X7x0XSomq8d60", slug: "prone", value: null };
    const degrees = result.prone === "failure" ? { failure: [prone], criticalFailure: [prone] } : result.prone === "criticalFailure" ? { criticalFailure: [prone] } : {};
    await startShapeCard({ caster, name, rank, statistic: result.statistic, damage: { formula: String(amountAt(result.formula, rank, Number(caster.level ?? 1))), type: result.damageType },
        targets, dc: shapeDC(caster, spell, { classToo: true }), area: { type: "burst", value: result.feet }, riders: [{ type: "conditions", degrees }] });
    return [{ label: `${name}: its save card for ${targets.length} creature${targets.length === 1 ? "" : "s"}`, status: "applied" }];
}

/** The card's button: the targeted token is the summoned creature (the arrival's burst), the circle's place, the surge's centre or the undead to command. */
export async function runShapeCard(message, { at = null, choice = null } = {}) {
    const data = message.getFlag(MODULE_ID, "shapeCard");
    const caster = await fromUuid(data?.casterUuid ?? "").catch(() => null);
    const token = at ?? [...game.user.targets][0]?.document ?? null;
    if (!data || !caster || !token) throw new Error("Target the token first.");
    const spell = (data.spellUuid ? await fromUuid(data.spellUuid).catch(() => null) : null) ?? (data.spellSource ? new CONFIG.Item.documentClass(data.spellSource, { parent: caster }) : null);
    const rider = data.rider, rank = Number(data.rank);
    const shape = { name: data.name, choice };
    const DamageRoll = CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
    if (rider.type === "arrival") {
        // ("all creatures in a 10-foot emanation around the creature you summoned take 1d4 fire damage per spell rank"; its type from the creature's traits.)
        const traits = [...(token.actor?.traits ?? token.actor?.system?.traits?.value ?? [])];
        const types = [...new Set(Object.entries(rider.typeFromTraits ?? {}).filter(([trait]) => traits.includes(trait)).map(([, type]) => type))];
        const type = types.length > 1 ? await riderChoice(shape, "Which damage type?", types.map(value => ({ value, label: value }))) : types[0] ?? rider.damageType;
        const others = tokensWithin(token, rider.feet).filter(other => !(rider.exceptCaster && other.actor === caster));
        const roll = await new DamageRoll(`${rider.dice * rank}d${rider.faces}[${type}]`).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(data.name)}</strong>: ${others.length} creature${others.length === 1 ? "" : "s"}` }).catch(() => null);
        for (const other of others) await applyDamageWithReceipt(other.actor, { damage: DamageRoll.fromData(roll.toJSON()), token: other, skipIWR: false, rollOptions: new Set(["area-damage"]) }, foundry.utils.randomID());
        return { type, hit: others.map(other => other.name), total: roll.total };
    }
    if (rider.type === "delayed-burst") {
        // ("a glowing magic circle appears in a 5-foot burst within that area. At the beginning of your next turn, the circle detonates …")
        const spellTypes = spell ? spellFacts(spell).damageTypes : [];
        const type = rider.damage.fromSpell && spellTypes.length ? (spellTypes.length > 1 ? await riderChoice(shape, "Which damage type?", spellTypes.map(value => ({ value, label: value }))) : spellTypes[0]) : rider.damage.type;
        const center = token.object?.center ?? { x: token.x + token.width * canvas.grid.size / 2, y: token.y + token.height * canvas.grid.size / 2 };
        const combat = game.combat?.started ? game.combat : null;
        const [region] = await token.parent.createEmbeddedDocuments("Region", [{ name: `${data.name}: the circle`, color: "#a050ff", shapes: [{ type: "circle", x: center.x, y: center.y, radius: rider.feet / 5 * canvas.grid.size }],
            flags: { [MODULE_ID]: { spellshapeDetonation: { casterUuid: caster.uuid, name: data.name, rank, statistic: rider.statistic, formula: `${rider.damage.dice * rank}d${rider.damage.faces}`, type,
                spellUuid: data.spellUuid, combatId: combat?.id ?? null, startedAt: combat ? { round: combat.round, turn: combat.turn } : null } } } }]);
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), flags: { [MODULE_ID]: { kind: "spellshape-card", detonation: region.uuid } },
            content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(data.name)}</strong>: the circle detonates as ${escapeHTML(caster.name)}'s next turn begins (${rider.damage.dice * rank}d${rider.damage.faces} ${escapeHTML(type)}, basic ${escapeHTML(rider.statistic)}).</p><button type="button" data-pf2e-auto-shape-card="detonate" data-region="${region.uuid}">Detonate now</button></section>` }); } catch (_) {}
        return { region: region.uuid, type };
    }
    if (rider.type === "surge") return surgeCard(caster, spell, rank, data.name, data.surge.result, token);
    if (rider.type === "refract") {
        if (!spell) throw new Error(`${data.name}: the spell is gone.`);
        const from = await fromUuid(data.from ?? "").catch(() => null);
        const fromToken = from?.getActiveTokens?.(true, true)?.[0];
        if ((data.chain ?? []).includes(token.actor.uuid)) throw new Error(`${token.name} was already targeted.`);
        if (fromToken && tokenDistance(fromToken, token) > rider.feet) throw new Error(`${token.name} is more than ${rider.feet} feet from ${from.name}.`);
        const api = game.modules.get(MODULE_ID).api;
        // (The same spell again at the new creature: its own attack roll and color.)
        // (A preset "choice" of the ray's colors — the GM's or a test's — passes through; otherwise the spell rolls them.)
        const result = await api.execute(spell, { sourceActor: caster, plan: await api.compile(spell), castRank: rank, targets: [token.object ?? token], skipConfirmation: true, ...(Array.isArray(choice) ? { colors: choice } : {}) });
        const degree = typeof result?.degree === "number" ? result.degree : ({ criticalFailure: 0, failure: 1, success: 2, criticalSuccess: 3 }[result?.degree] ?? null);
        await message.update({ content: message.content.replace(/<button[^>]*>.*?<\/button>/, `<p><em>Refracted to ${escapeHTML(token.name)}.</em></p>`) }).catch(() => null);
        if (degree != null && degree >= 2) await postRefractCard(caster, { ...data, chain: [...(data.chain ?? []), token.actor.uuid], from: token.actor.uuid });
        else try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(data.name)}</strong>: the ray missed ${escapeHTML(token.name)}; the refraction ceases.</p>` }); } catch (_) {}
        return { degree, chain: [...(data.chain ?? []), token.actor.uuid] };
    }
    if (rider.type === "turn-start-barrage") return barrageVolley(caster, data, [...game.user.targets].map(target => target.document ?? target));
    if (rider.type === "granted-burst") {
        // (Wand of Chromatic Burst: one of the armor's colors; the spell ends; a 20-foot emanation of 4d6 of that color's type, basic Reflex against the spell DC.)
        const armored = await fromUuid(data.armoredUuid ?? "").catch(() => null) ?? token.actor;
        const centreToken = armored?.getActiveTokens?.(true, true)?.[0] ?? token;
        const colors = [["red", "fire"], ["orange", "acid"], ["yellow", "electricity"], ["green", "poison"], ["blue", "sonic"], ["indigo", "mental"], ["violet", "force"]];
        const type = await riderChoice(shape, "Which color?", colors.map(([color, damage]) => ({ value: damage, label: `${color} (${damage})` }))) ?? "fire";
        for (const armor of (armored?.itemTypes?.effect ?? []).filter(effect => /Chromatic Armor/.test(effect.name))) await armor.delete().catch(() => null);
        const targets = tokensWithin(centreToken, rider.feet).map(other => other.object ?? other);
        if (targets.length) await startShapeCard({ caster, name: data.name, rank, statistic: rider.statistic, damage: { formula: rider.formula, type }, targets, dc: shapeDC(caster, spell), area: { type: "emanation", value: rider.feet } });
        return { type, targets: targets.length };
    }
    if (rider.type === "spotlight") {
        // (Wand of Legerdemain: each enemy within 30 feet, a Will save against the spell DC; on a failure, Fascinated with the caster until the end of its next turn.)
        const casterToken = caster.getActiveTokens?.(true, true)?.[0] ?? token;
        const targets = tokensWithin(casterToken, rider.feet).filter(other => enemyOf(caster, other.actor)).map(other => other.object ?? other);
        const fascinated = { ...rider.condition, until: "caster-next-turn-end" };
        if (targets.length) await startShapeCard({ caster, name: data.name, rank, statistic: rider.statistic, targets, dc: shapeDC(caster, spell),
            outcomes: { criticalSuccess: "The creature is unaffected.", success: "The creature is unaffected.", failure: "The creature is unaffected.", criticalFailure: "The creature is unaffected." },
            riders: [{ type: "conditions", degrees: { failure: [fascinated], criticalFailure: [fascinated] } }] });
        return { targets: targets.length };
    }
    if (rider.type === "teeming") {
        // (Wand of Teeming Ghosts: false vitality ends, and the creature's frightened rises to 2.)
        const vitality = (caster.itemTypes?.effect ?? []).find(effect => /False Vitality/i.test(effect.name));
        if (!vitality || !(Number(caster.system?.attributes?.hp?.temp ?? 0) > 0)) throw new Error(`${caster.name} has no temporary Hit Points from false vitality.`);
        await vitality.delete();
        await caster.update({ "system.attributes.hp.temp": 0 });
        const now = Number(token.actor.getCondition?.("frightened")?.value ?? 0);
        if (now < rider.value) await token.actor.increaseCondition("frightened", { value: rider.value - now });
        return { frightened: token.actor.getCondition?.("frightened")?.value ?? 0 };
    }
    if (rider.type === "image-shards") {
        // (Wand of Shattering Images: the image's destroyer, if adjacent to the caster, takes 5 slashing.)
        const casterToken = caster.getActiveTokens?.(true, true)?.[0];
        if (!casterToken || tokenDistance(casterToken, token) > 5) return { adjacent: false };
        const DamageRoll = CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
        const roll = await new DamageRoll(`${rider.formula}[${rider.damageType}]`).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(data.name)}</strong>: shards at ${escapeHTML(token.name)}` }).catch(() => null);
        await applyDamageWithReceipt(token.actor, { damage: roll, token, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
        return { adjacent: true, total: roll.total };
    }
    if (rider.type === "terrain" && rider.where === "placed-square") {
        // (Wand of Rolling Flames: the sphere's square and those adjacent, until the caster's next turn; pressed again on a Sustain.)
        const size = canvas.grid.size;
        for (const old of token.parent.regions.filter(region => region.flags?.[MODULE_ID]?.spellshapeTerrain?.casterUuid === caster.uuid && region.flags[MODULE_ID].spellshapeTerrain.name === `${data.name}: rolling flames`)) await old.delete();
        const region = await shapeTerrain(token.parent, [{ type: "rectangle", x: token.x - size, y: token.y - size, width: (Number(token.width) + 2) * size, height: (Number(token.height) + 2) * size }],
            { name: `${data.name}: rolling flames`, castId: data.castId, caster, rider: { ...rider, rounds: null }, until: "caster-turn-start" });
        await postTerrainCard(caster, region, `rolling flames: difficult and hazardous terrain (${rider.hazard.formula} ${rider.hazard.damageType} per square moved into; a creature that doesn't move takes it for its squares as its turn ends) until ${caster.name}'s next turn.`);
        return { region: region.uuid };
    }
    if (rider.type === "landing") {
        // (Wand of Crushing Leaps: "making each creature in a 5-foot emanation Off-Guard until the start of its next turn" — each its own next turn — and the
        // space and the emanation difficult terrain for 1 minute.)
        const hit = tokensWithin(token, rider.feet).filter(other => other.actor !== caster);
        for (const other of hit) {
            const combat = game.combat?.started ? game.combat : null;
            await other.actor.createEmbeddedDocuments("Item", [{ name: `${data.name}: ${rider.condition.slug}`, type: "effect", img: "icons/svg/aura.svg", flags: { [MODULE_ID]: { spellshapeRider: { label: data.name } } },
                system: { duration: { value: 1, unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                    rules: [{ key: "GrantItem", uuid: rider.condition.uuid, onDeleteActions: { grantee: "restrict" } }] } }]);
        }
        const size = canvas.grid.size, cells = rider.feet / 5;
        const region = rider.terrainRounds ? await shapeTerrain(token.parent, [{ type: "rectangle", x: token.x - cells * size, y: token.y - cells * size, width: (Number(token.width) + 2 * cells) * size, height: (Number(token.height) + 2 * cells) * size }],
            { name: `${data.name}: broken ground`, castId: data.castId, caster, rider: { difficult: true, hazard: null, rounds: rider.terrainRounds } }) : null;
        return { hit: hit.map(other => other.name), terrain: region?.uuid ?? null };
    }
    if (rider.type === "control-card") {
        // ("the target becomes controlled by you if its level is equal to or lower than your level - 3. It can attempt a Will saving throw …")
        const target = token.actor;
        if (Number(target.level ?? 0) > Number(caster.level ?? 0) - rider.levelGap) {
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(data.name)}</strong>: ${escapeHTML(target.name)} is above level ${Number(caster.level ?? 0) - rider.levelGap}: unaffected.</p>` }); } catch (_) {}
            return { degree: null, tooHigh: true };
        }
        if ((target.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.spellshapeImmunity?.name === data.name)) return { degree: null, immune: true };
        const dc = shapeDC(caster, spell);
        const roll = await target.saves?.[rider.statistic]?.roll({ dc: { value: dc }, skipDialog: true });
        const degree = ["criticalFailure", "failure", "success", "criticalSuccess"][Number(roll?.degreeOfSuccess ?? 2)];
        if (degree === "criticalSuccess") await target.createEmbeddedDocuments("Item", [{ name: `${data.name}: immune`, type: "effect", img: "icons/svg/aura.svg", flags: { [MODULE_ID]: { spellshapeImmunity: { name: data.name } } },
            system: { duration: { value: 24, unit: "hours", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false } } }]);
        if (degree === "failure" || degree === "criticalFailure") {
            const [note] = await target.createEmbeddedDocuments("Item", [{ name: `${data.name}: ${caster.name}'s minion`, type: "effect", img: "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { spellshapeRider: { label: data.name } } },
                system: { duration: { value: degree === "criticalFailure" ? 1 : 1, unit: degree === "criticalFailure" ? "hours" : "minutes", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
                    description: { value: `<p>A minion under ${escapeHTML(caster.name)}'s control. ${rider.dismissedOnAttack ? "It's dismissed if the caster or an ally attacks it." : ""}</p>` } } }]);
            await grantMinionControl(note, target, caster.uuid);
        }
        return { degree };
    }
    return null;
}

/** Secondary Detonation Array: the circle detonating — as the caster's next turn begins, or now — its creatures' basic save card. */
export async function detonateShapeCircle(region) {
    const data = region?.flags?.[MODULE_ID]?.spellshapeDetonation;
    const caster = await fromUuid(data?.casterUuid ?? "").catch(() => null);
    if (!data || !caster) return null;
    const spell = data.spellUuid ? await fromUuid(data.spellUuid).catch(() => null) : null;
    // (The creatures in the circle: their centres within its radius — a new Region's membership isn't known at once.)
    const shape = region.shapes?.[0];
    const size = canvas.grid.size;
    const centreOf = token => ({ x: token.x + Number(token.width ?? 1) * size / 2, y: token.y + Number(token.height ?? 1) * size / 2 });
    const targets = (region.parent?.tokens ?? []).filter(token => token.actor && !token.hidden && shape
        && Math.hypot(centreOf(token).x - shape.x, centreOf(token).y - shape.y) <= Number(shape.radius) + size / 2).map(token => token.object ?? token);
    await region.delete();
    if (!targets.length) return { targets: 0 };
    await startShapeCard({ caster, name: data.name, rank: data.rank, statistic: data.statistic, damage: { formula: data.formula, type: data.type }, targets, dc: shapeDC(caster, spell), area: { type: "burst", value: 5 } });
    return { targets: targets.length };
}

/** As a turn begins: the caster's circles detonate. */
export async function detonateOnTurn(combat) {
    if (!activeGM() || !combat?.started) return [];
    const actor = combat.combatant?.actor;
    const done = [];
    for (const region of canvas.scene?.regions ?? []) {
        const data = region.flags?.[MODULE_ID]?.spellshapeDetonation;
        if (!data || data.casterUuid !== actor?.uuid) continue;
        if (data.combatId === combat.id && data.startedAt && combat.round === data.startedAt.round && combat.turn === data.startedAt.turn) continue;
        done.push(await detonateShapeCircle(region));
    }
    return done;
}

/** The cards' buttons. */
export function bindShapeCardButtons(message, html) {
    for (const button of html.querySelectorAll?.("[data-pf2e-auto-shape-card]") ?? []) button.addEventListener("click", async () => {
        try {
            if (button.dataset.pf2eAutoShapeCard === "detonate") return await detonateShapeCircle(await fromUuid(button.dataset.region));
            if (button.dataset.pf2eAutoShapeCard === "gather-power") return await gatherPower(message);
            if (button.dataset.pf2eAutoShapeCard === "release-power") return await releasePower(message);
            await runShapeCard(message);
        } catch (error) { ui.notifications.error(error.message); }
    });
}

/** Wand of Overflowing Life: as the caster's next turn starts, the 1-action Heal at the stated rank on itself (its healing from PF2e's Heal at that rank). */
export async function turnStartShapeHeal(combat) {
    if (!activeGM() || !combat?.started) return [];
    const actor = combat.combatant?.actor;
    const done = [];
    for (const effect of (actor?.itemTypes?.effect ?? []).filter(item => item.flags?.[MODULE_ID]?.spellshapeTurnHeal)) {
        const data = effect.flags[MODULE_ID].spellshapeTurnHeal;
        if (data.combatId === combat.id && data.startedAt && combat.round === data.startedAt.round && combat.turn === data.startedAt.turn) continue;
        const heal = (await game.packs.get("pf2e.spells-srd")?.getDocuments({ name: data.spell }).catch(() => []))?.[0] ?? null;
        const base = /^(\d+)d(\d+)$/.exec(String(Object.values(heal?.system?.damage ?? {})[0]?.formula ?? "1d8"));
        const step = /^(\d+)d\d+$/.exec(String(Object.values(heal?.system?.heightening?.damage ?? {})[0] ?? "1d8"));
        const interval = Number(heal?.system?.heightening?.interval ?? 1);
        const dice = Number(base?.[1] ?? 1) + Math.floor((data.rank - Number(heal?.system?.level?.value ?? 1)) / interval) * Number(step?.[1] ?? 1);
        const roll = await new Roll(`${dice}d${base?.[2] ?? 8}`).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(data.label)}</strong>: ${escapeHTML(data.spell)} on ${escapeHTML(actor.name)}` }).catch(() => null);
        await actor.applyDamage({ damage: -roll.total, token: actor.getActiveTokens?.(true, true)?.[0], skipIWR: true, rollOptions: new Set(["item:trait:healing"]) });
        await effect.delete().catch(() => null);
        done.push({ healed: roll.total });
    }
    return done;
}

// ---- Wands that watch (the user, 2026-10-05: "automate as much as you can"): Effects whose flag the module follows ----

/** The creatures a cast targeted: PF2e's target on the message, else its author's targets, else the caster. */
export function castTargetActors(message, actor) {
    const uuid = message.flags?.pf2e?.context?.target?.actor;
    const one = uuid ? fromUuidSync(uuid) : null;
    if (one) return [one];
    const user = message.author ?? game.user;
    const targets = [...(user?.targets ?? [])].map(token => token.actor).filter(Boolean);
    return targets.length ? targets : [actor];
}

const pendingScales = new Map();
const WATCH_LABEL = { thorns: "thorns", "haze-orbs": "orbs of electricity", "failed-check-damage": "venomous web", "first-success-worse": "traitorous thoughts",
    "turn-start-barrage": "shards each turn", "echo-recast": "echoes", "damage-exposes": "poisoned blades" };

/** At the cast: the watching Effect (on the targets for thorns and the probe, else on the caster), or Continuation's longer duration. */
async function wandWatch(actor, message, shape, rider, facts, spell, rank) {
    if (rider.type === "duration-scale") {
        pendingScales.set(message.id, { casterUuid: actor.uuid, spellUuid: spell?.uuid ?? null, spellName: spell?.name ?? null, factor: rider.factor, until: Date.now() + 10 * 60 * 1000 });
        const scaled = await scaleCastEffects(message.id);
        const rounds = shapeSpellFacts(spell)?.durationRounds ?? null;
        return [{ label: `${shape.name}: the duration increased by half${rounds ? ` (${rounds} → ${Math.round(rounds * rider.factor)} rounds)` : ""}${scaled.length ? `; ${scaled.join(", ")}` : ""}`, status: "applied" }];
    }
    const combat = game.combat?.started ? game.combat : null;
    const watch = { ...foundry.utils.deepClone(rider), ...(rider.type === "damage-exposes" ? { poisonName: rider.name } : {}), casterUuid: actor.uuid, castId: message.id, spellUuid: spell?.uuid ?? null, spellName: spell?.name ?? null, rank, name: shape.name,
        startedAt: combat ? { combatId: combat.id, round: combat.round, turn: combat.turn } : { worldTime: game.time.worldTime }, hits: {} };
    if (rider.type === "echo-recast") { watch.spellSource = spell?.toObject?.() ?? null; watch.dc = shapeDC(actor, spell); watch.echoes = 0; }
    const holders = ["thorns", "first-success-worse"].includes(rider.type) ? castTargetActors(message, actor) : [actor];
    const rounds = rider.type === "turn-start-barrage" ? rider.rounds ?? 10 : rider.type === "echo-recast" ? 100 : shapeSpellFacts(spell)?.durationRounds ?? 10;
    const results = [];
    for (const holder of holders) {
        const made = await shapeEffect(holder, actor, `${shape.name}: ${WATCH_LABEL[rider.type]}`, [], { rounds, flags: { spellshapeWatch: watch } });
        results.push({ label: `${shape.name}: ${WATCH_LABEL[rider.type]} on ${holder.name}`, status: "applied", effectUuid: made?.uuid ?? null });
    }
    return results;
}

/** A duration times the factor: in a smaller unit when it isn't whole (1 minute × 1.5 = 15 rounds). */
export function scaledDuration(value, unit, factor) {
    let amount = Number(value) * factor, at = unit;
    const down = { days: ["hours", 24], hours: ["minutes", 60], minutes: ["rounds", 10] };
    while (!Number.isInteger(amount) && down[at]) { amount *= down[at][1]; at = down[at][0]; }
    return { value: Math.round(amount), unit: at };
}

async function scaleEffect(effect, factor) {
    const duration = effect.system?.duration;
    if (!duration || !(Number(duration.value) > 0) || !["rounds", "minutes", "hours", "days"].includes(duration.unit) || effect.flags?.[MODULE_ID]?.durationScaled) return null;
    const next = scaledDuration(duration.value, duration.unit, factor);
    await effect.update({ "system.duration.value": next.value, "system.duration.unit": next.unit, [`flags.${MODULE_ID}.durationScaled`]: true });
    return `${effect.name}: ${next.value} ${next.unit}`;
}

const scaleMatches = (effect, castId, pending) => castIdOf(effect) === castId || (pending.spellUuid && effect.system?.context?.origin?.item === pending.spellUuid)
    || (pending.spellName && effect.system?.context?.origin?.actor === pending.casterUuid && effect.name.includes(pending.spellName));

/** The cast's Effects already made, lengthened. */
async function scaleCastEffects(castId) {
    const pending = pendingScales.get(castId);
    if (!pending) return [];
    const done = [];
    const actors = new Set([...game.actors, ...(canvas.scene?.tokens ?? []).map(token => token.actor).filter(Boolean)]);
    for (const actor of actors) for (const effect of actor.itemTypes?.effect ?? []) if (scaleMatches(effect, castId, pending)) { const label = await scaleEffect(effect, pending.factor); if (label) done.push(label); }
    return done;
}

/** An Effect made for a cast with Continuation (within 10 minutes of it): lengthened. */
export async function shapeScaleOnCreate(item) {
    if (!activeGM() || item?.type !== "effect" || !pendingScales.size) return null;
    for (const [castId, pending] of pendingScales) {
        if (Date.now() > pending.until) { pendingScales.delete(castId); continue; }
        if (scaleMatches(item, castId, pending)) return scaleEffect(item, pending.factor);
    }
    return null;
}

/** The watching Effects on the scene's creatures. */
function watches(type) {
    const seen = new Set(), found = [];
    for (const token of canvas.scene?.tokens ?? []) for (const effect of token.actor?.itemTypes?.effect ?? []) {
        const watch = effect.flags?.[MODULE_ID]?.spellshapeWatch;
        if (watch?.type !== type || seen.has(effect.uuid)) continue;
        seen.add(effect.uuid);
        found.push({ effect, watch, holder: token.actor, token });
    }
    return found;
}

async function watchDamage(watch, actor, token, note) {
    const DamageRoll = CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
    const roll = await new DamageRoll(`${watch.formula}[${watch.damageType}]`).evaluate();
    const caster = await fromUuid(watch.casterUuid).catch(() => null);
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster ?? actor }), flavor: `<strong>${escapeHTML(watch.name)}</strong>: ${escapeHTML(note)}` }).catch(() => null);
    const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
    return { actor: actor.name, damage: Number(receipt?.damage ?? 0) };
}

const domainsOf = context => [...(context.domains ?? []), ...(context.options ?? [])];

/** PF2e's checks the wands watch: an unarmed hit on the thorny creature, a failed flat check beside the hazy caster, a failed check in the web, the probe's Deception. */
export async function shapeWatchMessage(message) {
    if (!activeGM()) return [];
    const context = message.flags?.pf2e?.context;
    const roller = message.actor;
    if (!context?.type || !roller || (context.options ?? []).some(option => String(option).startsWith("pf2e-auto-application:"))) return [];
    const outcome = context.outcome ?? null;
    const failed = ["failure", "criticalFailure"].includes(outcome);
    const rollerToken = message.token ?? roller.getActiveTokens?.(true, true)?.[0]?.document ?? null;
    const done = [];
    if (context.type === "attack-roll" && ["success", "criticalSuccess"].includes(outcome) && domainsOf(context).some(entry => ["item:category:unarmed", "item:trait:unarmed"].includes(entry))) {
        // (Wand of Hawthorn: "any creature that hits the target with an unarmed Strike … takes 1d4 piercing damage from the thorns".)
        const targetUuid = context.target?.actor ?? null;
        for (const { watch, holder } of watches("thorns")) if (holder.uuid === targetUuid && holder !== roller) done.push(await watchDamage(watch, roller, rollerToken, `${roller.name} strikes ${holder.name}'s thorns`));
    }
    if (context.type === "flat-check" && failed && rollerToken) {
        // (Wand of Shocking Haze: "Each time a creature that's adjacent to you fails a flat check against the concealment from blur …")
        for (const { watch, holder, token } of watches("haze-orbs")) if (holder !== roller && tokenDistance(token, rollerToken) <= 5) done.push(await watchDamage(watch, roller, rollerToken, `${roller.name} bursts an orb`));
    }
    if (["skill-check", "saving-throw"].includes(context.type) && failed && rollerToken) {
        // (Wand of the Spider: "Any creature that fails its Athletics check or Reflex save to navigate the web takes 1d6 poison damage" — in the web's area.)
        const kind = domainsOf(context).find(entry => ["athletics", "reflex"].includes(entry));
        if (kind) for (const { watch } of watches("failed-check-damage")) {
            const web = rollerToken.parent?.regions?.find(region => region.flags?.pf2e?.messageId === watch.castId);
            if (web && tokenInRegion(rollerToken, web)) done.push(await watchDamage(watch, roller, rollerToken, `${roller.name} fails to navigate the web`));
        }
    }
    if (context.type === "skill-check" && ["success", "criticalSuccess"].includes(outcome) && domainsOf(context).includes("deception")) {
        // (Wand of Traitorous Thoughts: "The first time the target rolls a success at a Deception check to mislead your probe, it gets a result one step worse".)
        for (const { effect, watch, holder } of watches("first-success-worse")) {
            if (holder !== roller) continue;
            const worse = outcome === "criticalSuccess" ? "success" : "failure";
            await message.update({ "flags.pf2e.context.outcome": worse }).catch(() => null);
            await effect.delete().catch(() => null);
            try { await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(watch.name)}</strong> (GM): ${escapeHTML(roller.name)}'s Deception counts as a ${worse === "failure" ? "failure — the caster learns the answer" : "success — the caster learns nothing rather than a falsehood"}.</p>` }); } catch (_) {}
            done.push({ worse });
        }
    }
    return done;
}

/** A creature's damage from the spell a Wand of Toxic Blades made: exposed to its poison, once per turn (from the save card, basic-save-runtime.js). */
export async function shapeWatchSave(state, entries) {
    const found = watches("damage-exposes").filter(({ watch }) => watch.casterUuid === state.sourceActorUuid && (watch.spellUuid === state.sourceItemUuid || (watch.spellName && String(state.spellName ?? "").startsWith(watch.spellName))));
    if (!found.length) return [];
    const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
    const results = [];
    for (const { effect, watch } of found) {
        const stamp = game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : `t${game.time.worldTime}`;
        const hits = { ...(effect.flags[MODULE_ID].spellshapeWatch.hits ?? {}) };
        const exposed = [];
        for (const entry of entries.filter(entry => entry.damaged && entry.token)) {
            if (hits[entry.actor.uuid] === stamp) { results.push({ label: `${watch.name}: ${entry.actor.name} was exposed this turn`, status: "skipped" }); continue; }
            hits[entry.actor.uuid] = stamp;
            exposed.push(entry.token.object ?? entry.token);
        }
        await effect.setFlag(MODULE_ID, "spellshapeWatch.hits", hits);
        if (!exposed.length || !caster) continue;
        await exposeToPoison(caster, watch.uuid, exposed);
        results.push({ label: `${watch.name}: ${exposed.map(token => token.name).join(", ")} exposed to ${watch.poisonName ?? "the poison"}`, status: "applied" });
    }
    return results;
}

/** A poison item's exposure, as a save card: its own DC and stages (a failure stage 1, a critical failure stage 2). */
export async function exposeToPoison(caster, uuid, targets) {
    const poison = await fromUuid(uuid);
    const html = String(poison?.system?.description?.value ?? "");
    const check = /@Check\[([a-z]+)\|dc:(\d+)/.exec(html);
    if (!poison || !check) throw new Error("The poison or its save is unavailable.");
    const save = SAVE_NAME[check[1]];
    const max = /<strong>Maximum Duration<\/strong>\s*([^<]+)/.exec(html)?.[1]?.trim() ?? null;
    const stages = html.split(/<\/p>/).map(part => part.replace(/^\s*<p>/, "").trim()).filter(part => /^<strong>Stage \d+<\/strong>/.test(part));
    const lower = poison.name.toLowerCase();
    const level = Number(poison.system?.level?.value ?? 1);
    const kinds = (poison.system?.traits?.value ?? []).filter(trait => ["poison", "disease", "curse"].includes(trait));
    const text = `<p>The target is exposed to ${lower}. The target must attempt a ${save} save.</p><hr /><p><strong>Critical Success</strong> The target is unaffected.</p><p><strong>Success</strong> The target is unaffected.</p>`
        + `<p><strong>Failure</strong> The target is afflicted with ${lower} at stage 1.</p><p><strong>Critical Failure</strong> The target is afflicted with ${lower} at stage 2.</p><hr />`
        + `<p><strong>${escapeHTML(poison.name)}</strong> (${kinds.join(", ") || "poison"})</p><p><strong>Level</strong> ${level}</p>${max ? `<p><strong>Maximum Duration</strong> ${max}</p>` : ""}${stages.map(stage => `<p>${stage}</p>`).join("")}`;
    const rank = Math.max(1, Math.ceil(level / 2));
    const item = new CONFIG.Item.documentClass({ _id: foundry.utils.randomID(), name: poison.name, type: "spell", img: poison.img, system: { slug: null, level: { value: rank }, traits: { value: kinds.length ? kinds : ["poison"], rarity: "common", traditions: [] },
        description: { value: text }, time: { value: "1" }, duration: { value: "", sustained: false }, target: { value: "1 creature" }, range: { value: "" }, area: null,
        defense: { save: { statistic: check[1], basic: false } }, damage: {}, heightening: null, location: { value: null, heightenedLevel: rank } } }, { parent: caster });
    const api = game.modules.get(MODULE_ID).api;
    const plan = await api.compile(item);
    if (!api.saves.supports(plan)) throw new Error(`${poison.name}: its exposure isn't one the module resolves.`);
    return api.saves.start(item, { plan, sourceActor: caster, targets, castRank: rank, dc: Number(check[2]), skipConfirmation: true });
}

/** Wand of the Ash Puppet: the powdered creature's ashes as the caster's Sulfur Zombie (the minion and summoned traits; the caster's) for 1 minute, in the creature's space. */
async function ashPuppet(caster, entry, shape, rider, state) {
    const source = await fromUuid(rider.uuid);
    if (source?.documentName !== "Actor") throw new Error(`${rider.name} is unavailable.`);
    const dust = entry.token.document ?? entry.token;
    const casterToken = caster.getActiveTokens?.(true, true)?.[0]?.document ?? null;
    const actorData = game.actors.fromCompendium(source);
    actorData.system.traits.value = [...new Set([...(actorData.system.traits.value ?? []), "minion", "summoned"])];
    actorData.ownership = { ...foundry.utils.deepClone(caster.ownership ?? {}), default: 0 };
    foundry.utils.setProperty(actorData, "system.details.alliance", caster.alliance ?? caster.system?.details?.alliance ?? null);
    actorData.prototypeToken = { ...(actorData.prototypeToken ?? {}), actorLink: true, disposition: casterToken?.disposition ?? 1 };
    actorData.flags = foundry.utils.mergeObject(actorData.flags ?? {}, { [MODULE_ID]: { summoned: { castId: state.castId, casterUuid: caster.uuid, spell: shape.name, endsAtZero: true } } });
    const actor = await Actor.create(actorData);
    // (The creature is powder: its token hidden, the zombie where it stood.)
    await dust.update({ hidden: true }).catch(() => null);
    const tokenData = (await actor.getTokenDocument({ x: dust.x, y: dust.y, disposition: casterToken?.disposition ?? 1, actorLink: true })).toObject();
    const place = adjacentFreeSpace(tokenData, dust.x, dust.y, canvas.grid.size) ?? { x: dust.x, y: dust.y };
    const [token] = await dust.parent.createEmbeddedDocuments("Token", [{ ...tokenData, x: place.x, y: place.y }]);
    await shapeEffect(caster, caster, `${shape.name}: ${actor.name}`, [], { rounds: rider.rounds ?? 10, flags: { summon: { castId: state.castId, actorUuid: actor.uuid, tokenUuid: token.uuid } } });
    return actor;
}

/** The cast's template placed: its area kept for echoes, and the wands' area riders — Remaining Air, Fey Flames' Will save, Caustic Effluence's ground. */
export async function shapeAreaFromTemplate(region) {
    if (!activeGM()) return null;
    const message = game.messages.get(region?.flags?.pf2e?.messageId ?? "");
    const shaping = message?.getFlag(MODULE_ID, "shaping");
    if (!shaping || shaping.areaMade || !message.actor) return null;
    const entries = (shaping.shapes ?? []).flatMap(shape => (shape.riders ?? []).map(rider => ({ shape, rider })))
        .filter(item => ["area-effect", "area-save-effect", "prone-damage", "echo-recast"].includes(item.rider.type));
    if (!entries.length) return null;
    await message.update({ [`flags.${MODULE_ID}.shaping.areaMade`]: true });
    const shapes = region.shapes.map(shape => shape.toObject?.() ?? shape);
    await message.setFlag(MODULE_ID, "castArea", shapes);
    const caster = message.actor, spell = message.item;
    const rank = Number(message.flags?.pf2e?.casting?.castRank ?? spell?.rank ?? 1);
    const inside = region.parent.tokens.filter(token => token.actor && !token.hidden && tokenInRegion(token, region));
    const results = [];
    for (const { shape, rider } of entries) {
        if (rider.type === "area-effect" && rider.uuid) {
            const template = await loadNativeEffectTemplate(rider.uuid);
            for (const token of inside) {
                if (!template) break;
                await createNativeEffect(token.actor, prepareNativeEffectSource(template, { castInstanceId: message.id, castRank: rank, sourceActorUuid: caster.uuid, sourceItemUuid: spell?.uuid ?? null,
                    sourceItemName: spell?.name ?? shape.name, resolutionKind: "save", targetActorUuid: token.actor.uuid }));
                results.push(`${token.name}: ${template.name}`);
            }
        } else if (rider.type === "area-save-effect" && inside.length) {
            await startShapeCard({ caster, name: shape.name, rank, statistic: rider.statistic, targets: inside.map(token => token.object ?? token), dc: shapeDC(caster, spell),
                outcomes: { criticalSuccess: "The creature is unaffected.", success: "The creature is unaffected.", failure: "The creature is unaffected.", criticalFailure: "The creature is unaffected." },
                riders: rider.uuid ? [{ type: "effect", degrees: ["failure", "criticalFailure"], uuid: rider.uuid, name: rider.name }] : [] });
            results.push(`${shape.name}: a ${SAVE_NAME[rider.statistic]} save for ${inside.length} creature(s)`);
        } else if (rider.type === "prone-damage") {
            const rounds = shapeSpellFacts(spell)?.durationRounds ?? 10;
            await shapeTerrain(region.parent, shapes, { name: `${shape.name}: caustic ground`, castId: message.id, caster,
                rider: { difficult: false, rounds, hazard: { formula: rider.formula, damageType: rider.damageType, per: "turn-start-prone" } } });
            results.push(`${shape.name}: a creature beginning its turn prone in the area takes ${rider.formula} ${rider.damageType}`);
        }
    }
    if (results.length) try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<section class="pf2e-auto-runtime-card">${results.map(line => `<p>${escapeHTML(line)}</p>`).join("")}</section>` }); } catch (_) {}
    return results;
}

const turnStarts = new Map();
const freshFor = (watch, combat) => !(watch.startedAt?.combatId === combat.id && combat.round === watch.startedAt.round && combat.turn === watch.startedAt.turn);

/** Damage dice of a spell at a rank: its first damage's dice and its heightening's (Noise Blast: 2d10 at 2nd, +1d10 a rank). */
export function diceAtRank(spell, rank) {
    const base = /^(\d+)d(\d+)/.exec(String(Object.values(spell?.system?.damage ?? {})[0]?.formula ?? ""));
    if (!base) return null;
    const heightening = spell.system?.heightening;
    const step = heightening?.type === "interval" ? /^(\d+)d/.exec(String(Object.values(heightening.damage ?? {})[0] ?? "")) : null;
    const interval = Number(heightening?.interval ?? 1) || 1;
    const extra = step ? Math.floor((rank - Number(spell.system.level.value)) / interval) * Number(step[1]) : 0;
    return { dice: Number(base[1]) + extra, faces: Number(base[2]) };
}

/** As a turn begins: Thundering Echoes' echo, Shardstorm's shards, Caustic Effluence's prone damage; positions kept for Rolling Flames' stillness. */
export async function shapeTurnStart(combat) {
    if (!activeGM() || !combat?.started) return [];
    const token = combat.combatant?.token;
    const actor = token?.actor;
    if (!token || !actor) return [];
    turnStarts.set(token.id, { x: token.x, y: token.y, round: combat.round });
    const done = [];
    for (const effect of actor.itemTypes?.effect ?? []) {
        const watch = effect.flags?.[MODULE_ID]?.spellshapeWatch;
        if (!watch || !freshFor(watch, combat)) continue;
        if (watch.type === "turn-start-barrage") {
            const missiles = Number(watch.actions ?? 1) * (1 + Math.floor((Number(watch.rank) - 1) / 2));
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), flags: { [MODULE_ID]: { kind: "spellshape-card", shapeCard: { casterUuid: actor.uuid, name: watch.name, rank: watch.rank, rider: { type: "turn-start-barrage", missiles } } } },
                content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(watch.name)}</strong>: ${missiles} shard${missiles === 1 ? "" : "s"} (1d4+1 force each), as the 1-action force barrage. Target the creatures (one shard each in turn).</p><button type="button" data-pf2e-auto-shape-card="go">Release the shards at the targeted creatures</button></section>` }); } catch (_) {}
            done.push({ barrage: missiles });
        } else if (watch.type === "echo-recast") {
            done.push(await echoAgain(effect, watch, actor));
        }
    }
    // (A creature beginning its turn prone on the caustic ground.)
    if (actor.hasCondition?.("prone")) for (const region of token.parent?.regions ?? []) {
        if (region.flags?.[MODULE_ID]?.spellshapeTerrain?.hazard?.per !== "turn-start-prone" || !tokenInRegion(token, region)) continue;
        done.push(await shapeTerrainMove(region.uuid, token.uuid).catch(() => null));
    }
    return done;
}

/** Thundering Echoes: the spell again in its area, one fewer d10 each time, until below the stated dice. */
async function echoAgain(effect, watch, caster) {
    const castArea = game.messages.get(watch.castId)?.getFlag(MODULE_ID, "castArea");
    const spell = watch.spellSource ? new CONFIG.Item.documentClass(watch.spellSource, { parent: caster }) : null;
    const echoes = Number(watch.echoes ?? 0) + 1;
    const rank = Number(watch.rank) - echoes;
    const dice = spell ? diceAtRank(spell, rank) : null;
    if (!castArea || !spell || !dice || rank < Number(spell.system.level.value) || dice.dice < Number(watch.minDice ?? 2)) {
        await effect.delete().catch(() => null);
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(watch.name)}</strong>: the echoes fade.</p>` }); } catch (_) {}
        return { ended: true };
    }
    await effect.setFlag(MODULE_ID, "spellshapeWatch.echoes", echoes);
    const area = { shapes: castArea };
    const targets = (canvas.scene?.tokens ?? []).filter(token => token.actor && !token.hidden && tokenInRegion(token, area)).map(token => token.object ?? token);
    if (!targets.length) return { echo: echoes, dice: dice.dice, targets: 0 };
    const api = game.modules.get(MODULE_ID).api;
    await api.saves.start(spell, { plan: await api.compile(spell), sourceActor: caster, targets, castRank: rank, dc: watch.dc ?? undefined, skipConfirmation: true });
    return { echo: echoes, dice: dice.dice, targets: targets.length };
}

/** Shardstorm's button: the shards shared out among the targeted creatures, each creature's shards one damage roll (as force barrage). */
async function barrageVolley(caster, data, targets) {
    if (!targets.length) throw new Error("Target the creatures first.");
    const missiles = Number(data.rider.missiles ?? 1);
    const count = new Map();
    for (let index = 0; index < missiles; index++) { const target = targets[index % targets.length]; count.set(target, (count.get(target) ?? 0) + 1); }
    const DamageRoll = CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
    const results = [];
    for (const [target, shards] of count) {
        const roll = await new DamageRoll(`(${shards}d4+${shards})[force]`).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(data.name)}</strong>: ${shards} shard${shards === 1 ? "" : "s"} at ${escapeHTML(target.name)}` }).catch(() => null);
        const receipt = await applyDamageWithReceipt(target.actor, { damage: roll, token: target, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
        results.push({ target: target.name, shards, damage: Number(receipt?.damage ?? 0) });
    }
    return results;
}

/** Rolling Flames: a creature that didn't move on its turn takes the flames' damage for each of its squares in them, as its turn ends. */
export async function stillInFlames(combat) {
    if (!activeGM() || !combat?.started) return [];
    const previous = combat.previous?.combatantId ? combat.combatants.get(combat.previous.combatantId) : null;
    const token = previous?.token;
    const start = token ? turnStarts.get(token.id) : null;
    if (!token?.actor || !start || start.x !== token.x || start.y !== token.y) return [];
    const done = [];
    for (const region of token.parent?.regions ?? []) {
        const hazard = region.flags?.[MODULE_ID]?.spellshapeTerrain?.hazard;
        if (!hazard?.stationary || !tokenInRegion(token, region)) continue;
        const squares = Math.max(1, Math.round(Number(token.width ?? 1) * Number(token.height ?? 1)));
        done.push(await shapeTerrainMove(region.uuid, token.uuid, squares).catch(() => null));
    }
    return done;
}

/** Wand of Refracting Rays' card: refract to the targeted creature (within the distance of the last, not one already targeted); it ceases on a miss. */
async function postRefractCard(caster, data) {
    const from = data.from ? fromUuidSync(data.from) : null;
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), flags: { [MODULE_ID]: { kind: "spellshape-card", shapeCard: { casterUuid: caster.uuid, ...data } } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(data.name)}</strong>: after a hit${from ? ` on ${escapeHTML(from.name)}` : ""}, the ray refracts to another creature within ${data.rider.feet} feet (none twice; it ceases on a miss).</p><button type="button" data-pf2e-auto-shape-card="go">Refract to the targeted creature</button></section>` }); } catch (_) {}
}

/** Disintegrate's powder (immediate-runtime.js): a Wand of the Ash Puppet's cast animates it as the caster's sulfur zombie (living creatures only). */
export async function shapeDisintegrated(state, actor, token) {
    const message = state.sourceMessageId ? game.messages.get(state.sourceMessageId) : null;
    const shapes = message?.getFlag(MODULE_ID, "shaping")?.shapes ?? [];
    const found = shapes.flatMap(shape => (shape.riders ?? []).map(rider => ({ shape, rider }))).find(item => item.rider.type === "ash-puppet");
    if (!found || !token || traitsOf(actor).some(trait => ["undead", "construct"].includes(trait))) return null;
    const caster = await fromUuid(state.sourceActorUuid).catch(() => null);
    if (!caster) return null;
    const made = await ashPuppet(caster, { actor, token }, found.shape, found.rider, { castId: state.castId });
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(found.shape.name)}</strong>: ${escapeHTML(actor.name)}'s ashes rise as ${escapeHTML(made.name)}, ${escapeHTML(caster.name)}'s minion for ${(found.rider.rounds ?? 10) / 10 >= 1 ? `${(found.rider.rounds ?? 10) / 10} minute(s)` : `${found.rider.rounds} round(s)`} (it crumbles at 0 Hit Points). A verbal command is a single action (auditory, concentrate).</p>` }); } catch (_) {}
    return { name: made.name, actorUuid: made.uuid };
}

// ---- Magic+'s Energy ring rune ----
// "Activate—Gather Power 1 Requirements Your last action was to Cast a Spell that dealt energy damage and was shaped by Veracious Spell; You absorb some of the energy you are about
// to expel into your power ring. You hold a charge of Gathered Power in the ring of that energy type. These charges last for 1 minute or until expelled by using Release Power.
// Activate—Release Power 1 (attack) Requirements You have a charge of Gathered Power in the ring; You shoot a ray of power from stored up energy in the ring. Make a spell attack roll
// against the target's AC, dealing 5d4 damage on a success or twice that amount on a critical success. You apply the ring's item bonus to this spell attack roll. The damage is of the
// same damage type as the energy used to Gather Power and you expel the charge of energy from Gathered Power."
const ENERGY_TYPES = ["acid", "cold", "electricity", "fire", "force", "sonic", "vitality", "void"];
const ENERGY_RUNE = /Activate\s*[—–-]\s*Gather Power .*?Your last action was to Cast a Spell that dealt energy damage and was shaped by Veracious Spell.*?Activate\s*[—–-]\s*Release Power .*?dealing @Damage\[(\d+d\d+)\] damage on a success or twice that amount on a critical success\. You apply the ring.s item bonus to this spell attack roll\./;
const runeText = item => String(item?.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
export function readEnergyRune(source) {
    const m = ENERGY_RUNE.exec(runeText(source));
    return m ? { formula: m[1], minutes: 1 } : null;
}
const energyRuneOf = actor => (actor?.itemTypes?.equipment ?? []).find(item => item.system?.equipped?.carryType === "worn" && item.system?.equipped?.invested !== false && readEnergyRune(item)) ?? null;
// (The ring's item bonus: its Veracious Spell's "+N item bonus to your spell attack roll".)
const ringBonusOf = actor => Math.max(0, ...(actor?.itemTypes?.equipment ?? []).filter(item => item.system?.equipped?.carryType === "worn")
    .map(item => Number(/Veracious Spell .*?you gain a \+(\d+) item bonus to your spell attack roll/.exec(runeText(item))?.[1] ?? 0)));
const chargeOf = actor => (actor?.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.gatheredPower) ?? null;

async function offerGatherPower(actor, facts) {
    const rune = energyRuneOf(actor);
    const types = [...new Set((facts.damageTypes ?? []).filter(type => ENERGY_TYPES.includes(type)))];
    if (!rune || !types.length) return null;
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: game.users.filter(user => user.isGM || actor.testUserPermission?.(user, "OWNER")).map(user => user.id),
        flags: { [MODULE_ID]: { kind: "spellshape-card", gatherPower: { casterUuid: actor.uuid, runeUuid: rune.uuid, types } } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(rune.name)}</strong>: Gather Power (1 action) — hold a charge of ${escapeHTML(types.join(" or "))} in the ring for 1 minute.</p><button type="button" data-pf2e-auto-shape-card="gather-power">Gather Power</button></section>` });
}

export async function gatherPower(message) {
    const data = message.getFlag(MODULE_ID, "gatherPower");
    const actor = await fromUuid(data?.casterUuid ?? "").catch(() => null);
    if (!actor) throw new Error("The caster is gone.");
    if (data.used) throw new Error("Already gathered.");
    const type = data.types.length > 1 ? await riderChoice({ name: "Gather Power", choice: null }, "Which energy?", data.types.map(value => ({ value, label: value }))) ?? data.types[0] : data.types[0];
    const old = chargeOf(actor);
    if (old) await old.delete();
    const combat = game.combat?.started ? game.combat : null;
    const [charge] = await actor.createEmbeddedDocuments("Item", [{ name: `Gathered Power (${type})`, type: "effect", img: "icons/magic/lightning/orb-ball-blue.webp",
        flags: { [MODULE_ID]: { gatheredPower: { type, runeUuid: data.runeUuid } } },
        system: { duration: { value: 1, unit: "minutes", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
            description: { value: `<p>A charge of ${type} held in the power ring, until expelled by Release Power.</p>` } } }]);
    await message.setFlag(MODULE_ID, "gatherPower", { ...data, used: true });
    await postReleasePower(actor, charge);
    return charge;
}

async function postReleasePower(actor, charge) {
    const type = charge.flags[MODULE_ID].gatheredPower.type;
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: game.users.filter(user => user.isGM || actor.testUserPermission?.(user, "OWNER")).map(user => user.id),
        flags: { [MODULE_ID]: { kind: "spellshape-card", releasePower: { casterUuid: actor.uuid, chargeUuid: charge.uuid } } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>Gathered Power (${escapeHTML(type)})</strong>: Release Power (1 action, attack) — a spell attack ray at the targeted creature.</p><button type="button" data-pf2e-auto-shape-card="release-power">Release Power at the targeted creature</button></section>` });
}

/** The Energy rune's card posted while a charge is held: its Release Power button. */
export async function energyRuneOnCard(message) {
    if (!activeGM() || message?.flags?.pf2e?.origin?.type !== "equipment") return null;
    const item = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    const charge = item && readEnergyRune(item) ? chargeOf(item.actor) : null;
    return charge ? postReleasePower(item.actor, charge) : null;
}

export async function releasePower(message) {
    const data = message.getFlag(MODULE_ID, "releasePower");
    const actor = await fromUuid(data?.casterUuid ?? "").catch(() => null);
    const charge = actor ? chargeOf(actor) : null;
    if (!charge) throw new Error("No charge of Gathered Power in the ring.");
    const target = [...game.user.targets][0] ?? null;
    if (!target) throw new Error("Target the token first.");
    const rune = await fromUuid(charge.flags[MODULE_ID].gatheredPower.runeUuid).catch(() => null) ?? energyRuneOf(actor);
    const formula = readEnergyRune(rune)?.formula ?? "5d4", type = charge.flags[MODULE_ID].gatheredPower.type;
    const entry = actor.spellcasting?.regular?.[0] ?? null;
    if (!entry) throw new Error(`${actor.name} has no spellcasting entry for the spell attack.`);
    const rank = Math.max(1, Math.ceil(Number(actor.level ?? 1) / 2));
    const source = { _id: foundry.utils.randomID(), name: "Release Power", type: "spell", img: charge.img, system: { slug: null, level: { value: rank }, traits: { value: ["attack", type], rarity: "common", traditions: [] },
        // (In the wording the compiler reads as a spell attack's degrees.)
        description: { value: "<p>Make a spell attack roll against the target's AC.</p><hr /><p><strong>Critical Success</strong> The target takes double damage.</p><p><strong>Success</strong> The target takes full damage.</p>" },
        time: { value: "1" }, duration: { value: "", sustained: false }, target: { value: "1 creature" }, range: { value: "60 feet" }, area: null,
        defense: { passive: { statistic: "ac" }, save: null }, damage: { ray: { formula, type, category: null, materials: [], kinds: ["damage"] } }, heightening: null,
        location: { value: entry.id, heightenedLevel: rank } } };
    const spell = new CONFIG.Item.documentClass(source, { parent: actor });
    const api = game.modules.get(MODULE_ID).api;
    const plan = await api.compile(spell);
    const bonus = ringBonusOf(actor);
    await charge.delete();
    return api.saves.start(spell, { plan, sourceActor: actor, targets: [target], castRank: rank, skipConfirmation: true, ...(bonus ? { attackBonus: { value: bonus, label: "Power ring", type: "item" } } : {}) });
}
