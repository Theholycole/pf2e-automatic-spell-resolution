// Affliction care: no-save spells acting on a creature's existing afflictions
// (the Pseudo Afflictions handler's Effects: stage = badge), conditions,
// persistent poison and counteractable effects. The GM chooses what the caster
// chose; every operation is applied and reported on one chat card.
import { MODULE_ID } from "./effect-runtime.js";
import { applyDamageWithReceipt } from "./native-damage-receipt.js";
import { isDying, recoverFromDying, revivedNote } from "./dying-recovery.js";
import { setAsideEffect } from "./set-aside-runtime.js";
import { AFFLICTION_HANDLER as HANDLER } from "./runtime-utils.js";
import { afflictionCounteractRank, afflictionStage, afflictionStageDelta, carePlanAtRank, counteracts, durationSeconds, isExecutableCarePlan,
    nextAfflictionBadge, stageLengthSeconds } from "./affliction-care-core.js";

import { noticeImmunity } from "./immunity-notice.js";
const esc = value => foundry.utils.escapeHTML(String(value ?? ""));
const DEGREES = ["critical failure", "failure", "success", "critical success"];
const span = d => `${d.value} ${d.value === 1 ? d.unit.replace(/s$/, "") : d.unit}`;

function handlerActive() {
    return game.modules.get(HANDLER)?.active === true;
}

const signed = value => (value > 0 ? `+${value}` : `${value}`);

/**
 * Without Pseudo Afflictions there is no affliction Effect to change, so each
 * affliction operation becomes an exact instruction for the GM instead.
 */
function manualAffliction(op, choices, care) {
    const why = "Pseudo Afflictions is unavailable";
    switch (op.op) {
        case "affliction-saves":
            return `${why}: the target attempts one save against each affliction it has whose current stage lasts ${span(op.maxStageLength)} or less; apply each result (critical success −2 stages, success −1, failure +1, critical failure +2).`;
        case "affliction-save": {
            const modifier = Number(choices.modifier);
            return `${why}: the target immediately attempts its next save against ${care.pickAny ? "each chosen" : "the chosen"} ${op.traits.join(" or ")} affliction${op.modifierChoice.includes(modifier) ? ` with a ${signed(modifier)} status modifier` : ""}; apply the stage change.`;
        }
        case "counteract":
            return `${why}: attempt a counteract check (the caster's counteract modifier, rank = cast rank) against ${op.pick === 1 ? "one" : "each chosen"} ${op.traits.join(" or ")} affliction (DC = its DC, counteract rank = half its level, rounded up); on success it ends.`;
        case "reduce-affliction-stage":
            return `${why}: reduce the stage of one ${op.traits.join(" or ")} affliction the target has by ${op.by} (not below stage 1; it isn't cured)${care.oncePerExposure ? "; only once for the same exposure" : ""}.`;
    }
    return null;
}

function handlerAfflictions(actor) {
    return actor.itemTypes.effect.filter(effect => effect.flags?.[HANDLER]?.stages).map(effect => {
        const flags = effect.flags[HANDLER];
        const onset = !!flags.onset;
        const badge = Number(effect.badge?.value ?? effect.system.badge?.value ?? 1);
        return { effect, id: effect.id, name: effect.name, traits: effect.system.traits?.value ?? [], onset, inOnset: onset && badge === 1,
            badge, max: Number(effect.badge?.max ?? effect.system.badge?.max ?? badge), stage: afflictionStage(badge, onset),
            stageLength: flags.stages?.[badge]?.duration ?? null, save: flags.save ?? null };
    });
}

/** One of the creature's afflictions (the handler's Effects) with the traits, its stage lowered (not below the floor): Bounty of the Sky's gift. */
export async function lowerAfflictionStage(actor, traits, { id = null, by = 1, floor = 1 } = {}) {
    const eligible = handlerAfflictions(actor).filter(affliction => traits.some(trait => affliction.traits.includes(trait)));
    const affliction = eligible.find(entry => entry.id === id) ?? eligible[0];
    if (!affliction) return null;
    const badge = nextAfflictionBadge(affliction, -by, floor);
    if (badge != null && badge !== affliction.badge) await affliction.effect.update({ "system.badge.value": badge });
    return { name: affliction.name, from: affliction.stage, to: badge == null ? affliction.stage : afflictionStage(badge, affliction.onset) };
}

function persistentPoison(actor) {
    return actor.itemTypes.condition.filter(condition => condition.slug === "persistent-damage" && condition.system.persistent?.damageType === "poison");
}

/** A spell's Effect: PF2e marks it fromSpell, or its origin item is a spell. */
function isSpellEffect(effect) {
    if (effect.system?.fromSpell === true) return true;
    const origin = effect.system?.context?.origin?.item;
    const item = origin ? fromUuidSync(origin) : null;
    return item?.type === "spell";
}

/** An Effect's whole duration in seconds (null when unlimited or unknown). */
function effectSeconds(effect) {
    const duration = effect.system?.duration ?? {};
    const per = { rounds: 6, minutes: 60, hours: 3600, days: 86400 }[duration.unit];
    return per && Number.isFinite(Number(duration.value)) ? Number(duration.value) * per : null;
}

/**
 * Thief of Fortune: the countered spell Effect stays, and the caster gains a copy; "the spell's duration is halved … each round that both … are
 * affected counts for two rounds": both keep half the remaining time (in rounds, from now).
 */
async function siphonEffect(effect, caster, spell) {
    const remaining = Number(effect.remainingDuration?.remaining ?? effectSeconds(effect) ?? 6);
    const rounds = Math.max(1, Math.ceil(remaining / 2 / 6));
    const start = { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null };
    const duration = { value: rounds, unit: "rounds", expiry: effect.system?.duration?.expiry ?? "turn-start", sustained: false };
    await effect.update({ "system.duration": duration, "system.start": start });
    const source = effect.toObject();
    delete source._id;
    foundry.utils.setProperty(source, "system.duration", duration);
    foundry.utils.setProperty(source, "system.start", start);
    foundry.utils.setProperty(source, `flags.${MODULE_ID}.siphoned`, { fromActorUuid: effect.parent?.uuid ?? null, fromEffectId: effect.id, spell: spell.name });
    const [copy] = await caster.createEmbeddedDocuments("Item", [source]);
    return { copy, rounds };
}

