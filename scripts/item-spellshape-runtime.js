// Items whose activation is a spellshape (src/compiler/item-spellshape.js), at the table (the spell features audit, batch F4, 2026-10-05):
//   - the item's card posted arms it for the next spell, as a spellshape feat's does (spellshape-runtime.js armSpellshape), after what the activation
//     does at once — Hundred-Moth Caress's damage to the wielder, Djezet Dose's choice of feat, Star Chart Tattoo's constellation on a creature;
//   - its riders, read with the spell as cast: the spellshape riders, and the items' own here — the attack against a save DC (Shadow Signet), Strike
//     dice and the touch retaliation (Sparking Grimoire), an area whose creatures save as their turns begin (Radiant Tome, Bloodstained Treatise),
//     cards for what the GM sees happen (a disbelief, a summoned creature, a wall crossed, a night's rest), an ally's temporary Hit Points (Juubun's
//     One Thousand Poems) and the Lie to hide the casting (Liar's Lexicon).
import { readItemSpellshape } from "../src/compiler/item-spellshape.js";
import { readSpellshapeFeat } from "../src/compiler/spellshape-readers.js";
import { riderChoice, timedConditions, shapeEffect, timedTempHp, castTargetActors, shapeDC, startShapeCard, pendingShapeEffect, shapeSpellFacts, tokensWithin } from "./spellshape-runtime.js";
import { applyDamageWithReceipt } from "./native-damage-receipt.js";
import { loadNativeEffectTemplate, prepareNativeEffectSource, createNativeEffect } from "./native-outcome-effects.js";
import { tokenDistance, tokenDocumentDistance } from "./token-distance.js";
import { DEGREES, MODULE_ID, activeGM, allied, core, escapeHTML, gmIds } from "./runtime-utils.js";

import { noticeImmunity } from "./immunity-notice.js";
const damageRollClass = () => CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
const capital = text => `${text[0].toUpperCase()}${text.slice(1)}`;

/** An activation's name on the GM's choice: its label and the spell it takes ("a healing spell"). */
function activationLabel(activation) {
    const requires = activation.requires ?? {};
    return `${activation.label}: ${requires.healing ? "a healing spell" : requires.damaging ? "a damage-dealing spell" : requires.anyTraits ? `a ${requires.anyTraits.join(" or ")} spell` : "the next spell"}`;
}

/**
 * The item's card posted: its activation armed for the caster's next spell this turn. The choices — which activation, which feat — are the
 * card's `flags[MODULE_ID].itemShapeChoice` ({ activation, feat, choice }) when given, else the GM's.
 */
