import { assertSpellNotLost, dropMissedTargets } from "./casting-rules-runtime.js";
import { markWardTrigger } from "./mark-ward-runtime.js";
import { strikeDeliveryFor, deliveredStrikeMessage } from "./spell-actions-runtime.js";
import {loadNativeEffectTemplate, prepareNativeOutcomeEffectSource, prepareNativeEffectSource, createNativeEffect} from './native-outcome-effects.js';
import {generatedSpeedLabel, inspectGeneratedSpeedProof, prepareGeneratedSpeedEffectSource} from './generated-outcome-modifier.js';
import {composeInlinePersistentDamageRoll, selectComponentDamageRoll} from './component-damage.js';
import { applyDamageWithReceipt, confirmedDamageSummary } from "./native-damage-receipt.js";
import { prepareConditionGrantSource, prepareNoteEffectSource, prepareSpellNoteEffectSource } from "./note-effects.js";
import { revealInformation } from "./reveal-runtime.js";
import { grantMinionControl } from "./minion-control-runtime.js";
import { spellNoteText } from "../src/compiler/spell-note.js";
import { proveCasterMark } from "../src/compiler/caster-mark.js";
import { isDying, recoverFromDying, revivedNote } from "./dying-recovery.js";
import { recipientMatchesProof, inspectCasterBenefitClaim, sameEffectMechanics } from "./effect-modifier-proof.js";
import { proveAllyEffect, proveAllyTempHP } from "../src/compiler/ally-enemy-split.js";
import { proveBolsterEffect } from "../src/compiler/bolster-split.js";
import { proveStrikeMark } from "../src/compiler/attack-mark.js";
import { heightenedDurationAt } from "../src/compiler/heightened-duration-compiler.js";
import { hasPersistentDamage } from "./persistent-link-runtime.js";
import { startImpossibleMarks } from "./impossible-runtime.js";
import { splashParts, splashDamageRoll } from "./splash-damage.js";
import { reminderHTML, strikeRiderSource, findStrikeMessage } from "./strike-prelude-runtime.js";
import { forcedMove, forcedElevation, moveToFreeSpace } from "./forced-movement.js";
import { textSpellDamage } from "./text-spell-damage.js";
import { catalystOrigins, swapAfflictionConditions } from "./catalyst-runtime.js";
import { shapeRidersFor, applyShapeRiders, finishShapeRiders, shapeSpellFacts, shapeTypeSwapFor, shapeSplitFor, shapeDualFor, shapeCoverReduceFor, powerRingBonus, shapeMaterialFor, shapeResistanceLowersFor, assignShapeTargets, shapedCastRank, mythicDC, shapeWatchSave, shapeRerollOnesFor, attackDefenseFor } from "./spellshape-runtime.js";
import { heightenedPlanAt, gmQuestionGates, gateAnswerFor, isPrimaryDeath, isCasterConditionEnd, isCasterConditionOnly, isCasterConditionTimed } from "./basic-save-core.js";
import { killEffectMatches } from "../src/compiler/kill-effect.js";
import { casterRowEffectMatches } from "../src/compiler/caster-row-effect.js";
import { counteracts } from "./affliction-care-core.js";
import { tokenDistance } from "./token-distance.js";
import { nativeConditionTiming } from './condition-timing.js';
import { MODULE_ID, freeSpaceNear } from "./effect-runtime.js";
import { lastDamageOf } from "./climb-aid-runtime.js";
import {
    damageMultiplierForTarget,
    damageSwapApplies,
    swapDamageType,
    bloodlineDamageType,
    bloodlineRollMatches,
    executableConditionLinks,
    isEscapeLifetime,
    isActionEndLifetime,
    isRecurringSaveLifetime,
    isPostDamageDeath,
    isTimedStunned,
    isAfflictionHandoffPlan,
    isSharedDamageGate,
    isConditionFloor,
    degreeAdjustmentFor,
    correctSaveTarget,
    targetOutcomeConditions,
    targetOutcomeNotes,
    targetParticipates,
    synchronizeSecondary,
    basicSaveReadiness,
    saveCollectionReadiness,
    checkRollSkipDialog,
    isExecutableDegreeSavePlan,
    isExecutableSavePlan,
    normalizeSaveDegree,
    outcomeDamageRollIds,
    outcomeForTarget,
    readableSaveDegree,
    recordProvisionalSave,
    recordSecondarySave,
    requiredOutcomeDamageRolls,
    secondaryOutcomeForTarget,
    secondarySaveForTarget,
    sharedDamageRequired,
    SAVE_DEGREES,
    validateActorTarget,
    actorAlliance,
    isSustainedConditionPlan,
    sustainedMaximumSeconds,
    isSpellLifetime,
    isLeaveAreaLifetime,
    isAreaLifetime,
    isNextAttackLifetime,
    isRestLifetime,
    isPersistentLinkedLifetime,
    healingTargets,
    dualEnergyMode,
    splashTargets,
    followUpExposurePlan,
    sustainStrikePlan
} from "./basic-save-core.js";
import {
    activeUsers,
    actorFromTarget,
    clone,
    confirmAction,
    escapeHTML,
    randomID,
    terrainDifficulties
} from "./runtime-utils.js";
import { debugError, debugLog } from "./debug.js";
import { destroyThrall, isThrall } from "./thrall-tokens.js";
import { castSpellFromUuid, rememberCastSpell, spellFromSource } from './cast-spell.js';
import { CASTER_SAVE_ACTIONS } from './chat-card-controls.js';
import { postControlsCard, copyCreature } from './incarnate-parts-runtime.js';
import { startFollowingAura } from './form-aura-runtime.js';
import { AFFLICTION_HANDLER, tempHPSourceId } from "./runtime-utils.js";
import { stageCreatureFlag } from "./curse-creature.js";

const SAVE_SCHEMA = 9;
const SAVE_OPTION_PREFIX = "pf2e-auto-basic-save";

/** Which targeted token is the caster's thrall: asked when there's more than one candidate. */
async function chooseThrall(spellName, inputs) {
    const tokens = inputs.map(tokenDocumentFromTarget).filter(Boolean);
    if (tokens.length <= 1) return tokens[0] ?? null;
    return await foundry.applications.api.DialogV2.prompt({ window: { title: `${spellName} — Thrall` },
        content: `<p>Which targeted token is your thrall?</p><select name="thrall">${tokens.map(token => `<option value="${token.uuid}">${foundry.utils.escapeHTML(token.name)}</option>`).join("")}</select>`,
        ok: { label: "Cast through it", callback: (_event, button) => tokens.find(token => token.uuid === button.form.elements.thrall.value) }, rejectClose: false }) ?? null;
}

function tokenDocumentFromTarget(target) {
    if (!target || target.documentName === "Actor") return null;
    if (target.document?.documentName === "Token") return target.document;
    return target.documentName === "Token" ? target : null;
}

function tokenUuidFromSyntheticActorUuid(actorUuid) {
    return String(actorUuid ?? "").match(/^(Scene\.[^.]+\.Token\.[^.]+)(?:\.Actor\.[^.]+)?$/)?.[1] ?? null;
}

async function resolveTargetDocuments(target) {
    const tokenUuid = target.tokenUuid ?? tokenUuidFromSyntheticActorUuid(target.actorUuid);
    const resolvedToken = tokenUuid ? await fromUuid(tokenUuid) : null;
    let token = tokenDocumentFromTarget(resolvedToken) ?? resolvedToken;
    const actor = token?.actor ?? await fromUuid(target.actorUuid);
    // Actor-only callers need a real, unambiguous token for PF2e damage chat.
    // Never substitute another token when a persisted token has disappeared.
    if (!tokenUuid && !token) {
        const activeTokens = actor?.getActiveTokens?.(false, true) ?? [];
        if (activeTokens.length === 1) token = tokenDocumentFromTarget(activeTokens[0]);
    }
    return { actor, token };
}

/** Marks secondary targets: one eligible primary, and up to `max` creatures eligible once the waived predicate is set aside. */
function markSecondaryTargets(targets, constraints, secondary) {
    const primaries = targets.filter(target => target.eligible);
    if (primaries.length !== 1) return;
    const waived = { ...constraints, predicates: (constraints.predicates ?? []).filter(predicate => !(predicate.kind === secondary.waived.kind && predicate.damageType === secondary.waived.damageType)) };
    let count = 0;
    for (const target of targets) {
        if (target.eligible || count >= secondary.max) continue;
        const actor = globalThis.fromUuidSync?.(target.actorUuid);
        if (!actor || !validateActorTarget(waived, actor).eligible) continue;
        count += 1;
        Object.assign(target, { eligible: true, eligibilityReason: null, applicationStatus: "pending",
            secondaryOf: { actorUuid: primaries[0].actorUuid, name: primaries[0].name }, confirmation: { question: secondary.question, status: "pending" } });
    }
}

function assertPersistedTargetIdentity(target, actor) {
    if (actor && actor.uuid !== target.actorUuid) {
        throw new Error(`${target.name}: the persisted token now resolves to a different actor. Results were not applied.`);
    }
}

function snapshotTargets(targets, constraints, degreeAdjustment = null, dualMode = null, allyCaster = null, traitGrant = null) {
    const records = new Map();
    for (const target of Array.isArray(targets) ? targets : [...(targets ?? [])]) {
        const actor = actorFromTarget(target);
        if (!actor || records.has(actor.uuid)) continue;
        const token = tokenDocumentFromTarget(target);
        let eligibility = validateActorTarget(constraints, actor);
        // Heal-or-harm: the creature decides whether it's healed or harmed (or unaffected).
        let mode = dualMode ? dualEnergyMode(dualMode, actor) : null;
        if (mode === "unaffected" && eligibility.eligible) eligibility = { eligible: false, reason: `not affected by ${dualMode.energy} energy` };
        // Allies of the caster in an ally/enemy area: healed, with the spell's Effect, and no save.
        if (allyCaster && actor.uuid !== allyCaster.uuid && typeof allyCaster.isAllyOf === "function" && allyCaster.isAllyOf(actor)) {
            mode = "ally"; eligibility = { eligible: true, reason: null };
        }
        // Creatures of the trait (Deathless March's undead): the condition, no save.
        if (traitGrant && (actor.traits?.has?.(traitGrant.trait) ?? (actor.system?.traits?.value ?? []).includes(traitGrant.trait))) {
            mode = "trait-grant"; eligibility = { eligible: true, reason: null };
        }
        records.set(actor.uuid, {
            ...(mode && mode !== "unaffected" ? { mode } : {}),
            id: randomID(),
            actorUuid: actor.uuid,
            tokenUuid: token?.uuid ?? null,
            name: actor.name,
            level: Number(actor.level ?? actor.system?.details?.level?.value ?? 0),
            // (Its traits, for a row's note on a creature with a trait: Silver Spear's tether on a fiend.)
            traits: [...(actor.traits ?? actor.system?.traits?.value ?? [])].filter(trait => typeof trait === "string"),
            excluded: false,
            revision: 0,
            originalEligibility: clone(eligibility),
            eligibilityOverride: null,
            eligible: eligibility.eligible,
            eligibilityReason: eligibility.reason,
            confirmation: eligibility.confirmation && eligibility.eligible ? { question: eligibility.confirmation, status: "pending" } : null,
            degreeAdjustment: degreeAdjustmentFor(degreeAdjustment, actor),
            degree: null,
            saveMessageId: null,
            saveTimestamp: 0,
            rollRevision: 0,
            reroll: false,
            saveTotal: null,
            saveNatural: null,
            saveModifier: null,
            lastSubmissionId: null,
            secondary: null,
            supportsHeroPoints: typeof actor.isOfType === "function"
                ? actor.isOfType("character")
                : actor.type === "character",
            applicationStatus: eligibility.eligible ? "pending" : "unaffected",
            hpBefore: null,
            hpAfter: null,
            damageResults: [],
            effectUuids: [],
            conditionResults: [],
            terminalResult: null,
            terminalApplied: false,
            reviewRequired: false
        });
    }
    return [...records.values()];
}

function normalizeDC(value) {
    const dc = Number(value);
    return Number.isFinite(dc) && dc > 0 ? dc : null;
}

function spellDC(spell, actor) {
    const candidates = [
        spell?.spellcasting?.statistic?.dc?.value,
        spell?.spellcasting?.statistic?.dc,
        spell?.spellcasting?.dc?.value,
        actor?.getStatistic?.("spell-dc")?.dc?.value,
        actor?.system?.attributes?.spellDC?.value,
        actor?.system?.attributes?.classOrSpellDC?.value
    ];
    return candidates.map(normalizeDC).find(Boolean) ?? null;
}

/** The spell at the cast rank, with the PF2e variant (overlays) it was cast as, if any. */
function resolveSpellAtRank(spell, castRank, overlayIds = [], { force = false } = {}) {
    const overlays = Array.isArray(overlayIds) ? overlayIds.filter(id => typeof id === "string") : [];
    // (PF2e applies fixed-level heightening data — Dehydrate's 4d6 at 3rd — only when it loads the rank: a stored spell already at the cast
    // rank still needs loading.)
    const fixedLevels = spell?.system?.heightening?.type === "fixed" && Object.keys(spell.system.heightening.levels ?? {}).some(rank => Number(rank) <= Number(castRank));
    if (typeof spell?.loadVariant !== "function" || (!force && !fixedLevels && Number(spell.rank) === Number(castRank) && !overlays.length)) return spell;
    try { return spell.loadVariant({ castRank, ...(overlays.length ? { overlayIds: overlays } : {}) }) ?? spell; }
    catch (error) {
        console.warn(`${MODULE_ID} | Could not load the rank-${castRank} variant of ${spell?.name}.`, error);
        return spell;
    }
}

function degreeFromMessage(message) {
    const pf2e = message.flags?.pf2e ?? {};
    const roll = message.rolls?.[0];
    for (const candidate of [
        pf2e.context?.outcome,
        pf2e.context?.degreeOfSuccess,
        pf2e.context?.degree,
        pf2e.outcome,
        pf2e.degreeOfSuccess,
        roll?.degreeOfSuccess,
        roll?.options?.degreeOfSuccess,
        message.system?.degreeOfSuccess
    ]) {
        const degree = normalizeSaveDegree(candidate);
        if (degree) return degree;
    }
    return null;
}

function isRerollMessage(message) {
    const context = message.flags?.pf2e?.context ?? {};
    const options = Array.isArray(context.options) ? context.options : [];
    return context.isReroll === true
        || options.includes("check:reroll")
        || options.includes("check:reroll:hero-points");
}

function saveReference(message) {
    const options = message.flags?.pf2e?.context?.options ?? [];
    for (const option of Array.isArray(options) ? options : []) {
        const match = String(option).match(new RegExp(`^${SAVE_OPTION_PREFIX}:([^:]+):([^:]+)$`));
        if (match) return { castId: match[1], targetId: match[2] };
    }
    return null;
}

function messageActor(message) {
    try { if (message.actor) return message.actor; } catch (_) {}
    const actorId = message.speaker?.actor;
    return actorId ? game.actors.get(actorId) ?? null : null;
}

function isCardCoordinator(card) {
    const users = activeUsers();
    if (typeof card?.getFlag?.(MODULE_ID, "ongoingCastId") === "string" || typeof card?.getFlag?.(MODULE_ID, "formBreathCastId") === "string") return users.find(user => user.isGM)?.id === game.user.id;
    const leader = users.find(user => user.isGM)
        ?? users.find(user => user.id === card?.author?.id)
        ?? users[0]
        ?? null;
    return !leader || leader.id === game.user.id;
}

function hpValue(actor) {
    const value = Number(actor?.system?.attributes?.hp?.value);
    return Number.isFinite(value) ? value : null;
}

function initiativeForActor(actor) {
    return game.combat?.combatants?.find(combatant => combatant.actor?.uuid === actor?.uuid)?.initiative ?? null;
}

function heightenOutcomeFormula(entry, baseRank, castRank) {
    const steps = entry.heightening?.type === "interval"
        ? Math.max(0, Math.floor((castRank - baseRank) / entry.heightening.interval))
        : 0;
    if (!steps) return entry.formula;
    const base = /^(\d+)d(\d+)(\[[^\]]+\])$/i.exec(entry.formula);
    const increase = /^(\d+)d(\d+)$/i.exec(entry.heightening.formula);
    if (!base || !increase || base[2] !== increase[2]) {
        throw new Error(`Unsupported outcome damage heightening: ${entry.formula} + ${entry.heightening.formula}.`);
    }
    return `${Number(base[1]) + steps * Number(increase[1])}d${base[2]}${base[3]}`;
}

/** A fixed duration that grows with the cast rank ("the duration … increases by 2 rounds" per heightening step). */
function heightenedDuration(duration, castRank) {
    if (!duration?.heightening) return clone(duration);
    const { heightening, ...rest } = clone(duration);
    const steps = Math.max(0, Math.floor((Number(castRank) - heightening.rank) / heightening.interval));
    return { ...rest, value: Number(rest.value) + heightening.increase * steps };
}

function snapshotEffect(effect, castRank) {
    return {
        kind: effect.kind,
        slug: effect.slug,
        name: effect.name,
        value: effect.value,
        duration: heightenedDuration(effect.duration, castRank),
        raw: effect.raw,
        ...(effect.whileCondition ? {
            whileCondition: effect.whileCondition,
            endsWhen: clone(effect.endsWhen)
        } : {}),
        ...(isEscapeLifetime(effect) || isActionEndLifetime(effect) || isSpellLifetime(effect) || isPersistentLinkedLifetime(effect) || isRestLifetime(effect) || isLeaveAreaLifetime(effect) || isAreaLifetime(effect) || isNextAttackLifetime(effect) ? {
            endsWhen: clone(effect.endsWhen),
            expirationMode: effect.expirationMode
        } : {}),
        ...(effect.recurringSave ? { recurringSave: clone(effect.recurringSave) } : {}),
        ...(effect.growth ? { growth: clone(effect.growth) } : {}),
        ...(effect.actionSave ? { actionSave: clone(effect.actionSave) } : {}),
        // Granted by the row's degree-choice Effect instead of applied by the module.
        ...(effect.carriedBy ? { carriedBy: effect.carriedBy } : {}),
        ...(effect.valueRoll ? { valueRoll: effect.valueRoll } : {}),
        ...(effect.gate ? { gate: clone(effect.gate) } : {}),
        // (Held: "can't reduce the value of this condition normally".)
        ...(effect.locked === true ? { locked: true } : {}),
        ...(effect.choiceGroup ? { choiceGroup: effect.choiceGroup } : {}),
        ...(effect.option ? { option: effect.option } : {}),
        // ("If more than one of the targets failed …": how many targets with which results.)
        ...(effect.groupGate ? { groupGate: clone(effect.groupGate) } : {}),
        // One more than the creature has now ("or increasing its clumsy condition by 1").
        ...(effect.increment === true ? { increment: true } : {}),
        // ("If they were already prone, they instead … Unconscious": the other condition for a creature holding this one.)
        ...(effect.insteadIfHeld ? { insteadIfHeld: clone(effect.insteadIfHeld) } : {}),
        // (Unfathomable Song: the roll's results giving this condition.)
        ...(Array.isArray(effect.rollResults) ? { rollResults: [...effect.rollResults] } : {}),
        ...(effect.attributes ? { attributes: [...effect.attributes] } : {})
    };
}

function snapshotOutcomes(plan, castRank) {
    const rollByFormula = new Map();
    const snapshotDamage = (source, scope) => {
        const damage = clone(source);
        for (const entry of damage.formulas ?? []) {
            entry.formula = heightenOutcomeFormula(entry, Number(plan.rank), castRank);
            const key = `${scope}:${entry.formula}`;
            let roll = rollByFormula.get(key);
            if (!roll) {
                roll = {
                    id: `outcome-damage-${rollByFormula.size + 1}`,
                    formula: entry.formula,
                    rollJSON: null,
                    total: null,
                    instances: [],
                    rollOptions: []
                };
                rollByFormula.set(key, roll);
            }
            entry.rollId = roll.id;
        }
        return damage;
    };
    const snapshotSecondary = (followUp, primaryDegree, index) => {
        const id = `secondary-${primaryDegree}-${index + 1}`;
        return {
            id,
            timing: clone(followUp.timing),
            check: clone(followUp.check),
            // (Asked of the GM first: Unhelpful Nudge's collision.)
            ...(followUp.gate ? { gate: clone(followUp.gate) } : {}),
            // ("A creature of 10th level or lower must also …": the highest level at the cast rank.)
            ...(followUp.levelGate ? { maxLevel: followUp.levelGate.maxLevel + (followUp.levelGate.perStep ? Math.max(0, Math.floor((Number(castRank) - followUp.levelGate.baseRank) / followUp.levelGate.interval)) * followUp.levelGate.perStep : 0) } : {}),
            outcomes: Object.fromEntries(SAVE_DEGREES.map(degree => {
                const outcome = followUp.outcomes[degree];
                return [degree, {
                    damage: snapshotDamage(outcome.damage, id),
                    effects: clone(outcome.effects ?? []).map(effect => snapshotEffect(effect, castRank)),
                    terminal: clone(outcome.terminal),
                    ...(outcome.noteEffects?.length ? { noteEffects: clone(outcome.noteEffects) } : {})
                }];
            }))
        };
    };
    const mapOutcomes = source => Object.fromEntries(SAVE_DEGREES.map(degree => {
        const outcome = source[degree];
        return [degree, {
            damage: snapshotDamage(outcome.damage, "primary"),
            effects: clone(outcome.effects ?? []).map(effect => snapshotEffect(effect, castRank)),
            nativeEffects: clone(outcome.nativeEffects ?? []),
            modifiers: clone(outcome.modifiers ?? []),
            // "The target dies." / "The target's Dying value increases by 1.".
            terminal: isPrimaryDeath(outcome.terminal) ? clone(outcome.terminal) : null,
            conditionIncreases: clone(outcome.conditionIncreases ?? []),
            // "You are Stunned 1 and the spell ends.".
            casterConditions: isCasterConditionEnd(outcome) || isCasterConditionOnly(outcome) || isCasterConditionTimed(outcome) ? clone(outcome.casterConditions) : [],
            // (Or a bare "The spell immediately ends." row of a lingering save, which the compiler flags.)
            endsSpell: isCasterConditionEnd(outcome) || (outcome?.endsSpell === true && outcome.casterConditions == null && (/^The spell (?:immediately )?ends\.$/.test(String(outcome.rawText ?? "").trim())
                // ("If the target critically succeeds at any … save …, the spell ends": the compiler marked it.)
                || outcome.endsSpellOn === "critical-success")),
            // (A save repeated on each Sustain: this result ends the spell, so no more repeats — Lurking Doom's critical success.)
            ...(outcome?.endsRepeat === true ? { endsRepeat: true } : {}),
            affliction: clone(outcome.affliction ?? null),
            afflictionImmunity: clone(outcome.afflictionImmunity ?? null),
            afflictionSavePenalty: clone(outcome.afflictionSavePenalty ?? null),
            conditionFloor: isConditionFloor(outcome.conditionFloor) ? clone(outcome.conditionFloor) : null,
            rawText: outcome.rawText,
            // A GM note the row states ("uses its remaining actions …").
            rowNotes: clone(outcome.rowNotes ?? []),
            // Note Effects: what the module can't carry out, as reminders on the creature.
            noteEffects: clone(outcome.noteEffects ?? []),
            // "Heightened (+2) … the distance the target is moved … increases by 5 feet": the distance at the cast rank.
            // A fixed-rank heightening ("Heightened (4th) … pushed to 10 feet"): that distance from that rank.
            forcedMovement: outcome.forcedMovement?.heightening?.minRank
                ? { ...clone(outcome.forcedMovement), distance: Number(castRank) >= outcome.forcedMovement.heightening.minRank ? outcome.forcedMovement.heightening.distance : outcome.forcedMovement.distance }
                : outcome.forcedMovement?.heightening
                ? { ...clone(outcome.forcedMovement), distance: outcome.forcedMovement.distance
                    + Math.max(0, Math.floor((Number(castRank) - Number(plan.rank)) / outcome.forcedMovement.heightening.interval)) * outcome.forcedMovement.heightening.feet }
                : clone(outcome.forcedMovement ?? null),
            // (Vacuum's critical failure: suffocating.)
            ...(outcome.suffocate ? { suffocate: clone(outcome.suffocate) } : {}),
            followUps: (outcome.followUps ?? []).map((followUp, index) =>
                snapshotSecondary(followUp, degree, index))
        }];
    }));
    const outcomes = mapOutcomes(plan.resolution.outcomes);
    // The rows for creatures of the spell's other kind (Flense's undead), sharing the cast's rolls.
    const traitOutcomes = plan.resolution.traitVariant ? mapOutcomes(plan.resolution.traitVariant.outcomes) : null;
    return { outcomes, traitOutcomes, outcomeRolls: [...rollByFormula.values()] };
}

function planUsesSharedDamage(plan) {
    return SAVE_DEGREES.some(degree => {
        const outcome = plan.resolution.outcomes?.[degree];
        return ["shared", "mixed"].includes(outcome?.damage?.mode)
            || (outcome?.followUps ?? []).some(followUp => SAVE_DEGREES.some(secondaryDegree =>
                followUp.outcomes?.[secondaryDegree]?.damage?.mode === "primary-shared"));
    });
}


function outcomeEffectsForTarget(state, target) {
    return targetOutcomeConditions(state, target);
}

function existingCondition(actor, slug) {
    try {
        const matches = actor.conditions?.bySlug?.(slug);
        if (matches?.length) return matches.find(condition => condition.active) ?? matches[0];
    } catch (_) {}
    return actor.items?.find(item => item.type === "condition" && item.slug === slug && item.active !== false) ?? null;
}

function conditionValue(condition) {
    for (const candidate of [condition?.value, condition?.system?.value?.value, condition?.system?.badge?.value]) {
        const value = Number(candidate);
        if (Number.isFinite(value)) return value;
    }
    return 0;
}

async function clearConditionCompletely(actor, slug) {
    for (let attempt = 0; attempt < 12; attempt++) {
        const before = existingCondition(actor, slug);
        if (!before) return;
        const value = conditionValue(before);
        if (typeof actor.decreaseCondition === "function") await actor.decreaseCondition(slug);
        else if (before.delete && before.readonly !== true) await before.delete();
        else return;
        const after = existingCondition(actor, slug);
        if (!after || (after.id === before.id && conditionValue(after) === value)) return;
    }
}

/** A row's death and condition increases, as the card lists them. */
function primaryRowLabels(outcome) {
    return [...(outcome?.terminal?.kind === "death" ? ["Dies"] : []),
        ...(outcome?.casterConditions ?? []).map(entry => `Caster ${entry.slug}${entry.value == null ? "" : ` ${entry.value}`}${outcome?.endsSpell ? ", the spell ends" : ""}`),
        ...(outcome?.conditionIncreases ?? []).map(entry => `${entry.slug[0].toUpperCase()}${entry.slug.slice(1)} +${entry.amount}`)];
}

/**
 * The caster's Effect while a sustained attack spell lasts (Sign of Conviction): the stated rules for the spell's duration (sustained), ending
 * when the caster's token moves; made with the card's first attack. A later attack from the same card after it has ended is refused.
 */
async function ensureCastEffect(plan, sourceActor, spell, options) {
    const data = plan.resolution.castEffect;
    const key = options.sourceMessageId ?? spell?.uuid ?? plan.source.uuid;
    const existing = sourceActor.itemTypes?.effect?.find(effect => effect.flags?.[MODULE_ID]?.castEffect?.key === key && !effect.isExpired);
    if (existing) return existing;
    const message = options.sourceMessageId ? game.messages.get(options.sourceMessageId) : null;
    if (message?.getFlag(MODULE_ID, "castEffectMade")) throw new Error(`${plan.source.name}: the spell has ended (its Effect on ${sourceActor.name} is gone).`);
    const seconds = plan.lifecycle?.durationSpec?.mode === "fixed" ? Number(plan.lifecycle.durationSpec.value) * ({ rounds: 6, minutes: 60, hours: 3600 }[plan.lifecycle.durationSpec.unit] ?? 0) : 60;
    const initiative = game.combat?.combatants.find(combatant => combatant.actor === sourceActor)?.initiative ?? null;
    const [effect] = await sourceActor.createEmbeddedDocuments("Item", [{ name: plan.source.name, type: "effect", img: spell?.img ?? "icons/svg/aura.svg",
        system: { duration: { value: Math.max(1, Math.round(seconds / 60)), unit: "minutes", expiry: "turn-start", sustained: data.sustained === true }, start: { value: game.time.worldTime, initiative },
            tokenIcon: { show: true }, rules: foundry.utils.deepClone(data.rules),
            description: { value: data.notes.map(note => `<p>${escapeHTML(note)}</p>`).join("") } },
        flags: { [MODULE_ID]: { castEffect: { key, spell: plan.source.name }, runtime: { schema: 1, kind: "cast-effect", sourceActorUuid: sourceActor.uuid, sourceItemName: plan.source.name,
            targetActorUuid: sourceActor.uuid, ...(data.endsAfterMovement ? { endsAfterMovement: true } : {}) } } } }]);
    if (message) await message.setFlag(MODULE_ID, "castEffectMade", true).catch(() => null);
    return effect;
}

/**
 * A conjured creature (Avenging Wildwood's tree; user decision 2026-10-01: a token the module makes): an NPC with the stated size, AC (the spell
 * DC), saves (the spell DC – 10) and Hit Points at the cast rank, owned like the caster, placed in the nearest free space (or options.conjurePosition)
 * within range; the caster's Effect for the spell's duration removes it when it ends (summonOnEnd). Later attacks of the same spell reuse it.
 */
async function ensureConjuredCreature(plan, sourceActor, spell, castRank, dc, options) {
    const data = plan.resolution.conjuredCreature;
    const key = spell?.uuid ?? plan.source.uuid;
    const existing = sourceActor.itemTypes?.effect?.find(effect => effect.flags?.[MODULE_ID]?.summon?.conjuredBy === key && !effect.isExpired);
    if (existing) {
        const token = await fromUuid(existing.flags[MODULE_ID].summon.tokenUuid).catch(() => null);
        if (!token) throw new Error(`${plan.source.name}: the ${data.name} is gone; end the spell (delete ${existing.name}).`);
        return { token, created: false };
    }
    const casterToken = sourceActor.getActiveTokens?.(true, true)?.[0] ?? null;
    if (!casterToken) throw new Error(`${plan.source.name}: ${sourceActor.name} needs a token on the scene.`);
    const hp = data.hp.base + data.hp.step * Math.max(0, Math.floor((castRank - data.hp.baseRank) / data.hp.interval));
    const castId = randomID();
    const actor = await Actor.create({ name: `${plan.source.name}: ${data.name}`, type: "npc", img: spell?.img ?? "icons/svg/oak.svg",
        ownership: { ...foundry.utils.deepClone(sourceActor.ownership ?? {}), default: 0 },
        prototypeToken: { actorLink: true, disposition: casterToken.disposition, name: `${plan.source.name}: ${data.name}` },
        system: { details: { level: { value: 0 }, alliance: sourceActor.alliance ?? sourceActor.system?.details?.alliance ?? null },
            // (A stated AC, and no saves for an object: Bonewall Bulwark.)
            attributes: { ac: { value: Number.isInteger(data.ac) ? data.ac : dc }, hp: { value: hp, max: hp } },
            saves: data.saves === "none" ? { fortitude: { value: 0 }, reflex: { value: 0 }, will: { value: 0 } } : { fortitude: { value: dc - 10 }, reflex: { value: dc - 10 }, will: { value: dc - 10 } },
            traits: { value: [...data.traits, "summoned"], size: { value: data.size }, rarity: "common" } },
        flags: { [MODULE_ID]: { summoned: { castId, casterUuid: sourceActor.uuid, spell: plan.source.name } } } });
    let token;
    try {
        const place = options.conjurePosition ?? freeSpaceNear(casterToken, actor.prototypeToken, data.rangeFeet);
        if (!place) throw new Error(`${plan.source.name}: there's no free space within ${data.rangeFeet} feet of ${sourceActor.name}.`);
        const tokenData = (await actor.getTokenDocument({ x: place.x, y: place.y, disposition: casterToken.disposition, actorLink: true })).toObject();
        [token] = await casterToken.parent.createEmbeddedDocuments("Token", [tokenData]);
    } catch (error) { await actor.delete().catch(() => null); throw error; }
    const initiative = game.combat?.combatants.find(combatant => combatant.actor === sourceActor)?.initiative ?? null;
    const seconds = plan.lifecycle?.durationSpec?.mode === "fixed" ? Number(plan.lifecycle.durationSpec.value) * ({ rounds: 6, minutes: 60, hours: 3600 }[plan.lifecycle.durationSpec.unit] ?? 0) : 60;
    await sourceActor.createEmbeddedDocuments("Item", [{ name: `${plan.source.name}: the ${data.name}`, type: "effect", img: spell?.img ?? "icons/svg/oak.svg",
        system: { duration: { value: Math.max(1, Math.round(seconds / 60)), unit: "minutes", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative },
            description: { value: plan.resolution.repeatable?.trigger === "turn-start"
                ? `<p>The ${escapeHTML(data.name)} (AC ${Number.isInteger(data.ac) ? data.ac : dc}, ${hp} HP) attacks a creature within ${data.reach} feet of it at the start of each of your turns (attack from the spell's card). It's removed when this Effect ends.</p>`
                : `<p>The ${escapeHTML(data.name)} (AC ${dc}, saves +${dc - 10}, ${hp} HP) Strikes a creature within ${data.reach} feet of it when you Cast and each time you Sustain the spell (attack from the spell's card). It's removed when this Effect ends (delete it if you stop Sustaining).</p>` }, rules: [] },
        flags: { [MODULE_ID]: { summon: { castId, actorUuid: actor.uuid, tokenUuid: token.uuid, conjuredBy: key } } } }]);
    return { token, created: true };
}

/** "You gain …, granting you a +2 circumstance bonus …" on a target's failed save (Mental Map): the caster's linked Effect, once per cast. */
async function applyCasterRowEffect(state, createdEffects) {
    const caster = await fromUuid(state.sourceActorUuid);
    if (!caster) throw new Error(`${state.spellName}: the caster is unavailable for its Effect.`);
    const template = await loadNativeEffectTemplate(state.casterRowEffect.uuid);
    if (!casterRowEffectMatches({ rules: template.system?.rules, duration: template.system?.duration }, state.casterRowEffect)) throw new Error(`${state.spellName}: ${template.name} no longer states the spell's bonus.`);
    const source = template.toObject();
    delete source._id;
    source.system.level = { value: state.castRank };
    source.system.context = { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: caster.uuid }, roll: null };
    source.system.start = { value: state.effectStart.value, initiative: state.effectStart.initiative };
    source.flags = { ...(source.flags ?? {}), [MODULE_ID]: { outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid,
        sourceItemName: state.spellName, casterRowEffect: true, conditions: [] } } };
    // (A cast's Effect gated on an option nothing sets: the caster's toggle for it.)
    if (state.casterRowEffect.kind === "weapon-cast" && state.casterEffectSelection) {
        const choice = source.system.rules.find(rule => rule.key === "ChoiceSet" && rule.flag === "weapon");
        if (choice) { choice.selection = state.casterEffectSelection; source.flags.system ??= {}; source.flags.system.rulesSelections = { ...(source.flags.system.rulesSelections ?? {}), weapon: state.casterEffectSelection }; }
    }
    if (state.casterRowEffect.kind === "cast") source.system.rules = [...(source.system.rules ?? []),
        { key: "RollOption", domain: "skill-check", option: state.casterRowEffect.option, toggleable: true, label: state.casterRowEffect.toggleLabel }];
    const [effect] = await caster.createEmbeddedDocuments("Item", [source]);
    if (!effect) throw new Error(`${state.spellName}: the caster's Effect was not confirmed.`);
    createdEffects.push(effect);
    return { name: effect.name, uuid: effect.uuid };
}

/** "If this kills it, you gain …": the caster's linked Effect, once per cast. */
async function applyKillEffect(state, createdEffects) {
    const caster = await fromUuid(state.sourceActorUuid);
    if (!caster) throw new Error(`${state.spellName}: the caster is unavailable for its Effect.`);
    const template = await loadNativeEffectTemplate(state.killEffect.uuid);
    const mechanics = { rules: template.system?.rules, duration: template.system?.duration };
    if (!killEffectMatches(mechanics, state.killEffect)) throw new Error(`${state.spellName}: ${template.name} no longer states the spell's benefit.`);
    const source = template.toObject();
    delete source._id;
    source.system.level = { value: state.castRank };
    source.system.context = { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: caster.uuid }, roll: null };
    source.system.start = { value: state.effectStart.value, initiative: state.effectStart.initiative };
    source.flags = { ...(source.flags ?? {}), [MODULE_ID]: { outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid,
        sourceItemName: state.spellName, killEffect: true, conditions: [] } } };
    const [effect] = await caster.createEmbeddedDocuments("Item", [source]);
    if (!effect) throw new Error(`${state.spellName}: the caster's Effect was not confirmed.`);
    createdEffects.push(effect);
    return { name: effect.name, uuid: effect.uuid };
}

async function applyTerminalDeath(state, target, actor, terminal) {
    if (typeof actor.toggleStatusEffect !== "function") {
        throw new Error(`${target.name} does not expose PF2e's dead-status control.`);
    }
    // ("It is reduced to 0 Hit Points and dies.")
    if (terminal?.zeroHp && (Number(actor.system?.attributes?.hp?.value ?? 0) > 0 || Number(actor.system?.attributes?.hp?.temp ?? 0) > 0))
        await actor.update({ "system.attributes.hp.value": 0, "system.attributes.hp.temp": 0 });
    if (!actor.statuses?.has?.("dead")) await actor.toggleStatusEffect("dead", { active: true });
    if (actor.statuses?.has?.("dead") !== true) {
        throw new Error(`PF2e did not confirm the Dead status on ${target.name}.`);
    }
    await clearConditionCompletely(actor, "dying");
    await clearConditionCompletely(actor, "unconscious");
    target.terminalResult = clone(terminal);
    target.terminalApplied = true;
    debugLog(state.castId, "terminal death applied", {
        targetId: target.id,
        actorUuid: actor.uuid,
        label: terminal.label ?? "Dies"
    });
}

function nativeOutcomeLabel(effect) {
    const proof = effect.outcomeRule;
    return proof?.kind === 'degree-speed-penalty'
        ? `${proof.selectionValue}-foot ${proof.modifierType} penalty to Speeds`
        : effect.label ?? effect.reference ?? 'Native Effect';
}

function sharedDamageLabel(state, target) {
    const multiplier = damageMultiplierForTarget(state, target);
    if (!(multiplier > 0)) return null;
    if (!state.damage?.componentSelective) return `×${multiplier} shared damage`;
    const damage = outcomeForTarget(state, target)?.damage;
    const selection = damage?.mode === 'mixed' ? damage.shared : damage;
    return (selection?.sourceComponentIds ?? []).map(id => {
        const component = state.damage.components.find(candidate => candidate.id === id);
        return `×${selection.componentMultipliers?.[id] ?? selection.multiplier} ${component?.category === 'persistent' || component?.type === 'bleed' ? 'persistent ' : ''}${component?.type ?? 'unknown'} damage`;
    }).join(' + ');
}

function conditionLabel(condition) {
    if (condition.timedStunned || isTimedStunned(condition)) {
        const {value, unit} = condition.duration;
        return `Stunned (can't act for ${value} ${Number(value) === 1 ? unit.replace(/s$/, "") : unit})`;
    }
    return `${condition.name}${condition.value == null ? "" : ` ${condition.value}`}`;
}

const DAMAGE_ICONS = Object.freeze({
    acid: "vial",
    bleed: "droplet",
    bludgeoning: "hammer",
    cold: "snowflake",
    electricity: "bolt",
    fire: "fire",
    force: "sparkles",
    mental: "brain",
    piercing: "bow-arrow",
    poison: "spider",
    slashing: "axe",
    sonic: "waveform-lines",
    spirit: "ghost",
    vitality: "sun",
    void: "skull"
});

/** The damage types of the Strikes a creature can make (its weapons and unarmed attacks): [{strike, type}], one entry per type. */
export function targetStrikeTypes(actor) {
    const out = [];
    for (const action of actor?.system?.actions ?? []) {
        const item = action?.item;
        if (!item || action.type !== "strike") continue;
        const types = item.type === "melee" ? Object.values(item.system?.damageRolls ?? {}).map(roll => roll?.damageType) : [item.system?.damage?.damageType];
        for (const type of new Set(types.filter(type => /^[a-z]+$/.test(type ?? "")))) out.push({ strike: action.label ?? item.name, type });
    }
    return out;
}

function damageTypeFromFormula(formula) {
    const configured = CONFIG.PF2E?.damageTypes ?? {};
    const types = String(formula ?? "").match(/\[([^\]]+)\]/g)?.flatMap(group =>
        group.slice(1, -1).split(",").map(value => value.trim())) ?? [];
    return types.find(type => Object.hasOwn(configured, type) || type in DAMAGE_ICONS) ?? "untyped";
}

function damageTypeLabel(type, persistent = false) {
    const key = CONFIG.PF2E?.damageTypes?.[type];
    const localized = key && globalThis.game?.i18n?.localize ? game.i18n.localize(key) : null;
    const label = localized && localized !== key
        ? localized
        : type.replace(/(^|-)([a-z])/g, (_match, separator, letter) => `${separator ? " " : ""}${letter.toUpperCase()}`);
    return `${persistent ? "Persistent " : ""}${label} Damage`;
}

function damageInstances(roll, fallback = {}) {
    const instances = Array.isArray(roll?.instances) ? roll.instances : [];
    if (!instances.length) return [{
        type: damageTypeFromFormula(fallback.formula ?? roll?.formula),
        formula: fallback.formula ?? roll?.formula ?? null,
        total: Number.isFinite(Number(fallback.total ?? roll?.total)) ? Number(fallback.total ?? roll.total) : null,
        persistent: /\[([^\]]*,)?persistent(,[^\]]*)?\]/i.test(fallback.formula ?? roll?.formula ?? "")
    }];
    return instances.map(instance => ({
        type: instance.type ?? damageTypeFromFormula(instance.formula),
        formula: instance.head?.expression ?? instance.formula ?? null,
        total: Number.isFinite(Number(instance.total)) ? Number(instance.total) : null,
        persistent: instance.persistent === true
    }));
}

function damageBadge(part, { multiplier = 1 } = {}) {
    const type = part.type ?? damageTypeFromFormula(part.formula);
    const icon = DAMAGE_ICONS[type];
    const persistent = part.persistent === true;
    const value = persistent
        ? String(part.formula ?? "Persistent damage").replace(/\[[^\]]+\]/g, "").trim()
        : part.total ?? "—";
    const multiplierLabel = multiplier !== 1 ? `<small>×${escapeHTML(multiplier)}</small>` : "";
    return `<span class="damage color ${escapeHTML(type)} pf2e-auto-damage-result"
        title="${escapeHTML(damageTypeLabel(type, persistent))}">
        ${multiplierLabel}<strong>${escapeHTML(value)}</strong>
        ${persistent ? '<i class="fa-duotone fa-hourglass pf2e-auto-damage-icon"></i>' : ""}
        ${icon ? `<i class="fa-solid fa-${icon} pf2e-auto-damage-icon"></i>` : ""}
        <span>${escapeHTML(damageTypeLabel(type, persistent))}</span>
    </span>`;
}

function damageParts(entry) {
    return entry?.instances?.length ? entry.instances : [{
        type: damageTypeFromFormula(entry?.formula),
        formula: entry?.formula,
        total: entry?.total,
        persistent: /persistent/i.test(entry?.formula ?? "")
    }];
}

function damageRollBadges(entry) {
    const parts = damageParts(entry);
    return `<div class="pf2e-auto-damage-results">${parts.map(part => damageBadge(part)).join("")}</div>`;
}

/** A push or pull for this target's result, for the GM to carry out (tokens aren't moved automatically). */
/** "… it takes @Damage[(5 * ceil((@item.level - 2) / 2))[bludgeoning]] damage." at rank 3 → "… it takes 5 bludgeoning damage." */
function forcedMovementNoteText(note, castRank) {
    return String(note)
        .replace(/@Damage\[(.+?)\[([a-z]+)\]\]/g, (match, formula, type) => {
            // ("(3 + (@item.rank - 3) * 1)d6": the dice at the cast rank.)
            const dice = /^\((.+)\)d(\d+)$/.exec(formula);
            if (dice) {
                let count = null;
                try { count = Roll.safeEval(dice[1].replace(/@item\.(?:level|rank)\b/g, String(Number(castRank)))); } catch { count = null; }
                if (Number.isInteger(count)) return `${count}d${dice[2]}${type === "untyped" ? "" : ` ${type}`}`;
            }
            let value = null;
            try { value = Roll.safeEval(formula.replace(/@item\.(?:level|rank)\b/g, String(Number(castRank)))); } catch { value = null; }
            return Number.isFinite(value) ? `${value} ${type}` : `${formula} ${type}`;
        })
        .replace(/\[\[\/act ([a-z-]+)\]\]/g, (match, slug) => slug.split("-").map((word, index) => index > 0 && ["a", "an", "the", "of", "to"].includes(word) ? word : word[0].toUpperCase() + word.slice(1)).join(" "));
}

function forcedMovementNote(state, target) {
    const rowNotes = target.degree ? (outcomeForTarget(state, target)?.rowNotes ?? []) : [];
    const notes = rowNotes.map(note => `<div class="pf2e-auto-gm-reminder"><strong>GM:</strong> ${escapeHTML(target.name)}: ${escapeHTML(note.text)}</div>`).join("");
    return notes + movementNote(state, target) + hazardNote(state, target);
}

/** “the ground in the target's space catches fire …”: where the module placed the hazard, or why it didn't. */
function hazardNote(state, target) {
    const hazard = state.groundHazard;
    if (!hazard || !target.degree || !hazard.degrees.includes(target.degree)) return "";
    const result = target.groundHazard;
    const when = hazard.events.map(event => event === "enter" ? "enters" : event === "turn-start" ? "starts its turn" : "ends its turn").join(" or ");
    return `<div class="pf2e-auto-gm-reminder"><strong>Area:</strong> the ground in ${escapeHTML(target.name)}'s space ${escapeHTML(hazard.label)}: ${escapeHTML(hazard.formula)} ${escapeHTML(hazard.damage.type)} damage (no save) to each creature that ${when} there. ${result?.status === "placed" ? "The module placed a region there and deals the damage itself." : result?.status === "failed" ? `The region couldn't be placed (${escapeHTML(result.reason)}); mark the squares and deal the damage yourself.` : "Placed at Finalize."}</div>`;
}

/**
 * A note lasting the spell's duration, at the cast rank: “Heightened (4th) The duration lasts until the next time you make your
 * daily preparations.” replaces it. A note with its own timing (“for 3 rounds”) keeps it.
 */
export function noteAtRank(note, lifecycle, castRank) {
    const spec = lifecycle?.durationSpec;
    const heightened = heightenedDurationAt(lifecycle?.heightenedDurations, castRank);
    // The spell's own duration: named by its text, or copied from the item (its raw duration).
    if (!heightened || !spec?.raw || (note?.duration?.sourceText ?? note?.duration?.raw) !== spec.raw) return note;
    return { ...note, duration: { mode: "fixed", value: heightened.value, unit: heightened.unit, expiry: "turn-start", anchor: "effect-start", offset: 0, sourceText: heightened.raw } };
}

/** A hazard formula at the cast rank: “(@item.rank)d6” at rank 3 is “3d6”. */
export function hazardFormula(formula, rank) {
    return String(formula).replace(/@item\.(?:rank|level)/g, String(rank))
        // "(floor(4/2))d4" is 2d4.
        .replace(/\(floor\((\d+)\/(\d+)\)\)d/g, (_, a, b) => `${Math.floor(Number(a) / Number(b))}d`)
        .replace(/\((\d+)\)d/g, "$1d");
}

/** The point a push is away from (or a pull toward): the caster (or the card's own origin), or the burst's centre — the cast's template. */
async function forcedMovementPoint(state, move) {
    // (A centre given by the card that started this save: an incarnate part's area or familiar.)
    if (state.forcedPoint) return { x: Number(state.forcedPoint.x), y: Number(state.forcedPoint.y), token: null };
    const originUuid = state.forcedOrigin ?? null;
    const origin = originUuid ? await fromUuid(originUuid).catch(() => null) : (await fromUuid(state.sourceActorUuid).catch(() => null))?.getActiveTokens?.(true, true)?.[0] ?? null;
    const tokenPoint = token => token ? { x: token.x + Number(token.width ?? 1) * canvas.grid.size / 2, y: token.y + Number(token.height ?? 1) * canvas.grid.size / 2, token } : null;
    if (move.direction === "from-center" || move.direction === "center") {
        if (state.areaShape === "emanation" || state.spellAreaType === "emanation") return tokenPoint(origin);
        const region = state.sourceMessageId ? canvas.scene?.regions.find(entry => entry.flags?.pf2e?.messageId === state.sourceMessageId) : null;
        const shape = region?.shapes?.[0];
        return shape ? { x: Number(shape.x), y: Number(shape.y), token: null } : null;
    }
    return tokenPoint(origin);
}

/** A target's forced movement, when the module can carry it out: {moved, squares, stoppedBy} or {skipped: why}. */
async function carryOutForcedMovement(state, target, move, token) {
    if (move.optional || move.upTo || move.direction === "any" || move.direction === "chosen" || move.perHit || move.actions || move.avoid) return { skipped: "the caster's or target's choice" };
    const actor = await fromUuid(target.actorUuid).catch(() => null);
    if (move.trait) {
        const traits = actor?.traits ?? new Set(actor?.system?.traits?.value ?? []);
        if (!(traits.has?.(move.trait) ?? [...traits].includes(move.trait))) return { skipped: "not of the trait" };
    }
    const doc = token?.document ?? token ?? actor?.getActiveTokens?.(true, true)?.[0];
    if (!doc) return { skipped: "no token" };
    if (move.kind === "rise") return forcedElevation(doc, { rise: Number(move.distance) });
    if (move.kind === "fall") return forcedElevation(doc, { fall: Number(move.distance) });
    const point = await forcedMovementPoint(state, move);
    if (!point) return { skipped: "no centre for the area" };
    const toward = move.kind === "pull" || move.direction === "center" || move.direction === "toward";
    // ("to the nearest empty space adjacent to the caster"; "to the center of the area": as far as it takes.)
    const feet = move.toAdjacent || move.toCenter ? 10000 : Number(move.distance);
    const done = await forcedMove(doc, { point, direction: toward ? "toward" : "away", feet, stopAt: toward ? point.token : null, reason: state.spellName });
    // (On the caster's own square no way is "away" or "toward": the GM's to move.)
    if (done.stoppedBy === "no direction") return { skipped: "no direction from the caster" };
    // (Stopped short by a firm surface: "creatures that can't complete this forced movement are knocked Prone" (Arcane Explosion); "takes bludgeoning
    // damage equal to the remaining number of feet it would've moved" (Planar Collision).)
    if (move.stopped && done.feetLeft > 0 && actor) {
        if (move.stopped.prone && !actor.hasCondition?.("prone")) { await actor.increaseCondition("prone"); done.prone = true; }
        if (move.stopped.damage) {
            const DamageRoll = CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
            const roll = await new DamageRoll(`${done.feetLeft}[${move.stopped.damage}]`).evaluate();
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(state.spellName)}</strong>: ${escapeHTML(actor.name)} hits a firm surface (${done.feetLeft} feet left)` }).catch(() => null);
            done.collision = (await applyDamageWithReceipt(actor, { damage: roll, token: doc.object ?? doc, skipIWR: false, rollOptions: new Set() }, randomID()))?.damage ?? null;
        }
    }
    return done;
}

function movementNote(state, target) {
    const move = target.degree ? outcomeForTarget(state, target)?.forcedMovement : null;
    if (!move) return "";
    // (Carried out by the module: where it went.)
    const done = target.forcedMoved;
    if (done && !done.skipped && !done.error) {
        const verb = move.kind === "rise" ? `rose ${move.distance} feet` : move.kind === "fall" ? "fell safely" : move.kind === "pull" ? "was pulled" : "was pushed";
        const stop = (done.stoppedBy === "wall" ? " (a wall stopped it)" : done.stoppedBy === "occupied" ? " (ending beside the creature in its way)" : done.stoppedBy === "edge" ? " (the scene's edge stopped it)" : "")
            + (done.prone ? "; knocked Prone" : "") + (done.collision != null ? `; ${done.collision} damage from the collision` : "");
        // (Stopped by a wall or a creature: the spell's rule for that — "If the push would move it into a solid barrier or another creature, it stops
        // there and takes 3d6 damage" — for the GM.)
        const collided = done.stoppedBy === "wall" || done.stoppedBy === "occupied" ? (state.forcedMovementNotes ?? []).map(note => ` ${escapeHTML(note)}`).join("") : "";
        return `<div class="pf2e-auto-gm-reminder"><strong>Moved:</strong> ${escapeHTML(target.name)} ${done.moved ? `${verb}${done.squares != null && move.kind !== "rise" && move.kind !== "fall" ? ` ${done.squares * 5} feet` : ""}${stop}. The module moved the token.` : `couldn't move${stop}. The token stays where it is.`}${collided}</div>`;
    }
    // A push only for creatures with a trait ("undead creatures are also knocked back").
    if (move.trait) {
        const actor = globalThis.fromUuidSync?.(target.actorUuid);
        const traits = actor?.traits ?? new Set(actor?.system?.traits?.value ?? []);
        if (!(traits.has?.(move.trait) ?? [...traits].includes(move.trait))) return "";
    }
    const extra = (state.forcedMovementNotes ?? []).map(note => ` ${escapeHTML(note)}`).join("");
    // (Only when the spell was cast with that many actions: the GM checks.)
    const onlyIf = move.actions ? ` Only if the spell was cast with ${move.actions} actions.` : "";
    if (move.kind === "rise") return `<div class="pf2e-auto-gm-reminder"><strong>GM:</strong> ${escapeHTML(target.name)} rises ${move.distance} feet into the air. Raise the token's elevation; the module doesn't.${extra}</div>`;
    if (move.kind === "fall") return `<div class="pf2e-auto-gm-reminder"><strong>GM:</strong> ${escapeHTML(target.name)} falls up to ${move.distance} feet, safely (no falling damage if it reaches the ground). Move the token; the module doesn't.</div>`;
    const how = move.perHit ? `pushed back ${{ 0.5: "half", 1: "", 2: "double" }[move.perHit.multiplier]}${move.perHit.multiplier === 1 ? "" : " "}the normal distance away from the caster (${move.perHit.normal} feet for each normal hit from the Strikes, plus ${move.perHit.critical} feet for each critical hit)`
        : move.direction === "center" ? (move.toCenter ? "moved to the center of the area (forced movement)" : `moved ${move.distance} feet toward the center of the area (forced movement)`)
        : move.direction === "from-center" ? `pushed ${move.distance} feet away from the center of the burst`
        : move.direction === "chosen" ? `moved ${move.distance} feet toward the creature or object the caster chose (forced movement)`
        : move.kind === "pull" && move.toAdjacent ? "pulled to the nearest empty space adjacent to the caster"
        : move.kind === "pull" ? `pulled ${move.upTo ? "up to " : ""}${move.distance} feet toward the caster`
        : `pushed ${move.upTo ? "up to " : ""}${move.distance} feet${move.direction === "away" ? " away from the caster" : move.direction === "any" ? " in any direction" : ""}${move.note ? ` (${move.note})` : ""}`;
    const avoid = move.avoid === "prone" ? ` ${escapeHTML(target.name)} can choose to fall Prone instead of moving.`
        : move.avoid === "hazard-prone" ? ` If moved toward a hazard (a pool of acid, off a cliff), ${escapeHTML(target.name)} can fall Prone instead of moving.` : "";
    return `<div class="pf2e-auto-gm-reminder"><strong>GM:</strong> ${escapeHTML(target.name)} ${move.optional ? `can be ${how} (the caster's choice)` : `is ${how}`}. Move the token; the module doesn't.${onlyIf}${avoid}${extra}</div>`;
}

function saveResultBadge(target) {
    if (!target.degree) return "Not rolled";
    const total = target.saveTotal == null ? (target.itemHit ? `<strong>${escapeHTML(target.itemHit)}</strong> ` : "") : `<strong>${escapeHTML(target.saveTotal)}</strong> `;
    const breakdown = target.saveNatural == null || target.saveModifier == null
        ? ""
        : `<small>d20 ${escapeHTML(target.saveNatural)} ${target.saveModifier >= 0 ? "+" : "−"}${escapeHTML(Math.abs(target.saveModifier))}</small>`;
    const detail = target.saveNatural == null
        ? ""
        : ` title="Natural ${escapeHTML(target.saveNatural)}${target.saveModifier == null ? "" : `; modifier ${target.saveModifier >= 0 ? "+" : ""}${escapeHTML(target.saveModifier)}`}"`;
    const original = target.rolledDegree ?? target.degree;
    const correction = target.degreeOverride
        ? `<small class="pf2e-auto-correction-note">GM adjusted: ${escapeHTML(readableSaveDegree(original))} → ${escapeHTML(readableSaveDegree(target.degree))}</small>` : "";
    return `<span class="pf2e-auto-save-result ${escapeHTML(original)}"${detail}>
        <i class="fa-solid fa-dice-d20"></i> ${total}${escapeHTML(readableSaveDegree(original))}${breakdown}
    </span>${correction}`;
}

function eligibilityNote(target) {
    if (!target.eligibilityOverride) return "";
    const original = target.originalEligibility;
    return `<small class="pf2e-auto-correction-note">GM marked ${target.eligible ? "Affected" : "Unaffected"} for this cast. Original: ${original?.eligible ? "eligible" : escapeHTML(original?.reason ?? "unaffected")}.</small>`;
}

function durationLabel(duration) {
    return !duration || duration.mode === "unlimited" || duration.unit === "unlimited"
        ? "unlimited" : `${duration.value} ${Number(duration.value) === 1 ? duration.unit.replace(/s$/, "") : duration.unit}${duration.expiry ? `, ${duration.expiry}` : ""}`;
}

function conditionAdjustmentNote(target) {
    const notes = Object.values(target.conditionOverrides ?? {}).map(({ original, changes }) => {
        const value = "value" in changes ? `value ${original.value} → ${changes.value}` : "";
        const duration = changes.duration ? `duration ${durationLabel(original.duration)} → ${durationLabel(changes.duration)}` : "";
        // (Indolent Haze: already prone, so Unconscious instead.)
        if (changes.slug && changes.slug !== original.slug) return `${original.name} → ${changes.name} (already ${original.slug})`;
        return `${original.name}: ${[value, duration].filter(Boolean).join("; ")}`;
    });
    return notes.length ? `<div class="pf2e-auto-correction-note">GM adjusted: ${notes.map(escapeHTML).join("; ")}</div>` : "";
}

function correctionButton(state, target, action, label, stage = "primary", degree = "") {
    return `<button type="button" class="pf2e-auto-save-button pf2e-auto-gm-correction" data-save-action="correct-target"
        data-message-id="${escapeHTML(state.messageId)}" data-target-id="${escapeHTML(target.id)}"
        data-correction-action="${action}" data-save-stage="${stage}" data-degree="${degree}"
        data-target-revision="${Number(target.revision ?? 0)}">${label}</button>`;
}

function correctionControls(state, target) {
    if (state.status !== "collecting" || state.reviewRequired || target.reviewRequired
        || !["pending", "unaffected"].includes(target.applicationStatus)) return "";
    if (target.excluded) return correctionButton(state, target, "restore", "Restore Target");
    const degrees = (record, stage) => !targetParticipates(target) || !record?.degree ? "" :
        `<div><strong>${stage === "secondary" ? "Secondary save" : "Save degree"}</strong>${SAVE_DEGREES.map(degree =>
            correctionButton(state, target, "degree", readableSaveDegree(degree), stage, degree)).join("")}</div>`;
    return `<details class="pf2e-auto-gm-corrections"><summary>GM corrections</summary>
        ${correctionButton(state, target, "exclude", "Exclude Target")}
        ${correctionButton(state, target, target.eligible === false ? "affected" : "unaffected", target.eligible === false ? "Mark Affected" : "Mark Unaffected")}
        ${degrees(target, "primary")}${degrees(target.secondary, "secondary")}
        ${targetParticipates(target) && target.degree && (!target.secondary || target.secondary.degree)
            ? outcomeEffectsForTarget(state, target).map((condition, index) => correctionButton(state, target, "condition", `Adjust ${conditionLabel(condition)}`, "primary", String(index))).join("") : ""}
        ${conditionAdjustmentNote(target)}</details>`;
}

function conditionDuration(condition, lifecycle) {
    if (condition.whileCondition) return { value: -1, unit: "unlimited", expiry: null, anchor: "effect-start" };
    // Rest ends or lowers it: no timer, not even the spell's own duration.
    if (isRestLifetime(condition)) return { value: -1, unit: "unlimited", expiry: null, anchor: "effect-start" };
    // Leaving the area ends it: no timer.
    if (isLeaveAreaLifetime(condition) || isAreaLifetime(condition)) return { value: -1, unit: "unlimited", expiry: null, anchor: "effect-start" };
    if (condition.duration == null && condition.slug === "stunned" && Number.isInteger(condition.value)) {
        return {value:-1,unit:"unlimited",expiry:null,anchor:"effect-start",derived:"stunned-action-debt"};
    }
    // Prone lasts until the creature Stands (PF2e's own rule), never the spell's duration.
    if (condition.duration == null && condition.slug === "prone") return { value: -1, unit: "unlimited", expiry: null, anchor: "effect-start" };
    // A sustained spell's conditions run to its maximum; a missed Sustain ends them sooner.
    const duration = condition.duration?.mode === "sustained" ? condition.duration.maximum : condition.duration ?? (lifecycle?.durationSpec?.mode === "fixed"
        ? lifecycle.durationSpec
        : lifecycle?.durationSpec?.mode === "sustained" && lifecycle.durationSpec.maximum?.mode === "fixed"
            ? lifecycle.durationSpec.maximum
            : null);
    if (!duration || duration.mode === "unlimited") {
        return { value: -1, unit: "unlimited", expiry: null, anchor: "effect-start" };
    }
    // PF2e's Effects count days at most: a spell lasting "1 week" lasts 7 days.
    const weeks = duration.unit === "weeks";
    return {
        value: weeks ? 7 * Number(duration.value) : Number(duration.value),
        unit: weeks ? "days" : duration.unit,
        expiry: duration.expiry ?? null,
        anchor: duration.anchor ?? "effect-start",
        offset: duration.offset
    };
}

function conditionGrant(condition, ruleFlag, multiple) {
    const template = game.pf2e?.ConditionManager?.getCondition(condition.slug);
    if (!template) throw new Error(`PF2e condition ${condition.slug} is unavailable.`);
    const valued = template.system?.value?.isValued === true;
    // Timed Stunned: PF2e needs a badge value, but the Effect's name and timer
    // carry the rule (can't act for the duration); no action debt is tracked.
    if (isTimedStunned(condition)) condition = { ...condition, value: 1, timedStunned: true };
    if (valued && !Number.isInteger(condition.value)) {
        throw new Error(`${condition.name} requires a compiled condition value.`);
    }
    if (!valued && condition.value != null) {
        throw new Error(`${condition.name} does not accept a condition value.`);
    }
    const conditionUuid = template._stats?.compendiumSource
        ?? (template.uuid?.startsWith("Compendium.") ? template.uuid : null)
        ?? `Compendium.pf2e.conditionitems.Item.${template.id}`;
    const alterations = condition.value == null ? [] : [{
        mode: "override",
        property: "badge-value",
        value: condition.value
    }];
    return {
        condition,
        template,
        ruleFlag,
        rule: {
            key: "GrantItem",
            uuid: conditionUuid,
            flag: ruleFlag,
            allowDuplicate: true,
            alterations,
            // ("… and can't reduce the value of this condition normally": PF2e keeps it while the Effect lasts.)
            onDeleteActions: { granter: "cascade", grantee: condition.locked ? "restrict" : multiple ? "detach" : "cascade" }
        }
    };
}

function conditionGroupSource(state, target, actor, conditions, linkedTo = null) {
    const duration = nativeConditionTiming(conditionDuration(conditions[0], state.lifecycle), state.effectStart, state.sourceActorUuid, actor.uuid);
    const initiative = duration.anchor === "target-turn"
        ? initiativeForActor(actor)
        : state.effectStart.initiative;
    const multiple = conditions.length > 1;
    const grants = conditions.map((condition, index) =>
        conditionGrant(condition, `condition${index + 1}`, multiple));
    const labels = conditions.map(conditionLabel);
    const applicationId = randomID();
    const persistentLink = isPersistentLinkedLifetime(conditions[0]) ? { damageType: conditions[0].endsWhen.damageType } : null;
    const source = {
        name: `${state.spellName}: ${labels.join(", ")}${persistentLink ? ` (while taking persistent ${persistentLink.damageType} damage)` : ""}${isEscapeLifetime(conditions[0]) ? " (until Escape)" : ""}${isRecurringSaveLifetime(conditions[0]) ? " (end-of-turn save)" : ""}${isActionEndLifetime(conditions[0]) ? { next: " (until its next action)", "next-turn-action": " (until its first action next turn)", "outside-action": " (1 action outside the area ends it)" }[conditions[0].endsWhen[0].action] ?? " (ends on Interact)" : ""}`,
        type: "effect",
        img: grants[0].template.img,
        flags: { [MODULE_ID]: { outcomeEffect: {
            schema: SAVE_SCHEMA,
            applicationId,
            castId: state.castId,
            sourceActorUuid: state.sourceActorUuid,
            sourceItemUuid: state.sourceItemUuid,
            sourceItemName: state.spellName,
            targetId: target.id,
            degree: target.degree,
            secondaryDegree: target.secondary?.degree ?? null,
            ...(linkedTo ? { linkedTo } : {}),
            ...(persistentLink ? { persistentLink } : {}),
            // Ended (or lowered by 1) by PF2e's Rest for the Night.
            ...(isRestLifetime(conditions[0]) ? { restLifetime: { mode: conditions[0].endsWhen[0].mode } } : {}),
            ...(isLeaveAreaLifetime(conditions[0]) ? { leaveAreaLifetime: true } : {}),
            ...(isEscapeLifetime(conditions[0]) ? { escape: { dc: state.dc, event: "escape", ...(conditions[0].endsWhen[0].check ? { check: conditions[0].endsWhen[0].check } : {}), expirationMode: conditions[0].expirationMode } } : {}),
            ...(isActionEndLifetime(conditions[0]) ? { actionEnd: { action: conditions[0].endsWhen[0].action, expirationMode: conditions[0].expirationMode } } : {}),
            // (Coral Scourge: it grows as each of the creature's turns begins; Ongoing raises it, and grants the further condition at the maximum.)
            ...(conditions[0].growth ? { growth: clone(conditions[0].growth) } : {}),
            ...(isRecurringSaveLifetime(conditions[0]) ? { recurringSave: { timing: conditions[0].recurringSave.timing ?? "turn-end", mode: conditions[0].recurringSave.mode,
                // (Only once it's outside this cast's lingering area.)
                ...(conditions[0].recurringSave.outsideArea ? { outsideArea: state.lingeringCastId ?? null } : {}),
                statistic: conditions[0].recurringSave.statistic, dc: state.dc,
                ...(conditions[0].recurringSave.mode === "escalate" ? { steps: clone(conditions[0].recurringSave.steps), maximum: conditions[0].recurringSave.maximum, slug: conditions[0].slug,
                    ...(conditions[0].recurringSave.atActions ? { atActions: clone(conditions[0].recurringSave.atActions) } : {}) } : {}),
                ...(state.traitSaveBonus ? { traitSaveBonus: clone(state.traitSaveBonus) } : {}) } } : {}),
            conditions: grants.map(grant => ({
                slug: grant.condition.slug,
                label: conditionLabel(grant.condition),
                ruleFlag: grant.ruleFlag,
                ...(grant.condition.slug === "sickened" ? {recovery:"sickened"} : grant.condition.slug === "frightened" ? {recovery:"frightened"} : grant.condition.slug === "stunned" && grant.condition.duration == null ? {recovery:"stunned-actions"} : {}),
                // (Its own action's save to lose just this condition: Pressure Zone's popped ears.)
                ...(grant.condition.actionSave ? { actionSave: { statistic: grant.condition.actionSave.statistic, dc: state.dc } } : {})
            }))
        } } },
        system: {
            description: { value: `<p>Applies ${labels.map(escapeHTML).join(", ")} from <strong>${escapeHTML(state.spellName)}</strong> after a ${escapeHTML(readableSaveDegree(target.degree))}${target.secondary ? ` and a secondary ${escapeHTML(readableSaveDegree(target.secondary.degree))}` : ""}.</p>${persistentLink ? `<p>Ends when the creature is no longer taking persistent ${escapeHTML(persistentLink.damageType)} damage.</p>` : ""}${isEscapeLifetime(conditions[0]) ? conditions[0].endsWhen[0].check === "grapple" ? `<p>Ends early when the creature succeeds at a Grapple against DC ${escapeHTML(state.dc)}: [[/act grapple dc=${escapeHTML(state.dc)}]].</p>` : `<p>Ends early when the creature succeeds at an Escape check against DC ${escapeHTML(state.dc)}.</p>` : ""}${isActionEndLifetime(conditions[0]) ? conditions[0].endsWhen[0].action === "next-turn-action" ? `<p>Ends once the creature has completed its first action on its next turn (end it in Ongoing spells).</p>` : conditions[0].endsWhen[0].action === "next" ? `<p>Ends when the creature takes its next action (end it in Ongoing spells).</p>` : conditions[0].endsWhen[0].action === "outside-action" ? `<p>Once outside the area, the creature can spend 1 action to end this (in Ongoing spells).</p>` : `<p>The creature can spend an Interact action to end this.</p>` : ""}${isRestLifetime(conditions[0]) ? (conditions[0].endsWhen[0].mode === "end" ? `<p>Ends when the creature next gets 8 hours of rest (Rest for the Night).</p>` : `<p>Each 8 hours of rest (Rest for the Night) lowers these conditions by 1.</p>`) : ""}${isRecurringSaveLifetime(conditions[0]) ? `<p>At the ${conditions[0].recurringSave.timing === "caster-turn-start" ? "start of each of the caster's turns" : "end of each of its turns"}, the creature attempts a DC ${escapeHTML(state.dc)} ${escapeHTML(conditions[0].recurringSave.statistic)} save: ${conditions[0].recurringSave.mode === "reduce" ? "a success reduces the remaining duration by 1 round; a critical success ends it" : conditions[0].recurringSave.mode === "escalate" ? `a failure raises the condition by ${conditions[0].recurringSave.steps.failure} (${conditions[0].recurringSave.steps.criticalFailure} on a critical failure, to at most ${conditions[0].recurringSave.maximum}); a success lowers it by ${-conditions[0].recurringSave.steps.success}; at 0 it ends` : "a success ends it"}.</p>` : ""}` },
            duration: {
                value: duration.value,
                unit: duration.unit,
                expiry: duration.expiry,
                sustained: false
            },
            fromSpell: true,
            context: {
                origin: { actor: duration.originActorUuid, item: state.sourceItemUuid },
                target: { actor: actor.uuid, token: target.tokenUuid ?? null },
                roll: null
            },
            level: { value: state.castRank },
            rules: grants.map(grant => grant.rule),
            start: { value: state.effectStart.value, initiative },
            tokenIcon: { show: true },
            traits: { value: [] }
        }
    };
    // "while in the cloud": the lingering area removes it when the creature leaves (clearLeaveArea).
    if (isLeaveAreaLifetime(conditions[0])) {
        if (!state.lingeringCastId) throw new Error(`${state.spellName}: a condition that lasts while the creature is in the area needs its lingering area.`);
        source.flags[MODULE_ID].leaveArea = { castId: state.lingeringCastId };
        source.name = `${source.name} (while in the area)`;
    }
    // "against the triggering attack": the next attack roll against this creature removes it (main.js), the end of the turn at the latest.
    if (isNextAttackLifetime(conditions[0])) {
        source.flags[MODULE_ID].nextAttack = { actorUuid: actor.uuid };
        source.name = `${source.name} (against the triggering attack)`;
    }
    // "fascinated by the cloud": the area's end removes it.
    if (isAreaLifetime(conditions[0])) {
        if (!state.lingeringCastId) throw new Error(`${state.spellName}: a condition that lasts as long as the area needs its lingering area.`);
        source.flags[MODULE_ID].areaLifetime = { castId: state.lingeringCastId };
        source.name = `${source.name} (while the area lasts)`;
    }
    return {
        applicationId,
        linkedTo,
        persistentLink,
        conditions: grants.map(grant => ({ condition: grant.condition, ruleFlag: grant.ruleFlag })),
        duration,
        source
    };
}

function groupedConditionSources(state, target, actor) {
    // A condition a degree-choice Effect grants is carried by that Effect, not applied again.
    const all = outcomeEffectsForTarget(state, target);
    const ownCount = outcomeForTarget(state, target)?.effects?.length ?? 0;
    const effects = all.filter(condition => !condition.carriedBy);
    const primaryCount = all.slice(0, ownCount).filter(condition => !condition.carriedBy).length;
    const sources = [];
    for (const branch of [effects.slice(0, primaryCount), effects.slice(primaryCount)]) {
        const groups = new Map();
        const links = executableConditionLinks(branch);
        if (!links) throw new Error("The selected outcome has an unsupported linked condition dependency.");
        const dependedOn = new Set(links.values());
        for (const [index, condition] of branch.entries()) {
            if (links.has(index) || dependedOn.has(index)) continue;
            const duration = conditionDuration(condition, state.lifecycle);
            // Escape ends only its own restraint, never a same-timer neighbor.
            const key = JSON.stringify([duration, ["frightened","stunned","sickened"].includes(condition.slug) ? condition.slug : "other",
                isEscapeLifetime(condition), isActionEndLifetime(condition), condition.recurringSave ? [condition.recurringSave.mode, condition.recurringSave.statistic, condition.recurringSave.timing ?? "turn-end"] : null,
                isPersistentLinkedLifetime(condition) ? condition.endsWhen.damageType : null, isRestLifetime(condition) ? condition.endsWhen[0].mode : null, condition.gate ? `${condition.gate.kind}:${condition.gate.key ?? ""}` : null,
                isLeaveAreaLifetime(condition), isAreaLifetime(condition), isNextAttackLifetime(condition), condition.growth ? JSON.stringify(condition.growth) : null]);
            const group = groups.get(key) ?? [];
            group.push(condition);
            groups.set(key, group);
        }
        sources.push(...[...groups.values()].map(conditions =>
            conditionGroupSource(state, target, actor, conditions)));
        const roots = new Map([...dependedOn].map(index => [index,
            conditionGroupSource(state, target, actor, [branch[index]])]));
        sources.push(...roots.values());
        for (const [index, rootIndex] of links) {
            const root = roots.get(rootIndex);
            sources.push(conditionGroupSource(state, target, actor, [branch[index]], {
                rootApplicationId: root.applicationId,
                rootRuleFlag: root.conditions[0].ruleFlag,
                rootSlug: branch[rootIndex].slug
            }));
        }
    }
    return sources;
}

function outcomeEffectMetadata(effect) {
    return effect?.getFlag?.(MODULE_ID, "outcomeEffect")
        ?? effect?.flags?.[MODULE_ID]?.outcomeEffect
        ?? null;
}

function documentDiagnostic(document) {
    return {
        name: document?.name ?? null,
        type: document?.type ?? document?.documentName ?? null,
        uuid: document?.uuid ?? null,
        parentUuid: document?.parent?.uuid ?? null,
        outcomeEffect: outcomeEffectMetadata(document)
    };
}

/**
 * The cast's spell: the recovery copy, the caster's own item, or — a spell cast from a wand, scroll or other item, which PF2e builds for the cast and
 * which no UUID finds afterwards — the copy taken when the card was made.
 */
async function castSpellDocument(state, sourceActor) {
    if (state.recoverySource && sourceActor) return new CONFIG.Item.documentClass(clone(state.recoverySource), { parent: sourceActor });
    let found = null;
    try { found = state.sourceItemUuid ? await castSpellFromUuid(state) : null; } catch (_) { found = null; }
    if (found?.type === "spell") return found;
    return state.originalSpellSource && sourceActor ? spellFromSource(state.originalSpellSource, sourceActor) : found;
}

/** Falling Sky: each target token above 0 elevation descends to the ground, taking twice the falling damage for the distance (the distance itself), capped. */
async function applyAreaFall(state) {
    const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
    const caster = await fromUuid(state.sourceActorUuid), spell = await castSpellDocument(state, caster);
    const fell = [];
    for (const target of state.targets.filter(target => !target.excluded)) {
        const { actor, token } = await resolveTargetDocuments(target);
        const document = token?.document ?? token;
        const elevation = Number(document?.elevation ?? 0);
        if (!actor || !document || !(elevation > 0)) continue;
        const amount = Math.min(state.areaFall.cap, Math.floor(elevation / 2) * state.areaFall.multiplier);
        await document.update({ elevation: 0 });
        if (amount > 0) {
            const roll = await new DamageRoll(`${amount}[${state.areaFall.type}]`).evaluate();
            await actor.applyDamage({ damage: roll, token: document.object ?? document, item: spell ?? undefined, rollOptions: new Set(["area-damage"]) });
        }
        fell.push({ name: actor.name, feet: elevation, amount });
    }
    if (fell.length) try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(state.spellName)}</strong>: ${fell.map(entry => `${escapeHTML(entry.name)} falls ${entry.feet} feet (${entry.amount} ${escapeHTML(state.areaFall.type)})`).join("; ")}.</p>` }); } catch (_) {}
    return { status: "fallen", fell };
}

/** Massacre's backlash: none of the card's creatures died — the flat damage to each living one (level-excluded too) and to the caster. */
async function applyBacklash(state) {
    const isDead = actor => !actor || Number(actor.hitPoints?.value ?? actor.system?.attributes?.hp?.value ?? 1) <= 0 || !!actor.hasCondition?.("dead") || !!actor.statuses?.has?.("dead");
    const entries = [];
    for (const target of state.targets.filter(target => !target.excluded)) entries.push({ target, ...(await resolveTargetDocuments(target)) });
    if (entries.some(({ target, actor }) => targetParticipates(target) && isDead(actor))) return { status: "killed" };
    const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
    const caster = await fromUuid(state.sourceActorUuid), spell = await castSpellDocument(state, caster);
    const hit = [];
    const deal = async (actor, token, formula) => {
        const roll = await new DamageRoll(formula).evaluate();
        await actor.applyDamage({ damage: roll, token: token?.object ?? token ?? undefined, item: spell ?? undefined, rollOptions: new Set(["area-damage"]) });
        hit.push({ name: actor.name, amount: roll.total });
    };
    for (const { actor, token } of entries) if (actor && actor.modeOfBeing === "living" && !isDead(actor)) await deal(actor, token, state.backlash.formula);
    if (caster) await deal(caster, caster.getActiveTokens?.()[0]?.document ?? null, state.backlash.caster);
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(state.spellName)}</strong> killed no one: it turns back — ${hit.map(entry => `${escapeHTML(entry.name)} ${entry.amount}`).join(", ")}.</p>` }); } catch (_) {}
    return { status: "backlash", hit };
}

function stateFromCard(card) {
    return clone(card?.getFlag(MODULE_ID, "basicSaveState") ?? card?.flags?.[MODULE_ID]?.basicSaveState ?? null);
}

/** This client's user owns the cast's caster and may edit its save card (the card is theirs: their own Prepare made it). */
async function casterMayEditCard(card, state) {
    if (!state?.sourceActorUuid || !card?.canUserModify?.(game.user, "update")) return false;
    const caster = await fromUuid(state.sourceActorUuid);
    return !!caster?.testUserPermission?.(game.user, "OWNER");
}

function cardForCast(castId) {
    return game.messages.find(message =>
        message.getFlag(MODULE_ID, "basicSaveState")?.castId === castId) ?? null;
}

function afflictionHandlerActive() {
    return game.modules.get(AFFLICTION_HANDLER)?.active === true;
}

function afflictionLabel(affliction, handoff = null, choice = null) {
    const base = `Afflicted: ${affliction.name}, stage ${affliction.stage}${affliction.maxStage ? ` (can't pass stage ${affliction.maxStage})` : ""}${choice?.selected ? ` (${choice.label.toLowerCase()}: ${choice.selected})` : ""}`;
    if (!handoff) return `${base} (${afflictionHandlerActive() ? "Pseudo Afflictions" : "stages and progression by GM"})`;
    if (handoff.status === "immune") return `${base} — ${handoff.reason}; not afflicted`;
    const others = handoff.others ? ` (${handoff.others} are immune: GM check)` : "";
    if (handoff.status === "applied") return `${base} — handled by Pseudo Afflictions (${handoff.effectName}, stage ${handoff.stage})${others}`;
    const option = choice?.selected ? choice.options.find(entry => entry.name === choice.selected) : null;
    const behaviour = option ? ` At stage ${choice.stage}: ${option.text}${choice.notes?.length ? ` ${choice.notes.join(" ")}` : ""}` : "";
    return `${base} — ${handoff.reason}; apply the affliction manually${others}.${behaviour}`;
}

function afflictionHandlerEffects(actor) {
    return new Map(actor.itemTypes.effect.filter(effect => effect.flags?.[AFFLICTION_HANDLER]?.stages)
        .map(effect => [effect.id, Number(effect.badge?.value ?? effect.system?.badge?.value ?? 0)]));
}

/**
 * Pseudo Afflictions resolves afflictions from a native saving-throw message.
 * The module's saves are provisional until Finalize, so the confirmed degree
 * is sent through its processMessage hook instead, then confirmed on the actor.
 */
function conditionUuidFor(slug) {
    const template = game.pf2e?.ConditionManager?.getCondition(slug);
    if (!template) throw new Error(`PF2e condition ${slug} is unavailable.`);
    return template._stats?.compendiumSource ?? (template.uuid?.startsWith("Compendium.") ? template.uuid : null)
        ?? `Compendium.pf2e.conditionitems.Item.${template.id}`;
}

function conditionFloorLabel(floor, secondaryOf = null) {
    const name = floor.slug[0].toUpperCase() + floor.slug.slice(1);
    if (floor.lifetime === "while-condition") return `Can't reduce ${name} below ${floor.value} while ${floor.whileCondition.slug} from this spell (${floor.whileCondition.duration.value} ${floor.whileCondition.duration.unit})`;
    if (floor.lifetime === "until-lifted") return `Can't reduce ${name} below ${floor.value} until ${floor.liftedBy} (GM: delete this Effect then)`;
    if (floor.lifetime === "while-persistent") return `Can't reduce ${name} below ${floor.value} while ${secondaryOf ? `${secondaryOf.name} (the primary target) is ` : ""}taking persistent ${floor.persistentDamage} damage`;
    if (floor.lifetime === "fixed") return `Can't reduce ${name} below ${floor.value} for ${floor.duration.value} ${floor.duration.unit}`;
    if (floor.lifetime === "spell") return `Can't reduce ${name} below ${floor.value} while the spell lasts${floor.whileText ? ` and ${floor.whileText} (GM: delete this Effect while it can't)` : ""}`;
    return `Curse: can't reduce ${name} below ${floor.value}${floor.situational ? `; ${floor.situational.grant.slug} ${floor.situational.grant.value} while ${floor.situational.requires} and ${floor.situational.circumstance} (toggle)` : ""}`;
}

/**
 * The curse Effect: a locked grant of the floor value (PF2e keeps the granted
 * condition while the Effect exists, so reductions stop at the floor) and,
 * when written, a situational condition granted only while the GM toggle is
 * on and the creature still has the floor condition.
 */
function conditionFloorSource(state, target, actor, floor) {
    const uuid = conditionUuidFor(floor.slug);
    const toggle = `${state.spellSlug ?? "curse"}-situational`;
    const whileCondition = floor.lifetime === "while-condition" ? floor.whileCondition : null;
    const rules = [{ key: "GrantItem", uuid, flag: "floor", allowDuplicate: true, alterations: [{ mode: "override", property: "badge-value", value: floor.value }],
        onDeleteActions: { granter: "cascade", grantee: "restrict" } }];
    // (The situational condition — "Slowed 1 while at sea" —: the GM's toggle on the curse; the module gives it while the toggle is on and the creature has the
    // floor condition (situationalCurseToggle in main.js). PF2e 8.6's re-evaluated grants lost track of what they granted.)
    if (floor.situational) rules.push({ key: "RollOption", domain: "all", option: toggle, toggleable: true, value: false, label: `${state.spellName}: ${floor.situational.circumstance}` });
    return {
        name: ["spell", "while-condition", "while-persistent", "until-lifted", "fixed"].includes(floor.lifetime) ? `${state.spellName}: ${floor.slug} floor` : `${state.spellName} (curse)`, type: "effect", img: "icons/svg/skull.svg",
        flags: { [MODULE_ID]: { conditionFloor: clone(floor), ...(floor.situational ? { situationalToggle: toggle } : {}), outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid,
            sourceItemName: state.spellName, targetId: target.id, conditions: [],
            // Removed with the creature's last persistent damage of that type (persistent-link-runtime.js) — a secondary target's with the
            // primary target's.
            ...(floor.lifetime === "while-persistent" ? { persistentLink: { damageType: floor.persistentDamage, ...(target.secondaryOf ? { actorUuid: target.secondaryOf.actorUuid } : {}) } } : {}) } } },
        system: {
            description: { value: `<p>${escapeHTML(conditionFloorLabel(floor, target.secondaryOf))}.</p>${floor.liftNote ? `<p>${escapeHTML(floor.liftNote.replace(/^./, letter => letter.toUpperCase()))}.</p>` : ""}${floor.liftedBy && floor.lifetime === "curse" ? `<p>The curse can be lifted by ${escapeHTML(floor.liftedBy)}; delete this Effect when it is.</p>` : ""}` },
            duration: whileCondition ? { value: whileCondition.duration.value, unit: whileCondition.duration.unit, expiry: "turn-start", sustained: false }
                : floor.lifetime === "fixed" ? { value: floor.duration.value, unit: floor.duration.unit, expiry: "turn-start", sustained: false } : { value: -1, unit: "unlimited", expiry: null, sustained: false }, fromSpell: true,
            context: { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: actor.uuid, token: target.tokenUuid ?? null }, roll: null },
            level: { value: state.castRank }, rules, start: { value: state.effectStart.value, initiative: null }
        }
    };
}

function afflictionExtraLabels(outcome) {
    return [
        ...(outcome?.afflictionImmunity ? [`Immune to ${outcome.afflictionImmunity.name} (${outcome.afflictionImmunity.duration.value} ${outcome.afflictionImmunity.duration.unit})`] : []),
        ...(outcome?.afflictionSavePenalty ? [`${outcome.afflictionSavePenalty.value} status to saves against ${outcome.afflictionSavePenalty.name} (${outcome.afflictionSavePenalty.duration.value} ${outcome.afflictionSavePenalty.duration.unit} or until contracted${afflictionHandlerActive() ? "" : "; delete it if the creature contracts the affliction"})`] : [])
    ];
}

/**
 * The saves this penalty covers are this spell's own save and the handler's
 * progression saves (Pseudo Afflictions rolls them with its "effect-<spell>"
 * Effect as the item). Once that Effect exists the creature has contracted the
 * affliction, so the modifier stops applying.
 */
function afflictionExtraSources(state, target, actor, outcome) {
    const base = (name, duration, flags, rules, description) => ({
        name, type: "effect", img: "icons/svg/aura.svg",
        flags: { [MODULE_ID]: { ...flags, outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, targetId: target.id, conditions: [] } } },
        system: { description: { value: description }, duration: { value: duration.value, unit: duration.unit, expiry: "turn-start", sustained: false },
            fromSpell: true, context: { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: actor.uuid, token: target.tokenUuid ?? null }, roll: null },
            level: { value: state.castRank }, rules, start: { value: state.effectStart.value, initiative: null } }
    });
    const out = [];
    const immunity = outcome?.afflictionImmunity;
    if (immunity) out.push({ label: afflictionExtraLabels({ afflictionImmunity: immunity })[0], effect: base(`${state.spellName}: Immune to ${immunity.name}`, immunity.duration,
        { afflictionImmunity: { name: immunity.name, spellSlug: state.spellSlug } }, [],
        `<p>Immune to <strong>${escapeHTML(immunity.name)}</strong> from <strong>${escapeHTML(state.spellName)}</strong>. Later casts of this spell don't afflict this creature while this lasts.</p>`) });
    const penalty = outcome?.afflictionSavePenalty;
    if (penalty && state.spellSlug) {
        const handlerEffect = `effect-${state.spellSlug}`;
        out.push({ label: afflictionExtraLabels({ afflictionSavePenalty: penalty })[0], effect: base(`${state.spellName}: Penalty against ${penalty.name}`, penalty.duration,
            { afflictionSavePenalty: { name: penalty.name, spellSlug: state.spellSlug } },
            [{ key: "FlatModifier", selector: "saving-throw", type: penalty.type, value: penalty.value, label: `${state.spellName}: saves against ${penalty.name}`,
                // PF2e drops the "effect-" prefix in actor roll options.
                predicate: [{ or: [`item:slug:${state.spellSlug}`, `item:slug:${handlerEffect}`] }, { not: `self:effect:${state.spellSlug}` }] }],
            `<p>${escapeHTML(String(penalty.value))} status penalty to saves against <strong>${escapeHTML(penalty.name)}</strong>, until the creature contracts it.</p>`
            + (afflictionHandlerActive() ? "" : "<p>Pseudo Afflictions is unavailable, so this can't end on contraction by itself: delete it when the creature contracts the affliction.</p>")) });
    }
    return out;
}

/** Write the cast-time behaviour choice onto the handler's affliction Effect. */
async function recordCastChoice(state, effect) {
    const choice = state.castChoice, option = choice.options.find(entry => entry.name === choice.selected);
    const note = `<p><strong>${escapeHTML(state.spellName)} — ${escapeHTML(choice.label.toLowerCase())} at stage ${escapeHTML(choice.stage)}: ${escapeHTML(option.name)}.</strong> ${escapeHTML(option.text)}</p>`
        + choice.notes.map(text => `<p>${escapeHTML(text)}</p>`).join("");
    const current = String(effect.system?.description?.value ?? "");
    if (!current.includes(note)) await effect.update({ "system.description.value": `${note}${current}` });
}

/** Virulent, and the stated conditions at their heightened value in every stage (and those the stage already granted). */
async function patchHeightenedAffliction(effect, patch) {
    const handler = effect.flags?.[AFFLICTION_HANDLER] ?? {};
    const stages = foundry.utils.deepClone(handler.stages ?? {});
    for (const stage of Object.values(stages)) for (const condition of stage.conditions ?? []) if (patch.values[condition.slug]) condition.value = patch.values[condition.slug];
    const names = Object.keys(patch.values).join("|");
    const description = String(effect.system?.description?.value ?? "").replace(new RegExp(String.raw`\b(${names}) ${patch.from}\b`, "gi"), (all, name) => `${name} ${patch.values[name.toLowerCase()]}`);
    await effect.update({ [`flags.${AFFLICTION_HANDLER}.stages`]: stages, "system.description.value": description,
        ...(patch.virulent ? { "system.traits.value": [...new Set([...(effect.system?.traits?.value ?? []), "virulent"])] } : {}) });
    const granted = effect.actor.itemTypes.condition.filter(condition => condition.flags?.pf2e?.grantedBy?.id === effect.id && patch.values[condition.slug] && condition.value !== patch.values[condition.slug]);
    for (const condition of granted) await condition.update({ "system.value.value": patch.values[condition.slug] });
}

/** "(max(4,(@item.rank)-1))" at a rank: digits, + - *, parentheses, max and min only. */
export function resolveRankCount(expression, rank) {
    const source = String(expression).replace(/@item\.rank/g, String(rank)).replace(/\s+/g, "");
    let index = 0;
    const peek = () => source[index];
    const number = () => { const match = /^\d+/.exec(source.slice(index)); if (!match) throw new Error(`bad count ${expression}`); index += match[0].length; return Number(match[0]); };
    const primary = () => {
        for (const name of ["max", "min"]) if (source.startsWith(`${name}(`, index)) {
            index += name.length + 1; const args = [sum()];
            while (peek() === ",") { index++; args.push(sum()); }
            if (peek() !== ")") throw new Error(`bad count ${expression}`); index++;
            return Math[name](...args);
        }
        if (peek() === "(") { index++; const value = sum(); if (peek() !== ")") throw new Error(`bad count ${expression}`); index++; return value; }
        return number();
    };
    const product = () => { let value = primary(); while (peek() === "*") { index++; value *= primary(); } return value; };
    const sum = () => { let value = product(); while (peek() === "+" || peek() === "-") { const op = source[index++]; value = op === "+" ? value + product() : value - product(); } return value; };
    const value = sum();
    if (index !== source.length || !Number.isInteger(value) || value < 1) throw new Error(`bad count ${expression}`);
    return value;
}

async function handOffAffliction(state, target, actor, affliction = null) {
    const spellImmunity = actor.itemTypes.effect.find(effect => effect.flags?.[MODULE_ID]?.afflictionImmunity?.name === state.afflictionHandoff?.name);
    if (spellImmunity) return {status: "immune", reason: `immune (${spellImmunity.name})`};
    const immunity = state.afflictionHandoff?.immunity;
    const immuneTrait = immunity?.traits.find(trait => actor.traits?.has?.(trait) ?? actor.system?.traits?.value?.includes(trait));
    if (immuneTrait) return {status: "immune", reason: `immune (${immuneTrait} trait)`};
    if (!afflictionHandlerActive()) return {status: "manual", reason: "Pseudo Afflictions is not active"};
    const spell = await castSpellFromUuid(state);
    const sourceActor = await fromUuid(state.sourceActorUuid);
    if (!spell) return {status: "manual", reason: "the source spell is unavailable"};
    const before = afflictionHandlerEffects(actor);
    Hooks.callAll(`${AFFLICTION_HANDLER}.processMessage`, {
        actor,
        item: spell,
        speaker: {actor: sourceActor?.id ?? null},
        // (A success that still afflicts — Curse of Death's capped stage 1 — goes to the handler as the degree that starts that stage.)
        flags: {pf2e: {context: {type: "saving-throw", outcome: ["success", "criticalSuccess"].includes(target.degree) && affliction ? (affliction.stage >= 2 ? "criticalFailure" : "failure") : target.degree,
            dc: {value: state.dc, label: `${state.spellName} DC`}}}},
        getRollData: () => spell.getRollData?.() ?? {}
    }, {}, game.userId);
    for (let waited = 0; waited <= 5000; waited += 100) {
        const after = afflictionHandlerEffects(actor);
        const createdId = [...after.keys()].find(id => !before.has(id));
        const updatedId = [...after.keys()].find(id => before.has(id) && after.get(id) > before.get(id));
        const effect = actor.items.get(createdId ?? updatedId);
        // A heightened affliction (Divine Plagues at 5th): Pseudo Afflictions' own copy made virulent, with the raised condition values.
        if (effect && createdId && state.afflictionHandoff?.heightenedPatch) await patchHeightenedAffliction(effect, state.afflictionHandoff.heightenedPatch);
        // A wand's "…, but it gains the virulent trait." (Wand of Pernicious Poison): the affliction it starts made virulent.
        const gained = (state.shapeRiders ?? []).flatMap(shape => shape.riders).filter(rider => rider.type === "trait").map(rider => rider.trait);
        if (effect && createdId && gained.length) await effect.update({"system.traits.value": [...new Set([...(effect.system?.traits?.value ?? []), ...gained])]});
        // A catalyst's "Clumsy instead of Enfeebled" (Ogre Spider Filament).
        const swaps = (state.shapeRiders ?? []).flatMap(shape => shape.riders).filter(rider => rider.type === "affliction-swap");
        if (effect && createdId && swaps.length) await swapAfflictionConditions(effect, swaps, AFFLICTION_HANDLER);
        // Stage damage counted from the cast rank, which the handler can't evaluate: written at this cast's rank.
        if (effect && createdId && state.afflictionHandoff?.rankDamage) {
            const updates = {};
            for (const [stage, entry] of Object.entries(state.afflictionHandoff.rankDamage))
                updates[`flags.${AFFLICTION_HANDLER}.stages.${stage}.damage.formula`] = `{${resolveRankCount(entry.count, state.castRank)}d${entry.faces}[${entry.type}]}`;
            await effect.update(updates);
        }
        // Started at a stage other than the handler's own for this degree.
        // (Not with an onset, whose counter is one ahead of the stages.)
        // (Gift of Dusk: the stage that brings a creature — curse-creature.js places it when the curse gets there; at 6th the curse's level is 11.)
        if (effect && createdId && state.afflictionHandoff?.stageCreature) await effect.update({[`flags.${MODULE_ID}.stageCreature`]: stageCreatureFlag(state.afflictionHandoff.stageCreature, state),
            ...(state.afflictionHandoff.levelPatch ? {"system.level.value": state.afflictionHandoff.levelPatch} : {})});
        if (effect && createdId && affliction && !effect.flags?.[AFFLICTION_HANDLER]?.onset && effect.badge?.value !== affliction.stage) await effect.update({"system.badge.value": affliction.stage});
        if (effect && state.castChoice?.selected) await recordCastChoice(state, effect);
        if (effect) return {status: "applied", others: immunity?.others ?? null, created: createdId ? effect : null, updated: !!updatedId && !createdId,
            effectUuid: effect.uuid, effectName: effect.name, stage: after.get(effect.id)};
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    // (An affliction Pseudo Afflictions' list doesn't have — PF2e 8.6's Gift of Dusk —: its Effect made in the handler's own terms from the compiled
    // stages; the handler runs it from there.)
    const built = state.afflictionHandoff?.handlerStages ? await buildHandlerAffliction(state, actor, spell, affliction) : null;
    if (built) return {status: "applied", others: immunity?.others ?? null, created: built, updated: false, effectUuid: built.uuid, effectName: built.name, stage: built.badge?.value ?? null};
    return {status: "manual", others: immunity?.others ?? null, reason: "Pseudo Afflictions did not pick up this spell"};
}

/** The handler's affliction Effect from the compiled stages, at the stage the result starts (its save the cast's DC), or null. */
async function buildHandlerAffliction(state, actor, spell, affliction) {
    const handoff = state.afflictionHandoff, stages = handoff.handlerStages;
    const count = Object.keys(stages).length, start = Math.min(count, Math.max(1, Number(affliction?.stage ?? 1)));
    if (!count || !Number.isFinite(Number(state.dc))) return null;
    const labels = Array.from({length: count}, (_, index) => `Stage ${index + 1}`);
    const [effect] = await actor.createEmbeddedDocuments("Item", [{
        name: `Affliction Effect: ${handoff.name}`, type: "effect", img: spell?.img ?? "icons/svg/biohazard.svg",
        flags: { [AFFLICTION_HANDLER]: { save: { type: state.saveStatistic, value: Number(state.dc) }, stages: clone(stages) },
            [MODULE_ID]: { builtAffliction: { castId: state.castId, spellName: state.spellName },
                ...(handoff.stageCreature ? { stageCreature: stageCreatureFlag(handoff.stageCreature, state) } : {}) } },
        system: {
            slug: `effect-${game.pf2e?.system?.sluggify?.(handoff.name) ?? String(handoff.name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            badge: { type: "counter", value: start, min: 1, max: count, labels, label: labels[start - 1], loop: false },
            duration: { value: -1, unit: "unlimited", expiry: null, sustained: false },
            level: { value: Number(handoff.levelPatch ?? handoff.level ?? state.castRank) },
            traits: { value: [...new Set(handoff.traits ?? [])], otherTags: [] },
            description: { value: `<p>From <strong>${escapeHTML(state.spellName)}</strong> (DC ${escapeHTML(state.dc)} ${escapeHTML(state.saveStatistic)}).</p>${(handoff.stages ?? []).map(stage => `<p><strong>Stage ${escapeHTML(stage.stage)}</strong> ${stage.text}</p>`).join("")}` },
            context: { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: actor.uuid, token: null }, roll: null },
            rules: []
        }
    }]);
    return effect ?? null;
}

function appliedConditionLabel(result) {
    if (result.status === "manual") return result.label;
    if (result.status === "immune") return `${result.label} (immune)`;
    if (result.status === "dependency-unavailable") return `${result.label} (not applied — required condition absent)`;
    return result.label;
}

/** A heal-or-harm target the spell heals: no save; the shared roll restores Hit Points at Finalize. */
function healingSummary(state, target) {
    const amount = target.damageResults?.find(result => result.kind === "healing")?.total;
    return target.applicationStatus === "applied"
        ? `<strong>Healed</strong> ${escapeHTML(String(amount ?? ""))} HP (${escapeHTML(String(target.hpBefore ?? "?"))} → ${escapeHTML(String(target.hpAfter ?? "?"))})${target.revived ? ` — ${escapeHTML(revivedNote(target.revived))}` : ""}`
        : `<strong>Healed</strong> — no save; restores the spell's ${escapeHTML(state.dualMode?.energy ?? "")} roll${state.damage?.total != null ? ` (${escapeHTML(String(state.damage.total))} HP)` : ""} at Finalize`;
}

/** An ally in an ally/enemy area: no save; healed by the ally roll and given the spell's Effect at Finalize. */
function allySummary(state, target) {
    const bonus = state.allySplit?.bonus, temp = state.allySplit?.tempHP;
    const benefit = bonus ? `+${bonus.value} ${bonus.type} bonus to ${bonus.statistic} saves for ${bonus.duration}`
        : temp ? `${temp.base + temp.step * Math.max(0, Number(state.castRank) - temp.rank)} temporary Hit Points for ${temp.duration}` : "the spell's Effect";
    // (Roar of Freedom: the Effect's temporary Hit Points, no healing.)
    if (!state.allySplit?.healing) return target.applicationStatus === "applied" ? `<strong>Ally</strong> — ${escapeHTML(benefit)}` : `<strong>Ally</strong> — no save; ${escapeHTML(benefit)} at Finalize`;
    return target.applicationStatus === "applied"
        ? `<strong>Ally</strong> — healed ${escapeHTML(String(target.damageResults?.[0]?.total ?? ""))} HP (${escapeHTML(String(target.hpBefore ?? "?"))} → ${escapeHTML(String(target.hpAfter ?? "?"))}) and ${escapeHTML(benefit)}`
        : `<strong>Ally</strong> — no save; healed (${escapeHTML(state.allySplit?.healing?.formula ?? "")}) and ${escapeHTML(benefit)} at Finalize`;
}

/** A creature within 5 feet of the attack's target: no roll; the splash damage on a hit. */
function splashSummary(target) {
    if (target.applicationStatus === "applied") return `<strong>Splash</strong> ${escapeHTML(String(target.damageResults?.[0]?.total ?? ""))} damage (${escapeHTML(String(target.hpBefore ?? "?"))} → ${escapeHTML(String(target.hpAfter ?? "?"))})`;
    if (target.splashNote) return `<strong>Splash</strong> — ${escapeHTML(target.splashNote)}`;
    return "<strong>Splash</strong> — within 5 feet of the target; takes the splash damage if the attack hits";
}

function resultSummary(state, target) {
    if (target.eligible === false) {
        return `<strong>Unaffected</strong>${target.eligibilityOverride ? "" : ` — ${escapeHTML(target.eligibilityReason ?? "invalid target")}`}`;
    }
    if (target.mode === "healing" && !target.excluded) return healingSummary(state, target);
    if (target.mode === "ally" && !target.excluded) return allySummary(state, target);
    if (target.mode === "trait-grant" && !target.excluded) return target.applicationStatus === "applied" ? `<strong>${escapeHTML(state.traitGrant?.label ?? "")}</strong> for ${escapeHTML(String(state.traitGrant?.duration?.value ?? ""))} ${escapeHTML(state.traitGrant?.duration?.unit ?? "")} (no save)` : `${escapeHTML(state.traitGrant?.trait ?? "")}: ${escapeHTML(state.traitGrant?.label ?? "")}, no save`;
    if (target.mode === "splash" && !target.excluded) return splashSummary(target);
    const multiplier = damageMultiplierForTarget(state, target);
    const formulas = [
        ...(outcomeForTarget(state, target)?.damage?.formulas ?? []),
        ...(secondaryOutcomeForTarget(state, target)?.damage?.formulas ?? [])
    ].map(entry => entry.formula);
    const damageLabels = [
        ...(multiplier > 0 ? [sharedDamageLabel(state, target)] : []),
        ...formulas
    ];
    const scale = damageLabels.length ? ` — ${escapeHTML(damageLabels.join(" + "))}` : " — no damage";
    const expectedEffects = [...outcomeEffectsForTarget(state, target).map(conditionLabel),
        ...(outcomeForTarget(state, target)?.nativeEffects ?? []).map(nativeOutcomeLabel),
        ...(outcomeForTarget(state, target)?.modifiers ?? []).map(generatedSpeedLabel),
        ...targetOutcomeNotes(state, target).map(note => `Note: ${note.label}`),
        ...(state.afflictionHandoff && outcomeForTarget(state, target)?.affliction ? [afflictionLabel(outcomeForTarget(state, target).affliction)] : []),
        ...(state.afflictionHandoff ? afflictionExtraLabels(outcomeForTarget(state, target)) : []),
        ...(outcomeForTarget(state, target)?.conditionFloor ? [conditionFloorLabel(outcomeForTarget(state, target).conditionFloor, target.secondaryOf)] : [])];
    if (secondaryOutcomeForTarget(state, target)?.terminal?.kind === "death") expectedEffects.push("Dies");
    expectedEffects.push(...primaryRowLabels(outcomeForTarget(state, target)));
    const appliedEffects = (target.conditionResults ?? []).map(appliedConditionLabel);
    if (target.terminalApplied) appliedEffects.push(target.terminalResult?.label ?? "Dead");
    const effects = target.applicationStatus === "applied" ? appliedEffects : expectedEffects;
    const effectSummary = effects.length ? ` — ${effects.map(escapeHTML).join(", ")}` : "";
    const reroll = target.reroll ? ` <span class="pf2e-auto-save-reroll">(revision ${target.rollRevision})</span>` : "";
    const applied = target.applicationStatus === "applied" ? " <strong>Applied</strong>" : "";
    const review = target.reviewRequired ? " <strong class=\"warning\">Manual review</strong>" : "";
    return `${saveResultBadge(target)}${scale}${effectSummary}${forcedMovementNote(state, target)}${reroll}${applied}${review}`;
}

function damageTotalHTML(state) {
    const total = confirmedDamageSummary(state);
    return `<p><strong>Total damage to group${total.incomplete ? " (incomplete confirmed subtotal)" : ""}: ${total.damage}</strong>${total.healing ? `; healing: ${total.healing}` : ""}</p>`;
}

function waitForActor(actor, predicate, timeout = 4000) {
    if (predicate(actor)) return Promise.resolve(true);
    return new Promise(resolve => {
        const timer = setTimeout(() => { Hooks.off("updateActor", hook); resolve(predicate(actor)); }, timeout);
        const hook = Hooks.on("updateActor", document => {
            if (document.uuid !== actor.uuid || !predicate(document)) return;
            clearTimeout(timer); Hooks.off("updateActor", hook); resolve(true);
        });
    });
}

/**
 * One damage type's part of what a creature took: that instance's rolled total with PF2e's recorded IWR for that type (its receipt's
 * applications), never recomputed. An application PF2e records for a type the roll doesn't name (resistance to all damage) can't be
 * attributed to one part, so the GM reviews it.
 */
function typedPortion(target, result, type) {
    const iwr = result.receipt?.iwr;
    if (!Array.isArray(iwr)) throw new Error(`${target.name}: PF2e's record of the resistances and weaknesses applied is unavailable.`);
    const instances = result.instances ?? [];
    const types = new Set(instances.map(instance => String(instance.type ?? "").toLowerCase()));
    const stray = iwr.filter(entry => !entry.ignored && !types.has(String(entry.type ?? "").toLowerCase()));
    if (stray.length) throw new Error(`${target.name}: PF2e applied ${stray.map(entry => `${entry.category} (${entry.type})`).join(", ")}, which can't be split by damage type.`);
    const own = iwr.filter(entry => !entry.ignored && String(entry.type ?? "").toLowerCase() === type);
    if (own.some(entry => entry.category === "immunity")) return 0;
    const rolled = instances.filter(instance => String(instance.type ?? "").toLowerCase() === type).reduce((sum, instance) => sum + Number(instance.total ?? 0), 0);
    const part = Math.max(0, rolled + own.reduce((sum, entry) => sum + Number(entry.adjustment ?? 0), 0));
    return Math.min(part, Number(result.receipt.damage ?? 0));
}

/** Damage-derived temporary HP or healing for the caster, from confirmed receipts only. */
async function applyCasterBenefit(state, journal, ongoing, createdEffects) {
    const benefit = state.casterBenefit;
    const applied = state.targets.filter(target => targetParticipates(target) && target.applicationStatus === "applied");
    // "1d4 temporary Hit Points for every living creature in the line": the dice once for each living target (PF2e's mode of being).
    let rolled = null;
    if (benefit.measure === "dice-per-living") {
        let living = 0;
        for (const target of applied) { const { actor } = await resolveTargetDocuments(target); if (actor && (actor.modeOfBeing ?? "living") === "living") living++; }
        rolled = { living, total: 0 };
        if (living) {
            const roll = await new Roll(`${living * benefit.dice.count}d${benefit.dice.faces}`).evaluate();
            rolled.total = roll.total; rolled.formula = roll.formula;
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(state.sourceActorUuid) }),
                flavor: `${escapeHTML(state.spellName)}: temporary Hit Points (${living} living creature${living === 1 ? "" : "s"})` });
        }
    }
    const counted = (benefit.condition === "target-killed" ? applied.filter(target => target.killedBySpell) : applied)
        // (Only the rows that state it: Fearful Feast's failures.)
        .filter(target => !Array.isArray(benefit.degrees) || benefit.degrees.includes(target.degree));
    const damages = counted.map(target => {
        const dealt = (target.damageResults ?? []).reduce((total, result) => {
            if (result.receipt?.status !== "confirmed") throw new Error(`${target.name}: an unconfirmed damage receipt cannot fund a caster benefit.`);
            if (benefit.portion === "type") return total + typedPortion(target, result, benefit.damageType);
            return total + Number(result.receipt.damage ?? 0);
        }, 0);
        // "the total amount of HP the target loses, including the HP lost from becoming Drained": its Hit Points before the
        // damage less those after its row.
        // "If the target's Hit Points were lower than the damage you dealt, … their remaining Hit Points instead."
        if (benefit.measure === "hp-capped") {
            if (!Number.isFinite(Number(target.hpBefore))) throw new Error(`${target.name}: its Hit Points before the damage weren't recorded.`);
            return Math.min(dealt, Math.max(0, Number(target.hpBefore)));
        }
        if (benefit.measure !== "hp-lost") return dealt;
        if (!Number.isFinite(Number(target.hpBefore)) || !Number.isFinite(Number(target.hpAfter))) throw new Error(`${target.name}: the Hit Points it lost weren't recorded.`);
        return Math.max(0, Number(target.hpBefore) - Number(target.hpAfter));
    });
    const base = rolled ? rolled.total : damages.length ? (benefit.aggregate === "max-target" ? Math.max(...damages) : damages[0]) : 0;
    const amount = Math.floor(base * benefit.fraction);
    const result = { kind: benefit.kind, base, amount, healing: 0, temporaryHP: 0, status: "none", ...(rolled ? { living: rolled.living, formula: rolled.formula ?? null } : {}) };
    if (amount <= 0) return result;
    const caster = await fromUuid(state.sourceActorUuid);
    let temporary = amount;
    if (benefit.kind === "heal-then-temp" || benefit.kind === "heal") {
        const tokens = caster.getActiveTokens?.(false, true) ?? [];
        if (tokens.length !== 1) throw new Error(`${state.spellName}: the caster needs exactly one token on the scene to regain Hit Points.`);
        const wasDying = isDying(caster);
        const receipt = await applyDamageWithReceipt(caster, { damage: -amount, token: tokens[0], skipIWR: true, rollOptions: new Set() }, randomID());
        result.healing = receipt.healing;
        // Healed back from Dying: Dying and Unconscious end, Wounded rises (dying-recovery.js).
        const revived = await recoverFromDying(caster, wasDying);
        if (revived) result.revived = revived;
        temporary = benefit.kind === "heal" ? 0 : Math.max(0, amount - receipt.healing);
    }
    result.status = "applied";
    if (temporary <= 0) return result;
    const before = Number(caster._source?.system?.attributes?.hp?.temp ?? caster.system?.attributes?.hp?.temp ?? 0);
    // PF2e's TempHP rule applies only a strictly higher value; never create an
    // Effect that would not become the temporary HP source.
    if (temporary <= before) {
        result.status = "kept-existing";
        result.existingTemporaryHP = before;
        return result;
    }
    const [effect] = await caster.createEmbeddedDocuments("Item", [{
        name: `${state.spellName}: Temporary Hit Points`, type: "effect", img: "icons/svg/regen.svg",
        flags: { [MODULE_ID]: { outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid,
            sourceItemName: state.spellName, casterBenefit: { amount: temporary }, conditions: [] } } },
        system: {
            description: { value: `<p>Temporary Hit Points from <strong>${escapeHTML(state.spellName)}</strong>; ${benefit.duration ? "any remaining are lost when this Effect ends" : "the spell states no duration, so they last until used"}.</p>` },
            duration: benefit.duration ? { value: benefit.duration.value, unit: benefit.duration.unit, expiry: benefit.duration.unit === "rounds" ? "turn-start" : null, sustained: false }
                : { value: -1, unit: "unlimited", expiry: null, sustained: false },
            context: { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: caster.uuid }, roll: null },
            level: { value: state.castRank },
            rules: [{ key: "TempHP", value: temporary, events: { onCreate: true, onTurnStart: false } }],
            start: { value: state.effectStart.value, initiative: state.effectStart.initiative },
            tokenIcon: { show: true }, traits: { value: [] }
        }
    }]);
    if (!effect) throw new Error(`${state.spellName}: the caster's temporary Hit Points Effect was not confirmed.`);
    createdEffects.push(effect);
    // PF2e writes the actor's temporary HP after the Effect is created.
    const confirmed = await waitForActor(caster, actor => tempHPSourceId(actor._source?.system?.attributes?.hp) === effect.id
        && Number(actor._source.system.attributes.hp.temp) === temporary);
    if (!confirmed) throw new Error(`${state.spellName}: PF2e did not confirm ${temporary} temporary Hit Points on the caster.`);
    if (journal) await ongoing.attach(journal, effect);
    result.temporaryHP = temporary;
    result.effectUuid = effect.uuid;
    return result;
}

function casterMarkHTML(state) {
    if (!state.casterMark) return "";
    if (!state.casterMarkResults) return `<p><strong>Caster (at Finalize):</strong> ${escapeHTML(state.casterMark.label)}, marking each target ${state.casterMark.kind === "strike-bonus" ? "you hit" : `that takes the persistent ${escapeHTML(state.casterMark.damageType)} damage`}.</p>`;
    return state.casterMarkResults.length
        ? `<p><strong>Caster:</strong> ${escapeHTML(state.casterMark.label)} marks ${escapeHTML(state.casterMarkResults.map(result => result.targetName).join(", "))}.</p>`
        : `<p><strong>Caster:</strong> no mark (no target took the persistent damage).</p>`;
}

function casterNoteHTML(state) {
    if (!state.casterNote) return casterMarkHTML(state);
    const duration = `${state.casterNote.duration.value} ${state.casterNote.duration.unit}`;
    if (state.casterNote.kind === "while-target-condition") return casterMarkHTML(state) + (state.casterNoteResult
        ? `<p><strong>Caster:</strong> ${state.casterNoteResult.count ? `${escapeHTML(state.casterNoteResult.name)} applied (until the creature's ${escapeHTML(state.casterNote.condition)} ends, up to ${escapeHTML(duration)})` : "no creature is affected; no caster note"}.</p>`
        : `<p><strong>Caster (at Finalize, for each creature that fails):</strong> ${escapeHTML(state.casterNote.castText.replace(/\n/g, " "))}</p>`);
    return casterMarkHTML(state) + (state.casterNoteResult
        ? `<p><strong>Caster:</strong> ${escapeHTML(state.casterNoteResult.name)} applied (while Sustained, up to ${escapeHTML(duration)}).</p>`
        : `<p><strong>Caster (at Finalize):</strong> a note while Sustained, up to ${escapeHTML(duration)}: ${escapeHTML(state.casterNote.castText.replace(/\n/g, " "))}</p>`);
}

/** "If this kills it, you gain …": the caster's Effect, before and after. */
function casterRowEffectHTML(state) {
    if (!state.casterRowEffect) return "";
    const effect = state.casterRowEffect;
    if (effect.kind === "trait-resistance") return state.casterRowEffectResult ? `<p><strong>Caster:</strong> ${escapeHTML(state.casterRowEffectResult.name)} (resistance ${escapeHTML(effect.value)} to ${escapeHTML(effect.types.join(" and "))}).</p>`
        : `<p class="pf2e-auto-gm-reminder"><strong>Caster:</strong> if a ${escapeHTML(effect.traits.join(", "))} target is ${escapeHTML(effect.condition)}, ${escapeHTML(effect.reference)} goes on the caster at Finalize.</p>`;
    return state.casterRowEffectResult ? `<p><strong>Caster:</strong> ${escapeHTML(state.casterRowEffectResult.name)} (a +${effect.value} ${escapeHTML(effect.type)} bonus; switch it on while it applies).</p>`
        : `<p class="pf2e-auto-gm-reminder"><strong>Caster:</strong> ${effect.kind === "cast" ? "" : "on a failed save, "}${escapeHTML(effect.reference)} goes on the caster at Finalize.</p>`;
}

function killEffectHTML(state) {
    if (state.casterConditionResult) return `<p><strong>Caster:</strong> ${escapeHTML(state.casterConditionResult.labels.join(", "))}${state.casterConditionResult.endsSpell === false ? "" : "; the spell ends"}.</p>`;
    if (!state.killEffect) return "";
    return `<p><strong>Caster:</strong> ${state.killEffectResult ? `${escapeHTML(state.killEffectResult.name)} applied` : `${escapeHTML(state.killEffect.label)} if this kills the target`}.</p>`;
}

function casterBenefitHTML(state) {
    const effectResult = state.casterEffectResult;
    const effectLine = !effectResult ? "" : effectResult.status === "applied"
        ? `<p><strong>Caster:</strong> ${escapeHTML(effectResult.name)} applied.</p>`
        : `<p><strong>Caster:</strong> no benefit (the attack didn't hit).</p>`;
    const result = state.casterBenefitResult;
    if (!result) return effectLine;
    const parts = [];
    if (result.healing) parts.push(`${result.healing} HP regained`);
    if (result.revived) parts.push(revivedNote(result.revived));
    if (result.temporaryHP) parts.push(`${result.temporaryHP} temporary HP (${state.casterBenefit.duration ? durationLabel(state.casterBenefit.duration) : "until used"})`);
    if (result.status === "kept-existing") parts.push(`kept existing ${result.existingTemporaryHP} temporary HP (higher than ${result.amount - result.healing})`);
    if (state.casterBenefit.measure === "dice-per-living") {
        if (result.status === "none") parts.push("no benefit (no living creature among the targets)");
        return `${effectLine}<p><strong>Caster:</strong> ${escapeHTML(parts.join("; "))}${result.living ? ` from ${escapeHTML(result.formula)} = ${escapeHTML(result.base)} (${escapeHTML(result.living)} living)` : ""}.</p>`;
    }
    if (result.status === "none") parts.push("no benefit (no qualifying damage)");
    return `${effectLine}<p><strong>Caster:</strong> ${escapeHTML(parts.join("; "))} from ${escapeHTML(result.base)} ${state.casterBenefit.measure === "hp-lost" ? "Hit Points lost (damage and Drained)" : state.casterBenefit.measure === "hp-capped" ? "damage (at most the target's Hit Points)" : "damage"}.</p>`;
}

function renderResultCard(state) {
    const rows = state.targets.map(target => {
        if (target.excluded) return `<li><strong>${escapeHTML(target.name)}</strong>: Excluded — no damage or effects${saveResultBadge(target)}${eligibilityNote(target)}</li>`;
        if (target.eligible === false) {
            return `<li><strong>${escapeHTML(target.name)}</strong>: Unaffected${target.eligibilityOverride ? "" : ` — ${escapeHTML(target.eligibilityReason ?? "invalid target")}`}${eligibilityNote(target)}</li>`;
        }
        if (target.mode === "healing") return `<li><strong>${escapeHTML(target.name)}</strong>: ${healingSummary(state, target)}${eligibilityNote(target)}</li>`;
        if (target.mode === "splash") return `<li><strong>${escapeHTML(target.name)}</strong>: ${splashSummary(target)}</li>`;
        const damage = (target.damageResults ?? []).flatMap(result => damageParts(result)
            .map(part => damageBadge(part, { multiplier: part.multiplier ?? (result.kind === "shared" ? result.multiplier : 1) })));
        const conditions = (target.conditionResults ?? []).map(appliedConditionLabel);
        if (target.terminalApplied) conditions.push(target.terminalResult?.label ?? "Dead");
        const confirmed = confirmedDamageSummary({ status: "completed", targets: [target] });
        const persistentApplied = (target.damageResults ?? []).some(result => result.receipt?.persistentIds?.length > 0)
            ? "<div>Persistent damage applied</div>" : "";
        const appliedDamage = target.damageResults?.length ? `<div>Damage applied: ${confirmed.damage}${confirmed.incomplete ? " (incomplete)" : ""}${confirmed.healing ? `; healing: ${confirmed.healing}` : ""}${target.damageSwapped ? ` (${escapeHTML(target.damageSwapped)} for this creature)` : ""}${target.resistanceHalved ? ` (${escapeHTML(target.resistanceHalved)})` : ""}</div>` : "";
        const effectDetails = (target.conditionResults ?? []).filter(result => result.status === "applied" && result.duration)
            .map(result => `${result.label}: ${durationLabel(result.duration)}`);
        const adjustments = conditionAdjustmentNote(target);
        const effectDetailsHTML = effectDetails.length || adjustments
            ? `<details><summary>Durations and GM adjustments</summary>${effectDetails.map(escapeHTML).join("; ")}${adjustments}</details>` : "";
        const conditionsHTML = (conditions.length
            ? `<div class="pf2e-auto-result-conditions">${conditions.map(escapeHTML).join(", ")}</div>`
            : "") + (target.effectNotes ?? []).map(note => `<div class="pf2e-auto-correction-note">${escapeHTML(note)}</div>`).join("")
            + (target.revived ? `<div class="pf2e-auto-correction-note">${escapeHTML(revivedNote(target.revived))}</div>` : "");
        const secondary = target.secondary
            ? `<div class="pf2e-auto-secondary-result"><strong>Secondary ${escapeHTML(secondarySaveForTarget(state, target)?.check?.statistic ?? "")} save</strong>${saveResultBadge(target.secondary)}</div>`
            : "";
        return `<li class="pf2e-auto-save-target"><div class="pf2e-auto-result-heading"><strong>${escapeHTML(target.name)}</strong>${saveResultBadge(target)}</div>${eligibilityNote(target)}${secondary}`
            + `${forcedMovementNote(state, target)}${appliedDamage}${persistentApplied}${damage.length ? `<details><summary>Damage calculations</summary><div class="pf2e-auto-damage-results">${damage.join("")}</div></details>` : ""}${conditionsHTML}${effectDetailsHTML}`
            + `${!damage.length && !conditions.length ? "<div>No damage or effects</div>" : ""}</li>`;
    }).join("");
    return `<section class="pf2e-auto-runtime-card pf2e-auto-save-result-card">
        <header><strong>${escapeHTML(state.spellName)} — Damage &amp; Effects</strong></header>
        ${(state.reminders ?? []).map(reminder => reminderHTML(reminder, escapeHTML)).join("")}
        <p>${state.saveStatistic === "strike" ? `Resolved at rank ${escapeHTML(state.castRank)} by the caster's Strike.` : state.saveStatistic === "spell-attack" ? `Resolved at rank ${escapeHTML(state.castRank)} by the caster's spell attack against each target's AC.` : `Resolved at rank ${escapeHTML(state.castRank)} against DC ${escapeHTML(state.dc)} ${escapeHTML(state.saveStatistic)}.`}</p>
        ${damageTotalHTML(state)}
        ${casterBenefitHTML(state)}
        ${killEffectHTML(state)}
        ${casterNoteHTML(state)}
        <ul class="pf2e-auto-save-targets">${rows}</ul>
    </section>`;
}

function castChoiceHTML(state, collecting) {
    const choice = state.castChoice;
    if (!choice) return "";
    const selected = choice.options.find(option => option.name === choice.selected);
    const buttons = collecting ? choice.options.map(option => `<button type="button" class="pf2e-auto-save-button" data-save-action="cast-choice"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${escapeHTML(option.name)}" ${option.name === choice.selected ? "disabled" : ""}>${escapeHTML(option.name)}</button>`).join("") : "";
    return `<div class="pf2e-auto-cast-choice"><p><strong>${escapeHTML(choice.label)}</strong> (${escapeHTML(choice.affliction)} stage ${escapeHTML(choice.stage)}): ${selected ? `<strong>${escapeHTML(selected.name)}</strong> — ${escapeHTML(selected.text)}` : "<em>not chosen</em>"}</p>${buttons}</div>`;
}

// "If you already dealt damage … increase the damage dice to d12s": asked once for the cast, before damage is rolled.
// "Roll [[/r 1d4]]. On a 1, … clumsy; …; on a 4, you choose": rolled when the card is made; a 4 asks the caster.
function conditionRollHTML(state, collecting) {
    const roll = state.conditionRoll;
    if (!roll) return "";
    // (A table's result names its row: "1d4: 3 — Yellow: frightened".)
    const label = roll.labels?.[roll.slug] ? `${escapeHTML(roll.labels[roll.slug])}: ` : "";
    // (A table read by degree: a failure's result, a critical failure's one higher.)
    if (roll.kind === "degree-results" && Number.isInteger(roll.rolled)) return `<p class="pf2e-auto-correction-note">${escapeHTML(roll.formula)}: ${escapeHTML(roll.rolled)} — a failure: ${escapeHTML(roll.labels?.[roll.rolled] ?? "")}; a critical failure (${escapeHTML(roll.rolled + Number(roll.criticalOffset ?? 0))}): ${escapeHTML(roll.labels?.[roll.rolled + Number(roll.criticalOffset ?? 0)] ?? "")}</p>`;
    // (Rolled notes: the row's note for that result.)
    if (roll.slug && roll.kind === "notes") return `<p class="pf2e-auto-correction-note">${escapeHTML(roll.formula)}: ${escapeHTML(roll.rolled ?? "")} — <strong>the note for ${escapeHTML(roll.labels?.[roll.slug] ?? roll.slug)}</strong></p>`;
    // (A critical failure's second roll: shown, and its choice asked once the first is known.)
    const second = roll.second ? (roll.second.slug ? ` A critical failure's second: ${escapeHTML(roll.second.rolled)} — <strong>${escapeHTML(roll.second.slug)}</strong>${roll.second.chosen ? " (the caster's choice)" : ""}.`
        : ` A critical failure's second rolled ${escapeHTML(roll.second.rolled)}: the caster chooses a different condition. ${collecting && roll.slug ? roll.options.filter(slug => slug !== roll.slug).map(slug => `<button type="button" class="pf2e-auto-save-button" data-save-action="condition-choice"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${escapeHTML(slug)}">${escapeHTML(slug)}</button>`).join("") : ""}`) : "";
    if (roll.slug) return `<p class="pf2e-auto-correction-note">${escapeHTML(roll.formula)}: ${escapeHTML(roll.rolled ?? "")} — ${label}<strong>${escapeHTML(roll.slug)}</strong>${roll.chosen ? " (the caster's choice)" : ""}.${second}</p>`;
    const buttons = collecting ? roll.options.map(slug => `<button type="button" class="pf2e-auto-save-button" data-save-action="condition-choice"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${escapeHTML(slug)}">${escapeHTML(slug)}</button>`).join("") : "";
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> the ${escapeHTML(roll.formula)} rolled ${escapeHTML(roll.rolled ?? "?")}; choose the condition. ${buttons}</div>`;
}

function casterChoiceHTML(state, collecting) {
    const choice = state.casterChoice;
    if (!choice) return "";
    // (A second pick for the rows that get two.)
    if (choice.selected && choice.twoOn?.length && !choice.also) return `<div class="pf2e-auto-confirmation">${escapeHTML(choice.label)}: <strong>${escapeHTML(choice.selected)}</strong>; on a ${escapeHTML(choice.twoOn.join(" or "))}, choose a second. ${collecting ? choice.values.filter(value => value !== choice.selected).map(value => `<button type="button" class="pf2e-auto-save-button" data-save-action="caster-choice"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${escapeHTML(value)}">${escapeHTML(value)}</button>`).join("") : ""}</div>`;
    if (choice.selected) return `<p class="pf2e-auto-correction-note">${escapeHTML(choice.label)}: <strong>${escapeHTML(choice.selected)}</strong>${choice.also ? ` and <strong>${escapeHTML(choice.also)}</strong>` : ""}</p>`;
    const buttons = collecting ? choice.values.map(value => `<button type="button" class="pf2e-auto-save-button" data-save-action="caster-choice"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${escapeHTML(value)}">${escapeHTML(value)}</button>`).join("") : "";
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> choose the ${escapeHTML(choice.label.toLowerCase())}. ${buttons}</div>`;
}

// "… deals additional mental damage equal to the counteract rank of the highest-level effect": the caster's number, before damage.
// "… you can choose which damage type increases for each rank": how many of the heightened dice are the second type.
function diceSplitHTML(state, collecting) {
    const split = state.diceSplit;
    if (!split) return "";
    if (split.answer != null) return `<p class="pf2e-auto-correction-note">Heightened dice: ${escapeHTML(split.steps - split.answer)} ${escapeHTML(split.from)}, ${escapeHTML(split.answer)} ${escapeHTML(split.to)}.</p>`;
    const buttons = collecting ? Array.from({ length: split.steps + 1 }, (_, value) => `<button type="button" class="pf2e-auto-save-button" data-save-action="dice-split"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${value}">${value}</button>`).join("") : "";
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> how many of the ${escapeHTML(split.steps)} heightened d${escapeHTML(split.faces)} are ${escapeHTML(split.to)} (the rest ${escapeHTML(split.from)})? ${buttons}</div>`;
}

// "Ground in the area becomes difficult terrain for 1 minute.": after Finalize, the GM selects the area's region and places the terrain.
function areaTerrainHTML(state) {
    const terrain = state.areaTerrain;
    if (!terrain) return "";
    const span = terrain.durationSeconds % 60 ? `${terrain.durationSeconds / 6} round${terrain.durationSeconds === 6 ? "" : "s"}` : `${terrain.durationSeconds / 60} minute${terrain.durationSeconds === 60 ? "" : "s"}`;
    // (A storm: its turn-end damage and Sustain go with it.)
    const stormFormula = terrain.hazard ? terrain.hazard.formula.replaceAll("@item.rank", String(Number(state.castRank))) : "";
    // (A flat formula of the rank reads as its number: "(floor(6/2))" is 3.)
    let stormAmount = stormFormula;
    try { if (!/d/.test(stormFormula)) stormAmount = String(Roll.safeEval(stormFormula)); } catch (_) {}
    // (Weapon Tide's: entering or ending a turn there, once a turn, of the caster's chosen type.)
    const hazardType = terrain.hazard?.chosenType ? state.casterChoice?.selected ?? "the chosen type of" : terrain.hazard?.type;
    const storm = terrain.hazard ? `, where ${terrain.hazard.enemiesOnly ? "an enemy" : "a creature"} ${terrain.hazard.events?.includes("enter") ? "moving into it or ending its turn there" : "ending its turn"} takes ${stormAmount} ${hazardType} damage (no save${terrain.hazard.oncePerTurn ? ", once a turn" : ""})${terrain.sustained ? "; Sustain it each turn" : ""}`
        : terrain.gmHazard ? ` and hazardous terrain (${(() => { try { return Roll.safeEval(terrain.gmHazard.formula.replaceAll("@item.rank", String(Number(state.castRank)))); } catch (_) { return terrain.gmHazard.formula; } })()} ${terrain.gmHazard.type} damage for each square a creature moves into: Ongoing spells control)${terrain.placed ? "" : "; select each burst's region"}` : "";
    if (terrain.placed) return `<p class="pf2e-auto-correction-note">${terrain.noTerrain ? "The area placed" : "Difficult terrain placed"} for ${escapeHTML(span)}${escapeHTML(storm)}.</p>`;
    // (Weapon Tide: only when it was cast with 3 actions.)
    const when = terrain.whenActions ? `Only if it was cast with ${terrain.whenActions} actions: ` : "";
    return `<div class="pf2e-auto-confirmation"><strong>GM:</strong> ${escapeHTML(when)}select the spell's area (its template's region), then ${terrain.noTerrain ? "keep it" : "make it difficult terrain"} for ${escapeHTML(span)}${escapeHTML(storm)}.${terrain.disbelief ? " Disbelief (a Perception check against the spell DC) is the area's control; a success halves the damage." : ""}
        <button type="button" class="pf2e-auto-save-button" data-save-action="area-terrain" data-message-id="${escapeHTML(state.messageId)}">Place the terrain</button></div>`;
}

function damageBonusHTML(state, collecting) {
    const bonus = state.damageBonus;
    if (!bonus) return "";
    if (bonus.answer != null) return `<p class="pf2e-auto-correction-note">${escapeHTML(bonus.question)} <strong>${escapeHTML(bonus.answer)}</strong>${bonus.answer ? ` (+${escapeHTML(bonus.answer)} ${escapeHTML(bonus.type)} damage)` : ""}</p>`;
    const buttons = collecting ? bonus.choices.map(value => `<button type="button" class="pf2e-auto-save-button" data-save-action="damage-bonus"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${escapeHTML(value)}">${escapeHTML(value)}</button>`).join("") : "";
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> ${escapeHTML(bonus.question)} ${buttons}</div>`;
}

function castGateHTML(state, collecting) {
    const gate = state.castGate;
    if (!gate) return "";
    if (gate.answer != null) return `<p class="pf2e-auto-correction-note">${escapeHTML(gate.question)} <strong>${gate.answer === "yes" ? "Yes" : "No — no creature is affected"}</strong></p>`;
    const buttons = collecting ? ["yes", "no"].map(answer => `<button type="button" class="pf2e-auto-save-button" data-save-action="cast-gate"
        data-message-id="${escapeHTML(state.messageId)}" data-answer="${answer}">${answer === "yes" ? "Yes" : "No"}</button>`).join("") : "";
    return `<div class="pf2e-auto-confirmation"><strong>GM:</strong> ${escapeHTML(gate.question)} ${buttons}</div>`;
}

function persistentRiderHTML(state, collecting) {
    const rider = state.persistentRider;
    if (!rider) return "";
    if (rider.answer) return `<p class="pf2e-auto-correction-note">${escapeHTML(rider.question)} <strong>${rider.answer === "yes" ? `Yes — ${escapeHTML(rider.castAmount)} persistent damage of the chosen type` : "No"}</strong></p>`;
    const buttons = collecting && !state.damage?.rollJSON ? ["yes", "no"].map(answer => `<button type="button" class="pf2e-auto-save-button" data-save-action="persistent-rider"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${answer}">${answer === "yes" ? "Yes" : "No"}</button>`).join("") : "";
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> ${escapeHTML(rider.question)} ${buttons}</div>`;
}

/** Final Sacrifice's minion (a select of the scene's minion tokens) or Bony Barrage's thrall reminder. */
function sacrificeHTML(state, collecting) {
    const sacrifice = state.sacrifice;
    if (!sacrifice) return "";
    if (sacrifice.pick === "thrall") return `<p class="pf2e-auto-gm-reminder"><strong>GM:</strong> ${escapeHTML(sacrifice.reminder)}</p>`;
    if (sacrifice.selected) return `<p class="pf2e-auto-correction-note">Destroyed: <strong>${escapeHTML(sacrifice.selectedName)}</strong> (slain)${sacrifice.retyped ? ` — the damage is ${escapeHTML(sacrifice.typeByTrait.type)}` : ""}.</p>`;
    const caster = state.sourceActorUuid;
    const options = (canvas?.scene?.tokens ?? []).filter(token => token.actor && token.actor.uuid !== caster && (token.actor.traits?.has?.(sacrifice.trait) ?? (token.actor.system?.traits?.value ?? []).includes(sacrifice.trait)))
        .map(token => `<option value="${escapeHTML(token.uuid)}">${escapeHTML(token.name)}</option>`).join("");
    const control = collecting && !state.damage?.rollJSON ? (options ? `<select class="pf2e-auto-sacrifice">${options}</select><button type="button" class="pf2e-auto-save-button" data-save-action="sacrifice"
        data-message-id="${escapeHTML(state.messageId)}">Destroy it</button>` : "<em>No token with the minion trait is on the scene.</em>") : "";
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> choose the minion the spell destroys. <span class="pf2e-auto-gm-reminder">GM: ${escapeHTML(sacrifice.question)}</span> ${control}</div>`;
}

/** Bony Barrage's bone armor: the caster's yes/no. */
function boneArmorHTML(state, collecting) {
    const armor = state.boneArmor;
    if (!armor) return "";
    if (armor.answer) return `<p class="pf2e-auto-correction-note">${escapeHTML(armor.question)} <strong>${armor.answer === "yes" ? `Yes — no damage and +${escapeHTML(armor.ac)} status to AC for the caster and its allies` : "No"}</strong></p>`;
    const buttons = collecting && !state.damage?.rollJSON ? ["yes", "no"].map(answer => `<button type="button" class="pf2e-auto-save-button" data-save-action="bone-armor"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${answer}">${answer === "yes" ? "Yes" : "No"}</button>`).join("") : "";
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> ${escapeHTML(armor.question)} ${buttons}</div>`;
}

/** The caster and its allies (PF2e alliances) among the targets, when the bone armor is taken. */
async function markBoneArmor(state) {
    const caster = await fromUuid(state.sourceActorUuid);
    const mine = caster ? actorAlliance(caster) : null;
    for (const target of state.targets) {
        const { actor } = await resolveTargetDocuments(target);
        target.boneArmor = state.boneArmor?.answer === "yes" && !!actor && (actor.uuid === state.sourceActorUuid || (!!mine && actorAlliance(actor) === mine));
    }
}

/** A formula with more dice of one type: "{12d6[piercing]}" + 2d6 piercing → "{14d6[piercing]}"; "(@item.rank - 4)d8[bleed]" + 1d8 → "(@item.rank - 4 + 1)d8[bleed]". */
function addDice(formula, dice, spellName) {
    const pattern = new RegExp(`(\\d+|\\([^()]+\\))d${dice.faces}(\\[(?:[a-z]+,)*${dice.type}\\])`, "g");
    const matches = String(formula).match(pattern) ?? [];
    if (matches.length !== 1) throw new Error(`${spellName}: the ${dice.type} dice to add to aren't one d${dice.faces} term (${formula}).`);
    return String(formula).replace(pattern, (all, count, tail) => /^\d+$/.test(count) ? `${Number(count) + dice.count}d${dice.faces}${tail}` : `(${count.slice(1, -1)} + ${dice.count})d${dice.faces}${tail}`);
}

function diceUpgradeHTML(state, collecting) {
    const upgrade = state.diceUpgrade;
    if (!upgrade) return "";
    // (A basic save's added dice have no persistent part: Draw the Lightning's stormy sky.)
    const yes = upgrade.adds ? `Yes — +${upgrade.adds.dice.count}d${upgrade.adds.dice.faces} ${upgrade.adds.dice.type}${upgrade.adds.persistent ? `, +${upgrade.adds.persistent.count}d${upgrade.adds.persistent.faces} persistent ${upgrade.adds.persistent.type} on a critical hit` : ""}`
        : `Yes — d${upgrade.faces} dice`;
    if (upgrade.answer) return `<p class="pf2e-auto-correction-note">${escapeHTML(upgrade.question)} <strong>${upgrade.answer === "yes" ? escapeHTML(yes) : "No"}</strong></p>`;
    const buttons = collecting && !state.damage?.rollJSON ? ["yes", "no"].map(answer => `<button type="button" class="pf2e-auto-save-button" data-save-action="dice-upgrade"
        data-message-id="${escapeHTML(state.messageId)}" data-choice="${answer}">${answer === "yes" ? "Yes" : "No"}</button>`).join("") : "";
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> ${escapeHTML(upgrade.question)} ${buttons}</div>`;
}

// "If the target takes damage, a willing creature … gains fast healing …": after a damaging save, the caster grants PF2e's Effect to the
// willing creature they target (once).
function beneficiaryHTML(state) {
    const benefit = state.beneficiaryEffect;
    if (!benefit) return "";
    if (benefit.grantedTo) return `<p class="pf2e-auto-correction-note">${escapeHTML(benefit.label)}: granted to <strong>${escapeHTML(benefit.grantedTo)}</strong>.</p>`;
    const damaged = (state.targets ?? []).some(target => Number(confirmedDamageSummary({ status: "completed", targets: [target] }).damage ?? 0) > 0);
    if (!damaged) return `<p class="pf2e-auto-correction-note">${escapeHTML(benefit.label)}: the target took no damage, so no creature gains it.</p>`;
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> target the willing creature within range, then grant it ${escapeHTML(benefit.label)}.
        <button type="button" class="pf2e-auto-save-button" data-save-action="beneficiary-effect" data-message-id="${escapeHTML(state.messageId)}">Grant to targeted creature</button></div>`;
}

// "You or an ally of your choice within 30 feet of the thrall regains Hit Points equal to double the amount the creature lost.": after
// Finalize, the caster targets the creature to heal.
function healBackLost(state) {
    const degrees = state.healBack?.degrees ?? [];
    return (state.targets ?? []).filter(target => targetParticipates(target) && degrees.includes(target.degree) && Number.isFinite(Number(target.hpBefore)) && Number.isFinite(Number(target.hpAfter)))
        .map(target => ({ name: target.name, lost: Math.max(0, Number(target.hpBefore) - Number(target.hpAfter)) }));
}
// "… and the other target is Quickened for 1 round.": after Finalize, the caster targets itself or an ally and grants the foe's row's condition.
function partnerDegree(state) {
    const degrees = (state.targets ?? []).filter(target => targetParticipates(target) && target.degree).map(target => target.degree);
    return degrees.length === 1 ? degrees[0] : null;
}
/** Call the Blood: the Hit Points the (non-caster) target lost to the spell, and what the caster is. */
function casterDrawLost(state) {
    return (state.targets ?? []).filter(target => targetParticipates(target) && target.actorUuid !== state.sourceActorUuid)
        .reduce((total, target) => total + (target.damageResults ?? []).reduce((sum, entry) => sum + Math.max(0, Number(entry.receipt?.damage ?? 0)), 0), 0);
}
function casterDrawMode(actor) {
    const voidHealing = actor?.system?.attributes?.hp?.negativeHealing === true || actor?.attributes?.hp?.negativeHealing === true;
    const being = actor?.modeOfBeing ?? ((actor?.traits?.has?.("undead") ?? false) ? "undead" : "living");
    return being === "undead" || (being === "living" && voidHealing) ? "undead" : being === "living" ? "living" : "none";
}

function healSpreadHTML(state) {
    const spread = state.healSpread;
    if (!spread) return "";
    if (spread.healed) return `<p class="pf2e-auto-correction-note">Healed ${escapeHTML(spread.healed.amount)} Hit Points: ${escapeHTML(spread.healed.names.join(", "))}.</p>`;
    const amount = Math.max(0, ...(state.targets ?? []).filter(targetParticipates).map(target => (target.damageResults ?? []).reduce((sum, entry) => sum + Math.max(0, Number(entry.receipt?.damage ?? 0)), 0)));
    if (amount <= 0) return `<p class="pf2e-auto-correction-note">No creature took damage: no one regains Hit Points.</p>`;
    return `<div class="pf2e-auto-confirmation"><strong>GM:</strong> target the living creatures in the second cone (the caster is included), then heal them ${escapeHTML(amount)} Hit Points.
        <button type="button" class="pf2e-auto-save-button" data-save-action="heal-spread" data-message-id="${escapeHTML(state.messageId)}">Heal the caster and the targeted creatures</button></div>`;
}

function casterDrawHTML(state) {
    const draw = state.casterDraw;
    if (!draw) return "";
    if (draw.result) return `<p class="pf2e-auto-correction-note">${escapeHTML(draw.result)}</p>`;
    const lost = casterDrawLost(state);
    if (lost <= 0) return `<p class="pf2e-auto-correction-note">The target took no damage: no blood flows.</p>`;
    let caster = null; try { caster = fromUuidSync(state.sourceActorUuid); } catch (_) {}
    const mode = casterDrawMode(caster);
    const button = (choice, label) => `<button type="button" class="pf2e-auto-save-button" data-save-action="caster-draw" data-choice="${choice}" data-message-id="${escapeHTML(state.messageId)}">${escapeHTML(label)}</button>`;
    if (mode === "living") return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> the blood flows into your mouth (living, no void healing). ${button("living", `${draw.living.name} ${draw.living.value}`)}</div>`;
    if (mode === "undead") {
        const temp = Math.floor(lost * draw.undead.fraction);
        return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> choose. ${button("temp", `${temp} temporary Hit Points and ${draw.undead.condition.name} for ${draw.undead.withTemp.value} round`)} ${button("quickened", `${draw.undead.condition.name} for ${draw.undead.without.value} minute`)}</div>`;
    }
    return `<p class="pf2e-auto-correction-note">The caster is neither living nor undead: the blood has no effect.</p>`;
}

function partnerGrantHTML(state) {
    const partner = state.partnerGrant;
    if (!partner) return "";
    if (partner.grantedTo) return `<p class="pf2e-auto-correction-note">${escapeHTML(partner.grantedTo.condition)}: granted to <strong>${escapeHTML(partner.grantedTo.name)}</strong>.</p>`;
    const row = partner.rows?.[partnerDegree(state)];
    if (!row) return `<p class="pf2e-auto-correction-note">The other target is unaffected.</p>`;
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> target yourself or the ally, then grant it ${escapeHTML(row.name)} for ${escapeHTML(row.duration.value)} ${escapeHTML(row.duration.value === 1 ? row.duration.unit.replace(/s$/, "") : row.duration.unit)}.${partner.restriction ? ` ${escapeHTML(partner.restriction)}` : ""}
        <button type="button" class="pf2e-auto-save-button" data-save-action="partner-grant" data-message-id="${escapeHTML(state.messageId)}">Grant to targeted creature</button></div>`;
}

function healBackHTML(state) {
    const heal = state.healBack;
    if (!heal) return "";
    if (heal.grantedTo) return `<p class="pf2e-auto-correction-note">Healed: <strong>${escapeHTML(heal.grantedTo)}</strong> regained ${escapeHTML(heal.amount)} Hit Points.</p>`;
    const lost = healBackLost(state);
    if (!lost.length || lost.every(entry => entry.lost <= 0)) return `<p class="pf2e-auto-correction-note">No Hit Points were lost, so no creature is healed.</p>`;
    const amount = Math.floor(lost.reduce((total, entry) => total + entry.lost, 0) * heal.multiplier);
    return `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> target yourself or an ally within ${escapeHTML(heal.within.feet)} feet of the ${escapeHTML(heal.within.of)}: it regains ${escapeHTML(amount)} Hit Points (${heal.multiplier === 2 ? "double" : "half"} the ${escapeHTML(lost.map(entry => `${entry.lost} ${entry.name}`).join(", "))} lost). A creature healed by this spell can't be again for ${escapeHTML(heal.onceEvery.value)} ${escapeHTML(heal.onceEvery.unit)}.
        <button type="button" class="pf2e-auto-save-button" data-save-action="heal-back" data-message-id="${escapeHTML(state.messageId)}">Heal the targeted creature</button></div>`;
}

function renderCard(state) {
    const readiness = saveCollectionReadiness(state);
    const collecting = state.status === "collecting";
    const unrolledSaves = state.targets.flatMap(target => {
        if (!targetParticipates(target) || target.applicationStatus !== "pending") return [];
        return [
            ...(!target.degree ? [{ target, stage: "primary" }] : []),
            ...(target.secondary && !target.secondary.degree ? [{ target, stage: "secondary" }] : [])
        ];
    });
    const damage = state.damage?.enabled === false
        ? `<p><strong>Shared damage:</strong> none</p>`
        : state.damage?.rollJSON
            ? `<div><strong>Shared damage:</strong>${damageRollBadges(state.damage)}</div>`
            : `<p><strong>Shared damage:</strong> rolls when saves are finalized</p>`;
    const requiredRolls = requiredOutcomeDamageRolls(state);
    const outcomeDamage = !state.outcomes
        ? ""
        : unrolledSaves.length
            ? `<p><strong>Outcome damage:</strong> waiting for all saves</p>`
            : requiredRolls.length === 0
            ? `<p><strong>Outcome damage:</strong> none required</p>`
            : `<div class="pf2e-auto-outcome-damage"><strong>Outcome damage:</strong>${requiredRolls.map(entry =>
                `<div>${entry.rollJSON ? damageRollBadges(entry) : `${escapeHTML(entry.formula)} — rolls when finalized`}</div>`
            ).join("")}</div>`;
    const rows = state.targets.map(target => target.excluded
        ? `<li class="pf2e-auto-save-target"><details><summary><strong>${escapeHTML(target.name)}</strong> — Excluded</summary>${saveResultBadge(target)}${target.secondary ? saveResultBadge(target.secondary) : ""}${eligibilityNote(target)}</details>${correctionControls(state, target)}</li>`
        : `
        <li class="pf2e-auto-save-target">
            <div><strong>${escapeHTML(target.name)}</strong>: ${resultSummary(state, target)}</div>
            ${target.confirmation?.status === "pending" && collecting ? `<div class="pf2e-auto-confirmation"><strong>GM:</strong> ${escapeHTML(target.confirmation.question)}
                ${correctionButton(state, target, "affected", "Yes — affected")}${correctionButton(state, target, "unaffected", "No — immune")}</div>`
                : target.confirmation ? `<small class="pf2e-auto-correction-note">GM confirmed: ${escapeHTML(target.confirmation.status === "affected" ? "affected" : "immune")}</small>` : ""}
            ${gmQuestionGates(state, target).map(gate => !gateAnswerFor(target, gate) && collecting ? `<div class="pf2e-auto-confirmation"><strong>GM:</strong> ${escapeHTML(target.name)}: ${escapeHTML(gate.question)}
                ${correctionButton(state, target, "gate-yes", "Yes", "primary", gate.key ?? "")}${correctionButton(state, target, "gate-no", "No", "primary", gate.key ?? "")}</div>`
                : gateAnswerFor(target, gate) ? `<small class="pf2e-auto-correction-note">GM answered${gate.key ? ` (${escapeHTML(gate.question)})` : ""}: ${escapeHTML(gateAnswerFor(target, gate))}</small>` : "").join("")}
            ${state.targetUpgrade && targetParticipates(target) && !target.upgradeAnswer && collecting && !state.damage?.rollJSON ? `<div class="pf2e-auto-confirmation"><strong>Caster:</strong> ${escapeHTML(target.name)}: ${escapeHTML(state.targetUpgrade.question)}
                ${correctionButton(state, target, "upgrade-yes", "Yes")}${correctionButton(state, target, "upgrade-no", "No")}</div>`
                : target.upgradeAnswer ? `<small class="pf2e-auto-correction-note">Caster answered: ${escapeHTML(target.upgradeAnswer.answer)}${target.upgradeAnswer.answer === "yes" ? ` (${escapeHTML(state.targetUpgrade?.formula ?? "")})` : ""}</small>` : ""}
            ${target.attackAdjustment?.status === "pending" && collecting ? `<div class="pf2e-auto-confirmation"><strong>GM:</strong> ${escapeHTML(state.attackAdjustment?.question ?? "")}
                ${(state.attackAdjustment?.choices ?? []).map(choice => correctionButton(state, target, "attack-adjustment", choice.label, "primary", String(choice.value))).join("")}</div>`
                : target.attackAdjustment?.status === "answered" ? `<small class="pf2e-auto-correction-note">GM answered: ${escapeHTML(target.attackAdjustment.label)}</small>` : ""}
            ${target.attributeCondition?.status === "pending" && collecting ? `<div class="pf2e-auto-confirmation"><strong>GM:</strong> ${escapeHTML(target.name)}'s highest attributes tie (${escapeHTML(target.attributeCondition.attributes.join(", "))}); the creature chooses:
                ${target.attributeCondition.options.map(slug => correctionButton(state, target, "attribute-condition", slug, "primary", slug)).join("")}</div>`
                : target.attributeCondition?.slug ? `<small class="pf2e-auto-correction-note">Condition by highest attribute (${escapeHTML(target.attributeCondition.attributes.join(", "))}): ${escapeHTML(target.attributeCondition.slug)}</small>` : ""}
            ${target.zone?.status === "pending" && collecting ? `<div class="pf2e-auto-confirmation"><strong>GM:</strong> ${escapeHTML(state.traitVariant?.question ?? "")}
                ${(state.traitVariant?.values ?? []).map(value => correctionButton(state, target, "zone", state.traitVariant.labels?.[value] ?? `The ${value} square`, "primary", value)).join("")}</div>`
                : target.zone?.status === "chosen" ? `<small class="pf2e-auto-correction-note">${state.traitVariant?.labels ? escapeHTML(state.traitVariant.labels[target.zone.value] ?? target.zone.value) : `In the ${escapeHTML(target.zone.value)} square`}</small>` : ""}
            ${target.bolster?.status === "pending" && collecting ? `<div class="pf2e-auto-confirmation"><strong>GM:</strong> ${escapeHTML(state.bolster?.question ?? "")}
                ${correctionButton(state, target, "bolstered", "Yes — bolstered (no save)")}${correctionButton(state, target, "not-bolstered", "No — it saves")}</div>`
                : target.bolster?.status === "bolstered" ? `<small class="pf2e-auto-correction-note">Bolstered: no save; ${escapeHTML(state.bolster?.label ?? "the spell's Effect")} at Finalize${target.bolster.applied ? " (applied)" : ""}</small>` : ""}
            ${target.degreeAdjustment?.status === "pending" && collecting ? `<div class="pf2e-auto-confirmation"><strong>GM:</strong> ${escapeHTML(target.degreeAdjustment.question)}
                ${target.degreeAdjustment.choices ? target.degreeAdjustment.choices.map(choice => correctionButton(state, target, "adjustment-choice", escapeHTML(choice.label), "primary", choice.key)).join("")
                    + correctionButton(state, target, "adjustment-not-applicable", "Neither")
                    : `${correctionButton(state, target, "adjustment-applies", "Yes — adjust degree")}${correctionButton(state, target, "adjustment-not-applicable", "No")}`}</div>` : ""}
            ${target.degreeAdjustment?.to && target.degreeAdjustment.to !== target.degreeAdjustment.from ? `<small class="pf2e-auto-correction-note">Spell rule: ${escapeHTML(readableSaveDegree(target.degreeAdjustment.from))} → ${escapeHTML(readableSaveDegree(target.degreeAdjustment.to))}${target.degreeAdjustment.traits ? ` (${escapeHTML(target.degreeAdjustment.traits.join("/"))} creature)` : ""}${target.degreeAdjustment.immunities ? ` (immune to ${escapeHTML(target.degreeAdjustment.immunities.join("/"))})` : ""}${target.degreeAdjustment.caster ? " (the caster)" : ""}</small>` : ""}
            ${eligibilityNote(target)}${correctionControls(state, target)}
            ${target.eligible === false || target.mode === "healing" || target.mode === "splash" || target.mode === "ally" || target.mode === "trait-grant" ? "" : `<button type="button" class="pf2e-auto-save-button" data-save-action="roll-save"
                data-message-id="${escapeHTML(state.messageId)}" data-target-id="${escapeHTML(target.id)}"
                data-save-stage="primary"
                title="Shift-click toggles PF2e's save dialog."
                ${target.applicationStatus !== "pending" || !collecting ? "disabled" : ""}>
                <i class="fa-solid fa-dice-d20"></i> ${state.saveStatistic === "strike" ? (target.degree ? "Read Strike Again" : "Read Strike Result") : state.saveStatistic === "spell-attack" ? (target.degree ? "Roll Attack Again" : "Roll Spell Attack") : target.degree ? "Roll Save Again" : `Roll ${escapeHTML(state.saveChoice?.length ? `${state.saveChoice.join(" or ")} (better)` : state.saveStatistic)} Save`}
            </button>${target.supportsHeroPoints && target.degree && collecting ? `<button type="button" class="pf2e-auto-save-button"
                data-save-action="hero-reroll" data-message-id="${escapeHTML(state.messageId)}" data-target-id="${escapeHTML(target.id)}" data-save-stage="primary">
                <i class="fa-solid fa-circle-h"></i> Hero Point Reroll
            </button>` : ""}${target.secondary ? `<div class="pf2e-auto-secondary-save"><strong>Secondary ${escapeHTML(secondarySaveForTarget(state, target)?.check?.statistic ?? "")} save</strong>
                <div>${saveResultBadge(target.secondary)}</div>
                <button type="button" class="pf2e-auto-save-button" data-save-action="roll-save"
                    data-message-id="${escapeHTML(state.messageId)}" data-target-id="${escapeHTML(target.id)}" data-save-stage="secondary"
                    title="Shift-click toggles PF2e's save dialog." ${target.applicationStatus !== "pending" || !collecting ? "disabled" : ""}>
                    <i class="fa-solid fa-dice-d20"></i> ${target.secondary.degree ? "Roll Secondary Save Again" : "Roll Secondary Save"}
                </button>${target.supportsHeroPoints && target.secondary.degree && collecting ? `<button type="button" class="pf2e-auto-save-button"
                    data-save-action="hero-reroll" data-message-id="${escapeHTML(state.messageId)}" data-target-id="${escapeHTML(target.id)}" data-save-stage="secondary">
                    <i class="fa-solid fa-circle-h"></i> Hero Point Reroll
                </button>` : ""}</div>` : ""}`}
        </li>`).join("");
    const review = state.reviewRequired
        ? `<p class="warning"><strong>Automation stopped:</strong> ${escapeHTML(state.reviewReason)}</p>`
        : "";
    const complete = state.status === "completed" ? `<p><strong>Resolution complete.</strong></p>${beneficiaryHTML(state)}${healBackHTML(state)}${partnerGrantHTML(state)}${casterDrawHTML(state)}${healSpreadHTML(state)}${areaTerrainHTML(state)}` : "";
    return `<section class="pf2e-auto-runtime-card pf2e-auto-basic-save-card">
        <header><strong>${escapeHTML(state.spellName)} — ${state.saveIsBasic !== false ? "Basic " : ""}Save Resolution</strong></header>
        ${(state.reminders ?? []).map((reminder, index) => reminderHTML(reminder, escapeHTML)
            + (["counteract-along-path", "counteract-overlap", "counteract-spell", "counteract-fixed"].includes(reminder.kind) && state.status !== "completed"
                ? `<button type="button" class="pf2e-auto-save-button" data-save-action="counteract-reminder" data-message-id="${escapeHTML(state.messageId)}" data-reminder-index="${index}"><i class="fa-solid fa-ban"></i> Counteract the ${escapeHTML(reminder.target)}</button>` : "")).join("")}${(state.dataNotes ?? []).map(note => `<p class="pf2e-auto-gm-reminder"><strong>PF2e data:</strong> ${escapeHTML(note)}</p>`).join("")}<p>${state.saveStatistic === "strike" ? "The caster's own PF2e Strike against the target decides the result (critical hit, hit, miss): make the Strike, then read its result" : state.saveStatistic === "spell-attack" ? "Spell attack against each target's AC (results are the attack's: critical hit, hit, miss)" : `DC ${escapeHTML(state.dc)} ${escapeHTML(state.saveChoice?.length ? `${state.saveChoice.join(" or ")} (the target's choice: its better save)` : state.saveStatistic)}`}; cast at rank ${escapeHTML(state.castRank)}.</p>
        ${castChoiceHTML(state, collecting)}${casterChoiceHTML(state, collecting)}${diceUpgradeHTML(state, collecting)}${sacrificeHTML(state, collecting)}${boneArmorHTML(state, collecting)}${persistentRiderHTML(state, collecting)}${damageBonusHTML(state, collecting)}${diceSplitHTML(state, collecting)}${castGateHTML(state, collecting)}${conditionRollHTML(state, collecting)}${casterNoteHTML(state)}${killEffectHTML(state)}${casterRowEffectHTML(state)}${damage}${outcomeDamage}<ul class="pf2e-auto-save-targets">${rows}</ul>${review}${complete}
        <div class="pf2e-auto-runtime-controls">
            <button type="button" class="pf2e-auto-save-button" data-save-action="roll-all"
                data-message-id="${escapeHTML(state.messageId)}" title="Shift-click toggles PF2e's save dialog for the entire sequence."
                ${!unrolledSaves.length || !collecting ? "disabled" : ""}>
                <i class="fa-solid fa-dice-d20"></i> ${unrolledSaves.length
                    ? `Roll All Unrolled Saves (${unrolledSaves.length})`
                    : "All Saves Rolled"}
            </button>
            <button type="button" class="pf2e-auto-save-button" data-save-action="add-targets"
                data-message-id="${escapeHTML(state.messageId)}" ${!collecting ? "disabled" : ""}>
                <i class="fa-solid fa-user-plus"></i> Add Current Targets
            </button>
            <button type="button" class="pf2e-auto-save-button" data-save-action="finalize"
                data-message-id="${escapeHTML(state.messageId)}" ${!readiness.ready || !collecting ? "disabled" : ""}>
                <i class="fa-solid fa-wand-magic-sparkles"></i> Finalize Saves &amp; Resolve
            </button>
        </div>
        ${!readiness.ready && collecting && !state.reviewRequired ? `<small>${escapeHTML(readiness.reason)}</small>` : ""}
    </section>`;
}

/** The caster's melee Strikes with a held weapon (or an NPC's melee attacks). */
function weaponStrikes(actor) {
    return (actor?.system?.actions ?? []).filter(strike => strike?.item && (strike.item.isMelee ?? strike.item.system?.range == null) && strike.ready !== false
        && (strike.item.type === "melee" || strike.item.isHeld !== false) && typeof strike.damage === "function" && typeof strike.critical === "function");
}

/** A click that skips PF2e's roll dialog (shift inverts the user's setting). */
function noDialogEvent() {
    return new MouseEvent("click", { shiftKey: game.user?.settings?.showDamageDialogs !== false });
}

/** PF2e's immunity to critical hits. */
function immuneToCriticalHits(actor) {
    return (actor?.system?.attributes?.immunities ?? []).some(immunity => immunity.type === "critical-hits");
}

export class BasicSaveRuntime {
    #jobs = new Map();
    ongoing = null;

    supports(plan) {
        return isExecutableSavePlan(plan);
    }

    canCoordinate(card) {
        return isCardCoordinator(card);
    }

    async start(spell, options = {}) {
        // (A spell lost to a disruption or a counterspell has no effect: casting-rules-runtime.js.)
        assertSpellNotLost(options?.sourceMessageId ?? null);
        // (A concealed or hidden target the spell's flat check missed is left out.)
        if (options?.sourceMessageId) {
            const kept = dropMissedTargets(options.sourceMessageId, options.targets ?? null);
            if (Array.isArray(kept) && !kept.length && (options.targets ?? [...(game.user?.targets ?? [])]).length) throw new Error("The spell's concealed or hidden flat check missed every target; it has no effect on them.");
            options = { ...options, targets: kept ?? options.targets };
        }
        rememberCastSpell(spell);
        // (A spellshape changing the cast's rank — Split Hex, Mythic Heightening, Simple Mastery: the rank the cast recorded.)
        // (The spellshapes' cast: the card's own, or — a held spell triggered later (Murmuration) — the cast that set it, for its riders only.)
        const shapeFrom = options.sourceMessageId ?? options.shapeMessageId ?? null;
        const shapedRank = options.sourceMessageId ? shapedCastRank(options.sourceMessageId) : null;
        if (shapedRank) options = { ...options, castRank: shapedRank };
        const basePlan = options.plan;
        if (!this.supports(basePlan)) throw new Error(`${basePlan?.source?.name ?? spell?.name ?? "Spell"} is not an executable save plan.`);
        // A heightened variant's rows at the cast rank (Sleep at 4th): the plan the card uses.
        let plan = heightenedPlanAt(basePlan, Number(options.castRank ?? spell?.rank ?? basePlan.rank));
        // The caster's zodiac constellation (Shining Starlight Attack): it sets the save and the damage type (asked when the cast doesn't say;
        // PF2e's Starlit Sentinel flag, when set, picks the default).
        if (plan.resolution.constellations?.length) {
            const caster = options.sourceActor ?? spell?.actor ?? null;
            const flagged = caster?.flags?.system?.starlitSentinelDedication?.damageType ?? null;
            let name = options.constellation ?? null;
            if (!name) name = await foundry.applications.api.DialogV2.prompt({ window: { title: `${plan.source.name} — constellation` },
                content: `<select name="constellation">${plan.resolution.constellations.map(row => `<option value="${escapeHTML(row.name)}"${row.damageType === flagged ? " selected" : ""}>${escapeHTML(row.name)} (${escapeHTML(row.area.value)}-foot ${escapeHTML(row.area.type)}, ${escapeHTML(row.statistic)}, ${escapeHTML(row.damageType)})</option>`).join("")}</select>`,
                ok: { label: "Cast", callback: (_event, button) => String(button.form.elements.constellation.value) }, rejectClose: false });
            const row = plan.resolution.constellations.find(entry => entry.name === name);
            if (!row) return { status: "cancelled" };
            plan = { ...plan, resolution: { ...plan.resolution, check: { ...plan.resolution.check, statistic: row.statistic }, constellation: row } };
            options = { ...options, casterChoice: row.damageType };
        }
        const sourceActor = options.sourceActor ?? spell?.actor ?? null;
        if (!sourceActor) throw new Error("The casting actor could not be resolved.");
        // "You must be wielding a melee weapon": the held melee weapon whose Strike deals the damage (asked among several), and whether undead
        // take vitality instead of the physical damage (Invoke the Crimson Oath).
        let weaponChoice = null;
        // Weapon Storm: any weapon the caster holds; its die (the two-hand die when held in both hands) and damage type.
        if (plan.resolution.weaponDamage?.mode === "dice") {
            const weapons = (sourceActor.itemTypes?.weapon ?? []).filter(item => item.isHeld !== false && (item.system?.equipped?.carryType === "held" || item.isHeld === true)
                && /^d\d+$/.test(item.system?.damage?.die ?? "") && /^[a-z]+$/.test(item.system?.damage?.damageType ?? ""));
            if (!weapons.length) throw new Error(`${plan.source.name}: ${sourceActor.name} must be holding a weapon.`);
            const picked = options.weaponItemId ?? (weapons.length === 1 ? weapons[0].id : await foundry.applications.api.DialogV2.prompt({ window: { title: `${plan.source.name} — which weapon?` },
                content: `<select name="weapon">${weapons.map(item => `<option value="${item.id}">${escapeHTML(item.name)}</option>`).join("")}</select>`,
                ok: { label: "Swing", callback: (_event, button) => String(button.form.elements.weapon.value) }, rejectClose: false }));
            const weapon = weapons.find(item => item.id === picked);
            if (!weapon) return { status: "cancelled" };
            const twoHand = (weapon.system?.traits?.value ?? []).map(trait => /^two-hand-(d\d+)$/.exec(trait)?.[1]).find(Boolean);
            const both = Number(weapon.system?.equipped?.handsHeld ?? 0) === 2;
            const die = twoHand && both ? twoHand : weapon.system.damage.die;
            const count = plan.resolution.weaponDamage.count + Math.max(0, Number(options.castRank ?? spell?.rank ?? plan.rank) - plan.resolution.weaponDamage.baseRank) * plan.resolution.weaponDamage.perRank;
            // (All of it another type when an item casts it so — castFromItem's damageType, the entry's copy flagged castDamageType: Soulcutter's spirit.)
            const typed = spell?.flags?.[MODULE_ID]?.castDamageType ?? weapon.system.damage.damageType;
            weaponChoice = { dice: true, itemId: weapon.id, name: weapon.name, formula: `${count}${die}[${typed}]` };
        }
        else if (plan.resolution.weaponDamage) {
            const strikes = weaponStrikes(sourceActor);
            if (!strikes.length) throw new Error(`${plan.source.name}: ${sourceActor.name} must be wielding a melee weapon.`);
            const picked = options.weaponItemId ?? (strikes.length === 1 ? strikes[0].item.id : await foundry.applications.api.DialogV2.prompt({ window: { title: `${plan.source.name} — which weapon?` },
                content: `<select name="weapon">${strikes.map(strike => `<option value="${strike.item.id}">${escapeHTML(strike.label ?? strike.item.name)}</option>`).join("")}</select>`,
                ok: { label: "Swing", callback: (_event, button) => String(button.form.elements.weapon.value) }, rejectClose: false }));
            const strike = strikes.find(entry => entry.item.id === picked);
            if (!strike) return { status: "cancelled" };
            const convert = plan.resolution.weaponDamage.convert;
            const converting = !convert ? false : options.weaponConvert ?? await foundry.applications.api.DialogV2.confirm({ window: { title: `${plan.source.name} — ${convert.trait} creatures` },
                content: `<p>Convert all the physical damage into ${escapeHTML(convert.to)} damage against ${escapeHTML(convert.trait)} creatures in the area?</p>`, rejectClose: false });
            weaponChoice = { itemId: strike.item.id, name: strike.item.name, convert: convert && converting ? { to: convert.to, trait: convert.trait } : null };
        }
        let targetInputs = Array.isArray(options.targets)
            ? options.targets
            : [...(options.targets ?? game.user.targets)];
        // Safeguard Spell: "you aren't affected by the spell even if you are within the area" — the caster isn't a target.
        if (shapeFrom && shapeRidersFor(shapeFrom).some(shape => shape.riders.some(rider => rider.type === "self-exempt")))
            targetInputs = targetInputs.filter(input => tokenDocumentFromTarget(input)?.actor?.uuid !== sourceActor?.uuid);
        // Cast through one of the caster's thralls: the thrall is the caster's choice (options.thrall, or asked among
        // the targeted tokens); it isn't a save target, and the area or reach is measured from it.
        const thrallSpec = plan.targeting?.thrall ?? null;
        let thrallToken = null;
        if (thrallSpec) {
            thrallToken = tokenDocumentFromTarget(options.thrall ?? await chooseThrall(plan.source.name, targetInputs));
            if (!thrallToken?.parent) throw new Error(`${plan.source.name}: choose the thrall (a token on the scene) the spell is cast through.`);
            targetInputs = targetInputs.filter(input => tokenDocumentFromTarget(input)?.id !== thrallToken.id);
            const casterToken = tokenDocumentFromTarget(sourceActor.getActiveTokens?.(false, true)?.[0]);
            if (!casterToken || casterToken.parent?.id !== thrallToken.parent.id) throw new Error(`${plan.source.name}: the caster needs a token on the thrall's scene.`);
            if (tokenDistance(casterToken, thrallToken) > thrallSpec.range) throw new Error(`${plan.source.name}: the thrall ${thrallToken.name} is more than ${thrallSpec.range} feet from the caster.`);
            const reach = thrallSpec.origin === "emanation" ? thrallSpec.radius : thrallSpec.origin === "within" ? thrallSpec.within : null;
            if (thrallSpec.maxTargets && targetInputs.length > thrallSpec.maxTargets) throw new Error(`${plan.source.name}: the thrall reaches ${thrallSpec.maxTargets} creature.`);
            if (reach != null) for (const input of targetInputs) {
                const token = tokenDocumentFromTarget(input);
                if (!token || token.parent?.id !== thrallToken.parent.id || tokenDistance(token, thrallToken) > reach)
                    throw new Error(`${plan.source.name}: ${token?.name ?? "a target"} is more than ${reach} feet from the thrall.`);
            }
        }
        const castRank = Number(options.castRank ?? spell?.rank ?? plan.rank);
        if (plan.resolution.rankGate && castRank > plan.resolution.rankGate.maxRank)
            throw new Error(`${plan.source.name}: at rank ${plan.resolution.rankGate.minRank} and above its heightened rules aren't automated (“${plan.resolution.rankGate.sourceText.slice(0, 160)}”). Resolve it by hand.`);
        const immunitySpell = resolveSpellAtRank(spell, castRank, spell?.isVariant ? [...(spell.appliedOverlays?.values?.() ?? [])] : []);
        const constraints = { ...plan.targeting.actorConstraints,
            spellRollOptions: plan.resolution.check.purpose === "condition-recovery" ? [] : [...(immunitySpell.getRollOptions?.("item") ?? []), "item:type:effect"],
            ...(plan.resolution.temporaryImmunity ? {spellImmunityKey:plan.resolution.temporaryImmunity.byCaster ? `${plan.resolution.temporaryImmunity.key}:${sourceActor.uuid}` : plan.resolution.temporaryImmunity.key}
                // (An immunity only a later save grants — Enthrall's "no longer fascinated and temporarily immune" — still keeps the creature out.)
                : plan.resolution.laterImmunityKey ? {spellImmunityKey:plan.resolution.laterImmunityKey} : {}),
            // Enemies are judged against the caster's alliance when the saves are prepared.
            ...((plan.targeting.actorConstraints.predicates ?? []).some(predicate => ["enemy-of-caster", "non-ally-of-caster", "not-caster"].includes(predicate.kind))
                ? {casterUuid: sourceActor.uuid, casterAlliance: actorAlliance(sourceActor)} : {}),
            // A level limit read at the cast rank.
            ...((plan.targeting.actorConstraints.predicates ?? []).some(predicate => ["level-at-most", "size-at-most"].includes(predicate.kind)) ? { castRank } : {}),
            // A level limit read from the caster's level.
            ...((plan.targeting.actorConstraints.predicates ?? []).some(predicate => predicate.kind === "level-at-most-caster") ? { casterLevel: Number(sourceActor.level ?? sourceActor.system?.details?.level?.value) } : {}),
            // "… a land Speed greater than yours": the caster's land Speed now.
            ...((plan.targeting.actorConstraints.predicates ?? []).some(predicate => predicate.kind === "land-speed-above-caster")
                ? {casterLandSpeed: Number(sourceActor.system?.movement?.speeds?.land?.value ?? sourceActor.system?.attributes?.speed?.total ?? NaN)} : {}) };
        // (An adjustment for the caster's allies: the caster named now.)
        // (A card's own adjustment: Ray of Corruption's save a degree worse after a critical hit.)
        const castAdjustment = options.degreeAdjustment ? clone(options.degreeAdjustment) : plan.resolution.degreeAdjustment?.predicate?.kind === "ally-of-caster"
            ? { ...clone(plan.resolution.degreeAdjustment), predicate: { ...clone(plan.resolution.degreeAdjustment.predicate), casterUuid: sourceActor.uuid } }
            // (A note this spell gave: the spell's item now.)
            // (Undermine Reality: a quasi-real caster's saves are a degree better for everyone.)
            : !plan.resolution.degreeAdjustment && (sourceActor?.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.runtime?.sourceSavesBetter)
                ? { predicate: { kind: "everyone" }, map: { criticalFailure: "failure", failure: "success", success: "criticalSuccess", criticalSuccess: "criticalSuccess" }, sourceText: "quasi-real caster" }
            : plan.resolution.degreeAdjustment?.predicate?.kind === "note-held"
                ? { ...clone(plan.resolution.degreeAdjustment), predicate: { ...clone(plan.resolution.degreeAdjustment.predicate), sourceItemUuid: spell?.uuid ?? null } } : plan.resolution.degreeAdjustment ?? null;
        const targets = snapshotTargets(targetInputs, constraints, castAdjustment, plan.resolution.dualMode ?? null, plan.resolution.allySplit ? sourceActor : null, plan.resolution.traitGrant ?? null);
        // Shadow's Betrayal: the damage type of a Strike the one target could make (a weapon it wields or an unarmed attack), the caster's pick among
        // its types; chosen when the attack is made.
        let strikeType = null;
        if (plan.resolution.damageTypeFrom?.kind === "target-strike") {
            const actor = tokenDocumentFromTarget(targetInputs[0])?.actor ?? null;
            if (targetInputs.length !== 1 || !actor) throw new Error(`${plan.source.name}: target exactly one creature.`);
            const types = targetStrikeTypes(actor);
            if (!types.length) throw new Error(`${plan.source.name}: ${actor.name} has no Strike whose damage type the module can read; it must wield a weapon or have an unarmed attack.`);
            const picked = options.strikeDamageType ?? (types.length === 1 ? `${types[0].strike}|${types[0].type}` : await foundry.applications.api.DialogV2.prompt({ window: { title: `${plan.source.name} — ${actor.name}'s Strike` },
                content: `<p>Choose a weapon ${escapeHTML(actor.name)} is wielding or an unarmed attack it could use (and its damage type).</p><select name="strike">${types.map(entry => `<option value="${escapeHTML(`${entry.strike}|${entry.type}`)}">${escapeHTML(entry.strike)} — ${escapeHTML(entry.type)}</option>`).join("")}</select>`,
                ok: { label: "Attack", callback: (_event, button) => String(button.form.elements.strike.value) }, rejectClose: false }));
            if (picked == null) return { status: "cancelled" };
            const found = types.find(entry => `${entry.strike}|${entry.type}` === picked || (typeof options.strikeDamageType === "string" && entry.type === options.strikeDamageType && !options.strikeDamageType.includes("|")));
            if (!found) throw new Error(`${plan.source.name}: ${actor.name} has no Strike dealing that damage.`);
            strikeType = found;
        }
        // A chain of targets (Chain Lightning): in the order targeted, each within the distance of the one before.
        if (plan.resolution.chain) {
            const tokens = targetInputs.map(input => tokenDocumentFromTarget(input));
            for (let index = 1; index < tokens.length; index++) {
                if (!tokens[index] || !tokens[index - 1] || tokens[index].parent?.id !== tokens[index - 1].parent?.id || tokenDistance(tokens[index - 1], tokens[index]) > plan.resolution.chain.feet)
                    throw new Error(`${plan.source.name}: each target must be within ${plan.resolution.chain.feet} feet of the one before it (target them in the chain's order).`);
            }
        }
        // "You and the target each take …" (Debilitating Dichotomy): the caster saves too, its result one degree better.
        if (plan.resolution.casterShare) {
            if (targets.some(target => target.actorUuid === sourceActor.uuid)) throw new Error(`${plan.source.name}: target another creature; the card adds you.`);
            const casterToken = sourceActor.getActiveTokens?.(false, true)?.[0];
            if (!casterToken) throw new Error(`${plan.source.name}: ${sourceActor.name} needs a token to share the save.`);
            const [own] = snapshotTargets([casterToken], { ...constraints, predicates: [] }, plan.resolution.degreeAdjustment, null, null, null);
            if (!own?.eligible) throw new Error(`${plan.source.name}: ${sourceActor.name} can't take the save (${own?.eligibilityReason ?? "no record"}).`);
            own.degreeAdjustment = { status: "applies", caster: true };
            own.casterShare = true;
            targets.push(own);
        }
        // Heightened secondary targets (Horrifying Blood Loss at 4th): with one primary target, up to the stated number of creatures that
        // miss only the waived requirement join, each with the GM's question.
        if (plan.resolution.secondaryTargets && castRank >= plan.resolution.secondaryTargets.fromRank) markSecondaryTargets(targets, constraints, plan.resolution.secondaryTargets);
        if (plan.resolution.bolster) for (const target of targets) if (target.eligible) target.bolster = { status: "pending" };
        // Each creature's square is the GM's (Redistribute Potential).
        if (plan.resolution.traitVariant?.kind === "zone") for (const target of targets) { if (target.eligible) target.zone = { status: "pending" }; }
        // (Noxious Metals: PF2e's traits pick the second table; the GM answers the aversion for the others.)
        else if (plan.resolution.traitVariant?.kind === "trait-rows") for (const target of targets) {
            if (!target.eligible) continue;
            const actor = await fromUuid(target.actorUuid);
            const traits = actor?.traits && typeof actor.traits.has === "function" ? actor.traits : new Set(actor?.system?.traits?.value ?? []);
            if (plan.resolution.traitVariant.traits.some(trait => traits.has(trait))) target.traitVariant = plan.resolution.traitVariant.trait;
            else target.zone = { status: "pending" };
        }
        // A creature with the spell's other trait (undead) uses the other rows.
        else if (plan.resolution.traitVariant) for (const target of targets) {
            const actor = await fromUuid(target.actorUuid);
            const traits = actor?.traits && typeof actor.traits.has === "function" ? actor.traits : new Set(actor?.system?.traits?.value ?? []);
            if (traits.has(plan.resolution.traitVariant.trait) && !(plan.resolution.traitVariant.excludedTraits ?? []).some(trait => traits.has(trait))) target.traitVariant = plan.resolution.traitVariant.trait;
        }
        if (!targets.length) throw new Error(`${plan.source.name}: target every affected creature before preparing saves.`);
        if (plan.resolution.check.statistic === "strike" && targets.length !== 1) throw new Error(`${plan.source.name}: target the one creature your Strike is against.`);
        // Damage PF2e types by the caster's bloodline: without that bloodline choice PF2e would roll it untyped.
        if (plan.resolution.bloodlineDamage && !bloodlineDamageType(plan.resolution.bloodlineDamage, sourceActor))
            throw new Error(`${plan.source.name}: ${sourceActor.name} has no ${plan.resolution.bloodlineDamage.bloodline} bloodline choice in PF2e, so PF2e can't give this spell its damage type.`);
        // "2 creatures no more than 10 feet from each other."
        const spacing = plan.targeting.actorConstraints.mutualWithin;
        if (spacing != null) {
            const tokens = targets.map(target => tokenDocumentFromTarget(targetInputs.find(input => actorFromTarget(input)?.uuid === target.actorUuid)));
            if (tokens.some(token => !token?.parent)) throw new Error(`${plan.source.name}: every target needs a token on the scene to measure the ${spacing} feet between them.`);
            for (const [index, token] of tokens.entries()) for (const other of tokens.slice(index + 1))
                if (tokenDistance(token, other) > spacing) throw new Error(`${plan.source.name}: ${token.name} and ${other.name} are more than ${spacing} feet from each other.`);
        }
        // A target-dependent attack question: each target waits for the GM's answer before its attack is rolled.
        if (plan.resolution.attackAdjustment) for (const target of targets) target.attackAdjustment = { status: "pending" };
        // "… depending on its highest attribute modifier": each target's condition, or its choice on a tie.
        if (plan.resolution.attributeCondition) for (const target of targets) {
            const actor = actorFromTarget(targetInputs.find(input => actorFromTarget(input)?.uuid === target.actorUuid));
            const mods = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(key => [key, Number(actor?.system?.abilities?.[key]?.mod ?? actor?.abilities?.[key]?.mod)]));
            if (Object.values(mods).some(mod => !Number.isFinite(mod))) throw new Error(`${plan.source.name}: ${target.name} has no attribute modifiers to choose its condition from.`);
            const top = Math.max(...Object.values(mods));
            const tied = Object.keys(mods).filter(key => mods[key] === top);
            const slugs = [...new Set(tied.map(key => plan.resolution.attributeCondition.options.find(option => option.attributes.includes(key))?.slug))];
            target.attributeCondition = slugs.length === 1 ? { status: "set", slug: slugs[0], attributes: tied, mods } : { status: "pending", options: slugs, attributes: tied, mods };
        }
        // Splash: every other creature within 5 feet of the attack's target takes the splash damage on a hit.
        if (plan.resolution.splash) {
            if (targets.length !== 1) throw new Error(`${plan.source.name}: splash damage needs exactly one attack target.`);
            const struck = tokenDocumentFromTarget(targetInputs.find(input => actorFromTarget(input)?.uuid === targets[0].actorUuid));
            if (!struck?.parent) throw new Error(`${plan.source.name}: the target needs a token on a scene for splash damage.`);
            const nearby = struck.parent.tokens.filter(token => token.id !== struck.id && token.actor
                && token.actor.uuid !== targets[0].actorUuid && tokenDistance(token, struck) <= plan.resolution.splash.radius);
            targets.push(...snapshotTargets(nearby, { supportsActorTargets: true, complete: true, predicates: [] })
                .filter(record => record.actorUuid !== targets[0].actorUuid)
                .map(record => ({ ...record, mode: "splash", eligible: true, eligibilityReason: null, applicationStatus: "pending" })));
        }
        const dc = normalizeDC(options.dc) ?? spellDC(spell, sourceActor);
        if (!dc) throw new Error(`${plan.source.name}: the caster's spell DC could not be resolved.`);
        // Avenging Wildwood: the tree is made when the spell is cast (a token with the stated statistics), and Strikes only creatures within
        // its reach.
        if (plan.resolution.conjuredCreature) {
            const conjured = await ensureConjuredCreature(plan, sourceActor, spell, castRank, dc, options);
            for (const target of targets) {
                if (!target.eligible) continue;
                const token = target.tokenUuid ? await fromUuid(target.tokenUuid) : null;
                const distance = token ? tokenDistance(conjured.token, token) : Infinity;
                if (!(distance <= plan.resolution.conjuredCreature.reach)) {
                    const reason = `more than ${plan.resolution.conjuredCreature.reach} feet from the ${plan.resolution.conjuredCreature.name}`;
                    Object.assign(target, { eligible: false, eligibilityReason: reason, originalEligibility: { eligible: false, reason } });
                }
            }
        }
        // Sign of Conviction: the caster's Effect, made with the first attack; once it's gone (the caster moved, or stopped Sustaining) the spell has ended.
        if (plan.resolution.castEffect) await ensureCastEffect(plan, sourceActor, spell, options);
        // Crystallized Vapors: the caster's emanation of difficult terrain, made with the first attack.
        if (plan.resolution.terrainAura) await this.#ensureTerrainAura(plan, sourceActor, spell, castRank, options);
        const saveIsBasic = plan.resolution.check.basic === true;

        // Half the triggering damage (Retributive Pain): the caster's last damage taken (or the amount passed in).
        const triggered = plan.resolution.sharedDamage?.triggeredDamage ?? null;
        let triggeredFormula = null;
        if (triggered) {
            const taken = Number(options.triggeringDamage ?? lastDamageOf(sourceActor)?.amount);
            if (!Number.isFinite(taken) || taken <= 0) throw new Error(`${plan.source.name}: ${sourceActor.name} has taken no damage to reflect.`);
            triggeredFormula = `${Math.floor(taken * triggered.fraction)}[${triggered.type}]`;
        }
        const confirmed = options.skipConfirmation === true || await confirmAction({
            title: `${plan.source.name} — Prepare ${saveIsBasic ? "Basic " : ""}Saves`,
            content: `<p>Snapshot ${targets.length} target${targets.length === 1 ? "" : "s"} at DC ${dc}?</p><p>No damage is applied until the final confirmation.</p>`,
            label: "Prepare Saves"
        });
        if (!confirmed) return { status: "cancelled", plan };

        const degreeOutcome = isExecutableDegreeSavePlan(plan);
        const outcomeSnapshot = degreeOutcome
            ? snapshotOutcomes(plan, castRank)
            : { outcomes: null, outcomeRolls: [] };
        // (Damage only for creatures of the named traits: each target marked when the card opens.)
        if (plan.resolution.damageTraits) for (const target of targets) {
            const actor = target.actorUuid ? await fromUuid(target.actorUuid) : null;
            const traits = actor?.traits ?? new Set(actor?.system?.traits?.value ?? []);
            target.traitDamage = plan.resolution.damageTraits.traits.some(trait => traits.has?.(trait) ?? traits.includes?.(trait));
        }
        const state = {
            schema: SAVE_SCHEMA,
            castId: randomID(),
            messageId: null,
            // (The cast's message — its template is a burst's centre for a push — and a push's own origin token when it isn't the caster's: Vexing Tempest's familiar.)
            ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
            ...(!options.sourceMessageId && options.shapeMessageId ? { shapeMessageId: options.shapeMessageId } : {}),
            ...(options.forcedOrigin ? { forcedOrigin: options.forcedOrigin } : {}), ...(options.forcedPoint ? { forcedPoint: options.forcedPoint } : {}),
            spellAreaType: spell?.system?.area?.type ?? null,
            // (Creatures moved out of the area to the nearest unoccupied space — Garden of Stone's stalagmite, Blade Barrier's successes, Frost Pillar's
            // success to an adjacent space; a card's own area when it gives one: Lifewood Cage's cage.)
            ...(plan.resolution.groundOnly ? { groundOnly: foundry.utils.deepClone(plan.resolution.groundOnly) } : {}),
            ...(plan.resolution.areaExit ? { areaExit: foundry.utils.deepClone(plan.resolution.areaExit) } : {}), ...(plan.resolution.areaPullIn ? { areaPullIn: foundry.utils.deepClone(plan.resolution.areaPullIn) } : {}), ...(options.exitArea ? { exitArea: foundry.utils.deepClone(options.exitArea) } : {}),
            // (A card part's save whose Effects belong to the card's own record — Unbreaking Wave Containment's hold, ended with the spell.)
            ...(options.attachTo ? { attachTo: String(options.attachTo) } : {}),
            // (The cast's spellshape feats and wand: their riders, after each creature's outcome — spellshape-runtime.js.)
            ...(options.shapeRiders?.length ? { shapeRiders: options.shapeRiders, areaShape: spell?.system?.area?.type ?? null, shapeSpell: shapeSpellFacts(spell) }
                : shapeFrom && shapeRidersFor(shapeFrom).length ? { shapeRiders: shapeRidersFor(shapeFrom), areaShape: spell?.system?.area?.type ?? null, shapeSpell: shapeSpellFacts(spell) } : {}),
            // (Chaotic Spell's roll: the spell's damage type changed.)
            ...(shapeFrom && shapeTypeSwapFor(shapeFrom) ? { shapeTypeSwap: shapeTypeSwapFor(shapeFrom) } : {}),
            // (The Lurking Storm: the damage split between two types.)
            ...(shapeFrom && shapeSplitFor(shapeFrom) ? { shapeSplit: shapeSplitFor(shapeFrom) } : {}),
            // (Fury of a Thousand on Murmuration: its damage in full as both types.)
            ...(shapeFrom && shapeDualFor(shapeFrom) ? { shapeDual: shapeDualFor(shapeFrom) } : {}),
            // ("Treat the resistances … as if they were 10 lower": Cataclysm.)
            ...(Number.isInteger(options.plan?.resolution?.resistanceLower) ? { resistanceLower: options.plan.resolution.resistanceLower } : {}),
            ...(shapeFrom && shapeResistanceLowersFor(shapeFrom, sourceActor).length ? { shapeResistanceLower: shapeResistanceLowersFor(shapeFrom, sourceActor) } : {}),
            ...(shapeFrom && shapeMaterialFor(shapeFrom) ? { shapeMaterial: shapeMaterialFor(shapeFrom) } : {}),
            // (Codex of Destruction and Renewal: "you reroll any damage dice that roll a 1".)
            ...(shapeFrom && shapeRerollOnesFor(shapeFrom) ? { shapeRerollOnes: true } : {}),
            // (A bonus the card states for the attack: Comet Charge's target Off-Guard after a dive from above.)
            ...(options.attackBonus ? { attackBonus: { value: Number(options.attackBonus.value), label: String(options.attackBonus.label), type: options.attackBonus.type ?? "circumstance" } } : {}),
            sourceActorUuid: sourceActor.uuid,
            sourceItemUuid: spell.uuid ?? plan.source.uuid ?? null,
            recoverySource: plan.resolution.check.purpose === "condition-recovery" ? clone(options.recoverySource ?? null) : null,
            originalSpellSource: typeof spell.toObject === "function" ? spell.toObject() : spell?.type === "spell" && spell.system ? clone(spell) : null,
            spellName: plan.source.name,
            spellSlug: plan.source.slug ?? null,
            compilerVersion: plan.compilerVersion,
            baseRank: Number(plan.rank),
            castRank,
            dc,
            saveStatistic: plan.resolution.check.statistic,
            // ("Reflex or Will (target's choice)": each target rolls its better save.)
            saveChoice: plan.resolution.check.saveChoice ? [...plan.resolution.check.saveChoice.statistics] : null,
            sharedMultipleAttackPenalty: plan.resolution.check.sharedMultipleAttackPenalty === true,
            // (A chain of targets: it ends at the first critical success.)
            chain: plan.resolution.chain ? clone(plan.resolution.chain) : null,
            // The PF2e variant (action count) the spell was cast as: rolls reload it with these overlays.
            overlayIds: spell?.isVariant ? [...(spell.appliedOverlays?.values?.() ?? [])] : [],
            // Rules for the GM to resolve alongside the card (not automated).
            reminders: clone(plan.resolution.reminders ?? []).map(reminder => reminder.kind === "thrall-destroyed" && thrallToken
                ? { ...reminder, text: isThrall(thrallToken) ? `The thrall (${thrallToken.name}) is destroyed (its token removed).` : `The thrall (${thrallToken.name}) is destroyed: remove its token.` }
                // A distance stated at the cast rank ("Fly up to 10 feet", +5 feet per 2 ranks).
                : reminder.rankFeet ? { ...reminder, text: reminder.text.replaceAll("{feet}", String(reminder.rankFeet.base
                    + reminder.rankFeet.step * Math.max(0, Math.floor((Number(castRank) - reminder.rankFeet.baseRank) / reminder.rankFeet.interval)))) } : reminder),
            // The thrall the spell was cast through.
            thrall: thrallToken ? { name: thrallToken.name, tokenUuid: thrallToken.uuid, origin: thrallSpec.origin } : null,
            // Heal-or-harm: which energy heals and which harms (see dualEnergyMode).
            dualMode: clone(plan.resolution.dualMode ?? null),
            allySplit: plan.resolution.allySplit ? { ...clone(plan.resolution.allySplit), roll: null } : null,
            traitGrant: plan.resolution.traitGrant ? clone(plan.resolution.traitGrant) : null,
            traitVariant: plan.resolution.traitVariant && outcomeSnapshot.traitOutcomes ? { trait: plan.resolution.traitVariant.trait, outcomes: outcomeSnapshot.traitOutcomes,
                ...(plan.resolution.traitVariant.kind === "zone" ? { kind: "zone", values: clone(plan.resolution.traitVariant.values), question: plan.resolution.traitVariant.question, damageSwap: clone(plan.resolution.traitVariant.damageSwap) } : {}),
                ...(plan.resolution.traitVariant.kind === "trait-rows" ? { kind: "trait-rows", values: clone(plan.resolution.traitVariant.values), labels: clone(plan.resolution.traitVariant.labels),
                    question: plan.resolution.traitVariant.question, traits: clone(plan.resolution.traitVariant.traits) } : {}),
                ...(plan.resolution.traitVariant.kind === "persistent-extra" ? { kind: "persistent-extra", excludedTraits: clone(plan.resolution.traitVariant.excludedTraits) } : {}) } : null,
            // Creatures the GM judges bolstered: no save, PF2e's bonus Effect at Finalize.
            bolster: clone(plan.resolution.bolster ?? null),
            // An exposure of a lingering area: effects that end when the creature leaves the area are that area's.
            lingeringCastId: typeof options.lingeringCastId === "string" ? options.lingeringCastId : null,
            // Divine Armageddon: the void part is vitality for undead and void-healing creatures.
            damageSwap: clone(plan.resolution.damageSwap ?? null),
            // Damage typed by the caster's bloodline (PF2e applies it); the roll is checked for it.
            bloodlineDamage: clone(plan.resolution.bloodlineDamage ?? null),
            // Splash damage: the struck target's roll doubles only its non-splash part; nearby creatures take the splash.
            splash: clone(plan.resolution.splash ?? null),
            // Extra damage for creatures with a trait, rolled once at Finalize.
            conditionalDamage: [...(plan.resolution.conditionalDamage ?? []).map(entry => ({ ...clone(entry), id: randomID(), rollJSON: null, total: null })),
                // Shocking Grasp's persistent damage for a metal target: gated by the GM's answer, not doubled on a critical hit.
                // (Remember the Lost: the larger dice for the targets the caster named, in place of the shared roll.)
                ...(plan.resolution.targetUpgrade ? [{ formula: plan.resolution.targetUpgrade.formula, gate: "target-upgrade", replaces: true, doubles: true,
                    label: plan.resolution.targetUpgrade.label, sourceText: plan.resolution.targetUpgrade.sourceText, id: randomID(), rollJSON: null, total: null }] : []),
                ...(plan.resolution.attackAdjustment?.onApplies ? [{ formula: plan.resolution.attackAdjustment.onApplies.formula, gate: "attack-adjustment",
                    doubles: false, label: "targets the GM marked (metal)", sourceText: plan.resolution.attackAdjustment.onApplies.sourceText, id: randomID(), rollJSON: null, total: null }] : [])],
            attackAdjustment: clone(plan.resolution.attackAdjustment ?? null),
            // Where PF2e's Effect differs from the text, the Effect is applied as PF2e defines it; the card says how.
            dataNotes: clone(plan.resolution.dataNotes ?? []),
            // What the GM does when a push hits a wall or goes off a ledge, with the damage at the cast rank.
            forcedMovementNotes: (plan.resolution.forcedMovementNotes ?? []).map(note => forcedMovementNoteText(note, castRank)),
            // A hazard left in the target's squares: a region the module places at Finalize and runs for the spell's duration.
            groundHazard: plan.resolution.groundHazard ? { ...clone(plan.resolution.groundHazard), formula: hazardFormula(plan.resolution.groundHazard.damage.formula, castRank) } : null,
            casterEffect: clone(plan.resolution.casterEffect ?? null),
            // What the caster plays while Sustaining: a note Effect on the caster at Finalize, with the Heightened text at the cast rank.
            // PF2e's marking Effect on the caster, one for each target whose row deals the persistent damage (at Finalize).
            casterMark: clone(plan.resolution.casterMark ?? null),
            immunityBypass: clone(plan.resolution.immunityBypass ?? null),
            resistanceBypass: clone(plan.resolution.resistanceBypass ?? null),
            // "apply only half their usual fire resistance" (and the immune take it untyped, one degree better).
            resistanceHalving: clone(plan.resolution.resistanceHalving ?? null),
            // Persistent damage that ends with a condition the failing rows grant: the created persistent conditions are tagged.
            persistentEndsWith: Object.fromEntries(Object.entries(plan.resolution.outcomes ?? {}).filter(([, outcome]) => outcome?.persistentEndsWith)
                .map(([degree, outcome]) => [degree, { condition: outcome.persistentEndsWith.condition, damageType: outcome.persistentEndsWith.damageType }])),
            casterNote: plan.resolution.casterNote ? { ...clone(plan.resolution.casterNote), castText: spellNoteText(plan.resolution.casterNote, castRank, Number(plan.rank)) } : null,
            attackNumber: null,
            saveIsBasic,
            targetConstraints: clone(constraints),
            outcomes: outcomeSnapshot.outcomes,
            // (A basic save keeps no rows: a critical success that ends the spell — Mirror Malefactors — is carried on its own.)
            criticalEndsSpell: plan.resolution.outcomes?.criticalSuccess?.endsSpellOn === "critical-success" && plan.resolution.outcomes.criticalSuccess.endsSpell === true,
            generatedSpeedProof: clone(plan.compilerEvidence?.generatedSpeedPenalties ?? null),
            postDamageTerminal: isPostDamageDeath(plan.resolution.postDamageTerminal) ? clone(plan.resolution.postDamageTerminal) : null,
            // (Unsullied Blood: "you recover half of the damage dealt as Hit Points" in place of the temporary Hit Points.)
            casterBenefit: (() => { const benefit = clone(plan.resolution.casterBenefit ?? null); const kind = shapeFrom ? shapeRidersFor(shapeFrom).flatMap(shape => shape.riders ?? []).find(rider => rider.type === "caster-benefit-kind")?.kind : null;
                return benefit && kind ? { ...benefit, kind } : benefit; })(),
            // "If this kills it, you gain …": the caster's Effect when a row's death is applied.
            killEffect: clone(plan.resolution.killEffect ?? null),
            // (Promised Renewal: the growth around a creature this save kills — started by the effect runtime on saveApplied.)
            ...(options.renewalGrowth ? { renewalGrowth: clone(options.renewalGrowth) } : {}),
            // (A penalty or bonus on this card's saves alone, once — a rerolled Chromatic Wall's −2 to the crossing save.)
            ...(options.saveModifier && Number.isFinite(Number(options.saveModifier.value)) ? { cardSaveModifier: { value: Number(options.saveModifier.value),
                type: String(options.saveModifier.type ?? "circumstance"), label: String(options.saveModifier.label ?? "") } } : {}),
            backlash: clone(plan.resolution.backlash ?? null),
            areaFall: clone(plan.resolution.areaFall ?? null),
            casterRowEffect: clone(plan.resolution.casterRowEffect ?? null),
            // (Draw the Lightning: the weapon PF2e's Effect asks for, when the cast already says — otherwise PF2e prompts.)
            casterEffectSelection: typeof options.casterEffectSelection === "string" ? options.casterEffectSelection : null,
            persistentRemoval: clone(plan.resolution.persistentRemoval ?? null),
            degreeAdjustment: clone(castAdjustment),
            // Dehydrate: each creature taking the persistent damage saves again at the end of each of its turns (an Ongoing record).
            impossibleBurst: clone(plan.resolution.impossibleBurst ?? null),
            followUpSave: plan.resolution.followUpSave ? { ...clone(plan.resolution.followUpSave), exposurePlan: followUpExposurePlan(plan) } : null,
            // ("… damaged immediately and at the end of each of your turns": a record per failing target; doubled after a critical failure.)
            turnHazard: plan.resolution.turnHazard ? clone(plan.resolution.turnHazard) : null,
            // Sanguine Mist's Sustain exposure: the caster's temporary Hit Points from the most a creature lost.
            casterSiphon: plan.resolution.casterSiphon ? clone(plan.resolution.casterSiphon) : null,
            temporaryImmunity: clone(plan.resolution.temporaryImmunity ?? null),
            traitSaveBonus: clone(plan.resolution.traitSaveBonus ?? null),
            // ("the same type as your Arcane Cascade": the caster's stance's type at the roll.)
            attackDefense: plan.resolution.attackDefense ? clone(plan.resolution.attackDefense) : null,
            damageTypeFrom: plan.resolution.damageTypeFrom ? { ...clone(plan.resolution.damageTypeFrom), ...(strikeType ? { type: strikeType.type, strike: strikeType.strike } : {}) } : null,
            afflictionHandoff: isAfflictionHandoffPlan(plan) ? clone(plan.resolution.afflictionHandoff) : null,
            damageGate: isSharedDamageGate(plan) ? clone(plan.resolution.damageGate) : null,
            // (The damage only for creatures of the named traits: Life's Flowing River's undead and nindoru.)
            damageTraits: clone(plan.resolution.damageTraits ?? null),
            castChoice: isAfflictionHandoffPlan(plan) && plan.resolution.castChoice ? {...clone(plan.resolution.castChoice), selected: null} : null,
            diceUpgrade: plan.resolution.diceUpgrade ? { ...clone(plan.resolution.diceUpgrade), answer: null } : null,
            targetUpgrade: clone(plan.resolution.targetUpgrade ?? null),
            // (Steal Shadow: the basic save each round's first Sustain opens for the targets that failed.)
            sustainStrike: plan.resolution.sustainStrike ? { ...clone(plan.resolution.sustainStrike), plan: sustainStrikePlan(plan) } : null,
            sustainHold: clone(plan.resolution.sustainHold ?? null),
            // (Warped Visage: the save each turn's first Sustain gives one ally of a target that failed.)
            sustainAllySave: clone(plan.resolution.sustainAllySave ?? null),
            // (Targeted Ward: the caster's Effect at Finalize; the defense preset by a test, or picked on its ChoiceSet.)
            casterWard: plan.resolution.casterWard ? { ...clone(plan.resolution.casterWard), ...(["ac", "fortitude", "reflex", "will"].includes(options.wardDefense) ? { defense: options.wardDefense } : {}) } : null,
            // (Technomancy Ray: the die by the caster's Crafting rank.)
            skillDie: clone(plan.resolution.skillDie ?? null),
            timeline: clone(plan.resolution.timeline ?? null),
            escapeDamage: clone(plan.resolution.escapeDamage ?? null),
            // Final Sacrifice's minion (chosen on the card) or Bony Barrage's thrall (the GM's reminder), and the bone armor question.
            sacrifice: plan.resolution.sacrifice ? { ...clone(plan.resolution.sacrifice), selected: null, selectedName: null, retyped: false } : null,
            boneArmor: plan.resolution.boneArmor ? { ...clone(plan.resolution.boneArmor), answer: null } : null,
            // "If you already dealt damage to the creature earlier this turn, it also takes … persistent damage": the caster's answer.
            persistentRider: plan.resolution.persistentRider ? { ...clone(plan.resolution.persistentRider), castAmount: String(castRank), answer: null } : null,
            damageBonus: plan.resolution.damageBonus ? { ...clone(plan.resolution.damageBonus), answer: null } : null,
            // ("For water and wood, you can choose which damage type increases for each rank": the caster's split of the heightened dice.)
            diceSplit: plan.resolution.sharedDamage?.diceSplit && Number(castRank) > plan.resolution.sharedDamage.diceSplit.baseRank
                ? { ...clone(plan.resolution.sharedDamage.diceSplit), steps: Number(castRank) - plan.resolution.sharedDamage.diceSplit.baseRank, answer: null } : null,
            // ("Ground in the area becomes difficult terrain for 1 minute.": the card places it on the selected region.)
            areaTerrain: plan.resolution.areaTerrain ? { ...clone(plan.resolution.areaTerrain), placed: null } : null,
            weaponDamage: weaponChoice,
            // Whether the save happens at all: the GM answers once ("no" leaves every creature unaffected).
            castGate: plan.resolution.castGate ? { ...clone(plan.resolution.castGate), answer: null } : null,
            beneficiaryEffect: plan.resolution.beneficiaryEffect ? { ...clone(plan.resolution.beneficiaryEffect), grantedTo: null } : null,
            healBack: plan.resolution.healBack ? { ...clone(plan.resolution.healBack), grantedTo: null, amount: null } : null,
            partnerGrant: plan.resolution.partnerGrant ? { ...clone(plan.resolution.partnerGrant), grantedTo: null } : null,
            // Call the Blood: the caster's part after Finalize, by what the caster is.
            casterDraw: plan.resolution.casterDraw ? { ...clone(plan.resolution.casterDraw), result: null } : null,
            // Blood-Feasting Breath: the second cone's healing after Finalize.
            healSpread: plan.resolution.healSpread ? { ...clone(plan.resolution.healSpread), healed: null } : null,
            // Grisly Growths: the second save around the target, a card after Finalize.
            areaFollowUp: plan.resolution.areaFollowUp ? { ...clone(plan.resolution.areaFollowUp), posted: false } : null,
            // Pack Breaker: each affected creature's former allies within its reach save too (a card per creature after Finalize, the same plan).
            chainSave: plan.resolution.chainSave ? { ...clone(plan.resolution.chainSave), plan: clone(plan), posted: false } : null,
            // (A spread save started from another cast's card, whose results last while that cast does: Infectious Ennui at 5th.)
            parentCastId: typeof options.parentCastId === "string" ? options.parentCastId : null,
            // Blister: the charges the target's result leaves, a card after Finalize.
            popSave: plan.resolution.popSave ? { ...clone(plan.resolution.popSave), posted: false } : null,
            // The caster's choice for the cast (a damage type); an ongoing area passes the one made when it started.
            casterChoice: plan.resolution.casterChoice ? { ...clone(plan.resolution.casterChoice),
                // (Fury of a Thousand on Murmuration: both types are dealt — the first stands for the roll, no choice asked.)
                selected: plan.resolution.casterChoice.values.includes(options.casterChoice) ? options.casterChoice
                    : plan.resolution.casterChoice.kind === "damage-type" && shapeFrom && shapeDualFor(shapeFrom) && plan.resolution.casterChoice.values.includes(shapeDualFor(shapeFrom).types[0]) ? shapeDualFor(shapeFrom).types[0] : null } : null,
            conditionRoll: plan.resolution.conditionRoll ? { ...clone(plan.resolution.conditionRoll), rolled: null, slug: null } : null,
            duplicate: plan.resolution.duplicate ? clone(plan.resolution.duplicate) : null,
            targetAura: plan.resolution.targetAura ? clone(plan.resolution.targetAura) : null,
            casterForm: plan.resolution.casterForm ? clone(plan.resolution.casterForm) : null,
            // (The spell's controls, as their card shows them; each button recompiles the spell for its part.)
            controls: plan.resolution.controls ? { degrees: [...plan.resolution.controls.degrees], label: plan.resolution.controls.label,
                parts: plan.resolution.controls.parts.map(part => ({ key: part.key, title: part.title, traits: [...(part.traits ?? [])], kind: part.kind, ...(part.count ? { count: part.count } : {}),
                    ...(part.repeat ? { repeat: clone(part.repeat) } : {}), ...(part.reminder ? { reminder: part.reminder } : {}), ...(part.note ? { note: part.note } : {}), ...(part.plan ? { plan: true } : {}) })) } : null,
            lifecycle: degreeOutcome ? clone(plan.lifecycle) : null,
            // The round the spell was cast in: Sustain is due on the caster's later turns.
            sustained: isSustainedConditionPlan(plan) ? { castRound: this.ongoing?.clock?.().round ?? 0, maximumSeconds: sustainedMaximumSeconds(plan.lifecycle) } : null,
            effectStart: {
                value: game.time?.worldTime ?? 0,
                initiative: initiativeForActor(sourceActor),
                started: game.combat?.started === true,
                combatId: game.combat?.id ?? null,
                turn: game.combat?.turn ?? 0,
                turnActors: (game.combat?.turns ?? []).map(turn => turn.actor?.uuid ?? null)
            },
            traits: [...new Set([...(spell.system?.traits?.value ?? []), ...(plan.resolution.check.traits ?? [])])],
            damage: {
                enabled: plan.resolution.sharedDamage != null && planUsesSharedDamage(plan),
                components: clone(plan.resolution.sharedDamage?.components ?? []),
                sourceFormula: triggeredFormula ?? (plan.resolution.sharedDamage?.mode === "formula" ? plan.resolution.sharedDamage.formula : null),
                // The text's formula for an entry PF2e's variant data states otherwise ("This spell deals 2d10 sonic damage, …").
                formulaOverrides: clone(plan.resolution.sharedDamage?.formulaOverrides ?? []),
                typeOverride: clone(plan.resolution.sharedDamage?.typeOverride ?? null),
                // (Persistent-only damage scaled by the result: the card scales the formula.)
                persistentScaled: plan.resolution.sharedDamage?.persistentScaled === true,
                // The caster's own damage for casting (Mutilate), rolled and applied once at Finalize.
                casterDamage: clone(plan.resolution.casterDamage ?? null),
                // The text's larger heightening step for a damage type (the missing dice at the cast rank).
                heighteningCorrection: clone(plan.resolution.sharedDamage?.heighteningCorrection ?? []),
                componentSelective: !!plan.compilerEvidence?.componentSelectiveDamage,
                inlinePersistentComposed: !!plan.compilerEvidence?.inlinePersistentDamage,
                rollJSON: null,
                formula: null,
                total: null,
                rollOptions: [],
                instances: [],
                outcomeRolls: outcomeSnapshot.outcomeRolls
            },
            targets,
            status: "collecting",
            reviewRequired: false,
            reviewReason: null,
            resultMessageId: null,
            createdAt: Date.now()
        };
        // (Kirin Echo Chime: where the creatures stood before the spell pushed them.)
        const origins = state.shapeRiders ? catalystOrigins(state.shapeRiders, targets.map(target => target.tokenUuid ? fromUuidSync(target.tokenUuid) : null).filter(Boolean)) : null;
        if (origins) state.shapeOrigins = origins;
        debugLog(state.castId, "save prepared", {
            moduleVersion: game.modules?.get(MODULE_ID)?.version ?? null,
            spell: state.spellName,
            castRank: state.castRank,
            dc: state.dc,
            statistic: state.saveStatistic,
            targets: state.targets.map(target => ({
                id: target.id,
                name: target.name,
                actorUuid: target.actorUuid,
                tokenUuid: target.tokenUuid,
                eligible: target.eligible,
                eligibilityReason: target.eligibilityReason
            })),
            targetConstraints: state.targetConstraints
        });
        // The cast's one roll that picks the condition ("Roll [[/r 1d4]]. On a 1, …"); a 4 waits for the caster's choice.
        // `options.conditionRollResult` fixes the result (a replayed or GM-entered roll).
        if (state.conditionRoll) {
            const fixed = Number.isInteger(options.conditionRollResult) ? options.conditionRollResult : null;
            const roll = fixed == null ? await new Roll(state.conditionRoll.formula).evaluate() : null;
            state.conditionRoll.rolled = fixed ?? roll.total;
            state.conditionRoll.slug = state.conditionRoll.kind === "degree-results" ? `result ${state.conditionRoll.rolled}` : state.conditionRoll.results[state.conditionRoll.rolled] ?? null;
            if (roll) try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: sourceActor }), flavor: `${escapeHTML(plan.source.name)}: which condition (${state.conditionRoll.formula})` }); } catch (_) {}
            // (Realityflicker's critical failure: a second roll — the same condition again, or a choosing face, is the caster's choice.)
            if (state.conditionRoll.criticalSecond) {
                const secondRoll = await new Roll(state.conditionRoll.formula).evaluate();
                const rolled = Number.isInteger(options.conditionRollSecond) ? options.conditionRollSecond : secondRoll.total;
                const slug = state.conditionRoll.results[rolled] ?? null;
                state.conditionRoll.second = { rolled, slug: slug && slug !== state.conditionRoll.slug ? slug : null };
                try { await secondRoll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: sourceActor }), flavor: `${escapeHTML(plan.source.name)}: a critical failure's second condition (${state.conditionRoll.formula})` }); } catch (_) {}
            }
        }
        // (The creatures a spread reaches only at its outer distance take half: Propagating Arc.)
        if (Array.isArray(options.halfTargetUuids)) for (const target of state.targets.filter(target => options.halfTargetUuids.includes(target.tokenUuid))) {
            target.shapeHalf = true; target.shapeNote = String(options.halfNote ?? "half damage"); }
        // (Spellshapes that single out some of the targets — Split Shot's second target, Tempest-Sun Redirection's shielded ones; Mythic Casting's DC.)
        if (state.shapeRiders?.length) {
            await assignShapeTargets(state);
            const mythic = mythicDC(state, sourceActor, spell);
            if (mythic) { state.dcBeforeMythic = state.dc; state.dc = mythic; }
        }
        // (An item's hit standing in for the spell attack roll — castFromItem's attackDegree: Spellstrike Ammunition, a bolt — recorded on each target as its result.)
        const itemHit = options.sourceMessageId ? game.messages.get(options.sourceMessageId)?.getFlag(MODULE_ID, "castFromItem") : null;
        if (state.saveStatistic === "spell-attack" && ["success", "criticalSuccess"].includes(itemHit?.attackDegree)) {
            for (const target of state.targets.filter(targetParticipates)) {
                recordProvisionalSave(state, target.id, { degree: itemHit.attackDegree, timestamp: Date.now(), messageId: null });
                target.itemHit = `${itemHit.itemName}'s hit`;
            }
        }
        const card = await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: sourceActor }),
            content: `<section class="pf2e-auto-runtime-card"><p>Preparing ${escapeHTML(plan.source.name)}…</p></section>`,
            flags: { [MODULE_ID]: { kind: "save-resolution", basicSaveState: state } }
        });
        state.messageId = card.id;
        try { await this.#updateCard(card, state); }
        catch (error) {
            await card.delete().catch(() => {});
            throw error;
        }
        // A Strike-prelude spell's additional damage on a hit joins the caster's own Strike (see strike-prelude-runtime.js).
        const extraOnHit = plan.resolution.strikePrelude?.extraOnHit;
        if (extraOnHit) {
            const [rider] = await sourceActor.createEmbeddedDocuments("Item", [strikeRiderSource({ spellName: plan.source.name,
                reach: plan.resolution.strikePrelude.reach, formula: extraOnHit.formula, damageType: extraOnHit.damageType,
                castId: state.castId, sourceItemUuid: spell?.uuid ?? null, img: spell?.img })]);
            if (!rider) throw new Error(`${plan.source.name}: the Strike's additional damage couldn't be added to ${sourceActor.name}.`);
        }
        if (options.sourceMessageId) {
            try {
                await game.messages.get(options.sourceMessageId)?.setFlag(MODULE_ID, "saveCast", {
                    castId: state.castId,
                    resolutionMessageId: card.id
                });
            } catch (error) {
                console.warn(`${MODULE_ID} | The save-resolution card was created, but its source card could not be marked.`, error);
            }
        }
        // Terrain left in the caster's emanation (Untwisting Iron Roots): a region of difficult terrain around the caster's space, which stays
        // (the GM removes it when it's cleared); the caster's own movement through it is the GM's.
        const left = plan.resolution.leftTerrain;
        if (left) {
            const token = sourceActor.getActiveTokens?.(true, true)?.[0];
            if (!token) throw new Error(`${plan.source.name}: ${sourceActor.name} has no token for the terrain.`);
            const size = canvas.grid.size, feet = size / canvas.grid.distance;
            const [region] = await canvas.scene.createEmbeddedDocuments("Region", [{ name: `${plan.source.name}: difficult terrain`, color: "#7a5c3a",
                shapes: [{ type: "circle", x: token.x + token.width * size / 2, y: token.y + token.height * size / 2, radius: Number(left.area.value) * feet + token.width * size / 2 }],
                behaviors: [{ name: `${plan.source.name}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: terrainDifficulties(["walk"], 2) } }],
                flags: { [MODULE_ID]: { leftTerrain: { castId: state.castId, spellName: plan.source.name } } } }]);
            state.leftTerrainRegionUuid = region?.uuid ?? null;
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: sourceActor }), whisper: game.users.filter(user => user.isGM).map(user => user.id),
                content: `<p><strong>${escapeHTML(plan.source.name)}</strong>: the ${left.area.value}-foot emanation is difficult terrain (its region stays after the spell; remove it when it's cleared).</p>${left.casterExempt ? `<p class="pf2e-auto-gm-reminder"><strong>GM:</strong> ${escapeHTML(sourceActor.name)} moves through it normally; the region applies to everyone, so adjust ${escapeHTML(sourceActor.name)}'s movement.</p>` : ""}` }); } catch (_) {}
        }
        // "The wave moves another 60 feet in the same direction at the start of your next turn, then vanishes.": a card for the GM to move it on.
        if (plan.resolution.waveRepeat && !options.waveLeg) {
            const next = clone(plan);
            delete next.resolution.waveRepeat;
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: sourceActor }), flags: { [MODULE_ID]: { waveRepeat: { plan: next, spellUuid: spell?.uuid ?? null, sourceActorUuid: sourceActor.uuid,
                castRank: state.castRank, dc: state.dc, feet: plan.resolution.waveRepeat.feet, used: false } } },
                content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(plan.source.name)} — the wave moves on</strong></header><p>At the start of ${escapeHTML(sourceActor.name)}'s next turn the wave moves another ${plan.resolution.waveRepeat.feet} feet in the same direction, then vanishes. Place its path; the creatures in it save.</p><button type="button" class="pf2e-auto-wave-repeat"><i class="fa-solid fa-water"></i> Move the wave on</button></section>` }); }
            catch (error) { console.warn(`${MODULE_ID} | The wave card could not be posted.`, error); }
        }
        // (The caster's own Effect while the spell lasts — Poltergeist's Fury's storm giving lesser cover.)
        if (plan.resolution.casterStorm && !options.waveLeg) {
            const storm = plan.resolution.casterStorm;
            await sourceActor.createEmbeddedDocuments("Item", [{ name: `${plan.source.name}: ${storm.name}`, type: "effect", img: spell?.img ?? "icons/svg/whirlwind.svg",
                flags: { [MODULE_ID]: { casterStorm: { castId: state.castId } } },
                system: { duration: { value: Math.max(1, Math.round(storm.seconds / 6)), unit: "rounds", expiry: "turn-start", sustained: storm.sustained === true }, rules: clone(storm.rules),
                    start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, description: { value: `<p>${escapeHTML(storm.text)}</p>` } } }]);
        }
        // (A thrall the spell destroys: removed when it's one of the module's thrall tokens.)
        if (thrallToken && (plan.resolution.reminders ?? []).some(reminder => reminder.kind === "thrall-destroyed") && isThrall(thrallToken)) await destroyThrall(thrallToken);
        // (Mark of Mystery: the caster targeted a marked creature with this spell — its save card for that, after this one.)
        if (!options.markWardTrigger) {
            const marked = (await Promise.all(state.targets.filter(target => target.excluded !== true).map(target => fromUuid(target.actorUuid)))).filter(Boolean);
            void markWardTrigger(sourceActor, marked, (other, more) => this.start(other, more)).catch(error => console.warn(`${MODULE_ID} | Mark ward failed.`, error));
        }
        return { status: "prepared", plan, card, state };
    }

    /** Blister: pop one charge — the pop's basic save for the targeted creatures (the target and those in the cone); the spell ends with the last. */
    async popSave(message, targets = [...(game.user?.targets ?? [])]) {
        const data = message?.getFlag?.(MODULE_ID, "popSave");
        if (!data) throw new Error("This card has nothing to pop.");
        if (!(data.left > 0)) throw new Error(`No ${data.noun}s are left: the spell has ended.`);
        if (game.time.worldTime > data.expiresAt) throw new Error("The spell's duration has run out.");
        const spell = await fromUuid(data.spellUuid), caster = await fromUuid(data.sourceActorUuid);
        if (!spell || !caster) throw new Error("The spell or its caster is gone.");
        if (!game.user.isGM && !caster.testUserPermission(game.user, "OWNER")) throw new Error("The caster pops it.");
        const tokens = targets.map(token => token?.document ?? token).filter(token => token?.actor);
        if (!tokens.some(token => token.uuid === data.targetTokenUuid)) throw new Error(`Target the creature with the ${data.noun}s too (it takes the damage as well).`);
        const left = data.left - 1;
        await message.update({ [`flags.${MODULE_ID}.popSave.left`]: left, content: message.content.replace(/has \d+ [a-z]+s?\./, `has ${left} ${data.noun}${left === 1 ? "" : "s"}.`) });
        return this.start(spell, { plan: data.plan, sourceActor: caster, targets: tokens.map(token => token.object ?? token), castRank: data.castRank, dc: data.dc, skipConfirmation: true });
    }

    /** Pack Breaker: the affected creature's former allies the GM targets save against the same spell (their own immunity keeps it from repeating). */
    async chainSave(message, targets = [...(game.user?.targets ?? [])]) {
        const data = message?.getFlag?.(MODULE_ID, "chainSave");
        if (!data) throw new Error("This card has no chained save.");
        if (data.used) throw new Error("These saves were already started.");
        if (!game.user.isGM) throw new Error("The GM starts the chained saves.");
        const spell = await fromUuid(data.spellUuid), caster = await fromUuid(data.sourceActorUuid);
        if (!spell || !caster) throw new Error("The spell or its caster is gone.");
        const tokens = targets.map(token => token?.document ?? token).filter(token => token?.actor);
        if (!tokens.length) throw new Error(`Target ${data.fromName}'s former allies first.`);
        if (!data.repeatable) await message.setFlag(MODULE_ID, "chainSave", { ...data, used: true });
        return this.start(spell, { plan: data.plan, sourceActor: caster, targets: tokens.map(token => token.object ?? token), castRank: data.castRank, dc: data.dc, skipConfirmation: true,
            ...(data.parentCastId ? { parentCastId: data.parentCastId } : {}) });
    }

    /** Grisly Growths' second save: every creature within the distance of the target (the target too), with its own table and immunity. */
    async areaFollowUp(message) {
        const data = message?.getFlag?.(MODULE_ID, "areaFollowUp");
        if (!data) throw new Error("This card has no follow-up save.");
        if (data.used) throw new Error("The follow-up saves were already started.");
        if (!game.user.isGM) throw new Error("The GM starts the follow-up saves.");
        const spell = await fromUuid(data.spellUuid), caster = await fromUuid(data.sourceActorUuid), centre = await fromUuid(data.centreTokenUuid);
        if (!spell || !caster || !centre) throw new Error("The spell, its caster or the target is gone.");
        const reach = data.outer?.radius ?? data.radius;
        const inside = (centre.parent?.tokens ?? canvas.scene.tokens).filter(token => token.actor?.isOfType?.("creature") && (token.id === centre.id ? !data.excludeCentre : tokenDistance(token, centre) <= reach));
        // (Propagating Arc: "There must be at least 1 creature within 10 feet of the target …"; those further out take half.)
        const outerOnly = data.outer ? inside.filter(token => tokenDistance(token, centre) > data.radius) : [];
        if (data.needsInner && inside.length === outerOnly.length) { await message.setFlag(MODULE_ID, "areaFollowUp", { ...data, used: true }); return { status: "none-within" }; }
        await message.setFlag(MODULE_ID, "areaFollowUp", { ...data, used: true });
        return this.start(spell, { plan: data.plan, sourceActor: caster, targets: inside.map(token => token.object ?? token), castRank: data.castRank, dc: data.dc, skipConfirmation: true,
            ...(outerOnly.length ? { halfTargetUuids: outerOnly.map(token => token.uuid), halfNote: `further than ${data.radius} feet: half` } : {}) });
    }

    /** The wave's second move (Sea Surge): the GM places its path; the creatures in it (of the size) get the same save. */
    async waveRepeat(message, { region = null } = {}) {
        const data = message?.getFlag?.(MODULE_ID, "waveRepeat");
        if (!data) throw new Error("This card has no wave.");
        if (data.used) throw new Error("The wave already moved on.");
        if (!game.user.isGM) throw new Error("The GM moves the wave.");
        const spell = await fromUuid(data.spellUuid), caster = await fromUuid(data.sourceActorUuid);
        if (!spell || !caster) throw new Error("The spell or its caster is gone.");
        const placed = region ?? await spell.clone({ "system.area": { type: "line", value: data.feet } }).placeTemplate();
        if (!placed) return { status: "cancelled" };
        const inside = (placed.parent?.tokens ?? canvas.scene.tokens).filter(token => {
            if (!token.actor?.isOfType?.("creature") || token.actor === caster) return false;
            const centre = token.getCenterPoint?.() ?? { x: token.x + token.width * canvas.grid.size / 2, y: token.y + token.height * canvas.grid.size / 2 };
            return placed.testPoint({ x: centre.x, y: centre.y, elevation: token.elevation ?? 0 });
        });
        await message.setFlag(MODULE_ID, "waveRepeat", { ...data, used: true });
        if (!region) setTimeout(() => placed.delete().catch(() => null), 6000);
        if (!inside.length) return { status: "empty" };
        return this.start(spell, { plan: data.plan, sourceActor: caster, targets: inside.map(token => token.object ?? token), castRank: data.castRank, dc: data.dc, skipConfirmation: true, waveLeg: true });
    }

    /**
     * The card's light/darkness reminder: the GM names the magical light or darkness (its counteract DC and rank); the
     * caster's PF2e counteract check (the spell's counteract rank is the cast rank) decides; the GM ends it if counteracted.
     */
    async counteractReminder(card, index, { choice = null } = {}) {
        if (!game.user.isGM) throw new Error("The GM resolves the counteract.");
        const state = stateFromCard(card);
        const reminder = state?.reminders?.[index];
        if (!reminder || !["counteract-along-path", "counteract-overlap", "counteract-spell", "counteract-fixed"].includes(reminder.kind)) throw new Error("This card has no such counteract reminder.");
        const sourceSpell = await castSpellFromUuid(state);
        if (!sourceSpell) throw new Error(`${state.spellName}: the original spell is unavailable.`);
        const spell = resolveSpellAtRank(sourceSpell, state.castRank, state.overlayIds);
        choice ??= await foundry.applications.api.DialogV2.prompt({ window: { title: `${state.spellName} — counteract the ${reminder.target}` },
            content: `<p>${escapeHTML(reminder.text)}</p><label>The magical ${escapeHTML(reminder.target)} <input type="text" name="name"></label>
                <label>Its counteract DC <input type="number" name="dc"></label><label>Its counteract rank <input type="number" name="rank"></label>`,
            ok: { label: "Roll counteract", callback: (_event, button) => ({ name: String(button.form.elements.name.value).trim(), dc: Number(button.form.elements.dc.value), rank: Number(button.form.elements.rank.value) }) },
            rejectClose: false });
        if (!choice) return null;
        if (!choice.name || !Number.isFinite(choice.dc) || !Number.isInteger(choice.rank)) throw new Error(`${state.spellName}: name the ${reminder.target} and enter its counteract DC and rank.`);
        // (A stated modifier and rank — "counteract modifier +25, counteract rank 8" — is a plain d20 roll against the DC; otherwise the caster's own check.)
        let roll;
        if (reminder.kind === "counteract-fixed") {
            roll = await new Roll(`1d20 + ${Number(reminder.modifier)}`).evaluate();
            const natural = roll.dice[0]?.total ?? 10;
            let degree = roll.total >= choice.dc + 10 ? 3 : roll.total >= choice.dc ? 2 : roll.total <= choice.dc - 10 ? 0 : 1;
            degree = Math.max(0, Math.min(3, degree + (natural === 20 ? 1 : natural === 1 ? -1 : 0)));
            roll.degreeOfSuccess = degree;
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: spell.actor }), flavor: `<strong>${escapeHTML(state.spellName)}</strong> — counteract the ${escapeHTML(reminder.target)} (+${escapeHTML(reminder.modifier)} vs DC ${escapeHTML(choice.dc)})` });
        } else {
            const statistic = spell.spellcasting?.counteraction ?? spell.spellcasting?.statistic;
            if (!statistic) throw new Error(`${state.spellName}: the caster's counteract statistic is unavailable.`);
            roll = await statistic.check.roll({ dc: { value: choice.dc }, item: spell, extraRollOptions: ["action:counteract"], skipDialog: true });
        }
        let counterRank = reminder.kind === "counteract-fixed" ? Number(reminder.rank) : Number(state.castRank);
        // (Deathless Light: "increases the spell rank of a spell with the light trait by 1 (maximum 7) when determining whether the spell's light will … counteract a Darkness spell".)
        const lightRank = reminder.target === "darkness" ? (state.shapeRiders ?? []).flatMap(shape => shape.riders ?? []).find(rider => rider.type === "light-rank") : null;
        if (lightRank) counterRank = Math.max(counterRank, Math.min(Number(lightRank.max), counterRank + Number(lightRank.by)));
        const countered = counteracts(roll.degreeOfSuccess, counterRank, choice.rank);
        const degree = ["critical failure", "failure", "success", "critical success"][roll.degreeOfSuccess];
        const content = `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(state.spellName)} — counteract the ${escapeHTML(reminder.target)}</strong></header>
            <p>Counteract check vs DC ${escapeHTML(choice.dc)}: ${escapeHTML(degree)} (rank ${escapeHTML(counterRank)} vs ${escapeHTML(choice.rank)}).</p>
            <p>${countered ? `<strong>GM to apply:</strong> ${escapeHTML(choice.name)} is counteracted: end it.` : `${escapeHTML(choice.name)} is not counteracted.`}</p></section>`;
        const message = await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor: spell.actor }),
            flags: { [MODULE_ID]: { reminderCounteract: { castId: state.castId, index, name: choice.name, dc: choice.dc, rank: choice.rank, degree: roll.degreeOfSuccess, countered } } } });
        return { countered, degree: roll.degreeOfSuccess, message };
    }

    async handleCardAction(button, event = null) {
        const card = game.messages.get(button.dataset.messageId);
        if (!card) throw new Error("The save-resolution card no longer exists.");
        const castId = stateFromCard(card)?.castId;
        // The caster's own cast-wide buttons, pressed on a client that doesn't coordinate the card: the coordinating GM's client does it.
        // (Adding targets is the caster's own: done right here when they may edit the card.)
        if (button.dataset.saveAction === "add-targets" && !isCardCoordinator(card) && await casterMayEditCard(card, stateFromCard(card)))
            return await this.#queue(castId, () => this.addTargets(card));
        if (CASTER_SAVE_ACTIONS.has(button.dataset.saveAction) && !isCardCoordinator(card)) {
            const state = stateFromCard(card);
            const caster = state?.sourceActorUuid ? await fromUuid(state.sourceActorUuid) : null;
            if (!caster?.testUserPermission?.(game.user, "OWNER")) throw new Error("Only the caster or the GM can use this control.");
            if (!activeUsers().some(user => user.isGM)) throw new Error("A GM must be connected to resolve this cast.");
            game.socket.emit(`module.${MODULE_ID}`, { type: "save-card-request", castId, action: button.dataset.saveAction, rollId: button.dataset.rollId ?? null,
                userId: game.user.id, targetTokenUuids: [...(game.user?.targets ?? [])].map(token => token.document?.uuid ?? token.uuid).filter(Boolean) });
            ui.notifications.info(`${state.spellName}: sent to the GM.`);
            return { status: "requested" };
        }
        if (button.dataset.saveAction === "correct-target" && button.dataset.correctionAction === "condition") {
            return await this.#promptConditionCorrection(card, button.dataset.targetId, Number(button.dataset.degree), Number(button.dataset.targetRevision));
        }
        if (button.dataset.saveAction === "correct-target") return await this.correctTarget(card, button.dataset.targetId, {
            action: button.dataset.correctionAction,
            degree: button.dataset.degree,
            stage: button.dataset.saveStage,
            expectedRevision: Number(button.dataset.targetRevision)
        });
        if (button.dataset.saveAction === "counteract-reminder") return await this.counteractReminder(card, Number(button.dataset.reminderIndex));
        if (button.dataset.saveAction === "add-targets") return await this.#queue(castId, () => this.addTargets(card));
        if (button.dataset.saveAction === "cast-choice") return await this.chooseCastOption(card, button.dataset.choice);
        if (button.dataset.saveAction === "dice-upgrade") return await this.answerDiceUpgrade(card, button.dataset.choice);
        if (button.dataset.saveAction === "sacrifice") return await this.answerSacrifice(card, button.closest(".pf2e-auto-confirmation")?.querySelector("select.pf2e-auto-sacrifice")?.value ?? null);
        if (button.dataset.saveAction === "bone-armor") return await this.answerBoneArmor(card, button.dataset.choice);
        if (button.dataset.saveAction === "persistent-rider") return await this.answerPersistentRider(card, button.dataset.choice);
        if (button.dataset.saveAction === "damage-bonus") return await this.answerDamageBonus(card, Number(button.dataset.choice));
        if (button.dataset.saveAction === "dice-split") return await this.answerDiceSplit(card, Number(button.dataset.choice));
        if (button.dataset.saveAction === "area-terrain") return await this.placeAreaTerrain(card);
        if (button.dataset.saveAction === "cast-gate") return await this.answerCastGate(card, button.dataset.answer);
        if (button.dataset.saveAction === "beneficiary-effect") return await this.grantBeneficiaryEffect(card, [...(game.user?.targets ?? [])]);
        if (button.dataset.saveAction === "heal-back") return await this.healBack(card, [...(game.user?.targets ?? [])]);
        if (button.dataset.saveAction === "partner-grant") return await this.grantPartner(card, [...(game.user?.targets ?? [])]);
        if (button.dataset.saveAction === "caster-draw") return await this.drawBlood(card, button.dataset.choice);
        if (button.dataset.saveAction === "heal-spread") return await this.spreadHealing(card, [...(game.user?.targets ?? [])]);
        if (button.dataset.saveAction === "caster-choice") return await this.chooseCasterOption(card, button.dataset.choice);
        if (button.dataset.saveAction === "condition-choice") return await this.chooseRolledCondition(card, button.dataset.choice);
        if (button.dataset.saveAction === "finalize") return await this.finalize(card);
        // Kept for save cards persisted by module versions before 0.6.0.
        if (button.dataset.saveAction === "roll-damage") return await this.#queue(castId, () => this.rollDamage(card));
        if (button.dataset.saveAction === "roll-outcome-damage") {
            return await this.#queue(castId, () => this.rollOutcomeDamage(card, button.dataset.rollId));
        }
        if (button.dataset.saveAction === "roll-all") return await this.rollAll(card, { event });
        if (button.dataset.saveAction === "roll-save") {
            return await this.rollSave(card, button.dataset.targetId, { event, stage: button.dataset.saveStage });
        }
        if (button.dataset.saveAction === "hero-reroll") {
            return await this.rollSave(card, button.dataset.targetId, { heroPoint: true, stage: button.dataset.saveStage });
        }
        if (button.dataset.saveAction === "apply") return await this.apply(card);
        throw new Error(`Unknown save-resolution action ${JSON.stringify(button.dataset.saveAction)}.`);
    }

    async #promptConditionCorrection(card, targetId, conditionIndex, expectedRevision) {
        if (!game.user.isGM || !isCardCoordinator(card)) throw new Error("Only the coordinating GM can correct this cast.");
        const state = stateFromCard(card);
        const target = state?.targets?.find(entry => entry.id === targetId);
        const effect = target && outcomeEffectsForTarget(state, target)[conditionIndex];
        if (!effect) throw new Error("The condition outcome changed. Refresh the card.");
        const duration = conditionDuration(effect, state.lifecycle);
        const changes = await foundry.applications.api.DialogV2.prompt({
            window: { title: `${target.name} — Adjust ${effect.name}` },
            content: `<p>Adjust this cast's outcome before Finalize. Rerolling or changing a save clears these adjustments.</p>
                ${effect.value != null ? `<label>Condition value <input name="conditionValue" type="number" min="1" step="1" value="${effect.value}"></label>` : ""}
                <label>Duration <input name="durationValue" type="number" min="0.01" step="any" value="${duration.value > 0 ? duration.value : 1}"></label>
                <label>Unit <select name="durationUnit">${["rounds", "minutes", "hours", "days", "unlimited"].map(unit => `<option value="${unit}"${unit === duration.unit ? " selected" : ""}>${unit}</option>`).join("")}</select></label>
                <label>Expiry <select name="durationExpiry">${[["", "No turn boundary"], ["turn-start", "Start of turn"], ["turn-end", "End of turn"]].map(([value, label]) => `<option value="${value}"${value === (duration.expiry ?? "") ? " selected" : ""}>${label}</option>`).join("")}</select></label>
                <label><input name="restore" type="checkbox"> Restore calculated outcome</label>`,
            ok: { label: "Save adjustment", callback: (_event, button) => {
                const form = button.form;
                if (form.elements.restore.checked) return {};
                const unit = form.elements.durationUnit.value;
                return {
                    ...(effect.value != null ? { value: Number(form.elements.conditionValue.value) } : {}),
                    duration: unit === "unlimited" ? { mode: "unlimited" } : {
                        mode: "fixed", value: Number(form.elements.durationValue.value), unit,
                        expiry: form.elements.durationExpiry.value || null, anchor: duration.anchor
                    }
                };
            } }, rejectClose: false, modal: true
        });
        if (changes == null) return { status: "cancelled" };
        return await this.correctTarget(card, targetId, { action: "condition", conditionIndex, changes, expectedRevision });
    }

    async correctTarget(card, targetId, correction) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!game.user.isGM || !isCardCoordinator(card)) throw new Error("Only the coordinating GM can correct this cast.");
            const state = stateFromCard(card);
            if (!state) throw new Error("The save-resolution state is missing.");
            const target = correctSaveTarget(state, targetId, correction, game.user.id);
            if (correction.action === "condition") {
                const override = target.conditionOverrides?.[correction.conditionIndex];
                if (override) override.original.duration ??= conditionDuration(override.original, state.lifecycle);
            }
            await this.#updateCard(card, state);
            return { status: "corrected", state, target };
        });
    }

    /** The caster's cast-time choice (for example a compelled behaviour); GM-recorded before Finalize. */
    async chooseCastOption(card, name) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!game.user.isGM || !isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the cast choice.");
            const state = stateFromCard(card);
            if (!state?.castChoice) throw new Error("This cast has no cast-time choice.");
            if (state.status !== "collecting") throw new Error(`${state.spellName}: the choice is locked after finalization begins.`);
            if (!state.castChoice.options.some(option => option.name === name)) throw new Error(`Unknown choice ${JSON.stringify(name)}.`);
            state.castChoice.selected = name;
            await this.#updateCard(card, state);
            return { status: "chosen", state };
        });
    }

    /** The caster's choice of condition when the cast's roll lets them choose. */
    async chooseRolledCondition(card, slug) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the choice.");
            const state = stateFromCard(card);
            const roll = state?.conditionRoll;
            if (!roll) throw new Error("This cast has no rolled condition.");
            if (!roll.options.includes(slug)) throw new Error(`Choose one of: ${roll.options.join(", ")}.`);
            // (The critical failure's second condition, once the first is known: a different one.)
            if (roll.slug && roll.second && !roll.second.slug) {
                if (slug === roll.slug) throw new Error(`${state.spellName}: the second condition must differ from ${roll.slug}.`);
                roll.second.slug = slug; roll.second.chosen = true;
                await this.#updateCard(card, state);
                return { status: "chosen", state };
            }
            if (roll.slug) throw new Error(`${state.spellName}: the condition is already ${roll.slug}.`);
            roll.slug = slug; roll.chosen = true;
            await this.#updateCard(card, state);
            return { status: "chosen", state };
        });
    }

    /** The caster's choice for the cast (a damage type the rows' Effect reads), recorded before finalizing. */
    async chooseCasterOption(card, value) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the choice.");
            const state = stateFromCard(card);
            const choice = state?.casterChoice;
            if (!choice) throw new Error("This cast has no caster's choice.");
            if (state.status !== "collecting") throw new Error(`${state.spellName}: the choice is locked after finalization begins.`);
            if (!choice.values.includes(value)) throw new Error(`Choose one of: ${choice.values.join(", ")}.`);
            // (A second pick for the rows that get two: Sensory Deprivation's critical failure.)
            if (choice.selected && choice.twoOn?.length && !choice.also) {
                if (value === choice.selected) throw new Error(`${state.spellName}: choose a different ${choice.label.toLowerCase()}.`);
                choice.also = value;
                await this.#updateCard(card, state);
                return { status: "chosen", state };
            }
            if (choice.selected) throw new Error(`${state.spellName}: the ${choice.label.toLowerCase()} is already ${choice.selected}.`);
            choice.selected = value;
            // An option's critical-failure extra: the other options' inline formulas leave the rows (their conditions are filtered).
            if (choice.kind === "option") for (const outcome of Object.values(state.outcomes ?? {})) {
                if (outcome?.damage?.mode !== "mixed") continue;
                const kept = (outcome.damage.formulas ?? []).filter(entry => entry.option == null || entry.option === value);
                // (The card's flag update merges objects: the dropped keys are written as null so they don't survive.)
                outcome.damage = kept.length ? { ...outcome.damage, formulas: kept } : { mode: "shared", ...outcome.damage.shared, formulas: null, shared: null, rollScope: null };
            }
            await this.#updateCard(card, state);
            return { status: "chosen", state };
        });
    }

    /** After a damaging save: PF2e's linked Effect on the one willing creature the caster targets (once for the cast). */
    async grantBeneficiaryEffect(card, targets) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can grant it.");
            const state = stateFromCard(card);
            const benefit = state?.beneficiaryEffect;
            if (!benefit) throw new Error("This cast grants no Effect.");
            if (state.status !== "completed") throw new Error(`${state.spellName}: finalize the save first.`);
            if (benefit.grantedTo) throw new Error(`${state.spellName}: already granted to ${benefit.grantedTo}.`);
            if (!(state.targets ?? []).some(target => Number(confirmedDamageSummary({ status: "completed", targets: [target] }).damage ?? 0) > 0))
                throw new Error(`${state.spellName}: the target took no damage.`);
            const tokens = targets.map(token => token?.document ?? token).filter(token => token?.actor);
            if (tokens.length !== 1) throw new Error(`${state.spellName}: target the one willing creature to grant it to.`);
            const actor = tokens[0].actor;
            if ((state.targets ?? []).some(target => target.actorUuid === actor.uuid)) throw new Error(`${state.spellName}: grant it to another creature, not the one it damaged.`);
            const template = await loadNativeEffectTemplate(benefit.uuid);
            if (!template) throw new Error(`${state.spellName}: PF2e's ${benefit.label} is unavailable.`);
            await createNativeEffect(actor, prepareNativeEffectSource(template, { castInstanceId: state.castId, castRank: state.castRank, sourceActorUuid: state.sourceActorUuid,
                sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName }));
            benefit.grantedTo = actor.name;
            await this.#updateCard(card, state);
            return { status: "granted", state };
        });
    }

    /** After Finalize (Blood-Feasting Breath): the caster and the targeted living creatures regain the most any one creature lost. */
    async spreadHealing(card, targets) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can heal them.");
            const state = stateFromCard(card);
            const spread = state?.healSpread;
            if (!spread) throw new Error("This cast heals no one.");
            if (state.status !== "completed") throw new Error(`${state.spellName}: finalize the save first.`);
            if (spread.healed) throw new Error(`${state.spellName}: already healed.`);
            const amount = Math.max(0, ...state.targets.filter(targetParticipates).map(target => (target.damageResults ?? []).reduce((sum, entry) => sum + Math.max(0, Number(entry.receipt?.damage ?? 0)), 0)));
            if (amount <= 0) throw new Error(`${state.spellName}: no creature took damage.`);
            const caster = await fromUuid(state.sourceActorUuid);
            const tokens = targets.map(token => token?.document ?? token).filter(token => token?.actor);
            const recipients = new Map();
            if (caster) recipients.set(caster.uuid, { actor: caster, token: caster.getActiveTokens?.(false, true)?.[0] ?? null });
            for (const token of tokens) {
                if (state.targets.some(target => target.actorUuid === token.actor.uuid)) throw new Error(`${state.spellName}: ${token.name} was in the first cone.`);
                // "all living creatures in the second cone".
                const being = token.actor.modeOfBeing ?? ((token.actor.traits?.has?.("undead") ?? false) ? "undead" : "living");
                if (being !== "living") throw new Error(`${state.spellName}: ${token.name} isn't living.`);
                recipients.set(token.actor.uuid, { actor: token.actor, token });
            }
            const names = [];
            for (const { actor, token } of recipients.values()) {
                await applyDamageWithReceipt(actor, { damage: -amount, token: token ?? undefined, skipIWR: true, rollOptions: new Set() }, randomID());
                names.push(actor.name);
            }
            spread.healed = { amount, names };
            await this.#updateCard(card, state);
            return { status: "healed", amount, names, state };
        });
    }

    /** After Finalize (Call the Blood): the caster's part — Sickened for the living; for the undead, temporary Hit Points and Quickened briefly, or Quickened longer. */
    async drawBlood(card, choice) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can apply it.");
            const state = stateFromCard(card);
            const draw = state?.casterDraw;
            if (!draw) throw new Error("This cast draws no blood.");
            if (state.status !== "completed") throw new Error(`${state.spellName}: finalize the save first.`);
            if (draw.result) throw new Error(`${state.spellName}: already applied.`);
            const lost = casterDrawLost(state);
            if (lost <= 0) throw new Error(`${state.spellName}: the target took no damage.`);
            const caster = await fromUuid(state.sourceActorUuid);
            const mode = casterDrawMode(caster);
            if (mode === "none" || (mode === "living") !== (choice === "living") || !["living", "temp", "quickened"].includes(choice))
                throw new Error(`${state.spellName}: that choice isn't the caster's (${mode}).`);
            const runtime = { castId: state.castId, castRank: state.castRank, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid,
                sourceItemName: state.spellName, targetActorUuid: caster.uuid };
            if (choice === "living") {
                // ("you're Sickened 2": at least that value — PF2e's increase adds to a value the caster already has, so only the difference.)
                const current = Number(caster.getCondition?.(draw.living.slug)?.value ?? 0);
                if (current < draw.living.value) await caster.increaseCondition(draw.living.slug, current ? { value: draw.living.value - current } : { value: draw.living.value });
                draw.result = `${caster.name} is ${draw.living.name} ${draw.living.value}.`;
            } else {
                const template = await fromUuid(draw.undead.condition.uuid);
                if (!template) throw new Error(`${state.spellName}: PF2e's ${draw.undead.condition.name} condition is unavailable.`);
                const time = choice === "temp" ? draw.undead.withTemp : draw.undead.without;
                const sources = [prepareConditionGrantSource({ slug: draw.undead.condition.slug, name: draw.undead.condition.name, value: null }, template, { ...runtime, duration: { mode: "fixed", ...time } }),
                    prepareNoteEffectSource({ label: `${draw.undead.condition.name} (extra action)`, text: draw.undead.restriction, sourceText: draw.sourceText, duration: { mode: "fixed", ...time } }, runtime)];
                const temp = Math.floor(lost * draw.undead.fraction);
                // (PF2e's TempHP rule: granted now, removed when this Effect ends after the stated time.)
                if (choice === "temp" && temp > 0) {
                    const holder = prepareNoteEffectSource({ label: "temporary Hit Points", text: `${temp} temporary Hit Points; any remaining are lost when this ends.`, sourceText: draw.sourceText,
                        duration: { mode: "fixed", ...draw.undead.tempLasts } }, runtime);
                    holder.system.rules = [{ key: "TempHP", value: temp }];
                    sources.push(holder);
                }
                await caster.createEmbeddedDocuments("Item", sources);
                draw.result = choice === "temp" ? `${caster.name} gains ${temp} temporary Hit Points and is ${draw.undead.condition.name} for ${time.value} round.` : `${caster.name} is ${draw.undead.condition.name} for ${time.value} minute.`;
            }
            await this.#updateCard(card, state);
            return { status: "applied", state };
        });
    }

    /** After Finalize: the foe's row's condition on the other target (the caster or an ally), once for the cast. */
    async grantPartner(card, targets) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can grant it.");
            const state = stateFromCard(card);
            const partner = state?.partnerGrant;
            if (!partner) throw new Error("This cast grants nothing to another target.");
            if (state.status !== "completed") throw new Error(`${state.spellName}: finalize the save first.`);
            if (partner.grantedTo) throw new Error(`${state.spellName}: already granted to ${partner.grantedTo.name}.`);
            const row = partner.rows?.[partnerDegree(state)];
            if (!row) throw new Error(`${state.spellName}: the foe's result grants the other target nothing.`);
            const tokens = targets.map(token => token?.document ?? token).filter(token => token?.actor);
            if (tokens.length !== 1) throw new Error(`${state.spellName}: target the one creature (yourself or an ally).`);
            const actor = tokens[0].actor, caster = await fromUuid(state.sourceActorUuid);
            if ((state.targets ?? []).some(target => target.actorUuid === actor.uuid)) throw new Error(`${state.spellName}: the other target can't be the foe.`);
            if (actor.uuid !== caster?.uuid && !(caster?.isAllyOf?.(actor))) throw new Error(`${state.spellName}: grant it to yourself or an ally.`);
            const template = await fromUuid(row.uuid);
            if (!template) throw new Error(`${state.spellName}: PF2e's ${row.name} condition is unavailable.`);
            const runtime = { castId: state.castId, castRank: state.castRank, duration: row.duration, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid,
                sourceItemName: state.spellName, targetActorUuid: actor.uuid };
            const sources = [prepareConditionGrantSource({ slug: row.slug, name: row.name, value: row.value ?? null }, template, runtime)];
            if (partner.restriction) sources.push(prepareNoteEffectSource({ label: `${row.name} (extra action)`, text: partner.restriction, sourceText: row.sourceText, duration: row.duration }, runtime));
            await actor.createEmbeddedDocuments("Item", sources);
            partner.grantedTo = { name: actor.name, condition: row.name };
            await this.#updateCard(card, state);
            return { status: "granted", state };
        });
    }

    /** After Finalize: the caster's pick (itself or an ally near the thrall) regains the multiple of the Hit Points the creature lost; once per creature per the stated time. */
    async healBack(card, targets) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can apply it.");
            const state = stateFromCard(card);
            const heal = state?.healBack;
            if (!heal) throw new Error("This cast heals no one.");
            if (state.status !== "completed") throw new Error(`${state.spellName}: finalize the save first.`);
            if (heal.grantedTo) throw new Error(`${state.spellName}: already healed ${heal.grantedTo}.`);
            const lost = healBackLost(state);
            const amount = Math.floor(lost.reduce((total, entry) => total + entry.lost, 0) * heal.multiplier);
            if (amount <= 0) throw new Error(`${state.spellName}: no Hit Points were lost.`);
            const tokens = targets.map(token => token?.document ?? token).filter(token => token?.actor);
            if (tokens.length !== 1) throw new Error(`${state.spellName}: target the one creature to heal (you or an ally).`);
            const actor = tokens[0].actor, caster = await fromUuid(state.sourceActorUuid);
            if (actor.uuid !== caster?.uuid && !(caster?.isAllyOf?.(actor))) throw new Error(`${state.spellName}: heal yourself or an ally.`);
            const origin = heal.within.of === "thrall" ? (state.thrall?.tokenUuid ? await fromUuid(state.thrall.tokenUuid) : null) : null;
            if (heal.within.of === "thrall" && origin?.object && tokens[0].object && canvas.grid.measurePath([origin.object.center, tokens[0].object.center]).distance > heal.within.feet)
                throw new Error(`${state.spellName}: the creature must be within ${heal.within.feet} feet of the thrall.`);
            const key = `heal-back:${state.spellSlug ?? state.spellName}`;
            if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.healBackLock === key)) throw new Error(`${state.spellName}: ${actor.name} was healed by this spell too recently.`);
            const wasDying = isDying(actor);
            const receipt = await applyDamageWithReceipt(actor, { damage: -amount, token: tokens[0], skipIWR: true, rollOptions: new Set() }, randomID());
            await recoverFromDying(actor, wasDying);
            await actor.createEmbeddedDocuments("Item", [{ name: `${state.spellName}: healed (not again for ${heal.onceEvery.value} ${heal.onceEvery.unit})`, type: "effect", img: "icons/svg/regen.svg",
                flags: { [MODULE_ID]: { healBackLock: key, outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, conditions: [] } } },
                system: { duration: { value: heal.onceEvery.value, unit: heal.onceEvery.unit, expiry: "turn-start", sustained: false }, level: { value: state.castRank },
                    start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                    description: { value: `<p>${escapeHTML(state.spellName)} can't heal this creature again until this ends.</p>` }, rules: [] } }]);
            heal.grantedTo = actor.name; heal.amount = receipt?.healing ?? amount;
            await this.#updateCard(card, state);
            return { status: "healed", amount, healing: receipt?.healing ?? null, state };
        });
    }

    /** The caster's number for additional damage, recorded before the damage is rolled. */
    async answerDamageBonus(card, answer) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the answer.");
            const state = stateFromCard(card);
            if (!state?.damageBonus) throw new Error("This cast has no additional-damage question.");
            if (state.damage?.rollJSON) throw new Error(`${state.spellName}: the damage was already rolled.`);
            if (!state.damageBonus.choices.includes(answer)) throw new Error(`Answer one of: ${state.damageBonus.choices.join(", ")}.`);
            state.damageBonus.answer = answer;
            await this.#updateCard(card, state);
            return { status: "answered", state };
        });
    }

    /** How many of the heightened dice are the second type, recorded before the damage is rolled. */
    async answerDiceSplit(card, answer) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the answer.");
            const state = stateFromCard(card);
            if (!state?.diceSplit) throw new Error("This cast has no heightened dice to split.");
            if (state.damage?.rollJSON) throw new Error(`${state.spellName}: the damage was already rolled.`);
            if (!Number.isInteger(answer) || answer < 0 || answer > state.diceSplit.steps) throw new Error(`Answer 0 to ${state.diceSplit.steps}.`);
            state.diceSplit.answer = answer;
            await this.#updateCard(card, state);
            return { status: "answered", state };
        });
    }

    /** The caster's emanation of difficult terrain for the spell's duration (a region following the caster's token; the caster exempt), once per cast. */
    async #ensureTerrainAura(plan, sourceActor, spell, castRank, options) {
        const data = plan.resolution.terrainAura;
        const message = options.sourceMessageId ? game.messages.get(options.sourceMessageId) : null;
        if (message?.getFlag(MODULE_ID, "terrainAuraMade")) return null;
        // (One emanation at a time: a later attack without the cast's card finds the region still there.)
        const key = `${sourceActor.uuid}:${plan.source.name}`;
        if (canvas.scene?.regions?.some(region => region.flags?.[MODULE_ID]?.terrainAura === key)) return null;
        const casterToken = sourceActor.getActiveTokens?.(false, true)?.[0];
        if (!casterToken) throw new Error(`${plan.source.name}: the caster needs a token on the scene for the emanation.`);
        if (!this.ongoing?.startRegionArea) throw new Error(`${plan.source.name} needs the ongoing spell manager.`);
        const size = canvas.grid.size, pixels = data.radius / canvas.dimensions.distance * size + Number(casterToken.width ?? 1) * size / 2;
        const centre = { x: casterToken.x + Number(casterToken.width ?? 1) * size / 2, y: casterToken.y + Number(casterToken.height ?? 1) * size / 2 };
        const [region] = await canvas.scene.createEmbeddedDocuments("Region", [{ name: `${plan.source.name} (${sourceActor.name})`, color: "#99ccee",
            shapes: [{ type: "circle", x: centre.x, y: centre.y, radiusX: pixels, radiusY: pixels, radius: pixels, rotation: 0, hole: false }],
            flags: { [MODULE_ID]: { followToken: casterToken.uuid, followShape: "emanation", followRadius: pixels, terrainAura: key } } }]);
        const spec = plan.lifecycle?.durationSpec;
        const seconds = spec?.mode === "fixed" ? Number(spec.value) * ({ rounds: 6, minutes: 60, hours: 3600 }[spec.unit] ?? 0) : 60;
        const started = await this.ongoing.startRegionArea({ spellName: plan.source.name, sourceActorUuid: sourceActor.uuid, sourceItemUuid: spell?.uuid ?? null, castRank, region,
            durationSeconds: seconds, followToken: casterToken.uuid,
            behaviors: [{ name: `${plan.source.name}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: { walk: 1 } },
                flags: { [MODULE_ID]: { selectiveTerrain: { actions: ["walk", "travel"], default: 2, creatures: [{ actorUuid: sourceActor.uuid, difficulty: 1 }] } } } }] });
        if (message) await message.setFlag(MODULE_ID, "terrainAuraMade", true).catch(() => null);
        return started;
    }

    /** After Finalize: the selected region becomes difficult terrain for the stated time (an Ongoing area that removes it). */
    async placeAreaTerrain(card, region = null) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can place it.");
            const state = stateFromCard(card);
            const terrain = state?.areaTerrain;
            if (!terrain) throw new Error("This cast leaves no terrain.");
            if (state.status !== "completed") throw new Error(`${state.spellName}: finalize the save first.`);
            if (terrain.placed) throw new Error(`${state.spellName}: the terrain is already placed.`);
            // (Coral Eruption: each burst's region, up to the stated count, each with the per-square control at the cast rank.)
            if (terrain.gmHazard) {
                const regions = (Array.isArray(region) ? region : region ? [region] : (canvas.regions?.controlled ?? []).map(entry => entry.document)).filter(Boolean);
                if (!regions.length || regions.length > terrain.count + 1) throw new Error(`${state.spellName}: select the bursts' regions (${terrain.count}, or ${terrain.count + 1} underwater).`);
                if (!this.ongoing?.startRegionArea) throw new Error(`${state.spellName} needs the ongoing spell manager.`);
                const formula = `${terrain.gmHazard.formula.replaceAll("@item.rank", String(Number(state.castRank)))}[${terrain.gmHazard.type}]`;
                const castIds = [];
                for (const selected of regions) {
                    const started = await this.ongoing.startRegionArea({ spellName: state.spellName, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, castRank: state.castRank,
                        region: selected, durationSeconds: terrain.durationSeconds, notes: [terrain.sourceText, ...(terrain.notes ?? [])],
                        gmHazard: { kind: "per-square", enemiesOnly: false, formula },
                        behaviors: [{ name: `${state.spellName}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: terrainDifficulties(["walk"], 2) } }] });
                    castIds.push(started?.castId ?? null);
                }
                terrain.placed = { castIds, regionUuids: regions.map(entry => entry.uuid) };
                await this.#updateCard(card, state);
                return { status: "placed", castInstanceIds: castIds, state };
            }
            const selected = region ?? canvas.regions?.controlled?.[0]?.document ?? null;
            if (!selected) throw new Error(`${state.spellName}: select the area's region first.`);
            if (!this.ongoing?.startRegionArea) throw new Error(`${state.spellName} needs the ongoing spell manager.`);
            // (A storm: its damage at the end of a creature's turn inside, at the cast rank, no save; Sustained.)
            if (terrain.hazard?.chosenType && !state.casterChoice?.selected) throw new Error(`${state.spellName}: the damage type wasn't chosen.`);
            const hazard = terrain.hazard ? { formula: terrain.hazard.formula.replaceAll("@item.rank", String(Number(state.castRank))),
                type: terrain.hazard.chosenType ? state.casterChoice.selected : terrain.hazard.type, label: terrain.hazard.label,
                // (Shadow Raid: only enemies, halved for a creature that disbelieved.)
                ...(terrain.hazard.enemiesOnly ? { enemiesOnly: true } : {}), ...(terrain.hazard.halvedOnDisbelief ? { halvedOnDisbelief: true } : {}) } : null;
            const started = await this.ongoing.startRegionArea({ spellName: state.spellName, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, castRank: state.castRank,
                region: selected, durationSeconds: terrain.durationSeconds, notes: [terrain.sourceText, ...(terrain.notes ?? [])],
                ...(hazard ? { events: [...terrain.hazard.events], hazardDamage: hazard, sustained: terrain.sustained === true, hazardOncePerTurn: terrain.hazard.oncePerTurn === true } : {}),
                ...(terrain.disbelief ? { disbelief: { ...terrain.disbelief }, dc: state.dc } : {}),
                behaviors: terrain.noTerrain ? [] : [{ name: `${state.spellName}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: terrainDifficulties(["walk"], 2) } }] });
            terrain.placed = { castId: started?.castId ?? null, regionUuid: selected.uuid };
            await this.#updateCard(card, state);
            return { status: "placed", castInstanceId: started?.castId ?? null, state };
        });
    }

    /** The GM's answer to whether the save happens at all; "no" excludes every target (no damage or effects). */
    async answerCastGate(card, answer) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the answer.");
            const state = stateFromCard(card);
            if (!state?.castGate) throw new Error("This cast has no situation question.");
            if (state.status !== "collecting") throw new Error(`${state.spellName}: the cast is already resolved.`);
            if (!["yes", "no"].includes(answer)) throw new Error("Answer yes or no.");
            state.castGate.answer = answer;
            if (answer === "no") for (const target of state.targets) if (target.applicationStatus === "pending") target.excluded = true;
            await this.#updateCard(card, state);
            return { status: "answered", state };
        });
    }

    /** The caster's answer to whether the extra persistent damage applies, recorded before the damage is rolled. */
    async answerPersistentRider(card, answer) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the answer.");
            const state = stateFromCard(card);
            if (!state?.persistentRider) throw new Error("This cast has no persistent-damage question.");
            if (state.damage?.rollJSON) throw new Error(`${state.spellName}: the damage was already rolled.`);
            if (!["yes", "no"].includes(answer)) throw new Error("Answer yes or no.");
            state.persistentRider.answer = answer;
            await this.#updateCard(card, state);
            return { status: "answered", state };
        });
    }

    /** The caster's answer to a damage-dice question, recorded before the damage is rolled. */
    /** Final Sacrifice: the minion the spell destroys (its cold or water trait makes the damage cold). */
    async answerSacrifice(card, tokenUuid) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the choice.");
            const state = stateFromCard(card);
            if (state?.sacrifice?.pick !== "minion") throw new Error("This cast has no minion to choose.");
            if (state.damage?.rollJSON) throw new Error(`${state.spellName}: the damage was already rolled.`);
            const token = tokenUuid ? await fromUuid(tokenUuid) : null;
            const traits = token?.actor ? (token.actor.traits ?? new Set(token.actor.system?.traits?.value ?? [])) : null;
            if (!token?.actor || !traits?.has?.(state.sacrifice.trait)) throw new Error(`${state.spellName}: choose a token with the ${state.sacrifice.trait} trait.`);
            if (token.actor.uuid === state.sourceActorUuid) throw new Error(`${state.spellName}: the caster isn't its own minion.`);
            state.sacrifice.selected = token.uuid;
            state.sacrifice.selectedName = token.name;
            state.sacrifice.retyped = (state.sacrifice.typeByTrait?.traits ?? []).some(trait => traits.has(trait));
            await this.#updateCard(card, state);
            return { status: "chosen", state };
        });
    }

    /** Bony Barrage: the second thrall's bone armor. */
    async answerBoneArmor(card, answer) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the answer.");
            const state = stateFromCard(card);
            if (!state?.boneArmor) throw new Error("This cast has no bone armor question.");
            if (state.damage?.rollJSON) throw new Error(`${state.spellName}: the damage was already rolled.`);
            if (!["yes", "no"].includes(answer)) throw new Error("Answer yes or no.");
            state.boneArmor.answer = answer;
            await markBoneArmor(state);
            await this.#updateCard(card, state);
            return { status: "answered", state };
        });
    }

    async answerDiceUpgrade(card, answer) {
        return await this.#queue(stateFromCard(card)?.castId, async () => {
            if (!isCardCoordinator(card)) throw new Error("Only the coordinating GM can record the answer.");
            const state = stateFromCard(card);
            if (!state?.diceUpgrade) throw new Error("This cast has no damage-dice question.");
            if (state.damage?.rollJSON) throw new Error(`${state.spellName}: the damage was already rolled.`);
            if (!["yes", "no"].includes(answer)) throw new Error("Answer yes or no.");
            state.diceUpgrade.answer = answer;
            await this.#updateCard(card, state);
            return { status: "answered", state };
        });
    }

    async addTargets(card, targets = game.user.targets) {
        const state = stateFromCard(card);
        if (!state) throw new Error("The save-resolution state is missing.");
        // (The coordinating GM, or the caster themselves when they may edit the card — their own Prepare made it: no GM needed.)
        if (!isCardCoordinator(card) && !(await casterMayEditCard(card, state))) throw new Error("Only the caster or the GM can add targets to this cast.");
        if (state.status !== "collecting") throw new Error(`${state.spellName}: targets are locked after finalization begins.`);
        const snapshots = snapshotTargets(targets, state.targetConstraints, state.degreeAdjustment ?? null, state.dualMode ?? null,
            state.allySplit ? await fromUuid(state.sourceActorUuid) : null, state.traitGrant ?? null);
        const existing = new Set(state.targets.map(target => target.actorUuid));
        const added = snapshots.filter(target => !existing.has(target.actorUuid));
        if (state.bolster) for (const target of added) if (target.eligible) target.bolster = { status: "pending" };
        if (state.traitVariant?.kind === "trait-rows") for (const target of added) {
            if (!target.eligible) continue;
            const actor = await fromUuid(target.actorUuid);
            const traits = actor?.traits && typeof actor.traits.has === "function" ? actor.traits : new Set(actor?.system?.traits?.value ?? []);
            if (state.traitVariant.traits.some(trait => traits.has(trait))) target.traitVariant = state.traitVariant.trait; else target.zone = { status: "pending" };
        }
        else if (state.traitVariant) for (const target of added) {
            const actor = await fromUuid(target.actorUuid);
            const traits = actor?.traits && typeof actor.traits.has === "function" ? actor.traits : new Set(actor?.system?.traits?.value ?? []);
            if (traits.has(state.traitVariant.trait) && !(state.traitVariant.excludedTraits ?? []).some(trait => traits.has(trait))) target.traitVariant = state.traitVariant.trait;
        }
        if (!added.length) {
            globalThis.ui?.notifications?.info?.(`${state.spellName}: no new targeted actors to add.`);
            return { status: "nothing-to-add", added: 0, state };
        }
        state.targets.push(...added);
        await this.#updateCard(card, state);
        debugLog(state.castId, "save targets added", {
            added: added.map(target => ({
                id: target.id,
                name: target.name,
                actorUuid: target.actorUuid,
                tokenUuid: target.tokenUuid,
                eligible: target.eligible,
                eligibilityReason: target.eligibilityReason
            }))
        });
        return { status: "added", added: added.length, targets: added, state };
    }

    async finalize(card) {
        return await this.#queue(stateFromCard(card)?.castId, () => this.#finalize(card));
    }

    async #finalize(card) {
        this.forms?.assertSave(card);
        if (this.ongoing?.hasSave(card.id)) this.ongoing.assertCoordinator();
        let state = stateFromCard(card);
        if (!state) throw new Error("The save-resolution state is missing.");
        if (!isCardCoordinator(card)) throw new Error("The active GM must finalize this cast.");
        const readiness = saveCollectionReadiness(state);
        if (!readiness.ready) throw new Error(`${state.spellName}: ${readiness.reason}`);
        state.status = "finalizing";
        if (state.boneArmor) await markBoneArmor(state);
        await this.#updateCard(card, state);
        debugLog(state.castId, "save finalization started", { targetCount: state.targets.length });
        try {
            if (sharedDamageRequired(state) && !state.damage?.rollJSON) {
                await this.rollDamage(card, { postMessage: false });
            }
            state = stateFromCard(card);
            for (const entry of requiredOutcomeDamageRolls(state).filter(candidate => !candidate.rollJSON)) {
                await this.rollOutcomeDamage(card, entry.id, { postMessage: false });
            }
            // (A chain ends at the first critical success: the targets after it are excluded.)
            if (state.chain?.endsOn) {
                let ended = null;
                for (const target of state.targets) {
                    if (ended && targetParticipates(target)) Object.assign(target, { excluded: true, eligibilityReason: `the chain ended at ${ended}` });
                    else if (!ended && target.degree === state.chain.endsOn) ended = target.name;
                }
                if (ended) await this.#updateCard(card, state);
            }
            return await this.#apply(card, { skipConfirmation: true, createResultCard: true });
        } catch (error) {
            state = stateFromCard(card);
            if (state && state.status === "finalizing") {
                state.status = "collecting";
                await this.#updateCard(card, state).catch(() => {});
            }
            throw error;
        }
    }

    async rollDamage(card, { postMessage = true } = {}) {
        const state = stateFromCard(card);
        if (!state) throw new Error("The save-resolution state is missing.");
        if (state.damage.enabled === false) return { status: "not-required", state };
        if (state.damage.rollJSON) return { status: "already-rolled", state };
        if (!isCardCoordinator(card)) throw new Error("The active GM must roll this cast's shared damage.");
        const sourceActor = await fromUuid(state.sourceActorUuid);
        const sourceSpell = await castSpellDocument(state, sourceActor);
        if (!sourceActor || !sourceSpell) throw new Error(`${state.spellName}: the original caster or spell is unavailable.`);
        if (!game.user.isGM && !sourceActor.canUserModify?.(game.user, "update")) {
            throw new Error(`You do not have permission to roll ${state.spellName}'s damage.`);
        }
        // The text's base formula replaces the entry's before PF2e loads the variant and heightens it.
        const overrides = state.damage.formulaOverrides ?? [];
        const textSpell = overrides.length ? sourceSpell.clone(Object.fromEntries(overrides.map(entry => [`system.damage.${entry.componentId}.formula`, entry.formula])), { keepId: true }) : sourceSpell;
        const spell = overrides.length ? resolveSpellAtRank(textSpell, state.castRank, state.overlayIds, { force: true }) : resolveSpellAtRank(sourceSpell, state.castRank, state.overlayIds);
        // PF2e can clamp a variant to the caster's maximum rank. Never roll
        // structured damage at a different rank than the cast records.
        if (Number.isFinite(Number(spell?.rank)) && Number(spell.rank) !== Number(state.castRank)) {
            throw new Error(`${state.spellName}: PF2e resolved rank ${spell.rank}, not the recorded cast rank ${state.castRank}. Damage was not rolled.`);
        }
        let prepared, roll, evaluated = false;
        if (state.weaponDamage?.dice) {
            // Weapon Storm: the weapon's dice, of its type, at the cast rank.
            const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
            if (!DamageRoll) throw new Error("PF2e's DamageRoll class could not be resolved.");
            roll = await new DamageRoll(state.weaponDamage.formula).evaluate();
            evaluated = true;
            prepared = { context: { options: [] } };
        } else if (state.weaponDamage) {
            // PF2e's own Strike damage roll for the weapon (its dialog skipped: a shift-click inverts the user's setting).
            const strike = weaponStrikes(sourceActor).find(entry => entry.item.id === state.weaponDamage.itemId);
            if (!strike) throw new Error(`${state.spellName}: ${sourceActor.name} no longer wields ${state.weaponDamage.name}.`);
            roll = await strike.damage({ createMessage: false, event: noDialogEvent() });
            if (!roll?.total && roll?.total !== 0) throw new Error(`${state.spellName}: PF2e returned no damage for ${state.weaponDamage.name}.`);
            evaluated = true;
            prepared = { context: { options: [...(strike.item.getRollOptions?.("item") ?? [])] } };
        } else if (state.damage.sourceFormula) {
            // A lingering area's Sustain damage: its own formula, at the cast rank.
            const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
            if (!DamageRoll) throw new Error("PF2e's DamageRoll class could not be resolved.");
            const rollData = spell.getRollData?.({ castRank: state.castRank }) ?? { item: { rank: state.castRank, level: state.castRank } };
            // The text's damage: the type the caster picked replaces its untyped placeholder.
            let sourceFormula = state.damage.sourceFormula;
            if (["damage-type", "option"].includes(state.casterChoice?.kind)) {
                if (!state.casterChoice.selected) throw new Error(`${state.spellName}: choose the ${state.casterChoice.label.toLowerCase()} before rolling damage.`);
                if (!(state.casterChoice.allPools ? /\[(?:persistent,)?untyped\]/ : /\[untyped\]\}?$/).test(sourceFormula)) throw new Error(`${state.spellName}: the damage formula has no type to choose.`);
                const type = state.casterChoice.kind === "option" ? state.casterChoice.options?.[state.casterChoice.selected]?.type : state.casterChoice.selected;
                // (The last pool's type: one pool, or the last of several — "{…[bludgeoning],…[untyped]}".)
                // (Or every pool's, persistent too: Ravaging End.)
                sourceFormula = state.casterChoice.allPools ? sourceFormula.replace(/\[(persistent,)?untyped\]/g, (_m, persistent) => `[${persistent ?? ""}${type}]`)
                    : sourceFormula.replace(/\[untyped\](\}?)$/, `[${type}]$1`);
            }
            // (A die set by the caster's skill — Technomancy Ray's d6 at master in Crafting, d8 at legendary — in place of the text's base die.)
            if (state.skillDie) {
                const skill = sourceActor?.skills?.[state.skillDie.skill] ?? sourceActor?.system?.skills?.[state.skillDie.skill];
                const faces = state.skillDie.byRank?.[Number(skill?.rank ?? 0)] ?? Object.entries(state.skillDie.byRank ?? {}).filter(([rank]) => Number(skill?.rank ?? 0) >= Number(rank)).map(([, value]) => value).at(-1) ?? state.skillDie.base;
                sourceFormula = sourceFormula.replace(new RegExp(`d${state.skillDie.base}\\[`), `d${faces}[`);
                state.skillDie.faces = faces;
            }
            // The persistent rider, of the chosen type, when the caster said it applies (the save scales it with the rest).
            if (state.persistentRider && !state.persistentRider.answer) throw new Error(`${state.spellName}: answer the caster's question before rolling damage.`);
            if (state.persistentRider?.answer === "yes") {
                if (!state.casterChoice?.selected) throw new Error(`${state.spellName}: choose the damage type before rolling damage.`);
                sourceFormula = `{${sourceFormula},${state.persistentRider.formula}[persistent,${state.casterChoice.selected}]}`;
            }
            // (As PF2e spell damage, so the caster's spell-damage rules apply; its formula as before when it can't be.)
            // (The spell's own type toggle — Shadow Wield's suboptions, whose overrides retype its damage — set to the card's choice.)
            const chosenType = state.casterChoice?.kind === "damage-type" ? state.casterChoice.selected : null;
            const typeToggle = chosenType ? (sourceSpell.system?.rules ?? []).find(rule => rule.key === "RollOption" && rule.toggleable && (rule.suboptions ?? []).some(entry => entry.value === chosenType)) : null;
            if (typeToggle && typeof sourceActor.toggleRollOption === "function") await sourceActor.toggleRollOption(typeToggle.domain ?? "all", typeToggle.option, sourceSpell.id, true, chosenType);
            const built = await textSpellDamage(spell, sourceFormula, { castRank: state.castRank });
            roll = built?.roll ?? new DamageRoll(sourceFormula, rollData, { rollerId: game.user.id });
            prepared = built?.context ? { context: built.context } : { context: { options: [...(spell.getRollOptions?.("item") ?? [])] } };
        } else {
            const formDamage = await this.forms?.damage(spell);
            if (!formDamage && typeof spell.getDamage !== "function") throw new Error(`${state.spellName} does not expose PF2e spell damage.`);
            prepared = formDamage ?? await spell.getDamage({ skipDialog: true });
            roll = prepared?.template?.damage?.roll;
            // "4d4 bludgeoning or piercing damage (your choice)": the item's untyped damage, of the type the caster chose.
            if (state.casterChoice?.kind === "damage-type") {
                if (!state.casterChoice.selected) throw new Error(`${state.spellName}: choose the damage type before rolling damage.`);
                // PF2e writes one untyped instance as "{4d4}" (or "{4d4[untyped]}"); anything else isn't retyped.
                const formula = String(roll?.toJSON().formula ?? roll?._formula ?? "");
                const instances = roll?.instances ?? [];
                // (PF2e's own rule may already have typed it as chosen: Shining Starlight Attack's constellation flag.)
                const typed = new RegExp(`^\\{([^{}\\[\\]]+?)\\[${state.casterChoice.selected}\\]\\}$`).exec(formula)?.[1];
                const inner = typed ?? /^\{([^{}\[\]]+?)(?:\[untyped\])?\}$/.exec(formula)?.[1];
                if (!inner || instances.length !== 1 || (!typed && instances[0].type !== "untyped")) throw new Error(`${state.spellName}: PF2e's damage isn't the untyped damage the choice replaces (${formula}).`);
                roll = new roll.constructor(`{${inner}[${state.casterChoice.selected}]}`, roll.data, roll.options);
            }
            // A table row naming the types of two untyped entries (Chthonian Wrath's realm): each instance, in order, of the pair's type.
            if (state.casterChoice?.kind === "damage-pair") {
                if (!state.casterChoice.selected) throw new Error(`${state.spellName}: choose the ${state.casterChoice.label.toLowerCase()} before rolling damage.`);
                const pair = state.casterChoice.pairs?.[state.casterChoice.selected];
                const formula = String(roll?.toJSON().formula ?? roll?._formula ?? "");
                const parts = /^\{([^{}\[\],]+?)(?:\[untyped\])?,([^{}\[\],]+?)(?:\[untyped\])?\}$/.exec(formula);
                // (PF2e merges two equal untyped entries into one: "{10d6}" is 5d6 of each type.)
                const merged = !parts ? /^\{(\d+)d(\d+)(?:\[untyped\])?\}$/.exec(formula) : null;
                const equal = (state.damage?.components ?? []).length === 2 && state.damage.components.every(component => String(component.formula) === String(state.damage.components[0].formula));
                if (!pair || !(parts ? (roll?.instances ?? []).length === 2 : merged && equal && Number(merged[1]) % 2 === 0 && (roll?.instances ?? []).length === 1)
                    || roll.instances.some(instance => instance.type !== "untyped"))
                    throw new Error(`${state.spellName}: PF2e's damage isn't the two untyped entries the choice types (${formula}).`);
                roll = parts ? new roll.constructor(`{${parts[1]}[${pair[0]}],${parts[2]}[${pair[1]}]}`, roll.data, roll.options)
                    : new roll.constructor(`{${Number(merged[1]) / 2}d${merged[2]}[${pair[0]}],${Number(merged[1]) / 2}d${merged[2]}[${pair[1]}]}`, roll.data, roll.options);
            }
            // "increase the damage dice from this spell to d12s": every die of the spell's damage, when the caster said yes.
            if (state.diceUpgrade && !state.diceUpgrade.answer) throw new Error(`${state.spellName}: answer the caster's question before rolling damage.`);
            // The roll's own formula ("{1d8[sonic]}"), not its display text ("1d8 sonic").
            if (roll && state.diceUpgrade?.answer === "yes" && state.diceUpgrade.faces) roll = new roll.constructor(String(roll.toJSON().formula ?? roll._formula).replace(/(\d+)d\d+/g, `$1d${state.diceUpgrade.faces}`), roll.data, roll.options);
            // The text's larger heightening step (the text over PF2e's data): the missing dice of that type at the cast rank.
            for (const entry of state.damage?.heighteningCorrection ?? []) {
                const steps = Math.max(0, Math.floor((Number(state.castRank) - entry.baseRank) / entry.interval));
                if (roll && steps > 0) roll = new roll.constructor(addDice(String(roll.toJSON().formula ?? roll._formula), { count: steps * entry.perStep, faces: entry.faces, type: entry.type }, state.spellName), roll.data, roll.options);
            }
            // "If you are a gug, increase the piercing damage by 2d6 …": the caster's yes adds the dice to that type's instance.
            if (roll && state.diceUpgrade?.answer === "yes" && state.diceUpgrade.adds) roll = new roll.constructor(addDice(String(roll.toJSON().formula ?? roll._formula), state.diceUpgrade.adds.dice, state.spellName), roll.data, roll.options);
            // The text's type over PF2e's variant data ("{3d6[bludgeoning]}" → "{3d6[spirit]}"): every instance must be the data's type.
            if (roll && state.damage.typeOverride) {
                const { from, to } = state.damage.typeOverride;
                if (!(roll.instances ?? []).length || roll.instances.some(instance => instance.type !== from))
                    throw new Error(`${state.spellName}: PF2e's damage isn't the ${from} damage the text retypes (${roll.formula}).`);
                roll = new roll.constructor(String(roll.toJSON().formula ?? roll._formula).replaceAll(`[${from}]`, `[${to}]`), roll.data, roll.options);
            }
            // The caster's split of the heightened dice: "{5d10[cold],3d10[bludgeoning]}" with 1 of 2 to bludgeoning → "{4d10[cold],4d10[bludgeoning]}".
            if (state.diceSplit && state.diceSplit.answer == null) throw new Error(`${state.spellName}: answer how the heightened dice split before rolling damage.`);
            if (roll && state.diceSplit?.answer > 0) {
                const { from, to, faces, answer } = state.diceSplit;
                const formula = String(roll.toJSON().formula ?? roll._formula ?? "");
                const pattern = type => new RegExp(`(^|[{,])(\\d+)d${faces}\\[${type}\\]`);
                const fromMatch = pattern(from).exec(formula), toMatch = pattern(to).exec(formula);
                if (!fromMatch || !toMatch || Number(fromMatch[2]) <= answer) throw new Error(`${state.spellName}: PF2e's damage isn't the two entries the split moves dice between (${formula}).`);
                roll = new roll.constructor(formula.replace(pattern(from), `$1${Number(fromMatch[2]) - answer}d${faces}[${from}]`).replace(pattern(to), `$1${Number(toMatch[2]) + answer}d${faces}[${to}]`), roll.data, roll.options);
            }
            // Final Sacrifice: a minion with the cold or water trait makes the damage cold.
            if (state.sacrifice?.pick === "minion" && !state.sacrifice.selected) throw new Error(`${state.spellName}: choose the minion before rolling damage.`);
            if (roll && state.sacrifice?.retyped) roll = new roll.constructor(String(roll.toJSON().formula ?? roll._formula).replaceAll(`[${state.sacrifice.typeByTrait.replaces}]`, `[${state.sacrifice.typeByTrait.type}]`), roll.data, roll.options);
            // The caster's number added to the spell's one damage instance ("{1d8[mental]}" → "{(1d8 + 2)[mental]}").
            if (state.damageBonus && state.damageBonus.answer == null) throw new Error(`${state.spellName}: answer the caster's question before rolling damage.`);
            if (roll && state.damageBonus?.answer > 0) {
                const formula = String(roll.toJSON().formula ?? roll._formula ?? "");
                const single = /^\{([^{}\[\]]+)\[([a-z]+)\]\}$/.exec(formula);
                if (!single || single[2] !== state.damageBonus.type) throw new Error(`${state.spellName}: PF2e's damage isn't the one ${state.damageBonus.type} instance the answer adds to (${formula}).`);
                roll = new roll.constructor(`{(${single[1]} + ${state.damageBonus.answer})[${single[2]}]}`, roll.data, roll.options);
            }
        }
        if (!roll) throw new Error(`PF2e returned no damage roll for ${state.spellName}.`);
        // ("The damage dealt by this spell is the same type as your Arcane Cascade.": the caster's stance's chosen type — force, its own, when none is —
        // given to the untyped damage before it's rolled.)
        if (state.damageTypeFrom?.kind === "arcane-cascade" && !evaluated) {
            const stance = (sourceActor.itemTypes?.effect ?? []).find(effect => effect.slug === "stance-arcane-cascade" || effect.slug === "effect-arcane-cascade");
            const chosen = stance ? Object.values(stance.flags?.pf2e?.rulesSelections ?? stance.flags?.system?.rulesSelections ?? {}).find(value => typeof value === "string" && /^[a-z]+$/.test(value)) : null;
            const type = chosen && chosen !== "weapon-damage" ? chosen : state.damageTypeFrom.fallback;
            const parts = (roll.instances ?? []).map(instance => `(${instance.head?.formula ?? instance.formula})[${instance.persistent ? "persistent," : ""}${!instance.type || instance.type === "untyped" ? type : instance.type}]`);
            if (parts.length) roll = new roll.constructor(`{${parts.join(",")}}`, roll.data, roll.options);
            state.damageTypeFrom.resolved = type;
        }
        // (A third-party item whose data names another type than its text — Judge Soul's "6d6 void damage", the item bludgeoning: the text's type.)
        if (state.damageTypeFrom?.kind === "target-strike" && !evaluated) {
            if (!/^[a-z]+$/.test(state.damageTypeFrom.type ?? "")) throw new Error(`${state.spellName}: the target's Strike wasn't chosen.`);
            const parts = (roll.instances ?? []).map(instance => `(${instance.head?.formula ?? instance.formula})[${instance.persistent ? "persistent," : ""}${state.damageTypeFrom.type}]`);
            if (parts.length) roll = new roll.constructor(`{${parts.join(",")}}`, roll.data, roll.options);
            state.damageTypeFrom.resolved = state.damageTypeFrom.type;
        }
        if (state.damageTypeFrom?.kind === "text" && !evaluated) {
            const parts = (roll.instances ?? []).map(instance => `(${instance.head?.formula ?? instance.formula})[${instance.persistent ? "persistent," : ""}${state.damageTypeFrom.type}]`);
            if (parts.length) roll = new roll.constructor(`{${parts.join(",")}}`, roll.data, roll.options);
            state.damageTypeFrom.resolved = state.damageTypeFrom.type;
        }
        // (An item's spellshape: each damage die that rolls a 1 rolled again — Foundry's "r1".)
        if (!evaluated && state.shapeRerollOnes) roll = new roll.constructor(String(roll.toJSON().formula ?? roll._formula).replace(/(\d+d\d+)(?![r\d])/g, "$1r1"), roll.data, roll.options);
        if (!evaluated) await roll.evaluate();
        // (A spellshape changing the damage type — Chaotic Spell's roll: every listed type becomes the rolled one.)
        if (state.shapeTypeSwap) {
            let json = roll.toJSON();
            for (const from of state.shapeTypeSwap.from) json = swapDamageType(json, from, state.shapeTypeSwap.to);
            roll = roll.constructor.fromData(json);
        }
        // (The Lurking Storm: "half of the damage as bludgeoning damage and half the damage as electricity damage" — the rolled total split, persistent damage apart.)
        if (state.shapeSplit) {
            const instances = roll.instances ?? [];
            const total = instances.filter(instance => !instance.persistent).reduce((sum, instance) => sum + Number(instance.total ?? 0), 0);
            const kept = instances.filter(instance => instance.persistent).map(instance => `(${instance.total})[persistent,${instance.type}]`);
            const [first, second] = state.shapeSplit.types;
            const half = Math.floor(total / 2);
            roll = await new roll.constructor(`{${[`${total - half}[${first}]`, `${half}[${second}]`, ...kept].join(",")}}`, roll.data, roll.options).evaluate();
            state.shapeSplit.total = total;
        }
        // (Fury of a Thousand on Murmuration: the full damage as each type — the user's reading, 2026-10-07.)
        if (state.shapeDual) {
            const instances = roll.instances ?? [];
            const total = instances.filter(instance => !instance.persistent).reduce((sum, instance) => sum + Number(instance.total ?? 0), 0);
            const kept = instances.filter(instance => instance.persistent).map(instance => `(${instance.total})[persistent,${instance.type}]`);
            roll = await new roll.constructor(`{${[...state.shapeDual.types.map(type => `${total}[${type}]`), ...kept].join(",")}}`, roll.data, roll.options).evaluate();
            state.shapeDual.total = total;
        }
        // (Golden Dragon's Bounty: the physical damage is the chosen metal, for weaknesses and resistances.)
        if (state.shapeMaterial) {
            let json = roll.toJSON();
            for (const type of ["bludgeoning", "piercing", "slashing"]) json = swapDamageType(json, type, `${type},${state.shapeMaterial}`);
            roll = roll.constructor.fromData(json);
        }
        if (state.bloodlineDamage) {
            const expected = bloodlineDamageType(state.bloodlineDamage, sourceActor);
            const types = (roll.instances ?? []).map(instance => instance.type);
            if (!bloodlineRollMatches(state.bloodlineDamage, types, expected))
                throw new Error(`${state.spellName}: PF2e rolled ${types.join(", ") || "no"} damage, not the ${state.bloodlineDamage.bloodline} bloodline's ${expected ?? "type"}. Damage was not recorded.`);
        }
        state.damage.rollJSON = clone(roll.toJSON());
        state.damage.formula = roll.formula;
        state.damage.total = roll.total;
        state.damage.rollOptions = [...(prepared.context?.options ?? [])];
        state.damage.instances = damageInstances(roll, {
            formula: state.damage.formula,
            total: state.damage.total
        });
        await this.#updateCard(card, state);
        debugLog(state.castId, "shared damage rolled", {
            formula: state.damage.formula,
            total: state.damage.total,
            rollOptions: state.damage.rollOptions
        });
        if (postMessage) try {
            await roll.toMessage({
                speaker: ChatMessage.getSpeaker({ actor: sourceActor }),
                flavor: `<strong>${escapeHTML(state.spellName)}</strong> — Shared Save Damage`,
                flags: { [MODULE_ID]: { kind: "basic-save-damage", castId: state.castId } }
            });
        } catch (error) {
            console.warn(`${MODULE_ID} | Shared damage was stored, but its roll message could not be posted.`, error);
        }
        return { status: "rolled", roll, state };
    }

    async rollOutcomeDamage(card, rollId, { postMessage = true } = {}) {
        const state = stateFromCard(card);
        if (!state) throw new Error("The save-resolution state is missing.");
        if (state.targets.some(target => targetParticipates(target) && !target.degree)) {
            throw new Error("Finish every provisional save before rolling outcome-specific damage.");
        }
        const entry = requiredOutcomeDamageRolls(state).find(candidate => candidate.id === rollId);
        if (!entry) throw new Error("That outcome damage roll is not required by the current save results.");
        if (entry.rollJSON) return { status: "already-rolled", state };
        if (!isCardCoordinator(card)) throw new Error("The active GM must roll this cast's outcome damage.");
        const sourceActor = await fromUuid(state.sourceActorUuid);
        const sourceSpell = await castSpellDocument(state, sourceActor);
        if (!sourceActor || !sourceSpell) throw new Error(`${state.spellName}: the original caster or spell is unavailable.`);
        if (!game.user.isGM && !sourceActor.canUserModify?.(game.user, "update")) {
            throw new Error(`You do not have permission to roll ${state.spellName}'s damage.`);
        }
        const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
        if (!DamageRoll) throw new Error("PF2e's DamageRoll class could not be resolved.");
        if (typeof DamageRoll.validate === "function" && !DamageRoll.validate(entry.formula)) {
            throw new Error(`${state.spellName}: PF2e rejected outcome damage formula ${entry.formula}.`);
        }
        const spell = resolveSpellAtRank(sourceSpell, state.castRank, state.overlayIds);
        const rollData = spell.getRollData?.({ castRank: state.castRank }) ?? {
            item: { rank: state.castRank, level: state.castRank }
        };
        // ("… increase the Persistent Bleed Damage you deal on a critical hit by 1d8.": the caster's yes adds the dice to that persistent roll.)
        const persistentAdds = state.diceUpgrade?.answer === "yes" ? state.diceUpgrade.adds?.persistent : null;
        let outcomeFormula = persistentAdds && new RegExp(`\\[(?:persistent,)?${persistentAdds.type}\\]\\}?$`).test(entry.formula) ? addDice(entry.formula, persistentAdds, state.spellName) : entry.formula;
        // (A row's own damage of the caster's chosen type too — Technomancy Ray's critical persistent damage, its Variable Core's type.)
        if (state.casterChoice?.kind === "damage-type" && state.casterChoice.outcomeFormulas === true) {
            if (!state.casterChoice.selected) throw new Error(`${state.spellName}: choose the ${state.casterChoice.label.toLowerCase()} before rolling damage.`);
            outcomeFormula = outcomeFormula.replace(/\[(persistent,)?untyped\]/g, (_m, persistent) => `[${persistent ?? ""}${state.casterChoice.selected}]`);
        }
        const roll = new DamageRoll(outcomeFormula, rollData, { rollerId: game.user.id });
        await roll.evaluate();
        entry.rollJSON = clone(roll.toJSON());
        entry.total = roll.total;
        entry.instances = damageInstances(roll, { formula: entry.formula, total: entry.total });
        entry.rollOptions = [...new Set([
            ...(spell.getRollOptions?.("item") ?? []),
            ...(state.traits ?? []).map(trait => `item:trait:${trait}`)
        ])];
        await this.#updateCard(card, state);
        debugLog(state.castId, "outcome damage rolled", {
            rollId: entry.id,
            formula: entry.formula,
            total: entry.total,
            requiredBy: state.targets.filter(target => outcomeDamageRollIds(state, target).includes(entry.id))
                .map(target => ({ targetId: target.id, name: target.name, degree: target.degree }))
        });
        if (postMessage) try {
            await roll.toMessage({
                speaker: ChatMessage.getSpeaker({ actor: sourceActor }),
                flavor: `<strong>${escapeHTML(state.spellName)}</strong> — ${escapeHTML(entry.formula)}`,
                flags: { [MODULE_ID]: { kind: "outcome-save-damage", castId: state.castId, rollId: entry.id } }
            });
        } catch (error) {
            console.warn(`${MODULE_ID} | Outcome damage was stored, but its roll message could not be posted.`, error);
        }
        return { status: "rolled", roll, state };
    }

    async rollSave(card, targetId, { event = null, skipDialog = null, heroPoint = false, stage = "primary", attackNumber: requestedAttackNumber = null } = {}) {
        const state = stateFromCard(card);
        const target = state?.targets?.find(candidate => candidate.id === targetId);
        if (typeof card.getFlag(MODULE_ID, "ongoingCastId") === "string" && !activeUsers().some(user => user.isGM)) throw Error("An active GM is required to record ongoing saves. This work has not been applied.");
        if (!state || !target) throw new Error("The selected save target is unavailable.");
        if (state.status !== "collecting") throw new Error(`${state.spellName}: saves are locked after finalization begins.`);
        if (target.excluded) throw new Error(`${target.name} is excluded from this cast.`);
        if (target.eligible === false) throw new Error(`${target.name} is unaffected: ${target.eligibilityReason}.`);
        if (target.applicationStatus !== "pending") throw new Error(`${target.name}'s result has already been applied.`);
        const { actor, token } = await resolveTargetDocuments(target);
        const sourceActor = await fromUuid(state.sourceActorUuid);
        const sourceSpell = await castSpellDocument(state, sourceActor);
        if (!actor || !sourceActor || !sourceSpell) throw new Error("The target, caster, or original spell is unavailable.");
        assertPersistedTargetIdentity(target, actor);
        // A Strike spell: the result is the caster's own PF2e Strike against this target, read from PF2e's message.
        // (A spell attack delivered by a Strike — Spellstrike, Eldritch Shot, Spell-Woven Shot, Spellsling: "using your attack roll result to determine the
        // effects of both the Strike and the spell" — read the same way.)
        const delivered = state.saveStatistic === "spell-attack" && stage === "primary" ? strikeDeliveryFor(state.sourceMessageId ?? null) : null;
        if ((state.saveStatistic === "strike" || delivered?.attack) && stage === "primary") {
            if (!game.user.isGM && !sourceActor.canUserModify?.(game.user, "update")) throw new Error(`You do not have permission to read ${sourceActor.name}'s Strike.`);
            // (A delivered spell's Strike follows its cast, before or after the card opens.)
            const after = delivered ? Number(game.messages.get(state.sourceMessageId)?.timestamp ?? card.timestamp ?? 0) : Number(card.timestamp ?? 0);
            // (Who delivers it, and which of the Strikes: spell-actions-runtime.js deliveredStrikeMessage.)
            const message = delivered ? deliveredStrikeMessage({ cast: game.messages.get(state.sourceMessageId), delivery: delivered, caster: sourceActor, target: actor, targetTokenUuid: target.tokenUuid })
                : findStrikeMessage({ casterUuid: sourceActor.uuid, targetActorUuid: actor.uuid, targetTokenUuid: target.tokenUuid, after });
            const striker = delivered?.strikerUuid ? fromUuidSync(delivered.strikerUuid)?.name ?? "the mystic duo" : sourceActor.name;
            if (!message) throw new Error(`${state.spellName}: make ${striker}'s ${delivered?.kind === "big-shot" ? "spellgun Activation" : delivered?.dual ? "two Strikes" : "Strike"} against ${target.name} with PF2e first (with ${target.name} targeted), then read its result.`);
            const degree = normalizeSaveDegree(message.flags.pf2e.context.outcome);
            if (!degree) throw new Error(`${state.spellName}: PF2e's Strike against ${target.name} has no degree of success.`);
            const roll = message.rolls?.[0] ?? null;
            const natural = roll?.dice?.flatMap(die => die.results ?? []).find(result => result.active !== false && result.discarded !== true)?.result ?? null;
            const submission = { type: "inline-save-result", submissionId: randomID(), castId: state.castId, targetId: target.id, stage,
                targetRevision: Number(target.revision ?? 0), actorUuid: actor.uuid, userId: game.user.id, degree, total: roll?.total ?? null, natural,
                modifier: null, reroll: target.degree != null };
            if (isCardCoordinator(card)) await this.#acceptInlineSave(submission);
            else game.socket.emit(`module.${MODULE_ID}`, submission);
            return roll;
        }
        // (Hone Spell: the caster's spell attack against the one target's AC in place of its save — "no effect on a miss, the effects of a failure on a successful
        // spell attack roll, or the effects of a critical failure on a critically successful spell attack roll"; the power ring's item bonus applied.)
        if (state.shapeHone && stage === "primary" && state.saveStatistic !== "spell-attack") {
            if (!game.user.isGM && !sourceActor.canUserModify?.(game.user, "update")) throw new Error(`You do not have permission to roll ${sourceActor.name}'s spell attack.`);
            const spell = resolveSpellAtRank(sourceSpell, state.castRank, state.overlayIds);
            const ring = state.shapeHone.ringBonus ? powerRingBonus(sourceActor) : 0;
            const modifiers = ring ? [new game.pf2e.Modifier({ slug: "power-ring", label: `${state.shapeHone.label}: power ring`, modifier: ring, type: "item" })] : [];
            const quiet = typeof skipDialog === "boolean" ? skipDialog : checkRollSkipDialog(event, game.user.settings?.showCheckDialogs ?? true);
            const roll = await spell.rollAttack(null, requestedAttackNumber ?? 1, { target: actor, skipDialog: quiet, createMessage: true, ...(modifiers.length ? { modifiers } : {}) });
            if (!roll) return null;
            const attackDegree = normalizeSaveDegree(roll.options?.degreeOfSuccess ?? roll.degreeOfSuccess);
            const degree = state.shapeHone.degrees[attackDegree] ?? null;
            if (!degree) throw new Error(`${state.spellName}: the honed spell attack against ${target.name} returned no degree of success.`);
            target.honedAttack = attackDegree;
            const natural = roll.dice?.flatMap(die => die.results ?? []).find(result => result.active !== false && result.discarded !== true)?.result ?? null;
            const submission = { type: "inline-save-result", submissionId: randomID(), castId: state.castId, targetId: target.id, stage,
                targetRevision: Number(target.revision ?? 0), actorUuid: actor.uuid, userId: game.user.id, degree, total: roll.total, natural,
                modifier: roll.options?.totalModifier, reroll: target.degree != null };
            if (isCardCoordinator(card)) await this.#acceptInlineSave(submission);
            else game.socket.emit(`module.${MODULE_ID}`, submission);
            return roll;
        }
        // A spell attack: the caster rolls PF2e's spell attack against this target's AC.
        if (state.saveStatistic === "spell-attack" && stage === "primary") {
            if (!game.user.isGM && !sourceActor.canUserModify?.(game.user, "update")) throw new Error(`You do not have permission to roll ${sourceActor.name}'s spell attack.`);
            if (heroPoint) throw new Error("Use PF2e's own reroll on the caster's attack.");
            // "The penalty doesn't increase until after both attacks": one attack number for the whole card.
            let attackNumber = requestedAttackNumber ?? (state.sharedMultipleAttackPenalty ? state.attackNumber ?? null : null);
            const quiet = typeof skipDialog === "boolean" ? skipDialog : checkRollSkipDialog(event, game.user.settings?.showCheckDialogs ?? true);
            if (attackNumber == null && !quiet) {
                attackNumber = await foundry.applications.api.DialogV2.prompt({ window: { title: `${state.spellName} — spell attack` },
                    content: "<p>Which attack is this on the caster’s turn? PF2e applies the multiple attack penalty.</p><select name=\"number\"><option value=\"1\">First attack</option><option value=\"2\">Second attack</option><option value=\"3\">Third or later attack</option></select>",
                    ok: { label: "Roll spell attack", callback: (_event, button) => Number(button.form.elements.number.value) }, rejectClose: false });
                if (attackNumber == null) return null;
            }
            attackNumber ??= 1;
            if (![1, 2, 3].includes(attackNumber)) throw new Error("Choose a valid attack number.");
            const tokens = actor.getActiveTokens?.(false, true) ?? [];
            if (tokens.length !== 1 || (target.tokenUuid && tokens[0].uuid !== target.tokenUuid)) throw new Error(`${target.name}'s token is ambiguous or off-scene; the attack needs one target token.`);
            const spell = resolveSpellAtRank(sourceSpell, state.castRank, state.overlayIds);
            // The GM's answer to the attack question adds its bonus to this target's attack roll.
            if (state.attackAdjustment && target.attackAdjustment?.status !== "answered") throw new Error(`${state.spellName}: answer the GM question for ${target.name} before rolling the attack.`);
            const bonus = Number(target.attackAdjustment?.value ?? 0);
            const modifiers = bonus > 0 ? [new game.pf2e.Modifier({ slug: "spell-attack-adjustment", label: state.spellName, modifier: bonus, type: state.attackAdjustment.modifierType })] : [];
            if (state.attackBonus?.value) modifiers.push(new game.pf2e.Modifier({ slug: "card-attack-bonus", label: state.attackBonus.label, modifier: state.attackBonus.value, type: state.attackBonus.type ?? "circumstance" }));
            // (Shadow Signet: "You make your spell attack roll against that defense instead of AC" — the roll against AC moved by AC − that DC, the same degree.)
            // (Or the spell's own: Tidal Grasp's "spell attack roll against the target's Fortitude DC".)
            const defense = attackDefenseFor(state.sourceMessageId ?? state.shapeMessageId ?? null) ?? (state.attackDefense ? { statistic: state.attackDefense.statistic, label: state.spellName } : null);
            if (defense) {
                const ac = Number(actor.armorClass?.value ?? actor.system?.attributes?.ac?.value), dc = Number(actor.saves?.[defense.statistic]?.dc?.value);
                if (!Number.isFinite(ac) || !Number.isFinite(dc)) throw new Error(`${target.name} has no AC or ${defense.statistic} DC for ${defense.label}.`);
                if (ac !== dc) modifiers.push(new game.pf2e.Modifier({ slug: "against-save-dc", label: `${defense.label}: against ${defense.statistic} DC ${dc}`, modifier: ac - dc, type: "untyped" }));
            }
            // (Seeking Spell: "you reduce the circumstance bonus to target's AC from cover by 2".)
            const cover = shapeCoverReduceFor(state.sourceMessageId ?? state.shapeMessageId ?? null, actor);
            if (cover) modifiers.push(new game.pf2e.Modifier({ slug: "cover-reduced", label: `${cover.label}: cover reduced`, modifier: cover.value, type: "untyped" }));
            const roll = await spell.rollAttack(null, attackNumber, { target: actor, skipDialog: quiet, createMessage: false, ...(modifiers.length ? { modifiers } : {}) });
            if (!roll) return null;
            const degree = normalizeSaveDegree(roll.options?.degreeOfSuccess ?? roll.degreeOfSuccess);
            if (!degree) throw new Error(`${state.spellName}: the spell attack against ${target.name} returned no degree of success.`);
            const natural = roll.dice?.flatMap(die => die.results ?? []).find(result => result.active !== false && result.discarded !== true)?.result ?? null;
            // (Overwhelming: "Spell attacks you modify with Veracious Spell are a critical success on a 19 on the die as long as that result is a success.")
            const riders = (state.shapeRiders ?? []).flatMap(shape => shape.riders ?? []);
            const keen = riders.find(rider => rider.type === "natural-crit" && (!rider.withVeracious || riders.some(other => other.veracious)));
            const attackDegree = keen && degree === "success" && natural >= keen.natural ? "criticalSuccess" : degree;
            // Recorded exactly like a save result, keyed by the attack's degree.
            const submission = { type: "inline-save-result", submissionId: randomID(), castId: state.castId, targetId: target.id, stage,
                targetRevision: Number(target.revision ?? 0), actorUuid: actor.uuid, userId: game.user.id, degree: attackDegree, total: roll.total, natural,
                modifier: roll.options?.totalModifier, reroll: target.degree != null, attackNumber };
            if (isCardCoordinator(card)) await this.#acceptInlineSave(submission);
            else game.socket.emit(`module.${MODULE_ID}`, submission);
            return roll;
        }
        if (!game.user.isGM && !actor.canUserModify?.(game.user, "update")) {
            throw new Error(`You do not have permission to roll ${target.name}'s save.`);
        }
        const secondarySave = stage === "secondary" ? secondarySaveForTarget(state, target) : null;
        const saveRecord = stage === "secondary" ? target.secondary : target;
        if (stage === "secondary" && (!secondarySave || !saveRecord)) {
            throw new Error(`${target.name} has no required secondary save.`);
        }
        // (The target's choice between two saves — or a save and a skill: Shape Stone's "Reflex save or Acrobatics check" — the better of its two modifiers.)
        const choiceStatistic = slug => actor.saves?.[slug] ?? (state.saveChoice?.includes(slug) ? actor.skills?.[slug] : null);
        const chosenSlug = stage === "primary" && state.saveChoice?.length ? [...state.saveChoice].sort((a, b) => Number(choiceStatistic(b)?.mod ?? -99) - Number(choiceStatistic(a)?.mod ?? -99))[0] : null;
        const statisticSlug = secondarySave?.check?.statistic ?? chosenSlug ?? state.saveStatistic;
        const statistic = chosenSlug ? choiceStatistic(statisticSlug) : actor.saves?.[statisticSlug];
        if (!statistic || typeof statistic.roll !== "function") {
            throw new Error(`${target.name} has no PF2e ${statisticSlug} save statistic.`);
        }
        const spell = resolveSpellAtRank(sourceSpell, state.castRank, state.overlayIds);
        const traits = [...new Set([...(state.traits ?? []), ...(secondarySave?.check?.traits ?? [])])];
        // The GM's answer to the save question adds its bonus to this target's primary save.
        const saveAdjustment = stage !== "secondary" && state.attackAdjustment?.appliesTo === "save" ? state.attackAdjustment : null;
        if (saveAdjustment && target.attackAdjustment?.status !== "answered") throw new Error(`${state.spellName}: answer the GM question for ${target.name} before rolling the save.`);
        const saveBonus = saveAdjustment ? Number(target.attackAdjustment.value ?? 0) : 0;
        // ("Creatures with the plant trait have a +2 circumstance bonus to saves against this spell.")
        const traitBonus = stage !== "secondary" && !saveBonus && state.traitSaveBonus && (actor.traits?.has?.(state.traitSaveBonus.trait) ?? (actor.system?.traits?.value ?? []).includes(state.traitSaveBonus.trait))
            ? state.traitSaveBonus : null;
        let heroPoints = null;
        if (heroPoint) {
            if (!saveRecord.degree) throw new Error(`${target.name} must roll this save before using a Hero Point reroll.`);
            heroPoints = actor.getResource?.("hero-points") ?? null;
            if (!heroPoints || Number(heroPoints.value) < 1 || typeof actor.updateResource !== "function") {
                throw new Error(`${target.name} has no Hero Point available.`);
            }
        }
        debugLog(state.castId, "save roll requested", {
            targetId: target.id,
            targetName: target.name,
            savedActorUuid: target.actorUuid,
            savedTokenUuid: target.tokenUuid,
            resolvedActorUuid: actor.uuid,
            resolvedTokenUuid: token?.uuid ?? null,
            stage,
            statistic: statisticSlug
        });
        const roll = await statistic.roll({
            dc: state.dc,
            token: token ?? undefined,
            item: spell,
            origin: sourceActor,
            label: `${state.spellName} — ${target.name} ${stage === "secondary" ? "Secondary " : ""}${statisticSlug} Save`,
            title: `${state.spellName} — ${target.name} ${stage === "secondary" ? "Secondary " : ""}${statisticSlug} Save`,
            extraRollOptions: [
                `${SAVE_OPTION_PREFIX}:${state.castId}:${target.id}`,
                ...(heroPoint ? ["check:reroll", "check:reroll:hero-points"] : []),
                ...traits.map(trait => `item:trait:${trait}`)
            ],
            traits,
            ...(() => {
                const modifiers = saveBonus !== 0 ? [new game.pf2e.Modifier({ slug: "spell-save-adjustment", label: state.spellName, modifier: saveBonus, type: saveAdjustment.modifierType })]
                    : traitBonus ? [new game.pf2e.Modifier({ slug: "spell-trait-save-bonus", label: `${state.spellName} (${traitBonus.trait})`, modifier: traitBonus.value, type: traitBonus.type })]
                    // The second save's own penalty or bonus (Firework Blast's −2 after a critical failure).
                    : stage === "secondary" && secondarySave?.check?.modifier ? [new game.pf2e.Modifier({ slug: "secondary-save-adjustment", label: state.spellName,
                        modifier: Number(secondarySave.check.modifier.value), type: secondarySave.check.modifier.type })] : [];
                // (The card's own one-time modifier, on the primary save.)
                if (stage !== "secondary" && state.cardSaveModifier) modifiers.push(new game.pf2e.Modifier({ slug: "card-save-modifier", label: state.cardSaveModifier.label || state.spellName,
                    modifier: state.cardSaveModifier.value, type: state.cardSaveModifier.type }));
                // (A spellshape's penalty to the target's save against the spell — Mocking Spell, Courtier's Pillow Book, Cast Out's −3 against a demon.)
                if (stage !== "secondary") for (const [index, rider] of (state.shapeRiders ?? []).flatMap(shape => (shape.riders ?? []).filter(entry => entry.type === "save-penalty").map(entry => ({ ...entry, shapeName: shape.name }))).entries()) {
                    const traitValue = Object.entries(rider.vsTraits ?? {}).find(([trait]) => actor.traits?.has?.(trait) ?? (actor.system?.traits?.value ?? []).includes(trait))?.[1];
                    modifiers.push(new game.pf2e.Modifier({ slug: `shape-save-penalty-${index}`, label: rider.shapeName, modifier: Number(traitValue ?? rider.value), type: rider.penaltyType ?? "circumstance" }));
                }
                return modifiers.length ? { modifiers } : {};
            })(),
            createMessage: false,
            skipDialog: heroPoint ? true : typeof skipDialog === "boolean"
                ? skipDialog
                : checkRollSkipDialog(event, game.user.settings?.showCheckDialogs ?? true)
        });
        if (!roll) return null;
        const degree = normalizeSaveDegree(roll.options?.degreeOfSuccess ?? roll.degreeOfSuccess);
        if (!degree) throw new Error(`${target.name}'s save returned no recognized degree of success.`);
        if (heroPoint) await actor.updateResource("hero-points", Number(heroPoints.value) - 1);
        const natural = roll.dice?.flatMap(die => die.results ?? [])
            .find(result => result.active !== false && result.discarded !== true)?.result ?? null;
        const submission = {
            type: "inline-save-result",
            submissionId: randomID(),
            castId: state.castId,
            targetId: target.id,
            stage,
            targetRevision: Number(target.revision ?? 0),
            actorUuid: actor.uuid,
            userId: game.user.id,
            degree,
            total: roll.total,
            natural,
            modifier: roll.options?.totalModifier,
            reroll: heroPoint || saveRecord.degree != null
        };
        if (isCardCoordinator(card)) await this.#acceptInlineSave(submission);
        else game.socket.emit(`module.${MODULE_ID}`, submission);
        return roll;
    }

    async handleSocket(payload) {
        if (payload?.type === "save-card-request") return this.#acceptCasterRequest(payload);
        if (payload?.type === "save-card-response") {
            if (payload.userId === game.user.id && payload.error) ui.notifications.error(`${payload.spellName ?? "Spell"}: ${payload.error}`);
            return;
        }
        const card = payload?.type === "inline-save-result" ? cardForCast(payload.castId) : null;
        if (!card || !isCardCoordinator(card)) return;
        await this.#acceptInlineSave(payload);
    }

    /** A caster's add-targets, finalize or damage roll sent from their client: done here, by the coordinating GM, if they own the caster. */
    async #acceptCasterRequest(payload) {
        const card = cardForCast(payload.castId);
        if (!card || !isCardCoordinator(card)) return;
        const state = stateFromCard(card), user = game.users.get(payload.userId);
        const reply = error => game.socket.emit(`module.${MODULE_ID}`, { type: "save-card-response", userId: payload.userId, spellName: state?.spellName, error });
        try {
            const caster = state?.sourceActorUuid ? await fromUuid(state.sourceActorUuid) : null;
            if (!user || !caster?.testUserPermission?.(user, "OWNER")) throw new Error("Only the caster or the GM can use this control.");
            if (!CASTER_SAVE_ACTIONS.has(payload.action)) throw new Error("That control isn't the caster's.");
            if (payload.action === "add-targets") {
                const tokens = (await Promise.all((payload.targetTokenUuids ?? []).map(uuid => fromUuid(uuid)))).map(token => token?.object ?? token).filter(token => token?.actor);
                if (!tokens.length) throw new Error("Target the creatures to add first.");
                await this.#queue(state.castId, () => this.addTargets(card, new Set(tokens)));
            } else if (payload.action === "finalize") await this.finalize(card);
            else if (payload.action === "roll-damage") await this.#queue(state.castId, () => this.rollDamage(card));
            else if (payload.action === "roll-outcome-damage") await this.#queue(state.castId, () => this.rollOutcomeDamage(card, payload.rollId));
        } catch (error) { reply(error.message); console.error(`PF2e Automatic Resolution | ${state?.spellName ?? "Spell"}: ${user?.name ?? "a player"}'s request failed`, error); }
    }

    async rollAll(card, { event = null, skipDialog = null } = {}) {
        let state = stateFromCard(card);
        if (!state) throw new Error("The save-resolution state is missing.");
        if (!isCardCoordinator(card)) throw new Error("The active GM must start the roll-all sequence.");
        const primaryTargets = state.targets.filter(target =>
            targetParticipates(target) && target.applicationStatus === "pending" && !target.degree);
        const initialSecondaryTargets = state.targets.filter(target =>
            targetParticipates(target) && target.applicationStatus === "pending"
            && target.secondary && !target.secondary.degree);
        if (!primaryTargets.length && !initialSecondaryTargets.length) {
            return { status: "nothing-to-roll", rolled: 0, state };
        }

        let rolled = 0;
        for (const target of primaryTargets) {
            const result = await this.rollSave(card, target.id, { event, skipDialog });
            if (!result) return { status: "cancelled", rolled, state };
            rolled += 1;
        }
        state = stateFromCard(card);
        const secondaryTargets = state.targets.filter(target =>
            targetParticipates(target) && target.applicationStatus === "pending"
            && target.secondary && !target.secondary.degree);
        for (const target of secondaryTargets) {
            const result = await this.rollSave(card, target.id, { event, skipDialog, stage: "secondary" });
            if (!result) return { status: "cancelled", rolled, state };
            rolled += 1;
        }
        return { status: "rolled", rolled, state };
    }

    async handleSaveMessage(message) {
        const reference = saveReference(message);
        if (!reference) return;
        const card = cardForCast(reference.castId);
        if (!card || !isCardCoordinator(card)) return;
        const degree = degreeFromMessage(message);
        const actor = messageActor(message);
        if (!degree || !actor) return;
        await this.#queue(reference.castId, async () => {
            const state = stateFromCard(card);
            const target = state?.targets?.find(candidate => candidate.id === reference.targetId);
            if (!state || !target || target.actorUuid !== actor.uuid) {
                console.warn(`${MODULE_ID} | Ignored a save whose actor did not match its snapshotted target.`, message);
                return;
            }
            if (target.saveMessageId === message.id || target.postApplicationMessageId === message.id) return;
            const result = recordProvisionalSave(state, target.id, {
                degree,
                messageId: message.id,
                timestamp: message.timestamp ?? Date.now(),
                reroll: isRerollMessage(message)
            });
            synchronizeSecondary(state, target);
            debugLog(state.castId, "save result recorded", {
                messageId: message.id,
                targetId: target.id,
                targetName: target.name,
                actorUuid: actor.uuid,
                degree,
                reroll: isRerollMessage(message),
                status: result.status,
                revision: target.rollRevision,
                requiredOutcomeDamage: requiredOutcomeDamageRolls(state).map(entry => ({
                    id: entry.id,
                    formula: entry.formula,
                    rolled: entry.rollJSON != null
                }))
            });
            await this.#updateCard(card, state);
            if (result.status === "manual-review") {
                globalThis.ui?.notifications?.warn(`${state.spellName}: ${state.reviewReason} Correct the result manually.`);
            }
        });
    }

    async apply(card, options = {}) {
        return await this.#queue(stateFromCard(card)?.castId, () => this.#apply(card, options));
    }

    async #apply(card, { skipConfirmation = false, createResultCard = true } = {}) {
        this.ongoing?.assertSave(card.id);
        this.forms?.assertSave(card);
        const state = stateFromCard(card);
        if (!state) throw new Error("The save-resolution state is missing.");
        if (!isCardCoordinator(card)) throw new Error("The active GM must confirm and apply this cast's results.");
        const readiness = basicSaveReadiness(state);
        if (!readiness.ready) throw new Error(`${state.spellName}: ${readiness.reason}`);
        const resolvedTargets = await Promise.all(state.targets.map(target => targetParticipates(target)
            ? resolveTargetDocuments(target) : { actor: null, token: null }));
        const actors = resolvedTargets.map(target => target.actor);
        if (actors.some((actor, index) => targetParticipates(state.targets[index]) && !actor)) throw new Error(`${state.spellName}: one or more targets are unavailable.`);
        state.targets.forEach((target, index) => assertPersistedTargetIdentity(target, actors[index]));
        if (new Set(actors.filter(Boolean).map(actor => actor.uuid)).size !== actors.filter(Boolean).length) {
            throw new Error(`${state.spellName}: multiple saved targets now resolve to the same actor. Results were not applied.`);
        }
        for (const [index, actor] of actors.entries()) {
            const target = state.targets[index];
            // (A secondary target is eligible without the waived requirement; the GM's question decides it. The caster sharing the save isn't
            // one of the spell's targets: "other than you" isn't its.)
            if (!targetParticipates(target) || target.eligibilityOverride?.eligible === true || target.secondaryOf || target.casterShare) continue;
            const eligibility = validateActorTarget(state.targetConstraints, actor);
            if (!eligibility.eligible) {
                target.eligible = false;
                target.eligibilityReason = eligibility.reason;
                target.applicationStatus = "unaffected";
            }
        }
        for (const [index, target] of state.targets.entries()) {
            if (!targetParticipates(target)) continue;
            const requiresDamage = damageMultiplierForTarget(state, target) > 0
                || outcomeDamageRollIds(state, target).length > 0;
            if (requiresDamage && !resolvedTargets[index].token) {
                throw new Error(`${target.name}: select an available, unambiguous token before applying damage.`);
            }
        }
        debugLog(state.castId, "application targets resolved", {
            targets: state.targets.map((target, index) => ({
                id: target.id,
                name: target.name,
                degree: target.degree,
                savedActorUuid: target.actorUuid,
                savedTokenUuid: target.tokenUuid,
                resolvedActorUuid: actors[index]?.uuid ?? null,
                resolvedTokenUuid: resolvedTargets[index].token?.uuid ?? null
            }))
        });
        if (!game.user.isGM && actors.some((actor, index) =>
            targetParticipates(state.targets[index]) && !actor.canUserModify?.(game.user, "update"))) {
            throw new Error("A GM must apply damage to targets you do not own.");
        }
        if (state.casterBenefit?.aggregate === "single-target" && state.targets.filter(targetParticipates).length !== 1) {
            throw new Error(`${state.spellName}: this caster benefit is computed from exactly one target. Exclude extra targets before applying.`);
        }
        if (state.casterBenefit) {
            const caster = await fromUuid(state.sourceActorUuid);
            if (!caster) throw new Error(`${state.spellName}: the caster is unavailable for its benefit.`);
            if (state.casterBenefit.kind === "heal-then-temp" && (caster.getActiveTokens?.(false, true) ?? []).length !== 1) {
                throw new Error(`${state.spellName}: place exactly one caster token before applying; the caster regains Hit Points.`);
            }
        }
        const templates = new Map();
        const nativeEffectSources = [];
        const speedInspection = inspectGeneratedSpeedProof(state.generatedSpeedProof,state.outcomes,
            {lifecycle:state.lifecycle});
        if (!speedInspection.supported) throw new Error(`${state.spellName}: ${speedInspection.reason}.`);
        const generatedSpeedSources = [];
        for (const target of state.targets) {
            const sources = [];
            delete target.effectNotes;
            if (targetParticipates(target)) for (const effect of outcomeForTarget(state, target)?.nativeEffects ?? []) {
                // A form's Effect: only the form the caster picked.
                if (effect.choiceGroup === "caster-option" && !(state.casterChoice?.kind === "option" && effect.option === state.casterChoice.selected)) continue;
                // "… if it's a metal creature": only a creature with that trait.
                if (effect.outcomeRule?.recipientTrait) {
                    const actor = actors[state.targets.indexOf(target)];
                    const traits = actor?.traits && typeof actor.traits.has === "function" ? actor.traits : new Set(actor?.system?.traits?.value ?? []);
                    if (!traits.has(effect.outcomeRule.recipientTrait)) {
                        target.effectNotes = [...(target.effectNotes ?? []), `${effect.label ?? "Effect"} not applied: it isn't a ${effect.outcomeRule.recipientTrait} creature (PF2e's traits).`];
                        continue;
                    }
                }
                // An Effect proved for one kind of recipient (not the caster; undead or living) skips any other.
                if (effect.outcomeRule?.kind === 'text-modifier' && !recipientMatchesProof(effect.outcomeRule, actors[state.targets.indexOf(target)], state.sourceActorUuid)) {
                    target.effectNotes = [...(target.effectNotes ?? []), `${effect.label ?? 'Effect'} not applied: the spell's text covers a different recipient.`];
                    continue;
                }
                let template = templates.get(effect.uuid);
                if (!template) { template = await loadNativeEffectTemplate(effect.uuid); templates.set(effect.uuid, template); }
                const source = prepareNativeOutcomeEffectSource(effect, template, {
                    degree: target.degree, castInstanceId: state.castId, castRank: state.castRank, effectStart: state.effectStart,
                    sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid,
                    sourceItemName: state.spellName, targetActorUuid: target.actorUuid,
                    compilerVersion: state.compilerVersion,
                    operationId: `${state.castId}:${target.id}:native:${sources.length}`,
                    ...(state.casterChoice ? {casterChoice: state.casterChoice.selected} : {}),
                    ...(state.conditionRoll?.kind === 'native-choice' ? {rolledChoice: state.conditionRoll.slug} : {}),
                    ...(effect.outcomeRule?.escape ? {dc: state.dc} : {}),
                    ...(effect.outcomeRule?.leaveArea ? {lingeringCastId: state.lingeringCastId ?? null} : {}),
                    ...(['persistent-linked-effect', 'persistent-linked-degree-effect'].includes(effect.outcomeRule?.kind) ? {persistentLink: {damageType: effect.outcomeRule.damageType}} : {}),
                    // "can attempt another Will save at the end of each of its turns, ending the spell's effect on a success"
                    ...(effect.outcomeRule?.recurringSave ? {recurringSave: {...clone(effect.outcomeRule.recurringSave), dc: state.dc}} : {}),
                    // An Effect that changes how this spell's damage applies (it removes an immunity) goes on first.
                    ...(effect.outcomeRule?.kind === 'stated-effect' ? {beforeDamage: true} : {})
                });
                sources.push({source, effect});
            }
            nativeEffectSources.push(sources);
            generatedSpeedSources.push(targetParticipates(target)
                ? (outcomeForTarget(state,target)?.modifiers ?? []).map((modifier,index) => ({modifier,
                    source:prepareGeneratedSpeedEffectSource(modifier,{
                        claimText:outcomeForTarget(state,target).rawText,
                        degree:target.degree,castId:state.castId,castRank:state.castRank,effectStart:state.effectStart,
                        sourceActorUuid:state.sourceActorUuid,sourceItemUuid:state.sourceItemUuid,
                        sourceItemName:state.spellName,targetActorUuid:target.actorUuid,
                        compilerVersion:state.compilerVersion,
                        operationId:`${state.castId}:${target.id}:speed:${index}`,
                        lingeringCastId:state.lingeringCastId ?? null,dc:state.dc,
                        // (A penalty until the creature Escapes lasts the spell's own fixed time.)
                        spellDuration:state.lifecycle?.durationSpec?.mode === 'fixed' ? {value:Number(state.lifecycle.durationSpec.value),unit:state.lifecycle.durationSpec.unit} : (state.lifecycle?.spellDuration ?? null),
                        // (Stone Lance: the persistent bleed its Escape deals, at the cast rank.)
                        escapeDamage:state.escapeDamage ? {formula:String(state.escapeDamage.base + state.escapeDamage.perRank * Math.max(0, state.castRank - state.escapeDamage.baseRank)),type:state.escapeDamage.type} : null
                    })})) : []);
        }
        // Note durations rolled for each creature ("The creature is affected for 1d4 rounds"), kept on the target.
        for (const [targetIndex, target] of state.targets.entries()) {
            if (!targetParticipates(target)) continue;
            for (const [noteIndex, note] of targetOutcomeNotes(state, target).entries()) {
                if (note.duration?.value != null || !note.duration?.valueRoll || target.noteRounds?.[noteIndex] != null) continue;
                const roll = await new Roll(note.duration.valueRoll).evaluate();
                target.noteRounds = { ...(target.noteRounds ?? {}), [noteIndex]: Math.max(1, roll.total) };
                try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: actors[targetIndex] }), flavor: `${escapeHTML(state.spellName)}: ${escapeHTML(target.name)}'s rounds (${note.duration.valueRoll})` }); } catch (_) {}
            }
        }
        const noteSources = state.targets.map(target => targetParticipates(target)
            ? targetOutcomeNotes(state, target).map((note, index) => target.noteRounds?.[index] != null ? { ...note, duration: { ...note.duration, value: target.noteRounds[index], valueRoll: undefined } } : note)
                .map(note => noteAtRank(note, state.lifecycle, state.castRank)).map((note, index) => ({ note, source: prepareNoteEffectSource(note, {
                castId: state.castId, castRank: state.castRank, effectStart: state.effectStart, degree: target.degree, dc: state.dc,
                sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName,
                ...(state.lingeringCastId ? { lingeringCastId: state.lingeringCastId } : {}),
                targetActorUuid: target.actorUuid, targetName: target.name, operationId: `${state.castId}:${target.id}:note:${index}` }) })) : []);
        if (!this.ongoing && (nativeEffectSources.some(sources => sources.length)
            || generatedSpeedSources.some(sources => sources.length))) throw new Error('Native outcome Effects require the ongoing cast manager.');
        // Condition values rolled for each creature ("Drained [[/r 1d4]]"), recorded as the card's condition corrections.
        for (const target of state.targets) {
            if (!targetParticipates(target)) continue;
            for (const [index, condition] of targetOutcomeConditions(state, target).entries()) {
                // "If they were already prone, they instead … becoming Unconscious" (Indolent Haze): the other condition for a creature holding this one.
                if (condition.insteadIfHeld && actors[state.targets.indexOf(target)]?.hasCondition?.(condition.insteadIfHeld.ifHeld) && condition.slug === condition.insteadIfHeld.ifHeld) {
                    target.conditionOverrides ??= {};
                    const previous = target.conditionOverrides[index];
                    target.conditionOverrides[index] = { ...(previous ?? {}), original: { ...(previous?.original ?? {}), slug: condition.slug, name: condition.name },
                        changes: { ...(previous?.changes ?? {}), slug: condition.insteadIfHeld.slug, name: condition.insteadIfHeld.name, value: null }, userId: game.user.id, instead: condition.insteadIfHeld.ifHeld };
                    continue;
                }
                // Rounds rolled for this creature ("Stupefied 1 for [[/r 1d4 #rounds]]{1d4 rounds}").
                if (condition.duration?.value == null && condition.duration?.valueRoll) {
                    const roll = await new Roll(condition.duration.valueRoll).evaluate();
                    const rounds = Math.max(1, roll.total);
                    target.conditionOverrides ??= {};
                    const previous = target.conditionOverrides[index];
                    target.conditionOverrides[index] = { original: { ...(previous?.original ?? {}), duration: clone(condition.duration) },
                        changes: { ...(previous?.changes ?? {}), duration: { ...clone(condition.duration), value: rounds, valueRoll: undefined } }, userId: game.user.id, rolledDuration: condition.duration.valueRoll };
                    try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: actors[state.targets.indexOf(target)] }), flavor: `${escapeHTML(state.spellName)}: ${escapeHTML(target.name)}'s ${escapeHTML(condition.name ?? condition.slug)} rounds (${condition.duration.valueRoll})` }); } catch (_) {}
                }
                // "… Clumsy 1 (or increasing its clumsy condition by 1 if it is already clumsy)": one more than the creature has now.
                if (condition.increment && Number.isInteger(condition.value)) {
                    const current = Number(actors[state.targets.indexOf(target)]?.getCondition?.(condition.slug)?.value ?? 0);
                    if (current >= condition.value) {
                        target.conditionOverrides ??= {};
                        const previous = target.conditionOverrides[index];
                        target.conditionOverrides[index] = { ...(previous ?? {}), original: { ...(previous?.original ?? {}), value: condition.value }, changes: { ...(previous?.changes ?? {}), value: current + 1 }, userId: game.user.id, incremented: current };
                    }
                    continue;
                }
                if (condition.value != null || !condition.valueRoll) continue;
                const roll = await new Roll(condition.valueRoll).evaluate();
                target.conditionOverrides ??= {};
                const previous = target.conditionOverrides[index];
                target.conditionOverrides[index] = { ...(previous ?? {}), original: { ...(previous?.original ?? {}), value: null }, changes: { ...(previous?.changes ?? {}), value: Math.max(1, roll.total) }, userId: game.user.id, rolled: condition.valueRoll };
                try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: actors[state.targets.indexOf(target)] }), flavor: `${escapeHTML(state.spellName)}: ${escapeHTML(target.name)}'s ${escapeHTML(condition.name ?? condition.slug)} value (${condition.valueRoll})` }); } catch (_) {}
            }
        }
        const conditionSources = state.targets.map((target, index) =>
            targetParticipates(target) ? groupedConditionSources(state, target, actors[index]) : []);
        if (!this.ongoing && conditionSources.some(groups => groups.some(group => group.linkedTo))) {
            throw new Error("Linked conditions require the ongoing cast manager.");
        }
        const summary = state.targets.map(target => {
            if (target.excluded) return `<li>${escapeHTML(target.name)}: excluded</li>`;
            if (target.eligible === false) {
                return `<li>${escapeHTML(target.name)}: unaffected — ${escapeHTML(target.eligibilityReason)}</li>`;
            }
            if (target.mode === "healing") return `<li>${escapeHTML(target.name)}: healed ${escapeHTML(String(state.damage?.total ?? "?"))} HP (no save)</li>`;
            if (target.mode === "ally") return `<li>${escapeHTML(target.name)}: ally — ${state.allySplit?.healing ? `healed (${escapeHTML(state.allySplit.healing.formula ?? "")}) and ` : ""}${escapeHTML(state.allySplit?.effect?.label ?? "the spell's Effect")} (no save)</li>`;
            if (target.mode === "splash") return `<li>${escapeHTML(target.name)}: splash damage if the attack hit</li>`;
            const multiplier = damageMultiplierForTarget(state, target);
            const formulas = [
                ...(outcomeForTarget(state, target)?.damage?.formulas ?? []),
                ...(secondaryOutcomeForTarget(state, target)?.damage?.formulas ?? [])
            ]
                .map(entry => entry.formula);
            const conditions = [...outcomeEffectsForTarget(state, target).map(conditionLabel),
                ...(outcomeForTarget(state, target)?.nativeEffects ?? []).map(nativeOutcomeLabel),
                ...(outcomeForTarget(state, target)?.modifiers ?? []).map(generatedSpeedLabel)];
            if (secondaryOutcomeForTarget(state, target)?.terminal?.kind === "death") conditions.push("Dies");
            conditions.push(...primaryRowLabels(outcomeForTarget(state, target)));
            const result = [
                ...(multiplier > 0 ? [sharedDamageLabel(state, target)] : []),
                ...formulas,
                ...conditions
            ].join(", ");
            const degrees = target.secondary
                ? `${readableSaveDegree(target.degree)}; secondary ${readableSaveDegree(target.secondary.degree)}`
                : readableSaveDegree(target.degree);
            return `<li>${escapeHTML(target.name)}: ${escapeHTML(degrees)} — ${escapeHTML(result || "no damage or effects")}</li>`;
        }).join("");
        const confirmed = skipConfirmation || await confirmAction({
            title: `${state.spellName} — Apply Results`,
            content: `<p>Apply the compiled damage and conditions for these provisional results?</p><ul>${summary}</ul>`,
            label: "Apply Results"
        });
        if (!confirmed) return { status: "cancelled", state };

        const outcomeRolls = new Map(requiredOutcomeDamageRolls(state).map(entry => [entry.id, entry]));
        const needsDamage = sharedDamageRequired(state) || outcomeRolls.size > 0;
        const DamageRoll = needsDamage
            ? (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll")
            : null;
        if (needsDamage && !DamageRoll?.fromData) throw new Error("PF2e's DamageRoll class could not be resolved.");
        // Trait-conditional extra damage: one roll per entry, only when a damaged target has the trait.
        const hasTrait = (actor, trait) => actor?.traits?.has?.(trait) ?? (actor?.system?.traits?.value ?? []).includes(trait);
        // (An entry may name several traits — any of them — and only some rows: Spray of Salt's persistent spirit damage on a failure.)
        const traitApplies = (entry, actor, target) => (entry.traits ?? [entry.trait]).some(trait => hasTrait(actor, trait)) && (!entry.degrees || entry.degrees.includes(target?.degree));
        for (const entry of state.conditionalDamage ?? []) {
            if (entry.rollJSON) continue;
            const needed = [];
            for (const target of state.targets) {
                if (!targetParticipates(target) || damageMultiplierForTarget(state, target) <= 0) continue;
                const { actor } = await resolveTargetDocuments(target);
                if (entry.gate === "target-upgrade" ? target.upgradeAnswer?.answer === "yes" : entry.gate === "attack-adjustment" ? Number(target.attackAdjustment?.value ?? 0) > 0 : traitApplies(entry, actor, target)) needed.push(target.id);
            }
            if (!needed.length) continue;
            const ConditionalRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
            if (!ConditionalRoll) throw new Error("PF2e's DamageRoll class could not be resolved.");
            const spell = resolveSpellAtRank(await castSpellFromUuid(state), state.castRank, state.overlayIds);
            const rollData = spell?.getRollData?.({ castRank: state.castRank }) ?? { item: { rank: state.castRank, level: state.castRank } };
            // The caster's "yes" to the dice question (Sun Blade's sunlight) enlarges these dice too.
            if (state.diceUpgrade && !state.diceUpgrade.answer) throw new Error(`${state.spellName}: answer the caster's question before rolling damage.`);
            const formula = state.diceUpgrade?.answer === "yes" && state.diceUpgrade.faces ? String(entry.formula).replace(/d\d+/g, `d${state.diceUpgrade.faces}`) : entry.formula;
            const roll = new ConditionalRoll(formula, rollData, { rollerId: game.user.id });
            await roll.evaluate();
            entry.rollJSON = clone(roll.toJSON()); entry.total = roll.total; entry.rollFormula = roll.formula;
            try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(state.sourceActorUuid) }),
                flavor: `<strong>${escapeHTML(state.spellName)}</strong> — extra damage to ${escapeHTML(entry.label ?? `${entry.trait} creatures`)}`,
                flags: { [MODULE_ID]: { kind: "conditional-damage", castId: state.castId } } }); } catch (error) { console.warn(`${MODULE_ID} | Conditional damage roll message could not be posted.`, error); }
        }
        await this.#updateCard(card, state);
        // Resolve every selection before any recipient can lose HP. A missing
        // or ambiguous native instance must leave the whole cast unapplied.
        const selectedDamageRolls = state.targets.map(target => {
            if (!targetParticipates(target) || damageMultiplierForTarget(state, target) <= 0
                || !state.damage.componentSelective) return null;
            const outcomeDamage = outcomeForTarget(state, target)?.damage;
            const selection = outcomeDamage?.mode === 'mixed' ? outcomeDamage.shared : outcomeDamage;
            return selectComponentDamageRoll(DamageRoll.fromData(clone(state.damage.rollJSON)),
                state.damage.components, selection, {DamageRoll, InstancePool: CONFIG.Dice?.termTypes?.InstancePool});
        });
        // Splash damage: split the rolled totals once, then build the struck target's roll (non-splash × row, splash once).
        const splashSplit = state.splash && state.damage.rollJSON ? splashParts(DamageRoll.fromData(clone(state.damage.rollJSON))) : null;
        const splashPrimaryRolls = await Promise.all(state.targets.map(async target => {
            if (!splashSplit || !targetParticipates(target)) return null;
            const multiplier = damageMultiplierForTarget(state, target);
            return multiplier > 0 ? await splashDamageRoll(splashSplit, { multiplier }, DamageRoll) : null;
        }));
        const combinedDamageRolls = state.targets.map(target => {
            if (!targetParticipates(target)) return null;
            const damage = outcomeForTarget(state, target)?.damage;
            if (damage?.mode !== 'mixed' || damage.rollScope !== 'combined') return null;
            if (!state.damage.inlinePersistentComposed || damage.formulas?.length !== 1
                || !state.damage.rollJSON) {
                throw new Error(`${target.name}: combined inline persistent damage is not certified on this cast.`);
            }
            const entry = outcomeRolls.get(damage.formulas[0].rollId);
            if (!entry?.rollJSON || entry.formula !== damage.formulas[0].formula
                || outcomeDamageRollIds(state, target).length !== 1
                || outcomeDamageRollIds(state, target)[0] !== entry.id) {
                throw new Error(`${target.name}: inline persistent damage was not rolled exactly once.`);
            }
            const sharedOptions = new Set(state.damage.rollOptions ?? []);
            if (!Array.isArray(entry.rollOptions)
                || entry.rollOptions.some(option => !sharedOptions.has(option))) {
                throw new Error(`${target.name}: inline persistent damage has unmatched native roll options.`);
            }
            return composeInlinePersistentDamageRoll(
                DamageRoll.fromData(clone(state.damage.rollJSON)),
                DamageRoll.fromData(clone(entry.rollJSON)),
                state.damage.components, damage.shared,
                {DamageRoll, InstancePool: CONFIG.Dice?.termTypes?.InstancePool}
            );
        });
        const needsOngoing = this.ongoing && state.targets.some(targetParticipates) && (state.temporaryImmunity || state.casterBenefit || state.casterMark?.kind === "strike-bonus" || conditionSources.some(groups => groups.length) || nativeEffectSources.some(sources => sources.length) || generatedSpeedSources.some(sources => sources.length) || noteSources.some(sources => sources.length)
            // An affliction that ends when the spell ends (Mycological Malady's voidcap spores): its Effect ends with the cast.
            || (state.afflictionHandoff?.endsWithSpell && state.targets.some(target => targetParticipates(target) && outcomeForTarget(state, target)?.affliction))
            // Later rounds' conditions and the end's damage (Impending Doom): the Ongoing record carries them.
            || (state.timeline && state.targets.some(target => targetParticipates(target) && state.timeline.byDegree?.[target.degree])));
        if (needsOngoing) this.ongoing.assertCoordinator();
        const parentFound = state.attachTo && this.ongoing ? this.ongoing.find(state.attachTo) ?? null : null;
        const parentJournal = parentFound?.getFlag?.(MODULE_ID, "ongoingCast")?.status === "active" ? parentFound : null;
        if (state.attachTo && !parentJournal) throw new Error(`${state.spellName}: the spell has ended (its card's record is gone).`);
        const ongoingJournal = parentJournal ? parentJournal : needsOngoing
            ? await this.ongoing.begin({ castId: state.castId, name: state.spellName, kind: "native",
                sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid,
                recoverySource: state.originalSpellSource, dc: state.dc, rank: state.castRank,
                dismissal: clone(state.lifecycle?.dismissal ?? null),
                ...(state.sustained ? { sustained: true, castRound: state.sustained.castRound, maximumAt: (game.time?.worldTime ?? 0) + state.sustained.maximumSeconds } : {}),
                recipientUuids: state.targets.filter(targetParticipates).map(target => target.actorUuid),
                // The targets whose save failed, for the basic save each round's first Sustain opens (Steal Shadow).
                // The targets the cast holds, for each round's first Sustain (Lightning Lasso).
                // Each affected target's later rounds and end damage, timed from the cast (the caster's turn starts each of the spell's rounds).
                ...(state.timeline ? { timeline: { rounds: state.timeline.rounds, start: state.effectStart.value, initiative: state.effectStart.initiative ?? null,
                    formula: `${state.timeline.damage.dice + state.timeline.damage.perRank * Math.max(0, state.castRank - state.timeline.damage.baseRank)}d${state.timeline.damage.faces}`,
                    damageType: state.timeline.damage.type, ended: false,
                    targets: state.targets.filter(target => targetParticipates(target) && state.timeline.byDegree?.[target.degree]).map(target => ({ actorUuid: target.actorUuid,
                        tokenUuid: target.tokenUuid ?? null, name: target.name, degree: target.degree, multiplier: state.timeline.byDegree[target.degree].multiplier,
                        steps: clone(state.timeline.byDegree[target.degree].steps).map(step => ({ round: step.round, conditions: step.conditions, done: false })) })) } } : {}),
                ...(state.sustainHold && state.sustained ? { sustainHold: { ...clone(state.sustainHold), targetActorUuids: state.targets.filter(target => targetParticipates(target)
                    && state.sustainHold.degrees.includes(target.degree)).map(target => target.actorUuid) } } : {}),
                ...(state.sustainStrike && state.sustained ? { sustainStrike: { label: state.sustainStrike.label, plan: clone(state.sustainStrike.plan),
                    targetTokenUuids: state.targets.filter(target => targetParticipates(target) && state.sustainStrike.degrees.includes(target.degree) && target.tokenUuid).map(target => target.tokenUuid) } } : {}),
                ...(state.sustainAllySave && state.sustained ? { sustainAllySave: { plan: clone(state.sustainAllySave.plan), radius: state.sustainAllySave.radius,
                    centreTokenUuids: state.targets.filter(target => targetParticipates(target) && state.sustainAllySave.degrees.includes(target.degree) && target.tokenUuid).map(target => target.tokenUuid) } } : {}) }) : null;
        // The caster, when its own nature decides the damage type (Spiritual Torrent).
        const swapCaster = state.damageSwap?.when === "caster-undead" ? await fromUuid(state.sourceActorUuid) : null;
        // The weapon's critical damage roll, once, for the creatures that critically failed (not those immune to critical hits).
        if (state.weaponDamage && !state.weaponDamage.dice && !state.weaponDamage.criticalRollJSON && state.targets.some((target, index) => targetParticipates(target) && target.degree === "criticalFailure"
            && !immuneToCriticalHits(resolvedTargets[index]?.actor))) {
            const sourceActor = await fromUuid(state.sourceActorUuid);
            const strike = weaponStrikes(sourceActor).find(entry => entry.item.id === state.weaponDamage.itemId);
            if (!strike) throw new Error(`${state.spellName}: ${sourceActor?.name ?? "the caster"} no longer wields ${state.weaponDamage.name}.`);
            const critical = await strike.critical({ createMessage: false, event: noDialogEvent() });
            if (!critical) throw new Error(`${state.spellName}: PF2e returned no critical damage for ${state.weaponDamage.name}.`);
            state.weaponDamage.criticalRollJSON = clone(critical.toJSON());
            try { await critical.toMessage({ speaker: ChatMessage.getSpeaker({ actor: sourceActor }), flavor: `<strong>${escapeHTML(state.spellName)}</strong>: ${escapeHTML(state.weaponDamage.name)}'s critical damage (critical failures)` }); } catch (_) {}
        }
        const createdEffects = [];
        let damageApplied = false;
        try {
            state.status = "applying";
            await this.#updateCard(card, state);
            for (let index = 0; index < state.targets.length; index++) {
                const target = state.targets[index];
                if (target.applicationStatus === "applied" || !targetParticipates(target)) continue;
                const { actor, token } = resolvedTargets[index];
                target.applicationStatus = "applying";
                target.damageResults ??= [];
                target.hpBefore = hpValue(actor);
                await this.#updateCard(card, state);
                const multiplier = damageMultiplierForTarget(state, target);
                // "Unlike normal void damage, … damages objects, constructs, and the like": a construct's void immunity is lifted (a PF2e
                // Immunity "remove" rule) for this spell's damage, and kept while this spell's persistent void damage lasts.
                if (state.immunityBypass && multiplier > 0 && actor.traits?.has?.(state.immunityBypass.trait)
                    && (actor.system?.attributes?.immunities ?? []).some(immunity => immunity.type === state.immunityBypass.type)) {
                    const [bypass] = await actor.createEmbeddedDocuments("Item", [{ name: `${state.spellName}: ${state.immunityBypass.type} damages this ${state.immunityBypass.trait}`,
                        type: "effect", img: "icons/svg/downgrade.svg",
                        flags: { [MODULE_ID]: { outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName,
                            conditions: [], persistentLink: { damageType: state.immunityBypass.type } }, immunityBypass: clone(state.immunityBypass) } },
                        system: { description: { value: `<p>${escapeHTML(state.immunityBypass.sourceText)}</p><p>Removed when this creature's persistent ${escapeHTML(state.immunityBypass.type)} damage ends.</p>` },
                            duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, level: { value: state.castRank },
                            rules: [{ key: "Immunity", mode: "remove", type: state.immunityBypass.type }],
                            context: { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: actor.uuid }, roll: null } } }]);
                    if (!bypass || (actor.system?.attributes?.immunities ?? []).some(immunity => immunity.type === state.immunityBypass.type))
                        throw new Error(`${target.name}: PF2e did not lift its ${state.immunityBypass.type} immunity for ${state.spellName}.`);
                    target.immunityBypassUuid = bypass.uuid;
                }
                debugLog(state.castId, "target application started", {
                    targetId: target.id,
                    targetName: target.name,
                    actorUuid: actor.uuid,
                    tokenUuid: token?.uuid ?? null,
                    degree: target.degree,
                    secondaryDegree: target.secondary?.degree ?? null,
                    damageMultiplier: multiplier,
                    outcomeDamage: outcomeDamageRollIds(state, target).map(id => ({
                        id,
                        formula: outcomeRolls.get(id)?.formula ?? null,
                        total: outcomeRolls.get(id)?.total ?? null
                    })),
                    hpBefore: target.hpBefore,
                    conditionGroups: conditionSources[index].map(group => ({
                        applicationId: group.applicationId,
                        duration: group.duration,
                        conditions: group.conditions.map(entry => conditionLabel(entry.condition))
                    }))
                });
                // "The target loses any immunity to bleed": before the bleed damage, so PF2e applies it.
                for (const {source, effect: specification} of nativeEffectSources[index].filter(entry => entry.source.flags?.[MODULE_ID]?.runtime?.beforeDamage)) {
                    const created = await createNativeEffect(actor, source);
                    createdEffects.push(created);
                    target.effectUuids ??= [];
                    target.effectUuids.push(created.uuid);
                    target.conditionResults ??= [];
                    target.conditionResults.push({label: nativeOutcomeLabel(specification), status: 'applied', effectUuid: created.uuid, duration: {mode:'fixed', ...clone(created.system.duration)}});
                    if (ongoingJournal) await this.ongoing.attach(ongoingJournal, created);
                }
                if (multiplier > 0) {
                    // The same dice, with the void part as vitality for an undead or void-healing creature.
                    // (Or the square the GM placed it in: the second square's damage type.)
                    const swap = damageSwapApplies(state.damageSwap, state.damageSwap?.when === "caster-undead" ? swapCaster : actor) ? state.damageSwap : (state.traitVariant?.kind === "zone" && target.traitVariant ? state.traitVariant.damageSwap : null);
                    // (A creature immune to the halved type doesn't get the immunity's benefit: the damage is untyped for it.)
                    const halving = state.resistanceHalving;
                    const immuneHalved = halving && target.degreeAdjustment?.immunities && target.degreeAdjustment.status === "applies";
                    const swapJSON = json => immuneHalved ? swapDamageType(json, halving.type, "untyped") : json;
                    const baseRoll = DamageRoll.fromData(swapJSON(swap ? swapDamageType(clone(state.damage.rollJSON), swap.from, swap.to) : clone(state.damage.rollJSON)));
                    if (swap) target.damageSwapped = `${swap.from} → ${swap.to}`;
                    if (immuneHalved) target.damageSwapped = `${halving.type} → untyped (immune to ${halving.type})`;
                    let damage = splashPrimaryRolls[index] ?? combinedDamageRolls[index] ?? selectedDamageRolls[index]
                        ?? (multiplier === 1 ? baseRoll : baseRoll.alter(multiplier, 0));
                    // (Tempest-Sun Redirection: "reduce the spell's damage to those targets by an amount equal to the spell's rank".)
                    // (Transmute Spell's Spirit: no damage to a creature without the weakness.)
                    if (target.shapeNoDamage && Number(damage.total) > 0) damage = damage.alter(0, 0);
                    if (target.shapeReduce && Number(damage.total) > 0) { damage = damage.alter(1, -Math.min(Number(target.shapeReduce), Number(damage.total))); target.damageReduced = target.shapeReduce; }
                    // The larger dice for a target the caster named (its roll, scaled by the same result).
                    const upgraded = target.upgradeAnswer?.answer === "yes" ? (state.conditionalDamage ?? []).find(entry => entry.gate === "target-upgrade" && entry.replaces) : null;
                    if (upgraded) {
                        if (!upgraded.rollJSON) throw new Error(`${target.name}: the larger dice weren't rolled.`);
                        const larger = DamageRoll.fromData(clone(upgraded.rollJSON));
                        damage = multiplier === 1 ? larger : larger.alter(multiplier, 0);
                        target.damageUpgraded = upgraded.rollFormula ?? upgraded.formula;
                    }
                    // Persistent-only damage scaled by the result: PF2e ignores a multiplier on persistent damage, so the formula itself is halved
                    // or doubled ("{5d4[persistent,cold]}" → "{(floor(5d4/2))[persistent,cold]}" / "{(2*5d4)[persistent,cold]}").
                    if (state.damage.persistentScaled && multiplier !== 1) {
                        // (PF2e writes "{6d4[cold,persistent]}" or "{6d4[persistent,cold]}".)
                        const persistent = /^\{\(?([^{}\[\]]+?)\)?\[(?:persistent,([a-z]+)|([a-z]+),persistent)\]\}$/.exec(String(state.damage.rollJSON?.formula ?? baseRoll.formula ?? "").replace(/\s+/g, ""));
                        if (!persistent) throw new Error(`${state.spellName}: PF2e's damage isn't the one persistent entry the result scales (${state.damage.rollJSON?.formula}).`);
                        const scaled = multiplier === 0.5 ? `floor(${persistent[1]}/2)` : multiplier === 2 ? `2*${persistent[1]}` : `${multiplier}*${persistent[1]}`;
                        damage = await new DamageRoll(`{(${scaled})[persistent,${persistent[2] ?? persistent[3]}]}`).evaluate();
                    }
                    // The weapon's damage: its critical roll on a critical failure (the failure's for a creature immune to critical hits), and
                    // the physical damage as the chosen energy for a creature of the trait.
                    if (state.weaponDamage && !state.weaponDamage.dice) {
                        const critical = target.degree === "criticalFailure";
                        const immune = critical && immuneToCriticalHits(actor);
                        let json = critical && !immune ? clone(state.weaponDamage.criticalRollJSON) : clone(state.damage.rollJSON);
                        const convert = state.weaponDamage.convert;
                        if (convert && (actor.traits?.has?.(convert.trait) ?? (actor.system?.traits?.value ?? []).includes(convert.trait))) {
                            for (const type of ["bludgeoning", "piercing", "slashing"]) json = swapDamageType(json, type, convert.to);
                            target.damageSwapped = `physical → ${convert.to}`;
                        }
                        damage = DamageRoll.fromData(json);
                        if (critical) target.weaponCritical = immune ? "immune to critical hits: the failure's damage" : "the weapon's critical damage";
                        if (!critical && multiplier !== 1) damage = damage.alter(multiplier, 0);
                    }
                    // "(this damage bypasses its resistances)": PF2e's own bypass option on the roll; its IWR marks each resistance ignored.
                    if (state.resistanceBypass) damage.options.bypass = { immunity: { ignore: [], downgrade: [], redirect: [] },
                        resistance: { ignore: [{ type: state.resistanceBypass.ignore, max: Infinity }], redirect: [] } };
                    // Half the creature's resistance to the type: PF2e ignores that resistance, and the roll loses the rest of half of it beyond the
                    // creature's best other applicable resistance (all damage, energy), which PF2e still applies — only the highest one counts.
                    if (halving && !immuneHalved) {
                        const resistances = actor.attributes?.resistances ?? [];
                        const own = Math.max(0, ...resistances.filter(resistance => resistance.type === halving.type).map(resistance => Number(resistance.value) || 0));
                        if (own > 0) {
                            const other = Math.max(0, ...resistances.filter(resistance => ["all-damage", "energy"].includes(resistance.type)).map(resistance => Number(resistance.value) || 0));
                            const extra = Math.max(0, Math.floor(own / 2) - other);
                            if (extra > 0) damage = await new DamageRoll(`{${Math.max(0, damage.total - extra)}[${halving.type}]}`).evaluate();
                            damage.options.bypass = { immunity: { ignore: [], downgrade: [], redirect: [] }, resistance: { ignore: [{ type: halving.type, max: Infinity }], redirect: [] } };
                            target.resistanceHalved = `${halving.type} resistance ${own} → ${Math.floor(own / 2)}`;
                        }
                    }
                    // Treat entry into PF2e's damage workflow as irreversible: a hook
                    // can throw after HP has already changed.
                    damageApplied = true;
                    const receipt = await applyDamageWithReceipt(actor, {
                        damage,
                        token: token ?? undefined,
                        skipIWR: false,
                        rollOptions: new Set(state.damage.rollOptions ?? []),
                        shieldBlockRequest: CONFIG.PF2E?.chatDamageButtonShieldToggle ?? false
                    }, randomID());
                    target.damageResults.push({
                        kind: combinedDamageRolls[index] ? 'combined' : "shared",
                        receipt,
                        formula: damage.formula,
                        multiplier,
                        ...(state.damage.componentSelective || combinedDamageRolls[index]
                            ? {selection: clone(outcomeForTarget(state, target)?.damage)} : {}),
                        total: damage.total,
                        instances: damageInstances(damage, {
                            formula: damage.formula,
                            total: damage.total
                        }).map(part => {
                            if (!state.damage.componentSelective) return part;
                            const component = state.damage.components.find(candidate => candidate.type === part.type
                                && (candidate.category === 'persistent' || candidate.type === 'bleed') === part.persistent);
                            const selection = outcomeForTarget(state, target)?.damage;
                            return {...part, multiplier: selection?.componentMultipliers?.[component?.id] ?? multiplier};
                        })
                    });
                    // ("Treat the resistances … as if they were 10 lower": each resistance PF2e applied — its own record, matched to the creature's
                    // resistance by label — stops only min(damage, resistance − 10); the rest is given back.)
                    // (A spellshape's "ignores an amount of the target's resistance to acid, cold, … equal to your level": the same, for those types.)
                    const lowers = [...(state.resistanceLower ? [{ value: state.resistanceLower, types: null }] : []), ...(state.shapeResistanceLower ?? [])];
                    if (lowers.length && Array.isArray(receipt.iwr)) {
                        const resistances = actor.attributes?.resistances ?? [];
                        const back = receipt.iwr.filter(entry => entry.category === "resistance" && !entry.ignored).reduce((sum, entry) => {
                            const applied = Math.abs(Number(entry.adjustment ?? 0));
                            const resistance = resistances.find(candidate => candidate.applicationLabel === entry.type);
                            const lower = Math.max(0, ...lowers.filter(item => !item.types || (resistance && item.types.includes(resistance.type))).map(item => item.value));
                            if (!lower) return sum;
                            const value = Number(resistance?.value ?? NaN);
                            if (!Number.isFinite(value)) return sum + Math.min(lower, applied);
                            const stopped = applied < value ? Math.min(applied, Math.max(0, value - lower)) : Math.max(0, value - lower);
                            return sum + Math.max(0, applied - stopped);
                        }, 0);
                        if (back > 0) target.resistanceLowered = { amount: back, receipt: await applyDamageWithReceipt(actor, { damage: back, token: token ?? undefined, skipIWR: true, rollOptions: new Set() }, randomID()) };
                    }
                    // The trait's extra damage, scaled by the same result.
                    for (const entry of state.conditionalDamage ?? []) {
                        if (entry.replaces) continue;
                        if (!entry.rollJSON || !(entry.gate === "attack-adjustment" ? Number(target.attackAdjustment?.value ?? 0) > 0 : traitApplies(entry, actor, target))) continue;
                        const extraBase = DamageRoll.fromData(clone(entry.rollJSON));
                        // A gated persistent roll isn't doubled on a critical hit.
                        const extra = multiplier === 1 || entry.doubles === false ? extraBase : extraBase.alter(multiplier, 0);
                        const extraReceipt = await applyDamageWithReceipt(actor, { damage: extra, token: token ?? undefined, skipIWR: false,
                            rollOptions: new Set(state.damage.rollOptions ?? []), shieldBlockRequest: false }, randomID());
                        target.damageResults.push({ kind: "conditional", trait: entry.trait, receipt: extraReceipt, formula: extra.formula, multiplier, total: extra.total,
                            instances: damageInstances(extra, { formula: extra.formula, total: extra.total }) });
                    }
                    await this.#updateCard(card, state);
                    debugLog(state.castId, "target damage applied", {
                        targetId: target.id,
                        actorUuid: actor.uuid,
                        multiplier,
                        hpBefore: target.hpBefore,
                        hpAfter: hpValue(actor)
                    });
                }
                // Damage gate: a creature that took none of the delivery damage
                // makes no save and suffers nothing further from this cast.
                if (state.damageGate) {
                    const taken = (target.damageResults ?? []).filter(result => result.kind === "shared")
                        .reduce((total, result) => total + Number(result.receipt?.damage ?? 0), 0);
                    target.damageGate = { damageType: state.damageGate.damageType, taken, passed: taken > 0 };
                    if (!(taken > 0)) {
                        target.conditionResults = [{ label: `Took no ${state.damageGate.damageType} damage — no save; the rest of the outcome does not apply`, status: "manual" }];
                        target.hpAfter = hpValue(actor);
                        target.applicationStatus = "applied";
                        await this.#updateCard(card, state);
                        continue;
                    }
                }
                for (const rollId of combinedDamageRolls[index] ? [] : outcomeDamageRollIds(state, target)) {
                    const entry = outcomeRolls.get(rollId);
                    if (!entry?.rollJSON) throw new Error(`${target.name}: required outcome damage ${rollId} is unavailable.`);
                    // (Divine Immolation: the row's persistent part takes the creature's worse type too.)
                    const rowSwap = state.damageSwap?.when === "more-detrimental" && damageSwapApplies(state.damageSwap, actor) ? state.damageSwap : null;
                    let rowJSON = rowSwap ? swapDamageType(clone(entry.rollJSON), rowSwap.from, rowSwap.to) : clone(entry.rollJSON);
                    // (A spellshape's or catalyst's type change — Necrotic Cap's "all acid damage the spell deals becomes void" — on the row's own damage too.)
                    if (state.shapeTypeSwap) for (const from of state.shapeTypeSwap.from) rowJSON = swapDamageType(rowJSON, from, state.shapeTypeSwap.to);
                    const damage = DamageRoll.fromData(rowJSON);
                    damageApplied = true;
                    const receipt = await applyDamageWithReceipt(actor, {
                        damage,
                        token: token ?? undefined,
                        skipIWR: false,
                        rollOptions: new Set(entry.rollOptions ?? []),
                        shieldBlockRequest: CONFIG.PF2E?.chatDamageButtonShieldToggle ?? false
                    }, randomID());
                    target.damageResults.push({
                        kind: "outcome",
                        receipt,
                        rollId,
                        formula: entry.formula,
                        multiplier: 1,
                        total: damage.total,
                        instances: damageInstances(damage, {
                            formula: entry.formula,
                            total: damage.total
                        })
                    });
                    await this.#updateCard(card, state);
                    debugLog(state.castId, "target outcome damage applied", {
                        targetId: target.id,
                        actorUuid: actor.uuid,
                        rollId,
                        formula: entry.formula,
                        total: damage.total,
                        hpAfter: hpValue(actor)
                    });
                }
                // A persistent-linked condition needs its persistent damage on the creature (PF2e may have refused it: immunity, a larger instance).
                const batch = conditionSources[index].filter(entry => {
                    // "… and if damaged by the spell is Clumsy 1": only for a target the GM answered yes for, that took damage.
                    if (entry.conditions.some(({condition}) => condition.gate?.kind === "adjustment-and-damaged")) {
                        const answered = Number(target.attackAdjustment?.value ?? 0) !== 0;
                        const damaged = (target.damageResults ?? []).reduce((total, result) => total + Number(result.receipt?.damage ?? 0), 0) > 0;
                        if (!answered || !damaged) {
                            target.effectNotes = [...(target.effectNotes ?? []), `${entry.conditions.map(({condition}) => conditionLabel(condition)).join(", ")} not applied: ${answered ? "the spell didn't damage the creature" : "the GM answered no"}.`];
                            return false;
                        }
                    }
                    // "If the creature is already exposed to bright light, it immediately becomes Blinded …": only on the GM's yes.
                    if (entry.conditions.some(({condition}) => condition.gate?.kind === "gm-question" && gateAnswerFor(target, condition.gate) !== "yes")) {
                        target.effectNotes = [...(target.effectNotes ?? []), `${entry.conditions.map(({condition}) => conditionLabel(condition)).join(", ")} not applied: the GM answered no.`];
                        return false;
                    }
                    // "If it's asleep, it wakes up and is Paralyzed …": asleep is PF2e's Unconscious with Hit Points above 0 (not knocked out).
                    if (entry.conditions.some(({condition}) => condition.gate?.kind === "asleep")) {
                        const asleep = actor.hasCondition?.("unconscious") && Number(actor.hitPoints?.value ?? actor.system?.attributes?.hp?.value ?? 0) > 0;
                        if (!asleep) {
                            target.effectNotes = [...(target.effectNotes ?? []), `${entry.conditions.map(({condition}) => conditionLabel(condition)).join(", ")} not applied: the creature wasn't asleep.`];
                            return false;
                        }
                        entry.wakes = true;
                    }
                    if (!entry.persistentLink || hasPersistentDamage(actor, entry.persistentLink.damageType)) return true;
                    target.effectNotes = [...(target.effectNotes ?? []), `${entry.conditions.map(({condition}) => conditionLabel(condition)).join(", ")} not applied: the creature isn't taking persistent ${entry.persistentLink.damageType} damage.`];
                    return false;
                });
                if (batch.some(entry => entry.wakes)) {
                    // It wakes up: its Unconscious ends.
                    const sleeping = actor.itemTypes?.condition?.filter(condition => condition.slug === "unconscious") ?? [];
                    if (sleeping.length) await actor.deleteEmbeddedDocuments("Item", sleeping.map(condition => condition.id));
                    target.effectNotes = [...(target.effectNotes ?? []), "It was asleep: it wakes up."];
                }
                if (batch.length) {
                    const roots = batch.filter(entry => !entry.linkedTo);
                    const linked = batch.filter(entry => entry.linkedTo);
                    const created = await actor.createEmbeddedDocuments("Item", roots.map(entry => entry.source), { keepId: false });
                    createdEffects.push(...created.filter(effect => effect.type === "effect"));
                    const rootWrappers = new Map(created.filter(effect => outcomeEffectMetadata(effect)?.applicationId)
                        .map(effect => [outcomeEffectMetadata(effect).applicationId, effect]));
                    const skippedLinks = new Set();
                    for (const entry of linked) {
                        const root = rootWrappers.get(entry.linkedTo.rootApplicationId);
                        const grant = root?.flags?.pf2e?.itemGrants?.[entry.linkedTo.rootRuleFlag];
                        const rootCondition = grant && (actor.items?.get?.(grant.id)
                            ?? [...(actor.items ?? [])].find(item => item.id === grant.id));
                        const rule = root?.system?.rules?.find(candidate =>
                            candidate.key === "GrantItem" && candidate.flag === entry.linkedTo.rootRuleFlag);
                        if (rule?.ignored === true) {
                            skippedLinks.add(entry.applicationId);
                            continue;
                        }
                        if (!rootCondition) throw new Error(`${target.name}: the linked condition's native root grant was not confirmed.`);
                        if (rootCondition.slug !== entry.linkedTo.rootSlug) {
                            throw new Error(`${target.name}: the linked condition's native root grant changed.`);
                        }
                        entry.source.flags[MODULE_ID].outcomeEffect.linkedTo = {
                            ...entry.linkedTo,
                            rootEffectUuid: root.uuid,
                            rootGrantId: grant.id
                        };
                    }
                    if (linked.length > skippedLinks.size) {
                        const linkedCreated = await actor.createEmbeddedDocuments("Item",
                            linked.filter(entry => !skippedLinks.has(entry.applicationId)).map(entry => entry.source), { keepId: false });
                        created.push(...linkedCreated);
                        createdEffects.push(...linkedCreated.filter(effect => effect.type === "effect"));
                    }
                    const applicationIds = new Set(batch.map(entry =>
                        entry.source.flags[MODULE_ID].outcomeEffect.applicationId).filter(id => !skippedLinks.has(id)));
                    const wrappers = created.filter(effect =>
                        applicationIds.has(outcomeEffectMetadata(effect)?.applicationId));
                    debugLog(state.castId, "PF2e condition documents returned", {
                        targetId: target.id,
                        actorUuid: actor.uuid,
                        requestedWrappers: batch.length,
                        returnedDocuments: created.map(documentDiagnostic),
                        matchedWrappers: wrappers.map(documentDiagnostic)
                    });
                    if (wrappers.length !== applicationIds.size) {
                        throw new Error(`${target.name}: PF2e returned ${created.length} documents but only ${wrappers.length} of ${applicationIds.size} compiled condition Effects could be identified.`);
                    }
                    const wrappersByApplicationId = new Map(wrappers.map(effect =>
                        [outcomeEffectMetadata(effect).applicationId, effect]));
                    const retained = [];
                    const outlives = new Set();
                    target.conditionResults = [];
                    for (const entry of batch) {
                        const applicationId = entry.applicationId;
                        if (skippedLinks.has(applicationId)) {
                            for (const grant of entry.conditions) target.conditionResults.push({
                                slug: grant.condition.slug,
                                label: conditionLabel(grant.condition),
                                status: "dependency-unavailable",
                                applicationId,
                                effectUuid: null
                            });
                            continue;
                        }
                        const effect = wrappersByApplicationId.get(applicationId);
                        const grantRules = effect?.system?.rules?.filter(rule => rule.key === "GrantItem") ?? [];
                        let appliedConditions = 0;
                        for (const grant of entry.conditions) {
                            const rule = grantRules.find(candidate => candidate.flag === grant.ruleFlag);
                            const ignored = rule?.ignored === true;
                            if (!ignored) appliedConditions += 1;
                            target.conditionResults.push({
                                slug: grant.condition.slug,
                                label: conditionLabel(grant.condition),
                                status: ignored ? "immune" : "applied",
                                applicationId,
                                duration: clone(entry.duration),
                                effectUuid: ignored ? null : effect?.uuid ?? null
                            });
                        }
                        if (appliedConditions === 0) {
                            await effect.delete({ [MODULE_ID]: { reason: "condition-immune" } });
                        } else if (effect) {
                            retained.push(effect);
                            // A condition the spell only floors ("can't be reduced below 1 while the spell is active") outlives it.
                            // (So does Prone without a timer of its own: it lasts until the creature Stands.)
                            // (Not one an end-of-turn save still moves — Petrify's unlimited Slowed: the cast keeps tracking it.)
                            if (entry.conditions.every(grant => grant.condition.duration?.mode === "unlimited" || (grant.condition.duration == null && grant.condition.slug === "prone"))
                                && !entry.conditions.some(grant => grant.condition.recurringSave)) outlives.add(effect);
                        }
                    }
                    if (ongoingJournal) for (const effect of retained) await this.ongoing.attach(ongoingJournal, effect, { permanent: outlives.has(effect) });
                    target.effectUuids = retained.map(effect => effect.uuid);
                }
                for (const {source, effect: specification} of nativeEffectSources[index]) {
                    if (source.flags?.[MODULE_ID]?.runtime?.beforeDamage) continue;
                    const link = source.flags?.[MODULE_ID]?.runtime?.persistentLink;
                    if (link && !hasPersistentDamage(actor, link.damageType)) {
                        target.effectNotes = [...(target.effectNotes ?? []), `${nativeOutcomeLabel(specification)} not applied: the creature isn't taking persistent ${link.damageType} damage.`];
                        continue;
                    }
                    const created = await createNativeEffect(actor, source);
                    createdEffects.push(created);
                    target.effectUuids ??= [];
                    target.effectUuids.push(created.uuid);
                    target.conditionResults ??= [];
                    target.conditionResults.push({label: nativeOutcomeLabel(specification), status: 'applied',
                        effectUuid: created.uuid, duration: {mode:'fixed', ...clone(created.system.duration)}});
                    if (ongoingJournal) await this.ongoing.attach(ongoingJournal, created);
                    // "You take on the target's appearance, and they take yours.": the same Effect on the caster, once.
                    if (specification.outcomeRule?.alsoCaster && !state.casterCopyUuid) {
                        const caster = await fromUuid(state.sourceActorUuid);
                        if (!caster) throw new Error(`${state.spellName}: the caster is missing.`);
                        const copy = clone(source);
                        copy.system.context = { ...(copy.system.context ?? {}), target: { actor: caster.uuid, token: null } };
                        if (copy.flags?.[MODULE_ID]?.runtime) copy.flags[MODULE_ID].runtime.targetActorUuid = caster.uuid;
                        const mine = await createNativeEffect(caster, copy);
                        createdEffects.push(mine);
                        state.casterCopyUuid = mine.uuid;
                        if (ongoingJournal) await this.ongoing.attach(ongoingJournal, mine);
                    }
                }
                for (const {source, note} of noteSources[index]) {
                    // A note tied to the row's condition ends with that condition's Effect (linked-effect runtime).
                    if (note.whileCondition) {
                        const root = createdEffects.find(effect => effect.actor?.uuid === actor.uuid && (effect.flags?.[MODULE_ID]?.outcomeEffect?.conditions ?? []).some(entry => entry.slug === note.whileCondition));
                        if (!root) throw new Error(`${target.name}: the ${note.whileCondition} Effect the note depends on wasn't found.`);
                        source.flags[MODULE_ID].runtime.endsWithEffectUuid = root.uuid;
                    }
                    // A note lasting while the persistent damage does: none if the creature isn't taking it (immune, resisted to 0).
                    if (note.whilePersistent && !hasPersistentDamage(actor, note.whilePersistent)) {
                        target.effectNotes = [...(target.effectNotes ?? []), `${note.label} not applied: the creature isn't taking persistent ${note.whilePersistent} damage.`];
                        continue;
                    }
                    const created = await createNativeEffect(actor, source);
                    createdEffects.push(created);
                    target.effectUuids ??= [];
                    target.effectUuids.push(created.uuid);
                    target.conditionResults ??= [];
                    target.conditionResults.push({label: `Note: ${note.label}`, status: 'applied', effectUuid: created.uuid, duration: clone(note.duration)});
                    if (ongoingJournal) await this.ongoing.attach(ongoingJournal, created);
                    // "the zombie is a minion under your control": the caster's owners get the token (restored when the note ends).
                    if (note.minionControl) await grantMinionControl(created, actor, state.sourceActorUuid);
                    // "The parrot tells you the target's highest weakness immediately".
                    if (note.reveal?.timing === "now") await revealInformation(actor, { kind: note.reveal.kind, sourceActorUuid: state.sourceActorUuid, spellName: state.spellName, text: note.reveal.text ?? null });
                }
                for (const {source,modifier} of generatedSpeedSources[index]) {
                    const created = await createNativeEffect(actor,source);
                    createdEffects.push(created);
                    target.effectUuids ??= [];
                    target.effectUuids.push(created.uuid);
                    target.conditionResults ??= [];
                    target.conditionResults.push({label:generatedSpeedLabel(modifier),status:'applied',
                        effectUuid:created.uuid,duration:clone(modifier.duration)});
                    if (ongoingJournal) await this.ongoing.attach(ongoingJournal,created);
                }
                // Affliction handoff: the final degree goes to Pseudo Afflictions,
                // which owns the affliction Effect, stage effects and progression.
                const affliction = state.afflictionHandoff ? outcomeForTarget(state, target)?.affliction : null;
                if (affliction) {
                    const handoff = await handOffAffliction(state, target, actor, affliction);
                    if (handoff.created) createdEffects.push(handoff.created);
                    // "the stage of the curse can't increase beyond stage 1": the new Effect's counter stops there (Pseudo Afflictions raises it to at most its
                    // max, which PF2e takes from the counter's one label per stage).
                    if (handoff.created && affliction.maxStage) {
                        const labels = handoff.created._source.system?.badge?.labels;
                        await handoff.created.update(Array.isArray(labels) && labels.length ? {"system.badge.labels": labels.slice(0, affliction.maxStage)} : {"system.badge.max": affliction.maxStage});
                        if (handoff.created.badge?.max !== affliction.maxStage) throw new Error(`${target.name}: ${handoff.created.name} didn't take its stage limit.`);
                    }
                    // (A raised Effect from an earlier cast keeps that cast's end; only this cast's own Effect is attached.)
                    if (handoff.created && state.afflictionHandoff.endsWithSpell && ongoingJournal) await this.ongoing.attach(ongoingJournal, handoff.created);
                    if (handoff.updated) damageApplied = true;
                    target.conditionResults ??= [];
                    target.conditionResults.push({label: afflictionLabel(affliction, handoff, state.castChoice), status: handoff.status === "applied" ? "applied" : "manual", ...(handoff.effectUuid ? {effectUuid: handoff.effectUuid} : {})});
                }
                const floor = outcomeForTarget(state, target)?.conditionFloor;
                if (floor) {
                    const source = conditionFloorSource(state, target, actor, floor);
                    // "… as long as it remains stupefied by this spell": the floor is linked to that condition's Effect (Ongoing ends it with it).
                    if (floor.lifetime === "while-condition") {
                        const root = createdEffects.find(effect => effect.actor?.uuid === actor.uuid
                            && (effect.flags?.[MODULE_ID]?.outcomeEffect?.conditions ?? []).some(entry => entry.slug === floor.whileCondition.slug));
                        const ruleFlag = (root?.flags?.[MODULE_ID]?.outcomeEffect?.conditions ?? []).find(entry => entry.slug === floor.whileCondition.slug)?.ruleFlag;
                        const grantId = ruleFlag ? root.flags?.pf2e?.itemGrants?.[ruleFlag]?.id : null;
                        if (!root || !grantId || !ongoingJournal) throw new Error(`${target.name}: the ${floor.whileCondition.slug} Effect the floor depends on wasn't found.`);
                        source.flags[MODULE_ID].outcomeEffect.linkedTo = { rootEffectUuid: root.uuid, rootGrantId: grantId, rootRuleFlag: ruleFlag, rootSlug: floor.whileCondition.slug };
                    }
                    const created = await createNativeEffect(actor, source);
                    createdEffects.push(created);
                    // A floor "while the spell is active" ends with the cast.
                    if (["spell", "while-condition"].includes(floor.lifetime) && ongoingJournal) await this.ongoing.attach(ongoingJournal, created);
                    target.effectUuids ??= [];
                    target.effectUuids.push(created.uuid);
                    target.conditionResults ??= [];
                    target.conditionResults.push({label: conditionFloorLabel(floor, target.secondaryOf), status: 'applied', effectUuid: created.uuid});
                }
                // Spell-granted immunity to the affliction, or a save penalty against it.
                for (const source of state.afflictionHandoff ? afflictionExtraSources(state, target, actor, outcomeForTarget(state, target)) : []) {
                    const created = await createNativeEffect(actor, source.effect);
                    createdEffects.push(created);
                    // (Its own time, not the cast's: a lasting cast's end doesn't take the immunity with it — Curse of Death's day.)
                    if (ongoingJournal) await this.ongoing.attach(ongoingJournal, created, { permanent: true });
                    target.effectUuids ??= [];
                    target.effectUuids.push(created.uuid);
                    target.conditionResults ??= [];
                    target.conditionResults.push({label: source.label, status: 'applied', effectUuid: created.uuid, duration: {mode: 'fixed', ...clone(created.system.duration)}});
                }
                // This cast's own confirmed damage must take the creature from
                // positive HP to 0; other damage or already-0 HP never qualifies.
                if (state.postDamageTerminal && !target.terminalApplied) {
                    const dealt = (target.damageResults ?? []).reduce((total, result) => total + Number(result.receipt?.damage ?? 0), 0);
                    if (Number(target.hpBefore) > 0 && dealt > 0 && hpValue(actor) === 0) {
                        damageApplied = true;
                        await applyTerminalDeath(state, target, actor, state.postDamageTerminal);
                        target.killedBySpell = true;
                    }
                }
                const terminal = secondaryOutcomeForTarget(state, target)?.terminal ?? null;
                if (terminal?.kind === "death") {
                    // A confirmed terminal status and cleared 0-HP conditions
                    // cannot be transactionally reconstructed on rollback.
                    damageApplied = true;
                    await applyTerminalDeath(state, target, actor, terminal);
                }
                // "The target's Dying value increases by 1." (PF2e's own increase; at its maximum the creature dies), and "The target dies.".
                const primaryRow = outcomeForTarget(state, target);
                for (const increase of primaryRow?.conditionIncreases ?? []) {
                    damageApplied = true;
                    const before = actor.getCondition?.(increase.slug)?.value ?? 0;
                    await actor.increaseCondition(increase.slug, { value: increase.amount });
                    const after = actor.getCondition?.(increase.slug)?.value ?? 0;
                    if (after !== before + increase.amount) throw new Error(`${target.name}: PF2e did not confirm ${increase.slug} ${before + increase.amount}.`);
                    target.conditionResults ??= [];
                    target.conditionResults.push({ label: `${increase.slug[0].toUpperCase()}${increase.slug.slice(1)} ${after}`, status: "applied" });
                    const dyingMax = Number(actor.system?.attributes?.dying?.max ?? 4);
                    if (increase.slug === "dying" && after >= dyingMax && !target.terminalApplied) {
                        await applyTerminalDeath(state, target, actor, { kind: "death", label: `Dies (Dying ${after})`, automatic: true });
                        target.killedByRow = true;
                    }
                }
                if (isPrimaryDeath(primaryRow?.terminal) && !target.terminalApplied) {
                    damageApplied = true;
                    await applyTerminalDeath(state, target, actor, primaryRow.terminal);
                    target.killedByRow = true;
                }
                if (state.temporaryImmunity && (!state.temporaryImmunity.degrees || state.temporaryImmunity.degrees.includes(target.degree))) {
                    // Immune from the spell's end: no timer until then (the Ongoing record starts it when the spell ends).
                    const afterEnd = state.temporaryImmunity.startsWhen === 'spell-ended';
                    // (Each result's own time, and one caster's castings only, when the rows say so.)
                    const immuneFor = state.temporaryImmunity.byDegree?.[target.degree] ?? state.temporaryImmunity.duration;
                    const immuneKey = state.temporaryImmunity.byCaster ? `${state.temporaryImmunity.key}:${state.sourceActorUuid}` : state.temporaryImmunity.key;
                    if (afterEnd && !ongoingJournal) throw Error(`${target.name}: immunity after the spell ends needs the Ongoing record.`);
                    const [effect] = await actor.createEmbeddedDocuments('Item', [{
                        name: `${state.spellName}: Temporary immunity`, type:'effect', img:'icons/svg/shield.svg',
                        flags:{[MODULE_ID]:{spellImmunity:{key:immuneKey,...(afterEnd?{afterEnd:clone(immuneFor)}:{})},outcomeEffect:{castId:state.castId,sourceActorUuid:state.sourceActorUuid,sourceItemUuid:state.sourceItemUuid,sourceItemName:state.spellName,conditions:[]}}},
                        system:{duration:afterEnd?{value:-1,unit:'unlimited',expiry:null,sustained:false}:{expiry:'turn-start',...immuneFor,sustained:false},
                            context:{origin:{actor:actor.uuid},target:{actor:actor.uuid},roll:null},rules:[]}
                    }]);
                    if(!effect)throw Error(`${target.name}: temporary immunity was not confirmed.`);
                    createdEffects.push(effect);
                    target.effectUuids??=[];target.effectUuids.push(effect.uuid);
                    if(ongoingJournal)await this.ongoing.attach(ongoingJournal,effect);
                    target.conditionResults??=[];
                    target.conditionResults.push({label:`Temporary immunity (${afterEnd?'until the spell ends, then ':''}${immuneFor.value} ${immuneFor.unit})`,status:'applied',effectUuid:effect.uuid});
                }
                // The lifted immunity stays only while this spell's persistent damage of that type does.
                if (target.immunityBypassUuid && !hasPersistentDamage(actor, state.immunityBypass.type)) {
                    await (await fromUuid(target.immunityBypassUuid))?.delete();
                    target.immunityBypassUuid = null;
                }
                // (Ravaging End: the row's note holds the spell's persistent damage — it ends with the note, at the row's recovery DC.)
                const holder = [...(actor.itemTypes?.effect ?? [])].find(effect => effect.flags?.[MODULE_ID]?.runtime?.castInstanceId === state.castId && effect.flags[MODULE_ID].runtime.holdsPersistent);
                if (holder) {
                    const ids = (target.damageResults ?? []).flatMap(result => result.receipt?.persistentIds ?? []).map(entry => typeof entry === "string" ? entry : entry?._id ?? entry?.id);
                    const held = ids.map(id => actor.items.get(id)).filter(item => item?.slug === "persistent-damage");
                    const tied = held.length ? held : [...(actor.itemTypes?.condition ?? [])].filter(item => item.slug === "persistent-damage" && item.system?.persistent?.damageType === state.casterChoice?.selected);
                    if (tied.length) await actor.updateEmbeddedDocuments("Item", tied.map(item => ({ _id: item.id, [`flags.${MODULE_ID}.endsWithEffectUuid`]: holder.uuid,
                        "system.persistent.dc": Number(holder.flags[MODULE_ID].runtime.holdsPersistent.dc) })));
                }
                // "If the target recovers from being Sickened, the persistent damage ends": tag this row's persistent damage.
                const endsWith = state.persistentEndsWith?.[target.degree];
                if (endsWith) {
                    const ids = (target.damageResults ?? []).flatMap(result => result.receipt?.persistentIds ?? []).map(entry => typeof entry === "string" ? entry : entry?._id ?? entry?.id);
                    const ofType = item => item?.slug === "persistent-damage" && item.system?.persistent?.damageType === endsWith.damageType;
                    // PF2e keeps one persistent condition per type: the receipt's, or the one this damage left.
                    const received = ids.map(id => actor.items.get(id)).filter(ofType);
                    const tagged = received.length ? received : ids.length ? [...(actor.itemTypes?.condition ?? [])].filter(ofType) : [];
                    if (tagged.length) {
                        await actor.updateEmbeddedDocuments("Item", tagged.map(item => ({ _id: item.id, [`flags.${MODULE_ID}.persistentEndsWith`]: { condition: endsWith.condition, castId: state.castId } })));
                        target.effectNotes = [...(target.effectNotes ?? []), `The persistent ${endsWith.damageType} damage ends when ${endsWith.condition} does.`];
                    }
                }
                target.hpAfter = hpValue(actor);
                target.applicationStatus = "applied";
                await this.#updateCard(card, state);
                debugLog(state.castId, "target application completed", {
                    targetId: target.id,
                    actorUuid: actor.uuid,
                    hpBefore: target.hpBefore,
                    hpAfter: target.hpAfter,
                    conditions: target.conditionResults,
                    effectUuids: target.effectUuids
                });
            }
            // Splash: on a hit or critical hit, each creature within 5 feet of the target takes the splash once.
            const struck = state.targets.find(targetParticipates);
            const splashHit = struck && ["success", "criticalSuccess"].includes(struck.degree) && struck.applicationStatus === "applied";
            for (const target of splashTargets(state)) {
                if (target.applicationStatus !== "pending") continue;
                if (!splashHit) { target.applicationStatus = "unaffected"; target.splashNote = "The attack didn't hit: no splash damage."; continue; }
                const { actor, token } = await resolveTargetDocuments(target);
                if (!actor) throw new Error(`${target.name}: the creature is missing.`);
                assertPersistedTargetIdentity(target, actor);
                const roll = await splashDamageRoll(splashSplit, { splashOnly: true }, DamageRoll);
                if (!roll) { target.applicationStatus = "unaffected"; target.splashNote = "No splash damage was rolled."; continue; }
                target.hpBefore = hpValue(actor);
                target.applicationStatus = "applying";
                damageApplied = true;
                const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, skipIWR: false,
                    rollOptions: new Set(state.damage.rollOptions ?? []), shieldBlockRequest: false }, randomID());
                target.damageResults = [{ kind: "splash", receipt, formula: roll.formula, multiplier: 1, total: roll.total,
                    instances: damageInstances(roll, { formula: roll.formula, total: roll.total }) }];
                target.hpAfter = hpValue(actor);
                target.applicationStatus = "applied";
                await this.#updateCard(card, state);
            }
            // Bolstered creatures: PF2e's bonus Effect, no save.
            const bolstered = state.bolster ? state.targets.filter(target => target.bolster?.status === "bolstered" && !target.bolster.applied && target.excluded !== true) : [];
            if (bolstered.length) {
                const template = await loadNativeEffectTemplate(state.bolster.uuid);
                const mechanics = { rules: template.system?.rules, duration: template.system?.duration, start: template.system?.start };
                if (!sameEffectMechanics(mechanics, state.bolster.document?.mechanics) || !proveBolsterEffect(mechanics, state.bolster.claim))
                    throw new Error(`${state.spellName}: ${template.name} changed since it was compiled.`);
                for (const target of bolstered) {
                    const { actor } = await resolveTargetDocuments(target);
                    if (!actor) throw new Error(`${target.name}: the creature is missing.`);
                    const created = await createNativeEffect(actor, prepareNativeEffectSource(template, { castInstanceId: state.castId, castRank: state.castRank,
                        sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, resolutionKind: "save", compilerVersion: state.compilerVersion }));
                    target.bolster = { ...target.bolster, applied: true };
                    target.effectUuids = [...(target.effectUuids ?? []), created.uuid];
                    target.conditionResults = [...(target.conditionResults ?? []), { label: template.name, status: "applied", effectUuid: created.uuid }];
                    await this.#updateCard(card, state);
                }
            }
            // Creatures of the trait (Deathless March's undead): the condition for its time, in an Effect with its note; no save.
            for (const target of state.traitGrant ? state.targets.filter(entry => entry.mode === "trait-grant" && entry.excluded !== true && entry.eligible !== false) : []) {
                if (target.applicationStatus === "applied") continue;
                const { actor } = await resolveTargetDocuments(target);
                if (!actor) throw new Error(`${target.name}: the creature is missing.`);
                assertPersistedTargetIdentity(target, actor);
                const grant = state.traitGrant;
                const [created] = await actor.createEmbeddedDocuments("Item", [{ name: `${state.spellName}: ${grant.label}`, type: "effect", img: "icons/svg/clockwork.svg",
                    flags: { [MODULE_ID]: { traitGrant: { castId: state.castId } } },
                    system: { duration: { value: grant.duration.value, unit: grant.duration.unit, expiry: "turn-start", sustained: false }, level: { value: state.castRank }, fromSpell: true,
                        context: { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: actor.uuid, token: target.tokenUuid ?? null }, roll: null },
                        description: { value: `<p>${escapeHTML(grant.note)}</p>` },
                        rules: [{ key: "GrantItem", uuid: grant.uuid, flag: "traitGrant", allowDuplicate: true, onDeleteActions: { granter: "cascade", grantee: "cascade" } }] } }]);
                target.effectUuids = [created.uuid];
                target.conditionResults = [{ label: grant.label, status: "applied", effectUuid: created.uuid }];
                target.applicationStatus = "applied";
                await this.#updateCard(card, state);
            }
            // Allies in an ally/enemy area: one healing roll for the cast, and the spell's Effect on each.
            const allies = state.allySplit ? state.targets.filter(target => target.mode === "ally" && target.excluded !== true && target.eligible !== false) : [];
            if (allies.some(target => target.applicationStatus !== "applied")) {
                const spell = await castSpellFromUuid(state);
                if (!spell) throw new Error(`${state.spellName}: the spell is missing; its allies can't be healed.`);
                // (Roar of Freedom: no healing — the Effect's temporary Hit Points.)
                const healing = state.allySplit.healing != null;
                if (healing && !state.allySplit.roll) {
                    const rollData = spell.getRollData?.({ castRank: state.castRank }) ?? { item: { rank: state.castRank, level: state.castRank } };
                    const HealingRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
                    if (!HealingRoll) throw new Error("PF2e's DamageRoll class could not be resolved.");
                    const roll = await new HealingRoll(state.allySplit.healing.formula, rollData, { rollerId: game.user.id }).evaluate();
                    state.allySplit.roll = { formula: roll.formula, total: roll.total };
                    await this.#updateCard(card, state);
                    try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(state.sourceActorUuid) }), flavor: `<strong>${escapeHTML(state.spellName)}</strong> — healing for allies` }); } catch (_) {}
                }
                const template = await loadNativeEffectTemplate(state.allySplit.effect.uuid);
                const mechanics = { rules: template.system?.rules, duration: template.system?.duration, start: template.system?.start };
                if (!sameEffectMechanics(mechanics, state.allySplit.effect.document?.mechanics) || !(healing ? proveAllyEffect(mechanics, state.allySplit.bonus) : proveAllyTempHP(mechanics, state.allySplit.tempHP)))
                    throw new Error(`${state.spellName}: ${template.name} changed since it was compiled.`);
                for (const target of allies) {
                    if (target.applicationStatus === "applied") continue;
                    const { actor, token } = await resolveTargetDocuments(target);
                    if (!actor) throw new Error(`${target.name}: the creature is missing.`);
                    assertPersistedTargetIdentity(target, actor);
                    target.hpBefore = hpValue(actor);
                    target.applicationStatus = "applying";
                    damageApplied = true;
                    if (healing) {
                        const wasDying = isDying(actor);
                        const receipt = await applyDamageWithReceipt(actor, { damage: -state.allySplit.roll.total, token: token ?? undefined, skipIWR: true,
                            rollOptions: new Set(), shieldBlockRequest: false }, randomID());
                        target.damageResults = [{ kind: "healing", receipt, formula: state.allySplit.roll.formula, multiplier: -1, total: state.allySplit.roll.total }];
                        const revived = await recoverFromDying(actor, wasDying);
                        if (revived) target.revived = revived;
                    }
                    const created = await createNativeEffect(actor, prepareNativeEffectSource(template, { castInstanceId: state.castId, castRank: state.castRank,
                        sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, resolutionKind: "save", compilerVersion: state.compilerVersion }));
                    target.effectUuids = [created.uuid];
                    target.conditionResults = [{ label: template.name, status: "applied", effectUuid: created.uuid }];
                    target.hpAfter = hpValue(actor);
                    target.applicationStatus = "applied";
                    await this.#updateCard(card, state);
                }
            }
            // Heal-or-harm: targets that are healed take the spell's rolled amount as healing (no save).
            for (const target of healingTargets(state)) {
                if (target.applicationStatus === "applied") continue;
                if (!state.damage?.rollJSON) throw new Error(`${target.name}: the spell's roll is missing; it can't be healed.`);
                const { actor, token } = await resolveTargetDocuments(target);
                if (!actor) throw new Error(`${target.name}: the creature is missing.`);
                assertPersistedTargetIdentity(target, actor);
                const amount = Number(state.damage.total);
                if (!Number.isFinite(amount) || amount < 0) throw new Error(`${target.name}: the spell's roll has no usable total.`);
                target.hpBefore = hpValue(actor);
                target.applicationStatus = "applying";
                damageApplied = true;
                // Healing has no IWR; the receipt records the Hit Points restored.
                const wasDying = isDying(actor);
                const receipt = await applyDamageWithReceipt(actor, { damage: -amount, token: token ?? undefined, skipIWR: true,
                    rollOptions: new Set(), shieldBlockRequest: false }, randomID());
                target.damageResults = [{ kind: "healing", receipt, formula: state.damage.formula, multiplier: -1, total: amount }];
                // Healed back from Dying: Dying and Unconscious end, Wounded rises (dying-recovery.js).
                const revived = await recoverFromDying(actor, wasDying);
                if (revived) target.revived = revived;
                // "… and ends one source of persistent acid, bleed, fire, poison, or void damage affecting it" (the caster picks among several).
                if (state.persistentRemoval) {
                    const sources = actor.itemTypes?.condition?.filter(item => item.slug === "persistent-damage" && state.persistentRemoval.types.includes(item.system?.persistent?.damageType)) ?? [];
                    const picked = sources.length > 1 ? await foundry.applications.api.DialogV2.prompt({ window: { title: `${state.spellName} — which persistent damage ends?` },
                        content: `<select name="pick">${sources.map(item => `<option value="${item.id}">${escapeHTML(item.name)}</option>`).join("")}</select>`,
                        ok: { label: "End it", callback: (_event, button) => button.form.elements.pick.value }, rejectClose: false }) : sources[0]?.id;
                    const ended = picked ? actor.items.get(picked) : null;
                    if (ended) { target.persistentRemoved = ended.name; await ended.delete(); }
                }
                target.hpAfter = hpValue(actor);
                target.applicationStatus = "applied";
                await this.#updateCard(card, state);
            }
            // A caster benefit carried by the spell's Effect: always, or when the attack hit a target.
            if (state.casterEffect && !state.casterEffectResult) {
                const hit = state.targets.some(target => targetParticipates(target) && ["success", "criticalSuccess"].includes(target.degree));
                if (state.casterEffect.when === "always" || hit) {
                    const caster = await fromUuid(state.sourceActorUuid);
                    if (!caster) throw new Error(`${state.spellName}: the caster is missing.`);
                    const template = await loadNativeEffectTemplate(state.casterEffect.uuid);
                    const mechanics = { rules: template.system?.rules, duration: template.system?.duration, start: template.system?.start };
                    if (!sameEffectMechanics(mechanics, state.casterEffect.document?.mechanics)
                        || !inspectCasterBenefitClaim({ mechanics, badge: template.system?.badge }, state.casterEffect.claimText, { rank: state.casterEffect.rank, spellDuration: state.casterEffect.spellDuration }).supported)
                        throw new Error(`${state.spellName}: ${template.name} changed since it was compiled.`);
                    const created = await createNativeEffect(caster, prepareNativeEffectSource(template, { castInstanceId: state.castId, castRank: state.castRank,
                        sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, resolutionKind: "save", compilerVersion: state.compilerVersion,
                        // "At the end of the movement, …": the module removes it when the caster's token next moves (the text).
                        ...(state.casterEffect.endsAfterMovement ? { endsAfterMovement: true } : {}) }));
                    createdEffects.push(created);
                    state.casterEffectResult = { status: "applied", name: created.name, uuid: created.uuid };
                } else state.casterEffectResult = { status: "not-hit" };
                await this.#updateCard(card, state);
            }
            if (state.casterMark && !state.casterMarkResults) {
                const marked = state.targets.map((target, index) => ({ target, index }))
                    .filter(({ target }) => targetParticipates(target) && target.applicationStatus === "applied" && state.casterMark.degrees.includes(target.degree));
                const results = [];
                if (marked.length) {
                    const caster = await fromUuid(state.sourceActorUuid);
                    if (!caster) throw new Error(`${state.spellName}: the caster is missing.`);
                    // PF2e ignores a TokenMark on an actor without a token.
                    if (!(caster.getActiveTokens?.() ?? []).length) throw new Error(`${state.spellName}: the caster needs a token on the scene for PF2e's mark.`);
                    const template = await loadNativeEffectTemplate(state.casterMark.uuid);
                    const mechanics = { rules: template.system?.rules, duration: template.system?.duration, start: template.system?.start };
                    const proved = state.casterMark.kind === "strike-bonus" ? proveStrikeMark(mechanics, { value: state.casterMark.value, heightens: state.casterMark.heightens }, state.casterMark.baseRank)
                        : proveCasterMark(mechanics, state.casterMark.claimText, state.casterMark.damageType);
                    if (!sameEffectMechanics(mechanics, state.casterMark.document?.mechanics) || proved?.slug !== state.casterMark.slug)
                        throw new Error(`${state.spellName}: ${template.name} changed since it was compiled.`);
                    for (const { target, index } of marked) {
                        const token = resolvedTargets[index].token;
                        if (!token?.uuid) throw new Error(`${target.name}: PF2e's mark needs the target's token.`);
                        const source = prepareNativeEffectSource(template, { castInstanceId: state.castId, castRank: state.castRank, sourceActorUuid: state.sourceActorUuid,
                            sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, resolutionKind: "save", compilerVersion: state.compilerVersion, markedTokenUuid: token.uuid,
                            ...(state.casterMark.endsWithTargetPersistent ? { endsWithTargetPersistent: state.casterMark.endsWithTargetPersistent } : {}) });
                        source.system.rules = source.system.rules.map(rule => rule.key === "TokenMark" ? { ...rule, uuid: token.uuid } : rule);
                        const created = await createNativeEffect(caster, source);
                        createdEffects.push(created);
                        // A mark the caster can Dismiss: Ongoing spells holds it.
                        if (ongoingJournal) await this.ongoing.attach(ongoingJournal, created);
                        results.push({ targetId: target.id, targetName: target.name, name: created.name, uuid: created.uuid });
                    }
                }
                state.casterMarkResults = results;
                await this.#updateCard(card, state);
            }
            // The caster's note while a failing creature has the row's condition (Frog Tongue's penalty): one per stuck creature,
            // removed with that creature's Escape-ending Effect (linked-effect runtime).
            if (state.casterNote?.kind === "while-target-condition" && !state.casterNoteResult) {
                const caster = await fromUuid(state.sourceActorUuid);
                if (!caster) throw new Error(`${state.spellName}: the caster is missing.`);
                const results = [];
                for (const target of state.targets.filter(entry => entry.eligible !== false && state.casterNote.degrees.includes(entry.degree))) {
                    const root = createdEffects.find(effect => effect.actor?.uuid === target.actorUuid && effect.flags?.[MODULE_ID]?.outcomeEffect?.castId === state.castId
                        && effect.flags?.[MODULE_ID]?.outcomeEffect?.escape);
                    if (!root) throw new Error(`${target.name}: the ${state.casterNote.condition} Effect the caster's note depends on wasn't found.`);
                    const source = prepareSpellNoteEffectSource(state.casterNote, { text: `${state.casterNote.castText} (${target.name})`,
                        castId: state.castId, castRank: state.castRank, effectStart: state.effectStart, sourceActorUuid: state.sourceActorUuid,
                        sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, targetActorUuid: state.sourceActorUuid });
                    source.flags[MODULE_ID].runtime.endsWithEffectUuid = root.uuid;
                    const [created] = await caster.createEmbeddedDocuments("Item", [source]);
                    createdEffects.push(created);
                    if (ongoingJournal) await this.ongoing.attach(ongoingJournal, created);
                    results.push({ name: created.name, uuid: created.uuid, targetName: target.name });
                }
                state.casterNoteResult = { name: results.map(result => result.name).join(", ") || "none", uuid: results[0]?.uuid ?? null, count: results.length };
                await this.#updateCard(card, state);
            }
            // The caster's condition while each possessed creature holds this cast's note (Possession): removed with that note.
            if (state.casterNote?.kind === "while-target-note" && !state.casterNoteResult) {
                const caster = await fromUuid(state.sourceActorUuid);
                if (!caster) throw new Error(`${state.spellName}: the caster is missing.`);
                const results = [];
                for (const target of state.targets.filter(entry => entry.eligible !== false && state.casterNote.degrees.includes(entry.degree))) {
                    const root = createdEffects.find(effect => effect.actor?.uuid === target.actorUuid && effect.flags?.[MODULE_ID]?.runtime?.kind === "note-effect"
                        && effect.flags?.[MODULE_ID]?.runtime?.castInstanceId === state.castId && /Possessed|Possessing/.test(effect.name));
                    if (!root) throw new Error(`${target.name}: the note the caster's condition depends on wasn't found.`);
                    const source = prepareSpellNoteEffectSource(state.casterNote, { text: `${state.casterNote.castText} (${target.name})`,
                        castId: state.castId, castRank: state.castRank, effectStart: state.effectStart, sourceActorUuid: state.sourceActorUuid,
                        sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, targetActorUuid: state.sourceActorUuid });
                    source.flags[MODULE_ID].runtime.endsWithEffectUuid = root.uuid;
                    const [created] = await caster.createEmbeddedDocuments("Item", [source]);
                    createdEffects.push(created);
                    if (ongoingJournal) await this.ongoing.attach(ongoingJournal, created);
                    results.push({ name: created.name, uuid: created.uuid, targetName: target.name });
                }
                state.casterNoteResult = { name: results.map(result => result.name).join(", ") || "none", uuid: results[0]?.uuid ?? null, count: results.length };
                await this.#updateCard(card, state);
            }
            if (state.casterNote && !["while-target-condition", "while-target-note"].includes(state.casterNote.kind) && !state.casterNoteResult) {
                const caster = await fromUuid(state.sourceActorUuid);
                if (!caster) throw new Error(`${state.spellName}: the caster is missing.`);
                const [created] = await caster.createEmbeddedDocuments("Item", [prepareSpellNoteEffectSource(state.casterNote, { text: state.casterNote.castText,
                    castId: state.castId, castRank: state.castRank, effectStart: state.effectStart, sourceActorUuid: state.sourceActorUuid,
                    sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, targetActorUuid: state.sourceActorUuid })]);
                createdEffects.push(created);
                state.casterNoteResult = { name: created.name, uuid: created.uuid };
                await this.#updateCard(card, state);
            }
            // "These cuts are superficial and cause 1d4 slashing damage to you": once for the cast, with the caster's own IWR.
            if (state.damage?.casterDamage && !state.casterDamageResult) {
                const caster = await fromUuid(state.sourceActorUuid);
                const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
                if (!caster || !DamageRoll) throw new Error(`${state.spellName}: the caster or PF2e's damage roll is unavailable for the caster's own damage.`);
                const roll = await new DamageRoll(`${state.damage.casterDamage.formula}[${state.damage.casterDamage.type}]`).evaluate();
                try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(state.spellName)}</strong>: the caster's own damage`,
                    flags: { [MODULE_ID]: { kind: "caster-damage", castId: state.castId } } }); } catch (_) {}
                damageApplied = true;
                const receipt = await applyDamageWithReceipt(caster, { damage: roll, token: caster.getActiveTokens?.(false, true)?.[0] ?? undefined, skipIWR: false, rollOptions: new Set() }, randomID());
                state.casterDamageResult = { formula: roll.formula, total: roll.total, damage: receipt.damage };
                await this.#updateCard(card, state);
            }
            if (state.casterBenefit) {
                damageApplied = true;
                state.casterBenefitResult = await applyCasterBenefit(state, ongoingJournal, this.ongoing, createdEffects);
                await this.#updateCard(card, state);
            }
            // (Targeted Ward: the caster's status bonus to the chosen defense against each opponent, by its row — one more from the heightened rank — for the spell's
            // rounds; the one-action version's behind its toggle.)
            if (state.casterWard && !state.casterWardResult) {
                damageApplied = true;
                const caster = await fromUuid(state.sourceActorUuid);
                if (!caster) throw new Error(`${state.spellName}: the caster is unavailable for its ward.`);
                const ward = state.casterWard, results = [];
                for (const target of state.targets.filter(entry => targetParticipates(entry) && entry.applicationStatus === "applied")) {
                    const opponent = await fromUuid(target.actorUuid);
                    const value = Number(ward.byDegree[target.degree] ?? 0) + (Number(state.castRank) >= ward.heightened.rank ? ward.heightened.add : 0);
                    if (!opponent || value <= 0) { results.push({ name: target.name, value: 0 }); continue; }
                    const choices = [["AC", "ac"], ["Fortitude saves", "fortitude"], ["Reflex saves", "reflex"], ["Will saves", "will"]].map(([label, value]) => ({ label, value }));
                    const rules = [{ key: "ChoiceSet", flag: "defense", prompt: `${state.spellName}: the defense against ${opponent.name}`, choices, ...(ward.defense ? { selection: ward.defense } : {}) },
                        ...(ward.toggle ? [{ key: "RollOption", domain: "all", option: "targeted-ward-action", toggleable: true, label: `${opponent.name} uses the chosen action`, value: false }] : []),
                        { key: "FlatModifier", selector: "{item|flags.system.rulesSelections.defense}", type: "status", value, label: state.spellName,
                            predicate: [`origin:signature:${opponent.signature}`, ...(ward.toggle ? ["targeted-ward-action"] : [])] }];
                    const [effect] = await caster.createEmbeddedDocuments("Item", [{ name: `${state.spellName} (${opponent.name})`, type: "effect", img: "icons/svg/shield.svg",
                        flags: { [MODULE_ID]: { outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, casterWard: true } } },
                        system: { duration: { value: Math.max(1, Math.round(ward.seconds / 6)), unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: state.effectStart.value, initiative: state.effectStart.initiative },
                            description: { value: `<p>+${value} status bonus to the chosen defense against ${escapeHTML(opponent.name)}.${ward.toggle ? " Switch it on when that opponent uses the action you focused on." : ""}</p>${ward.note ? `<p>${escapeHTML(ward.note)}</p>` : ""}` },
                            rules } }]);
                    if (effect) createdEffects.push(effect);
                    results.push({ name: target.name, value, effectUuid: effect?.uuid ?? null });
                }
                state.casterWardResult = results;
                await this.#updateCard(card, state);
            }
            // "You are Stunned 1 and the spell ends.": the caster's condition, once for the cast (raised to the stated value).
            const casterRows = state.targets.filter(target => targetParticipates(target) && target.applicationStatus === "applied")
                .flatMap(target => outcomeForTarget(state, target)?.casterConditions ?? []);
            if (casterRows.length && !state.casterConditionResult) {
                damageApplied = true;
                const caster = await fromUuid(state.sourceActorUuid);
                if (!caster) throw new Error(`${state.spellName}: the caster is unavailable for its condition.`);
                const labels = [];
                for (const entry of casterRows.filter((entry, index, all) => all.findIndex(other => other.slug === entry.slug) === index)) {
                    // (A timed one — "You are Confused for 1 round." — is an Effect granting it for that time.)
                    if (entry.duration) {
                        const [effect] = await caster.createEmbeddedDocuments("Item", [{ name: `${state.spellName}: ${entry.slug[0].toUpperCase()}${entry.slug.slice(1)}${entry.value == null ? "" : ` ${entry.value}`}`, type: "effect", img: "icons/svg/downgrade.svg",
                            flags: { [MODULE_ID]: { outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, casterCondition: true, conditions: [] } } },
                            system: { duration: { value: entry.duration.value, unit: entry.duration.unit, expiry: entry.duration.expiry, sustained: false },
                                start: { value: state.effectStart.value, initiative: state.effectStart.initiative }, context: { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: caster.uuid }, roll: null },
                                description: { value: `<p>${escapeHTML(entry.sourceText)}</p>` },
                                rules: [{ key: "GrantItem", uuid: entry.uuid, onDeleteActions: { grantee: "restrict" }, ...(entry.value == null ? {} : { alterations: [{ mode: "override", property: "badge-value", value: entry.value }] }) }] } }]);
                        if (effect) createdEffects.push(effect);
                        labels.push(`${entry.slug[0].toUpperCase()}${entry.slug.slice(1)}${entry.value == null ? "" : ` ${entry.value}`} for ${entry.duration.value} ${entry.duration.value === 1 ? entry.duration.unit.replace(/s$/, "") : entry.duration.unit}`);
                        continue;
                    }
                    const current = caster.getCondition?.(entry.slug)?.value ?? (caster.hasCondition?.(entry.slug) ? 1 : 0);
                    const wanted = entry.value ?? 1;
                    if (entry.value == null ? !caster.hasCondition?.(entry.slug) : current < wanted) await caster.increaseCondition(entry.slug, entry.value == null ? {} : { value: wanted - current });
                    labels.push(`${entry.slug[0].toUpperCase()}${entry.slug.slice(1)}${entry.value == null ? "" : ` ${caster.getCondition?.(entry.slug)?.value ?? wanted}`}`);
                }
                state.casterConditionResult = { labels, endsSpell: state.targets.some(target => targetParticipates(target) && target.applicationStatus === "applied" && outcomeForTarget(state, target)?.endsSpell === true) };
                await this.#updateCard(card, state);
            }
            // The minion the spell destroyed is slain (PF2e's Dead status).
            if (state.sacrifice?.pick === "minion" && state.sacrifice.selected && !state.sacrificeResult) {
                damageApplied = true;
                const minion = await fromUuid(state.sacrifice.selected);
                if (minion?.actor && !minion.actor.statuses?.has?.("dead")) await minion.actor.toggleStatusEffect("dead", { active: true });
                state.sacrificeResult = { name: state.sacrifice.selectedName, dead: !!minion?.actor?.statuses?.has?.("dead") };
            }
            // Bony Barrage's bone armor: +N status to AC until the start of the caster's next turn, for the caster and its allies in the area.
            if (state.boneArmor?.answer === "yes" && !state.boneArmorResult) {
                damageApplied = true;
                const caster = await fromUuid(state.sourceActorUuid);
                const holders = [caster, ...(await Promise.all(state.targets.filter(target => target.boneArmor).map(async target => (await resolveTargetDocuments(target)).actor)))]
                    .filter((actor, index, all) => actor && all.findIndex(other => other?.uuid === actor.uuid) === index);
                const initiative = game.combat?.combatants.find(combatant => combatant.actor === caster)?.initiative ?? null;
                for (const actor of holders) {
                    const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${state.spellName}: bone armor`, type: "effect", img: "icons/svg/shield.svg",
                        flags: { [MODULE_ID]: { outcomeEffect: { castId: state.castId, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, conditions: [] } } },
                        system: { duration: { value: 1, unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative },
                            context: { origin: { actor: state.sourceActorUuid, item: state.sourceItemUuid }, target: { actor: actor.uuid }, roll: null },
                            rules: [{ key: "FlatModifier", selector: "ac", type: "status", value: state.boneArmor.ac, label: state.spellName }] } }]);
                    if (effect) createdEffects.push(effect);
                }
                state.boneArmorResult = { holders: holders.map(actor => actor.name) };
            }
            // (Defy the Gods: only for a target of the stated traits.)
            const traitHolder = target => !state.casterRowEffect.traits || state.casterRowEffect.traits.some(trait => fromUuidSync(target.actorUuid)?.traits?.has?.(trait));
            if (state.casterRowEffect && state.targets.some(target => targetParticipates(target) && state.casterRowEffect.degrees.includes(target.degree) && traitHolder(target)) && !state.casterRowEffectResult) {
                damageApplied = true;
                state.casterRowEffectResult = await applyCasterRowEffect(state, createdEffects);
                await this.#updateCard(card, state);
            }
            if (state.killEffect && state.targets.some(target => target.killedByRow) && !state.killEffectResult) {
                damageApplied = true;
                state.killEffectResult = await applyKillEffect(state, createdEffects);
                await this.#updateCard(card, state);
            }
            if (this.ongoing?.hasSave(card.id)) {
                damageApplied = true;
                await this.ongoing.finalizeSave(card, state);
            }
            // The hazard in each qualifying target's squares (“On any result other than a critical failure, the ground … catches fire”).
            if (state.groundHazard) for (let index = 0; index < state.targets.length; index++) {
                const target = state.targets[index];
                if (!target.degree || !state.groundHazard.degrees.includes(target.degree) || target.groundHazard) continue;
                try {
                    if (!this.ongoing) throw new Error("ongoing spell tracking is unavailable");
                    const placed = await this.ongoing.startGroundHazard({ hazard: state.groundHazard, castId: state.castId, spellName: state.spellName,
                        sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, castRank: state.castRank,
                        targetActorUuid: target.actorUuid, targetTokenUuid: resolvedTargets[index]?.token?.uuid ?? null });
                    target.groundHazard = { status: "placed", regionUuid: placed.regionUuid };
                } catch (error) {
                    target.groundHazard = { status: "failed", reason: error.message };
                    console.warn(`${MODULE_ID} | ${state.spellName}: the hazard region could not be placed.`, error);
                }
                await this.#updateCard(card, state);
            }
            // "When a secondary target becomes slowed, it remains slowed as long as the spell is sustained" (Infectious Ennui at 5th): the spread's
            // conditions are attached to the original cast too, so they end when it does.
            if (state.parentCastId && this.ongoing && !state.parentAttached) {
                // (In the Ongoing queue, so the original cast's own reconcile can't overwrite the entries.)
                const effects = createdEffects.filter(effect => (effect.flags?.[MODULE_ID]?.outcomeEffect?.conditions ?? []).length);
                await this.ongoing.enqueue(async () => {
                    const parent = this.ongoing.find(state.parentCastId);
                    if (parent && Object.values(parent.flags?.[MODULE_ID] ?? {}).some(record => record?.castId === state.parentCastId && record.status === "active"))
                        for (const effect of effects) await this.ongoing.attach(parent, effect);
                });
                state.parentAttached = true;
            }
            // A save repeated on each Sustain (the Witches+ hexes): a result that ends the spell closes the cast's repeats.
            if (state.sourceMessageId && !state.repeatEnded && state.targets.some(target => targetParticipates(target) && outcomeForTarget(state, target)?.endsRepeat === true)) {
                const cast = game.messages.get(state.sourceMessageId);
                if (cast) await cast.setFlag(MODULE_ID, "repeatWindow", { ...(cast.getFlag(MODULE_ID, "repeatWindow") ?? {}), ended: true }).catch(() => null);
                state.repeatEnded = true;
            }
            // Forced movement the module carries out (forced-movement.js): a push or pull with its direction and distance, a rise, a safe fall. The
            // caster's choices (up to, any direction, an action count, a creature that may fall Prone instead) stay the GM's.
            if (!state.forcedApplied) {
                // ("All Medium or smaller creatures that are adjacent to the line are pulled to the nearest unoccupied space within the line": the targeted
                // creatures outside it, before the pushes.)
                if (state.areaPullIn) {
                    const area = state.sourceMessageId ? canvas.scene?.regions.find(entry => entry.flags?.pf2e?.messageId === state.sourceMessageId)?.shapes?.map(shape => shape.toObject?.() ?? shape) : null;
                    const ORDER = ["tiny", "sm", "med", "lg", "huge", "grg"];
                    for (const [index, target] of state.targets.entries()) {
                        if (!targetParticipates(target) || !area) continue;
                        const doc = resolvedTargets[index]?.token?.document ?? resolvedTargets[index]?.token ?? null;
                        const size = doc?.actor?.size ?? doc?.actor?.system?.traits?.size?.value ?? "med";
                        if (!doc || (state.areaPullIn.maxSize && ORDER.indexOf(size) > ORDER.indexOf(state.areaPullIn.maxSize))) continue;
                        try { target.pulledIn = await moveToFreeSpace(doc, { inside: area, reason: state.spellName }); } catch (error) { target.pulledIn = { moved: false, reason: error.message }; }
                    }
                }
                for (const [index, target] of state.targets.entries()) {
                    if (!targetParticipates(target) || target.applicationStatus !== "applied" || !target.degree) continue;
                    const move = outcomeForTarget(state, target)?.forcedMovement;
                    if (!move) continue;
                    try { target.forcedMoved = await carryOutForcedMovement(state, target, move, resolvedTargets[index]?.token ?? null); }
                    catch (error) { target.forcedMoved = { moved: false, error: error.message }; }
                }
                // (Stone Lance: "if the creature is on the ground" — a creature above the ground keeps no Immobilized from this cast.)
                if (state.groundOnly) for (const [index, target] of state.targets.entries()) {
                    const doc = resolvedTargets[index]?.token?.document ?? resolvedTargets[index]?.token ?? null;
                    if (!targetParticipates(target) || !doc || !(Number(doc.elevation ?? 0) > 0)) continue;
                    const actor = await fromUuid(target.actorUuid).catch(() => null);
                    for (const effect of actor?.itemTypes?.effect ?? []) {
                        const rules = effect.system?.rules ?? [];
                        const kept = rules.filter(rule => !(rule.key === "GrantItem" && rule.uuid === state.groundOnly.uuid));
                        if (kept.length === rules.length || (effect.flags?.[MODULE_ID]?.outcomeEffect?.castId ?? effect.flags?.[MODULE_ID]?.runtime?.castInstanceId) !== state.castId) continue;
                        await effect.update({ "system.rules": kept });
                        // (The condition the rule had granted goes too.)
                        const granted = (actor.itemTypes?.condition ?? []).filter(condition => condition.slug === state.groundOnly.slug && condition.flags?.pf2e?.grantedBy?.id === effect.id).map(condition => condition.id);
                        if (granted.length) await actor.deleteEmbeddedDocuments("Item", granted).catch(() => null);
                        target.groundOnly = { removed: state.groundOnly.slug };
                    }
                }
                // (Vacuum: a creature that critically fails is suffocating — the Suffocating Effect's turn-end Fortitude save, PF2e's suffocation.)
                for (const [index, target] of state.targets.entries()) {
                    const suffocate = targetParticipates(target) && target.applicationStatus === "applied" ? outcomeForTarget(state, target)?.suffocate : null;
                    if (!suffocate) continue;
                    const actor = await fromUuid(target.actorUuid).catch(() => null);
                    if (!actor || actor.itemTypes.effect.some(effect => effect.flags?.[MODULE_ID]?.runtime?.turnEndSave?.suffocation)) continue;
                    const [made] = await actor.createEmbeddedDocuments("Item", [{ name: `${state.spellName}: Suffocating`, type: "effect", img: "icons/svg/skull.svg",
                        flags: { [MODULE_ID]: { runtime: { schema: 1, sourceItemName: state.spellName, turnEndSave: { statistic: suffocate.statistic, dc: suffocate.dc, suffocation: { dcStep: suffocate.dcStep, die: suffocate.die, turns: 0 } } } } },
                        system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
                            description: { value: `<p>Suffocating: at the end of each of its turns a DC ${suffocate.dc} Fortitude save (+${suffocate.dcStep} each later turn); failure 1d${suffocate.die} damage (+1d${suffocate.die} each later turn), critical failure death. Remove this Effect when it can breathe again.</p>` } } }]);
                    target.suffocating = made?.uuid ?? null;
                }
                if (state.areaExit && (state.exitArea || !state.lingeringCastId)) {
                    const area = state.exitArea ?? (state.sourceMessageId ? canvas.scene?.regions.find(entry => entry.flags?.pf2e?.messageId === state.sourceMessageId)?.shapes?.map(shape => shape.toObject?.() ?? shape) : null);
                    for (const [index, target] of state.targets.entries()) {
                        if (!targetParticipates(target) || target.applicationStatus !== "applied" || !target.degree) continue;
                        if (state.areaExit.who === "success" && !["success", "criticalSuccess"].includes(target.degree)) continue;
                        const doc = resolvedTargets[index]?.token?.document ?? resolvedTargets[index]?.token ?? null;
                        if (!doc || (!area && !state.areaExit.adjacent)) { target.areaExited = { moved: false, reason: area ? "no token" : "the area isn't on the scene" }; continue; }
                        try { target.areaExited = await moveToFreeSpace(doc, { outside: state.areaExit.adjacent ? null : area, adjacentOnly: !!state.areaExit.adjacent, reason: state.spellName }); }
                        catch (error) { target.areaExited = { moved: false, reason: error.message }; }
                    }
                }
                state.forcedApplied = true;
                await this.#updateCard(card, state);
            }
            // Spellshape feats and wands: their riders on each creature, after the spell's own outcome (spellshape-runtime.js).
            if (state.shapeRiders?.length && !state.shapeApplied) {
                const shaped = [];
                for (const [index, target] of state.targets.entries()) {
                    if (!targetParticipates(target) || target.applicationStatus !== "applied") continue;
                    const actor = await fromUuid(target.actorUuid);
                    if (!actor) continue;
                    shaped.push({ target, actor, token: resolvedTargets[index]?.token ?? null });
                    try { target.conditionResults = [...(target.conditionResults ?? []), ...await applyShapeRiders(state, target, actor, resolvedTargets[index]?.token ?? null, { DamageRoll, multiplier: damageMultiplierForTarget(state, target) })]; }
                    catch (error) { target.conditionResults = [...(target.conditionResults ?? []), { label: `Spellshape riders: ${error.message}`, status: "failed" }]; }
                }
                try { state.shapeResults = await finishShapeRiders(state, shaped); }
                catch (error) { state.shapeResults = [{ label: `Spellshape riders: ${error.message}`, status: "failed" }]; }
                state.shapeApplied = true;
                await this.#updateCard(card, state);
            }
            // A wand's watch on the spell's damage (Wand of Toxic Blades: the damaged creatures exposed to its poison, once per turn).
            if (!state.watchApplied && state.targets.some(target => (target.damageResults ?? []).some(result => Number(result.receipt?.damage ?? 0) > 0))) {
                state.watchApplied = true;
                const damaged = [];
                for (const [index, target] of state.targets.entries()) {
                    if (!targetParticipates(target) || target.applicationStatus !== "applied") continue;
                    const actor = await fromUuid(target.actorUuid).catch(() => null);
                    if (actor) damaged.push({ actor, token: resolvedTargets[index]?.token ?? null, damaged: (target.damageResults ?? []).reduce((total, result) => total + Number(result.receipt?.damage ?? 0), 0) > 0 });
                }
                try { const watched = await shapeWatchSave(state, damaged); if (watched.length) { state.shapeResults = [...(state.shapeResults ?? []), ...watched]; await this.#updateCard(card, state); } }
                catch (error) { console.warn(`${MODULE_ID} | A wand's watch failed.`, error); }
            }
            if (ongoingJournal && !parentJournal) await this.ongoing.activate(ongoingJournal);
            // "In addition, unless the initial target critically succeeds, creatures within 30 feet of the target … must attempt … saves" (Grisly
            // Growths): a card starts that save for the creatures within the distance of the target.
            if (state.popSave && !state.popSave.posted) {
                const primary = state.targets.find(target => targetParticipates(target) && target.actorUuid !== state.sourceActorUuid);
                const left = primary ? Number(state.popSave.uses[primary.degree] ?? 0) : 0;
                if (left > 0) {
                    const seconds = state.lifecycle?.durationSpec?.mode === "fixed" ? Number(state.lifecycle.durationSpec.value) * ({ rounds: 6, minutes: 60, hours: 3600 }[state.lifecycle.durationSpec.unit] ?? 0) : 60;
                    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(state.sourceActorUuid) }), flags: { [MODULE_ID]: { popSave: { plan: state.popSave.plan,
                        spellUuid: state.sourceItemUuid, sourceActorUuid: state.sourceActorUuid, castRank: state.castRank, dc: state.dc, targetTokenUuid: primary.tokenUuid, noun: state.popSave.noun,
                        left, expiresAt: game.time.worldTime + (seconds || 60) } } },
                        content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(state.spellName)} — ${escapeHTML(state.popSave.noun)}s</strong></header><p>${escapeHTML(primary.name)} has ${left} ${escapeHTML(state.popSave.noun)}${left === 1 ? "" : "s"}. Pop one (a single action): target ${escapeHTML(primary.name)} and the creatures in the cone, then press the button.</p><button type="button" class="pf2e-auto-pop-save"><i class="fa-solid fa-burst"></i> Pop a ${escapeHTML(state.popSave.noun)}</button></section>` }); }
                    catch (error) { console.warn(`${MODULE_ID} | The pop card could not be posted.`, error); }
                }
                state.popSave.posted = true;
                await this.#updateCard(card, state);
            }
            if (state.areaFollowUp && !state.areaFollowUp.posted) {
                const primary = state.targets.find(target => targetParticipates(target) && target.actorUuid !== state.sourceActorUuid);
                if (primary && !state.areaFollowUp.unless.includes(primary.degree)) {
                    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(state.sourceActorUuid) }), flags: { [MODULE_ID]: { areaFollowUp: { plan: state.areaFollowUp.plan,
                        spellUuid: state.sourceItemUuid, sourceActorUuid: state.sourceActorUuid, castRank: state.castRank, dc: state.dc, centreTokenUuid: primary.tokenUuid, radius: state.areaFollowUp.radius,
                        ...(state.areaFollowUp.outer ? { outer: state.areaFollowUp.outer, excludeCentre: true, needsInner: true } : {}), used: false } } },
                        content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(state.spellName)} — around the target</strong></header><p>${state.areaFollowUp.outer ? `${escapeHTML(primary.name)} failed: the other creatures within ${state.areaFollowUp.radius} feet of it save, and those within ${state.areaFollowUp.outer.radius} feet take half (only if one is within ${state.areaFollowUp.radius} feet).` : `${escapeHTML(primary.name)} didn't critically succeed: the creatures within ${state.areaFollowUp.radius} feet of it, including it, save.`}</p><button type="button" class="pf2e-auto-area-follow-up"><i class="fa-solid fa-circle-dot"></i> Start their saves</button></section>` }); }
                    catch (error) { console.warn(`${MODULE_ID} | The follow-up card could not be posted.`, error); }
                }
                state.areaFollowUp.posted = true;
                await this.#updateCard(card, state);
            }
            // "At the start of the target's turn, choose one creature within 30 feet of the target to attempt a Will save as well" (Infectious Ennui): one card
            // for the cast when a target took a spreading result, pressed at each of the target's turns with the new creature targeted; its own plan (the
            // heightened one at its rank), immune to this casting only.
            if (state.chainSave?.spreadPlan && !state.chainSave.posted) {
                const from = state.targets.find(target => targetParticipates(target) && state.chainSave.degrees.includes(target.degree));
                if (from) {
                    const plan = clone(state.chainSave.heightened && state.castRank >= state.chainSave.heightened.rank ? state.chainSave.heightened.plan : state.chainSave.spreadPlan);
                    plan.resolution.temporaryImmunity = { ...plan.resolution.temporaryImmunity, key: `${plan.resolution.temporaryImmunity.key}:${state.castId}` };
                    const attach = !!(state.chainSave.heightened && state.castRank >= state.chainSave.heightened.rank && state.chainSave.heightened.whileSustained);
                    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(state.sourceActorUuid) }), flags: { [MODULE_ID]: { chainSave: { plan,
                        spellUuid: state.sourceItemUuid, sourceActorUuid: state.sourceActorUuid, castRank: state.castRank, dc: state.dc, fromName: from.name, used: false, repeatable: true,
                        ...(attach ? { parentCastId: state.castId } : {}) } } },
                        content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(state.spellName)} — ${escapeHTML(state.chainSave.label)}</strong></header><p>At the start of each of ${escapeHTML(from.name)}'s turns while the spell lasts: target one ${escapeHTML(state.chainSave.label)}, then start its save.</p><button type="button" class="pf2e-auto-chain-save"><i class="fa-solid fa-link"></i> Start its save</button></section>` }); }
                    catch (error) { console.warn(`${MODULE_ID} | The spread card could not be posted.`, error); }
                }
                state.chainSave.posted = true;
                await this.#updateCard(card, state);
            }
            if (state.chainSave && !state.chainSave.posted && state.chainSave.perCast) {
                // (One card for the cast, pressed on each Sustain; the newcomers' own saves post none.)
                const plan = clone(state.chainSave.plan); delete plan.resolution.chainSave;
                try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(state.sourceActorUuid) }), flags: { [MODULE_ID]: { chainSave: { plan,
                    spellUuid: state.sourceItemUuid, sourceActorUuid: state.sourceActorUuid, castRank: state.castRank, dc: state.dc, fromName: state.spellName, repeatable: true, used: false } } },
                    content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(state.spellName)} — ${escapeHTML(state.chainSave.label)}</strong></header><p>When you Sustain the spell: target the ${escapeHTML(state.chainSave.label)}, then start their saves.</p><button type="button" class="pf2e-auto-chain-save"><i class="fa-solid fa-link"></i> Start their saves</button></section>` }); }
                catch (error) { console.warn(`${MODULE_ID} | The newcomers' card could not be posted.`, error); }
                state.chainSave.posted = true;
                await this.#updateCard(card, state);
            }
            if (state.chainSave && !state.chainSave.posted) {
                for (const target of state.targets.filter(target => targetParticipates(target) && state.chainSave.degrees.includes(target.degree))) {
                    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(state.sourceActorUuid) }), flags: { [MODULE_ID]: { chainSave: { plan: state.chainSave.plan,
                        spellUuid: state.sourceItemUuid, sourceActorUuid: state.sourceActorUuid, castRank: state.castRank, dc: state.dc, fromName: target.name, used: false,
                        ...(state.chainSave.repeatable ? { repeatable: true } : {}) } } },
                        content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(state.spellName)} — ${escapeHTML(target.name)}'s ${escapeHTML(state.chainSave.label)}</strong></header><p>${escapeHTML(target.name)} was affected: target its ${escapeHTML(state.chainSave.label)}, then start their saves.</p><button type="button" class="pf2e-auto-chain-save"><i class="fa-solid fa-link"></i> Start their saves</button></section>` }); }
                    catch (error) { console.warn(`${MODULE_ID} | The chained-save card could not be posted.`, error); }
                }
                state.chainSave.posted = true;
                await this.#updateCard(card, state);
            }
            // "You also gain temporary Hit Points equal to half the damage a single creature took when you Sustained the spell this turn" (Sanguine
            // Mist): each Sustain exposure card offers its most; the caster keeps the higher amount (PF2e's TempHP rule on a timed Effect).
            if (state.casterSiphon && state.lingeringCastId) {
                const most = Math.max(0, ...state.targets.filter(targetParticipates).map(target => (target.damageResults ?? []).reduce((sum, entry) => sum + Math.max(0, Number(entry.receipt?.damage ?? 0)), 0)));
                const amount = Math.floor(most * state.casterSiphon.fraction);
                const caster = await fromUuid(state.sourceActorUuid);
                const held = (caster?.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.casterSiphon?.castId === state.lingeringCastId);
                if (caster && amount > Number(held?.flags?.[MODULE_ID]?.casterSiphon?.amount ?? 0)) {
                    if (held) await held.delete();
                    const source = prepareNoteEffectSource({ label: "temporary Hit Points", text: `${amount} temporary Hit Points (half the most a creature took when you Sustained the spell); any remaining are lost when this ends.`,
                        sourceText: state.casterSiphon.sourceText, duration: { mode: "fixed", ...state.casterSiphon.lasts } },
                        { castId: state.castId, castRank: state.castRank, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: state.spellName, targetActorUuid: caster.uuid });
                    source.system.rules = [{ key: "TempHP", value: amount }];
                    source.flags[MODULE_ID].casterSiphon = { castId: state.lingeringCastId, amount };
                    await caster.createEmbeddedDocuments("Item", [source]);
                    state.casterSiphon.granted = amount;
                    await this.#updateCard(card, state);
                }
            }
            // Dynamic Vampiric Feast's one action ("The next time you Cast a Spell before the end of your next turn, you gain temporary Hit Points equal to half the
            // damage a single creature takes from this spell … to a maximum of 5 × rank"): the caster's marker, read once by its next damaging spell's card.
            if (!state.vampiricNextApplied) {
                const caster = await fromUuid(state.sourceActorUuid);
                const marker = (caster?.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.runtime?.vampiricNext && !effect.isExpired && effect.flags[MODULE_ID].runtime.castInstanceId !== state.castId);
                const most = Math.max(0, ...state.targets.filter(targetParticipates).map(target => (target.damageResults ?? []).reduce((sum, entry) => sum + Math.max(0, Number(entry.receipt?.damage ?? 0)), 0)));
                if (marker && most > 0) {
                    const data = marker.flags[MODULE_ID].runtime.vampiricNext;
                    const amount = Math.min(Number(data.cap), Math.floor(most * Number(data.fraction)));
                    const source = prepareNoteEffectSource({ label: "temporary Hit Points", text: `${amount} temporary Hit Points (half the most a creature took from ${state.spellName}, at most ${data.cap}); any remaining are lost when this ends.`,
                        sourceText: data.sourceText, duration: { mode: "fixed", value: Number(data.rounds), unit: "rounds", expiry: "turn-start" } },
                        { castId: state.castId, castRank: state.castRank, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, sourceItemName: data.spellName, targetActorUuid: caster.uuid });
                    source.system.rules = [{ key: "TempHP", value: amount }];
                    await caster.createEmbeddedDocuments("Item", [source]);
                    await marker.delete();
                    state.vampiricNextApplied = amount;
                    await this.#updateCard(card, state);
                }
            }
            // The spell's damage again at the end of each of the caster's turns, for each creature that failed (Positive Attunement).
            if (state.turnHazard && this.ongoing && state.damage?.rollJSON) for (const [index, target] of state.targets.entries()) {
                const multiplier = targetParticipates(target) ? state.turnHazard.multipliers?.[target.degree] : null;
                const token = resolvedTargets[index]?.token;
                if (!multiplier || !token || target.turnHazard) continue;
                try {
                    const started = await this.ongoing.startTurnHazard({ spellName: state.spellName, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, castRank: state.castRank,
                        targetTokenUuid: token.uuid, formula: String(state.damage.formula ?? "").replace(new RegExp(`\\s*${state.turnHazard.type}$`), ""), type: state.turnHazard.type, multiplier,
                        events: state.turnHazard.events, sustained: state.turnHazard.sustained === true, durationSeconds: state.turnHazard.durationSeconds, note: state.turnHazard.sourceText });
                    target.turnHazard = { status: "started", castId: started.castId, multiplier };
                } catch (error) {
                    target.turnHazard = { status: "failed", reason: error.message };
                    console.warn(`${MODULE_ID} | ${state.spellName}: the turn-end damage could not be tracked.`, error);
                }
                await this.#updateCard(card, state);
            }
            // The additional save at the end of each of its turns, for each creature now taking the spell's persistent damage.
            if (state.followUpSave && this.ongoing) for (const [index, target] of state.targets.entries()) {
                if (!targetParticipates(target) || !target.degree) continue;
                const token = resolvedTargets[index]?.token, actor = resolvedTargets[index]?.actor ?? (token?.actor ?? null);
                if (!token || !actor || !hasPersistentDamage(actor, state.followUpSave.damageType)) continue;
                try {
                    const started = await this.ongoing.startFollowUpSave({ spellName: state.spellName, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid,
                        castRank: state.castRank, dc: state.dc, targetTokenUuid: token.uuid, followUp: state.followUpSave });
                    target.followUpSave = { status: "started", castId: started.castId };
                } catch (error) {
                    target.followUpSave = { status: "failed", reason: error.message };
                    console.warn(`${MODULE_ID} | ${state.spellName}: the additional save could not be tracked.`, error);
                }
                await this.#updateCard(card, state);
            }
            // An impossible spell: the creatures it damaged are marked (Fuel in Ongoing spells); the caster carries the lethologic mark.
            if (state.impossibleBurst && !state.impossibleMarked) {
                const damaged = [];
                for (const [index, target] of state.targets.entries()) {
                    if (!targetParticipates(target) || !Number.isFinite(Number(target.hpBefore)) || !Number.isFinite(Number(target.hpAfter)) || Number(target.hpAfter) >= Number(target.hpBefore)) continue;
                    const actor = resolvedTargets[index]?.actor ?? resolvedTargets[index]?.token?.actor;
                    if (actor) damaged.push(actor);
                }
                const caster = await fromUuid(state.sourceActorUuid), spell = await castSpellFromUuid(state);
                const started = await startImpossibleMarks(this.ongoing, { spellName: state.spellName, spellSlug: spell?.slug ?? state.spellName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                    sourceActor: caster, sourceItemUuid: state.sourceItemUuid, castRank: state.castRank, img: spell?.img, impossible: state.impossibleBurst, damaged, durationSeconds: 60 });
                state.impossibleMarked = started;
            }
            // Falling Sky: each creature above the ground drops to it and takes the fall (whatever its save).
            if (state.areaFall && !state.areaFallResult) {
                damageApplied = true;
                state.areaFallResult = await applyAreaFall(state);
                await this.#updateCard(card, state);
            }
            // Massacre: when the card kills no creature, the stated damage turns back — to every living creature on the card (those the level left
            // out too) and to the caster.
            if (state.backlash && !state.backlashResult) {
                damageApplied = true;
                state.backlashResult = await applyBacklash(state);
                await this.#updateCard(card, state);
            }
            state.status = "completed";
            await this.#updateCard(card, state);
            // Fateful Condemnation: the aura around each target its row names — a region following its token; the rule on it and its allies inside.
            if (state.targetAura && !state.targetAuraResults) {
                const results = [];
                for (const [index, target] of state.targets.entries()) {
                    const entry = state.targetAura.byDegree[target.degree];
                    const token = resolvedTargets[index]?.token ?? null, actor = resolvedTargets[index]?.actor ?? token?.actor ?? null;
                    if (!targetParticipates(target) || !entry || !token || !actor || !this.ongoing?.startRegionArea) continue;
                    const doc = token.document ?? token, size = canvas.grid.size, pixels = (entry.radius ?? state.targetAura.radius) / canvas.dimensions.distance * size + Number(doc.width ?? 1) * size / 2;
                    const centre = { x: doc.x + Number(doc.width ?? 1) * size / 2, y: doc.y + Number(doc.height ?? 1) * size / 2 };
                    const [region] = await canvas.scene.createEmbeddedDocuments("Region", [{ name: `${state.spellName}: around ${actor.name}`, color: "#8866aa",
                        shapes: [{ type: "circle", x: centre.x, y: centre.y, radius: pixels }], flags: { [MODULE_ID]: { followToken: doc.uuid, followShape: "emanation", followRadius: pixels } } }]);
                    const started = await this.ongoing.startRegionArea({ spellName: state.spellName, sourceActorUuid: state.sourceActorUuid, sourceItemUuid: state.sourceItemUuid, castRank: state.castRank, region,
                        durationSeconds: entry.seconds ?? state.targetAura.seconds, followToken: doc.uuid, seedMembers: true, notes: entry.untilLifted ? [`${entry.label} around ${actor.name}: until the curse is lifted (end it in Ongoing spells then).`] : [],
                        ...(entry.rules.length ? { memberEffect: { allies: true, alliesOf: actor.uuid, generated: { name: entry.label, text: entry.text, rules: clone(entry.rules) } } } : {}),
                        ...(entry.terrain ? { behaviors: [{ name: `${state.spellName}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: terrainDifficulties(["walk"], entry.terrain.difficulty) } }] } : {}),
                        ...(entry.allyTurnCondition ? { events: ["turn-start"], turnEffect: { condition: { uuid: entry.allyTurnCondition.uuid, name: `Slowed ${entry.allyTurnCondition.value}`, note: `Slowed ${entry.allyTurnCondition.value} for this round, starting its turn in the condemned creature's mist.`, value: entry.allyTurnCondition.value }, alliesOf: actor.uuid } } : {}) });
                    results.push({ actorUuid: actor.uuid, castId: started?.castId ?? null, regionUuid: region.uuid });
                }
                state.targetAuraResults = results;
                await this.#updateCard(card, state);
            }
            // Arcane Explosion: the caster's form after the blast — PF2e's Effect on it until removed, its aura around it, maximum Hit Points when it ends.
            if (state.casterForm && !state.casterFormResult) {
                const caster = await fromUuid(state.sourceActorUuid);
                const template = caster ? await loadNativeEffectTemplate(state.casterForm.effect.uuid) : null;
                if (caster && template) {
                    const source = prepareNativeEffectSource(template, { castInstanceId: state.castId, castRank: state.castRank, sourceActorUuid: caster.uuid, sourceItemUuid: state.sourceItemUuid,
                        sourceItemName: state.spellName, resolutionKind: "save" });
                    const effect = await createNativeEffect(caster, source);
                    const auras = {};
                    for (const aura of state.casterForm.auras) auras[aura.key] = await startFollowingAura(this.ongoing, { spellName: state.spellName, sourceActor: caster, sourceItemUuid: state.sourceItemUuid,
                        castRank: state.castRank, aura, durationSeconds: 365 * 24 * 3600 });
                    await effect?.setFlag(MODULE_ID, "formRiders", { castInstanceId: state.castId, auras, spellName: state.spellName, ...(state.casterForm.endFullHp ? { endFullHp: true } : {}) });
                    state.casterFormResult = { effectUuid: effect?.uuid ?? null, auras };
                } else state.casterFormResult = { error: "PF2e's Effect or the caster is unavailable: apply the form yourself." };
                await this.#updateCard(card, state);
            }
            // Duplicate Foe: the copy of each target whose row makes one (a module token, the caster's minion).
            if (state.duplicate && !state.duplicateResults) {
                const caster = await fromUuid(state.sourceActorUuid);
                const results = [];
                for (const [index, target] of state.targets.entries()) {
                    const entry = state.duplicate.byDegree[target.degree];
                    if (!targetParticipates(target) || !entry) continue;
                    const token = resolvedTargets[index]?.token ?? null, original = resolvedTargets[index]?.actor ?? token?.actor ?? null;
                    if (!original) continue;
                    const hp = state.duplicate.hp.base + state.duplicate.hp.step * Math.max(0, Math.floor((Number(state.castRank) - state.duplicate.hp.baseRank) / state.duplicate.hp.interval));
                    const seconds = entry.maxRounds ? Math.min(state.duplicate.seconds, entry.maxRounds * 6) : state.duplicate.seconds;
                    results.push(await copyCreature({ original, originalToken: token, caster, spellName: state.spellName, castId: state.castId, castRank: state.castRank, hp,
                        hpLoss: state.duplicate.hpLoss, halfDamage: entry.halfDamage === true, seconds, sustained: state.duplicate.sustained && !entry.maxRounds, notes: state.duplicate.notes }));
                }
                state.duplicateResults = results;
                await this.#updateCard(card, state);
            }
            // The spell's controls (Puppet Strings' forced actions): their card, once, when a target got a row that gives them.
            if (state.controls && !state.controlsMessageId) {
                const controlled = state.targets.filter(target => targetParticipates(target) && state.controls.degrees.includes(target.degree));
                if (controlled.length) try {
                    const message = await postControlsCard({ controls: state.controls, spellName: state.spellName, itemUuid: state.sourceItemUuid, sourceActorUuid: state.sourceActorUuid,
                        castRank: state.castRank, castId: state.castId, targets: controlled.map(target => target.name) });
                    state.controlsMessageId = message.id;
                    await this.#updateCard(card, state);
                } catch (error) { console.warn(`${MODULE_ID} | The controls card could not be posted.`, error); }
            }
            if (createResultCard && !state.resultMessageId) {
                try {
                    const resultCard = await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: await fromUuid(state.sourceActorUuid) }),
                        content: renderResultCard(state),
                        flags: { [MODULE_ID]: { kind: "save-resolution-result", saveResult: {
                            schema: SAVE_SCHEMA,
                            castId: state.castId,
                            resolutionMessageId: state.messageId
                        } } }
                    });
                    state.resultMessageId = resultCard.id;
                    await this.#updateCard(card, state);
                } catch (error) {
                    console.warn(`${MODULE_ID} | Results were applied, but the result summary card could not be created.`, error);
                }
            }
            debugLog(state.castId, "save resolution completed", {
                messageId: state.messageId,
                targets: state.targets.map(target => ({
                    name: target.name,
                    actorUuid: target.actorUuid,
                    degree: target.degree,
                    secondaryDegree: target.secondary?.degree ?? null,
                    hpBefore: target.hpBefore,
                    hpAfter: target.hpAfter,
                    damageResults: target.damageResults,
                    effectUuids: target.effectUuids
                }))
            });
            Hooks.callAll(`${MODULE_ID}.saveApplied`, { card, state });
            if (state.saveIsBasic !== false) Hooks.callAll(`${MODULE_ID}.basicSaveApplied`, { card, state });
            return { status: "applied", state };
        } catch (error) {
            debugError(state.castId, "save resolution failed", error, {
                damageApplied,
                status: state.status,
                targets: state.targets
            });
            if (ongoingJournal) await this.ongoing.review(ongoingJournal, `Outcome application interrupted: ${error.message}`);
            if (!damageApplied) {
                await Promise.allSettled(createdEffects.map(effect => effect.delete({
                    [MODULE_ID]: { reason: "rollback" }
                })));
                for (const target of state.targets) {
                    target.applicationStatus = "pending";
                    target.hpBefore = null;
                    target.hpAfter = null;
                    target.damageResults = [];
                    target.effectUuids = [];
                    target.conditionResults = [];
                    target.terminalResult = null;
                    target.terminalApplied = false;
                }
                state.status = "collecting";
                await this.#updateCard(card, state).catch(() => {});
                throw error;
            }
            state.status = "review";
            state.reviewRequired = true;
            state.reviewReason = "Result application was interrupted after irreversible damage may have been applied.";
            await this.#updateCard(card, state).catch(() => {});
            throw error;
        }
    }

    async #updateCard(card, state) {
        await card.update({
            content: (state.reviewRequired ? damageTotalHTML(state) : "") + renderCard(state),
            [`flags.${MODULE_ID}.basicSaveState`]: clone(state)
        });
    }

    async #acceptInlineSave(payload) {
        const card = cardForCast(payload.castId);
        if (!card || !isCardCoordinator(card)) return { status: "ignored" };
        return await this.#queue(payload.castId, async () => {
            const state = stateFromCard(card);
            const target = state?.targets?.find(candidate => candidate.id === payload.targetId);
            if (!state || !target || target.actorUuid !== payload.actorUuid) {
                throw new Error("The inline save result does not match its snapshotted target.");
            }
            const stage = payload.stage === "secondary" ? "secondary" : "primary";
            const saveRecord = stage === "secondary" ? target.secondary : target;
            if (!saveRecord) throw new Error(`${target.name} has no required secondary save.`);
            if (saveRecord.lastSubmissionId === payload.submissionId) return { status: "duplicate", state, target };
            if (state.status !== "collecting" && !["applying", "applied"].includes(target.applicationStatus)) {
                throw new Error(`${state.spellName}: saves are locked after finalization begins.`);
            }
            if (state.status === "collecting" && (!targetParticipates(target)
                || (payload.targetRevision != null && Number(payload.targetRevision) !== Number(target.revision ?? 0)))) {
                throw new Error(`${target.name}: this target changed while the save dialog was open. Roll again from the refreshed card.`);
            }
            const { actor } = await resolveTargetDocuments(target);
            assertPersistedTargetIdentity(target, actor);
            const user = game.users?.get?.(payload.userId)
                ?? game.users?.contents?.find(candidate => candidate.id === payload.userId)
                ?? null;
            // A spell attack is the caster's roll; a save is the target's.
            const roller = ["spell-attack", "strike"].includes(state.saveStatistic) && stage === "primary" ? await fromUuid(state.sourceActorUuid) : actor;
            if (!user || (!user.isGM && !roller?.canUserModify?.(user, "update"))) {
                throw new Error(`${target.name}: the submitting user cannot roll this ${roller === actor ? "actor's save" : "spell attack"}.`);
            }
            const recorder = stage === "secondary" ? recordSecondarySave : recordProvisionalSave;
            const result = recorder(state, target.id, {
                degree: payload.degree,
                messageId: null,
                timestamp: Date.now(),
                reroll: payload.reroll,
                total: payload.total,
                natural: payload.natural,
                modifier: payload.modifier,
                submissionId: payload.submissionId
            });
            if (stage === "primary") synchronizeSecondary(state, target);
            // A spell attack records which attack it was; with a shared penalty every target uses the first one chosen.
            if (state.saveStatistic === "spell-attack" && stage === "primary" && [1, 2, 3].includes(payload.attackNumber)) {
                target.attackNumber = payload.attackNumber;
                if (state.sharedMultipleAttackPenalty) state.attackNumber ??= payload.attackNumber;
            }
            const recorded = stage === "secondary" ? target.secondary : target;
            debugLog(state.castId, "inline save result recorded", {
                submissionId: payload.submissionId,
                targetId: target.id,
                targetName: target.name,
                actorUuid: target.actorUuid,
                userId: payload.userId,
                stage,
                degree: recorded.degree,
                total: recorded.saveTotal,
                natural: recorded.saveNatural,
                modifier: recorded.saveModifier,
                revision: recorded.rollRevision,
                status: result.status
            });
            await this.#updateCard(card, state);
            if (result.status === "manual-review") {
                globalThis.ui?.notifications?.warn(`${state.spellName}: ${state.reviewReason} Correct the result manually.`);
            }
            return { status: result.status, state, target };
        });
    }

    async #queue(key, work) {
        const prior = this.#jobs.get(key) ?? Promise.resolve();
        const job = prior.catch(() => {}).then(work);
        this.#jobs.set(key, job);
        try { return await job; }
        finally { if (this.#jobs.get(key) === job) this.#jobs.delete(key); }
    }
}

/**
 * A curse's situational condition (Mariner's Curse: "Slowed 1 while at sea"): given — a small Effect granting it, flagged to the curse — while the curse's
 * toggle is on and the creature has the floor condition; removed when the toggle is off, the floor condition is gone or the curse ends. The active GM.
 */
export async function situationalCurseSync(actor) {
    if (!actor || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return [];
    const changes = [];
    const curses = (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.conditionFloor?.situational && effect.flags[MODULE_ID].situationalToggle);
    const children = (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.situationalOf);
    for (const child of children) if (!curses.some(curse => curse.id === child.flags[MODULE_ID].situationalOf)) { await child.delete().catch(() => null); changes.push({ removed: child.name }); }
    for (const curse of curses) {
        const situational = curse.flags[MODULE_ID].conditionFloor.situational;
        const toggle = curse.flags[MODULE_ID].situationalToggle;
        const on = (curse.system?.rules ?? []).some(rule => rule.key === "RollOption" && rule.option === toggle && rule.value === true) && !!actor.hasCondition?.(situational.requires);
        const child = children.find(entry => entry.flags[MODULE_ID].situationalOf === curse.id && actor.items.has(entry.id));
        if (on && !child) {
            const name = `${curse.name.replace(/ \(curse\)$/, "")}: ${situational.grant.slug} ${situational.grant.value} (${situational.circumstance})`;
            await actor.createEmbeddedDocuments("Item", [{ name, type: "effect", img: curse.img,
                flags: { [MODULE_ID]: { situationalOf: curse.id } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
                    description: { value: `<p>While ${escapeHTML(situational.circumstance)} (the curse's toggle).</p>` },
                    rules: [{ key: "GrantItem", uuid: conditionUuidFor(situational.grant.slug), allowDuplicate: true, onDeleteActions: { grantee: "restrict" },
                        alterations: [{ mode: "override", property: "badge-value", value: situational.grant.value }] }] } }]);
            changes.push({ added: name });
        } else if (!on && child) { await child.delete().catch(() => null); changes.push({ removed: child.name }); }
    }
    return changes;
}