/** What a counteract can pick on this creature, each with a suggested DC and counteract rank (the GM confirms them). */
function counteractCandidates(actor, op, choices = {}, care = {}) {
    if (!actor) return [];
    const source = op.source ?? "effect";
    if (source === "affliction" || source === "chosen-affliction") {
        // "any one affliction" (Delay Affliction), or afflictions with one of the traits.
        const afflictions = handlerAfflictions(actor).filter(entry => op.anyAffliction || op.traits.some(trait => entry.traits.includes(trait)));
        const chosen = source === "chosen-affliction" ? afflictions.filter(entry => (choices.afflictions ?? []).includes(entry.id)) : afflictions;
        return chosen.map(entry => ({ id: entry.id, name: `${entry.name} (stage ${entry.stage})`, document: entry.effect, affliction: entry,
            dc: Number(entry.save?.value) || null, rank: afflictionCounteractRank(entry.effect.system?.level?.value) }));
    }
    const grantsOf = effect => actor.itemTypes.condition.filter(condition => condition.flags?.pf2e?.grantedBy?.id === effect.id).map(condition => condition.slug);
    // Cleansing Flames: a poison affliction imposing one of the listed conditions is a candidate too.
    const afflictions = (op.afflictionTraits ?? []).length ? handlerAfflictions(actor).filter(entry => op.afflictionTraits.some(trait => entry.traits.includes(trait))
        && op.grantsConditions.some(slug => grantsOf(entry.effect).includes(slug)))
        .map(entry => ({ id: entry.id, name: `${entry.name} (stage ${entry.stage})`, document: entry.effect, affliction: entry,
            dc: Number(entry.save?.value) || null, rank: afflictionCounteractRank(entry.effect.system?.level?.value) })) : [];
    return [...afflictions, ...actor.itemTypes.effect.filter(effect => {
        if (effect.flags?.[HANDLER] || effect.flags?.[MODULE_ID]?.setAside) return false;
        // (Thief of Fortune: "with a duration of 10 minutes or less".)
        if (source === "spell-effect") return isSpellEffect(effect) && (op.maxSeconds == null || (effectSeconds(effect) != null && effectSeconds(effect) <= op.maxSeconds));
        const traits = effect.system.traits?.value ?? [];
        // "This spell can't counteract or suppress curses, diseases, …"
        if ((care.excludeTraits ?? []).some(trait => traits.includes(trait))) return false;
        const grants = actor.itemTypes.condition.filter(condition => condition.flags?.pf2e?.grantedBy?.id === effect.id).map(condition => condition.slug);
        return op.traits.some(trait => traits.includes(trait)) || op.grantsConditions.some(slug => grants.includes(slug));
    }).map(effect => {
        const origin = effect.system?.context?.origin?.actor ? fromUuidSync(effect.system.context.origin.actor) : null;
        const dc = origin?.attributes?.classOrSpellDC?.value ?? origin?.system?.attributes?.spellDC?.value ?? null;
        return { id: effect.id, name: effect.name, document: effect, dc: Number(dc) || null, rank: Number(effect.system?.level?.value) || null };
    })];
}

/** The caster's counteract check: PF2e's counteract statistic for the spell's spellcasting entry. */
async function counteractRoll(spell, dc, modifiers = [], { secret = false } = {}) {
    const statistic = spell.spellcasting?.counteraction ?? spell.spellcasting?.statistic;
    if (!statistic) throw new Error(`${spell.name}: the caster's counteract statistic is unavailable.`);
    // "The GM attempts a secret counteract check": a blind roll only the GM sees.
    return statistic.check.roll({ dc: { value: dc }, item: spell, extraRollOptions: ["action:counteract"], skipDialog: true, ...(modifiers.length ? { modifiers } : {}), ...(secret ? { rollMode: "blindroll" } : {}) });
}

export class AfflictionCareRuntime {
    // Whether the current cast's checks are secret (its result card is whispered to the GM).
    #secret = false;
    supports(plan) { return isExecutableCarePlan(plan); }

    /** Choices may be passed programmatically; otherwise the GM is asked. */
    async start(spell, plan, { sourceActor = spell.actor, castRank = spell.rank, targets = game.user.targets, choices = null } = {}) {
        if (!game.user.isGM) throw new Error("The GM resolves affliction-care spells.");
        if (!isExecutableCarePlan(plan)) throw new Error(`${spell.name} is not an executable affliction-care plan.`);
        this.#secret = [...(plan.resolution.operations ?? []), ...(plan.resolution.modes ?? []).flatMap(mode => mode.operations)].some(op => op.secret === true);
        const tokens = [...targets];
        const recipient = plan.resolution.recipient ?? "target";
        // The caster's own care needs no target; a counteract against "the target" may name no creature (an area or item).
        if (recipient === "target" && tokens.length !== 1) throw new Error(`${spell.name}: target exactly one creature.`);
        if (recipient === "counteract-target" && tokens.length > 1) throw new Error(`${spell.name}: target at most one creature (none for an area or item).`);
        if (recipient === "targets") return await this.#startMany(spell, plan, { sourceActor, castRank, tokens, choices });
        // A counteract against a spell or an item/ward names no creature.
        // getActiveTokens(false, true) already returns token documents.
        const token = recipient === "self" ? sourceActor.getActiveTokens?.(false, true)?.[0] ?? null
            : tokens[0] ? tokens[0].document ?? tokens[0] : null;
        const actor = recipient === "self" ? sourceActor : recipient === "triggering-spell" ? null : token?.actor ?? null;
        const care = carePlanAtRank(plan.resolution, castRank);
        // "If the target is immune to poison, this spell has no effect."
        if (care.negatedByImmunity && actor?.attributes?.immunities?.some?.(entry => entry.type === care.negatedByImmunity)) {
            noticeImmunity({ actor, token, blocked: spell.name, why: `immune to ${care.negatedByImmunity}` });
            return await this.#report(spell, actor, castRank, [{ label: `${actor.name} is immune to ${care.negatedByImmunity}: ${spell.name} has no effect.`, status: "negated" }]);
        }
        const key = spell.slug ?? spell.system.slug;
        const results = [];
        const limit = care.immunity ?? care.dailyLimit;
        const marker = limit && actor?.itemTypes.effect.find(effect => effect.flags?.[MODULE_ID]?.careImmunity === key);
        if (marker) return await this.#report(spell, actor, castRank, [{ label: `${actor.name} can't benefit again yet (${marker.name}).`, status: "refused" }]);
        choices ??= await this.#ask(spell, care, actor);
        if (!choices) return { status: "cancelled" };

        if (care.unwillingSave && choices.unwilling) {
            const dc = spell.spellcasting?.statistic?.dc?.value;
            if (!Number.isFinite(dc)) throw new Error(`${spell.name}: the caster's spell DC is unavailable.`);
            const roll = await actor.saves[care.unwillingSave.statistic].roll({ dc: { value: dc }, item: spell, origin: sourceActor, skipDialog: true });
            results.push({ label: `Unwilling ${care.unwillingSave.statistic} save: ${DEGREES[roll.degreeOfSuccess]} (DC ${dc})`, status: "rolled" });
            if (roll.degreeOfSuccess >= 2) {
                results.push({ label: `${spell.name} is negated.`, status: "negated" });
                return await this.#report(spell, actor, castRank, results);
            }
        }
        const mode = care.modes.length ? care.modes.find(entry => entry.id === choices.mode) : null;
        if (care.modes.length && !mode && !(care.pickAny && care.progressTargets)) throw new Error(`${spell.name}: choose one of ${care.modes.map(entry => entry.label).join(", ")}.`);
        // The reaction's trigger and limits are the caster's to judge; the card repeats them.
        for (const note of [...(care.castingCondition ?? []), ...[care.counteractLimit, care.awareness, care.normalStateNote].filter(Boolean)]) results.push({ label: note, status: "note" });
        const operations = [...care.operations, ...(care.pickAny && care.progressTargets ? care.modes.flatMap(entry => entry.operations) : mode?.operations ?? [])];
        // One context for the whole cast: a counteract records the triggering spell's rank for a later Hit Point loss.
        const context = { spell, sourceActor, actor, token, castRank, care, choices };
        for (const op of operations) results.push(...await this.#apply(op, context));
        if (limit && actor) {
            const [effect] = await actor.createEmbeddedDocuments("Item", [{
                name: `${spell.name}: ${care.immunity ? "temporarily immune" : "benefited today"}`, type: "effect", img: "icons/svg/clockwork.svg",
                flags: { [MODULE_ID]: { careImmunity: key } },
                system: { duration: { value: limit.value, unit: limit.unit, expiry: "turn-start", sustained: false }, rules: [],
                    description: { value: `<p>${esc(actor.name)} can't benefit from <strong>${esc(spell.name)}</strong> again until this ends.</p>` },
                    context: { origin: { actor: sourceActor.uuid, item: spell.uuid }, target: { actor: actor.uuid, token: token?.uuid ?? null }, roll: null } }
            }]);
            results.push({ label: `${effect.name} (${span(limit)})`, status: "applied" });
        }
        return await this.#report(spell, actor, castRank, results);
    }

    /** Detonate Magic's explosion: the spell's own basic save, on a save card for the creatures the GM targets. */
    async #explode(spell, sourceActor, castRank, care, choices) {
        if (!this.saves) throw new Error(`${spell.name}: the save runtime is unavailable for the explosion.`);
        const targets = choices.explosionTargets ?? [...game.user.targets];
        if (!targets.length) return [{ label: `The explosion (${care.explosion.sentence}) — target the creatures it affects and cast its save from the spell.`, status: "manual" }];
        const { card } = await this.saves.start(spell, { plan: care.explosionPlan, sourceActor, targets, castRank, skipConfirmation: true });
        return [{ label: `Explosion: ${care.explosion.formula} ${care.explosion.damageType}, basic ${care.explosion.statistic} save for ${targets.length} creature${targets.length === 1 ? "" : "s"} (save card posted).`, status: "applied", explosionCardId: card.id }];
    }