export async function armItemSpellshape(message, item) {
    const read = item ? readItemSpellshape(item.toObject()) : null;
    const actor = item?.actor;
    if (!read || !actor) return null;
    const preset = message.flags?.[MODULE_ID]?.itemShapeChoice ?? {};
    let index = Number.isInteger(preset.activation) ? preset.activation : 0;
    if (read.activations.length > 1 && !Number.isInteger(preset.activation)) {
        const picked = await riderChoice({ name: item.name, choice: null }, "Which activation?", read.activations.map((activation, at) => ({ value: String(at), label: activationLabel(activation) })));
        if (picked == null) return null;
        index = Number(picked);
    }
    const activation = read.activations[index];
    if (!activation) return null;
    if (activation.arm?.type === "mark-creature") return markCreature(actor, item, activation.arm);
    if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.pendingSpellshape?.featUuid === item.uuid)) return null;
    const pending = { activation: index, ...(preset.choice != null ? { choice: preset.choice } : {}) };
    // (Djezet Dose: "you can apply the effects of the Reach Spell or Widen Spell spellshape feats" — one, chosen as it's drunk.)
    const pick = activation.riders.find(rider => rider.type === "as-feat" && rider.pick);
    if (pick) {
        pending.feat = pick.feats.some(feat => feat.uuid === preset.feat) ? preset.feat
            : await riderChoice({ name: item.name, choice: null }, "Which spellshape?", pick.feats.map(feat => ({ value: feat.uuid, label: feat.name })));
        if (!pending.feat) return null;
    }
    // (Hundred-Moth Caress: "You deal 1d10 void damage to yourself. This damage ignores all resistances and immunities, and you take it even if you
    // would be healed by void effects." — the total, untyped, taken whatever the wielder's defences; the spell's extra damage is that total.)
    if (activation.arm?.type === "self-damage") {
        const roll = await new (damageRollClass())(`${activation.arm.formula}[${activation.arm.damageType}]`).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(activation.label)}</strong>: damage to ${escapeHTML(actor.name)}` }).catch(() => null);
        await actor.applyDamage({ damage: roll.total, token: actor.getActiveTokens?.(true, true)?.[0], skipIWR: true, rollOptions: new Set() });
        pending.armed = roll.total;
    }
    return pendingShapeEffect(actor, item, "Item", pending);
}

/** Star Chart Tattoo: the constellation over a creature within reach — the targeted one — for a minute or three uses. */
async function markCreature(actor, item, arm) {
    const casterToken = actor.getActiveTokens?.(true, true)?.[0] ?? null;
    const target = [...(game.user?.targets ?? [])].find(token => token.actor && (!casterToken || tokenDistance(casterToken, token) <= arm.within));
    if (!target) {
        try { await ChatMessage.create({ whisper: gmIds(), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(item.name)}</strong> (GM): target a creature within ${arm.within} feet of ${escapeHTML(actor.name)}, then post the item again.</p>` }); } catch (_) {}
        return null;
    }
    const [made] = await target.actor.createEmbeddedDocuments("Item", [{ name: `${item.name}: constellation (${arm.uses} stars)`, type: "effect", img: item.img ?? "icons/svg/sun.svg",
        flags: { [MODULE_ID]: { starChart: { casterUuid: actor.uuid, uses: arm.uses, name: item.name } } },
        system: { duration: { value: arm.rounds, unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.started ? game.combat.combatant?.initiative ?? null : null },
            tokenIcon: { show: true }, description: { value: arm.text.map(text => `<p>${escapeHTML(text)}</p>`).join("") } } }]);
    return made;
}

/** A spell cast at the marked creature alone, with a range: one star winks out; the last ends the constellation. */
export async function starChartOnCast(message) {
    const isCast = message?.flags?.pf2e?.context?.type === "spell-cast" || (!message?.flags?.pf2e?.context?.type && message?.flags?.pf2e?.origin?.type === "spell" && message?.flags?.pf2e?.casting);
    const caster = message?.actor, spell = message?.item;
    if (!activeGM() || !isCast || !caster || !String(spell?.system?.range?.value ?? "").trim()) return null;
    const targets = castTargetActors(message, caster);
    if (targets.length !== 1 || targets[0] === caster) return null;
    const mark = (targets[0].itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.starChart?.casterUuid === caster.uuid);
    if (!mark) return null;
    const uses = Number(mark.flags[MODULE_ID].starChart.uses) - 1;
    if (uses <= 0) await mark.delete();
    else await mark.update({ name: `${mark.flags[MODULE_ID].starChart.name}: constellation (${uses} star${uses === 1 ? "" : "s"})`, [`flags.${MODULE_ID}.starChart.uses`]: uses });
    return { uses };
}

/** An armed item's riders for the cast: { requires, riders }, its borrowed feat's read in, and what its activation armed. */
export async function itemShapeFor(item, pending = {}) {
    const read = readItemSpellshape(item.toObject());
    const activation = read?.activations?.[pending.activation ?? 0];
    if (!activation) return null;
    let requires = foundry.utils.deepClone(activation.requires ?? {});
    const riders = [];
    for (const rider of foundry.utils.deepClone(activation.riders)) {
        if (rider.type === "as-feat") {
            // ("the spell gains the effects of the Widen Spell feat": the feat's own requirements and riders.)
            for (const feat of rider.pick ? rider.feats.filter(entry => entry.uuid === pending.feat) : rider.feats) {
                const doc = await fromUuid(feat.uuid).catch(() => null);
                const featRead = doc ? readSpellshapeFeat(doc.toObject()) : null;
                if (!featRead) { riders.push({ type: "note", wandRule: true, text: `${feat.name}'s effects apply to the spell.` }); continue; }
                const table = [...(featRead.requires?.table ?? []), ...(requires.table ?? [])];
                requires = { ...featRead.requires, ...requires, ...(table.length ? { table } : {}) };
                riders.push(...featRead.riders.map(entry => ({ ...entry, from: feat.name })));
            }
            continue;
        }
        if (rider.type === "flat-damage" && rider.formula === "armed") rider.formula = String(Number(pending.armed ?? 0));
        riders.push(rider);
    }
    return { requires, riders };
}