    /** "You and up to 9 allies": the chosen option for every target, one healing roll shared, one result card. */
    async #startMany(spell, plan, { sourceActor, castRank, tokens, choices }) {
        const care = carePlanAtRank(plan.resolution, castRank);
        const documents = tokens.map(token => token.document ?? token);
        if (!documents.length || documents.length > care.maxTargets) throw new Error(`${spell.name}: target 1 to ${care.maxTargets} creatures (you and your allies).`);
        const actors = documents.map(document => document.actor);
        choices ??= await this.#ask(spell, care, null, actors);
        if (!choices) return { status: "cancelled" };
        const mode = care.modes.find(entry => entry.id === choices.mode);
        if (!mode) throw new Error(`${spell.name}: choose one of ${care.modes.map(entry => entry.label).join(", ")}.`);
        const results = [], shared = {};
        for (const [index, actor] of actors.entries()) {
            const context = { spell, sourceActor, actor, token: documents[index], castRank, care, choices, shared };
            for (const op of mode.operations) for (const result of await this.#apply(op, context)) results.push({ ...result, label: `${actor.name}: ${result.label}` });
        }
        return await this.#report(spell, null, castRank, results, actors);
    }

    async #apply(op, context) {
        const { spell, actor, choices, care, castRank, sourceActor, token } = context;
        const out = [];
        const affliction = ["affliction-saves", "affliction-save", "reduce-affliction-stage"].includes(op.op)
            || (op.op === "counteract" && ["affliction", "chosen-affliction"].includes(op.source));
        if (affliction && !handlerActive()) return [{ label: manualAffliction(op, choices, care), status: "manual" }];
        if (affliction && op.op !== "affliction-saves" && op.op !== "counteract" && !handlerAfflictions(actor).some(entry => op.traits.some(trait => entry.traits.includes(trait)))) {
            return [{ label: `No ${op.traits.join(" or ")} affliction tracked by Pseudo Afflictions on ${actor.name}; ${manualAffliction(op, choices, care).replace(/^Pseudo Afflictions is unavailable: /, "if it has one untracked, ")}`, status: "manual" }];
        }
        switch (op.op) {
            case "suppress-condition": {
                const slug = choices.suppress;
                if (!op.from.includes(slug)) throw new Error(`${spell.name}: choose one of ${op.from.join(", ")} to suppress.`);
                const condition = actor.itemTypes.condition.find(entry => entry.slug === slug);
                if (!condition) return [{ label: `${actor.name} isn't ${slug}: nothing to suppress.`, status: "skipped" }];
                await setAsideEffect(condition, { setAside: op.setAside, spellName: spell.name, casterActor: sourceActor, castRank });
                out.push({ label: `${condition.name} suppressed for ${span(op.setAside.duration)} (it returns afterwards, its own duration paused)`, status: "applied" });
                if (care.suppressNote && ["grabbed", "restrained"].includes(slug)) out.push({ label: `${actor.name} breaks free from the ${slug === "grabbed" ? "grab" : "restraint"}.`, status: "applied" });
                return out;
            }
            case "decrease-conditions": {
                for (const slug of op.slugs) out.push(await decreaseCondition(actor, slug, op.by, care.permanent?.[slug], choices));
                return out;
            }
            case "reduce-conditions": {
                const pattern = choices.conditions ?? {};
                const amounts = Object.values(pattern).filter(value => value > 0).sort((a, b) => b - a);
                if (!op.patterns.some(allowed => JSON.stringify([...allowed].sort((a, b) => b - a)) === JSON.stringify(amounts))
                    || Object.keys(pattern).some(slug => !op.from.includes(slug))) throw new Error(`${spell.name}: choose ${op.patterns.map(p => p.join(" + ")).join(" or ")} from ${op.from.join(", ")}.`);
                for (const [slug, by] of Object.entries(pattern)) out.push(await decreaseCondition(actor, slug, by, care.permanent?.[slug], choices));
                return out;
            }
            case "affliction-saves": {
                const limit = durationSeconds(op.maxStageLength);
                for (const affliction of handlerAfflictions(actor)) {
                    if (stageLengthSeconds(affliction.stageLength) > limit) { out.push({ label: `${affliction.name}: stage length over ${span(op.maxStageLength)}; no save`, status: "skipped" }); continue; }
                    out.push(await afflictionSave(actor, affliction, 0, spell));
                }
                if (!out.length) out.push({ label: "No afflictions to save against.", status: "skipped" });
                return out;
            }
            case "affliction-save": {
                const picked = pickAfflictions(actor, op, choices.afflictions, care.pickAny);
                const modifier = Number(choices.modifier);
                if (!op.modifierChoice.includes(modifier)) throw new Error(`${spell.name}: choose ${op.modifierChoice.map(v => (v > 0 ? `+${v}` : v)).join(" or ")}.`);
                for (const affliction of picked) out.push(await afflictionSave(actor, affliction, modifier, spell));
                return out;
            }
            case "reduce-affliction-stage": {
                for (const affliction of pickAfflictions(actor, op, choices.afflictions, false)) {
                    if (care.oncePerExposure && affliction.effect.getFlag(MODULE_ID, "lessenedBy")?.includes(spell.slug ?? spell.system.slug)) {
                        out.push({ label: `${affliction.name}: this exposure was already lessened by ${spell.name}`, status: "refused" }); continue;
                    }
                    const badge = nextAfflictionBadge(affliction, -op.by, op.floor);
                    await affliction.effect.update({ "system.badge.value": badge });
                    await affliction.effect.setFlag(MODULE_ID, "lessenedBy", [...(affliction.effect.getFlag(MODULE_ID, "lessenedBy") ?? []), spell.slug ?? spell.system.slug]);
                    out.push({ label: `${affliction.name}: stage ${affliction.stage} → ${afflictionStage(badge, affliction.onset)}`, status: "applied" });
                }
                return out;
            }
            case "persistent-damage": {
                const available = persistentPoison(actor);
                const picked = care.pickAny ? available.filter(condition => (choices.persistent ?? []).includes(condition.id)) : available.filter(condition => condition.id === choices.persistent?.[0]);
                if (!picked.length) return care.pickAny ? [] : [{ label: "No persistent poison damage chosen.", status: "skipped" }];
                const dc = Number(choices.flatDC);
                if (!op.flatCheckDCChoice.includes(dc)) throw new Error(`${spell.name}: choose a flat check DC of ${op.flatCheckDCChoice.join(" or ")}.`);
                for (const condition of picked) {
                    if (choices.damageNow) {
                        const damage = condition.system.persistent.damage.clone();
                        await damage.evaluate();
                        const receipt = await applyDamageWithReceipt(actor, { damage, token, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
                        out.push({ label: `${condition.name}: took ${receipt.damage} damage now`, status: "applied" });
                    }
                    const original = condition._source.system.persistent.dc;
                    await condition.update({ "system.persistent.dc": dc });
                    await condition.rollRecovery();
                    // A successful flat check ends the condition; PF2e may still be deleting it, so a missing one is fine.
                    let still = actor.items.get(condition.id);
                    if (still) try { await still.update({ "system.persistent.dc": original }); } catch { still = actor.items.get(condition.id); if (still) throw new Error(`${spell.name}: ${condition.name}'s flat check DC could not be restored.`); }
                    out.push({ label: `${condition.name}: flat check DC ${dc} — ${still ? "continues" : "ended"}`, status: "applied" });
                }
                return out;
            }
            case "damage": {
                // "Deal poison damage equal to the spell's rank to the target."
                const DamageRoll = CONFIG.Dice.rolls.find(type => type.name === "DamageRoll");
                const roll = new DamageRoll(`${castRank}[${op.damageType}]`);
                await roll.evaluate();
                const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, item: spell, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
                return [{ label: `${castRank} ${op.damageType} damage: took ${receipt.damage}`, status: "applied" }];
            }
            case "heal": {
                // The spell's own healing entry, rolled by PF2e at the cast rank.
                // One roll for every target ("restores 7d8 Hit Points to the targets").
                context.shared ??= {};
                if (!context.shared.heal) {
                    const prepared = await spell.getDamage({ skipDialog: true });
                    const healRoll = prepared?.template?.damage?.roll;
                    if (!healRoll) throw new Error(`${spell.name}: PF2e returned no healing roll.`);
                    await healRoll.evaluate();
                    context.shared.heal = { roll: healRoll, prepared };
                }
                const { roll, prepared } = context.shared.heal;
                const wasDying = isDying(actor);
                const receipt = await applyDamageWithReceipt(actor, { damage: -roll.total, token: token ?? undefined, item: spell, skipIWR: false, rollOptions: new Set(prepared.context?.options ?? []) }, foundry.utils.randomID());
                const revived = await recoverFromDying(actor, wasDying);
                return [{ label: `Regained ${receipt.healing} HP (${roll.formula} = ${roll.total})${revived ? `; ${revivedNote(revived)}` : ""}`, status: "applied" }];
            }
            case "ward": {
                // A standing ward: a marker Effect on the warded creature, tracked in Ongoing spells, whose control
                // counteracts what the GM names each time the ward is triggered.
                const ward = care.ward;
                if (!actor) throw new Error(`${spell.name}: target the creature to ward.`);
                const named = ward.named ? String(choices.wardSpell ?? "").trim() : null;
                if (ward.named && !named) throw new Error(`${spell.name}: name the spell to ward against.`);
                const castInstanceId = foundry.utils.randomID();
                const duration = ward.untilDailyPreparations ? { value: -1, unit: "unlimited", expiry: null, sustained: false }
                    : { value: ward.duration.value, unit: ward.duration.unit, expiry: null, sustained: false };
                const metadata = { schema: 1, kind: "counteract-ward", castInstanceId, sourceActorUuid: sourceActor.uuid, sourceItemUuid: spell.uuid, sourceItemName: spell.name,
                    ward: { ...ward, rank: castRank, named } };
                const lasts = ward.untilDailyPreparations ? `until ${sourceActor.name}'s next daily preparations` : span(ward.duration);
                const [effect] = await actor.createEmbeddedDocuments("Item", [{
                    name: `${spell.name}${named ? ` (${named})` : ""}`, type: "effect", img: spell.img,
                    flags: { [MODULE_ID]: { runtime: metadata } },
                    system: { level: { value: castRank }, duration, start: { value: game.time.worldTime, initiative: null }, fromSpell: true, rules: [],
                        context: { origin: { actor: sourceActor.uuid, item: spell.uuid }, target: { actor: actor.uuid, token: token?.uuid ?? null }, roll: null },
                        description: { value: `<p><strong>${esc(spell.name)}</strong> (rank ${esc(castRank)}): ${esc(ward.trigger)}${named ? ` Named spell: <strong>${esc(named)}</strong>.` : ""} Use “Counteract with ${esc(spell.name)}” in Ongoing spells each time.</p>${(ward.notes ?? []).map(note => `<p>${esc(note)}</p>`).join("")}` } }
                }]);
                if (this.ongoing) {
                    const journal = await this.ongoing.begin({ castId: castInstanceId, name: spell.name, kind: "native", sourceActorUuid: sourceActor.uuid, sourceItemUuid: spell.uuid, recipientUuids: [actor.uuid] });
                    await this.ongoing.attach(journal, effect);
                    await this.ongoing.activate(journal);
                }
                return [{ label: `${actor.name} is warded (${lasts})${named ? ` against ${named}` : ""}: ${ward.trigger}`, status: "applied" }];
            }
            case "lose-hp": {
                // "You lose 1d8 Hit Points per rank of the triggering spell." — Hit Points lost, not damage (no resistances).
                const rank = context.triggeringRank;
                if (!Number.isInteger(rank) || rank < 1) throw new Error(`${spell.name}: the triggering spell's rank is unknown.`);
                const DamageRoll = CONFIG.Dice.rolls.find(type => type.name === "DamageRoll");
                const roll = new DamageRoll(`${op.dice * rank}d${op.faces}`);
                await roll.evaluate();
                const caster = sourceActor, casterToken = caster.getActiveTokens?.(false, true)?.[0];
                const receipt = await applyDamageWithReceipt(caster, { damage: roll, token: casterToken ?? undefined, skipIWR: true, rollOptions: new Set() }, foundry.utils.randomID());
                return [{ label: `${caster.name} loses ${receipt.damage} Hit Points (${op.dice * rank}d${op.faces} = ${roll.total})`, status: "applied" }];
            }
            case "counteract": {
                // With several targets, each pick names its creature.
                const picked = (choices.counteracts?.[op.source ?? "effect"] ?? []).filter(entry => !entry.actorUuid || entry.actorUuid === actor?.uuid);
                const candidates = counteractCandidates(actor, op, choices, care);
                // Another target (an area or an item) is named by the GM.
                // An item or ward (source "other") or the triggering spell is never an Effect on a creature.
                if ((!actor || ["other", "triggering-spell"].includes(op.source)) && op.otherTargets) {
                    // The triggering spell, or an area, item or ward the GM names, with its rank (and DC unless automatic).
                    const other = choices.otherTarget;
                    const what = op.source === "triggering-spell" ? "the triggering spell" : "the area or item";
                    if (!other?.name) throw new Error(`${spell.name}: name ${what} to counteract.`);
                    if (other.artifact && care.artifactFails) return [{ label: `${other.name} is an artifact: the counteract automatically fails.`, status: "applied" }];
                    const { dc, rank } = other;
                    if (!Number.isInteger(rank) || (!op.automatic && !Number.isFinite(dc))) throw new Error(`${spell.name}: enter the counteract ${op.automatic ? "rank" : "DC and rank"} of ${other.name}.`);
                    // Elemental Counter: the spell slot lost must be of the element that counters the triggering spell's.
                    let lost = null;
                    if (op.rankFromLostSlot) {
                        lost = choices.lostSlot;
                        const counters = care.elementCycle?.[lost?.against] ?? [];
                        if (!lost || !Number.isInteger(lost.rank) || lost.rank < 1 || !counters.includes(lost.element))
                            throw new Error(`${spell.name}: lose a spell of ${counters.length ? counters.join(" or ") : "the countering element"} to counter ${lost?.against ?? "that element"}, and give its rank.`);
                        out.push({ label: `${sourceActor.name} loses a rank ${lost.rank} ${lost.element} spell slot (as if casting it).`, status: "manual" });
                    }
                    // "Treat shadow siphon's counteract rank as 2 higher for this attempt." / "using the rank of the spell you lost"
                    const counteractRank = (lost ? lost.rank : castRank) + (care.counteractRankBonus ?? 0);
                    let degree = 3, countered = true;
                    if (op.automatic) out.push({ label: `${other.name} (rank ${rank}) is automatically counteracted.`, status: "applied" });
                    else {
                        const roll = await counteractRoll(spell, dc);
                        degree = roll.degreeOfSuccess;
                        countered = counteracts(degree, counteractRank, rank);
                        out.push({ label: `Counteract check vs DC ${dc}: ${DEGREES[degree]} (rank ${counteractRank}${care.counteractRankBonus ? ` including +${care.counteractRankBonus}` : ""} vs ${rank})`, status: "rolled" });
                    }
                    // Keep the triggering spell's rank for "per rank of the triggering spell".
                    context.triggeringRank = rank;
                    if (!countered) { out.push({ label: `${other.name} is not counteracted${op.source === "triggering-spell" ? "; it takes effect as normal" : ""}.`, status: "applied" }); return out; }
                    const outcome = care.counteractOutcome ?? {};
                    // Detonate Magic: the item rule for an item, the spell rule for a spell; then the explosion.
                    if (care.explosion) {
                        const itemText = (degree === 3 && outcome.criticalSuccess) || outcome.success;
                        out.push({ label: `${other.name} is counteracted: ${other.kind === "item" && itemText ? itemText.charAt(0).toLowerCase() + itemText.slice(1) : care.explosionNote ?? "it ends."}`, status: "manual" });
                        out.push(...await this.#explode(spell, sourceActor, castRank, care, choices));
                        return out;
                    }
                    const text = (degree === 3 && outcome.criticalSuccess) || outcome.success
                        || (other.kind === "item" && care.magicItem ? `it becomes a mundane item of its type for ${span(care.magicItem)} (its non-magical properties are unchanged).`
                            : op.source === "triggering-spell" ? "it has no effect." : "end it.");
                    out.push({ label: `${other.name} is counteracted: ${text.charAt(0).toLowerCase()}${text.slice(1)}`, status: "manual" });
                    if (care.restoreSlot) out.push({ label: `${sourceActor.name} restores one expended spell slot of rank ${care.restoreSlot} or lower.`, status: "manual" });
                    return out;
                }
                if (!candidates.length) return [{ label: `Nothing on ${actor?.name ?? "the target"} for ${spell.name} to counteract.`, status: "skipped" }];
                // The chosen affliction's DC and rank rows cover every eligible affliction; only the chosen one is used.
                const chosen = picked.map(entry => ({ ...entry, candidate: candidates.find(candidate => candidate.id === entry.id) }))
                    .filter(entry => op.source !== "chosen-affliction" || entry.candidate);
                // pick 1: exactly one; pick N: one to N ("an additional affliction" per rank); any: at least one.
                if (chosen.some(entry => !entry.candidate) || (op.pick === 1 ? chosen.length !== 1 : !chosen.length || (Number.isInteger(op.pick) && chosen.length > op.pick))) {
                    if (op.source === "chosen-affliction" && !chosen.length) return [{ label: "The chosen affliction can't be counteracted at this rank.", status: "skipped" }];
                    throw new Error(`${spell.name}: choose ${op.pick === 1 ? "one" : Number.isInteger(op.pick) ? `one to ${op.pick}` : "at least one"} eligible ${op.source === "affliction" || op.source === "chosen-affliction" ? "affliction" : "effect"} to counteract.`);
                }
                // Cleansing Flames: the target may take Drained 1 (or +1) for a +1 circumstance bonus to the check.
                const modifiers = [];
                if (care.empower && choices.empower) {
                    await actor.increaseCondition(care.empower.condition);
                    modifiers.push(new game.pf2e.Modifier({ slug: "care-empower", label: `${spell.name}: empowered`, modifier: care.empower.bonus, type: care.empower.type }));
                    out.push({ label: `${actor.name} becomes ${care.empower.condition} ${actor.getCondition(care.empower.condition)?.value ?? ""} to grant +${care.empower.bonus} ${care.empower.type}`, status: "applied" });
                }
                for (const { candidate, dc, rank } of chosen) {
                    if (!Number.isFinite(dc) || !Number.isInteger(rank)) throw new Error(`${spell.name}: enter the counteract DC and rank of ${candidate.name}.`);
                    const roll = await counteractRoll(spell, dc, modifiers, { secret: op.secret === true });
                    const countered = counteracts(roll.degreeOfSuccess, castRank, rank);
                    out.push({ label: `${candidate.name}: counteract check vs DC ${dc}: ${DEGREES[roll.degreeOfSuccess]} (rank ${castRank} vs ${rank})`, status: "rolled" });
                    const outcome = care.counteractOutcome ?? {};
                    if (countered && op.setAside) {
                        // "suspending its effects for 1 hour on a success rather than removing it" / "suppress the illusion for the duration"
                        await setAsideEffect(candidate.document, { setAside: op.setAside, spellName: spell.name, casterActor: sourceActor, castRank });
                        out.push({ label: `${candidate.name} ${op.setAside.mode === "suspend" ? "suspended" : "suppressed"} for ${span(op.setAside.duration)} (it returns afterwards)`, status: "applied" });
                        continue;
                    }
                    if (countered && op.siphon) {
                        const { copy, rounds } = await siphonEffect(candidate.document, sourceActor, spell);
                        out.push({ label: `${candidate.name} siphoned: ${sourceActor.name} gains it too (${copy.name}); both last ${rounds} more round${rounds === 1 ? "" : "s"}`, status: "applied" });
                        continue;
                    }
                    if (countered) {
                        await candidate.document.delete();
                        out.push({ label: `${candidate.name} counteracted${candidate.affliction ? " (cured)" : ""}`, status: "applied" });
                        // Detonate Magic against a spell effect on a creature: the effect ends, then the explosion.
                        if (care.explosion) { if (care.explosionNote) out.push({ label: care.explosionNote, status: "manual" }); out.push(...await this.#explode(spell, sourceActor, castRank, care, choices)); continue; }
                        if (outcome.success) out.push({ label: outcome.success, status: "manual" });
                        continue;
                    }
                    // "If you didn't counteract the effect, but you would have if its counteract rank were 2 lower, instead suppress it …"
                    const nearMiss = care.nearMiss;
                    if (nearMiss && counteracts(roll.degreeOfSuccess, castRank, rank - nearMiss.ranks)) {
                        await setAsideEffect(candidate.document, { setAside: nearMiss.setAside, spellName: spell.name, casterActor: sourceActor, castRank });
                        out.push({ label: `${candidate.name} suppressed until the start of ${sourceActor.name}'s next turn (its duration paused)`, status: "applied" });
                        continue;
                    }
                    if (outcome.failure) out.push({ label: outcome.failure, status: "manual" });
                    const bonus = care.counteractFailure;
                    if (!bonus) { out.push({ label: `${candidate.name} not counteracted`, status: "applied" }); continue; }
                    const effect = candidate.document;
                    const origin = effect.system.context?.origin?.item ? await fromUuid(effect.system.context.origin.item) : null;
                    const slugs = [effect.slug, origin?.slug].filter(Boolean);
                    const [created] = await actor.createEmbeddedDocuments("Item", [{
                        name: `${spell.name}: resonance against ${effect.name}`, type: "effect", img: "icons/svg/aura.svg",
                        flags: { [MODULE_ID]: { careResonance: effect.id } },
                        system: { duration: { value: bonus.duration.value, unit: bonus.duration.unit, expiry: "turn-start", sustained: false },
                            rules: [{ key: "FlatModifier", selector: `${bonus.statistic}`, type: bonus.type, value: bonus.bonus,
                                label: `${spell.name}: shrug off ${effect.name}`, predicate: [{ or: slugs.map(slug => `item:slug:${slug}`) }] }],
                            description: { value: `<p>+${bonus.bonus} status bonus to ${esc(bonus.statistic)} saves to shrug off <strong>${esc(effect.name)}</strong>.</p>` },
                            context: { origin: { actor: sourceActor.uuid, item: spell.uuid }, target: { actor: actor.uuid, token: token?.uuid ?? null }, roll: null } }
                    }]);
                    out.push({ label: `${effect.name} not counteracted; ${created.name} (+${bonus.bonus} for ${span(bonus.duration)})`, status: "applied" });
                }
                return out;
            }
        }
        throw new Error(`Unknown affliction-care operation ${op.op}.`);
    }

    async #ask(spell, care, actor, actors = null) {
        const afflictions = actor ? handlerAfflictions(actor) : [], persistent = actor ? persistentPoison(actor) : [];
        const counteractOps = [...care.operations, ...care.modes.flatMap(mode => mode.operations)].filter(op => op.op === "counteract");
        const options = (list, value, label) => list.map(entry => `<option value="${esc(value(entry))}">${esc(label(entry))}</option>`).join("");
        const conditionInputs = [...new Set(care.modes.flatMap(mode => mode.operations).filter(op => op.op === "reduce-conditions").flatMap(op => op.from))]
            .map(slug => `<label>${esc(slug)} (has ${esc(actor?.getCondition?.(slug)?.value ?? 0)}) <input type="number" name="cond-${slug}" min="0" max="2" value="0"></label>`).join("");
        const suppressFrom = [...new Set([...care.operations, ...care.modes.flatMap(mode => mode.operations)].filter(op => op.op === "suppress-condition").flatMap(op => op.from))];
        const content = `<form class="pf2e-auto-care">
            <p><strong>${esc(actors ? actors.map(each => each.name).join(", ") : actor?.name ?? (care.recipient === "triggering-spell" ? "The triggering spell" : "No creature targeted"))}</strong>: ${!actor ? (care.recipient === "triggering-spell" ? "name it and give its rank below" : "counteract what you name below") : handlerActive() ? afflictions.map(a => `${esc(a.name)} stage ${a.stage}${a.inOnset ? " (onset)" : ""}`).join("; ") || "no tracked afflictions" : "afflictions aren't tracked (Pseudo Afflictions is unavailable); affliction steps become instructions on the result card"}.</p>
            ${care.unwillingSave ? `<label><input type="checkbox" name="unwilling"> Target is unwilling (it attempts a ${esc(care.unwillingSave.statistic)} save to negate)</label>` : ""}
            ${care.modes.length && !(care.pickAny && care.progressTargets) ? `<label>Mode <select name="mode">${options(care.modes, m => m.id, m => m.label)}</select></label>` : ""}
            ${afflictions.length ? `<label>Affliction <select name="afflictions" ${care.pickAny ? "multiple" : ""}>${options(afflictions, a => a.id, a => `${a.name} (stage ${a.stage})`)}</select></label>` : ""}
            ${care.modes.some(mode => mode.operations.some(op => op.modifierChoice)) ? `<label>Save modifier <select name="modifier"><option value="2">+2 status (help)</option><option value="-2">−2 status (hinder)</option></select></label>` : ""}
            ${conditionInputs ? `<fieldset><legend>Reduce conditions</legend>${conditionInputs}</fieldset>` : ""}
            ${suppressFrom.length ? `<label>Condition to suppress <select name="suppress">${suppressFrom.map(slug => `<option value="${esc(slug)}" ${actor?.hasCondition?.(slug) ? "" : "disabled"}>${esc(slug)}${actor?.hasCondition?.(slug) ? "" : " (not affected)"}</option>`).join("")}</select></label>` : ""}
            ${Object.entries(care.permanent ?? {}).map(([slug, rule]) => `<label><input type="checkbox" name="permanent-${slug}"> This ${esc(slug)} is permanent</label>${rule.allowed ? `<label><input type="checkbox" name="paid-${slug}"> Cost paid (${esc(rule.cost)}, extra action)</label>` : ""}`).join("")}
            ${persistent.length ? `<label>Persistent poison <select name="persistent" ${care.pickAny ? "multiple" : ""}>${options(persistent, c => c.id, c => c.name)}</select></label>
                <label><input type="checkbox" name="damageNow"> Take the damage now</label><label>Flat check DC <select name="flatDC"><option>5</option><option>20</option></select></label>` : ""}
            ${actors ? actors.map(each => counteractOps.map(op => counteractFieldset(each, op, care, each.name)).join("")).join("")
                : counteractOps.map(op => counteractFieldset(actor, op, care)).join("")}
            ${care.ward?.named ? `<label>The spell to ward against <input type="text" name="wardSpell"></label>` : ""}
            ${care.empower ? `<label><input type="checkbox" name="empower"> The target chooses to become ${esc(care.empower.condition)} 1 (or +1) for a +${esc(care.empower.bonus)} ${esc(care.empower.type)} bonus to the counteract check</label>` : ""}
        </form>`;
        return await foundry.applications.api.DialogV2.wait({ window: { title: `${spell.name} — caster choices` }, content, rejectClose: false,
            buttons: [{ action: "apply", label: "Apply", default: true, callback: (_event, button) => {
                const form = button.form, data = new FormData(form);
                const multi = name => [...(form.elements[name]?.selectedOptions ?? [])].map(option => option.value);
                const conditions = Object.fromEntries([...data.keys()].filter(key => key.startsWith("cond-")).map(key => [key.slice(5), Number(data.get(key))]).filter(([, value]) => value > 0));
                return { unwilling: data.has("unwilling"), mode: data.get("mode"), afflictions: multi("afflictions"), modifier: Number(data.get("modifier")),
                    conditions, persistent: multi("persistent"), damageNow: data.has("damageNow"), flatDC: Number(data.get("flatDC")),
                    permanent: Object.fromEntries(Object.keys(care.permanent ?? {}).map(slug => [slug, { permanent: data.has(`permanent-${slug}`), paid: data.has(`paid-${slug}`) }])),
                    empower: data.has("empower"), wardSpell: data.get("wardSpell"), suppress: data.get("suppress"),
                    lostSlot: data.has("lostRank") ? { against: data.get("lostAgainst"), element: data.get("lostElement"), rank: Number(data.get("lostRank")) } : null,
                    counteracts: Object.fromEntries(counteractOps.map(op => [op.source ?? "effect", [...form.querySelectorAll(`[data-counteract="${op.source ?? "effect"}"]`)]
                        .filter(row => op.source === "chosen-affliction" || row.querySelector("input[name^=pick]")?.checked).map(row => ({ id: row.dataset.id, ...(row.dataset.actor ? { actorUuid: row.dataset.actor } : {}),
                            dc: Number(row.querySelector("input[name^=dc]").value), rank: Number(row.querySelector("input[name^=rank]").value) }))])),
                    otherTarget: counteractOps.some(op => op.otherTargets && (!actor || ["other", "triggering-spell"].includes(op.source))) ? { name: String(data.get("otherName") ?? "").trim(), kind: data.get("otherKind"),
                        dc: Number(data.get("otherDC")), rank: Number(data.get("otherRank")), artifact: data.has("otherArtifact") } : null };
            } }, { action: "cancel", label: "Cancel" }] }).then(result => result === "cancel" ? null : result);
    }

    async #report(spell, actor, castRank, results, actors = null) {
        const content = `<section class="pf2e-auto-runtime-card"><header><strong>${esc(spell.name)}${actor ? ` — ${esc(actor.name)}` : actors ? ` — ${esc(actors.map(each => each.name).join(", "))}` : ""}</strong></header>
            <p>Cast at rank ${esc(castRank)}.</p><ul>${results.map(result => `<li>${result.status === "manual" ? "<strong>GM to apply:</strong> " : result.status === "note" ? "<strong>Caster:</strong> " : ""}${esc(result.label)}</li>`).join("")}</ul></section>`;
        // A secret check's outcome stays with the GM.
        const secret = this.#secret;
        const message = await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor: spell.actor }), ...(secret ? { whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id) } : {}),
            flags: { [MODULE_ID]: { afflictionCare: { spell: spell.uuid, actor: actor?.uuid ?? null, results } } } });
        return { status: "completed", results, message };
    }
}

/** One row per candidate: pick it, and confirm its counteract DC and rank (suggested from the effect or affliction). */
function counteractFieldset(actor, op, care, forName = null) {
    const source = op.source ?? "effect";
    const what = source === "spell-effect" ? "spell effect" : source.includes("affliction") ? (op.anyAffliction ? "affliction" : `${op.traits.join(" or ")} affliction`) : `effect (${[...op.traits, ...op.grantsConditions].join(", ")})`;
    if ((!actor || ["other", "triggering-spell"].includes(source)) && op.otherTargets) {
        const kinds = source === "triggering-spell" ? ["spell"] : care.otherKinds ?? ["spell", "item"];
        // Elemental Counter: the triggering spell's element, and the spell (slot) you lose to counter it.
        const cycle = op.rankFromLostSlot ? care.elementCycle ?? {} : null;
        const elements = cycle ? [...new Set([...Object.keys(cycle), ...Object.values(cycle).flat()])] : [];
        const lostFields = cycle ? `<label>The triggering spell's element <select name="lostAgainst">${Object.keys(cycle).map(element => `<option>${esc(element)}</option>`).join("")}</select></label>
            <label>The spell you lose: element <select name="lostElement">${elements.map(element => `<option>${esc(element)}</option>`).join("")}</select></label>
            <label>Its rank (the counteract rank) <input type="number" name="lostRank"></label>` : "";
        const legend = source === "triggering-spell" ? "The triggering spell" : kinds.length === 2 ? "Counteract an area or item" : kinds[0] === "item" ? "The magic item" : "The warding spell or effect";
        return `<fieldset><legend>${legend}</legend>
        <label>Name <input type="text" name="otherName"></label>
        ${kinds.length === 2 ? `<label>Kind <select name="otherKind"><option value="spell">Spell or area</option><option value="item">Magic item</option></select></label>` : `<input type="hidden" name="otherKind" value="${kinds[0]}">`}
        ${op.automatic ? "" : `<label>Its counteract DC${source === "triggering-spell" ? " (its caster's spell DC)" : ""} <input type="number" name="otherDC"></label>`}
        <label>Its ${source === "triggering-spell" ? "rank" : "counteract rank"} <input type="number" name="otherRank"></label>
        ${care.artifactFails ? `<label><input type="checkbox" name="otherArtifact"> It's an artifact (automatically fails)</label>` : ""}${lostFields}</fieldset>`;
    }
    // The chosen affliction's rows: the affliction picked above, if it has one of these traits.
    const candidates = counteractCandidates(actor, source === "chosen-affliction" ? { ...op, source: "affliction" } : op, {}, care);
    const input = op.pick === 1 ? "radio" : "checkbox";
    return `<fieldset><legend>${forName ? `${esc(forName)}: ` : ""}Counteract ${op.pick === 1 ? "one" : Number.isInteger(op.pick) ? `up to ${op.pick}` : "any number of"} ${esc(what)}${source === "chosen-affliction" ? " (the one chosen above, if eligible)" : ""}</legend>
        ${candidates.length ? candidates.map(candidate => `<div data-counteract="${source}" data-id="${esc(candidate.id)}"${forName ? ` data-actor="${esc(actor.uuid)}"` : ""}>
            <label>${source === "chosen-affliction" ? "" : `<input type="${input}" name="pick-${source}${forName ? `-${esc(actor.id)}` : ""}"> `}${esc(candidate.name)}</label>
            <label>Its counteract DC <input type="number" name="dc-${source}-${esc(candidate.id)}" value="${esc(candidate.dc ?? "")}"></label>
            <label>Its counteract rank <input type="number" name="rank-${source}-${esc(candidate.id)}" value="${esc(candidate.rank ?? "")}"></label><hr></div>`).join("") : "<p>None found.</p>"}</fieldset>`;
}