/** The item riders that act as the spell is cast: results, or null for a rider that isn't an item's. */
export async function itemCastRider(actor, message, shape, rider, facts, spell, rank) {
    switch (rider.type) {
        case "attack-defense": {
            rider.chosen = await riderChoice(shape, "Against which defense?", rider.choice.map(value => ({ value, label: `${capital(value)} DC` }))) ?? null;
            return rider.chosen ? [{ label: `${shape.name}: the spell attack against ${capital(rider.chosen)} DC instead of AC`, status: "applied" }] : [];
        }
        case "reroll-ones": return [{ label: `${shape.name}: damage dice that roll a 1 are rolled again`, status: "applied" }];
        case "as-feat": case "healed-generated": return [];
        case "strike-dice": {
            // ("Until the end of your next turn, you and your allies' Strikes deal an additional 2d6 electricity damage".)
            const results = [];
            const recipients = [actor, ...(rider.allies ? (canvas.scene?.tokens ?? []).map(token => token.actor).filter(other => other && other !== actor && allied(other, actor)) : [])];
            for (const recipient of [...new Set(recipients)]) {
                const made = await shapeEffect(recipient, actor, `${shape.name}: +${rider.diceNumber}${rider.dieSize} ${rider.damageType} on Strikes`,
                    [{ key: "DamageDice", selector: "strike-damage", diceNumber: rider.diceNumber, dieSize: rider.dieSize, damageType: rider.damageType }], { rounds: 1, until: rider.until });
                results.push({ label: `${shape.name}: ${recipient.name}'s Strikes +${rider.diceNumber}${rider.dieSize} ${rider.damageType}`, status: "applied", effectUuid: made?.uuid ?? null });
            }
            return results;
        }
        case "retaliate": {
            // (Thunderbird Tuft: no save, on a hit, more with a metal weapon, not a reach weapon; for 1 round or a minute.)
            const made = await shapeEffect(actor, actor, `${shape.name}: ${rider.formula} ${rider.damageType} to melee and touch attackers`, [], { rounds: rider.rounds ?? 1, until: rider.rounds ? null : rider.until,
                flags: { itemShapeRetaliate: { formula: rider.formula, metalFormula: rider.metalFormula ?? null, damageType: rider.damageType, statistic: rider.statistic, hitOnly: !!rider.hitOnly, nonReach: !!rider.nonReach,
                    dc: shapeDC(actor, spell), casterUuid: actor.uuid, name: shape.name, rank } } });
            return [{ label: `${shape.name}: creatures ${rider.hitOnly ? "hitting" : "targeting"} ${actor.name} with a melee Strike or touch take ${rider.formula} ${rider.damageType}${rider.statistic ? ` (basic ${rider.statistic})` : ""}`, status: "applied", effectUuid: made?.uuid ?? null }];
        }
        case "hurt-spores": {
            // (Wood-Rotted Root: "For the duration, whenever you take physical damage, … a cloud of spores": watched on the caster's damage — catalyst-runtime.js.)
            const rounds = shapeSpellFacts(spell)?.durationRounds ?? 100;
            const made = await shapeEffect(actor, actor, `${shape.name}: spores when hurt`, [], { rounds, flags: { catalystSpores: { ...rider, name: shape.name } } });
            return [{ label: `${shape.name}: ${rider.formula} ${rider.damageType} spores (DC ${rider.dc} ${rider.statistic}) within ${rider.radius} feet when ${actor.name} takes physical damage`, status: "applied", effectUuid: made?.uuid ?? null }];
        }
        case "cast-push-save": {
            // (Deadlock Mint: the targeted creatures — the GM's for the emanation —, Large or smaller (Huge for the greater's shorter push), Fortitude or pushed away.)
            const SIZES = ["tiny", "sm", "med", "lg", "huge", "grg"];
            const results = [];
            const targets = [...(game.user?.targets ?? [])].filter(token => token.actor && token.actor !== actor);
            for (const [feet, fits] of [[rider.feet, size => SIZES.indexOf(size) <= SIZES.indexOf(rider.maxSize)], ...(rider.huge ? [[rider.huge, size => size === "huge"]] : [])]) {
                const caught = targets.filter(token => fits(token.actor.size ?? "med"));
                if (!caught.length) continue;
                const card = await startShapeCard({ caster: actor, name: shape.name, rank, statistic: rider.statistic, outcomes: { criticalSuccess: "The creature is unaffected.", success: "The creature is unaffected.", failure: `The creature is pushed ${feet} feet away from you.`, criticalFailure: `The creature is pushed ${feet} feet away from you.` },
                    targets: caught, dc: shapeDC(actor, spell), entryId: spell?.spellcasting?.id ?? null }).catch(error => ({ error: error.message }));
                results.push({ label: `${shape.name}: ${rider.statistic} save or pushed ${feet} feet for ${caught.map(token => token.name).join(", ")}${card?.error ? ` (${card.error})` : ""}`, status: card?.error ? "failed" : "applied" });
            }
            return results.length ? results : [{ label: `${shape.name}: target the creatures in the emanation`, status: "manual" }];
        }
        case "ally-temp-hp": {
            // ("If the target is an ally, … they gain 10 temporary Hit Points that last for 1 minute": PF2e's Effect.)
            const target = castTargetActors(message, actor).find(other => other !== actor);
            if (!target || !allied(target, actor)) return [];
            const template = rider.uuid ? await loadNativeEffectTemplate(rider.uuid) : null;
            if (!template) return [await timedTempHp(target, rider.amount, shape.name, rider.rounds)];
            const made = await createNativeEffect(target, prepareNativeEffectSource(template, { castInstanceId: message.id, castRank: rank, sourceActorUuid: actor.uuid, sourceItemUuid: spell?.uuid ?? null,
                sourceItemName: spell?.name ?? shape.name, resolutionKind: "save", targetActorUuid: target.uuid }));
            return [{ label: `${shape.name}: ${target.name} gains ${rider.amount} temporary Hit Points`, status: "applied", effectUuid: made?.uuid ?? null }];
        }
        case "lie-check": return lieCheck(actor, shape);
        case "turn-save-area": return [await turnSaveArea(actor, message, shape, rider, spell, rank)];
        case "damage-card": case "temp-hp-card": case "effect-card": case "save-card": {
            const button = { "damage-card": rider.label, "temp-hp-card": `${rider.amount} temporary Hit Points for ${rider.label} (target it)`, "effect-card": rider.label, "save-card": rider.label }[rider.type];
            const dc = shapeDC(actor, spell);
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: gmIds(), flags: { [MODULE_ID]: { kind: "item-shape-card", itemCard: { casterUuid: actor.uuid, castId: message.id, name: shape.name, rank, dc, rider } } },
                content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(shape.name)}</strong> (${escapeHTML(spell?.name ?? "the spell")})${rider.type === "save-card" ? `: ${escapeHTML(capital(rider.statistic))} DC ${dc}` : ""}</p>${rider.doubleRest ? "<p>They also regain double the Hit Points of an 8-hour rest.</p>" : ""}<button type="button" data-pf2e-auto-item-shape="${rider.type}">${escapeHTML(button)}</button></section>` }); } catch (_) {}
            return [{ label: `${shape.name}: its card`, status: "applied" }];
        }
        default: return null;
    }
}

/** Liar's Lexicon: "Attempt a Deception check to Lie … against the Perception DC of all those observing you" — the creatures not allied with the caster. */
async function lieCheck(actor, shape) {
    const observers = (canvas.scene?.tokens ?? []).filter(token => token.actor && !token.hidden && token.actor !== actor && !allied(token.actor, actor));
    const roll = await actor.skills?.deception?.roll({ extraRollOptions: ["action:lie"], skipDialog: true, label: `${shape.name}: Lie (the casting hidden)` });
    if (!roll) return [{ label: `${shape.name}: no Deception check`, status: "failed" }];
    const natural = roll.dice?.[0]?.results?.find(result => result.active !== false)?.result ?? null;
    const fooled = [], not = [];
    for (const token of observers) {
        const dc = Number(token.actor.perception?.dc?.value ?? token.actor.system?.perception?.dc ?? NaN);
        if (!Number.isFinite(dc)) continue;
        let degree = roll.total >= dc + 10 ? 3 : roll.total >= dc ? 2 : roll.total <= dc - 10 ? 0 : 1;
        if (natural === 20) degree = Math.min(3, degree + 1);
        if (natural === 1) degree = Math.max(0, degree - 1);
        (degree >= 2 ? fooled : not).push(token.name);
    }
    try { await ChatMessage.create({ whisper: gmIds(), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(shape.name)}</strong> (GM): ${escapeHTML(actor.name)}'s Lie (${roll.total}) — think it was only talking: ${escapeHTML(fooled.join(", ") || "none")}; see the casting: ${escapeHTML(not.join(", ") || "none")}.</p>` }); } catch (_) {}
    return [{ label: `${shape.name}: the Lie fools ${fooled.length} of ${fooled.length + not.length} observers`, status: "applied", fooled, notFooled: not }];
}

/** An area whose creatures save as their turns begin: around the caster (Radiant Tome's light), or on the ground around a chosen target (the blood). */
async function turnSaveArea(actor, message, shape, rider, spell, rank) {
    let center = null;
    if (rider.center === "caster") center = { actorUuid: actor.uuid };
    else {
        // ("The wounds of one affected target (chosen by you)": among the spell's targets, the ground where it stands.)
        const targets = castTargetActors(message, actor).filter(other => other !== actor);
        const pickedUuid = targets.length ? await riderChoice(shape, "Which target's blood?", targets.map(other => ({ value: other.uuid, label: other.name }))) : null;
        const token = targets.find(other => other.uuid === pickedUuid)?.getActiveTokens?.(true, true)?.[0] ?? null;
        if (!token) return { label: `${shape.name}: no target for the area`, status: "manual" };
        center = { x: token.x, y: token.y, width: token.width, height: token.height, name: token.name };
    }
    const rules = rider.light ? [{ key: "TokenLight", value: { bright: rider.light.bright, dim: rider.light.bright } }] : [];
    const made = await shapeEffect(actor, actor, `${shape.name}: ${rider.radius}-foot ${rider.center === "caster" ? "emanation" : `area around ${center.name}'s space`}`, rules, { rounds: rider.rounds,
        flags: { itemShapeArea: { casterUuid: actor.uuid, castId: message.id, name: shape.name, center, radius: rider.radius, who: rider.who, statistic: rider.statistic, outcomes: rider.outcomes,
            immuneRounds: rider.immuneRounds ?? null, dc: shapeDC(actor, spell), rank } } });
    return { label: `${shape.name}: creatures beginning their turn within ${rider.radius} feet ${rider.center === "caster" ? `of ${actor.name}` : `of ${center.name}'s space`} save (${rider.statistic})`, status: "applied", effectUuid: made?.uuid ?? null };
}