function pickAfflictions(actor, op, ids = [], any = false) {
    const eligible = handlerAfflictions(actor).filter(affliction => op.traits.some(trait => affliction.traits.includes(trait)));
    const picked = eligible.filter(affliction => (ids ?? []).includes(affliction.id));
    if (!picked.length || (!any && picked.length !== 1)) throw new Error(`Choose ${any ? "at least one" : "one"} eligible affliction (${op.traits.join(" or ")}).`);
    return picked;
}

/** A PF2e affliction save against the handler's Effect, then the stage change. */
async function afflictionSave(actor, affliction, modifier, spell) {
    if (affliction.inOnset) return { label: `${affliction.name}: still in onset; no save`, status: "skipped" };
    if (!affliction.save?.type || !Number.isFinite(Number(affliction.save.value))) return { label: `${affliction.name}: no save data; resolve manually`, status: "manual" };
    const modifiers = modifier ? [new game.pf2e.Modifier({ label: spell.name, modifier, type: "status" })] : [];
    const roll = await actor.saves[affliction.save.type].roll({ dc: { value: Number(affliction.save.value) }, item: affliction.effect, skipDialog: true, modifiers });
    const virulent = affliction.traits.includes("virulent");
    const delta = afflictionStageDelta(roll.degreeOfSuccess, virulent);
    const badge = nextAfflictionBadge(affliction, delta);
    if (badge == null) await affliction.effect.delete();
    else if (badge !== affliction.badge) await affliction.effect.update({ "system.badge.value": badge });
    const outcome = badge == null ? "cured" : `stage ${affliction.stage} → ${afflictionStage(badge, affliction.onset)}`;
    return { label: `${affliction.name}: ${DEGREES[roll.degreeOfSuccess]}${modifier ? ` (${modifier > 0 ? "+" : ""}${modifier})` : ""} — ${outcome}${virulent && roll.degreeOfSuccess === 2 ? " (virulent: needs a second consecutive success)" : ""}`, status: "applied" };
}

async function decreaseCondition(actor, slug, by, permanentRule, choices) {
    const current = actor.getCondition?.(slug);
    if (!current) return { label: `${slug}: not present`, status: "skipped" };
    const permanent = choices.permanent?.[slug];
    if (permanentRule && permanent?.permanent && !(permanentRule.allowed && permanent.paid)) return { label: `${slug}: permanent; can't be reduced${permanentRule.allowed ? " without the cost" : ""}`, status: "refused" };
    const before = current.value ?? 0;
    for (let step = 0; step < by && actor.getCondition?.(slug); step++) await actor.decreaseCondition(slug);
    const after = actor.getCondition?.(slug)?.value ?? 0;
    return { label: `${slug} ${before} → ${after}${after === before ? " (locked by another effect)" : ""}`, status: after < before ? "applied" : "refused" };
}