/** Outcomes of an item's save on a creature: conditions, a named Effect ("treats all other creatures as hidden"), immunity. */
async function applyOutcome(creature, caster, name, list, dc) {
    const results = [];
    for (const entry of list ?? []) {
        if (entry.generated) {
            const made = await shapeEffect(creature, caster, `${name}: ${entry.generated}`, [], { rounds: entry.rounds });
            results.push({ label: `${name}: ${creature.name} ${entry.generated} (${entry.rounds} round${entry.rounds === 1 ? "" : "s"})`, status: "applied", effectUuid: made?.uuid ?? null });
        } else results.push(...await timedConditions(creature, [entry], name, { caster, dc }));
    }
    return results;
}

const immuneTo = (creature, name, casterUuid) => (creature.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.itemShapeImmune?.name === name && effect.flags[MODULE_ID].itemShapeImmune.casterUuid === casterUuid);
async function makeImmune(creature, name, casterUuid, duration) {
    await creature.createEmbeddedDocuments("Item", [{ name: `${name}: immune`, type: "effect", img: "icons/svg/aura.svg", flags: { [MODULE_ID]: { itemShapeImmune: { name, casterUuid } } },
        system: { duration, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: false } } }]);
}

async function rollSave(creature, statistic, dc, name) {
    const roll = await creature.saves?.[statistic]?.roll({ dc: { value: dc }, skipDialog: true, extraRollOptions: ["item:trait:magical"], label: name });
    return DEGREES[Number(roll?.degreeOfSuccess ?? 2)];
}

/** A creature's turn begins: in an item's area, it saves (once per turn). */
export async function itemShapeTurnStart(combat) {
    if (!activeGM() || !combat?.started) return [];
    const token = combat.combatant?.token;
    const creature = token?.actor;
    if (!token || !creature) return [];
    const done = [];
    for (const other of canvas.scene?.tokens ?? []) for (const effect of other.actor?.itemTypes?.effect ?? []) {
        const area = effect.flags?.[MODULE_ID]?.itemShapeArea;
        if (!area || other.actor.uuid !== area.casterUuid) continue;
        const caster = other.actor;
        if (area.who === "enemies" && allied(creature, caster)) continue;
        const centerDoc = area.center.actorUuid ? other : { ...area.center };
        if (tokenDocumentDistance(centerDoc, token, { gridSize: canvas.grid.size, gridDistance: canvas.dimensions.distance }) > area.radius) continue;
        if (immuneTo(creature, area.name, caster.uuid)) { noticeImmunity({ actor: creature, token, blocked: area.name, why: `temporarily immune to ${caster.name}'s ${area.name}` }); continue; }
        const degree = await rollSave(creature, area.statistic, area.dc, area.name);
        const results = await applyOutcome(creature, caster, area.name, area.outcomes?.[degree], area.dc);
        if (degree === "criticalSuccess" && area.immuneRounds) await makeImmune(creature, area.name, caster.uuid, { value: area.immuneRounds, unit: "rounds", expiry: "turn-start", sustained: false });
        done.push({ creature: creature.name, degree, results: results.map(result => result.label) });
    }
    return done;
}

/** Sparking Grimoire's charge: a creature targeting the charged caster with a melee Strike or a touch spell takes the damage (basic save). */
export async function itemShapeWatchMessage(message) {
    if (!activeGM()) return [];
    const flags = message.flags?.pf2e ?? {};
    const context = flags.context ?? {};
    const roller = message.actor;
    if (!roller) return [];
    const strike = context.type === "attack-roll" && !(context.options ?? []).some(option => String(option).startsWith("pf2e-auto-application:"))
        && (context.options ?? []).includes("item:melee") && !(context.options ?? []).some(option => option === "item:trait:spell" || String(option).startsWith("item:type:spell"));
    const touchSpell = (context.type === "spell-cast" || (!context.type && flags.origin?.type === "spell" && flags.casting)) && /^touch$/i.test(String(message.item?.system?.range?.value ?? "").trim());
    if (!strike && !touchSpell) return [];
    const targets = strike ? [context.target?.actor ? fromUuidSync(context.target.actor) : null].filter(Boolean) : castTargetActors(message, roller);
    const done = [];
    for (const holder of targets) {
        if (holder === roller) continue;
        for (const effect of holder.itemTypes?.effect ?? []) {
            const watch = effect.flags?.[MODULE_ID]?.itemShapeRetaliate;
            if (!watch) continue;
            const rollerToken = message.token?.object ?? roller.getActiveTokens?.(true, false)?.[0] ?? null;
            if (!rollerToken) continue;
            // (Thunderbird Tuft: "hits you with a melee unarmed attack or non-reach melee weapon attack … or 1d6 … if the creature is using a metal weapon": no save.)
            const options = context.options ?? [];
            if (watch.hitOnly && strike && !["success", "criticalSuccess"].includes(context.outcome)) continue;
            if (watch.nonReach && strike && options.includes("item:trait:reach")) continue;
            if (!watch.statistic) {
                const weapon = strike && !options.includes("item:category:unarmed") && !options.some(option => /^item:trait:unarmed$/.test(option));
                const formula = weapon && watch.metalFormula ? watch.metalFormula : watch.formula;
                const roll = await new (damageRollClass())(`${formula}[${watch.damageType}]`).evaluate();
                await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: holder }), flavor: `<strong>${escapeHTML(watch.name)}</strong>: ${escapeHTML(roller.name)}` }).catch(() => null);
                await applyDamageWithReceipt(roller, { damage: roll, token: rollerToken.document ?? rollerToken, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
                done.push({ holder: holder.name, attacker: roller.name, formula });
                continue;
            }
            await startShapeCard({ caster: holder, name: watch.name, rank: watch.rank, statistic: watch.statistic, damage: { formula: watch.formula, type: watch.damageType }, targets: [rollerToken], dc: watch.dc });
            done.push({ holder: holder.name, attacker: roller.name });
        }
    }
    return done;
}

/** An item card's button: for the targeted creatures. */
export async function runItemShapeCard(message, button) {
    const data = message.flags?.[MODULE_ID]?.itemCard;
    const caster = data ? await fromUuid(data.casterUuid).catch(() => null) : null;
    if (!data || !caster) throw new Error("This card's caster is gone.");
    const rider = data.rider;
    const tokens = [...(game.user?.targets ?? [])].filter(token => token.actor);
    if (!tokens.length) throw new Error("Target the creature first.");
    const results = [];
    if (rider.type === "damage-card") {
        const amount = rider.formula === "rank" ? String(data.rank) : rider.formula;
        for (const token of tokens) {
            const roll = await new (damageRollClass())(`${amount}[${rider.damageType}]`).evaluate();
            const receipt = await applyDamageWithReceipt(token.actor, { damage: roll, token: token.document, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
            results.push(`${token.name} takes ${receipt?.damage ?? roll.total} ${rider.damageType}`);
        }
    } else if (rider.type === "temp-hp-card") {
        // ("one of the summoned creatures": once.)
        if (message.getFlag(MODULE_ID, "itemCardUsed")) throw new Error(`${data.name} has already been given.`);
        const result = await timedTempHp(tokens[0].actor, rider.amount, data.name, rider.rounds);
        await message.setFlag(MODULE_ID, "itemCardUsed", true);
        results.push(result.label);
    } else if (rider.type === "effect-card") {
        const template = await loadNativeEffectTemplate(rider.uuid);
        if (!template) throw new Error(`${data.name}: PF2e's Effect is unavailable.`);
        for (const token of tokens) {
            await createNativeEffect(token.actor, prepareNativeEffectSource(template, { castInstanceId: data.castId, castRank: data.rank, sourceActorUuid: caster.uuid, sourceItemUuid: null, sourceItemName: data.name, resolutionKind: "save", targetActorUuid: token.actor.uuid }));
            results.push(`${token.name}: ${template.name}`);
        }
    } else if (rider.type === "save-card") {
        for (const token of tokens) {
            if (immuneTo(token.actor, data.name, caster.uuid)) { results.push(`${token.name} is immune`); noticeImmunity({ actor: token.actor, token, blocked: data.name, why: `temporarily immune to ${caster.name}'s ${data.name}` }); continue; }
            const degree = await rollSave(token.actor, rider.statistic, data.dc, data.name);
            const applied = await applyOutcome(token.actor, caster, data.name, rider.outcomes?.[degree], data.dc);
            // ("Regardless of the results, the target then becomes immune to Bewildering Walls for 24 hours.")
            if (rider.immuneHours) await makeImmune(token.actor, data.name, caster.uuid, { value: rider.immuneHours, unit: "hours", expiry: null, sustained: false });
            results.push(`${token.name}: ${degree}${applied.length ? ` — ${applied.map(entry => entry.label).join("; ")}` : ""}`);
        }
    }
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), whisper: gmIds(), content: `<p><strong>${escapeHTML(data.name)}</strong></p><ul>${results.map(result => `<li>${escapeHTML(result)}</li>`).join("")}</ul>` }); } catch (_) {}
    return results;
}

export function bindItemShapeButtons(message, html) {
    const root = html instanceof HTMLElement ? html : html?.[0];
    for (const button of root?.querySelectorAll?.("[data-pf2e-auto-item-shape]") ?? []) button.addEventListener("click", async () => {
        try { await runItemShapeCard(message, button); } catch (error) { ui.notifications.error(error.message); }
    });
}

/**
 * Wood-Rotted Root's spores: the caster under its Effect takes physical damage — the creatures within the distance (not the caster) save against the fixed DC or take the damage.
 * (PF2e's damage message names the damage's types in its options.)
 */
export async function catalystSporesOnDamage(message) {
    if (!activeGM() || message?.flags?.pf2e?.context?.type !== "damage-taken" || message.flags.pf2e.appliedDamage?.isHealing) return null;
    const holder = message.actor;
    const effect = (holder?.itemTypes?.effect ?? []).find(entry => entry.flags?.[MODULE_ID]?.catalystSpores);
    if (!effect) return null;
    // (PF2e's damage message names no types: the ones its applyDamage was last given for this creature, which pf2e-resolution-core remembers.)
    const types = core()?.patches.damage.lastTypes(holder.uuid) ?? [];
    const physical = ["bludgeoning", "piercing", "slashing"].some(type => types.includes(type));
    // (The Hit Points lost: PF2e's update records the change.)
    const lost = Number((message.flags.pf2e.appliedDamage.updates ?? []).find(update => update.path === "system.attributes.hp.value")?.value ?? 0);
    if (!physical || !(lost > 0)) return null;
    const spores = effect.flags[MODULE_ID].catalystSpores;
    const center = holder.getActiveTokens?.(true, true)?.[0] ?? null;
    const caught = center ? tokensWithin(center, spores.radius).map(token => token.object ?? token) : [];
    if (!caught.length) return { caught: [] };
    // ("to avoid taking 1d8 poison damage": no damage on a success — the card's rows plain, the damage its rider on a failure.)
    const plainRow = "The creature is unaffected.";
    await startShapeCard({ caster: holder, name: spores.name, rank: 1, statistic: spores.statistic, outcomes: { criticalSuccess: plainRow, success: plainRow, failure: plainRow, criticalFailure: plainRow }, targets: caught, dc: spores.dc,
        riders: [{ type: "flat-damage", formula: spores.formula, damageType: spores.damageType, degrees: ["failure", "criticalFailure"] }] }).catch(() => null);
    return { caught: caught.map(token => token.name) };
}

/**
 * Demon Bone Tiles: a Shield Block with the spell's shield leaves no trace in PF2e's message — the shield's Effect is marked once the damage is applied,
 * and the GM's client bursts it (catalyst-runtime.js). pf2e-resolution-core's damage patch asks this before applying damage; returns what to do after, or null.
 */
export function shieldShardsBlock(actor, params) {
    const shieldId = actor.attributes?.shield?.raised ? actor.attributes.shield.itemId : null;
    const shards = params?.shieldBlockRequest && shieldId ? (actor.itemTypes?.effect ?? []).find(effect => effect.id === shieldId && effect.flags?.[MODULE_ID]?.shieldShards && !effect.flags[MODULE_ID].shieldShards.spent) ?? null : null;
    return shards ? () => shards.setFlag(MODULE_ID, "shieldShards", { ...shards.flags[MODULE_ID].shieldShards, blockedAt: Date.now() }).catch(() => null) : null;
}

