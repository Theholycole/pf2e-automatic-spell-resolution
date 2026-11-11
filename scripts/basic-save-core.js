import { isExecutableImpossible } from "../src/compiler/impossible-spell.js";
import { KILL_BENEFIT, OR_INCREASE, VALUE_INCREASE, killEffectMatches } from "../src/compiler/kill-effect.js";
import { casterRowEffectMatches } from "../src/compiler/caster-row-effect.js";
import { validNoteEffect, validNoteRule } from "./note-effects.js";
import { proveAllyEffect, proveAllyTempHP } from "../src/compiler/ally-enemy-split.js";
import {inspectCompiledNativeOutcomeEffect} from './native-outcome-effects.js';
import { inspectCasterBenefitClaim } from "./effect-modifier-proof.js";
import { proveCasterMark } from "../src/compiler/caster-mark.js";
import { proveStrikeMark } from "../src/compiler/attack-mark.js";
import { proveBolsterEffect } from "../src/compiler/bolster-split.js";
import {inspectGeneratedSpeedProof} from './generated-outcome-modifier.js';
export const SAVE_DEGREES = Object.freeze([
    "criticalSuccess",
    "success",
    "failure",
    "criticalFailure"
]);

const VALUED_CONDITIONS = new Set([
    "clumsy", "cursebound", "doomed", "drained", "dying", "enfeebled",
    "frightened", "sickened", "slowed", "stunned", "stupefied", "wounded"
]);

export function normalizeSaveDegree(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "number") return ["criticalFailure", "failure", "success", "criticalSuccess"][value] ?? null;
    const key = String(value).toLowerCase().replace(/[\s_-]/g, "");
    return {
        criticalfailure: "criticalFailure",
        critfailure: "criticalFailure",
        criticalfail: "criticalFailure",
        failure: "failure",
        fail: "failure",
        success: "success",
        criticalsuccess: "criticalSuccess",
        critsuccess: "criticalSuccess"
    }[key] ?? null;
}

export function readableSaveDegree(degree) {
    return {
        criticalSuccess: "Critical Success",
        success: "Success",
        failure: "Failure",
        criticalFailure: "Critical Failure"
    }[degree] ?? "Not rolled";
}

export function basicSaveMultiplier(degree) {
    return {
        criticalSuccess: 0,
        success: 0.5,
        failure: 1,
        criticalFailure: 2
    }[normalizeSaveDegree(degree)] ?? null;
}

export function checkRollSkipDialog(event, showCheckDialogs = true) {
    const normallySkip = !showCheckDialogs;
    return event?.shiftKey === true ? !normallySkip : normallySkip;
}

function executableActorTargetConstraints(plan) {
    const constraints = plan?.targeting?.actorConstraints;
    return constraints?.supportsActorTargets === true
        && constraints.complete === true
        && Array.isArray(constraints.predicates)
        && constraints.predicates.every(predicate =>
            (predicate.kind === "trait" && typeof predicate.present === "boolean" && !!predicate.slug)
            || predicate.kind === "not-caster"
            || predicate.kind === "living-or-undead"
            || (predicate.kind === "persistent-damage" && /^[a-z]+$/.test(predicate.damageType ?? ""))
            || predicate.kind === "living-creature"
            || predicate.kind === "hp-zero"
            || (predicate.kind === "not-immune-damage" && /^[a-z]+$/.test(predicate.damageType ?? ""))
            || predicate.kind === "undead-or-void-healing"
            || predicate.kind === "not-undead-or-void-healing"
            || predicate.kind === "enemy-of-caster"
            || predicate.kind === "non-ally-of-caster"
            || predicate.kind === "not-familiar"
            || predicate.kind === "land-speed-above-caster"
            || (predicate.kind === "size-at-most" && ["tiny", "sm", "med", "lg", "huge"].includes(predicate.size)
                && Object.entries(predicate.byRank ?? {}).every(([rank, size]) => /^\d+$/.test(rank) && ["tiny", "sm", "med", "lg", "huge"].includes(size)))
            || (predicate.kind === "level-at-most" && Number.isInteger(predicate.level) && Object.entries(predicate.byRank ?? {}).every(([rank, level]) => /^\d+$/.test(rank) && Number.isInteger(level)))
            // "with a level of no more than your level -4": the caster's level, less the offset.
            || (predicate.kind === "level-at-most-caster" && Number.isInteger(predicate.offset) && predicate.offset <= 0)
            || (predicate.kind === "gm-confirmed" && typeof predicate.question === "string" && predicate.question.length > 0));
}

function actorTraits(actor) {
    const traits = actor?.traits;
    if (traits && typeof traits.has === "function") return traits;
    return new Set(actor?.system?.traits?.value ?? []);
}

/** PF2e alliance: "party", "opposition" or null (neutral). */
export function actorAlliance(actor) {
    if (actor && "alliance" in actor) return actor.alliance ?? null;
    return actor?.system?.details?.alliance ?? null;
}

function actorIsCreature(actor) {
    if (typeof actor?.isOfType === "function") return actor.isOfType("creature");
    return ["character", "npc", "familiar"].includes(actor?.type);
}

export function validateActorTarget(constraints, actor) {
    if (!constraints) {
        return { eligible: false, reason: "target eligibility is missing; prepare a new resolution card" };
    }
    if (!constraints?.supportsActorTargets) {
        return { eligible: false, reason: "the ability does not target an Actor" };
    }
    if (!constraints.complete) {
        return { eligible: false, reason: "target eligibility was not completely compiled" };
    }
    // PF2e's native immunity evaluator consumes an Item's roll options. Keep
    // the cast-time options so later source deletion cannot erase eligibility.
    if (constraints.spellRollOptions?.length && actor?.isImmuneTo?.({
        parent: null, getRollOptions: () => constraints.spellRollOptions
    })) return {eligible:false,reason:'immune to this spell according to PF2e',immune:true};
    if (constraints.spellImmunityKey && [...(actor?.items ?? [])].some(item =>
        item.type === 'effect' && !item.isExpired
        && item.flags?.['pf2e-automatic-resolution']?.spellImmunity?.key === constraints.spellImmunityKey)) {
        return { eligible: false, reason: 'temporarily immune to this spell', immune: true };
    }
    const traits = actorTraits(actor);
    for (const predicate of constraints.predicates ?? []) {
        if (predicate.kind === "trait" && predicate.present === true && !traits.has(predicate.slug)) {
            return { eligible: false, reason: `requires the ${predicate.slug} trait` };
        }
        if (predicate.kind === "trait" && predicate.present === false && traits.has(predicate.slug)) {
            return { eligible: false, reason: `the ${predicate.slug} trait excludes it` };
        }
        if (predicate.kind === "not-caster" && actor?.uuid && actor.uuid === constraints.casterUuid) {
            return { eligible: false, reason: "the spell targets a creature other than the caster" };
        }
        // "1 living or undead creature": not a construct (or an object).
        if (predicate.kind === "living-or-undead" && (!actorIsCreature(actor) || (traits.has("construct") && !traits.has("undead")))) {
            return { eligible: false, reason: "requires a living or undead creature" };
        }
        // "1 creature taking bleed damage": PF2e's persistent damage condition of that type.
        if (predicate.kind === "persistent-damage" && ![...(actor?.items ?? [])].some(item => item.type === "condition" && item.slug === "persistent-damage"
            && String(item.system?.persistent?.damageType ?? "") === predicate.damageType)) {
            return { eligible: false, reason: `requires persistent ${predicate.damageType} damage` };
        }
        if (predicate.kind === "living-creature"
            && (!actorIsCreature(actor) || traits.has("undead") || traits.has("construct"))) {
            return { eligible: false, reason: "requires a living creature" };
        }
        // "a creature that isn't immune to spirit damage": PF2e's immunities.
        if (predicate.kind === "not-immune-damage" && [...(actor?.attributes?.immunities ?? actor?.system?.attributes?.immunities ?? [])].some(immunity => immunity?.type === predicate.damageType)) {
            return { eligible: false, reason: `immune to ${predicate.damageType} damage`, immune: true };
        }
        // "1 dying creature": PF2e's Dying condition.
        if (predicate.kind === "condition" && !(actor?.hasCondition?.(predicate.slug) ?? [...(actor?.items ?? [])].some(item => item.type === "condition" && item.slug === predicate.slug))) {
            return { eligible: false, reason: `requires a ${predicate.slug} creature` };
        }
        // "1 living creature that has 0 HP".
        if (predicate.kind === "hp-zero" && Number(actor?.hitPoints?.value ?? actor?.system?.attributes?.hp?.value) !== 0) {
            return { eligible: false, reason: "requires a creature at 0 Hit Points" };
        }
        if (predicate.kind === "undead-or-void-healing"
            && (!actorIsCreature(actor) || !(traits.has("undead")
                || actor?.hitPoints?.negativeHealing === true
                || actor?.system?.attributes?.hp?.negativeHealing === true))) {
            return { eligible: false, reason: "requires an undead creature or one with void healing" };
        }
        // Execute (Void): the other variant is for the undead and void-healing creatures.
        if (predicate.kind === "not-undead-or-void-healing"
            && (!actorIsCreature(actor) || traits.has("undead")
                || actor?.hitPoints?.negativeHealing === true
                || actor?.system?.attributes?.hp?.negativeHealing === true)) {
            return { eligible: false, reason: "undead and void-healing creatures take the vitality variant" };
        }
    }
    // "1 zombie of level 1 or lower" (5 or lower at 4th): PF2e's level, at the cast rank.
    const levelLimit = (constraints.predicates ?? []).find(predicate => predicate.kind === "level-at-most");
    if (levelLimit) {
        const rank = Number(constraints.castRank ?? 0);
        const limit = Object.entries(levelLimit.byRank ?? {}).filter(([at]) => rank >= Number(at)).sort(([a], [b]) => Number(b) - Number(a))[0]?.[1] ?? levelLimit.level;
        const level = Number(actor?.level ?? actor?.system?.details?.level?.value ?? NaN);
        if (!Number.isFinite(level)) return { eligible: false, reason: "its level can't be read" };
        if (level > limit) return { eligible: false, reason: `level ${level} is above the spell's limit (${limit})` };
    }
    const casterLimit = (constraints.predicates ?? []).find(predicate => predicate.kind === "level-at-most-caster");
    if (casterLimit) {
        const limit = Number(constraints.casterLevel) + Number(casterLimit.offset);
        const level = Number(actor?.level ?? actor?.system?.details?.level?.value ?? NaN);
        if (!Number.isFinite(level) || !Number.isFinite(limit)) return { eligible: false, reason: "its level or the caster's can't be read" };
        if (level > limit) return { eligible: false, reason: `level ${level} is above the spell's limit (the caster's level ${casterLimit.offset}: ${limit})` };
    }
    // "Large or smaller creatures must attempt …": PF2e's size.
    const sizeLimit = (constraints.predicates ?? []).find(predicate => predicate.kind === "size-at-most");
    if (sizeLimit) {
        const order = ["tiny", "sm", "med", "lg", "huge", "grg"];
        const size = actor?.size ?? actor?.system?.traits?.size?.value;
        if (!order.includes(size)) return { eligible: false, reason: "its size can't be read" };
        // (A larger size from a heightened rank: Expeditious Excavation's Large creature at 8th.)
        const rank = Number(constraints.castRank ?? 0);
        const limit = Object.entries(sizeLimit.byRank ?? {}).filter(([at]) => rank >= Number(at)).sort(([a], [b]) => Number(b) - Number(a))[0]?.[1] ?? sizeLimit.size;
        if (order.indexOf(size) > order.indexOf(limit)) return { eligible: false, reason: `too large (${size}); the spell affects ${limit} or smaller creatures` };
    }
    // "1 creature with a land Speed greater than yours": PF2e's land Speeds, the caster's taken when the saves were prepared.
    if ((constraints.predicates ?? []).some(predicate => predicate.kind === "land-speed-above-caster")) {
        const theirs = Number(actor?.system?.movement?.speeds?.land?.value ?? actor?.system?.attributes?.speed?.total ?? NaN), mine = Number(constraints.casterLandSpeed ?? NaN);
        if (!Number.isFinite(theirs) || !Number.isFinite(mine)) return { eligible: false, reason: "the land Speeds can't be compared" };
        if (!(theirs > mine)) return { eligible: false, reason: `its land Speed (${theirs} feet) isn't greater than the caster's (${mine} feet)` };
    }
    const questions = [];
    // "Each enemy in the area": PF2e alliances decide. The caster and its allies are
    // never enemies; a creature without an alliance (neutral) is the GM's call.
    if ((constraints.predicates ?? []).some(predicate => predicate.kind === "enemy-of-caster")) {
        if (actor?.uuid && actor.uuid === constraints.casterUuid) return { eligible: false, reason: "the caster isn't an enemy" };
        const theirs = actorAlliance(actor), mine = constraints.casterAlliance ?? null;
        if (mine && theirs && mine === theirs) return { eligible: false, reason: "an ally of the caster, not an enemy" };
        if (!mine || !theirs) questions.push("Is this creature an enemy of the caster? The spell affects only enemies.");
    }
    if ((constraints.predicates ?? []).some(predicate => predicate.kind === "not-familiar") && actor?.type === "familiar") return { eligible: false, reason: "a familiar" };
    // "Each non-allied creature in the area": the caster and its allies (PF2e alliances) are left out; neutral creatures are in.
    if ((constraints.predicates ?? []).some(predicate => predicate.kind === "non-ally-of-caster")) {
        if (actor?.uuid && actor.uuid === constraints.casterUuid) return { eligible: false, reason: "the caster" };
        const theirs = actorAlliance(actor), mine = constraints.casterAlliance ?? null;
        if (mine && theirs && mine === theirs) return { eligible: false, reason: "an ally of the caster" };
    }
    // PF2e has no data for this creature state; the GM answers per target.
    const confirmation = (constraints.predicates ?? []).find(predicate => predicate.kind === "gm-confirmed");
    if (confirmation) questions.push(confirmation.question);
    return { eligible: true, reason: null, ...(questions.length ? { confirmation: questions.join(" Also: ") } : {}) };
}

const SECONDS = { rounds: 6, minutes: 60, hours: 3600 };
/** The spell's maximum in seconds when it's sustained with a fixed maximum ("sustained up to 1 minute"). */
export function sustainedMaximumSeconds(lifecycle) {
    const maximum = lifecycle?.durationSpec?.mode === "sustained" ? lifecycle.durationSpec.maximum : null;
    if (maximum?.mode !== "fixed" || !SECONDS[maximum.unit] || !(Number(maximum.value) > 0)) return null;
    return Number(maximum.value) * SECONDS[maximum.unit];
}

/**
 * A sustained spell with a degree-of-success table: the save is resolved once;
 * conditions without their own duration last while the caster Sustains (the
 * ongoing workflow ends them on a missed Sustain), and never past the maximum.
 */
export function isSustainedConditionPlan(plan) {
    // (Or a basic save whose failing rows carry a note lasting the sustained spell: Hot Air's speech rider.)
    return plan?.resolution?.kind === "save" && (plan.resolution.check?.basic === false
        || (plan.resolution.check?.basic === true && (plan.automation?.compiledCapabilities ?? []).includes("basic-save-speech-rider")))
        && plan.lifecycle?.sustained === true && sustainedMaximumSeconds(plan.lifecycle) != null
        && !plan.resolution.lingering;
}

/** "If the target recovers from being Sickened, the persistent damage ends …": a failing row dealing that persistent damage and granting that condition. */
export function isConditionEndedPersistent(link, outcome, degree) {
    return ["failure", "criticalFailure"].includes(degree) && Object.keys(link ?? {}).every(key => ["condition", "damageType", "sourceText", "degrees"].includes(key))
        && /^[a-z-]+$/.test(link?.condition ?? "") && /^[a-z]+$/.test(link.damageType ?? "") && typeof link.sourceText === "string" && link.sourceText.length > 0
        && Array.isArray(link.degrees) && link.degrees.includes(degree)
        && outcome?.damage?.mode === "mixed" && (outcome.damage.formulas ?? []).some(entry => String(entry.formula ?? "").endsWith(`[persistent,${link.damageType}]`))
        && (outcome.effects ?? []).some(effect => effect.kind === "condition" && effect.slug === link.condition);
}

/** The caster's marking Effect: the compiled claim, proved against the Effect for the rows' one persistent type, which those rows deal. */
export function isCasterMark(mark, plan) {
    const outcomes = plan?.resolution?.outcomes ?? {};
    // A spell attack's mark for the caster's weapon damage, on a hit.
    if (mark?.kind === "strike-bonus") return plan?.resolution?.kind === "save" && plan.resolution.check?.statistic === "spell-attack"
        && typeof mark.uuid === "string" && mark.claimText === plan.compilerEvidence?.casterMark && JSON.stringify(mark.degrees) === '["criticalSuccess","success"]'
        && proveStrikeMark(mark.document?.mechanics, { value: mark.value, heightens: mark.heightens }, mark.baseRank)?.slug === mark.slug;
    const dealsIt = degree => outcomes[degree]?.damage?.mode === "mixed" && (outcomes[degree].damage.formulas ?? []).some(entry => new RegExp(`\\[persistent,${mark?.damageType}\\]$`).test(entry.formula ?? ""));
    return plan?.resolution?.kind === "save" && plan.resolution.check?.basic === false && ["fortitude", "reflex", "will"].includes(plan.resolution.check.statistic)
        && typeof mark?.uuid === "string" && typeof mark.claimText === "string" && mark.claimText === plan.compilerEvidence?.casterMark
        && /^[a-z]+$/.test(mark.damageType ?? "") && Array.isArray(mark.degrees) && mark.degrees.length > 0
        && mark.degrees.every(degree => ["success", "failure", "criticalFailure"].includes(degree) && dealsIt(degree))
        && Object.keys(outcomes).filter(dealsIt).every(degree => mark.degrees.includes(degree))
        && proveCasterMark(mark.document?.mechanics, mark.claimText, mark.damageType)?.slug === mark.slug;
}

/** The caster's sustained note on a basic save: the compiled sentences, the spell's maximum, and its Heightened text. */
export function isSustainedCasterNote(note, plan) {
    const duration = note?.duration;
    return note?.recipient === "source" && typeof note.text === "string" && note.text.length > 0 && note.text.length <= 1000
        && note.sourceText === plan?.compilerEvidence?.casterNote && note.text === note.sourceText
        && duration?.mode === "fixed" && duration.sustained === true && Number.isInteger(duration.value) && duration.value > 0
        && Number(duration.value) * (SECONDS[duration.unit] ?? NaN) === sustainedMaximumSeconds(plan.lifecycle)
        && Array.isArray(note.heightened) && note.heightened.every(entry => typeof entry?.text === "string" && entry.text.length > 0
            && ((Number.isInteger(entry.step) && entry.step > 0 && entry.rank == null) || (Number.isInteger(entry.rank) && entry.step == null)));
}

/**
 * The caster's note while a creature has the row's condition from this cast (Frog Tongue's "While a creature is stuck to the end of your
 * tongue, actions you take with the auditory trait take a –2 circumstance penalty."): the stated penalty to checks of actions with the
 * trait, for the spell's duration, made only for a failing creature and removed with its condition's Effect.
 */
export function isWhileTargetConditionCasterNote(note, plan) {
    const rule = note?.rules?.[0];
    const spec = plan?.lifecycle?.durationSpec;
    return note?.recipient === "source" && note.kind === "while-target-condition" && typeof note.text === "string" && note.text.startsWith(note.sourceText ?? "\u0000")
        && note.sourceText === plan?.compilerEvidence?.casterNote && JSON.stringify(note.degrees) === '["failure","criticalFailure"]'
        && ["failure", "criticalFailure"].every(degree => (plan.resolution.outcomes?.[degree]?.effects ?? []).some(effect => effect.slug === note.condition && isEscapeLifetime(effect)))
        && note.rules.length === 1 && rule.key === "FlatModifier" && rule.selector === "all" && ["circumstance", "status"].includes(rule.type) && Number.isInteger(rule.value) && rule.value < 0 && rule.value >= -4
        && validNoteRule(rule)
        && note.duration?.mode === "fixed" && note.duration.sustained !== true && spec?.mode === "fixed" && note.duration.value === spec.value && note.duration.unit === spec.unit;
}

/**
 * The caster's condition while a creature holds this cast's possession note (Possession's "your own body is Unconscious"): one per possessed creature,
 * removed with that creature's note; its text the compiled sentences, its rule the condition.
 */
export function isWhileTargetNoteCasterNote(note, plan) {
    const rule = note?.rules?.[0];
    return note?.recipient === "source" && note.kind === "while-target-note" && typeof note.text === "string" && note.text.startsWith(note.sourceText ?? "\u0000")
        && note.sourceText === plan?.compilerEvidence?.casterNote && Array.isArray(note.degrees) && note.degrees.length > 0
        && note.degrees.every(degree => (plan.resolution.outcomes?.[degree]?.noteEffects ?? []).some(entry => entry.possession === true))
        && note.rules?.length === 1 && rule.key === "GrantItem" && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(rule.uuid ?? "") && validNoteRule(rule)
        && note.duration?.mode === "fixed";
}

/** Heightened secondary targets (Horrifying Blood Loss at 4th): one waived persistent-damage requirement, a count, the GM's question. */
export function isSecondaryTargets(secondary, plan) {
    const predicates = plan?.targeting?.actorConstraints?.predicates ?? [];
    return Number.isInteger(secondary?.fromRank) && secondary.fromRank > Number(plan?.rank) && Number.isInteger(secondary.max) && secondary.max >= 1 && secondary.max <= 5
        && secondary.waived?.kind === "persistent-damage" && predicates.some(predicate => predicate.kind === "persistent-damage" && predicate.damageType === secondary.waived.damageType)
        && typeof secondary.question === "string" && secondary.floorFollowsPrimary === true && secondary.sourceText === plan?.compilerEvidence?.secondaryTargets
        && ["failure", "criticalFailure"].every(degree => plan.resolution.outcomes?.[degree]?.conditionFloor?.lifetime === "while-persistent");
}

/**
 * A creature of a trait taking extra persistent damage (Worm's Repast's non-skeletal undead): the same rows, except that each row dealing the
 * persistent damage deals "(<the row's dice> + <the stated extra dice>)" of the same type.
 */
function isPersistentExtraVariant(plan, variant) {
    if (plan.resolution.check?.basic !== false || !Array.isArray(variant.excludedTraits) || !variant.excludedTraits.every(trait => /^[a-z-]+$/.test(trait))
        || typeof variant.sourceText !== "string" || !plan.compilerEvidence?.traitModes?.includes(variant.sourceText)) return false;
    const extra = /^floor\(\(@item\.(?:level|rank)\/(\d+)\)\+(\d+)\)d(\d+)\[persistent,([a-z-]+)\]$/.exec(variant.formula ?? "");
    if (!extra || !variant.sourceText.includes(`@Damage[${variant.formula}]`)) return false;
    let extended = 0;
    for (const degree of SAVE_DEGREES) {
        const main = plan.resolution.outcomes?.[degree], other = variant.outcomes?.[degree];
        if (!main || !other) return false;
        const { damage: mainDamage, ...mainRest } = main, { damage: otherDamage, ...otherRest } = other;
        if (JSON.stringify(mainRest) !== JSON.stringify(otherRest) || mainDamage?.mode !== otherDamage?.mode) return false;
        if (mainDamage.mode !== "mixed") { if (JSON.stringify(mainDamage) !== JSON.stringify(otherDamage)) return false; continue; }
        const [mainFormula] = mainDamage.formulas ?? [], [otherFormula] = otherDamage.formulas ?? [];
        const typed = /^(.+)\[persistent,([a-z-]+)\]$/.exec(mainFormula?.formula ?? "");
        if (JSON.stringify(mainDamage.shared) !== JSON.stringify(otherDamage.shared) || mainDamage.formulas.length !== 1 || otherDamage.formulas?.length !== 1 || !typed || typed[2] !== extra[4]
            || otherFormula.formula !== `(${typed[1]} + (floor(@item.level/${extra[1]})+${extra[2]})d${extra[3]})[persistent,${extra[4]}]`) return false;
        extended++;
    }
    return extended > 0;
}

/** Trait-conditional extra damage entries (see src/compiler/conditional-damage.js). */
function executableConditionalDamage(plan) {
    const entries = plan?.resolution?.conditionalDamage;
    if (entries == null) return true;
    return Array.isArray(entries) && entries.length > 0 && plan.resolution.sharedDamage != null && entries.every(entry =>
        typeof entry?.formula === "string" && /\[[a-z]+\]$/.test(entry.formula) && typeof entry.trait === "string" && /^[a-z-]+$/.test(entry.trait)
        && [...entry.formula.matchAll(/@([a-z0-9_.-]+)/gi)].every(match => ["item.rank", "item.level"].includes(match[1].toLowerCase()))
        // (Or persistent damage on the failing rows only, for a creature with any of the traits: Spray of Salt.)
        || (typeof entry?.formula === "string" && /^\(@item\.(?:rank|level)\)d\d+\[persistent,[a-z]+\]$/.test(entry.formula) && Array.isArray(entry.traits) && entry.traits.length > 0
            && entry.traits.every(trait => /^[a-z-]+$/.test(trait)) && entry.trait === entry.traits[0] && JSON.stringify(entry.degrees) === '["failure","criticalFailure"]'));
}

/**
 * The caster's choice for a cast, made once on the card (or when an ongoing area starts): a damage type every row's
 * degree-choice Effect reads ("Choose one type of damage from the following list: …"), or the type of the item's one
 * untyped damage entry ("4d4 bludgeoning or piercing damage (your choice)").
 */
export function executableCasterChoice(plan) {
    const choice = plan?.resolution?.casterChoice;
    if (choice == null) return true;
    if (!(Array.isArray(choice.values) && choice.values.length > 1 && new Set(choice.values).size === choice.values.length
        && choice.values.every(value => typeof value === "string" && (/^[a-z]+(?: [a-z]+)?$/.test(value) || (choice.kind === "condition" && /^[a-z]+-[a-z]+$/.test(value)))) && typeof choice.label === "string"
        && typeof plan.compilerEvidence?.casterChoice === "string")) return false;
    // A table row naming the types of the spell's two untyped entries (Chthonian Wrath): a basic save, each row a pair of damage types.
    if (choice.kind === "damage-pair") {
        const components = plan.resolution.sharedDamage?.components ?? [];
        return plan.resolution.check?.basic === true && plan.resolution.sharedDamage?.mode === "pf2e-item-damage" && components.length === 2
            && components.every(component => String(component.type).toLowerCase() === "untyped" && !component.category)
            && choice.values.every(value => Array.isArray(choice.pairs?.[value]) && choice.pairs[value].length === 2 && choice.pairs[value].every(type => /^[a-z]+$/.test(type)));
    }
    if (choice.kind === "damage-type") {
        const components = plan.resolution.sharedDamage?.components ?? [];
        // The text's damage (PF2e's item has none): its own formula, untyped until the caster picks.
        // (Or a degree save held on its target whose rows scale that damage: Murmuration.)
        // (Every part of the text's damage the caster's type — Ravaging End's direct and persistent — the formula the compiler read.)
        if (plan.resolution.sharedDamage?.mode === "formula" && choice.allPools === true) return plan.resolution.sharedDamage.textDerived === true && choice.flag == null
            && plan.resolution.sharedDamage.formula === plan.compilerEvidence?.textFormula && (plan.resolution.sharedDamage.formula.match(/\[(?:persistent,)?untyped\]/g) ?? []).length === components.length
            && components.length >= 1 && components.every(component => component.type === "untyped") && Object.keys(choice).every(key => ["kind", "values", "label", "allPools", "selected"].includes(key));
        if (plan.resolution.sharedDamage?.mode === "formula") return (plan.resolution.check?.basic === true || plan.resolution.sharedDamage.degreeScaled === true || plan.resolution.check?.statistic === "spell-attack") && plan.resolution.sharedDamage.textDerived === true
            // (Or the last pool of several — Falling Stars' "{…d10[bludgeoning],…d6[untyped]}".)
            && /\[untyped\]\}?$/.test(plan.resolution.sharedDamage.formula ?? "") && (plan.resolution.sharedDamage.formula.match(/\[untyped\]/g) ?? []).length === 1 && components.length === 1 && choice.flag == null;
        return plan.resolution.check?.basic === true && plan.resolution.sharedDamage?.mode === "pf2e-item-damage" && components.length === 1
            && String(components[0].type).toLowerCase() === "untyped" && !components[0].category && choice.flag == null;
    }
    // An option the caster picks when casting ("the type of plant you choose to grow"): each option names a damage type for the text's
    // damage, and the critical failure's extras belong to one option each (a condition, or one inline formula).
    // A listed state the caster picks for a non-basic save's rows (Overwhelming Memory): each row it names holds exactly one entry per option
    // (a condition, or a note Effect), until the start of the caster's next turn; no other row has any.
    // One row's listed conditions, of which the caster picks one ("your choice of Clumsy 1, Drained 1, or Enfeebled 1 for 1 round"): that row holds exactly
    // one condition per option (one duration), claimed by its sentence; no other row is tagged.
    // Necrotize: the critical failure's second body part — that row's second Effect reads it; the cast's roll gives the first (the same list).
    if (choice.kind === "option" && choice.pick === "native-part") {
        const roll = plan.resolution.conditionRoll;
        const rolled = degree => (plan.resolution.outcomes?.[degree]?.nativeEffects ?? []).filter(effect => effect.outcomeRule?.kind === "rolled-part-effect");
        const values = rule => (rule.parts ?? []).map(part => part.value);
        return plan.resolution.check?.basic === false && JSON.stringify(choice.rows) === '["criticalFailure"]' && roll?.kind === "native-choice" && /^1d\d+$/.test(roll.formula ?? "")
            && JSON.stringify(roll.options) === JSON.stringify(choice.values) && Object.keys(roll.results ?? {}).length === choice.values.length
            && Object.entries(roll.results).every(([face, value]) => choice.values[Number(face) - 1] === value)
            && ["success", "failure"].every(degree => rolled(degree).length === 1 && rolled(degree)[0].outcomeRule.pick === "rolled")
            && JSON.stringify(rolled("criticalFailure").map(effect => effect.outcomeRule.pick)) === '["rolled","caster"]'
            && ["success", "failure", "criticalFailure"].every(degree => rolled(degree).every(effect => JSON.stringify(values(effect.outcomeRule)) === JSON.stringify(choice.values)))
            && rolled("criticalSuccess").length === 0;
    }
    if (choice.kind === "option" && choice.pick === "row-condition") {
        const degrees = ["criticalSuccess", "success", "failure", "criticalFailure"];
        if (!(plan.resolution.check?.basic === false && Array.isArray(choice.rows) && choice.rows.length === 1 && degrees.includes(choice.rows[0]))) return false;
        return degrees.every(degree => {
            const outcome = plan.resolution.outcomes?.[degree];
            const tagged = (outcome?.effects ?? []).filter(effect => effect.choiceGroup === "caster-option");
            if ((outcome?.noteEffects ?? []).some(note => note.choiceGroup === "caster-option")) return false;
            if (degree !== choice.rows[0]) return tagged.length === 0;
            return tagged.length === choice.values.length && tagged.length === (outcome.effects ?? []).length && tagged.every(effect => effect.kind === "condition" && effect.option === effect.slug)
                && JSON.stringify(tagged.map(effect => effect.option).sort()) === JSON.stringify([...choice.values].sort()) && typeof outcome.conditionPick?.sourceText === "string"
                && new Set(tagged.map(effect => JSON.stringify(effect.duration))).size === 1;
        });
    }
    if (choice.kind === "option" && Array.isArray(choice.rows)) {
        const degrees = ["criticalSuccess", "success", "failure", "criticalFailure"];
        if (!(plan.resolution.check?.basic === false && ["fortitude", "reflex", "will"].includes(plan.resolution.check?.statistic) && !plan.resolution.sharedDamage
            && choice.rows.length && choice.rows.every(degree => degrees.includes(degree)) && new Set(choice.rows).size === choice.rows.length && choice.options == null
            // (A second pick on some rows: Sensory Deprivation's critical failure, "you can choose two options instead of one".)
            && (choice.twoOn == null || (Array.isArray(choice.twoOn) && choice.twoOn.every(degree => choice.rows.includes(degree)) && Array.isArray(plan.compilerEvidence?.sensoryRows))))) return false;
        // (Dream Come True: each pick a set of entries — conditions and notes — on every row; each row holds at least one for each pick.)
        if (Array.isArray(plan.compilerEvidence?.optionSetRows)) return degrees.every(degree => {
            const outcome = plan.resolution.outcomes?.[degree];
            const tagged = [...(outcome?.effects ?? []), ...(outcome?.noteEffects ?? [])].filter(entry => entry.choiceGroup === "caster-option");
            if (!choice.rows.includes(degree)) return tagged.length === 0;
            return tagged.every(entry => choice.values.includes(entry.option)) && choice.values.every(value => tagged.some(entry => entry.option === value))
                && (outcome.effects ?? []).filter(effect => effect.choiceGroup === "caster-option").every(effect => effect.kind === "condition");
        });
        return degrees.every(degree => {
            const outcome = plan.resolution.outcomes?.[degree];
            const tagged = [...(outcome?.effects ?? []).filter(effect => effect.choiceGroup === "caster-option").map(effect => ({ entry: effect, condition: true })),
                ...(outcome?.noteEffects ?? []).filter(note => note.choiceGroup === "caster-option").map(note => ({ entry: note, condition: false }))];
            if (!choice.rows.includes(degree)) return tagged.length === 0;
            // (Dreamer's Call: each pick lasts as the row's Fascinated does — until the end of the target's next turn — and Prone until it Stands.)
            const course = Array.isArray(plan.compilerEvidence?.courseOfAction);
            // (Shaken Confidence: each pick's misfortune lasts until the end of the target's next turn, or its next such roll.)
            const misfortune = Array.isArray(plan.compilerEvidence?.misfortuneRows);
            // (Invoke the Harrow: each boon or bane lasts the spell's own time from the cast — rounds, or a minute from 6th.)
            const harrow = Array.isArray(plan.compilerEvidence?.harrowSuits);
            // (Sensory Deprivation: each restriction a note for the row's time — 1 round, or the spell's — disbelieved with a Seek.)
            const sensory = Array.isArray(plan.compilerEvidence?.sensoryRows);
            // (Careless Swings: each pick a GM-played note until the end of the target's next turn.)
            const optionNotes = Array.isArray(plan.compilerEvidence?.optionNoteRows);
            // (Beguile: each pick a condition lasting the sustained spell.)
            const optionConditions = Array.isArray(plan.compilerEvidence?.optionConditionRows);
            // (Planar Court: each attribute a note for the sustained spell, its one penalty to that attribute's "-based" statistics.)
            const court = Array.isArray(plan.compilerEvidence?.courtRows);
            const rowLength = JSON.stringify((outcome?.effects ?? []).find(effect => effect.slug === "fascinated")?.duration ?? null);
            return tagged.length === choice.values.length && JSON.stringify(tagged.map(({ entry }) => entry.option).sort()) === JSON.stringify([...choice.values].sort())
                && tagged.every(({ entry, condition }) => (!condition || entry.kind === "condition") && ((entry.duration?.expiry === "turn-start" && entry.duration?.anchor === "source-turn")
                    || (misfortune && !condition && entry.duration?.expiry === "turn-end" && entry.duration?.anchor === "target-turn" && entry.duration?.value === 1 && entry.rules?.length === 1 && entry.rules[0].key === "RollTwice")
                    || (course && (JSON.stringify(entry.duration) === rowLength || (condition && entry.slug === "prone" && entry.duration?.mode === "unlimited")))
                    || (harrow && !condition && entry.duration?.anchor === "effect-start" && ["rounds", "minutes"].includes(entry.duration?.unit) && entry.endSave?.statistic === "will")
                    || (sensory && !condition && entry.duration?.mode === "fixed" && ["rounds", "minutes"].includes(entry.duration?.unit) && entry.disbelieve?.statistic === "perception")
                    || (optionNotes && !condition && entry.gmPlays === true && entry.duration?.expiry === "turn-end" && entry.duration?.anchor === "target-turn" && entry.duration?.value === 1)
                    || (optionConditions && condition && entry.duration?.mode === "sustained" && entry.endsWhen?.[0]?.event === "spell-ended")
                    || (court && !condition && entry.duration?.sustained === true && entry.rules?.length === 1 && /^(?:str|dex|con|int|wis|cha)-based$/.test(entry.rules[0].selector ?? ""))));
        });
    }
    if (choice.kind === "option" && plan.resolution.check?.statistic === "spell-attack") {
        // A spell attack's form (Threefold Limb): the text's damage typed by the form; each form's extras only on the hit rows.
        const options = choice.options ?? {};
        const tagged = ["criticalSuccess", "success", "failure", "criticalFailure"].flatMap(degree => [...(plan.resolution.outcomes?.[degree]?.nativeEffects ?? []), ...(plan.resolution.outcomes?.[degree]?.noteEffects ?? [])]
            .filter(entry => entry.choiceGroup === "caster-option").map(entry => ({ degree, option: entry.option })));
        return plan.resolution.sharedDamage?.textDerived === true && /\[untyped\]$/.test(plan.resolution.sharedDamage.formula ?? "")
            && JSON.stringify(Object.keys(options)) === JSON.stringify(choice.values)
            && Object.values(options).every(option => /^[a-z]+$/.test(option?.type ?? "") && option.type !== "untyped" && Object.keys(option).length === 1)
            && tagged.every(entry => ["criticalSuccess", "success"].includes(entry.degree) && choice.values.includes(entry.option));
    }
    if (choice.kind === "option") {
        const options = choice.options ?? {};
        const critical = plan.resolution.outcomes?.criticalFailure;
        const tagged = (critical?.effects ?? []).filter(effect => effect.choiceGroup === "caster-option");
        const formulas = critical?.damage?.mode === "mixed" ? critical.damage.formulas ?? [] : [];
        const others = Object.entries(plan.resolution.outcomes ?? {}).filter(([degree]) => degree !== "criticalFailure")
            .some(([, outcome]) => (outcome.effects ?? []).some(effect => effect.choiceGroup === "caster-option") || outcome.damage?.mode === "mixed");
        return plan.resolution.check?.basic === true && plan.resolution.sharedDamage?.textDerived === true && !others
            && JSON.stringify(Object.keys(options)) === JSON.stringify(choice.values)
            && Object.values(options).every(option => /^[a-z]+$/.test(option?.type ?? "") && option.type !== "untyped" && Object.keys(option).length === 1)
            && tagged.every(effect => choice.values.includes(effect.option)) && formulas.every(entry => choice.values.includes(entry.option))
            && new Set([...tagged.map(effect => effect.option), ...formulas.map(entry => entry.option)]).size === tagged.length + formulas.length
            && (critical?.effects ?? []).every(effect => effect.choiceGroup === "caster-option");
    }
    // Two conditions a row grants, of which the caster picks one ("your choice of Clumsy 1 or Enfeebled 1"): one row holds
    // exactly those conditions in the choice, and it's claimed.
    if (choice.kind === "condition") {
        const rows = Object.values(plan.resolution.outcomes ?? {}).filter(outcome => (outcome.effects ?? []).some(effect => effect.choiceGroup === "caster-condition"));
        const grouped = rows.flatMap(outcome => outcome.effects.filter(effect => effect.choiceGroup === "caster-condition"));
        // (Shadow Army: a lingering area's failing rows, each holding every listed condition once — the caster picks one when the area starts.)
        if (Array.isArray(plan.compilerEvidence?.shadowArmy) && plan.compilerEvidence.shadowArmy.includes(plan.compilerEvidence.casterChoice))
            return plan.resolution.check?.basic === false && rows.length === 2 && rows.every(outcome => (outcome.conditionChoiceClaims ?? []).length === 1
                && JSON.stringify(outcome.effects.filter(effect => effect.choiceGroup === "caster-condition").map(effect => effect.slug)) === JSON.stringify(choice.values))
                && grouped.every(effect => effect.kind === "condition");
        return plan.resolution.check?.statistic === "strike" && rows.length === 1 && (rows[0].conditionChoiceClaims ?? []).length === 1 && choice.values.length === 2
            && grouped.every(effect => effect.kind === "condition") && JSON.stringify(grouped.map(effect => effect.slug)) === JSON.stringify(choice.values);
    }
    const rules = Object.values(plan.resolution.outcomes ?? {}).flatMap(outcome => outcome.nativeEffects ?? []).map(effect => effect.outcomeRule);
    return choice.kind == null && typeof choice.flag === "string" && rules.length > 0 && rules.every(rule => ["degree-choice", "chosen-weakness-effect", "twisted-form-effect"].includes(rule?.kind)
        && rule.casterChoice?.flag === choice.flag && JSON.stringify(rule.casterChoice.values) === JSON.stringify(choice.values));
}

/**
 * Allies healed with the linked Effect, enemies saving: an inline healing formula on the cast rank, an Effect whose only
 * rule is the stated save bonus, and enemies judged by the caster's alliance.
 */
export function executableAllySplit(plan) {
    const split = plan?.resolution?.allySplit;
    if (split == null) return true;
    // (Or allies given temporary Hit Points by the Effect, no healing, while enemies roll the table's save: Roar of Freedom.)
    const tempOnly = split.healing == null && split.tempHP != null && plan.resolution.check?.basic !== true && proveAllyTempHP(split.effect?.document?.mechanics, split.tempHP);
    return (tempOnly || (plan.resolution.check?.basic === true && /^(?:\(@item\.(?:level|rank)\)|\d+)d\d+\[healing\]$/.test(split.healing?.formula ?? "")
        && proveAllyEffect(split.effect?.document?.mechanics, split.bonus ?? {})))
        && typeof split.effect?.uuid === "string" && split.effect.document?.type === "effect"
        && (plan.targeting?.actorConstraints?.predicates ?? []).some(predicate => predicate.kind === "enemy-of-caster")
        && Array.isArray(plan.compilerEvidence?.allySplit) && plan.compilerEvidence.allySplit.length === 3;
}

/** Creatures the GM judges get PF2e's bonus Effect instead of saving: a question, and an Effect giving exactly the stated bonus. */
export function executableBolster(plan) {
    const bolster = plan?.resolution?.bolster;
    if (bolster == null) return true;
    // (A basic save's shielded targets: Call the Ten's resistance, from its sentence.)
    const basicOk = plan.resolution.check?.basic === false || (bolster.claim?.kind === "resistance" && Array.isArray(plan.compilerEvidence?.spiritChoice) && plan.compilerEvidence.spiritChoice.includes(bolster.sourceText));
    return basicOk && typeof bolster.question === "string" && bolster.question.length > 0 && typeof bolster.uuid === "string"
        && bolster.document?.type === "effect" && proveBolsterEffect(bolster.document.mechanics, bolster.claim ?? {}) && bolster.sourceText === plan.compilerEvidence?.bolster;
}

/** The caster's own creature destroyed for the blast (Final Sacrifice's minion, Bony Barrage's thrall): absent, or exactly as compiled. */
/** Repeated attacks: within the turn, or once on each later turn up to a stated total within a fixed duration (and the forms below). */
function validRepeatable(plan) {
    const repeat = plan.resolution?.repeatable;
    // (Or once a round while the spell lasts, each on a Sustain: Dancing Blade, Spirit Object.)
    return !repeat || !(!(repeat.window === "sustain" && Number.isInteger(repeat.attacks) && repeat.attacks >= 2 && repeat.attacks <= 101 && repeat.actions === 1 && (repeat.perTurn == null || repeat.perTurn === "any") && (repeat.trigger == null || repeat.trigger === "turn-start")
            && plan.lifecycle?.durationSpec?.mode === "fixed" && typeof repeat.sourceText === "string" && repeat.sourceText === plan.compilerEvidence?.repeatable && Array.isArray(plan.compilerEvidence?.sustainAttack)) && !(repeat.window === "turn"
        // (Or any number of single-action attacks while the spell lasts: Blazing Blade.)
        || (repeat.window === "duration" && repeat.actions === 1 && repeat.attacks == null && plan.lifecycle?.durationSpec?.mode === "fixed" && typeof repeat.sourceText === "string"
            && repeat.sourceText === plan.compilerEvidence?.repeatable && Array.isArray(plan.compilerEvidence?.bladeAttack) && repeat.gate == null && repeat.recharge == null)
        // (Or a breath weapon gained by a counteract, with a recharge: Swallow Light.)
        || (repeat.window === "duration" && [2, 3].includes(repeat.actions) && repeat.attacks == null && plan.lifecycle?.durationSpec?.mode === "fixed" && typeof repeat.sourceText === "string"
            && repeat.sourceText === plan.compilerEvidence?.repeatable && Array.isArray(plan.compilerEvidence?.breathGate) && /^\d+d\d+$/.test(repeat.recharge?.formula ?? "")
            && repeat.recharge.unit === "rounds" && repeat.gate?.kind === "counteract" && /^[a-z ]+$/.test(repeat.gate.target ?? "") && typeof repeat.gate.text === "string")
        || (repeat.window === "subsequent-turns" && Number.isInteger(repeat.attacks) && repeat.attacks >= 2 && repeat.attacks <= 5 && repeat.actions === 1
            && plan.lifecycle?.durationSpec?.mode === "fixed" && typeof repeat.sourceText === "string" && repeat.sourceText === plan.compilerEvidence?.repeatable)
        // (Or a save the creature attempts again the first time the caster Sustains each round: the Witches+ hexes — sustained, up to the maximum.)
        || (repeat.window === "sustain" && repeat.save === true && Number.isInteger(repeat.attacks) && repeat.attacks >= 2 && repeat.attacks <= 101 && repeat.actions === 1
            && plan.lifecycle?.durationSpec?.mode === "sustained" && plan.lifecycle.durationSpec.maximum?.mode === "fixed"
            // (Or a spell attack made again on each Sustain: Tidal Grasp.)
            && (plan.resolution.check?.statistic !== "spell-attack" || (plan.compilerEvidence?.sustainAttackAgain ?? []).includes(repeat.sourceText))
            && typeof repeat.sourceText === "string" && (plan.compilerEvidence?.sustainResave ?? []).includes(repeat.sourceText))));
}

/** A basic save dealt with the caster's melee weapon (Invoke the Crimson Oath): the compiled sentence, a melee requirement, its critical roll. */
function validWeaponDamage(plan) {
    const weapon = plan?.resolution?.weaponDamage;
    // (Weapon Storm: a count of the held weapon's dice, one more a rank, over the rows' placeholder roll.)
    if (weapon?.mode === "dice") return plan.resolution.check?.basic === false && Number.isInteger(weapon.count) && weapon.count > 0 && weapon.perRank === 1 && Number.isInteger(weapon.baseRank)
        && weapon.twoHand === true && (plan.compilerEvidence?.weaponDice ?? []).join(" ").includes(weapon.sourceText)
        && (plan.resolution.sharedDamage?.components ?? []).length === 1 && plan.resolution.sharedDamage.components[0].id === "weapon-dice";
    return weapon == null || (plan.resolution.check?.basic === true && weapon.requirement === "melee" && weapon.criticalRoll === true && weapon.critImmuneFails === true
        && Array.isArray(plan.compilerEvidence?.weaponBlast) && plan.compilerEvidence.weaponBlast.includes(weapon.sourceText)
        && (weapon.convert == null || (["vitality", "void"].includes(weapon.convert.to) && ["undead", "living"].includes(weapon.convert.trait) && weapon.convert.optional === true))
        && (plan.resolution.sharedDamage?.components ?? []).length === 1 && plan.resolution.sharedDamage.components[0].type === "untyped");
}

function validSacrifice(plan) {
    const sacrifice = plan?.resolution?.sacrifice;
    return sacrifice == null || (plan.resolution.check?.basic === true && sacrifice.sourceText === plan.compilerEvidence?.sacrifice && sacrifice.slain === true
        && ((sacrifice.pick === "minion" && sacrifice.trait === "minion" && typeof sacrifice.question === "string" && sacrifice.question.length > 0
            && (sacrifice.typeByTrait == null || (Array.isArray(sacrifice.typeByTrait.traits) && sacrifice.typeByTrait.traits.every(trait => /^[a-z]+$/.test(trait))
                && /^[a-z]+$/.test(sacrifice.typeByTrait.type) && sacrifice.typeByTrait.replaces === String(plan.resolution.sharedDamage?.components?.[0]?.type ?? "").toLowerCase())))
            || (sacrifice.pick === "thrall" && typeof sacrifice.reminder === "string" && sacrifice.reminder.length > 0)));
}

/** Shining Starlight Attack's constellations: each with its area, save and one of the choice's damage types. */
function validConstellations(plan) {
    const rows = plan?.resolution?.constellations;
    if (rows == null) return plan?.resolution?.constellation == null;
    const values = plan.resolution.casterChoice?.kind === "damage-type" ? plan.resolution.casterChoice.values : [];
    const valid = row => typeof row?.name === "string" && row.name.length > 0 && ["line", "cone"].includes(row.area?.type) && Number.isInteger(row.area?.value) && row.area.value > 0
        && ["fortitude", "reflex", "will"].includes(row.statistic) && values.includes(row.damageType) && Array.isArray(row.traits) && row.traits.every(trait => typeof trait === "string");
    return Array.isArray(rows) && rows.length > 1 && rows.every(valid) && new Set(rows.map(row => row.name)).size === rows.length
        && plan.resolution.check?.basic === true && Array.isArray(plan.compilerEvidence?.constellations)
        && (plan.resolution.constellation == null || (valid(plan.resolution.constellation) && plan.resolution.check.statistic === plan.resolution.constellation.statistic));
}

/** Bony Barrage's bone armor: absent, or with its thrall, the compiled sentence and the AC bonus. */
function validBoneArmor(plan) {
    const armor = plan?.resolution?.boneArmor;
    return armor == null || (plan.resolution.sacrifice?.pick === "thrall" && armor.sourceText === plan.compilerEvidence?.boneArmor && Number.isInteger(armor.ac)
        && armor.ac >= 1 && armor.ac <= 4 && typeof armor.question === "string" && armor.question.length > 0);
}

/** A damage type read from the caster at the card ("the same type as your Arcane Cascade"), or none. */
export function isDamageTypeFrom(from) {
    // (Or the text's own type where the item's data names another: Judge Soul.)
    // (Or the target's chosen Strike's type, picked at the card: Shadow's Betrayal.)
    if (from?.kind === "target-strike") return typeof from.sourceText === "string" && Object.keys(from).every(key => ["kind", "sourceText"].includes(key));
    if (from?.kind === "text") return /^[a-z]+$/.test(from.type ?? "") && typeof from.sourceText === "string" && Object.keys(from).every(key => ["kind", "type", "sourceText"].includes(key));
    return from == null || (from.kind === "arcane-cascade" && /^[a-z]+$/.test(from.fallback ?? "") && typeof from.sourceText === "string" && Object.keys(from).every(key => ["kind", "fallback", "sourceText"].includes(key)));
}

export function isExecutableBasicSavePlan(plan) {
    if (plan?.resolution?.kind !== "save" || plan.automation?.level !== "automatic") return false;
    if (!validSacrifice(plan) || !validBoneArmor(plan) || !validConstellations(plan) || !validRepeatable(plan) || !validWeaponDamage(plan)) return false;
    if (!executableAllySplit(plan)) return false;
    if (!executableCasterChoice(plan) || (plan.resolution.casterChoice != null && !["damage-type", "damage-pair"].includes(plan.resolution.casterChoice.kind))) return false;
    if (!executableConditionalDamage(plan)) return false;
    if (!executableActorTargetConstraints(plan)) return false;
    if (plan.resolution.check?.basic !== true || !plan.resolution.check?.statistic) return false;
    const shared = plan.resolution.sharedDamage;
    if (plan.compilerEvidence?.generatedSpeedPenalties) return false;
    // "formula": a lingering area's Sustain damage (`@Damage[(floor(@item.level/2))d10[bludgeoning]]`), rolled once from its own formula.
    const formulaShared = shared?.mode === "formula" && shared.rollOnce === true && shared.components?.length === 1
        // (Several pools in braces — Cataclysm's "{3d10[acid],…}" — end on the last pool's type.)
        && executableFormula({ formula: shared.formula }) && /\[[a-z]+\]\}?$/i.test(shared.formula);
    if (!formulaShared && (shared?.mode !== "pf2e-item-damage" || shared.rollOnce !== true || !shared.components?.length)) return false;
    // Half the triggering damage (Retributive Pain): the card replaces the "0[type]" placeholder with the amount.
    const triggered = shared?.triggeredDamage;
    if (triggered != null && !(formulaShared && shared.textDerived === true && triggered.fraction === 0.5 && triggered.source === "caster-last-damage"
        && typeof triggered.sourceText === "string" && shared.formula === `0[${triggered.type}]` && /^[a-z]+$/.test(triggered.type)
        && /^the triggering creature$/i.test(String(plan.targeting?.target ?? "")))) return false;
    if (!executableDualMode(plan)) return false;
    if (!executableDamageSwap(plan)) return false;
    if (!executableBloodlineDamage(plan)) return false;
    if (!executableThrall(plan)) return false;
    if (!executablePersistentRider(plan)) return false;
    // Terrain left in the caster's emanation (Untwisting Iron Roots): the card places it.
    const left = plan.resolution.leftTerrain;
    if (left != null && !(Object.keys(left).every(key => ["area", "casterExempt", "sourceText"].includes(key)) && left.area?.type === "emanation"
        && plan.targeting?.area?.type === "emanation" && Number(left.area.value) === Number(plan.targeting.area.value) && typeof left.casterExempt === "boolean"
        && typeof left.sourceText === "string" && left.sourceText === plan.compilerEvidence?.leftTerrain)) return false;
    if (!isExecutableFollowUpSave(plan)) return false;
    if (plan.resolution.impossibleBurst != null && !(isExecutableImpossible(plan.resolution.impossibleBurst) && Array.isArray(plan.compilerEvidence?.impossibleBurst))) return false;
    // A trait-read degree adjustment ("Creatures with the water or plant traits get a result one degree of success worse …").
    if (plan.resolution.degreeAdjustment != null && !(isDegreeAdjustment(plan.resolution.degreeAdjustment) && ["trait-any", "ally-of-caster"].includes(plan.resolution.degreeAdjustment.predicate?.kind)
        && plan.resolution.degreeAdjustment.sourceText === plan.compilerEvidence?.basicDegreeAdjustment) && !isResistanceHalving(plan) && !isCasterShare(plan)) return false;
    if (plan.resolution.casterShare != null && !isCasterShare(plan)) return false;
    if (plan.resolution.resistanceHalving != null && !isResistanceHalving(plan)) return false;
    return SAVE_DEGREES.every(degree => {
        const outcome = plan.resolution.outcomes?.[degree];
        const multiplier = basicSaveMultiplier(degree);
        const expectedMode = multiplier === 0 ? "none" : "shared";
        return outcome?.damage?.mode === expectedMode
            && outcome.damage.multiplier === multiplier
            && (outcome.effects?.length ?? 0) === 0
            && (outcome.nativeEffects?.length ?? 0) === 0
            && (outcome.modifiers?.length ?? 0) === 0
            && (outcome.followUps?.length ?? 0) === 0
            && outcome.terminal == null;
    });
}

/** The text's extra persistent damage, of the caster's chosen type, when the caster says its condition holds. */
export function executablePersistentRider(plan) {
    const rider = plan?.resolution?.persistentRider;
    return rider == null || (plan.resolution.check?.basic === true && plan.resolution.sharedDamage?.textDerived === true
        && plan.resolution.casterChoice?.kind === "damage-type" && rider.formula === "(@item.rank)" && typeof rider.question === "string"
        && Object.keys(rider).every(key => ["question", "formula", "sourceText"].includes(key))
        && rider.sourceText === plan.compilerEvidence?.casterChoice);
}

/** A spell cast through one of the caster's thralls: where its area or reach starts, and how far the thrall can be. */
export function executableThrall(plan) {
    const thrall = plan?.targeting?.thrall;
    if (thrall == null) return true;
    const feet = value => Number.isInteger(value) && value > 0;
    const shape = thrall.origin === "emanation" ? feet(thrall.radius) && plan.targeting.area?.type === "emanation" && Number(plan.targeting.area.value) === thrall.radius
        : ["line", "cone"].includes(thrall.origin) ? feet(thrall.size) && plan.targeting.area?.type === thrall.origin && Number(plan.targeting.area.value) === thrall.size
        : thrall.origin === "within" && feet(thrall.within) && thrall.maxTargets === 1 && !plan.targeting.area;
    return shape && feet(thrall.range) && typeof thrall.destroyed === "boolean" && typeof thrall.sourceText === "string" && plan.resolution?.kind === "save";
}

const BLOODLINE_FLAGS = { draconic: "dragonBloodline", elemental: "elementalBloodline" };

/** Damage PF2e gives its bloodline type (Dragon Breath, Elemental Toss, Flurry of Claws' extra dice). */
export function executableBloodlineDamage(plan) {
    const bloodline = plan?.resolution?.bloodlineDamage;
    if (bloodline == null) return true;
    return BLOODLINE_FLAGS[bloodline.bloodline] === bloodline.flag && ["type", "extra"].includes(bloodline.part) && typeof bloodline.sourceText === "string"
        && plan.resolution.sharedDamage?.mode === "pf2e-item-damage" && plan.compilerEvidence?.bloodlineDamage?.flag === bloodline.flag
        && (bloodline.part === "type" ? (plan.resolution.sharedDamage.components ?? []).every(component => component.type === "untyped") : /^d\d+$/.test(bloodline.die ?? ""));
}

/** The caster's PF2e bloodline damage type, or null (no such bloodline choice). */
export function bloodlineDamageType(bloodline, actor) {
    const value = actor?.flags?.system?.[bloodline?.flag]?.damageType;
    return typeof value === "string" && value && value !== "untyped" ? value : null;
}

/** A rolled damage's instance types (PF2e DamageRoll JSON) include the bloodline's, and no untyped part for a type rule. */
export function bloodlineRollMatches(bloodline, types, expected) {
    if (!bloodline) return true;
    if (!expected || !types.includes(expected)) return false;
    return bloodline.part !== "type" || !types.includes("untyped");
}

/** Divine Armageddon: the void part of the one roll is vitality for undead and void-healing creatures. */
export function executableDamageSwap(plan) {
    const swap = plan?.resolution?.damageSwap;
    if (swap == null) return true;
    const components = plan.resolution.sharedDamage?.components ?? [];
    // (Divine Immolation: the second type for each creature it hurts more; the spell's one damage entry of the first.)
    if (swap.when === "more-detrimental") return /^[a-z]+$/.test(swap.from ?? "") && /^[a-z]+$/.test(swap.to ?? "") && swap.from !== swap.to && typeof swap.sourceText === "string"
        && Object.keys(swap).every(key => ["from", "to", "when", "sourceText"].includes(key)) && (plan.compilerEvidence?.detrimentalType ?? []).includes(swap.sourceText)
        && components.length === 1 && components[0].type === swap.from && components[0].category == null && plan.resolution.dualMode == null;
    // (Awaken Entropy: the force instead for a creature the void doesn't affect — PF2e's own reading, from the sentence the compiler read.)
    if (swap.when === "not-affected") return /^[a-z]+$/.test(swap.from ?? "") && /^[a-z]+$/.test(swap.to ?? "") && swap.from !== swap.to && typeof swap.sourceText === "string"
        && (plan.compilerEvidence?.growingEntropy ?? []).includes(swap.sourceText) && components.length === 1 && components[0].type === swap.from && components[0].category == null && plan.resolution.dualMode == null;
    // (Winter's Cold Embrace: spirit instead for a creature immune or resistant to cold that has no darkvision — PF2e's own immunities, resistances and senses.)
    if (swap.when === "resistant-no-darkvision") return /^[a-z]+$/.test(swap.from ?? "") && /^[a-z]+$/.test(swap.to ?? "") && swap.from !== swap.to && typeof swap.sourceText === "string"
        && (plan.compilerEvidence?.coldEmbrace ?? []).includes(swap.sourceText) && components.length === 1 && components[0].type === swap.from && components[0].category == null && plan.resolution.dualMode == null;
    // (Spiritual Torrent: the caster's own nature turns the vitality damage to void.)
    if (swap.when === "caster-undead") return swap.from === "vitality" && swap.to === "void" && typeof swap.sourceText === "string"
        && plan.resolution.sharedDamage?.mode === "pf2e-item-damage" && components.length === 1 && components[0].type === "vitality" && components[0].category == null
        && plan.compilerEvidence?.energyByCreature?.mode === "damage-swap" && plan.resolution.dualMode == null;
    return swap.from === "void" && swap.to === "vitality" && swap.when === "undead-or-void-healing" && typeof swap.sourceText === "string"
        && plan.resolution.sharedDamage?.mode === "pf2e-item-damage" && components.some(component => component.type === "void" && component.category == null)
        && plan.compilerEvidence?.energyByCreature?.mode === "damage-swap" && plan.resolution.dualMode == null;
}

/** The void/vitality swap for this creature: an undead, or one with void healing. */
export function damageSwapApplies(swap, actor) {
    if (!swap) return false;
    if (swap.when === "more-detrimental") return moreDetrimental(actor, swap.from, swap.to);
    if (swap.when === "resistant-no-darkvision") { const attributes = actor?.attributes ?? actor?.system?.attributes ?? {};
        const shrugs = (attributes.immunities ?? []).some(entry => entry.type === swap.from) || (attributes.resistances ?? []).some(entry => entry.type === swap.from) || (typeof actor?.isAffectedBy === "function" && !actor.isAffectedBy(swap.from));
        const senses = actor?.perception?.senses ?? actor?.system?.perception?.senses ?? [];
        const sees = [...(senses?.contents ?? senses ?? [])].some(sense => ["darkvision", "greater-darkvision", "greaterDarkvision"].includes(sense?.type));
        return shrugs && !sees; }
    if (swap.when === "not-affected") { const attributes = actor?.attributes ?? actor?.system?.attributes ?? {};
        return (attributes.immunities ?? []).some(entry => entry.type === swap.from) || (typeof actor?.isAffectedBy === "function" && !actor.isAffectedBy(swap.from)); }
    const traits = actor?.traits ?? new Set(actor?.system?.traits?.value ?? []);
    return traits.has?.("undead") || actor?.hitPoints?.negativeHealing === true || actor?.system?.attributes?.hp?.negativeHealing === true;
}

/**
 * Whether the second damage type hurts this creature more than the first, by PF2e's immunities, weaknesses and resistances (an immunity or a
 * type it isn't affected by counts as none; otherwise the higher weakness less resistance; a tie keeps the first).
 */
export function moreDetrimental(actor, from, to) {
    const attributes = actor?.attributes ?? actor?.system?.attributes ?? {};
    const unaffected = type => (attributes.immunities ?? []).some(entry => entry.type === type) || (typeof actor?.isAffectedBy === "function" && !actor.isAffectedBy(type));
    if (unaffected(to)) return false;
    if (unaffected(from)) return true;
    const highest = (list, type) => Math.max(0, ...(list ?? []).filter(entry => entry.type === type).map(entry => Number(entry.value) || 0));
    const score = type => highest(attributes.weaknesses, type) - highest(attributes.resistances, type);
    return score(to) > score(from);
}

/** An evaluated roll's JSON with one damage type renamed (the dice results are kept), persistent spellings too. */
export function swapDamageType(rollJSON, from, to) {
    return JSON.parse(JSON.stringify(rollJSON).replaceAll(`[${from}]`, `[${to}]`).replaceAll(`"flavor":"${from}"`, `"flavor":"${to}"`)
        .replaceAll(`persistent,${from}]`, `persistent,${to}]`).replaceAll(`[${from},persistent]`, `[${to},persistent]`)
        .replaceAll(`"flavor":"persistent,${from}"`, `"flavor":"persistent,${to}"`).replaceAll(`"flavor":"${from},persistent"`, `"flavor":"${to},persistent"`));
}

/** Heal or harm: one PF2e item roll of void or vitality energy, from the heal-or-harm grammar. */
function executableDualMode(plan) {
    const dual = plan.resolution.dualMode;
    if (dual == null) return true;
    const components = plan.resolution.sharedDamage?.components ?? [];
    return ["void", "vitality"].includes(dual.energy) && Object.keys(dual).length === 1
        && plan.resolution.sharedDamage?.mode === "pf2e-item-damage" && components.length === 1
        && components[0].type === dual.energy && components[0].category == null
        && plan.compilerEvidence?.healOrHarm?.mode === "dual" && plan.compilerEvidence.healOrHarm.energy === dual.energy
        && !plan.resolution.conditionalDamage?.length && !plan.resolution.casterBenefit;
}

/** Damage dealt when the GM reports the trigger ("each time the target takes a hostile action"): its dice, type and frequency. */
export function isTriggeredDamage(value) {
    // "explosion": a lodged projectile's delayed blast (to the creature and those adjacent it the GM targets), doubled on a critical hit.
    if (value?.trigger === "explosion" && !([1, 2].includes(value.multiplier) && value.adjacent === true && value.frequency === "once" && value.endsSpell === true)) return false;
    // (Croak Voice's critical failure doubles the auditory damage.)
    if (value?.trigger === "auditory" && !(value.multiplier == null || value.multiplier === 2) || (value?.trigger === "auditory" && value.adjacent != null)) return false;
    if (!["explosion", "auditory"].includes(value?.trigger) && (value?.multiplier != null || value?.adjacent != null)) return false;
    // "… damage whenever it performs an auditory action or Casts a Spell": the row's own formula at the cast rank, each time.
    // ("… each time it Casts a Spell": Rend Magic's, the critical hit's doubled formula its own.)
    // ("… each time the creature takes an action with the move trait, it takes 1 force damage": Holding Glyph's, the GM reporting the action.)
    if (["auditory-or-cast", "spell-cast", "move-action"].includes(value?.trigger)) return typeof value.formula === "string" && /^(?:[\d\s()+*\/-]|@item\.(?:rank|level)|floor|ceil|d(?=\d))+$/.test(value.formula)
        && /^[a-z]+$/.test(value.type ?? "") && value.frequency === "each" && value.endsSpell === false && Number.isInteger(value.baseRank) && value.dice == null;
    // "… takes 1d8 damage per different creature it intentionally damaged on that turn … The maximum is 4d8": the GM's count, at most maxCount;
    // once, or each turn (ending after a turn with none when endsOnZero).
    if (value?.trigger === "creatures-damaged" ? !(Number.isInteger(value.maxCount) && value.maxCount > 0 && typeof value.endsOnZero === "boolean"
        && (value.frequency === "once") === value.endsSpell && !(value.endsOnZero && value.frequency === "once"))
        : value?.maxCount != null || value?.endsOnZero != null) return false;
    // "attack-result": the triggering attack's result was one of `results` (the GM reports it), once.
    if (value?.trigger === "attack-result" ? !(Array.isArray(value.results) && value.results.length > 0 && value.results.every(result => ["failure", "criticalFailure"].includes(result))
        && value.frequency === "once" && value.endsSpell === true) : value?.results != null) return false;
    // "detonate": the caster Dismisses the spell to detonate the mark (the control), once: a basic save card for the creatures within `emanation` feet of
    // the marked creature (Ymeri's Mark).
    if (value?.trigger === "detonate" && !(Number.isInteger(value.emanation) && value.emanation > 0 && value.emanation % 5 === 0 && value.frequency === "once" && value.endsSpell === true)) return false;
    if (value?.trigger !== "detonate" && value?.emanation != null) return false;
    // "ability-used": the creature used the chosen ability (the GM reports it and which kind), once a round: that variant's dice (Unravel Knowledge).
    if (value?.trigger === "ability-used") return /^[a-z]+$/.test(value.type ?? "") && value.frequency === "round" && value.endsSpell === false && Number.isInteger(value.baseRank)
        && value.dice == null && Array.isArray(value.variants) && value.variants.length >= 1 && value.variants.every(variant => typeof variant.label === "string" && Number.isInteger(variant.dice)
            && variant.dice > 0 && [4, 6, 8, 10, 12].includes(variant.die) && (variant.heightening == null || (Number.isInteger(variant.heightening.interval) && variant.heightening.interval > 0 && Number.isInteger(variant.heightening.dice))));
    if (value?.trigger !== "ability-used" && value?.variants != null) return false;
    // "noncompliance": it didn't comply with the caster's demand in time (the GM reports it), once: the row's persistent damage and conditions (Over the Coals).
    if (value?.trigger === "noncompliance" && !(value.persistent === true && value.frequency === "once" && value.endsSpell === true && Array.isArray(value.conditions)
        && value.conditions.every(condition => /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(condition.uuid ?? "") && /^[a-z-]+$/.test(condition.slug ?? "")
            && Number.isInteger(condition.value) && condition.value >= 1 && condition.value <= 4))) return false;
    if (value?.trigger !== "noncompliance" && value?.conditions != null) return false;
    // "spell-cast-rank": it Cast a Spell (the GM reports it and that spell's rank): `perRank` × that rank of `type` damage — once (the note ends), or each
    // time; optionally a condition for a time each time (Old-Mage's Echo's Deafened until the start of its next turn).
    if (value?.trigger === "spell-cast-rank") return Number.isInteger(value.perRank) && value.perRank > 0 && /^[a-z]+$/.test(value.type ?? "") && ["once", "each"].includes(value.frequency)
        && value.endsSpell === (value.frequency === "once") && Number.isInteger(value.baseRank) && value.dice == null && value.formula == null
        && (value.timedCondition == null || (/^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(value.timedCondition.uuid ?? "") && /^[a-z-]+$/.test(value.timedCondition.slug ?? "")
            && value.timedCondition.duration?.value === 1 && value.timedCondition.duration.unit === "rounds" && ["turn-start", "turn-end"].includes(value.timedCondition.duration.expiry)));
    if (value?.trigger !== "spell-cast-rank" && (value?.perRank != null || value?.timedCondition != null)) return false;
    // "bleed-gained": it gained persistent damage of `persistentType` (the GM reports it and its amount), once a round: that amount as `type` damage
    // (Achaekek's Clutch).
    if (value?.trigger === "bleed-gained") return /^[a-z]+$/.test(value.persistentType ?? "") && /^[a-z]+$/.test(value.type ?? "") && value.frequency === "round"
        && value.endsSpell === false && Number.isInteger(value.baseRank) && value.dice == null && value.formula == null;
    // "strike-wound": a single Strike would deal it at least `threshold` damage of one of `types` (the GM reports it and the type), once a round: the
    // row's formula of that type, and optionally an extra persistent roll (Bloodspray Curse).
    if (value?.trigger === "strike-wound") {
        const formulaOk = formula => typeof formula === "string" && /^(?:[\d\s()+*\/-]|@item\.(?:rank|level)|floor|ceil|d(?=\d))+$/.test(formula);
        return formulaOk(value.formula) && Array.isArray(value.types) && value.types.length === 2 && value.types.every(type => /^[a-z]+$/.test(type)) && Number.isInteger(value.threshold)
            && value.frequency === "round" && value.endsSpell === false && Number.isInteger(value.baseRank) && value.dice == null
            && (value.extra == null || (formulaOk(value.extra.formula) && /^[a-z]+$/.test(value.extra.type ?? "") && value.extra.persistent === true));
    }
    // "weapon-hit": the target weapon hit the creature (the GM reports it) — once, or each hit as persistent damage; a critical hit may also give a
    // condition, while that persistent damage lasts or not (Implement of Destruction).
    if (value?.trigger === "weapon-hit" ? !(["once", "each"].includes(value.frequency) && (value.persistent == null || (value.persistent === true && value.frequency === "each"))
        && (value.criticalCondition == null || (value.persistent === true && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(value.criticalCondition.uuid ?? "")
            && /^[a-z-]+$/.test(value.criticalCondition.slug ?? "") && Number.isInteger(value.criticalCondition.value) && value.criticalCondition.value >= 1 && typeof value.criticalCondition.whilePersistent === "boolean")))
        : (value?.persistent != null && !["noncompliance", "spell-affected"].includes(value?.trigger)) || value?.criticalCondition != null) return false;
    // "spell-affected": it became affected by a spell with a duration (the GM reports it), each time: the row's persistent damage (Spellwrack).
    if (value?.trigger === "spell-affected" && !(value.persistent === true && value.frequency === "each" && value.endsSpell === false)) return false;
    // "cage-broken": the creature Escaped or its cage was destroyed (the GM reports it), once, ending the cage (Skyglass Prison).
    if (value?.trigger === "cage-broken" && !(value.frequency === "once" && value.endsSpell === true)) return false;
    return value != null && ["hostile-action", "no-move", "no-escape", "explosion", "creatures-damaged", "daily", "hourly", "auditory", "attack-against-caster", "attack-result", "cage-broken", "weapon-hit", "noncompliance", "detonate", "spell-affected", "no-seek"].includes(value.trigger)
        // (Weaponize Secret: the discharge also ends the creature's persistent damage of that type.)
        && (value.endsPersistent == null || (value.trigger === "attack-against-caster" && /^[a-z]+$/.test(value.endsPersistent))) && Number.isInteger(value.dice) && value.dice > 0 && [4, 6, 8, 10, 12].includes(value.die)
        && /^[a-z]+$/.test(value.type ?? "") && ["once", "round", "each"].includes(value.frequency) && typeof value.endsSpell === "boolean"
        && Number.isInteger(value.baseRank) && (value.heightening == null || (Number.isInteger(value.heightening.interval) && value.heightening.interval > 0
            && Number.isInteger(value.heightening.dice) && value.heightening.dice > 0));
}

/** A creature-dependent degree map keyed by a PF2e trait list or a GM question. */
export function isDegreeAdjustment(adjustment) {
    const predicate = adjustment?.predicate;
    const validPredicate = (predicate?.kind === "trait-any" && Array.isArray(predicate.traits) && predicate.traits.length > 0
            && predicate.traits.every(trait => typeof trait === "string" && trait.length > 0))
        || (predicate?.kind === "gm-confirmed" && typeof predicate.question === "string" && predicate.question.length > 0)
        // (The caster sharing the save: "You get a degree of success one better than you rolled for your saving throw.")
        || predicate?.kind === "caster"
        // (The caster's allies: "Allies within the storm who roll a success … get a critical success instead" — the caster filled in at the cast.)
        || predicate?.kind === "ally-of-caster"
        // (Shadow Army: a creature holding this spell's note — its critical success — saves a degree better; the spell's item filled in at the cast.)
        || (predicate?.kind === "note-held" && typeof predicate.label === "string" && predicate.label.length > 0)
        // (Read from PF2e's immunities: "Creatures that are immune to fire, … one degree of success better.")
        || (predicate?.kind === "immunity-any" && Array.isArray(predicate.immunities) && predicate.immunities.length > 0
            && predicate.immunities.every(type => typeof type === "string" && type.length > 0))
        || (predicate?.kind === "trait-or-gm-confirmed" && Array.isArray(predicate.traits) && predicate.traits.length > 0
            && predicate.traits.every(trait => typeof trait === "string" && trait.length > 0)
            && typeof predicate.question === "string" && predicate.question.length > 0)
        // (Two described shifts, worse and better: the GM picks one or neither for each target; the map is the "neither" one.)
        || (predicate?.kind === "gm-choice" && typeof predicate.question === "string" && Array.isArray(predicate.options) && predicate.options.length === 2
            && predicate.options.every(option => ["worse", "better"].includes(option.key) && typeof option.label === "string" && SAVE_DEGREES.every(degree => SAVE_DEGREES.includes(option.map?.[degree])))
            && new Set(predicate.options.map(option => option.key)).size === 2 && SAVE_DEGREES.every(degree => adjustment.map?.[degree] === degree));
    return validPredicate && typeof adjustment.sourceText === "string"
        && Object.keys(adjustment).every(key => ["predicate", "map", "sourceText"].includes(key))
        && SAVE_DEGREES.every(degree => SAVE_DEGREES.includes(adjustment.map?.[degree]))
        && Object.keys(adjustment.map).length === 4;
}

/**
 * "… apply only half their usual fire resistance." with "Creatures that are immune to fire, … one degree of success better.": the spell's one
 * damage type, both compiled sentences, and the immune creatures' one-better map.
 */
export function isResistanceHalving(plan) {
    const halving = plan?.resolution?.resistanceHalving, adjustment = plan?.resolution?.degreeAdjustment, evidence = plan?.compilerEvidence?.basicResistanceHalving;
    const components = plan?.resolution?.sharedDamage?.components ?? [];
    return halving != null && evidence != null && Object.keys(halving).every(key => ["type", "sourceText"].includes(key))
        && halving.sourceText === evidence.halving && components.length === 1 && components[0].type === halving.type && !components[0].category
        && isDegreeAdjustment(adjustment) && adjustment.predicate.kind === "immunity-any" && adjustment.predicate.immunities.length === 1
        && adjustment.predicate.immunities[0] === halving.type && adjustment.sourceText === evidence.immune
        && adjustment.map.criticalSuccess === "criticalSuccess" && adjustment.map.success === "criticalSuccess" && adjustment.map.failure === "success" && adjustment.map.criticalFailure === "failure";
}

/**
 * A sustained storm the card places after a basic save when cast (Ice Storm): difficult terrain with damage at the end of a creature's turn
 * (a formula of the cast rank only), its compiled sentences, and notes.
 */
export function isStormArea(plan) {
    const terrain = plan?.resolution?.areaTerrain, evidence = plan?.compilerEvidence?.stormArea, hazard = terrain?.hazard;
    return terrain != null && Array.isArray(evidence) && terrain.sustained === true && plan.resolution.check?.basic === true && plan.lifecycle?.sustained === true
        && Object.keys(terrain).every(key => ["durationSeconds", "sourceText", "sustained", "hazard", "notes"].includes(key)) && evidence.includes(terrain.sourceText)
        && hazard != null && Object.keys(hazard).every(key => ["events", "formula", "type", "label", "sourceText"].includes(key))
        && JSON.stringify(hazard.events) === JSON.stringify(["turn-end"]) && /^[a-z]+$/.test(hazard.type ?? "") && typeof hazard.label === "string" && evidence.includes(hazard.sourceText)
        && typeof hazard.formula === "string" && /^[0-9d+\-*/() ]*$/.test(hazard.formula.replace(/@item\.rank|floor|ceil/g, "")) && /@item\.rank/.test(hazard.formula)
        && Array.isArray(terrain.notes) && terrain.notes.every(note => typeof note === "string" && evidence.includes(note));
}

/** The caster saving with the target, one degree better (Debilitating Dichotomy): one target, a basic save, the compiled sentences. */
export function isCasterShare(plan) {
    const share = plan?.resolution?.casterShare, adjustment = plan?.resolution?.degreeAdjustment, evidence = plan?.compilerEvidence?.casterShare;
    return share != null && Array.isArray(evidence) && evidence.length === 2 && Object.keys(share).every(key => key === "sourceText") && share.sourceText === evidence[0]
        // (Or an area the caster must be in: Blood Surge.)
        && plan.resolution.check?.basic === true && (!plan.targeting?.area || plan.compilerEvidence?.casterShareArea === true)
        && isDegreeAdjustment(adjustment) && adjustment.predicate.kind === "caster" && Object.keys(adjustment.predicate).length === 1 && adjustment.sourceText === evidence[1]
        && adjustment.map.criticalSuccess === "criticalSuccess" && adjustment.map.success === "criticalSuccess" && adjustment.map.failure === "success" && adjustment.map.criticalFailure === "failure";
}

/** Call the Blood's caster part: Sickened (a value) for the living, the undead's pick of temporary Hit Points (a fraction) and Quickened, or Quickened longer. */
export function isCasterDraw(plan) {
    const draw = plan?.resolution?.casterDraw, evidence = plan?.compilerEvidence?.casterDraw;
    const uuid = value => typeof value === "string" && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(value);
    const time = value => Number.isInteger(value?.value) && value.value > 0 && ["rounds", "minutes"].includes(value.unit);
    return draw != null && Array.isArray(evidence) && draw.sourceText === evidence.join(" ") && plan.resolution.check?.basic === true && !plan.targeting?.area
        && draw.living?.slug === "sickened" && Number.isInteger(draw.living.value) && draw.living.value > 0 && uuid(draw.living.uuid)
        && draw.undead?.fraction === 0.5 && draw.undead.condition?.slug === "quickened" && uuid(draw.undead.condition.uuid)
        && time(draw.undead.withTemp) && time(draw.undead.without) && time(draw.undead.tempLasts) && evidence.includes(draw.undead.restriction);
}

/**
 * A wave's terrain the card places after the save (Weapon Tide): with 3 actions, difficult terrain; over two rounds, difficult and hazardous terrain whose
 * damage (of the caster's chosen type, a formula of the cast rank) a creature takes on entering or ending its turn there, once a turn.
 */
export function isWaveTerrain(plan) {
    const terrain = plan?.resolution?.areaTerrain, evidence = plan?.compilerEvidence?.weaponWave, hazard = terrain?.hazard;
    if (terrain == null || !Array.isArray(evidence) || !evidence.includes(terrain.sourceText) || plan.resolution.casterChoice?.kind !== "damage-type" || plan.resolution.check?.basic !== true) return false;
    if (hazard == null) return terrain.whenActions === 3 && Object.keys(terrain).every(key => ["durationSeconds", "sourceText", "whenActions"].includes(key));
    return Object.keys(terrain).every(key => ["durationSeconds", "sourceText", "hazard"].includes(key))
        && Object.keys(hazard).every(key => ["events", "oncePerTurn", "chosenType", "formula", "type", "label", "sourceText"].includes(key))
        && JSON.stringify(hazard.events) === JSON.stringify(["enter", "turn-end"]) && hazard.oncePerTurn === true && hazard.chosenType === true && hazard.type === "chosen"
        && evidence.includes(hazard.sourceText) && /^\(\d+\+floor\(\(@item\.rank-\d+\)\/\d+\)\*\d+\)d(?:4|6|8|10|12)$/.test(hazard.formula ?? "");
}

/** Shadows the card places after the save (Shadow Raid): no terrain; the caster's type to each enemy ending its turn there; the GM's disbelief halves it. */
export function isShadowTerrain(plan) {
    const terrain = plan?.resolution?.areaTerrain, evidence = plan?.compilerEvidence?.shadowRaid, hazard = terrain?.hazard;
    return terrain != null && Array.isArray(evidence) && Object.keys(terrain).every(key => ["durationSeconds", "sourceText", "noTerrain", "hazard", "disbelief", "notes"].includes(key))
        && terrain.noTerrain === true && evidence.includes(terrain.sourceText) && plan.resolution.casterChoice?.kind === "damage-type" && plan.resolution.check?.basic === true
        && hazard != null && Object.keys(hazard).every(key => ["events", "oncePerTurn", "chosenType", "formula", "type", "label", "enemiesOnly", "halvedOnDisbelief", "sourceText"].includes(key))
        && JSON.stringify(hazard.events) === '["turn-end"]' && hazard.chosenType === true && hazard.type === "chosen" && hazard.enemiesOnly === true && hazard.halvedOnDisbelief === true
        && /^\(\d+\+\d+\*min\(1,floor\(@item\.rank\/\d+\)\)\)d(?:4|6|8|10|12)$/.test(hazard.formula ?? "")
        && terrain.disbelief?.halves === true && typeof terrain.disbelief.label === "string" && evidence.some(sentence => terrain.disbelief.sourceText.startsWith(sentence))
        && Array.isArray(terrain.notes) && terrain.notes.every(note => typeof note === "string");
}

/** Bursts' hazardous terrain the card places after the save (Coral Eruption): the count, a per-square GM control of a rank formula, notes. */
export function isReefTerrain(plan) {
    const terrain = plan?.resolution?.areaTerrain, evidence = plan?.compilerEvidence?.reefTerrain, hazard = terrain?.gmHazard;
    return terrain != null && Array.isArray(evidence) && Object.keys(terrain).every(key => ["durationSeconds", "sourceText", "count", "gmHazard", "notes"].includes(key))
        && evidence.includes(terrain.sourceText) && Number.isInteger(terrain.count) && terrain.count >= 1 && terrain.count <= 3
        && hazard?.kind === "per-square" && hazard.enemiesOnly === false && /^[a-z]+$/.test(hazard.type ?? "") && evidence.includes(hazard.sourceText)
        && /^\(floor\(@item\.rank\/2\)\+\d+\)$/.test(hazard.formula ?? "") && Array.isArray(terrain.notes) && terrain.notes.every(note => evidence.includes(note));
}

/** Per-target applicability, decided at snapshot from traits or left for the GM. */
export function degreeAdjustmentFor(adjustment, actor) {
    if (!adjustment) return null;
    if (adjustment.predicate.kind === "gm-confirmed") return { status: "pending", question: adjustment.predicate.question };
    if (adjustment.predicate.kind === "gm-choice") return { status: "pending", question: adjustment.predicate.question, choices: adjustment.predicate.options.map(option => ({ key: option.key, label: option.label })) };
    // (Only the caster's own record applies it: the card sets that one.)
    if (adjustment.predicate.kind === "caster") return { status: "not-applicable", caster: true };
    // (A quasi-real caster: every target's save is a degree better.)
    if (adjustment.predicate.kind === "everyone") return { status: "applies", everyone: true };
    if (adjustment.predicate.kind === "note-held") {
        const held = (actor?.itemTypes?.effect ?? []).some(effect => { const runtime = effect.flags?.["pf2e-automatic-resolution"]?.runtime;
            return runtime?.kind === "note-effect" && runtime.sourceItemUuid === adjustment.predicate.sourceItemUuid && effect.name === `${runtime.sourceItemName}: ${adjustment.predicate.label}`; });
        return { status: held ? "applies" : "not-applicable", noteHeld: true };
    }
    if (adjustment.predicate.kind === "ally-of-caster") {
        const caster = adjustment.predicate.casterUuid ? fromUuidSync(adjustment.predicate.casterUuid) : null;
        const ally = !!caster && actor && actor.uuid !== caster.uuid && (caster.isAllyOf?.(actor) ?? false);
        return { status: ally ? "applies" : "not-applicable", ally: true };
    }
    if (adjustment.predicate.kind === "immunity-any") {
        const immune = (actor?.attributes?.immunities ?? []).some(immunity => adjustment.predicate.immunities.includes(immunity.type));
        return { status: immune ? "applies" : "not-applicable", immunities: [...adjustment.predicate.immunities] };
    }
    const traits = actorTraits(actor);
    const hasTrait = adjustment.predicate.traits.some(trait => traits.has(trait));
    // A creature without the trait may still fit the described body; the GM answers.
    if (!hasTrait && adjustment.predicate.kind === "trait-or-gm-confirmed") return { status: "pending", question: adjustment.predicate.question };
    return { status: hasTrait ? "applies" : "not-applicable", traits: [...adjustment.predicate.traits] };
}

/** Re-derive the effective degree from the raw roll unless a GM overrode it. */
export function applyDegreeAdjustment(state, target) {
    const adjustment = state.degreeAdjustment, record = target.degreeAdjustment;
    if (!adjustment || !record || !target.rolledDegree || target.degreeOverride) return;
    // (A GM choice: the chosen option's map.)
    const map = record.choice ? adjustment.predicate.options?.find(option => option.key === record.choice)?.map ?? adjustment.map : adjustment.map;
    const adjusted = record.status === "applies" ? map[target.rolledDegree] : target.rolledDegree;
    record.from = target.rolledDegree;
    record.to = adjusted;
    target.degree = adjusted;
}

/**
 * "If the target takes piercing damage, they must attempt a save": the
 * delivery damage is the plan's single structured component and every degree
 * applies it, so a creature taking none of it skips the rest of its outcome.
 */
export function isSharedDamageGate(plan) {
    const gate = plan?.resolution?.damageGate;
    const components = plan?.resolution?.sharedDamage?.components ?? [];
    return gate?.requires === "shared-damage-taken" && Object.keys(gate).every(key => ["requires", "damageType"].includes(key))
        && components.length === 1 && String(components[0].type).toLowerCase() === gate.damageType && !components[0].category
        && plan.compilerEvidence?.afflictionDelivery?.gate?.damageType === gate.damageType
        && SAVE_DEGREES.every(degree => {
            const damage = plan.resolution.outcomes?.[degree]?.damage;
            const shared = damage?.mode === "mixed" ? damage.shared : damage?.mode === "shared" ? damage : null;
            return shared?.multiplier === 1;
        });
}

/**
 * A compiled affliction handoff: one stage block, and each afflicting outcome
 * names it with a starting stage inside that block. The module records the
 * affliction; stage effects and progression remain the GM's.
 */
/**
 * A curse floor: a locked grant of the floor value on an unlimited curse
 * Effect, optionally with a situational extra condition behind a GM toggle.
 */
export function isConditionFloor(floor) {
    const slugs = ["clumsy", "drained", "enfeebled", "frightened", "sickened", "stupefied"];
    const situational = floor?.situational;
    return !!floor && slugs.includes(floor.slug) && Number.isInteger(floor.value) && floor.value >= 1 && ["curse", "spell", "while-condition", "while-persistent", "until-lifted", "fixed"].includes(floor.lifetime)
        // ("can't reduce its frightened value below 1 for 1 minute": Unspeakable Shadow.)
        && (floor.lifetime !== "fixed" || (Number.isInteger(floor.duration?.value) && floor.duration.value > 0 && ["rounds", "minutes", "hours"].includes(floor.duration.unit)))
        && (floor.lifetime === "curse" || (floor.lifetime === "until-lifted" ? typeof floor.liftedBy === "string" && floor.liftedBy.length > 3 && floor.situational == null : floor.liftedBy == null && floor.situational == null))
        && (floor.liftNote == null || (floor.lifetime === "until-lifted" && typeof floor.liftNote === "string"))
        // "… as long as it remains stupefied by this spell": only while the row's other timed condition lasts.
        && (floor.lifetime !== "while-condition" || (slugs.includes(floor.whileCondition?.slug) && floor.whileCondition.slug !== floor.slug
            && Number.isInteger(floor.whileCondition.duration?.value) && floor.whileCondition.duration.value > 0 && ["rounds", "minutes"].includes(floor.whileCondition.duration.unit)))
        // "Until it stops bleeding, …": only while the creature takes persistent damage of that type.
        && (floor.lifetime !== "while-persistent" || /^[a-z]+$/.test(floor.persistentDamage ?? "")) && (floor.persistentDamage == null || floor.lifetime === "while-persistent")
        // "… while the spell is active and the target can hear you": a GM-judged qualifier, only on a spell's floor.
        && (floor.whileText == null || (floor.lifetime === "spell" && floor.whileText === "the target can hear you"))
        && Array.isArray(floor.sourceTexts) && floor.sourceTexts.length >= 1
        && (floor.liftedBy == null || typeof floor.liftedBy === "string")
        && (situational == null || (situational.requires === floor.slug && typeof situational.circumstance === "string"
            && VALUED_CONDITIONS.has(situational.grant?.slug) && Number.isInteger(situational.grant.value) && situational.grant.value >= 1));
}

/** A doom drawn out over the spell's rounds (Impending Doom): later rounds' conditions and the end's damage, per failing degree. */
export function isDoomTimeline(timeline, plan) {
    if (timeline == null) return true;
    const rounds = timeline.rounds, damage = timeline.damage;
    if (!Number.isInteger(rounds) || rounds < 2 || rounds > 10 || plan?.lifecycle?.durationSpec?.unit !== "rounds" || plan.lifecycle.durationSpec.value !== rounds) return false;
    if (!(Number.isInteger(damage?.dice) && damage.dice > 0 && [4, 6, 8, 10, 12].includes(damage.faces) && /^[a-z]+$/.test(damage.type ?? "")
        && Number.isInteger(damage.perRank) && damage.perRank >= 0 && Number.isInteger(damage.baseRank) && damage.baseRank >= 1)) return false;
    const entries = Object.entries(timeline.byDegree ?? {});
    return entries.length > 0 && entries.every(([degree, entry]) => SAVE_DEGREES.includes(degree) && [0.5, 1, 2].includes(entry.multiplier)
        && Array.isArray(entry.steps) && entry.steps.length > 0 && entry.steps.every((step, index) => Number.isInteger(step.round) && step.round >= 2 && step.round <= rounds
            && (index === 0 || step.round > entry.steps[index - 1].round) && Array.isArray(step.conditions) && step.conditions.length > 0
            && step.conditions.every(condition => /^[a-z-]+$/.test(condition.slug) && (condition.value == null || (Number.isInteger(condition.value) && condition.value >= 1 && condition.value <= 4))
                && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(condition.uuid))));
}

export function isAfflictionHandoffPlan(plan) {
    const block = plan?.resolution?.afflictionHandoff;
    if (!block || typeof block.name !== "string" || !block.name.trim() || !Array.isArray(block.stages) || !block.stages.length) return false;
    if (block.immunity != null && !(Array.isArray(block.immunity.traits) && block.immunity.traits.length
        && block.immunity.traits.every(trait => typeof trait === "string" && /^[a-z-]+$/.test(trait)))) return false;
    if (!(plan.automation?.delegatedCapabilities ?? []).includes("affliction-resolution")) return false;
    // A stage's dice count from the cast rank: an expression of digits, max/min and @item.rank only.
    if (block.rankDamage != null && !Object.entries(block.rankDamage).every(([stage, entry]) => Number(stage) >= 1 && Number(stage) <= block.stages.length
        && typeof entry.count === "string" && /^[\d\s,+*()-]*(?:(?:max|min|@item\.rank)[\d\s,+*()-]*)+$/.test(entry.count) && [4, 6, 8, 10, 12].includes(entry.faces) && /^[a-z]+$/.test(entry.type))) return false;
    // (The stages for an Effect the module makes in Pseudo Afflictions' terms: one per stage, conditions by slug and value, a time or unlimited.)
    if (block.handlerStages != null && !(Object.keys(block.handlerStages).length === block.stages.length
        && Object.entries(block.handlerStages).every(([stage, entry]) => Number(stage) >= 1 && Number(stage) <= block.stages.length
            && Array.isArray(entry.conditions) && entry.conditions.length && entry.conditions.every(condition => /^[a-z-]+$/.test(condition.slug ?? "") && (condition.value == null || (Number.isInteger(condition.value) && condition.value > 0)))
            && ["rounds", "minutes", "hours", "days", "weeks", "unlimited"].includes(entry.duration?.unit) && (entry.duration.unit === "unlimited" || (Number.isInteger(entry.duration.value) && entry.duration.value > 0))))) return false;
    const choice = plan.resolution.castChoice;
    if (choice != null && !(choice.kind === "affliction-behaviour" && choice.affliction === block.name
        && Number.isInteger(choice.stage) && choice.stage >= 1 && choice.stage <= block.stages.length
        && Array.isArray(choice.options) && choice.options.length >= 2
        && choice.options.every(option => typeof option.name === "string" && option.name && typeof option.text === "string")
        && new Set(choice.options.map(option => option.name)).size === choice.options.length)) return false;
    const known = name => name === block.name;
    const duration = d => d && Number.isInteger(d.value) && d.value > 0 && ["rounds", "minutes", "hours", "days"].includes(d.unit) && Object.keys(d).length === 2;
    for (const degree of SAVE_DEGREES) {
        const outcome = plan.resolution.outcomes?.[degree];
        const immunity = outcome?.afflictionImmunity, penalty = outcome?.afflictionSavePenalty;
        if (immunity != null && !(known(immunity.name) && duration(immunity.duration) && typeof immunity.sourceText === "string")) return false;
        if (penalty != null && !(known(penalty.name) && Number.isInteger(penalty.value) && penalty.value < 0 && penalty.type === "status"
            && duration(penalty.duration) && penalty.endsOnContraction === true && typeof penalty.sourceText === "string")) return false;
    }
    const afflicting = SAVE_DEGREES.map(degree => plan.resolution.outcomes?.[degree]?.affliction).filter(Boolean);
    return afflicting.length > 0 && afflicting.every(entry => entry.name === block.name
        && Number.isInteger(entry.stage) && entry.stage >= 1 && entry.stage <= block.stages.length
        && typeof entry.sourceText === "string"
        // A stage the affliction can't pass (Curse of Death's success): at least its start, within the stages.
        && (entry.maxStage == null || (Number.isInteger(entry.maxStage) && entry.maxStage >= entry.stage && entry.maxStage <= block.stages.length))
        && Object.keys(entry).every(key => ["name", "stage", "maxStage", "sourceText"].includes(key)));
}

/** Death when this cast's own damage reduces a creature from positive HP to 0. */
export function isPostDamageDeath(terminal) {
    return terminal?.kind === "death" && terminal.threshold === 0 && terminal.requiresReductionBySource === true
        && terminal.automatic === true
        && Object.keys(terminal).every(key => ["kind", "label", "threshold", "requiresReductionBySource", "automatic"].includes(key));
}

/** Temporary HP or healing computed from this cast's confirmed damage receipts. */
export function isCasterDamageBenefit(benefit, plan) {
    const components = plan?.resolution?.sharedDamage?.components ?? [];
    // The HP-lost measure (damage and Drained's Hit Points): one target whose rows grant Drained; it may last until used.
    const hpLost = benefit?.measure === "hp-lost";
    // The damage taken, at most the Hit Points the target had (Drain Life): one target, the whole amount, for a stated time.
    const hpCapped = benefit?.measure === "hp-capped" && benefit.kind === "temp-hp" && benefit.aggregate === "single-target" && benefit.fraction === 1 && benefit.duration != null;
    // Dice for each living creature among the targets (Life-Draining Roots), for a stated time.
    if (benefit?.measure === "dice-per-living") return benefit.kind === "temp-hp" && benefit.aggregate === "per-target" && benefit.condition === "always" && benefit.fraction === 1
        && Number.isInteger(benefit.dice?.count) && benefit.dice.count > 0 && [4, 6, 8, 10, 12].includes(benefit.dice.faces)
        && Number.isInteger(benefit.duration?.value) && benefit.duration.value > 0 && ["rounds", "minutes"].includes(benefit.duration.unit)
        && Array.isArray(benefit.sourceText) && benefit.sourceText.length > 0 && components.length === 1;
    if (benefit?.measure != null && !hpCapped && !(hpLost && benefit.kind === "temp-hp" && benefit.aggregate === "single-target" && benefit.fraction === 1
        && ["failure", "criticalFailure"].some(degree => (plan.resolution.outcomes?.[degree]?.effects ?? []).some(effect => effect.kind === "condition" && effect.slug === "drained")))) return false;
    // "…; you regain Hit Points equal to half the damage the target takes." on the failure rows only (Fearful Feast): healing, no temporary HP.
    if (benefit?.kind === "heal") return Object.keys(benefit).every(key => ["kind", "aggregate", "condition", "fraction", "damageType", "duration", "sourceText", "degrees"].includes(key))
        && benefit.aggregate === "single-target" && benefit.condition === "always" && [0.5, 1].includes(benefit.fraction) && benefit.duration === null
        && Array.isArray(benefit.degrees) && benefit.degrees.length > 0 && benefit.degrees.every(degree => SAVE_DEGREES.includes(degree))
        && components.length === 1 && String(components[0].type).toLowerCase() === benefit.damageType && Array.isArray(benefit.sourceText) && benefit.sourceText.length > 0;
    // The named type's portion of several damage types (Vampiric Maiden's void damage): one target, temporary HP, from PF2e's IWR record.
    if (benefit?.portion != null) return benefit.portion === "type" && Object.keys(benefit).every(key => ["kind", "aggregate", "condition", "fraction", "damageType", "duration", "sourceText", "portion"].includes(key))
        && benefit.kind === "temp-hp" && benefit.aggregate === "single-target" && benefit.condition === "always" && [0.5, 1].includes(benefit.fraction)
        && components.length > 1 && components.filter(component => String(component.type).toLowerCase() === benefit.damageType).length === 1
        && Number.isInteger(benefit.duration?.value) && benefit.duration.value > 0 && ["rounds", "minutes"].includes(benefit.duration.unit)
        && Array.isArray(benefit.sourceText) && benefit.sourceText.length > 0;
    return benefit && Object.keys(benefit).every(key => ["kind", "aggregate", "condition", "fraction", "damageType", "duration", "sourceText", "measure"].includes(key))
        && ["temp-hp", "heal-then-temp"].includes(benefit.kind)
        && ["single-target", "max-target"].includes(benefit.aggregate)
        && ["always", "target-killed"].includes(benefit.condition)
        && (benefit.condition !== "target-killed" || isPostDamageDeath(plan.resolution.postDamageTerminal))
        && [0.5, 1].includes(benefit.fraction)
        && components.length === 1 && String(components[0].type).toLowerCase() === benefit.damageType
        && ((hpLost && benefit.duration === null) || (Number.isInteger(benefit.duration?.value) && benefit.duration.value > 0 && ["rounds", "minutes"].includes(benefit.duration.unit)))
        && Array.isArray(benefit.sourceText) && benefit.sourceText.length > 0;
}

/** The bearer ends this condition with its own Interact action, or ("for its next action") when it takes its next action. */
export function isActionEndLifetime(effect) {
    const events = effect?.endsWhen;
    return Array.isArray(events) && events.length === 1
        && events[0]?.event === "action" && (["interact", "outside-action"].includes(events[0].action) || (["next", "next-turn-action"].includes(events[0].action) && effect.expirationMode === "event" && effect.duration == null))
        && Object.keys(events[0]).every(key => ["event", "action"].includes(key))
        && (effect.expirationMode === "first" ? effect.duration?.mode === "fixed" : effect.expirationMode === "event");
}

/** Executable event lifetime: a successful Escape against the spell DC (or a Grapple: Tenebrous Freedom's shadow taken back). */
export function isEscapeLifetime(effect) {
    const events = effect?.endsWhen;
    return Array.isArray(events) && events.length === 1
        && events[0]?.event === "escape" && events[0].dc === "spell" && [undefined, "grapple"].includes(events[0].check)
        && Object.keys(events[0]).every(key => ["event", "dc", "check"].includes(key))
        && (effect.expirationMode === "first" ? effect.duration?.mode === "fixed" : effect.expirationMode === "event");
}

/**
 * A recurring end-of-turn save: "end" ends the governed conditions on a
 * success; "reduce" shortens a rounds timer by 1 on a success and ends it on a
 * critical success. It cannot be combined with other event lifetimes.
 */
export function isRecurringSaveLifetime(effect) {
    const recurring = effect?.recurringSave;
    if (!recurring) return false;
    const duration = effect.duration;
    // ("On a failed save, the slowed condition increases by 1 (or 2 on a critical failure), to a maximum of slowed 4. On a success, the slowed
    // condition decreases by 1. If at any point the slowed condition is reduced to 0, the spell ends.": the condition's value moves.)
    // (Or turning to stone at the creature's action count: Petrify's "When a creature becomes fully unable to act due to the slowed condition …, {Petrified} permanently".)
    if (recurring.atActions != null && !(effect.slug === "slowed" && recurring.atActions.slug === "petrified" && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(recurring.atActions.uuid ?? "")
        && typeof recurring.atActions.sourceText === "string" && recurring.sourceText.includes(recurring.atActions.sourceText))) return false;
    if (recurring.mode === "escalate") return Object.keys(recurring).every(key => ["timing", "mode", "statistic", "sourceText", "steps", "maximum", "atActions"].includes(key))
        && recurring.timing === "turn-end" && ["fortitude", "reflex", "will"].includes(recurring.statistic) && typeof recurring.sourceText === "string" && recurring.sourceText.length > 0
        && ["criticalSuccess", "success", "failure", "criticalFailure"].every(degree => Number.isInteger(recurring.steps?.[degree]) && Math.abs(recurring.steps[degree]) <= 2)
        && Number.isInteger(recurring.maximum) && recurring.maximum >= 1 && recurring.maximum <= 4 && VALUED_CONDITIONS.has(effect.slug) && Number.isInteger(effect.value)
        && !effect.whileCondition && effect.endsWhen == null && (duration?.mode === "fixed" || duration?.mode === "unlimited");
    // ("it can attempt a new save if it's no longer in the pressure zone": only outside the cast's lingering area — Pressure Zone.)
    if (recurring.outsideArea != null && !(recurring.outsideArea === true && recurring.mode === "end" && recurring.timing === "turn-end")) return false;
    return Object.keys(recurring).every(key => ["timing", "mode", "statistic", "sourceText", "outsideArea"].includes(key))
        // At the end of the bearer's turns, or ("At the start of each of your turns") the caster's, ending it on a success.
        && (recurring.timing === "turn-end" || (recurring.timing === "caster-turn-start" && recurring.mode === "end"))
        && ["end", "reduce"].includes(recurring.mode)
        && ["fortitude", "reflex", "will"].includes(recurring.statistic)
        && typeof recurring.sourceText === "string" && recurring.sourceText.length > 0
        // (Or lasting the sustained spell, ending early on a success: Waking Dream's Confused.)
        && !effect.whileCondition && (effect.endsWhen == null || (recurring.mode === "end" && recurring.timing === "turn-end" && isSpellLifetime(effect)))
        && (isSpellLifetime(effect) || (recurring.mode === "reduce"
            ? duration?.mode === "fixed" && duration.unit === "rounds" && Number.isInteger(Number(duration.value)) && Number(duration.value) > 0
            : duration?.mode === "fixed" || duration?.mode === "unlimited"));
}

/**
 * "Stunned for 1 round": no value, a fixed timer, and the creature can't act
 * for that time. PF2e only models valued Stunned, so the runtime grants it on
 * a clearly named timed Effect without action-debt tracking.
 */
export function isTimedStunned(effect) {
    return effect?.slug === "stunned" && effect.value == null && !effect.whileCondition && effect.endsWhen == null
        && effect.duration?.mode === "fixed" && ((effect.duration.value != null && Number.isFinite(Number(effect.duration.value)) && Number(effect.duration.value) > 0)
            // (Or rounds rolled for each creature at Finalize: "Stunned for [[/r 1d4 #rounds]]{1d4 rounds}".)
            || (effect.duration.value == null && effect.duration.unit === "rounds" && /^\d+d\d+$/.test(String(effect.duration.valueRoll ?? "")) && effect.duration.heightening == null))
        && ["rounds", "minutes"].includes(effect.duration.unit);
}

/** A condition lasting as long as the target takes the spell's persistent damage of one type. */
export function isPersistentLinkedLifetime(effect) {
    const end = effect?.endsWhen;
    return !Array.isArray(end) && end?.event === "persistent-damage-ended" && /^[a-z]+$/.test(end.damageType ?? "")
        && Object.keys(end).length === 2 && effect.expirationMode === "event" && effect.duration == null;
}

/** A condition lasting as long as a sustained spell (with a fixed maximum). */
/** "until it next gets eight hours of rest" (end), or "decreasing these conditions by 1 for each eight hours of rest" (decrement). */
export function isRestLifetime(effect) {
    const events = Array.isArray(effect?.endsWhen) ? effect.endsWhen : [];
    return events.length === 1 && events[0].event === "rest" && ["end", "decrement"].includes(events[0].mode)
        && Object.keys(events[0]).every(key => ["event", "mode"].includes(key))
        && effect.duration == null && effect.expirationMode === "event";
}

/** "… Slowed 1 while in the cloud" / "until it leaves the cloud": only in a lingering area's exposure; leaving the area ends it. */
export function isLeaveAreaLifetime(effect) {
    const events = Array.isArray(effect?.endsWhen) ? effect.endsWhen : [];
    return events.length === 1 && events[0].event === "leave-area" && Object.keys(events[0]).length === 1 && effect.expirationMode === "event" && effect.duration == null;
}

/** "Off-Guard against the triggering attack" (a reaction): until the next attack roll against the creature or the end of the current turn. */
export function isNextAttackLifetime(effect) {
    const events = Array.isArray(effect?.endsWhen) ? effect.endsWhen : [];
    const d = effect?.duration;
    return events.length === 1 && events[0].event === "next-attack" && Object.keys(events[0]).length === 1 && effect.expirationMode === "first"
        && d?.mode === "fixed" && d.value === 1 && d.unit === "rounds" && d.expiry === "turn-end" && d.anchor === "current-turn";
}

/** "The target is fascinated by the cloud.": only in a lingering area's exposure; it lasts as long as the area. */
export function isAreaLifetime(effect) {
    const events = Array.isArray(effect?.endsWhen) ? effect.endsWhen : [];
    return events.length === 1 && events[0].event === "area-ended" && Object.keys(events[0]).length === 1 && effect.expirationMode === "event" && effect.duration == null;
}

export function isSpellLifetime(effect) {
    const events = Array.isArray(effect?.endsWhen) ? effect.endsWhen : [];
    return events.length === 1 && events[0].event === "spell-ended" && [null, undefined, "first"].includes(effect.expirationMode)
        && effect.duration?.mode === "sustained" && effect.duration.maximum?.mode === "fixed"
        && Number(effect.duration.maximum.value) > 0 && typeof effect.duration.maximum.unit === "string";
}

/** "Each round at the beginning of its turn, the target becomes clumsy 1 or increases its clumsy condition by 1, to a maximum of 4." (Coral Scourge) */
/** "It can use a single action to attempt a new Fortitude save, losing the deafened condition from this spell on a success." (Pressure Zone) */
export function isConditionActionSave(effect) {
    const save = effect?.actionSave;
    return save == null || (["fortitude", "reflex", "will"].includes(save.statistic) && typeof save.sourceText === "string" && save.sourceText.length > 0 && Object.keys(save).length === 2);
}

export function isConditionGrowth(effect) {
    const growth = effect?.growth;
    if (growth == null) return true;
    return growth.timing === "turn-start" && Number.isInteger(growth.step) && growth.step >= 1 && Number.isInteger(growth.maximum) && growth.maximum >= 2 && growth.maximum <= 4
        && Number.isInteger(effect.value) && effect.value <= growth.maximum && ["end", "reduce"].includes(growth.interact) && isActionEndLifetime(effect) && effect.endsWhen[0].action === "interact"
        && (growth.atMaximum == null || (/^[a-z-]+$/.test(growth.atMaximum.slug) && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(growth.atMaximum.uuid)))
        && Array.isArray(growth.sourceText) && growth.sourceText.length > 0;
}

function isExecutableOutcomeCondition(effect) {
    if (effect?.kind !== "condition" || !effect.slug) return false;
    if (!isConditionGrowth(effect)) return false;
    if (!isConditionActionSave(effect)) return false;
    if (effect.recurringSave != null && !isRecurringSaveLifetime(effect)) return false;
    if (effect.whileCondition) {
        if (effect.duration != null || effect.expirationMode != null
            || effect.endsWhen?.event !== "condition-removed"
            || effect.endsWhen.condition !== effect.whileCondition
            || Object.keys(effect.endsWhen).some(key => !["event", "condition"].includes(key))) return false;
    } else if (isEscapeLifetime(effect) || isActionEndLifetime(effect)) {
        // "for 1 round or until it Escapes" (first) or "until it Escapes" (event).
        if (effect.expirationMode === "event") return effect.duration == null;
    } else if (isPersistentLinkedLifetime(effect)) {
        // "until they recover from their persistent fire damage": no timer; it ends with that persistent damage.
        return VALUED_CONDITIONS.has(effect.slug) ? Number.isInteger(effect.value) && effect.value >= 1 : effect.value == null;
    } else if (isRestLifetime(effect)) {
        // Rest ends or lowers it; a decrement needs a valued condition.
        if (effect.endsWhen[0].mode === "decrement" && !VALUED_CONDITIONS.has(effect.slug)) return false;
        return VALUED_CONDITIONS.has(effect.slug) ? Number.isInteger(effect.value) && effect.value >= 1 : effect.value == null;
    } else if (isNextAttackLifetime(effect)) {
        // The end of the current turn caps it; the next attack roll against the creature ends it sooner (the runtime's hook).
        return VALUED_CONDITIONS.has(effect.slug) ? Number.isInteger(effect.value) && effect.value >= 1 : effect.value == null;
    } else if (isLeaveAreaLifetime(effect) || isAreaLifetime(effect)) {
        // Leaving the lingering area ends it (the area's record removes the Effect).
        return VALUED_CONDITIONS.has(effect.slug) ? Number.isInteger(effect.value) && effect.value >= 1 : effect.value == null;
    } else if (isSpellLifetime(effect)) {
        // "for the duration of the spell" in a sustained spell: the Sustain controller ends it.
        return VALUED_CONDITIONS.has(effect.slug) ? Number.isInteger(effect.value) && effect.value >= 1 : effect.value == null;
    } else if (effect.endsWhen != null || ["event", "first"].includes(effect.expirationMode)) return false;
    if (isTimedStunned(effect)) return true;
    if (VALUED_CONDITIONS.has(effect.slug)) {
        // A value rolled for each creature at Finalize ("Drained [[/r 1d4]]").
        const rolled = effect.value == null && /^\d+d\d+$/.test(String(effect.valueRoll ?? ""));
        if (!rolled && (!Number.isInteger(effect.value) || effect.value < 1)) return false;
    } else if (effect.value != null) return false;
    if (effect.duration == null || effect.duration.mode === "unlimited") return true;
    // A duration heightened by the cast rank: whole rounds per fixed interval from the spell's rank.
    const heightening = effect.duration.heightening;
    if (heightening != null && !(effect.duration.unit === "rounds" && [heightening.increase, heightening.interval, heightening.rank].every(Number.isInteger)
        && heightening.increase >= 1 && heightening.interval >= 1 && heightening.rank >= 1 && Object.keys(heightening).length === 3)) return false;
    // Rounds rolled for each creature at Finalize ("for [[/r 1d4 #rounds]]{1d4 rounds}").
    if (effect.duration.value == null && effect.duration.valueRoll != null) return effect.duration.mode === "fixed" && effect.duration.unit === "rounds"
        && /^\d+d\d+$/.test(String(effect.duration.valueRoll)) && heightening == null;
    return effect.duration.mode === "fixed"
        && Number.isFinite(Number(effect.duration.value))
        && Number(effect.duration.value) > 0
        && typeof effect.duration.unit === "string";
}

/** Resolve dependencies within one outcome, never against the actor's aggregate condition. */
export function executableConditionLinks(effects) {
    if (!Array.isArray(effects) || !effects.every(isExecutableOutcomeCondition)) return null;
    const links = new Map();
    for (const [index, effect] of effects.entries()) {
        if (!effect.whileCondition) continue;
        const roots = effects.map((candidate, rootIndex) => ({ candidate, rootIndex }))
            .filter(({ candidate }) => candidate.slug === effect.whileCondition && !candidate.whileCondition);
        if (roots.length !== 1 || roots[0].rootIndex === index
            || effects.some(candidate => candidate.slug === effect.whileCondition && candidate.whileCondition)) return null;
        links.set(index, roots[0].rootIndex);
    }
    return links;
}

function sharedDamagePart(damage) {
    if (damage?.mode === "shared") return damage;
    return damage?.mode === "mixed" ? damage.shared : null;
}

function executableFormula(entry) {
    if (!entry || typeof entry.formula !== "string" || !entry.formula.trim()) return false;
    if (![...entry.formula.matchAll(/@([a-z0-9_.-]+)/gi)]
        .every(match => ["item.rank", "item.level"].includes(match[1].toLowerCase()))) return false;
    if (!entry.heightening) return true;
    return entry.heightening.type === "interval"
        && Number.isInteger(entry.heightening.interval)
        && entry.heightening.interval > 0
        && /^\d+d\d+$/i.test(entry.formula.replace(/\[[^\]]+\]\s*$/, ""))
        && /^\d+d\d+$/i.test(entry.heightening.formula);
}

function executableFormulaDamage(damage, rollScope = "outcome") {
    return ["formulas", "mixed"].includes(damage?.mode)
        && damage.rollScope === rollScope
        && Array.isArray(damage.formulas)
        && damage.formulas.length > 0
        && damage.formulas.every(executableFormula);
}

function certifiedInlinePersistent(plan, shared) {
    const proof = plan.compilerEvidence?.inlinePersistentDamage;
    const components = shared?.components ?? [];
    if (proof?.kind !== 'inline-persistent-plus-structured'
        || proof.persistentType !== 'bleed'
        || ![1, 2].includes(components.length)
        || proof.directComponentIds?.length !== components.length
        || JSON.stringify(proof.directComponentIds) !== JSON.stringify(components.map(component => component.id))
        || JSON.stringify(proof.directComponents) !== JSON.stringify(components.map(component =>
            ({id: component.id, formula: component.formula, type: component.type})))
        || components.some(component => component.category != null || component.applyModifier
            || component.kinds?.length !== 1 || component.kinds[0] !== 'damage'
            || !/^[1-9]\d*d(?:4|6|8|10|12)$/i.test(component.formula))
        || new Set(components.map(component => component.type)).size !== components.length
        || !/^\((?:@item\.(?:rank|level)|[1-9]\d*\*ceil\(@item\.(?:rank|level)\/[1-9]\d*\)-\d+)\)\[bleed\]$/i.test(proof.sourceFormula)
        || plan.lifecycle?.durationSpec?.mode !== 'instantaneous'
        || plan.lifecycle?.controller?.required === true) return false;
    const ids = components.map(component => component.id);
    const base = proof.sourceFormula.replace(/\[bleed\]$/i, '');
    const formulas = {
        failure: `${base}[persistent,bleed]`,
        criticalFailure: `(2*(${base}))[persistent,bleed]`
    };
    return SAVE_DEGREES.every(degree => {
        const outcome = plan.resolution.outcomes?.[degree];
        const damage = outcome?.damage;
        if (proof.sourceText?.[degree] !== outcome?.rawText
            || JSON.stringify(proof.byDegree?.[degree]) !== JSON.stringify(damage)) return false;
        if (degree === 'criticalSuccess') return damage.mode === 'none' && damage.multiplier === 0
            && damage.sourceComponentIds?.length === 0;
        if (degree === 'success') return damage.mode === 'shared' && damage.multiplier === 0.5
            && JSON.stringify(damage.sourceComponentIds) === JSON.stringify(ids);
        return damage.mode === 'mixed' && damage.rollScope === 'combined'
            && damage.shared?.multiplier === (degree === 'failure' ? 1 : 2)
            && JSON.stringify(damage.shared.sourceComponentIds) === JSON.stringify(ids)
            && damage.formulas?.length === 1
            && damage.formulas[0].source === 'description-inline'
            && damage.formulas[0].formula === formulas[degree];
    });
}

function isExecutableSecondaryOutcome(outcome) {
    if (!outcome || (outcome.manualInstructions?.length ?? 0) > 0
        || (outcome.stateChanges?.length ?? 0) > 0
        || executableConditionLinks(outcome.effects ?? []) == null) return false;
    if (outcome.terminal != null
        && !(outcome.terminal.kind === "death" && outcome.terminal.automatic === true)) return false;
    const damage = outcome.damage;
    if (damage?.mode === "none") return damage.multiplier === 0;
    if (damage?.mode === "primary-shared") return [0.5, 1, 2].includes(damage.multiplier);
    return executableFormulaDamage(damage, "secondary-outcome");
}

function isExecutableImmediateSecondarySave(followUp) {
    return followUp?.kind === "save"
        // (Asked first when the text says when: Unhelpful Nudge's collision — the GM's question.)
        && (followUp.gate == null || (followUp.gate.kind === "gm-question" && typeof followUp.gate.question === "string" && typeof followUp.gate.sourceText === "string"
            && Object.keys(followUp.gate).every(key => ["kind", "question", "sourceText"].includes(key))))
        && followUp.complete === true
        && followUp.timing?.event === "after-primary-outcome"
        && followUp.timing.recurring === false
        && !!followUp.check?.statistic
        // A penalty or bonus the text gives this second save ("take a -2 circumstance penalty to this Fortitude save").
        && (followUp.check.modifier == null || (["circumstance", "status"].includes(followUp.check.modifier.type) && Number.isInteger(followUp.check.modifier.value)
            && followUp.check.modifier.value !== 0 && Math.abs(followUp.check.modifier.value) <= 4 && typeof followUp.check.modifier.sourceText === "string"))
        && followUp.decisionWindows?.nativeRollDialog === true
        && followUp.decisionWindows?.provisionalResult === true
        && SAVE_DEGREES.every(degree => isExecutableSecondaryOutcome(followUp.outcomes?.[degree]));
}

/** One capability assessment drives both routing and the coverage worklist. */
export function inspectDegreeSavePlan(plan) {
    const blockers = [];
    const block = (code, path, message) => blockers.push({code, path, message});
    const result = () => ({supported: blockers.length === 0, route: "degree-save", blockers});
    if (plan?.resolution?.kind !== "save" || !plan.resolution.check?.statistic) {
        block("primary-save", "resolution.check", "A compiled primary saving throw is required.");
        return result();
    }
    if (!executableActorTargetConstraints(plan)) block("target-eligibility", "targeting.actorConstraints", "Actor targeting has unsupported or incomplete eligibility rules.");
    if (!executableConditionalDamage(plan)) block("conditional-damage", "resolution.conditionalDamage", "Trait-conditional extra damage is malformed or has no shared damage to scale with.");
    if (!executableThrall(plan)) block("thrall", "targeting.thrall", "A spell cast through a thrall needs its origin, range and reach.");
    if (!executableBloodlineDamage(plan)) block("bloodline-damage", "resolution.bloodlineDamage", "Bloodline damage needs PF2e's own damage roll and a known bloodline.");
    if (plan.targeting?.actorConstraints?.mutualWithin != null && !(Number.isInteger(plan.targeting.actorConstraints.mutualWithin) && plan.targeting.actorConstraints.mutualWithin > 0))
        block("target-spacing", "targeting.actorConstraints.mutualWithin", "The distance between targets must be a whole number of feet.");
    if (!executableDamageSwap(plan)) block("damage-swap", "resolution.damageSwap", "The void/vitality swap is malformed or has no void damage to swap.");
    // Pushes and pulls the card asks the GM to carry out, by result.
    for (const degree of SAVE_DEGREES) {
        const move = plan.resolution.outcomes?.[degree]?.forcedMovement;
        if (move == null) continue;
        // (A pull "to the nearest empty space adjacent to you" has no distance; a move the target can refuse by falling Prone names how.)
        // "The target falls safely up to 120 feet.": a safe fall straight down.
        // "… rises 10 feet into the air." (Whirlwind): straight up, the GM's reminder.
        if (move.kind === "rise") {
            if (!(Number.isInteger(move.distance) && move.distance > 0 && move.upTo === false && move.optional === false && move.direction === "up"
                && Object.keys(move).every(key => ["kind", "distance", "upTo", "optional", "direction", "sourceText"].includes(key))
                && new RegExp(`\\brises ${move.distance} feet into the air\\.$`).test(move.sourceText ?? "")))
                block("forced-movement", `resolution.outcomes.${degree}.forcedMovement`, "A rise must be the stated distance up.");
            continue;
        }
        if (move.kind === "fall") {
            if (!(Number.isInteger(move.distance) && move.distance > 0 && move.upTo === true && move.optional === false && move.direction === "down" && move.safe === true
                && Object.keys(move).every(key => ["kind", "distance", "upTo", "optional", "direction", "safe", "sourceText"].includes(key))
                && new RegExp(`^The (?:target|creature) falls safely up to ${move.distance} feet\\.$`).test(move.sourceText ?? "")))
                block("forced-movement", `resolution.outcomes.${degree}.forcedMovement`, "A fall must be the stated safe fall.");
            continue;
        }
        if (!(["push", "pull"].includes(move.kind) && ((Number.isInteger(move.distance) && move.distance > 0) || (move.kind === "pull" && move.toAdjacent === true && move.distance == null)
            // ("… and is drawn to the center of the whirlpool": all the way to the area's centre.)
            || (move.kind === "pull" && move.toCenter === true && move.direction === "center" && move.distance == null)) && typeof move.upTo === "boolean"
            && (move.avoid == null || ["prone", "hazard-prone"].includes(move.avoid))
            && typeof move.optional === "boolean" && ["any", "away", "toward", "center", "from-center", "chosen"].includes(move.direction)
            && (move.note == null || /^\d+ feet through a body of water$/.test(move.note))
            // ("Creatures that fail their save are pushed …" only in the 3-action cast of a "2 to 3" variant: the GM's reminder says so.)
            && (move.actions == null || (move.actions === 3 && String(plan.activation?.time ?? "").trim() === "2 to 3"))
            // Only creatures with a trait are pushed ("undead creatures are also knocked back"); the card checks each target.
            && (move.trait == null || /^[a-z-]+$/.test(move.trait))
            // The distance set by the Strikes' hits ("5 feet for each normal hit …, plus 10 feet for each critical hit"), times the row's multiple.
            && (move.perHit == null || (Number.isInteger(move.perHit.normal) && Number.isInteger(move.perHit.critical) && [0.5, 1, 2].includes(move.perHit.multiplier)
                && plan.resolution.castGate != null && move.distance === move.perHit.normal))))
            block("forced-movement", `resolution.outcomes.${degree}.forcedMovement`, "A push or pull must name its kind, distance and direction.");
    }
    // GM reminders the card shows (counteracting light or darkness along a ray); only known kinds.
    const reminders = plan.resolution.reminders;
    // The caster's own Effect while a sustained attack spell lasts (Sign of Conviction): the stated status bonus to AC and saves and a granted condition.
    // Crystallized Vapors: the caster's emanation of difficult terrain (the caster exempt), its stated radius and sentence.
    const terrainAura = plan.resolution.terrainAura;
    if (terrainAura != null && !(plan.resolution.check?.statistic === "spell-attack" && plan.resolution.repeatable?.window === "sustain" && Number.isInteger(terrainAura.radius) && terrainAura.radius > 0
        && terrainAura.exemptCaster === true && typeof terrainAura.sourceText === "string" && terrainAura.sourceText === plan.compilerEvidence?.terrainAura))
        block("terrain-aura", "resolution.terrainAura", "The caster's terrain emanation needs its stated radius and sentence.");
    // The shared damage only for creatures with one of the named traits (Life's Flowing River's undead and nindoru), from the sentence the compiler read.
    const damageTraits = plan.resolution.damageTraits;
    if (damageTraits != null && !(Array.isArray(damageTraits.traits) && damageTraits.traits.length > 0 && damageTraits.traits.every(trait => /^[a-z-]+$/.test(trait))
        && typeof damageTraits.sourceText === "string" && damageTraits.sourceText === plan.compilerEvidence?.damageTraits && plan.resolution.sharedDamage != null))
        block("damage-traits", "resolution.damageTraits", "Damage for some creatures only needs the traits and the sentence that names them.");
    const castEffect = plan.resolution.castEffect;
    if (castEffect != null && !(plan.resolution.check.statistic === "spell-attack" && plan.resolution.repeatable?.window === "sustain" && castEffect.claimText === plan.compilerEvidence?.castEffect
        && Array.isArray(castEffect.rules) && castEffect.rules.length === 3 && castEffect.rules.every(rule => (rule.key === "FlatModifier" && ["ac", "saving-throw"].includes(rule.selector) && rule.type === "status" && Number.isInteger(rule.value) && rule.value > 0)
            || (rule.key === "GrantItem" && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(rule.uuid) && rule.inMemoryOnly === true))
        && Array.isArray(castEffect.notes)))
        block("cast-effect", "resolution.castEffect", "The caster's Effect needs the stated bonus to AC and saves and its condition.");
    // A caster Effect from a spell attack: its clause must still be proved by the compiled Effect.
    const casterEffect = plan.resolution.casterEffect;
    if (casterEffect != null && !(plan.resolution.check.statistic === "spell-attack" && ["always", "hit"].includes(casterEffect.when)
        && typeof casterEffect.uuid === "string" && inspectCasterBenefitClaim(casterEffect.document, casterEffect.claimText, { rank: casterEffect.rank, spellDuration: casterEffect.spellDuration }).supported))
        block("caster-effect", "resolution.casterEffect", "A caster Effect needs a spell attack and an Effect that gives exactly the stated benefit.");
    // "increase the damage dice from this spell to d12s": a caster question on a basic save, answered before damage is rolled.
    // The text's extra persistent damage, of the caster's chosen type, when the caster says its condition holds.
    if (!executablePersistentRider(plan))
        block("persistent-rider", "resolution.persistentRider", "Extra persistent damage needs the text's damage, its type choice and the rank formula.");
    // The caster's own creature destroyed for the blast (Final Sacrifice's minion, Bony Barrage's thrall), and Bony Barrage's bone armor.
    if (!validSacrifice(plan)) block("sacrifice", "resolution.sacrifice", "The destroyed creature needs its kind and the compiled sentence.");
    if (plan.resolution.laterImmunityKey != null && !(plan.resolution.laterImmunityKey === plan.source?.slug && Array.isArray(plan.compilerEvidence?.enthrallRows)))
        block("later-immunity", "resolution.laterImmunityKey", "A later save's immunity needs the spell's own key.");
    // "Each of its former allies within its reach must attempt a save against pack breaker.": a card per affected creature; the same plan.
    const chain = plan.resolution.chainSave;
    // (Or one card for the whole cast, pressed on each Sustain for the creatures that came within range — Enthrall — whose own saves start no cards.)
    const perCast = chain != null && chain.perCast === true && chain.repeatable === true && chain.cascade === false && plan.lifecycle?.sustained === true
        && typeof chain.label === "string" && chain.label.length > 0
        && [plan.compilerEvidence?.enthrallRows, plan.compilerEvidence?.comedyRows].some(sentences => Array.isArray(sentences) && sentences.includes(chain.sourceText))
        && Object.keys(chain).every(key => ["perCast", "repeatable", "cascade", "label", "sourceText"].includes(key));
    // (A spread whose save is a plan of its own, for some of the target's results — Infectious Ennui — and its heightened plan.)
    const spreadPlanOk = candidate => candidate?.resolution?.kind === "save" && candidate.resolution.temporaryImmunity && candidate.resolution.chainSave == null && inspectSavePlan(candidate).supported;
    const spread = chain != null && chain.perCast === true && chain.repeatable === true && chain.cascade === false && plan.lifecycle?.sustained === true
        && typeof chain.label === "string" && chain.label.length > 0 && Array.isArray(chain.degrees) && chain.degrees.length > 0 && chain.degrees.every(degree => SAVE_DEGREES.includes(degree))
        && Array.isArray(plan.compilerEvidence?.spreadingMood) && plan.compilerEvidence.spreadingMood.includes(chain.sourceText) && spreadPlanOk(chain.spreadPlan)
        && (chain.heightened == null || (Number.isInteger(chain.heightened.rank) && chain.heightened.rank > (plan.rank ?? 0) && chain.heightened.whileSustained === true && spreadPlanOk(chain.heightened.plan)))
        && Object.keys(chain).every(key => ["perCast", "repeatable", "cascade", "label", "sourceText", "degrees", "spreadPlan", "heightened"].includes(key));
    // (A curse spreading to each creature that casts a stated tradition's spell on an affected one — Spiritual Epidemic: no immunity, each card repeatable.)
    const curseSpread = chain != null && chain.repeatable === true && Array.isArray(chain.degrees) && chain.degrees.length > 0 && chain.degrees.every(degree => SAVE_DEGREES.includes(degree))
        && typeof chain.label === "string" && chain.label.length > 0 && Array.isArray(plan.compilerEvidence?.spreadingCurse) && plan.compilerEvidence.spreadingCurse.includes(chain.sourceText)
        && Object.keys(chain).every(key => ["degrees", "label", "sourceText", "repeatable"].includes(key));
    if (chain != null && !perCast && !spread && !curseSpread && !(Array.isArray(chain.degrees) && chain.degrees.length > 0 && chain.degrees.every(degree => SAVE_DEGREES.includes(degree)) && typeof chain.label === "string" && chain.label.length > 0
        && plan.resolution.temporaryImmunity && Array.isArray(plan.compilerEvidence?.packBreaker) && plan.compilerEvidence.packBreaker.includes(chain.sourceText)
        && Object.keys(chain).every(key => ["degrees", "label", "sourceText"].includes(key))))
        block("chain-save", "resolution.chainSave", "A chained save needs its results, its immunity and the compiled sentence.");
    if (!validBoneArmor(plan)) block("bone-armor", "resolution.boneArmor", "The bone armor needs its thrall, the compiled sentence and its AC bonus.");
    if (!validConstellations(plan)) block("constellations", "resolution.constellations", "The constellations need their area, save and a damage type of the choice.");
    const diceUpgrade = plan.resolution.diceUpgrade;
    const upgradeSource = (plan.resolution.check.basic === true && typeof plan.compilerEvidence?.basicDiceUpgrade === "string")
        // (A degree save's die by what the target is: Crisis of Faith's d8 for a divine spellcaster.)
        || (plan.resolution.check.basic === false && Array.isArray(plan.compilerEvidence?.faithCrisis))
        // (A spell attack's sunlight upgrade: Sun Blade.)
        || (plan.resolution.check.statistic === "spell-attack" && typeof plan.compilerEvidence?.attackDiceUpgrade === "string");
    // (Or dice the caster's yes adds — "If you are a gug, increase the piercing damage by 2d6 and … Persistent Bleed Damage … by 1d8.": a
    // spell attack's one damage type and its critical persistent damage.)
    const dieOk = dice => dice && Number.isInteger(dice.count) && dice.count > 0 && [4, 6, 8, 10, 12].includes(dice.faces) && /^[a-z]+$/.test(dice.type ?? "");
    const addsOk = diceUpgrade?.adds != null && ((plan.resolution.check.statistic === "spell-attack" && typeof plan.compilerEvidence?.casterForm === "string" && dieOk(diceUpgrade.adds.persistent))
            // (Or a basic save's dice the caster's yes adds — "If … is cast outside under a cloudy or stormy sky, increase the bolt's damage by 2d12": Draw the Lightning.)
            || (plan.resolution.check.basic === true && Array.isArray(plan.compilerEvidence?.drawLightning) && plan.compilerEvidence.drawLightning.includes(diceUpgrade.sourceText) && diceUpgrade.adds.persistent == null))
        && diceUpgrade.faces == null && dieOk(diceUpgrade.adds.dice)
        && (plan.resolution.sharedDamage?.components ?? []).length === 1 && String(plan.resolution.sharedDamage.components[0].type).toLowerCase() === diceUpgrade.adds.dice.type;
    if (diceUpgrade != null && !addsOk && !(upgradeSource && diceUpgrade.adds == null && [4, 6, 8, 10, 12].includes(diceUpgrade.faces) && typeof diceUpgrade.question === "string" && diceUpgrade.question.length > 0))
        block("dice-upgrade", "resolution.diceUpgrade", "A damage-dice upgrade needs a basic save (or its spell attack) and a question.");
    // A Sustain's flat damage to the targets this cast still holds, renewing the hold (Lightning Lasso): a sustained degree save, its failing rows (holding
    // that condition until the caster's turn or an Escape), a rank formula and the compiled sentence.
    const hold = plan.resolution.sustainHold;
    if (hold != null && !(plan.resolution.check.basic === false && plan.lifecycle?.sustained === true && Array.isArray(hold.degrees) && hold.degrees.length > 0
        && hold.degrees.every(degree => (plan.resolution.outcomes?.[degree]?.effects ?? []).some(effect => effect.slug === hold.slug && isEscapeLifetime(effect)))
        && /^\(@item\.rank -\d\)\*\d$/.test(hold.formula ?? "") && /^[a-z]+$/.test(hold.type ?? "") && Array.isArray(plan.compilerEvidence?.sustainedLasso)
        && plan.compilerEvidence.sustainedLasso.includes(hold.sourceText)))
        block("sustain-hold", "resolution.sustainHold", "A Sustain's damage to held targets needs a sustained save's held rows, a rank formula and its sentence.");
    // The mark's explosion (Ymeri's Mark): a degree save's one damage entry, its compiled sentence, and an executable basic save of it.
    const detonation = plan.resolution.detonation;
    if (detonation != null && !(plan.resolution.check.basic === false && (plan.resolution.sharedDamage?.components ?? []).some(component => component.id === detonation.componentId)
        && ["fortitude", "reflex", "will"].includes(detonation.statistic) && Number.isInteger(detonation.emanation) && Array.isArray(plan.compilerEvidence?.detonatingMark)
        && plan.compilerEvidence.detonatingMark.includes(detonation.sourceText) && inspectSavePlan(detonationPlan(plan)).supported))
        block("detonation", "resolution.detonation", "The mark's explosion needs the spell's damage, its sentence and an executable basic save.");
    // A basic save on each round's first Sustain for the targets whose save failed (Steal Shadow): a sustained degree save, its failing rows, the
    // compiled sentence, and an executable basic save of the spell's one damage entry.
    // (Targeted Ward: the caster's bonus against the opponent by its save's row, from the sentences the compiler read.)
    const ward = plan.resolution.casterWard;
    if (ward != null && !(plan.resolution.check.basic === false && SAVE_DEGREES.every(degree => Number.isInteger(ward.byDegree?.[degree]) && ward.byDegree[degree] >= 0 && ward.byDegree[degree] <= 4)
        && Number.isInteger(ward.heightened?.rank) && Number.isInteger(ward.heightened?.add) && Number.isInteger(ward.seconds) && ward.seconds > 0 && typeof ward.toggle === "boolean"
        && (plan.compilerEvidence?.casterWard ?? []).includes(ward.sourceText) && (ward.note == null || (plan.compilerEvidence?.casterWard ?? []).some(sentence => sentence.endsWith(ward.note)))
        && SAVE_DEGREES.every(degree => !(plan.resolution.outcomes?.[degree]?.effects ?? []).length)))
        block("caster-ward", "resolution.casterWard", "The caster's ward needs each row's bonus, its time and the sentences the compiler read.");
    // (Technomancy Ray: the text's base die replaced by the caster's skill rank's, from the sentence the compiler read.)
    const skillDie = plan.resolution.skillDie;
    if (skillDie != null && !(/^[a-z]+$/.test(skillDie.skill ?? "") && [4, 6, 8, 10, 12].includes(skillDie.base) && Object.entries(skillDie.byRank ?? {}).length > 0
        && Object.entries(skillDie.byRank).every(([rank, faces]) => [1, 2, 3, 4].includes(Number(rank)) && [4, 6, 8, 10, 12].includes(faces) && faces > skillDie.base)
        && skillDie.sourceText === plan.compilerEvidence?.skillDie && plan.resolution.sharedDamage?.mode === "formula" && new RegExp(`d${skillDie.base}\\[untyped\\]$`).test(plan.resolution.sharedDamage.formula ?? "")))
        block("skill-die", "resolution.skillDie", "A die set by the caster's skill needs the text's dice and the sentence the compiler read.");
    // (Warped Visage: one ally of a target that failed saves on the first Sustain each turn — its own plan with the immunity, from the sentence the compiler read.)
    const allySave = plan.resolution.sustainAllySave;
    if (allySave != null && !(plan.resolution.check.basic === false && plan.lifecycle?.sustained === true && Number.isInteger(allySave.radius) && allySave.radius > 0
        && Array.isArray(allySave.degrees) && allySave.degrees.length > 0 && allySave.degrees.every(degree => ["failure", "criticalFailure"].includes(degree))
        && (plan.compilerEvidence?.sustainAllySave ?? []).includes(allySave.sourceText) && allySave.plan?.resolution?.kind === "save" && allySave.plan.resolution.temporaryImmunity
        && !allySave.plan.resolution.sustainAllySave && !allySave.plan.lifecycle?.sustained && inspectSavePlan(allySave.plan).supported))
        block("sustain-ally-save", "resolution.sustainAllySave", "A Sustain's save for a target's ally needs the failing rows, its distance, the compiled sentence and its own executable plan.");
    const sustainStrike = plan.resolution.sustainStrike;
    if (sustainStrike != null && !(plan.resolution.check.basic === false && plan.lifecycle?.sustained === true && Array.isArray(sustainStrike.degrees) && sustainStrike.degrees.length > 0
        && sustainStrike.degrees.every(degree => ["failure", "criticalFailure"].includes(degree)) && ["fortitude", "reflex", "will"].includes(sustainStrike.statistic)
        && (plan.resolution.sharedDamage?.components ?? []).length === 1 && typeof sustainStrike.label === "string"
        && Array.isArray(plan.compilerEvidence?.shadowTheft) && plan.compilerEvidence.shadowTheft.some(sentence => sentence.includes(sustainStrike.sourceText))
        && inspectSavePlan(sustainStrikePlan(plan)).supported))
        block("sustain-strike", "resolution.sustainStrike", "A Sustain's basic save needs a sustained save's failing rows, the compiled sentence and an executable basic save.");
    // Larger dice for the targets the caster names (Remember the Lost): a basic save's one damage entry, the same type, a rank formula, the question.
    const targetUpgrade = plan.resolution.targetUpgrade;
    if (targetUpgrade != null && !(plan.resolution.check.basic === true && (plan.resolution.sharedDamage?.components ?? []).length === 1
        && String(plan.resolution.sharedDamage.components[0].type).toLowerCase() === targetUpgrade.type && !plan.resolution.diceUpgrade && !plan.resolution.lingering
        && /^\([^\[\]]+\)d(?:4|6|8|10|12)\[[a-z]+\]$/.test(targetUpgrade.formula ?? "") && targetUpgrade.formula.endsWith(`[${targetUpgrade.type}]`)
        && [...targetUpgrade.formula.matchAll(/@([a-z0-9_.]+)/gi)].every(match => ["item.rank", "item.level"].includes(match[1].toLowerCase()))
        && typeof targetUpgrade.question === "string" && targetUpgrade.question.length > 0 && typeof targetUpgrade.label === "string"
        && Array.isArray(plan.compilerEvidence?.lostNames) && plan.compilerEvidence.lostNames.includes(targetUpgrade.sourceText)))
        block("target-upgrade", "resolution.targetUpgrade", "Larger dice for named targets need a basic save, its one damage type, a rank formula and the question.");
    // Additional damage by the caster's answer: a basic save with one damage entry of that type, and whole-number choices from 0.
    const damageBonus = plan.resolution.damageBonus;
    if (damageBonus != null && !(plan.resolution.check.basic === true && typeof plan.compilerEvidence?.basicDamageBonus === "string"
        && typeof damageBonus.question === "string" && damageBonus.question.length > 0 && Array.isArray(damageBonus.choices) && damageBonus.choices[0] === 0
        && damageBonus.choices.every((choice, index) => choice === index) && damageBonus.choices.length <= 11
        && (plan.resolution.sharedDamage?.components ?? []).length === 1 && String(plan.resolution.sharedDamage.components[0].type).toLowerCase() === damageBonus.type))
        block("damage-bonus", "resolution.damageBonus", "Additional damage by the caster's answer needs a basic save, its one damage entry's type and choices from 0.");
    if (!executableAllySplit(plan)) block("ally-split", "resolution.allySplit", "Allies healed with an Effect need a stated formula and an Effect that gives exactly the stated bonus.");
    // Note Effects: a label, text and fixed duration (the compiler selected only GM/player-discretion clauses).
    for (const [degree, outcome] of Object.entries(plan.resolution.outcomes ?? {})) {
        // Notes chosen by the cast's roll: one per result, the roll's own results.
        // A form's note on a hit (the option the caster picks when casting).
        const optionNotes = (outcome?.noteEffects ?? []).filter(note => note.choiceGroup === "caster-option");
        if (optionNotes.length && !(plan.resolution.casterChoice?.kind === "option" && optionNotes.every(note => plan.resolution.casterChoice.values.includes(note.option))
            && (Array.isArray(plan.resolution.casterChoice.rows) ? plan.resolution.casterChoice.rows : ["criticalSuccess", "success"]).includes(degree)))
            block("caster-choice", `resolution.outcomes.${degree}.noteEffects`, "A form's note needs the cast's option.");
        const rolledNotes = (outcome?.noteEffects ?? []).filter(note => note.choiceGroup != null && note.choiceGroup !== "caster-option");
        if (rolledNotes.length) {
            const roll = plan.resolution.conditionRoll;
            if (!(roll?.kind === "notes" && /^1d\d+$/.test(roll.formula ?? "") && rolledNotes.length === (outcome.noteEffects ?? []).length
                && rolledNotes.every(note => note.choiceGroup === "condition-roll") && JSON.stringify(rolledNotes.map(note => note.choice)) === JSON.stringify(roll.options)
                && Object.values(roll.results ?? {}).every(choice => roll.options.includes(choice)) && !(outcome.effects ?? []).length))
                block("condition-roll", `resolution.outcomes.${degree}.noteEffects`, "Rolled notes need the cast's roll and one note per result.");
        }
        for (const note of outcome?.noteEffects ?? []) {
            if (!validNoteEffect(note)) block("note-effect", `resolution.outcomes.${degree}.noteEffects`, "A note Effect needs its text and a fixed duration.");
            // A note lasting while the persistent damage does sits on a row dealing that persistent damage.
            if (note.whilePersistent != null && !rowDealsPersistent(plan, outcome, note.whilePersistent))
                block("note-effect", `resolution.outcomes.${degree}.noteEffects`, "A note tied to persistent damage needs a row dealing it.");
            if (note.triggeredDamage != null && !isTriggeredDamage(note.triggeredDamage)) block("triggered-damage", `resolution.outcomes.${degree}.noteEffects`, "Triggered damage needs its dice, type and frequency.");
        }
    }
    // An aura around each target its row names (Fateful Condemnation): its radius and time, each row's rule for the target and its allies inside, a turn-start condition.
    const aura = plan.resolution.targetAura;
    if (aura != null && !(Number.isInteger(aura.radius) && aura.radius > 0 && aura.radius % 5 === 0 && Number.isFinite(aura.seconds) && aura.seconds > 0
        && (plan.compilerEvidence?.lastingCurse ?? []).some(sentence => sentence.endsWith(aura.sourceText)) && Object.keys(aura.byDegree ?? {}).length > 0
        && Object.entries(aura.byDegree).every(([degree, entry]) => ["success", "failure", "criticalFailure"].includes(degree) && typeof entry.label === "string" && Array.isArray(entry.rules)
            // (Tanglecurse: each row's own radius and time, and difficult terrain for everyone in it.)
            && (entry.radius == null || (Number.isInteger(entry.radius) && entry.radius > 0 && entry.radius % 5 === 0)) && (entry.seconds == null || (Number.isFinite(entry.seconds) && entry.seconds > 0))
            && (entry.terrain == null || [2, 3].includes(entry.terrain.difficulty)) && (entry.rules.length > 0 || entry.terrain != null)
            && entry.rules.every(rule => rule.key === "FlatModifier" && typeof rule.selector === "string" && ["status", "circumstance"].includes(rule.type) && Number.isInteger(rule.value) && rule.value < 0 && rule.value >= -4)
            && (entry.allyTurnCondition == null || (/^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(entry.allyTurnCondition.uuid ?? "") && Number.isInteger(entry.allyTurnCondition.value) && entry.allyTurnCondition.rounds === 1)))))
        block("target-aura", "resolution.targetAura", "An aura around the target needs its radius, time and each row's stated rule.");
    // A copy of the target fighting for the caster (Duplicate Foe): the rows that make one, its stated Hit Points (and step), its loss each turn, its time.
    const duplicate = plan.resolution.duplicate;
    if (duplicate != null && !(Object.keys(duplicate.byDegree ?? {}).length > 0 && Object.entries(duplicate.byDegree).every(([degree, entry]) => ["success", "failure", "criticalFailure"].includes(degree)
            && (entry.halfDamage == null || entry.halfDamage === true) && (entry.maxRounds == null || (Number.isInteger(entry.maxRounds) && entry.maxRounds > 0)))
        && Number.isInteger(duplicate.hp?.base) && duplicate.hp.base > 0 && Number.isInteger(duplicate.hp.step) && Number.isInteger(duplicate.hp.interval) && duplicate.hp.interval > 0
        && /^\d+d\d+$/.test(duplicate.hpLoss ?? "") && Number.isFinite(duplicate.seconds) && duplicate.seconds > 0
        && Array.isArray(plan.compilerEvidence?.creatureCopy) && plan.compilerEvidence.creatureCopy.includes(duplicate.sourceText)))
        block("duplicate", "resolution.duplicate", "A creature copy needs the rows that make it, its Hit Points, its loss each turn and the claimed text.");
    // The spell's controls (Puppet Strings' forced Strike): each part as the controls card runs it, for the rows that give them.
    const controls = plan.resolution.controls;
    if (controls != null && !(Array.isArray(controls.parts) && !inspectParts(controls.parts).length && Array.isArray(controls.degrees)
        && controls.degrees.length > 0 && controls.degrees.every(degree => ["criticalSuccess", "success", "failure", "criticalFailure"].includes(degree)) && typeof controls.label === "string"
        && Array.isArray(plan.compilerEvidence?.forcedActions) && plan.compilerEvidence.forcedActions.includes(controls.sourceText)))
        block("controls", "resolution.controls", "The spell's controls need their parts, the rows that give them and the claimed sentence.");
    // Row GM notes: only the known kinds, each claiming its exact sentence.
    // A behaviour rule (user decision): only beside something the row really applies.
    const grabbed = outcome => (outcome.effects ?? []).some(effect => effect.slug === "grabbed");
    for (const [degree, outcome] of Object.entries(plan.resolution.outcomes ?? {})) for (const note of outcome?.rowNotes ?? []) {
        const real = (outcome.effects ?? []).length > 0 || (outcome.nativeEffects ?? []).length > 0 || outcome.forcedMovement != null
            || (outcome.damage?.mode != null && outcome.damage.mode !== "none");
        const known = (note?.kind === "remaining-actions" && /^The (?:creature|target) uses its remaining actions to [a-z ,']{3,60}\.$/.test(note.sourceText ?? ""))
            || (note?.kind === "no-reactions" && /^The (?:creature|target) can't use reactions and takes /.test(note.sourceText ?? "") && real)
            // The caster's Reposition of the grabbed target, and the grabbing thing's AC and Hit Points: beside the row's Grabbed.
            || (note?.kind === "reposition" && /\bReposition\}? the (?:grabbed )?target up to \d+ feet\.$/.test(note.sourceText ?? "") && grabbed(outcome))
            // A fall the row's Prone may cause: the Arrest a Fall DC, or no Arrest a Fall and doubled falling damage.
            || (note?.kind === "fall-rider" && /^Additionally, if this spell causes the target to fall, (?:the DC to Arrest a Fall is your spell DC|the target can't Arrest a Fall, and falling damage is doubled)\.$/.test(note.sourceText ?? "")
                && (outcome.effects ?? []).some(effect => effect.slug === "prone"))
            || (note?.kind === "breakable" && /\bhas AC \d+ and \d+ Hit Points\), at which point the spell ends\.$/.test(note.sourceText ?? "") && grabbed(outcome))
            // What a death by the weakness's damage type does to the body (Incendiary Ashes): beside the row's weakness Effect.
            || (note?.kind === "reduced-to-ashes" && /^If the creature is killed by ([a-z]+) during this time it's reduced to ashes, though its gear remains\.$/.test(note.sourceText ?? "")
                && (outcome.nativeEffects ?? []).some(effect => (effect.outcomeRule?.modifiers?.weakness?.types ?? []).length))
            // Banishment: sending the creature away is the GM's (like a push), the row's whole effect.
            // An affliction's save benefit: afflictions are Pseudo Afflictions' (handed over), the row's whole effect.
            || (note?.kind === "affliction-benefit" && /^The target receives the benefit of a successful save against the lowest-level (?:disease|poison|curse) affecting it\.$/.test(note.sourceText ?? ""))
            // (The attempted action wasted, beside the row's condition: Mask of Terror.)
            || (note?.kind === "action-wasted" && note.sourceText === "Its action fails and is wasted." && real)
            // (Sent home beside the row's damage: Divine Decree.)
            || (note?.kind === "sent-home" && note.sourceText === "If you're on your home plane and the creature is not, the creature is sent back to its home plane." && real)
            || (note?.kind === "banished" && /^The target is banished(?: and can't return by any means to the plane it's banished from for \d+ (?:day|week|month|year)s?)?\.$/.test(note.sourceText ?? ""));
        if (!known) block("row-note", `resolution.outcomes.${degree}.rowNotes`, "Only known GM row notes, beside what the row applies, can accompany an automated spell.");
    }
    // Push notes (a wall's damage, a ledge) accompany a push row only.
    if ((plan.resolution.forcedMovementNotes ?? []).length && !Object.values(plan.resolution.outcomes ?? {}).some(outcome => outcome?.forcedMovement?.kind === "push"))
        block("forced-movement-notes", "resolution.forcedMovementNotes", "Push notes need a push row.");
    // Ranks whose Heightened rows aren't read are refused at cast time (the gate must be the compiler's).
    const gate = plan.resolution.rankGate;
    if (gate && !(Number.isInteger(gate.maxRank) && gate.maxRank >= plan.rank && gate.minRank === gate.maxRank + 1
        && typeof gate.sourceText === "string" && gate.sourceText === plan.compilerEvidence?.rankGate))
        block("rank-gate", "resolution.rankGate", "The heightened-rank gate is malformed.");
    // Repeated attacks: within the turn, or once on each later turn up to a stated total within a fixed duration.
    if (!validWeaponDamage(plan)) block("weapon-damage", "resolution.weaponDamage", "The weapon's damage needs the compiled sentence and its critical roll.");
    // A wave moving on at the start of the caster's next turn (Sea Surge): its compiled sentence.
    const wave = plan.resolution.waveRepeat;
    if (wave != null && !(Number.isInteger(wave.feet) && wave.feet > 0 && wave.when === "caster-turn-start" && Array.isArray(plan.compilerEvidence?.waveSurge) && plan.compilerEvidence.waveSurge.includes(wave.sourceText)))
        block("wave-repeat", "resolution.waveRepeat", "The wave's second move needs its distance and the compiled sentence.");
    if (!validRepeatable(plan))
        block("repeatable", "resolution.repeatable", "Repeated attacks need their window, total and a fixed spell duration.");
    // A hazard left in the target's squares: the region the runtime places needs every part stated.
    const hazard = plan.resolution.groundHazard;
    if (hazard) {
        const degrees = ["criticalSuccess", "success", "failure", "criticalFailure"];
        const spec = hazard.duration;
        // (Or the target's space and the squares adjacent to it: Disintegrating Puddle's hit.)
        const valid = ["target-space", "target-and-adjacent"].includes(hazard.where) && Array.isArray(hazard.degrees) && hazard.degrees.length && hazard.degrees.every(degree => degrees.includes(degree))
            && Array.isArray(hazard.events) && hazard.events.length && hazard.events.every(event => ["turn-end", "turn-start", "enter"].includes(event))
            && /^[a-z]+$/.test(hazard.damage?.type ?? "") && /^(?:(?:\([^()]+\)|\(floor\(@item\.rank\/\d\)\)|\d+)d\d+)$/.test(hazard.damage?.formula ?? "")
            && [...hazard.damage.formula.matchAll(/@([a-z0-9_.]+)/gi)].every(match => ["item.rank", "item.level"].includes(match[1].toLowerCase()))
            && typeof hazard.sourceText === "string" && hazard.sourceText === plan.compilerEvidence?.groundHazard
            && ((spec?.mode === "fixed" && Number.isInteger(spec.value) && spec.value > 0 && ["rounds", "minutes"].includes(spec.unit))
                || (spec?.mode === "turn-boundary" && spec.anchor === "target-turn" && spec.expiry === "turn-end" && spec.unit === "rounds"));
        if (!valid) block("ground-hazard", "resolution.groundHazard", "The hazard needs its squares, degrees, trigger, damage and duration.");
    }
    if (!executableCasterChoice(plan)) block("caster-choice", "resolution.casterChoice", "A caster's choice needs a stated list that every row's Effect reads.");
    // A bonus to saves against the spell for creatures of a trait (Lignify's plant creatures): the sentence the compiler read.
    const traitBonus = plan.resolution.traitSaveBonus;
    if (traitBonus != null && !(/^[a-z-]+$/.test(traitBonus.trait ?? "") && Number.isInteger(traitBonus.value) && traitBonus.value > 0 && traitBonus.value <= 4 && ["circumstance", "status"].includes(traitBonus.type)
        && Array.isArray(plan.compilerEvidence?.petrifyingRows) && plan.compilerEvidence.petrifyingRows.includes(traitBonus.sourceText)))
        block("trait-save-bonus", "resolution.traitSaveBonus", "A trait's save bonus needs its stated trait, value and sentence.");
    // A spell attack against a save's DC (Tidal Grasp): the stated statistic and sentence.
    const attackDefense = plan.resolution.attackDefense;
    if (attackDefense != null && !(plan.resolution.check?.statistic === "spell-attack" && ["fortitude", "reflex", "will"].includes(attackDefense.statistic) && typeof attackDefense.sourceText === "string"
        && Object.keys(attackDefense).every(key => ["statistic", "sourceText"].includes(key))))
        block("attack-defense", "resolution.attackDefense", "An attack against a save's DC needs its statistic and sentence.");
    // A GM-answered attack adjustment: a spell attack, choices with whole-number values, an optional persistent roll.
    // A save adjustment ("If …, it gains a +4 circumstance bonus to its save") uses the same question on a save.
    const adjustment = plan.resolution.attackAdjustment;
    const adjustedCheck = adjustment?.appliesTo === "save"
        ? ["fortitude", "reflex", "will"].includes(plan.resolution.check.statistic) && adjustment.onApplies == null && ["circumstance", "status"].includes(adjustment.modifierType)
        : plan.resolution.check.statistic === "spell-attack";
    if (adjustment != null && !(adjustedCheck && typeof adjustment.question === "string" && adjustment.question.length > 0
        && ["circumstance", "untyped", ...(adjustment.appliesTo === "save" ? ["status"] : [])].includes(adjustment.modifierType) && Array.isArray(adjustment.choices) && adjustment.choices.length >= 2
        && adjustment.choices.every(choice => typeof choice?.label === "string" && Number.isInteger(choice.value) && choice.value >= (adjustment.appliesTo === "save" ? -4 : 0) && choice.value <= 4)
        && (adjustment.onApplies == null || (/^\([^\[\]]+\)\[persistent,[a-z]+\]$|^[^\[\]]+\[persistent,[a-z]+\]$/.test(adjustment.onApplies.formula ?? "")
            && [...adjustment.onApplies.formula.matchAll(/@([a-z0-9_.]+)/gi)].every(match => ["item.rank", "item.level"].includes(match[1].toLowerCase()))))))
        block("attack-adjustment", "resolution.attackAdjustment", "An attack or save adjustment needs its check, a question and whole-number choices.");
    // Creatures of a trait gain a condition with no save (Deathless March's undead): the condition, its time and its note.
    const grant = plan.resolution.traitGrant;
    if (grant != null && !(/^[a-z-]+$/.test(grant.trait ?? "") && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(grant.uuid ?? "") && /^[a-z-]+$/.test(grant.slug ?? "")
        && Number.isInteger(grant.duration?.value) && grant.duration.value > 0 && ["rounds", "minutes"].includes(grant.duration.unit) && typeof grant.note === "string"
        && Array.isArray(plan.compilerEvidence?.traitGrant) && plan.compilerEvidence.traitGrant.includes(grant.sourceText) && plan.resolution.check?.basic === false))
        block("trait-grant", "resolution.traitGrant", "A trait's condition needs the condition, its time and the claimed sentence.");
    // A Strike-result check is only the caster's own Strike from a Strike-prelude spell.
    if (plan.resolution.check.statistic === "strike" && plan.resolution.strikePrelude?.result !== true) block("strike-check", "resolution.check.statistic", "A Strike result needs the spell's Strike.");
    // The Strike a Strike-prelude spell asks for, and where its target must be, are GM/player instructions; so is a
    // spell attack's cover and concealment rule.
    if (reminders != null && !(Array.isArray(reminders) && reminders.every(reminder => typeof reminder?.text === "string" && reminder.text.length > 0
        && ((["counteract-along-path", "counteract-overlap"].includes(reminder.kind) && ["light", "darkness"].includes(reminder.target))
            // (A stated counteract modifier and rank against the light or darkness in the area: an incarnate's part.)
            || (reminder.kind === "counteract-fixed" && ["light", "darkness"].includes(reminder.target) && Number.isInteger(reminder.modifier) && reminder.modifier > 0 && reminder.modifier <= 40
                && Number.isInteger(reminder.rank) && reminder.rank >= 1 && reminder.rank <= 10)
            || (reminder.kind === "attack-cover" && plan.resolution.check.statistic === "spell-attack")
            // (Ending the required spell and centring the area: a third-party finale, third-party-rows.js.)
            || (reminder.kind === "required-spell" && (plan.compilerEvidence?.thirdPartyPreamble ?? []).includes(reminder.sourceText))
            // (A third-party lead sentence the GM acts on: Drown's non-breathers.)
            || (reminder.kind === "third-party-note" && (plan.compilerEvidence?.thirdPartyPreamble ?? []).includes(reminder.sourceText))
            // (A third-party basic save's light left in the area, and the line's length at the cast rank: basic-feature-riders.js.)
            || (reminder.kind === "area-light" && (plan.compilerEvidence?.basicFeatureRiders ?? []).includes(reminder.sourceText))
            || (reminder.kind === "area-size" && Array.isArray(plan.compilerEvidence?.basicFeatureRiders) && /^Heightened \(\+1\)/.test(reminder.sourceText ?? ""))
            // A lodged projectile's removal (an Athletics check against the spell DC, as an Interact action).
            || (reminder.kind === "lodged-removal" && plan.resolution.check.statistic === "spell-attack" && typeof plan.compilerEvidence?.lodgedRemoval === "string"
                && reminder.sourceText === plan.compilerEvidence.lodgedRemoval)
            // Nonlethal damage against living creatures (PF2e doesn't track it).
            || (reminder.kind === "nonlethal" && typeof plan.compilerEvidence?.nonlethal === "string" && reminder.sourceText === plan.compilerEvidence.nonlethal)
            // Movement the caster makes after a spell attack (carried by the caster's Effect).
            || (reminder.kind === "caster-movement" && plan.resolution.check.statistic === "spell-attack" && plan.resolution.casterEffect != null
                && typeof plan.compilerEvidence?.casterMovement === "string" && reminder.sourceText === plan.compilerEvidence.casterMovement)
            // (Or a reaction's move away from the triggering creature after its basic save, its distance at the cast rank: Pyrefowl Rebuke.)
            || (reminder.kind === "caster-movement" && plan.resolution.check.basic === true && Array.isArray(plan.compilerEvidence?.reactionBlast)
                && reminder.sourceText === plan.compilerEvidence.casterMovement && reminder.text.includes("{feet}") && Number.isInteger(reminder.rankFeet?.base)
                && Number.isInteger(reminder.rankFeet.step) && Number.isInteger(reminder.rankFeet.interval) && reminder.rankFeet.interval > 0 && Number.isInteger(reminder.rankFeet.baseRank))
            // A thrall the spell destroys: the GM removes its token.
            || (reminder.kind === "thrall-destroyed" && plan.targeting?.thrall?.destroyed === true)
            // The area shape the caster chose from the spell's list (the caster targets the creatures in it).
            || (reminder.kind === "area-choice" && plan.resolution.check.statistic !== "spell-attack" && Array.isArray(plan.compilerEvidence?.areaChoice))
            || (["strike-prelude", "strike-placement"].includes(reminder.kind) && plan.resolution.strikePrelude != null)
            // Unattended objects in the area also take the damage (the module damages creatures only).
            || (reminder.kind === "object-damage" && plan.compilerEvidence?.objectDamage === true && plan.resolution.check.basic === true)
            // (A teleport the caster chooses, on a reworded table: Sudden Transposition.)
            || (reminder.kind === "teleport" && Array.isArray(plan.compilerEvidence?.savedRows) && plan.compilerEvidence.savedRows.join(" ") === reminder.sourceText)
            // (The object holding a creature, its statistics from a reworded row: Arctic Rift's ice.)
            || (["object-hold", "area-shape"].includes(reminder.kind) && Array.isArray(plan.compilerEvidence?.savedRows) && plan.compilerEvidence.savedRows.includes(reminder.sourceText))
            // Where the spell's projectile goes, when the save depends on where it explodes (the cast's gate).
            || (reminder.kind === "placement" && plan.resolution.castGate != null && typeof plan.compilerEvidence?.placement === "string" && reminder.sourceText === plan.compilerEvidence.placement)
            || (reminder.kind === "caster-elects-success" && typeof plan.compilerEvidence?.casterElectsSuccess === "string" && reminder.sourceText === plan.compilerEvidence.casterElectsSuccess)
            || (reminder.kind === "willing-choice" && typeof plan.compilerEvidence?.willingChoice === "string" && reminder.sourceText === plan.compilerEvidence.willingChoice)
            // "An unwilling target can attempt a … save": the GM sets a willing target's result.
            || (reminder.kind === "willing-no-save" && typeof plan.compilerEvidence?.willingNoSave === "string" && reminder.sourceText === plan.compilerEvidence.willingNoSave)
            // The traits a spell gains for the saving creatures (Deathless March): their immunities and bonuses (the GM's).
            || (reminder.kind === "trait-note" && Array.isArray(plan.compilerEvidence?.traitGrant) && plan.compilerEvidence.traitGrant.includes(reminder.sourceText))
            // A target with Hardness loses Hardness instead of gaining the weakness (the GM's; PF2e's Effect is the weakness only).
            || (reminder.kind === "hardness" && typeof plan.compilerEvidence?.hardness === "string" && reminder.sourceText === plan.compilerEvidence.hardness)
            // What the spell does to its surroundings (fires, fog, loose objects): the GM's.
            || (reminder.kind === "surroundings" && typeof plan.compilerEvidence?.surroundings === "string" && reminder.sourceText === plan.compilerEvidence.surroundings)
            // A conjured structure's statistics, cover and other exits, for the GM (Osseous Cage).
            || (reminder.kind === "structure" && typeof plan.compilerEvidence?.structure === "string" && reminder.sourceText === plan.compilerEvidence.structure)
            // An area-or-object spell's area branch (Grease): the skill alternative, the surface's later checks, the object branch.
            || (reminder.kind === "weapon-critical" && Array.isArray(plan.compilerEvidence?.weaponBlast) && plan.compilerEvidence.weaponBlast.includes(reminder.sourceText))
            || (["save-or-skill", "surroundings", "object-branch"].includes(reminder.kind) && Array.isArray(plan.compilerEvidence?.areaOrObject) && plan.compilerEvidence.areaOrObject.includes(reminder.sourceText))
            // An object target's Hardness on a hit, and a target that blocks the spell with an item: the GM's.
            || (reminder.kind === "object-hardness" && plan.resolution.check.statistic === "spell-attack" && reminder.sourceText === plan.compilerEvidence?.objectHardness)
            // (Piercing Jet: its damage ignores a low Hardness — the GM's, for a target with Hardness.)
            || (reminder.kind === "ignore-hardness" && plan.resolution.check.statistic === "spell-attack" && reminder.sourceText === plan.compilerEvidence?.ignoreHardness)
            || (reminder.kind === "shield-blocked" && plan.resolution.check.statistic === "spell-attack" && reminder.sourceText === plan.compilerEvidence?.shieldBlocked)
            // "Bane can counteract Bless.": the caster's counteract check against that spell, rolled from the card.
            || (reminder.kind === "counteract-spell" && /^[a-z' ]+$/.test(reminder.target ?? "") && typeof plan.compilerEvidence?.counteractSpell === "string" && reminder.sourceText === plan.compilerEvidence.counteractSpell)
            // Creatures next to the area pulled into it before the saves (the GM moves them).
            || (reminder.kind === "area-pull" && typeof plan.compilerEvidence?.areaPull === "string" && reminder.sourceText === plan.compilerEvidence.areaPull)
            // A Sustain-attack spell's movement, partners and multiple attack penalty: notes.
            || (reminder.kind === "sustain-attack-note" && Array.isArray(plan.compilerEvidence?.sustainAttack) && plan.resolution.repeatable?.window === "sustain")
            // "Willing and Unconscious targets automatically critically fail this saving throw.": the GM sets it.
            || (reminder.kind === "auto-critical-failure" && Array.isArray(plan.compilerEvidence?.appearanceSwap) && plan.compilerEvidence.appearanceSwap.includes(reminder.sourceText))
            // What an illusion's area does besides the save (entering disbelieves; the Sustain's harmless display): notes.
            || (reminder.kind === "illusion-note" && Array.isArray(plan.compilerEvidence?.illusionLure) && plan.compilerEvidence.illusionLure.includes(reminder.sourceText))
            // A metal object's Hardness lowered by the damage (Forge): the GM's.
            || (reminder.kind === "hardness-by-damage" && typeof plan.compilerEvidence?.hardnessByDamage === "string" && reminder.sourceText === plan.compilerEvidence.hardnessByDamage)
            // A form's option for the caster on a hit (Threefold Limb's Reposition): a reminder.
            || (reminder.kind === "option-note" && plan.resolution.casterChoice?.kind === "option" && plan.resolution.casterChoice.values.includes(reminder.option)
                && Array.isArray(plan.compilerEvidence?.optionAttack) && plan.compilerEvidence.optionAttack.includes(reminder.sourceText))
            // What the caster's mark means for detection (Vindicator's Mark's invisible targets): a note.
            || (reminder.kind === "mark-note" && plan.resolution.casterMark?.kind === "strike-bonus" && typeof plan.compilerEvidence?.markNote === "string" && reminder.sourceText === plan.compilerEvidence.markNote)
            // "If the target is a willing ally …, they automatically fail the save.": the GM sets that result.
            || (reminder.kind === "auto-failure" && typeof plan.compilerEvidence?.autoFailure === "string" && reminder.sourceText === plan.compilerEvidence.autoFailure)
            // The caster's movement that decides who saves (Mercurial Stride): a reminder; the GM targets the creatures passed through.
            || (reminder.kind === "caster-movement" && Array.isArray(plan.compilerEvidence?.casterMovement) && plan.compilerEvidence.casterMovement.includes(reminder.sourceText)
                && typeof reminder.text === "string" && reminder.text.length > 0)
            // A basic save's push rider (Blastback): the spared caster, and the text's heightened area where PF2e's data has none.
            // (And a reaction's limit on when it may be cast, Anathematic Reprisal's, with its example.)
            || (["caster-spared", "heightened-area", "cast-condition"].includes(reminder.kind) && Array.isArray(plan.compilerEvidence?.basicConditionRider)
                && (plan.compilerEvidence.basicConditionRider.includes(reminder.sourceText) || reminder.sourceText.split(/(?<=\.)\s+/).every(sentence => plan.compilerEvidence.basicConditionRider.includes(sentence))) && typeof reminder.text === "string" && reminder.text.length > 0)
            // A rule the GM plays, tied to one of the spell's compiled sentences (Grisly Growths' exception, Annunciation's invitation).
            // Ranger's Bramble: the borrowed rider's note (one of its own compiled sentences, unlinked).
            || (reminder.kind === "borrowed-rider-note" && typeof reminder.text === "string" && (plan.compilerEvidence?.borrowedRider?.sentences ?? []).some(sentence => sentence.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, "$1") === reminder.text))
            || (reminder.kind === "spell-note" && typeof reminder.text === "string" && reminder.text.length > 0
                && [plan.compilerEvidence?.auraModes, plan.compilerEvidence?.harrowSuits, plan.compilerEvidence?.saveModes, plan.compilerEvidence?.lingeringModes, plan.compilerEvidence?.currentLine, plan.compilerEvidence?.blastLingering, plan.compilerEvidence?.twinIllusion, plan.compilerEvidence?.areaFollowUp, plan.compilerEvidence?.sustainAllySave, plan.compilerEvidence?.invitationSave, plan.compilerEvidence?.censureRows, plan.compilerEvidence?.boundPenalty, plan.compilerEvidence?.stolenVoice, plan.compilerEvidence?.savedRows, plan.compilerEvidence?.smallSave, plan.compilerEvidence?.gmCommand, plan.compilerEvidence?.entrancedRows, plan.compilerEvidence?.trueNameCommand, plan.compilerEvidence?.reviewRows, plan.compilerEvidence?.insightRows, plan.compilerEvidence?.stasisRows, plan.compilerEvidence?.dragonRoar, plan.compilerEvidence?.hallucinationRows, plan.compilerEvidence?.luringRows, plan.compilerEvidence?.suggestionRows, plan.compilerEvidence?.nightmareSwap, plan.compilerEvidence?.weaveRows, plan.compilerEvidence?.mindRead, plan.compilerEvidence?.graspingSnakes, plan.compilerEvidence?.deadWhispers, plan.compilerEvidence?.stoneBind, plan.compilerEvidence?.faithCrisis, plan.compilerEvidence?.blameShift, plan.compilerEvidence?.stoneReshape, plan.compilerEvidence?.wakingVisions, plan.compilerEvidence?.enthrallRows, plan.compilerEvidence?.comedyRows, plan.compilerEvidence?.geyserRows, plan.compilerEvidence?.stoneGarden, plan.compilerEvidence?.mirrorRing, plan.compilerEvidence?.radiantWall, plan.compilerEvidence?.starLines, plan.compilerEvidence?.lostNames, plan.compilerEvidence?.realityUnravel, plan.compilerEvidence?.shadowTheft, plan.compilerEvidence?.adorationRows, plan.compilerEvidence?.glassCage, plan.compilerEvidence?.chainRows, plan.compilerEvidence?.chainSave, plan.compilerEvidence?.bladeWall, plan.compilerEvidence?.burstSalvo, plan.compilerEvidence?.casterStorm, plan.compilerEvidence?.mistHazard, plan.compilerEvidence?.smallSave, plan.compilerEvidence?.destructionImplement, plan.compilerEvidence?.bloodspray, plan.compilerEvidence?.mantisMark, plan.compilerEvidence?.coalsDemand, plan.compilerEvidence?.knowledgeUnravel, plan.compilerEvidence?.detonatingMark, plan.compilerEvidence?.drawLightning, plan.compilerEvidence?.skySteal, plan.compilerEvidence?.sorrowAura, plan.compilerEvidence?.timeMorass, plan.compilerEvidence?.liftedAfflictionImmunity, plan.compilerEvidence?.truthRing, plan.compilerEvidence?.pressureZone, plan.compilerEvidence?.impalingLance, plan.compilerEvidence?.decapitationSave, plan.compilerEvidence?.trappedRows, plan.compilerEvidence?.fallingArea, plan.compilerEvidence?.thirdPartyPreamble].some(sentences => Array.isArray(sentences) && sentences.includes(reminder.sourceText)))
            // Weapon Storm: the caster's choice of area, and the weapon's critical specialization on a critical failure (the GM's).
            || (["area-choice", "weapon-critical-specialization"].includes(reminder.kind) && plan.resolution.weaponDamage?.mode === "dice" && Array.isArray(plan.compilerEvidence?.weaponDice)
                && typeof reminder.text === "string" && reminder.text.length > 0)
            // The caster's option for the area's terrain (Sudden Blight's plants): the GM's.
            || (reminder.kind === "terrain-option" && typeof plan.compilerEvidence?.terrainOption === "string" && reminder.sourceText === plan.compilerEvidence.terrainOption)
            // When the save is rolled ("The next time the target falls asleep, …", Nightmare): the GM's timing.
            || (reminder.kind === "save-timing" && typeof plan.compilerEvidence?.saveTiming === "string" && reminder.sourceText === plan.compilerEvidence.saveTiming)
            // Unattended objects in the area pushed too (the module moves creatures only).
            || (reminder.kind === "object-push" && typeof plan.compilerEvidence?.objectPush === "string" && reminder.sourceText === plan.compilerEvidence.objectPush)
            // (A teleport spell's notes: willing creatures, line of sight, the redirected attack — its claimed sentences.)
            || (reminder.kind === "teleport-note" && plan.resolution.controls != null && Array.isArray(plan.compilerEvidence?.teleportSpell) && plan.compilerEvidence.teleportSpell.includes(reminder.sourceText))
            // (Arcane Explosion: the caster's form after the blast — its claimed sentences.)
            || (reminder.kind === "caster-form" && plan.resolution.casterForm != null && Array.isArray(plan.compilerEvidence?.casterForm) && plan.compilerEvidence.casterForm.includes(reminder.sourceText))
            // Targets counted by the actions spent (Pin the Spears in the Lamb): the caster's reminder.
            || (reminder.kind === "targets-by-actions" && typeof plan.compilerEvidence?.targetsByActions === "string" && reminder.sourceText === plan.compilerEvidence.targetsByActions)
            // (Tenebrous Freedom: how far the detached shadow moves, and its manipulate activity — the caster's and the GM's.)
            || (reminder.kind === "detached-shadow" && Array.isArray(plan.compilerEvidence?.shadowDetach) && plan.compilerEvidence.shadowDetach.includes(reminder.sourceText))
            // A reaction's blast around the triggering creature (Glimpse the Netherworld): its trigger and placement, the caster's reminder.
            || (reminder.kind === "triggered-blast" && Array.isArray(plan.compilerEvidence?.triggeredBlast) && reminder.sourceText === `${plan.compilerEvidence.triggeredBlast[0]} ${plan.compilerEvidence.triggeredBlast.at(-2)}`)
            // A spell also cast as a reaction (The Night is Mine): its reaction sentence, the caster's reminder.
            || (reminder.kind === "reaction-cast" && typeof plan.compilerEvidence?.reactionCast === "string" && reminder.sourceText === plan.compilerEvidence.reactionCast)
            // A spell that moves an object target instead of the creature's save (Grasping Vine): the object branch is the GM's.
            || (reminder.kind === "object-branch" && typeof plan.compilerEvidence?.objectMove === "string" && reminder.sourceText === plan.compilerEvidence.objectMove)
            // What the caster does for a target that failed a basic save (Recall Knowledge with its modifier).
            || (reminder.kind === "failed-save-follow-up" && plan.resolution.check.basic === true && Array.isArray(plan.compilerEvidence?.basicFollowUp)
                && JSON.stringify(reminder.degrees) === '["failure","criticalFailure"]')
            // How the persistent damage a condition is linked to can be removed (the GM removes it; the condition ends with it).
            || (reminder.kind === "removal" && plan.resolution.check.statistic === "spell-attack"
                && Object.values(plan.resolution.outcomes ?? {}).some(outcome => (outcome.effects ?? []).some(isPersistentLinkedLifetime)))))))
        block("reminders", "resolution.reminders", "Only known GM reminders can accompany an automated spell.");
    // (Arcane Explosion: PF2e's Effect on the caster after the blast, its aura's dice and type, its claimed sentences.)
    const casterForm = plan.resolution.casterForm;
    if (casterForm != null && !(typeof casterForm.effect?.uuid === "string" && /^Compendium\.pf2e\.spell-effects\.Item\.[A-Za-z0-9]+$/.test(casterForm.effect.uuid) && Array.isArray(casterForm.auras)
        && casterForm.auras.every(aura => Number(aura.radius) > 0 && /^\d+d\d+$/.test(String(aura.formula)) && /^[a-z]+$/.test(String(aura.type)) && Array.isArray(aura.events) && aura.events.length > 0
            && aura.events.every(event => ["enter", "turn-start", "turn-end"].includes(event)))
        && Array.isArray(plan.compilerEvidence?.casterForm) && plan.compilerEvidence.casterForm.length > 0))
        block("caster-form", "resolution.casterForm", "The caster's form needs PF2e's Effect, its aura's dice and type, and the claimed sentences.");
    if (plan.resolution.check.basic === true && !plan.compilerEvidence?.basicConditionRider
        && !plan.compilerEvidence?.basicPersistentDamageRider && !plan.compilerEvidence?.basicDamageBenefit && !plan.compilerEvidence?.basicEffectRider
        && !plan.compilerEvidence?.basicFollowUp
        // A second save's table on the failing rows (Firework Blast): each followUp is checked as an immediate secondary save.
        && !(Array.isArray(plan.compilerEvidence?.basicSecondTable) && ["failure", "criticalFailure"].every(degree => (plan.resolution.outcomes?.[degree]?.followUps ?? []).length === 1))
        // (Phantasmal Calamity: on the critical failure only.)
        && !(Array.isArray(plan.compilerEvidence?.basicCriticalSecond) && (plan.resolution.outcomes?.criticalFailure?.followUps ?? []).length === 1
            && ["criticalSuccess", "success", "failure"].every(degree => !(plan.resolution.outcomes?.[degree]?.followUps ?? []).length))
        && !plan.compilerEvidence?.basicDiceUpgrade
        && !plan.compilerEvidence?.basicDamageBonus
        && !(Array.isArray(plan.compilerEvidence?.basicBeneficiaryEffect) && plan.resolution.beneficiaryEffect != null)
        && !(plan.compilerEvidence?.basicSaveAdjustment && plan.resolution.attackAdjustment?.appliesTo === "save")
        && !(plan.compilerEvidence?.basicDegreeAdjustment && plan.resolution.degreeAdjustment?.predicate?.kind === "trait-any" && plan.resolution.degreeAdjustment.sourceText === plan.compilerEvidence.basicDegreeAdjustment)
        && !isResistanceHalving(plan)
        && !isStormArea(plan)
        && !isCasterShare(plan)
        // (Personal Runewell: the allies' Effect is the area's member Effect.)
        && !(Array.isArray(plan.compilerEvidence?.runewell) && plan.compilerEvidence?.lingeringExposure === true)
        // (Call the Ten: the shielded targets are the bolster's.)
        && !(Array.isArray(plan.compilerEvidence?.spiritChoice) && plan.resolution.bolster?.claim?.kind === "resistance")
        && !(plan.compilerEvidence?.basicAfflictionRider && isAfflictionHandoffPlan(plan))
        // (The caster's features — the Arcane Cascade's type, a choice of areas, off-guard to the caster: basic-feature-riders.js.)
        && !(Array.isArray(plan.compilerEvidence?.basicFeatureRiders) && plan.compilerEvidence.basicFeatureRiders.length > 0 && isDamageTypeFrom(plan.resolution.damageTypeFrom))) block("basic-save-composition", "resolution.check.basic", "Basic-save riders have not been completely compiled.");
    if (plan.automation?.level !== "guided") block("automation-level", "automation.level", "This plan is not a guided degree-outcome resolution.");
    for (const capability of plan.automation?.pendingCapabilities ?? []) block("compiler-gap", "automation.pendingCapabilities", capability);
    // Affliction progression is the accepted delegated exception, but only
    // once the immediate handoff (affliction and starting stage) is compiled.
    const afflictionHandoff = isAfflictionHandoffPlan(plan);
    for (const capability of plan.automation?.delegatedCapabilities ?? []) {
        if (capability === "affliction-resolution" && afflictionHandoff) continue;
        block("delegated-capability", "automation.delegatedCapabilities", capability);
    }
    if (plan.resolution.damageGate != null && !isSharedDamageGate(plan)) block("damage-gate", "resolution.damageGate", "The damage gate is not a supported shape.");
    if (!isDoomTimeline(plan.resolution.timeline, plan)) block("doom-timeline", "resolution.timeline", "The round-by-round timeline isn't a supported shape.");
    // "A creature that Escapes after being impaled takes 3 bleed damage" (Stone Lance): persistent damage of a rank count, on the Escape from the row's penalty.
    const escapeDamage = plan.resolution.escapeDamage;
    if (escapeDamage != null && !(Number.isInteger(escapeDamage.base) && escapeDamage.base > 0 && Number.isInteger(escapeDamage.perRank) && escapeDamage.perRank >= 0
        && Number.isInteger(escapeDamage.baseRank) && /^[a-z]+$/.test(escapeDamage.type ?? "") && Array.isArray(plan.compilerEvidence?.impalingLance) && plan.compilerEvidence.impalingLance.includes(escapeDamage.sourceText)))
        block("escape-damage", "resolution.escapeDamage", "Damage on Escape needs its stated amount and sentence.");
    if (plan.resolution.afflictionHandoff != null && !afflictionHandoff) block("affliction-handoff", "resolution.afflictionHandoff", "The affliction handoff is not a supported shape.");
    // Structured damage that no outcome applies would be silently dropped.
    if (plan.resolution.sharedDamage?.components?.length && !SAVE_DEGREES.some(degree => {
        const damage = plan.resolution.outcomes?.[degree]?.damage;
        // The push's collision damage, which the GM applies (the push note gives it at the cast rank).
        if (plan.resolution.collisionDamage && plan.resolution.outcomes?.[degree]?.forcedMovement?.kind === "push" && (plan.resolution.forcedMovementNotes ?? []).some(note => /solid barrier/.test(note))
            && plan.resolution.sharedDamage.components.some(component => component.id === plan.resolution.collisionDamage.componentId)) return true;
        // Dealt later, when the GM reports the trigger (the row's note carries the component).
        if ((plan.resolution.outcomes?.[degree]?.noteEffects ?? []).some(note => isTriggeredDamage(note.triggeredDamage)
            && plan.resolution.sharedDamage.components.some(component => component.id === note.triggeredDamage.componentId))) return true;
        return ["shared", "mixed"].includes(damage?.mode)
            || (plan.resolution.outcomes?.[degree]?.followUps ?? []).some(followUp => SAVE_DEGREES.some(secondary =>
                followUp.outcomes?.[secondary]?.damage?.mode === "primary-shared"));
    })) block("unused-shared-damage", "resolution.sharedDamage", "The spell's structured damage is not applied by any outcome.");
    // A sustained degree save: its conditions last while the caster Sustains, never past the maximum.
    const sustainedConditions = isSustainedConditionPlan(plan);
    // A condition lasting "for the duration of the spell" needs the Sustain controller that ends it.
    if (!sustainedConditions && SAVE_DEGREES.some(degree => (plan.resolution.outcomes?.[degree]?.effects ?? []).some(isSpellLifetime)))
        block("spell-lifetime", "resolution.outcomes", "A condition lasts for the spell's duration, which only a sustained cast's controller can end.");
    // "you gain a fly Speed of 15 feet until the end of your next turn": the spell's duration is the caster Effect's.
    const raw = String(plan.lifecycle?.durationSpec?.raw ?? "").trim().toLowerCase();
    const casterLifetime = (plan.resolution.casterEffect?.when === "always" && raw.length > 0
        && String(plan.resolution.casterEffect.claimText ?? "").toLowerCase().includes(raw))
        // Blasts repeated during the turn: "until the end of your turn" is the window for more attacks, not a lifetime.
        || (plan.resolution.repeatable?.window === "turn" && raw === "until the end of your turn");
    // "until the start of your next turn" / "until the end of the target's next turn": each row's conditions and notes carry
    // their own timing (conditions lasting "for the duration" are refused above), so the spell needs no controller.
    const turnBoundary = plan.lifecycle?.durationSpec?.mode === "turn-boundary" && ["until the start of your next turn", "until the end of your next turn", "until the end of the target's next turn", "until the end of your target's next turn"].includes(raw);
    // A sustained spell whose only lasting part is the beneficiary's own sustained Effect (the save damages once).
    const beneficiaryLifetime = plan.resolution.beneficiaryEffect != null && plan.resolution.check.basic === true && plan.lifecycle?.durationSpec?.mode === "sustained";
    // A sustained basic save whose lasting part is what the caster plays while Sustaining (a note Effect on the caster).
    const casterNoteLifetime = plan.resolution.casterNote != null && plan.resolution.check.basic === true && plan.lifecycle?.sustained === true
        && sustainedMaximumSeconds(plan.lifecycle) != null;
    // The GM's yes/no on whether the save happens at all ("If the rocket explodes in an enclosed space …").
    // The other target's condition by the foe's result (Tortoise and the Hare): PF2e's condition for a fixed time, granted on the card.
    const partner = plan.resolution.partnerGrant;
    if (partner != null && !(plan.resolution.check?.basic === false && partner.recipient === "caster-or-ally" && Object.keys(partner.rows ?? {}).length > 0
        && Object.entries(partner.rows).every(([degree, row]) => SAVE_DEGREES.includes(degree) && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(row?.uuid ?? "")
            && /^[a-z-]+$/.test(row.slug ?? "") && row.duration?.mode === "fixed" && Number.isInteger(row.duration.value) && row.duration.value > 0 && ["rounds", "minutes"].includes(row.duration.unit)
            && plan.compilerEvidence?.partnerGrant?.some(text => text.endsWith(row.sourceText)))
        && (partner.restriction == null || typeof partner.restriction === "string")))
        block("partner-grant", "resolution.partnerGrant", "The other target's condition needs its stated rows, PF2e's condition and a fixed duration.");
    const healBack = plan.resolution.healBack;
    if (healBack != null && !(plan.resolution.check?.basic === false && [2, 0.5].includes(healBack.multiplier) && healBack.measure === "hp-lost" && healBack.recipient === "caster-or-ally"
        && ["thrall", "target"].includes(healBack.within?.of) && Number.isInteger(healBack.within.feet) && healBack.within.feet > 0 && (healBack.within.of !== "thrall" || plan.targeting?.thrall != null)
        && Array.isArray(healBack.degrees) && healBack.degrees.length > 0 && healBack.degrees.every(degree => SAVE_DEGREES.includes(degree))
        && Number.isInteger(healBack.onceEvery?.value) && ["minutes", "hours"].includes(healBack.onceEvery.unit) && JSON.stringify(healBack.sourceText) === JSON.stringify(plan.compilerEvidence?.healBack)))
        block("heal-back", "resolution.healBack", "Healing the caster's pick from Hit Points lost needs its stated multiple, distance and limit.");
    // A spell attack whose rows depend on the target's trait (Flense): the other rows must be executable too.
    const traitVariant = plan.resolution.traitVariant;
    if (traitVariant != null && !((traitVariant.kind === "trait-rows"
            // (Noxious Metals: the second table for creatures of the traits, or the aversion the GM answers; both degree tables.)
            ? plan.resolution.check?.basic === false && Array.isArray(traitVariant.traits) && traitVariant.traits.length > 0 && traitVariant.traits.every(trait => /^[a-z]+$/.test(trait))
                && Array.isArray(traitVariant.values) && traitVariant.values.length === 2 && traitVariant.values[0] === traitVariant.trait && typeof traitVariant.question === "string"
                && traitVariant.values.every(value => typeof traitVariant.labels?.[value] === "string") && plan.compilerEvidence?.traitModes?.includes(traitVariant.sourceText)
            : traitVariant.kind === "zone"
            ? plan.resolution.check?.basic === true && Array.isArray(traitVariant.values) && traitVariant.values.length === 2 && typeof traitVariant.question === "string"
                && traitVariant.damageSwap?.from === traitVariant.values[0] && traitVariant.damageSwap.to === traitVariant.values[1]
                && (plan.resolution.sharedDamage?.components ?? []).every(component => component.type === traitVariant.values[0])
            : traitVariant.kind === "persistent-extra" ? isPersistentExtraVariant(plan, traitVariant)
            : plan.resolution.check?.statistic === "spell-attack") && /^[a-z-]+$/.test(traitVariant.trait ?? "") && Array.isArray(plan.compilerEvidence?.traitModes)
        && inspectSavePlan({ ...plan, resolution: { ...plan.resolution, traitVariant: null, outcomes: traitVariant.outcomes } }).supported))
        block("trait-variant", "resolution.traitVariant", "Rows for creatures of a trait need their own executable table.");
    // A conjured creature (Avenging Wildwood's tree): its statistics as stated, made when the repeated attack's spell is cast.
    const conjured = plan.resolution.conjuredCreature;
    if (conjured != null && !(plan.resolution.check?.statistic === "spell-attack" && plan.resolution.repeatable?.window === "sustain" && /^[a-z]+$/.test(conjured.name ?? "")
        && ["tiny", "sm", "med", "lg", "huge", "grg"].includes(conjured.size) && (conjured.ac === "spell-dc" || (Number.isInteger(conjured.ac) && conjured.ac > 0))
        && ["spell-dc-minus-10", "none"].includes(conjured.saves) && Number.isInteger(conjured.hp?.base) && conjured.hp.base > 0
        && Number.isInteger(conjured.hp.step) && Number.isInteger(conjured.hp.interval) && conjured.hp.interval > 0 && Number.isInteger(conjured.reach) && conjured.reach > 0
        && Number.isInteger(conjured.rangeFeet) && conjured.rangeFeet > 0 && Array.isArray(plan.compilerEvidence?.conjuredCreature)))
        block("conjured-creature", "resolution.conjuredCreature", "A conjured creature needs its stated size, AC, saves, Hit Points and reach.");
    // Soothing Mist: the healed creature loses one persistent damage of the listed types (heal-or-harm only).
    const removal = plan.resolution.persistentRemoval;
    if (removal != null && !(plan.resolution.dualMode != null && Array.isArray(removal.types) && removal.types.length > 0 && removal.types.every(type => /^[a-z]+$/.test(type))
        && removal.sourceText === plan.compilerEvidence?.persistentRemoval))
        block("persistent-removal", "resolution.persistentRemoval", "Removing persistent damage needs the listed types on a heal-or-harm spell.");
    if (!executableBolster(plan)) block("bolster", "resolution.bolster", "Creatures bolstered instead of saving need the GM's question and an Effect that gives exactly the stated bonus.");
    const castGate = plan.resolution.castGate;
    if (castGate != null && !(plan.resolution.kind === "save" && plan.resolution.check.basic === false && Object.keys(castGate).every(key => ["question", "sourceText"].includes(key))
        && typeof castGate.question === "string" && castGate.question.length > 0 && castGate.sourceText === plan.compilerEvidence?.castGate))
        block("cast-gate", "resolution.castGate", "A save that happens only in a stated situation needs the compiled sentence and the GM's question.");
    // "(this damage bypasses its resistances)": PF2e's bypass of every resistance on the spell's one damage roll.
    const resistanceBypass = plan.resolution.resistanceBypass;
    if (resistanceBypass != null && !(resistanceBypass.ignore === "all-damage" && Object.keys(resistanceBypass).every(key => ["ignore", "sourceText"].includes(key))
        && resistanceBypass.sourceText === plan.compilerEvidence?.resistanceBypass && plan.resolution.sharedDamage?.components?.length === 1))
        block("resistance-bypass", "resolution.resistanceBypass", "A resistance bypass needs the spell's own damage and the compiled sentence.");
    // A construct's void immunity lifted for this spell's own void damage ("… damages objects, constructs, and the like …").
    const bypass = plan.resolution.immunityBypass;
    if (bypass != null && !(bypass.type === "void" && bypass.trait === "construct" && Object.keys(bypass).every(key => ["type", "trait", "sourceText"].includes(key))
        && bypass.sourceText === plan.compilerEvidence?.immunityBypass && plan.resolution.check.statistic === "spell-attack"
        && (plan.resolution.sharedDamage?.components ?? []).every(component => String(component.type).toLowerCase() === "void")))
        block("immunity-bypass", "resolution.immunityBypass", "An immunity bypass needs the spell's own void damage and the compiled sentence.");
    if (plan.resolution.casterMark != null && !isCasterMark(plan.resolution.casterMark, plan))
        block("caster-mark", "resolution.casterMark", "A caster's marking Effect needs its proved claim and rows dealing that persistent damage.");
    // Heightened variants: each rank's rows must be executable like the base rows.
    for (const variant of plan.resolution.heightenedVariants ?? []) {
        const inner = !(Number.isInteger(variant?.minRank) && variant.minRank > Number(plan.rank) && typeof variant.sourceText === "string" && variant.outcomes)
            ? { supported: false } : inspectSavePlan({ ...plan, ...(variant.compilerEvidence ? { compilerEvidence: { ...plan.compilerEvidence, ...variant.compilerEvidence } } : {}),
                resolution: { ...plan.resolution, outcomes: variant.outcomes, ...(variant.afflictionHandoff ? { afflictionHandoff: variant.afflictionHandoff } : {}), heightenedVariants: null } });
        if (!inner.supported) block("heightened-variant", "resolution.heightenedVariants", `The rank ${variant?.minRank} rows aren't executable: ${(inner.blockers ?? []).map(entry => entry.code).join(", ")}.`);
    }
    if (plan.resolution.secondaryTargets != null && !isSecondaryTargets(plan.resolution.secondaryTargets, plan))
        block("secondary-targets", "resolution.secondaryTargets", "Secondary targets need the waived requirement, a count and the GM's question.");
    if (plan.resolution.casterNote != null && !(casterNoteLifetime && isSustainedCasterNote(plan.resolution.casterNote, plan))
        && !(plan.resolution.check.basic === true && isWhileTargetConditionCasterNote(plan.resolution.casterNote, plan)) && !isWhileTargetNoteCasterNote(plan.resolution.casterNote, plan))
        block("caster-note", "resolution.casterNote", "A caster note needs a sustained basic save and the compiled sentence.");
    // (The storm's Sustain: the area the card places is the sustained part.)
    // (Or the caster's own Effect is what lasts: Poltergeist's Fury's storm, from the sentences the compiler read.)
    const casterStorm = plan.resolution.casterStorm;
    const casterStormLifetime = casterStorm != null && plan.resolution.check.basic === true && plan.lifecycle?.sustained === true && Array.isArray(casterStorm.rules)
        && casterStorm.rules.every(rule => rule.key === "FlatModifier" && typeof rule.selector === "string" && Number.isFinite(rule.value)) && Number.isInteger(casterStorm.seconds) && casterStorm.seconds > 0
        && Array.isArray(plan.compilerEvidence?.casterStorm);
    if (casterStorm != null && !casterStormLifetime) block("caster-storm", "resolution.casterStorm", "A caster's storm needs a sustained basic save and its compiled rules.");
    if (!sustainedConditions && !casterLifetime && !turnBoundary && !beneficiaryLifetime && !casterNoteLifetime && !casterStormLifetime && !isStormArea(plan) && (!["instantaneous", "fixed", "outcome"].includes(plan.lifecycle?.durationSpec?.mode)
        || plan.lifecycle?.controller?.required === true)) block("lifecycle", "lifecycle", "The save route cannot manage this lifecycle or controller.");
    if (plan.lifecycle?.durationSpec?.mode === "fixed" && (!Number.isFinite(Number(plan.lifecycle.durationSpec.value))
        || Number(plan.lifecycle.durationSpec.value) <= 0 || typeof plan.lifecycle.durationSpec.unit !== "string")) block("duration", "lifecycle.durationSpec", "A fixed duration must have a positive value and unit.");
    const dismissal = plan.lifecycle?.dismissal;
    if (dismissal != null && !(dismissal.authority === "source-actor" && dismissal.scope === "cast" && dismissal.action === "Dismiss"
        && Object.keys(dismissal).every(key => ["authority", "scope", "action", "sourceText", "payoff"].includes(key))
        // Dismissing heals the ally the caster names, by the compiled formula.
        && (dismissal.payoff == null || (dismissal.payoff.kind === "healing" && dismissal.payoff.recipient === "ally" && dismissal.payoff.reaction === true
            && typeof dismissal.payoff.trigger === "string" && dismissal.sourceText === plan.compilerEvidence?.dismissalPayoff
            && /^(?:\(ceil\(@item\.(?:level|rank)\/\d\)\)d\d+|\d+d\d+)$/.test(dismissal.payoff.formula ?? ""))
            // Or damages the target the caster's mark is on (Vindicator's Mark), when the GM confirms the stated condition.
            || (dismissal.payoff.kind === "damage" && dismissal.payoff.recipient === "marked-target" && plan.resolution.casterMark?.kind === "strike-bonus"
                && typeof dismissal.payoff.condition === "string" && /^[a-z]+$/.test(dismissal.payoff.damageType ?? "") && dismissal.payoff.sourceText === plan.compilerEvidence?.dismissPayoff
                && /^(?:\(ceil\(@item\.(?:level|rank)\/\d\)\+\d\)d\d+|\d+d\d+)$/.test(dismissal.payoff.formula ?? ""))))) block("dismissal", "lifecycle.dismissal", "Only cast-wide Dismiss by the caster is supported.");
    // (The damage's type read from the caster or the text: Arcane Cascade, or the text's own over the item's — the sentence the compiler read.)
    if (plan.resolution.damageTypeFrom != null && !(isDamageTypeFrom(plan.resolution.damageTypeFrom)
        && (plan.resolution.damageTypeFrom.kind !== "text" || (plan.compilerEvidence?.thirdPartyPreamble ?? []).includes(plan.resolution.damageTypeFrom.sourceText))
        && (plan.resolution.damageTypeFrom.kind !== "target-strike" || (plan.compilerEvidence?.targetStrike ?? []).includes(plan.resolution.damageTypeFrom.sourceText))))
        block("damage-type-from", "resolution.damageTypeFrom", "The damage's type from the caster or the text needs its stated sentence.");
    if (plan.resolution.postDamageTerminal != null && !isPostDamageDeath(plan.resolution.postDamageTerminal)) block("post-damage-terminal", "resolution.postDamageTerminal", "Post-damage terminal consequences are not supported by this route.");
    if (plan.resolution.degreeAdjustment != null && !isDegreeAdjustment(plan.resolution.degreeAdjustment)) block("degree-adjustment", "resolution.degreeAdjustment", "The degree adjustment is not a supported shape.");
    if (plan.resolution.casterBenefit != null && !isCasterDamageBenefit(plan.resolution.casterBenefit, plan)) block("caster-benefit", "resolution.casterBenefit", "The caster benefit is not a supported damage-derived shape.");
    if (plan.resolution.killEffect != null && !isKillEffect(plan.resolution.killEffect, plan)) block("kill-effect", "resolution.killEffect", "The caster's Effect when the target dies must state exactly its rules.");
    // A row benefiting the caster through PF2e's Effect (Mental Map): the stated bonus exactly, on failed-save rows of a non-basic save.
    const casterRow = plan.resolution.casterRowEffect;
    if (casterRow != null && !((plan.resolution.check?.basic === false || (casterRow.kind === "weapon-cast" && Array.isArray(plan.compilerEvidence?.drawLightning))) && Array.isArray(casterRow.degrees) && casterRow.degrees.length > 0
        // (Or the cast's own Effect, whatever the results: every degree, a toggle's option.)
        && (casterRow.kind === "cast" || casterRow.kind === "weapon-cast" ? JSON.stringify(casterRow.degrees) === '["criticalSuccess","success","failure","criticalFailure"]' && (Array.isArray(plan.compilerEvidence?.dragonRoar) || Array.isArray(plan.compilerEvidence?.drawLightning))
            // (Defy the Gods: the rows that give the stated condition, for targets of the stated traits.)
            : casterRow.kind === "trait-resistance" ? casterRow.degrees.every(degree => (plan.resolution.outcomes?.[degree]?.effects ?? []).some(effect => effect.slug === casterRow.condition))
                && Array.isArray(casterRow.traits) && casterRow.traits.length > 0 && casterRow.traits.every(trait => /^[a-z]+$/.test(trait))
            : casterRow.degrees.every(degree => ["failure", "criticalFailure"].includes(degree))) && typeof casterRow.uuid === "string" && casterRow.uuid.startsWith("Compendium.pf2e.spell-effects.")
        && casterRow.claimText === plan.compilerEvidence?.casterRowEffect && casterRowEffectMatches(casterRow.document?.mechanics, casterRow)
        && casterRow.degrees.every(degree => !(plan.resolution.outcomes?.[degree]?.nativeEffects ?? []).length)))
        block("caster-row-effect", "resolution.casterRowEffect", "The caster's Effect from a save result must state exactly its bonus.");
    const immunity = plan.resolution.temporaryImmunity;
    if (immunity && (typeof immunity.key !== "string" || !immunity.key.trim()
        || !Number.isFinite(immunity.duration?.value) || immunity.duration.value < 0
        || !(["minutes", "hours", "days"].includes(immunity.duration.unit) && immunity.duration.value > 0
            // ("temporarily immune until the end of its next turn": a round to the end of its turn, the sentence the compiler read — Chromatic Armor.)
            // (Or "until the start of its next turn": Life's Flowing River's critical success.)
            || (immunity.duration.unit === "rounds" && immunity.duration.value === 1 && ["turn-end", "turn-start"].includes(immunity.duration.expiry) && (plan.compilerEvidence?.turnImmunity ?? null) === immunity.sourceText)
            // (Or "until the end of its turn": PF2e's 0 rounds to the end of the current turn — Cloak of Colors' attacker.)
            || (immunity.duration.unit === "rounds" && immunity.duration.value === 0 && immunity.duration.expiry === "turn-end" && (plan.compilerEvidence?.turnImmunity ?? null) === immunity.sourceText))
        // Immunity from when the spell ends needs a spell whose end the Ongoing record sees.
        || (immunity.startsWhen != null && !(immunity.startsWhen === "spell-ended" && isSustainedConditionPlan(plan)))
        // Immunity for some results only ("unaffected and temporarily immune for 1 hour" on a critical success).
        || (immunity.degrees != null && !(Array.isArray(immunity.degrees) && immunity.degrees.length > 0 && immunity.degrees.every(degree => SAVE_DEGREES.includes(degree))))
        // Each result's own time ("immune … for 1 week" / "for 1 day" / "for 1 hour"), for exactly the listed results.
        || (immunity.byDegree != null && !(Array.isArray(immunity.degrees) && Object.keys(immunity.byDegree).length === immunity.degrees.length
            && immunity.degrees.every(degree => Number.isInteger(immunity.byDegree[degree]?.value) && immunity.byDegree[degree].value > 0 && ["minutes", "hours", "days"].includes(immunity.byDegree[degree].unit))))
        // "Immune to further castings of this spell by you": one caster's castings only.
        || (immunity.byCaster != null && immunity.byCaster !== true)))
        block("temporary-immunity", "resolution.temporaryImmunity", "Temporary immunity needs a scope and supported duration.");
    const shared = plan.resolution.sharedDamage;
    const generatedSpeed = inspectGeneratedSpeedProof(plan.compilerEvidence?.generatedSpeedPenalties,
        plan.resolution.outcomes,{lifecycle:plan.lifecycle});
    if (!generatedSpeed.supported) block('generated-speed-proof','compilerEvidence.generatedSpeedPenalties',
        generatedSpeed.reason);
    const proof = plan.compilerEvidence?.componentSelectiveDamage;
    const inlineProof = plan.compilerEvidence?.inlinePersistentDamage;
    const componentIds = new Set((shared?.components ?? []).map(component => component.id));
    const proofShape = proof?.kind === 'two-component-initial-persistent'
        ? shared?.components?.length === 2 && componentIds.size === 2
            && proof.componentIds?.length === 2 && new Set(proof.componentIds).size === 2
            && shared.components.filter(component => component.category === 'persistent' || component.type === 'bleed').length === 1
        // A save whose only damage is one structured persistent entry, taken by degree.
        : proof?.kind === 'persistent-only-degree-rows'
            ? plan.resolution.check?.statistic !== 'spell-attack' && shared?.components?.length === 1
                && shared.components[0].category === 'persistent' && JSON.stringify(proof.componentIds) === JSON.stringify([shared.components[0].id])
        // A spell attack naming several damage entries: every entry on a hit, or the entries a written row keeps.
        : proof?.kind === 'attack-component-rows'
            && plan.resolution.check?.statistic === 'spell-attack'
            && ((shared?.components?.length ?? 0) >= 2 || (shared?.components?.length === 1 && shared.components[0].category === 'persistent'))
            && componentIds.size === shared.components.length && proof.componentIds?.length === componentIds.size
            && new Set(proof.componentIds).size === componentIds.size
            && shared.components.every(component => component.category == null || component.category === 'persistent');
    const selective = proofShape
        && proof.componentIds.every(id => componentIds.has(id))
        && shared.components.every(component => component.kinds?.length === 1 && component.kinds[0] === 'damage')
        && SAVE_DEGREES.every(degree => {
            const outcome = plan.resolution.outcomes?.[degree];
            const expected = proof.byDegree?.[degree], actual = outcome?.damage;
            return typeof proof.sourceText?.[degree] === 'string' && proof.sourceText[degree] === outcome?.rawText
                && expected && actual && expected.mode === actual.mode && expected.multiplier === actual.multiplier
                && JSON.stringify(expected.sourceComponentIds) === JSON.stringify(actual.sourceComponentIds)
                && JSON.stringify(expected.componentMultipliers ?? null) === JSON.stringify(actual.componentMultipliers ?? null);
        });
    if (proof && !selective) block("component-proof", "compilerEvidence.componentSelectiveDamage", "Component selection proof does not match the shared damage data.");
    const inlinePersistent = inlineProof && certifiedInlinePersistent(plan, shared);
    if (inlineProof && !inlinePersistent) block('inline-persistent-proof', 'compilerEvidence.inlinePersistentDamage',
        'Inline persistent composition lacks exact source, direct components, or outcome proof.');
    const splash = plan.resolution.splash != null && executableSplash(plan);
    if (plan.resolution.splash != null && !splash) block("splash", "resolution.splash", "Splash damage needs one attack target, the splash entries, and hit/critical-hit rows.");
    const textShared = shared?.mode === "formula" && shared.textDerived === true && shared.rollOnce === true && shared.components?.length === 1
        && executableFormula({ formula: shared.formula }) && (/\[untyped\]\}?$/.test(shared.formula) && (shared.formula.match(/\[untyped\]/g) ?? []).length === 1 && ["damage-type", "option"].includes(plan.resolution.casterChoice?.kind)
            // (Or a third-party spell's damage from its text, the item having none — Creeping Cold's persistent cold: third-party-rows.js.)
            || (!plan.resolution.casterChoice && typeof plan.compilerEvidence?.textFormula === "string" && shared.formula === plan.compilerEvidence.textFormula
                && new RegExp(`\\[${shared.components[0].category === "persistent" ? "persistent," : ""}${shared.components[0].type}\\]$`).test(shared.formula))
            // (Or a third-party version's heightening, the text's step where PF2e's variant data steps otherwise: glyph-versions.js.)
            || (!plan.resolution.casterChoice && typeof plan.compilerEvidence?.glyphFormula === "string" && shared.formula === plan.compilerEvidence.glyphFormula
                && new RegExp(`\\[${shared.components[0].type}\\]$`).test(shared.formula))
            // (Or the text's own type, no choice: Unsettling Perspective's mental damage, the formula the one the compiler read.)
            || (!plan.resolution.casterChoice && shared.formula === plan.compilerEvidence?.textDamage?.formula && Array.isArray(plan.compilerEvidence?.insightRows)
                && new RegExp(`\\[${shared.components[0].type}\\]$`).test(shared.formula) && shared.components[0].type !== "untyped")
            // (Or a move's damage per square traversed: Etheric Shards' exposure, the formula the GM's squares made.)
            || (!plan.resolution.casterChoice && Array.isArray(plan.compilerEvidence?.shardField) && shared.formula === `(${plan.compilerEvidence?.moveSaveExposure?.formula})[${shared.components[0].type}]`)
            // (Or a growing area's stepped dice — Awaken Entropy — one of its listed formulas at the cast rank, the exposure plan's after a growth.)
            || (!plan.resolution.casterChoice && (plan.resolution.lingering?.sustainGrowth?.dieSteps ?? []).some(step => step.replace(/@item\.rank/g, String(Number(plan.rank))) === shared.formula
                || /^\d+d(?:4|6|8|10|12)\[[a-z]+\]$/.test(shared.formula) && new RegExp(`d${/d(\d+)\[/.exec(step)?.[1]}\\[`).test(shared.formula)) && Array.isArray(plan.compilerEvidence?.growingEntropy))
            // (Or a soul-fed aura's turn dice — Voracious Gestalt — at least the cast rank's, of its die and type.)
            || (!plan.resolution.casterChoice && Array.isArray(plan.compilerEvidence?.growingGestalt) && plan.resolution.lingering?.turnDamage
                && (([, count, faces, type]) => Number(count) >= Number(plan.rank) + plan.resolution.lingering.turnDamage.offset && Number(faces) === plan.resolution.lingering.turnDamage.faces
                    && type === plan.resolution.lingering.turnDamage.type)(/^(\d+)d(\d+)\[([a-z]+)\]$/.exec(shared.formula) ?? [])));
    // (Cinder Swarm: the text's formula for an item with no damage of its own, at the cast rank — the formula the compiler wrote.)
    // (Or an incarnate phase's or a listed effect's own: Pest Swarm's, Pernicious Poltergeist's, whose item has no damage.)
    const auraShared = shared?.mode === "formula" && shared.textDerived === true && shared.rollOnce === true && (Array.isArray(plan.compilerEvidence?.auraModes)
        && typeof shared.formula === "string" && shared.formula === plan.compilerEvidence?.auraFormula || typeof shared.formula === "string" && shared.formula === plan.compilerEvidence?.phaseFormula)
        && !plan.resolution.casterChoice;
    // The caster's own damage for casting (Mutilate's "cause 1d4 slashing damage to you"): the text's dice and type, once per cast.
    const casterDamage = plan.resolution.casterDamage;
    if (casterDamage != null && !(Object.keys(casterDamage).every(key => ["formula", "type", "sourceText"].includes(key)) && /^\d+d\d+$/.test(casterDamage.formula ?? "")
        && /^[a-z]+$/.test(casterDamage.type ?? "") && Array.isArray(plan.compilerEvidence?.selfCost) && plan.compilerEvidence.selfCost.includes(casterDamage.sourceText)))
        block("caster-damage", "resolution.casterDamage", "The caster's own damage needs the text's dice, type and sentence.");
    // The text's larger heightening step for a damage type (Elemental Annihilation Wave's bludgeoning): more dice of the same size, per step.
    const corrections = shared?.heighteningCorrection;
    if (corrections != null && !(Array.isArray(corrections) && corrections.length > 0 && typeof plan.compilerEvidence?.heighteningCorrection === "string"
        && corrections.every(entry => /^[a-z]+$/.test(entry?.type ?? "") && [4, 6, 8, 10, 12].includes(entry.faces) && Number.isInteger(entry.perStep) && entry.perStep > 0
            && Number.isInteger(entry.interval) && entry.interval > 0 && Number.isInteger(entry.baseRank)
            && (shared.components ?? []).some(component => String(component.type).toLowerCase() === entry.type && new RegExp(`d${entry.faces}$`).test(String(component.formula))))))
        block("heightening-correction", "resolution.sharedDamage.heighteningCorrection", "A heightening correction needs the text's step for one of the spell's damage types.");
    // The text's type for a variant's one entry that PF2e types otherwise (Soul Cutter's spirit): the roll's instances retyped.
    const typeOverride = shared?.typeOverride;
    if (typeOverride != null && !(shared.mode === "pf2e-item-damage" && shared.components?.length === 1 && shared.components[0].id === typeOverride.componentId
        && String(shared.components[0].type).toLowerCase() === typeOverride.from && /^[a-z]+$/.test(typeOverride.to ?? "") && typeOverride.to !== typeOverride.from
        && !shared.components[0].category && typeof plan.compilerEvidence?.typeOverride === "string" && plan.compilerEvidence.typeOverride === typeOverride.sourceText))
        block("type-override", "resolution.sharedDamage.typeOverride", "A text type replaces only a variant's one damage entry of the data's type.");
    // A variant's text formula for its one entry (the runtime rolls PF2e's damage with the text's base formula).
    const overrides = shared?.formulaOverrides ?? [];
    if (!Array.isArray(overrides) || overrides.length > 1 || overrides.some(entry => !/^\d+d\d+$/.test(entry?.formula ?? "") || typeof entry.sourceText !== "string"
        || shared.mode !== "pf2e-item-damage" || shared.components?.length !== 1 || shared.components[0].id !== entry.componentId || !(plan.resolution.overlayIds?.length || /^[1-3]$/.test(String(plan.activation?.time ?? "")))))
        block("formula-override", "resolution.sharedDamage.formulaOverrides", "A text formula replaces only a variant's one damage entry.");
    // A save whose only damage is persistent, scaled by the result (Freezing Touch): the card scales the persistent formula itself.
    const persistentScaled = shared?.persistentScaled === true && shared.mode === "pf2e-item-damage" && shared.components?.length === 1 && shared.components[0].category === "persistent"
        && plan.resolution.check?.basic === false && Array.isArray(plan.compilerEvidence?.persistentRows);
    if (shared?.persistentScaled != null && !persistentScaled) block("persistent-scaled", "resolution.sharedDamage.persistentScaled", "Scaled persistent damage needs the one persistent entry and its stated rows.");
    // A basic save on one entry and one persistent entry together, both scaled by the result (Dimensional Excision: "takes 14d10 damage and 2d10 persistent bleed
    // damage with a basic Will save"): the sentence the compiler read names both.
    const basicPersistent = plan.resolution.check?.basic === true && shared?.mode === "pf2e-item-damage" && shared.components?.length === 2
        && shared.components.filter(component => component.category === "persistent").length === 1 && typeof plan.compilerEvidence?.basicPersistent === "string"
        && shared.components.every(component => new RegExp(`\\b${String(component.formula).replace(/\s+/g, "")} ${component.category === "persistent" ? "persistent " : ""}${component.type === "untyped" ? "" : `${component.type} `}damage\\b`).test(plan.compilerEvidence.basicPersistent));
    // A table save whose rows scale both its entries — one persistent — as a basic save would (Beheading Buzz-Saw: "takes 5d10 slashing damage and 4d6
    // persistent bleed damage, with a Reflex save", success unaffected, failure full, critical failure double): the sentence the compiler read names both.
    const rowPersistent = plan.resolution.check?.basic === false && shared?.mode === "pf2e-item-damage" && shared.components?.length === 2
        && shared.components.filter(component => component.category === "persistent").length === 1 && shared.components.filter(component => !component.category).length === 1
        && Array.isArray(plan.compilerEvidence?.decapitationSave) && shared.components.every(component => plan.compilerEvidence.decapitationSave.some(sentence =>
            new RegExp(`\\b${String(component.formula).replace(/\s+/g, "")} ${component.category === "persistent" ? "persistent " : ""}${component.type} damage\\b`).test(sentence)))
        && SAVE_DEGREES.every(degree => ["none", "shared"].includes(plan.resolution.outcomes?.[degree]?.damage?.mode ?? "none"));
    // Falling Sky: each creature above the ground falls to it, twice the falling damage for the distance (the distance itself) to a maximum, from the sentence
    // the compiler read.
    const areaFall = plan.resolution.areaFall;
    if (areaFall != null && !(Object.keys(areaFall).every(key => ["multiplier", "cap", "type", "sourceText"].includes(key)) && areaFall.multiplier === 2 && Number.isInteger(areaFall.cap)
        && areaFall.cap > 0 && /^[a-z]+$/.test(areaFall.type ?? "") && (plan.compilerEvidence?.fallingArea ?? []).includes(areaFall.sourceText)))
        block("area-fall", "resolution.areaFall", "An area's fall needs its stated sentence and maximum.");
    // "If massacre doesn't kill even a single creature, … an additional 30 void damage to every living creature in the line … and 30 void damage to you.": a
    // flat amount after the card, from the sentence the compiler read.
    const backlash = plan.resolution.backlash;
    if (backlash != null && !(Object.keys(backlash).every(key => ["formula", "caster", "when", "livingOnly", "sourceText"].includes(key)) && /^\d+\[[a-z]+\]$/.test(backlash.formula ?? "")
        && /^\d+\[[a-z]+\]$/.test(backlash.caster ?? "") && backlash.when === "none-killed" && backlash.livingOnly === true && plan.resolution.postDamageTerminal?.kind === "death"
        && (plan.compilerEvidence?.backlashSave ?? []).includes(backlash.sourceText)))
        block("backlash", "resolution.backlash", "A backlash needs its stated sentence, a flat amount and the spell's death at 0 Hit Points.");
    // (Or a third-party spell's text damage of several parts, all of the caster's type: Ravaging End.)
    const choiceShared = shared?.mode === "formula" && shared.textDerived === true && shared.rollOnce === true && plan.resolution.casterChoice?.allPools === true
        && shared.formula === plan.compilerEvidence?.textFormula && executableFormula({ formula: shared.formula });
    if (shared && !textShared && !auraShared && !choiceShared && (shared.mode !== "pf2e-item-damage" || shared.rollOnce !== true
        || !shared.components?.length || shared.components.some(component => component.category
            && !(selective && component.category === "persistent") && !(splash && component.category === "splash") && !(persistentScaled && component.category === "persistent")
            && !(basicPersistent && component.category === "persistent") && !(rowPersistent && component.category === "persistent")))) block("shared-damage", "resolution.sharedDamage", "Shared damage contains an unsupported roll mode or category.");
    for (const degree of SAVE_DEGREES) {
        const outcome = plan.resolution.outcomes?.[degree], path = `resolution.outcomes.${degree}`;
        if (!outcome) { block("missing-outcome", path, "Every save degree requires an outcome."); continue; }
        if (!outcome.semanticCoverage?.fullyCompiled) block("unaccounted-prose", `${path}.semanticCoverage`, "Some rules in this outcome remain unaccounted for.");
        for (const [index,effect] of (outcome.nativeEffects ?? []).entries()) {
            if (effect.outcomeRule?.check === "save" && !["fortitude", "reflex", "will"].includes(plan.resolution.check.statistic)) block("native-effect-composition", `${path}.nativeEffects.${index}`, "A save-row Effect proof needs a save.");
            const inspection = inspectCompiledNativeOutcomeEffect(effect, {degree});
            if (!inspection.supported) block("native-effect-composition", `${path}.nativeEffects.${index}`, inspection.reason);
        }
        if (((selective || inlinePersistent) && (outcome.followUps?.length ?? 0) > 0) || (outcome.followUps?.length ?? 0) > 1 || !(outcome.followUps ?? []).every(isExecutableImmediateSecondarySave)) block("follow-up-composition", `${path}.followUps`, "Only one fully supported immediate secondary save is executable.");
        if ((outcome.followUps ?? []).some(followUp => Object.values(followUp.outcomes ?? {}).some(row => (row?.noteEffects ?? []).some(note => note.choiceGroup != null || !validNoteEffect(note)))))
            block("note-effect", `${path}.followUps`, "A second save's note Effect needs its text and a fixed duration.");
        if ((outcome.decisions?.length ?? 0) > 0) block("outcome-choice", `${path}.decisions`, "Outcome choices require an executable decision workflow.");
        if ((outcome.manualInstructions?.length ?? 0) > 0) block("manual-mechanic", `${path}.manualInstructions`, "This outcome contains mechanics requiring manual handling.");
        // "The target dies.": PF2e's Dead status (with Dying and Unconscious cleared).
        if (outcome.terminal != null && !isPrimaryDeath(outcome.terminal)) block("terminal", `${path}.terminal`, "This primary outcome has an unsupported terminal result.");
        // (Or a bare "The spell immediately ends." row of a lingering save: the cast ends on that result.)
        const bareEnd = outcome.endsSpell === true && outcome.casterConditions == null && /^The spell (?:immediately )?ends\.$/.test(String(outcome.rawText ?? "").trim())
            && !(outcome.effects ?? []).length && (plan.resolution.lingering != null || plan.compilerEvidence?.lingeringExposure === true);
        // (Or "If the target critically succeeds at any … save against [the spell], … the spell ends": a lingering save's critical success.)
        const criticalEnd = degree === "criticalSuccess" && outcome.endsSpell === true && outcome.endsSpellOn === "critical-success" && outcome.casterConditions == null
            && (plan.resolution.lingering != null || plan.compilerEvidence?.lingeringExposure === true) && Array.isArray(plan.compilerEvidence?.mirrorRing);
        if ((outcome.casterConditions != null || outcome.endsSpell != null) && !isCasterConditionEnd(outcome) && !isCasterConditionOnly(outcome) && !isCasterConditionTimed(outcome) && !bareEnd && !criticalEnd) block("caster-condition", `${path}.casterConditions`, "The caster's condition needs its stated row, and the spell ends with it.");
        if (outcome.conditionIncreases != null && !isConditionIncreases(outcome.conditionIncreases)) block("condition-increase", `${path}.conditionIncreases`, "A condition increase needs its stated condition and amount.");
        if (executableConditionLinks(outcome.effects ?? []) == null) block("condition-composition", `${path}.effects`, "Condition values, lifetimes or dependencies are unsupported or ambiguous.");
        if ((outcome.effects ?? []).some(effect => isLeaveAreaLifetime(effect) || isAreaLifetime(effect)) && !plan.resolution?.lingering && !plan.compilerEvidence?.lingeringExposure)
            block("leave-area-lifetime", `${path}.effects`, "A condition that lasts while the creature is in the area needs the lingering area.");
        // Conditions chosen by the cast's roll: each option exactly once, and a well-formed roll.
        // A condition gated on the dice question's yes: only with that question, from the rows the compiler read.
        if ((outcome.effects ?? []).some(effect => effect.choiceGroup === "dice-upgrade-yes") && !(plan.resolution.diceUpgrade?.faces && Array.isArray(plan.compilerEvidence?.faithCrisis)))
            block("dice-upgrade-condition", `${path}.effects`, "A condition for the dice question's yes needs that question.");
        // Conditions chosen per target by its highest attribute: each option once, covering the six attributes.
        const attributeChoices = (outcome.effects ?? []).filter(effect => effect.choiceGroup === "attribute");
        if (attributeChoices.length) {
            const options = plan.resolution.attributeCondition?.options ?? [];
            const attributes = options.flatMap(option => option.attributes);
            if (!(attributeChoices.length === (outcome.effects ?? []).length && options.length === attributeChoices.length
                && JSON.stringify(attributeChoices.map(effect => effect.slug)) === JSON.stringify(options.map(option => option.slug))
                && attributes.length === 6 && new Set(attributes).size === 6 && ["str", "dex", "con", "int", "wis", "cha"].every(key => attributes.includes(key))))
                block("attribute-condition", `${path}.effects`, "Attribute-chosen conditions need each option once and all six attributes.");
        }
        // (Unfathomable Song: each condition names the roll's results giving it; a critical failure reads the roll plus the offset.)
        const resultTagged = (outcome.effects ?? []).filter(effect => effect.choiceGroup === "condition-roll-results");
        if (resultTagged.length) {
            const roll = plan.resolution.conditionRoll;
            const faces = Number(/^1d(\d+)$/.exec(roll?.formula ?? "")?.[1] ?? 0);
            if (!(roll?.kind === "degree-results" && faces >= 2 && Number.isInteger(roll.criticalOffset) && roll.criticalOffset >= 0 && resultTagged.length === (outcome.effects ?? []).length
                && ["failure", "criticalFailure"].includes(degree) && Array.isArray(plan.compilerEvidence?.unfathomableSong)
                && resultTagged.every(effect => Array.isArray(effect.rollResults) && effect.rollResults.length >= 1 && effect.rollResults.every(result => Number.isInteger(result)
                    && result >= 1 + (degree === "criticalFailure" ? roll.criticalOffset : 0) && result <= faces + (degree === "criticalFailure" ? roll.criticalOffset : 0)))))
                block("condition-roll", `${path}.effects`, "Rolled table conditions need the roll and the results giving each.");
        }
        const rolledChoices = (outcome.effects ?? []).filter(effect => effect.choiceGroup === "condition-roll");
        if (rolledChoices.length) {
            const roll = plan.resolution.conditionRoll;
            const options = roll?.options ?? [];
            if (!(rolledChoices.length === (outcome.effects ?? []).length && rolledChoices.every(effect => effect.choiceGroup === "condition-roll")
                && /^1d\d+$/.test(roll?.formula ?? "") && Array.isArray(roll.chooseOn) && options.length >= 2
                && JSON.stringify(rolledChoices.map(effect => effect.slug)) === JSON.stringify(options)
                && Object.values(roll.results ?? {}).every(slug => options.includes(slug))))
                block("condition-roll", `${path}.effects`, "Rolled condition choices need the cast's roll and each option once.");
        }
        // A condition only for targets the GM answered "yes" for, when the spell damaged them (Thunderstrike's metal rule).
        // Or only for a creature asleep at Finalize, which wakes ("If it's asleep, it wakes up and is Paralyzed for 1 round.").
        const asleepGate = gate => gate.kind === "asleep" && gate.wakes === true && typeof gate.sourceText === "string" && /^If it's asleep, it wakes up and is /.test(gate.sourceText)
            && Object.keys(gate).every(key => ["kind", "wakes", "sourceText"].includes(key));
        // Or only for a creature the GM says is in the stated situation ("If the creature is already exposed to bright light, it …").
        // (Or a creature the GM says isn't native to the plane: Unravel Existence's rider, from the sentence the compiler read.)
        const questionGate = gate => gate.kind === "gm-question" && typeof gate.question === "string" && gate.question.length > 5
            && (/^If (?:the creature|the target|it) is /.test(gate.sourceText ?? "") || (Array.isArray(plan.compilerEvidence?.realityUnravel) && plan.compilerEvidence.realityUnravel.includes(gate.sourceText))
                // (Steal the Sky: whether the descent hit a surface.)
                || (Array.isArray(plan.compilerEvidence?.skySteal) && plan.compilerEvidence.skySteal.includes(gate.sourceText))
                // (Or a keyed question from a sentence the compiler read: Chrysopoetic Curse's "If the target is wearing any armor or clothing".)
                || (typeof gate.key === "string" && /^[a-z-]+$/.test(gate.key) && (plan.compilerEvidence?.gateSentences ?? []).includes(gate.sourceText)))
            && Object.keys(gate).every(key => ["kind", "question", "sourceText", "key"].includes(key));
        if ((outcome.effects ?? []).some(effect => effect.gate != null && !asleepGate(effect.gate) && !questionGate(effect.gate) && !(effect.gate.kind === "adjustment-and-damaged" && adjustment?.appliesTo === "save"
            && adjustment.choices.some(choice => choice.value !== 0) && degree !== "criticalSuccess"))) block("condition-gate", `${path}.effects`, "A gated condition needs the save question it depends on.");
        // A row's damage only on the GM's answer: the same question as a gated condition in the row.
        if ((outcome.damage?.formulas ?? []).some(entry => entry.gate != null && !(questionGate(entry.gate) && ((outcome.effects ?? []).some(effect => effect.gate?.kind === "gm-question"
            && effect.gate.question === entry.gate.question && effect.gate.sourceText === entry.gate.sourceText)
            // (Or a row whose only gated part is its damage: Steal the Sky's success.)
            || Array.isArray(plan.compilerEvidence?.skySteal))))) block("damage-gate", `${path}.damage`, "Gated row damage needs the row's gated condition and its question.");
        if (outcome.persistentEndsWith != null && !isConditionEndedPersistent(outcome.persistentEndsWith, outcome, degree))
            block("persistent-ends-with", `${path}.persistentEndsWith`, "Persistent damage ending with a condition needs a failing row that deals it and grants that condition.");
        if (outcome.conditionFloor != null && (!isConditionFloor(outcome.conditionFloor) || (outcome.conditionFloor.lifetime === "spell" && !isSustainedConditionPlan(plan))))
            block("condition-floor", `${path}.conditionFloor`, "The condition floor is not a supported curse shape.");
        // (A Strike's rows decide the condition; its later saves are the item's own — Medusa's Wrath's Fortitude — from the sentence the compiler read.)
        if ((outcome.effects ?? []).some(effect => effect.recurringSave && effect.recurringSave.statistic !== plan.resolution.check.statistic
            && !(plan.resolution.check.statistic === "strike" && effect.recurringSave.mode === "escalate" && effect.recurringSave.sourceText === plan.compilerEvidence?.strikeEscalate)
            // (Vitrifying Blast: a Reflex blast whose stated ongoing save is Fortitude, from the row the compiler read.)
            && !(effect.recurringSave.mode === "escalate" && (plan.compilerEvidence?.vitrify ?? []).includes(`Failure ${effect.recurringSave.sourceText}`)))) block("recurring-save", `${path}.effects`, "A recurring save must use the primary save statistic and DC.");
        const damage = outcome.damage;
        if (damage?.mode === "none") {
            if (damage.multiplier !== 0) block("damage-multiplier", `${path}.damage`, "No-damage outcomes require a zero multiplier.");
            continue;
        }
        if (!["shared", "formulas", "mixed"].includes(damage?.mode)) { block("damage-mode", `${path}.damage`, "This damage operation is unsupported."); continue; }
        if (["formulas", "mixed"].includes(damage.mode)
            && !(inlinePersistent && damage.mode === 'mixed' && damage.rollScope === 'combined')
            && !executableFormulaDamage(damage)) block("damage-formula", `${path}.damage`, "Outcome formula, heightening or roll scope is unsupported.");
        const sharedPart = sharedDamagePart(damage);
        if (!sharedPart) {
            if (damage.mode !== "formulas") block("missing-shared-damage", `${path}.damage`, "This operation requires shared damage.");
            continue;
        }
        if (!shared || ![0.5, 1, 2].includes(sharedPart.multiplier)) block("shared-damage-multiplier", `${path}.damage`, "Shared damage requires a supported multiplier and roll.");
        const selectedIds = new Set(sharedPart.sourceComponentIds ?? []);
        const selectionValid = selectedIds.size > 0 && selectedIds.size === sharedPart.sourceComponentIds?.length
            && [...selectedIds].every(id => componentIds.has(id));
        const overrides = sharedPart.componentMultipliers;
        if (!selectionValid || (!selective && (selectedIds.size !== componentIds.size || overrides != null))) block("damage-selection", `${path}.damage`, "Component selection requires complete source evidence and known, unique component IDs.");
        if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides)
            || Object.entries(overrides).some(([id,multiplier]) => !selectedIds.has(id) || ![0.5,1,2].includes(multiplier)))) block("component-multiplier", `${path}.damage.componentMultipliers`, "Component multipliers must name selected components and supported scaling values.");
    }
    return result();
}

/** Whether a row deals the spell's persistent damage of this type (a selected entry, or an outcome formula). */
function rowDealsPersistent(plan, outcome, damageType) {
    const damage = outcome?.damage;
    const ids = damage?.mode === "mixed" ? damage.shared?.sourceComponentIds : damage?.sourceComponentIds;
    return (ids ?? []).some(id => (plan.resolution.sharedDamage?.components ?? []).some(component => component.id === id && component.category === "persistent"
            && String(component.type).toLowerCase() === damageType))
        // (A row's own formulas — "takes @Damage[2d6[persistent,bleed]] damage" with no shared damage — deal it too.)
        || (["mixed", "formulas"].includes(damage?.mode) && (damage.formulas ?? []).some(entry => String(entry.formula ?? "").endsWith(`[persistent,${damageType}]`)));
}

/** "You are Stunned 1 and the spell ends.": the caster's condition (once per cast), and the spell's end. */
/** "The target resists being banished and you are Stunned 1.": the caster's condition only (the spell goes on). */
export function isCasterConditionOnly(outcome) {
    const entries = outcome?.casterConditions;
    // (Or "You see your own fate closing in on you and become Frightened 1.": The End is Nigh's critical success.)
    // (Or "You become Doomed 1.": Planar Court's critical success, its narration claimed apart.)
    const match = /^(?:The target resists being [a-z]+ and you are|You [a-z ,']{3,60} and become|You become) @UUID\[Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+\]\{([A-Z][a-z-]+)(?: (\d))?\}\.$/.exec(entries?.[0]?.sourceText ?? "");
    return Array.isArray(entries) && entries.length === 1 && !!match && outcome.endsSpell == null && !(outcome.effects ?? []).length
        && entries[0].slug === match[1].toLowerCase() && entries[0].value === (match[2] ? Number(match[2]) : null)
        && Object.keys(entries[0]).every(key => ["slug", "value", "sourceText"].includes(key));
}

/** "You are Confused for 1 round." (Shared Nightmare's critical success): the caster's condition for its stated time (the spell goes on). */
export function isCasterConditionTimed(outcome) {
    const entries = outcome?.casterConditions;
    const match = /^You are @UUID\[(Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+)\]\{([A-Z][a-z-]+)(?: (\d))?\} for (\d+) (round|minute)s?\.$/.exec(entries?.[0]?.sourceText ?? "");
    return Array.isArray(entries) && entries.length === 1 && !!match && outcome.endsSpell == null && !(outcome.effects ?? []).length
        && entries[0].slug === match[2].toLowerCase() && entries[0].value === (match[3] ? Number(match[3]) : null) && entries[0].uuid === match[1]
        && entries[0].duration?.value === Number(match[4]) && entries[0].duration?.unit === `${match[5]}s` && ["turn-start", "turn-end"].includes(entries[0].duration?.expiry)
        && Object.keys(entries[0]).every(key => ["slug", "value", "uuid", "duration", "sourceText"].includes(key));
}

export function isCasterConditionEnd(outcome) {
    const entries = outcome?.casterConditions;
    const match = /^You are @UUID\[Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+\]\{([A-Z][a-z-]+)(?: (\d))?\} and the spell ends\.$/.exec(entries?.[0]?.sourceText ?? "");
    return Array.isArray(entries) && entries.length === 1 && !!match && outcome.endsSpell === true
        && entries[0].slug === match[1].toLowerCase() && entries[0].value === (match[2] ? Number(match[2]) : null)
        && Object.keys(entries[0]).every(key => ["slug", "value", "sourceText"].includes(key));
}

/** "The target dies." */
export function isPrimaryDeath(terminal) {
    return terminal?.kind === "death" && terminal.automatic === true && Object.keys(terminal).every(key => ["kind", "label", "automatic"].includes(key));
}

/** "The target's Dying value increases by 1.": PF2e's own increase of that condition, by the stated amount. */
export function isConditionIncreases(increases) {
    return Array.isArray(increases) && increases.length === 1 && increases.every(entry => {
        const match = VALUE_INCREASE.exec(entry?.sourceText ?? "") ?? OR_INCREASE.exec(entry?.sourceText ?? "");
        return match && entry.slug === match[1].toLowerCase() && entry.amount === Number(match[2]) && entry.amount >= 1
            && Object.keys(entry).every(key => ["slug", "amount", "sourceText"].includes(key));
    });
}

/** "If this kills it, you gain …": the caster's Effect, exactly the sentence's rules, given when a row's death is applied. */
export function isKillEffect(effect, plan) {
    const match = KILL_BENEFIT.exec(effect?.sourceText ?? "");
    return !!match && effect.sourceText === plan.compilerEvidence?.killEffect && effect.kind === "native-spell-effect" && effect.resolutionStatus === "resolved"
        && typeof effect.uuid === "string" && !!effect.document?.id
        && effect.temporaryHP === Number(match[1]) && effect.bonus === Number(match[2]) && effect.duration?.value === Number(match[3]) && effect.duration.unit === `${match[4]}s`
        && killEffectMatches(effect.document.mechanics, effect)
        && SAVE_DEGREES.some(degree => isPrimaryDeath(plan.resolution.outcomes?.[degree]?.terminal));
}

export function isExecutableDegreeSavePlan(plan) {
    return inspectDegreeSavePlan(plan).supported;
}

/**
 * A lingering area (enter / turn-start / turn-end / Sustain exposure over a
 * duration, with a basic or degree save) is resolved by the ongoing
 * lingering-area workflow, never as a one-time save. Its exposure saves use
 * `lingeringExposurePlan`.
 */
export function isExecutableLingeringPlan(plan) {
    const lingering = plan?.resolution?.lingering;
    if (!lingering || plan.resolution.kind !== "save" || typeof plan.resolution.check?.basic !== "boolean") return false;
    if ((plan.automation?.pendingCapabilities ?? []).length) return false;
    const events = lingering.events ?? [];
    // Sustain exposure needs a sustained spell, or an emanation that grows on an optional Sustain (only enemies not yet affected save);
    // an area needs some exposure after casting.
    const growing = lingering.optionalSustain === true && lingering.sustained === false && lingering.centre === "caster" && lingering.area?.type === "emanation"
        && Number.isInteger(lingering.growth?.feet) && lingering.growth.feet > 0 && lingering.growth.feet % 5 === 0 && lingering.unaffectedOnly === true && events.join() === "sustain";
    if ((lingering.optionalSustain != null || lingering.growth != null || lingering.unaffectedOnly != null) && !growing) return false;
    if (events.includes("sustain") && lingering.sustained !== true && !growing) return false;
    // A cloud exposed only when cast lingers to conceal ("All creatures in the area become concealed, …").
    // Or an area whose lasting part is PF2e's Effect on creatures of a trait while inside (Hallowed Ground's weakness).
    const member = lingering.memberEffect;
    const memberEffect = member != null && typeof member.uuid === "string" && ((/^[a-z-]+$/.test(member.trait ?? "") && member.sourceText === plan.compilerEvidence?.memberEffect
        && Number.isInteger(member.weakness?.value) && /^[a-z]+$/.test(member.weakness?.type ?? "") && lingering.centre === "placed"
        && (member.document?.mechanics?.rules ?? []).length === 1 && member.document.mechanics.rules[0].key === "Weakness" && member.document.mechanics.rules[0].type === member.weakness.type)
        // (Or the caster's and allies' spell damage while inside: Personal Runewell's Effect, exactly + the spell's rank, from the sentence the compiler read.)
        || (member.allies === true && lingering.centre === "placed" && Array.isArray(plan.compilerEvidence?.runewell) && plan.compilerEvidence.runewell.includes(member.sourceText)
            && (member.document?.mechanics?.rules ?? []).length === 1 && member.document.mechanics.rules[0].key === "FlatModifier" && member.document.mechanics.rules[0].selector === "spell-damage"
            && member.document.mechanics.rules[0].type === "status" && member.document.mechanics.rules[0].value === "@spell.rank"));
    if (member != null && !memberEffect) return false;
    const concealingCloud = events.length === 0 && lingering.initial === true && (lingering.concealment === true || lingering.terrain != null || memberEffect);
    // A save when a creature inside would regain Hit Points (Fallow Field): the module holds the healing and restores each result's share.
    const heal = lingering.healingSave;
    const healingSave = heal != null && events.length === 0 && lingering.initial === false && lingering.centre === "placed" && lingering.sustained === true
        && ["fortitude", "reflex", "will"].includes(heal.statistic) && JSON.stringify(heal.shares) === '{"criticalSuccess":1,"success":1,"failure":0.5,"criticalFailure":0}'
        && heal.immunity?.degree === "criticalSuccess" && Number.isInteger(heal.immunity.value) && heal.immunity.value > 0 && ["rounds", "minutes"].includes(heal.immunity.unit)
        && Array.isArray(plan.compilerEvidence?.fallowField) && lingering.sourceText.every(sentence => plan.compilerEvidence.fallowField.includes(sentence));
    if (heal != null && !healingSave) return false;
    // The GM's control when a creature ends a move action through the area (Etheric Shards): its basic save per square traversed.
    const move = lingering.moveSave;
    const moveSave = move != null && events.length === 0 && lingering.initial === false && lingering.centre === "placed" && Number.isInteger(move.die) && [4, 6, 8, 10, 12].includes(move.die)
        && /^[a-z]+$/.test(move.type ?? "") && ["fortitude", "reflex", "will"].includes(move.statistic) && plan.resolution.check?.basic === true
        && (plan.resolution.sharedDamage?.components ?? []).some(component => component.id === move.componentId)
        && Array.isArray(plan.compilerEvidence?.shardField) && plan.compilerEvidence.shardField.includes(move.sourceText);
    if (move != null && !moveSave) return false;
    // Mines the GM reports triggered (Instant Minefield): one card for the creatures each explosion catches, at most the stated count.
    const mines = lingering.mines;
    const minesOk = mines != null && events.length === 0 && lingering.initial === false && lingering.centre === "placed" && Number.isInteger(mines.count) && mines.count >= 1 && mines.count <= 10
        && Number.isInteger(mines.emanation) && typeof plan.resolution.check?.basic === "boolean" && Array.isArray(plan.compilerEvidence?.minefield) && plan.compilerEvidence.minefield.includes(mines.sourceText);
    if (mines != null && !minesOk) return false;
    // An exposure the GM triggers (Bralani Referendum: a creature in the area inflicts a chosen condition), once a round, with the conditions
    // chosen when the area starts.
    const trigger = lingering.gmTrigger;
    const gmTrigger = events.join() === "gm-trigger" && trigger?.kind === "inflicts-condition" && Array.isArray(trigger.choices) && trigger.choices.length > 1
        && trigger.choices.every(choice => /^[a-z-]+$/.test(choice)) && Number.isInteger(trigger.count) && trigger.count >= 1 && trigger.count < trigger.choices.length
        && (trigger.step == null || (Number.isInteger(trigger.step.interval) && trigger.step.interval > 0 && trigger.step.add === 1)) && Number.isInteger(trigger.baseRank)
        && trigger.sourceText === plan.compilerEvidence?.gmTrigger && lingering.oncePerRound === true && lingering.initial === false && lingering.centre === "placed";
    if ((trigger != null || events.includes("gm-trigger")) && !gmTrigger) return false;
    // (Or only the GM's control for an attempt the module can't see: Unbounded Sphere's crossing.)
    const gmActionOnly = events.length === 0 && typeof lingering.gmAction?.label === "string" && (lingering.initial === false || (lingering.initial === true
        // (Or a placed area that moves on each Sustain, saved against when cast and then only by those it moves through: Hungry Depths.)
        && lingering.centre === "placed" && lingering.moveOnSustain === true && lingering.sustained === true && lingering.oncePerRound === true)) && (lingering.centre === "placed"
        // (Or the cast's target itself: Purifying Veil's crossing, from the sentence the compiler read.)
        || (lingering.centre === "targets" && Array.isArray(plan.compilerEvidence?.purifyingVeil) && plan.compilerEvidence.purifyingVeil.includes(lingering.gmAction.sourceText))
        // (Or the caster's aura, whose allies hold its Effect: Divine Aura's melee hit on one of them, from the sentence the compiler read.)
        || (lingering.centre === "caster" && lingering.memberAllies === true && lingering.sustained === true && Array.isArray(plan.compilerEvidence?.divineAura)
            && plan.compilerEvidence.divineAura.includes(lingering.gmAction.sourceText)));
    return (events.length > 0 || concealingCloud || gmActionOnly || healingSave || moveSave || minesOk) && (gmTrigger || events.every(event => ["enter", "turn-start", "turn-end", "sustain", "round-start"].includes(event)))
        // Difficult terrain on the region (PF2e's movement cost); hazardous terrain is the entering damage.
        // (Greater difficult terrain only as Corrosive Muck's pools state it.)
        && (lingering.terrain == null || ((lingering.terrain.difficulty === 2 || (lingering.terrain.difficulty === 3 && Array.isArray(plan.compilerEvidence?.acidPools))) && ['["walk"]', '["fly"]', '["walk","fly"]'].includes(JSON.stringify(lingering.terrain.movement))
            && typeof lingering.terrain.hazardous === "boolean" && lingering.centre === "placed" && lingering.terrain.hazardous === (lingering.enterDamage != null)))
        && (lingering.enterDamage == null || (events.includes("enter") && typeof lingering.enterDamage.formula === "string" && /^\S.*\[[a-z]+\]$/.test(lingering.enterDamage.formula)
            && inspectSavePlan(lingeringExposurePlan(plan, { event: "enter" })).supported))
        // A region the GM draws (Bridge of Vines' bridge), and the rows' difficult terrain for the creature (the region's per-creature cost), from the
        // sentences the compiler read.
        && (lingering.drawnArea == null || (typeof lingering.drawnArea === "string" && lingering.centre === "placed" && Array.isArray(plan.compilerEvidence?.bridgeRows ?? plan.compilerEvidence?.rowTerrain ?? plan.compilerEvidence?.dreamHazard)))
        && (lingering.rowTerrain == null || (Array.isArray(lingering.rowTerrain.degrees) && lingering.rowTerrain.degrees.length > 0 && lingering.rowTerrain.degrees.every(degree => SAVE_DEGREES.includes(degree))
            && ["spell", "next-turn-start"].includes(lingering.rowTerrain.until) && lingering.centre === "placed"
            && (plan.compilerEvidence?.bridgeRows ?? plan.compilerEvidence?.rowTerrain ?? []).includes(lingering.rowTerrain.sourceText)))
        // "on future Will saves against the hazards, the creature continues to use this result unless it rolls a critical success" (Ephemeral Hazards).
        && (lingering.successLock == null || (["fortitude", "reflex", "will"].includes(lingering.successLock.statistic) && (plan.compilerEvidence?.rowTerrain ?? []).includes(lingering.successLock.sourceText)))
        && (lingering.oncePerTurn == null || lingering.oncePerTurn === true)
        && (lingering.recastEnds == null || lingering.recastEnds === true)
        && (lingering.dismissible == null || lingering.dismissible === true)
        && (lingering.notes == null || (Array.isArray(lingering.notes) && lingering.notes.every(note => typeof note === "string" && note.length > 0)))
        // (Dread Mosquito Storm: the stated damage at each listed exposure, before its save.)
        && (lingering.exposureDamage == null || (/^\d+(?:d\d+)?$/.test(lingering.exposureDamage.formula ?? "") && /^[a-z]+$/.test(lingering.exposureDamage.type ?? "")
            && Array.isArray(lingering.exposureDamage.events) && lingering.exposureDamage.events.length > 0 && lingering.exposureDamage.events.every(event => events.includes(event))
            && (plan.compilerEvidence?.mosquitoStorm ?? []).includes(lingering.exposureDamage.sourceText)))
        // (Unbreaking Wave Barrier: the emanation is a region on the caster that follows its token.)
        && (lingering.areaOnCaster == null || (lingering.areaOnCaster === true && lingering.centre === "placed" && lingering.area?.type === "emanation" && Array.isArray(plan.compilerEvidence?.waveBarrier)))
        // (Stars of Another Sky: the GM marks a creature at the top of the cylinder; it then takes the stated damage as each of its turns starts.)
        && (lingering.gmMark == null || (typeof lingering.gmMark.label === "string" && /^\d+d\d+$/.test(lingering.gmMark.dice) && /^[a-z]+$/.test(lingering.gmMark.type)
            && [1, 2].includes(lingering.gmMark.soulless) && typeof lingering.gmMark.diesAtZero === "boolean" && (plan.compilerEvidence?.starsSky ?? []).some(sentence => sentence.includes(lingering.gmMark.sourceText))))
        // (Tear the Veil: terrain only for the living, and a draining burst at the centre — Drained up to its maximum, then the death save.)
        && (lingering.terrain?.living == null || (lingering.terrain.living === true && lingering.livingOnly === true && Array.isArray(plan.compilerEvidence?.tearVeil)))
        && (lingering.drainCenter == null || (Number.isInteger(lingering.drainCenter.radius) && lingering.drainCenter.radius > 0 && lingering.centre === "placed"
            && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(lingering.drainCenter.uuid) && Number.isInteger(lingering.drainCenter.max) && lingering.drainCenter.max >= 1 && lingering.drainCenter.max <= 4
            && ["fortitude", "reflex", "will"].includes(lingering.drainCenter.statistic) && /^[a-z]+$/.test(lingering.drainCenter.becomes)
            && (plan.compilerEvidence?.tearVeil ?? []).some(sentence => lingering.drainCenter.sourceText.startsWith(sentence))))
        // (Indolent Haze: the sleepers' damage at the stated exposures, and the rows' Prone that's Unconscious for a creature already prone.)
        && (lingering.sleeperDamage == null || (Number.isInteger(lingering.sleeperDamage.dice) && lingering.sleeperDamage.dice > 0 && [4, 6, 8, 10, 12].includes(lingering.sleeperDamage.faces)
            && /^[a-z]+$/.test(lingering.sleeperDamage.type) && lingering.sleeperDamage.slug === "unconscious" && Array.isArray(lingering.sleeperDamage.events)
            && lingering.sleeperDamage.events.every(event => ["initial", "turn-end"].includes(event) && (event === "initial" ? lingering.initial === true : lingering.events.includes(event)))
            && Number.isInteger(lingering.sleeperDamage.baseRank) && (lingering.sleeperDamage.step == null || (Number.isInteger(lingering.sleeperDamage.step.interval) && Number.isInteger(lingering.sleeperDamage.step.dice)))
            && (plan.compilerEvidence?.indolentHaze ?? []).some(sentence => sentence.includes(lingering.sleeperDamage.sourceText.split(" as ")[0]))))
        && ["criticalSuccess", "success", "failure", "criticalFailure"].every(degree => (plan.resolution.outcomes?.[degree]?.effects ?? []).every(effect => effect.insteadIfHeld == null
            || (effect.kind === "condition" && typeof effect.insteadIfHeld.ifHeld === "string" && effect.insteadIfHeld.ifHeld === effect.slug && /^[a-z-]+$/.test(effect.insteadIfHeld.slug)
                && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(effect.insteadIfHeld.uuid) && Array.isArray(plan.compilerEvidence?.indolentHaze))))
        // Disbelievers exempt from later exposures (Visions of Danger): the GM's Perception control, from the sentences the compiler read.
        && (lingering.disbelief == null || (lingering.disbelief.statistic === "perception" && /^[a-z0-9-]+$/.test(lingering.disbelief.key ?? "")
            && Array.isArray(plan.compilerEvidence?.disbelievedArea ?? plan.compilerEvidence?.dreamHazard) && (plan.compilerEvidence.disbelievedArea ?? plan.compilerEvidence.dreamHazard).join(" ").includes(String(lingering.disbelief.sourceText ?? "\u0000").split(" ").slice(0, 6).join(" "))))
        // Only creatures not immune to that damage are exposed: the plan's target check says so.
        && (lingering.notImmune == null || (/^[a-z]+$/.test(lingering.notImmune) && (plan.targeting?.actorConstraints?.predicates ?? []).some(predicate => predicate.kind === "not-immune-damage" && predicate.damageType === lingering.notImmune)))
        && typeof lingering.initial === "boolean" && typeof lingering.oncePerRound === "boolean" && typeof lingering.excludeCaster === "boolean"
        // An area (placed, or around the caster), or the cast's own targets exposed again on each Sustain.
        && (["placed", "caster"].includes(lingering.centre) ? Number.isFinite(lingering.area?.value) && lingering.area.value > 0
            : lingering.centre === "targets" && lingering.area == null && (events.join() === "sustain" && lingering.sustained === true
                // A single target saving at the start of each of its turns (no save when cast); or the creatures adjacent to it (Gleaming Pet).
                || (events.join() === "turn-start" && typeof lingering.sustained === "boolean" && lingering.initial === false)
                || (events.join() === "turn-end" && lingering.aura != null && lingering.initial === false)
                || (gmActionOnly && lingering.aura == null)))
        && (lingering.aura == null || (lingering.centre === "targets" && lingering.aura.feet === 5 && Object.keys(lingering.aura).length === 1 && events.join() === "turn-start")
            // (Or the target and the creatures within its aura, on the cast and each Sustain: Cinder Swarm, from the sentences the compiler read.)
            || (lingering.centre === "targets" && JSON.stringify(lingering.aura) === '{"feet":5,"includeTargets":true}' && events.join() === "sustain" && lingering.sustained === true
                && lingering.initial === true && Array.isArray(plan.compilerEvidence?.auraModes) && lingering.sourceText.every(sentence => plan.compilerEvidence.auraModes.includes(sentence)))
            // (Or several targets' reach, saved against as an enemy's turn ends: Bloody Tendrils' thralls, from the sentence the compiler read.)
            || (lingering.centre === "targets" && Number.isInteger(lingering.aura.feet) && lingering.aura.feet % 5 === 0 && Object.keys(lingering.aura).length === 1 && events.join() === "turn-end"
                && lingering.enemiesOnly === true && Array.isArray(plan.compilerEvidence?.bloodTendrils) && lingering.sourceText.every(sentence => plan.compilerEvidence.bloodTendrils.includes(sentence)))
            // (Or a willing ally's light, growing on the first Sustain each round to its maximum, saved against as an enemy's turn ends: Aura of
            // Violent Light, from the sentences the compiler read, with the module's Effect on the ally.)
            || (lingering.centre === "targets" && JSON.stringify(lingering.aura) === JSON.stringify({ feet: lingering.aura.feet }) && Number.isInteger(lingering.aura.feet) && lingering.aura.feet % 5 === 0
                && events.join() === "turn-end" && lingering.enemiesOnly === true && lingering.sustained === true && lingering.anchorAlly === true
                && Number.isInteger(lingering.auraGrowth?.feet) && lingering.auraGrowth.feet % 5 === 0 && Number.isInteger(lingering.auraGrowth.maximum) && lingering.auraGrowth.maximum > lingering.aura.feet
                && /^Compendium\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.Item\.[A-Za-z0-9]{16}$/.test(lingering.anchorEffect?.uuid ?? "")
                && Array.isArray(plan.compilerEvidence?.violentLight) && [...lingering.sourceText, lingering.auraGrowth.sourceText].every(sentence => plan.compilerEvidence.violentLight.includes(sentence))))
        // (Divine Eclipse: the creatures blessed with light — the cast's targets up to the number — from the sentence the compiler read.)
        && (lingering.blessed == null || (lingering.centre === "caster" && Number.isInteger(lingering.blessed.max) && lingering.blessed.max >= 1 && Number.isInteger(lingering.blessed.bright)
            && /^Compendium\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.Item\.[A-Za-z0-9]{16}$/.test(lingering.blessed.effect?.uuid ?? "") && (plan.compilerEvidence?.divineEclipse ?? []).includes(lingering.blessed.sourceText)))
        && (lingering.maxTargets == null || (lingering.centre === "targets" && Number.isInteger(lingering.maxTargets.count) && lingering.maxTargets.count >= 1 && Number.isInteger(lingering.maxTargets.baseRank)))
        && (lingering.memberCondition == null || (typeof lingering.memberCondition.slug === "string" && /^[a-z-]+$/.test(lingering.memberCondition.slug)
            && (lingering.memberCondition.value == null || (Number.isInteger(lingering.memberCondition.value) && lingering.memberCondition.value > 0))
            // (Held at its value — "can't reduce their frightened value" — from the sentence the compiler read.)
            && (lingering.memberCondition.locked == null || (lingering.memberCondition.locked === true && Number.isInteger(lingering.memberCondition.value) && Array.isArray(plan.compilerEvidence?.mirrorRing)))))
        && Number.isInteger(lingering.durationSeconds) && lingering.durationSeconds > 0
        && (lingering.enterOncePerRound == null || (lingering.enterOncePerRound === true && events.includes("enter")))
        // The squares adjacent to the door (Door to Beyond): its own damage as turns end, from the sentence the compiler read.
        && (lingering.doorHazard == null || (lingering.centre === "placed" && Number.isInteger(lingering.doorHazard.dice) && lingering.doorHazard.dice > 0 && [4, 6, 8, 10, 12].includes(lingering.doorHazard.die)
            && /^[a-z]+$/.test(lingering.doorHazard.type ?? "") && Number.isInteger(lingering.doorHazard.baseRank) && Array.isArray(plan.compilerEvidence?.doorBeyond)
            && plan.compilerEvidence.doorBeyond.includes(lingering.doorHazard.sourceText)))
        // The caster's light while the area lasts (Cloak of Light): a TokenLight, from the sentence the compiler read.
        && (lingering.casterLight == null || (lingering.centre === "caster" && Number.isInteger(lingering.casterLight.bright) && lingering.casterLight.bright > 0 && lingering.casterLight.bright <= 120
            && Number.isInteger(lingering.casterLight.dim) && lingering.casterLight.dim >= lingering.casterLight.bright && lingering.casterLight.dim <= 240
            && Array.isArray(plan.compilerEvidence?.holyCloak) && plan.compilerEvidence.holyCloak.includes(lingering.casterLight.sourceText)))
        // A burst that grows with the actions spent (Swamp of Sloth): the feet each action past the first adds, from the sentence the compiler read.
        && (lingering.actionStep == null || (lingering.centre === "placed" && lingering.area?.type === "burst" && Number.isInteger(lingering.actionStep.feet) && lingering.actionStep.feet > 0
            && lingering.actionStep.feet % 5 === 0 && Array.isArray(plan.compilerEvidence?.slothSwamp) && plan.compilerEvidence.slothSwamp.includes(lingering.actionStep.sourceText)))
        // One more area each heightened step (Corrosive Muck's bursts).
        && (lingering.areaCountStep == null || (Number.isInteger(lingering.areaCountStep.interval) && lingering.areaCountStep.interval > 0 && lingering.areaCountStep.add === 1
            && Number.isInteger(lingering.areaCountStep.baseRank) && (plan.compilerEvidence?.acidPools ?? []).length > 0 && lingering.areaCount > 1))
        && (lingering.areaCount == null || (Number.isInteger(lingering.areaCount) && lingering.areaCount > 1 && lingering.areaCount <= 5
            && lingering.separateAreas === true && lingering.centre === "placed"))
        && (lingering.endsAt == null || (lingering.endsAt === "caster-turn-start" && lingering.sustained === false && lingering.durationSeconds === 6 && !events.includes("sustain")))
        && (lingering.sustainDamage == null || (events.includes("sustain") && inspectSavePlan(lingeringExposurePlan(plan, { event: "sustain" })).supported))
        // A Sustain's basic save of its own damage while the area's exposures apply the rows (Cyclone Rondo): its formula of the cast rank only.
        && (lingering.sustainBasic == null || (events.includes("sustain") && lingering.sustainDamage == null && Array.isArray(plan.compilerEvidence?.whirlwind)
            && plan.compilerEvidence.whirlwind.includes(lingering.sustainBasic.sourceText) && /^\(\d+\+\(@item\.rank - \d+\)\*\d+\)d(?:4|6|8|10|12)\[[a-z]+\]$/.test(lingering.sustainBasic.formula ?? "")
            && inspectSavePlan(lingeringExposurePlan(plan, { event: "sustain" })).supported))
        // Conditions the Sustain's exposures leave out: each one a row's, with the stated exception.
        && (lingering.sustainDrops == null || (events.includes("sustain") && typeof lingering.sustainDrops.sourceText === "string"
            && (plan.compilerEvidence?.movedAreaSave ?? []).includes(lingering.sustainDrops.sourceText)
            && Object.entries(lingering.sustainDrops).filter(([key]) => key !== "sourceText").every(([degree, slugs]) => SAVE_DEGREES.includes(degree) && Array.isArray(slugs) && slugs.length > 0
                && slugs.every(slug => (plan.resolution.outcomes?.[degree]?.effects ?? []).some(effect => effect.slug === slug)))))
        // The caster's temporary Hit Points from each Sustain's exposures: half the most a creature lost, for the stated minutes.
        && (lingering.casterSiphon == null || (lingering.sustainDamage != null && lingering.casterSiphon.fraction === 0.5 && lingering.casterSiphon.measure === "most-lost"
            && Number.isInteger(lingering.casterSiphon.lasts?.value) && lingering.casterSiphon.lasts.value > 0 && lingering.casterSiphon.lasts.unit === "minutes"
            && Array.isArray(plan.compilerEvidence?.siphonMist) && plan.compilerEvidence.siphonMist.join(" ").includes(lingering.casterSiphon.sourceText)))
        && (lingering.enemiesOnly !== true || (plan.targeting?.actorConstraints?.predicates ?? []).some(predicate => predicate.kind === "enemy-of-caster"))
        // Damage on a failed attack the save's Effect modified (Discomfiting Whispers): the item's one damage entry, dealt by the record's control.
        && (lingering.failedAttackDamage == null || isFailedAttackDamage(plan))
        // Hazardous terrain dealing the item's damage per square moved into (the record's control), growing on each Sustain (Wildfire).
        && ((lingering.hazardMove == null && lingering.sustainGrowth == null) || isHazardMove(plan) || isOptionalExpansion(lingering) || isSustainGrowth(lingering))
        // (Darklight: the placed region fully dark — Foundry's darkness level — and up to a count of allies spared, from the sentences the compiler read.)
        && (lingering.darkness == null || (lingering.darkness.mode === 0 && lingering.darkness.modifier === 1 && lingering.centre === "placed"
            && (plan.compilerEvidence?.darknessField ?? []).includes(lingering.darkness.sourceText)))
        && (lingering.spared == null || (Number.isInteger(lingering.spared.count) && lingering.spared.count >= 1 && lingering.spared.count <= 6
            && (plan.compilerEvidence?.darknessField ?? []).includes(lingering.spared.sourceText)))
        // (The area's rules for the caster's allies inside only — Divine Aura's wards.)
        && (lingering.memberAllies == null || (lingering.memberAllies === true && (lingering.memberRules ?? []).length > 0 && lingering.centre === "caster" && lingering.memberCaster == null)
            // (Or a placed square holding the caster too — Cosmic Glow's Recall Knowledge bonus — from the sentences the compiler read.)
            || (lingering.memberAllies === true && lingering.memberCaster === true && lingering.centre === "placed" && lingering.moveOnSustain === true
                && Array.isArray(plan.compilerEvidence?.cosmicGlow) && lingering.sourceText.every(sentence => plan.compilerEvidence.cosmicGlow.includes(sentence))))
        // Shifting Sand: the in-area Effect's rules — toggles and status modifiers only.
        && (lingering.memberRules == null || (Array.isArray(lingering.memberRules) && lingering.memberRules.length > 0 && lingering.memberRules.every(rule => (rule.key === "RollOption" && rule.toggleable === true)
            || (rule.key === "FlatModifier" && ["status", "circumstance"].includes(rule.type) && typeof rule.selector === "string"))))
        // Voracious Gestalt: the turn exposures' own formula (dice from the cast rank), and the soul the GM adds — the caster's emanation grows and the
        // turn damage gains a die — from the sentences the compiler read.
        && (lingering.turnDamage == null || (/^\(@item\.level-\d+\)d(?:4|6|8|10|12)\[[a-z]+\]$/.test(lingering.turnDamage.formula ?? "") && Number.isInteger(lingering.turnDamage.offset)
            && [4, 6, 8, 10, 12].includes(lingering.turnDamage.faces) && /^[a-z]+$/.test(lingering.turnDamage.type ?? "") && events.some(event => ["turn-start", "turn-end"].includes(event))
            && (plan.compilerEvidence?.growingGestalt ?? []).includes(lingering.turnDamage.sourceText) && inspectSavePlan(lingeringExposurePlan(plan, { event: "turn" })).supported))
        && (lingering.soulGrowth == null || (lingering.turnDamage != null && lingering.centre === "caster" && Number.isInteger(lingering.soulGrowth.feet) && lingering.soulGrowth.feet > 0
            && lingering.soulGrowth.feet % 5 === 0 && lingering.soulGrowth.dice === 1 && lingering.soulGrowth.faces === lingering.turnDamage.faces
            && (plan.compilerEvidence?.growingGestalt ?? []).join(" ").includes(lingering.soulGrowth.sourceText)))
        // Zombie Horde: the burst grows by the thralls destroyed in it (the GM's control), to its stated maximum.
        && (lingering.thrallGrowth == null || (Number.isInteger(lingering.thrallGrowth.feet) && lingering.thrallGrowth.feet > 0 && lingering.thrallGrowth.feet % 5 === 0
            && Number.isInteger(lingering.thrallGrowth.maximum) && lingering.thrallGrowth.maximum > Number(lingering.area?.value) && lingering.centre === "placed" && lingering.area?.type === "burst"
            && typeof lingering.thrallGrowth.sourceText === "string"))
        // The caster's own Effect when the area starts: it must still give exactly the stated benefit.
        && (lingering.casterEffect == null || (typeof lingering.casterEffect.uuid === "string" && typeof lingering.casterEffect.claimText === "string"
            && inspectCasterBenefitClaim(lingering.casterEffect.document, lingering.casterEffect.claimText, { rank: plan.rank, spellDuration: lingering.sustained ? "sustained" : null }).supported))
        // The caster's retaliation marker for the area's lifetime (Shroud of Flame's touch): a flat formula of the cast rank, on the caster's emanation.
        && (lingering.retaliation == null || (lingering.centre === "caster" && Array.isArray(lingering.retaliation.triggers) && lingering.retaliation.triggers.length === 1
            && lingering.retaliation.triggers.every(trigger => typeof trigger.trigger === "string" && /^[a-z]+$/.test(trigger.damage?.type ?? "")
                && /^[\d\s+-]+(?:@item\.rank[\d\s+-]*)?$/.test(trigger.damage?.formula ?? ""))))
        // A GM control for an action on the area the module can't see ("if it uses a Seek or Interact action on the cloud").
        // A creature of a trait damaged by the area rusts (persistent damage) and the area grows (Rust Cloud).
      && (lingering.traitRust == null || (/^[a-z]+$/.test(lingering.traitRust.trait ?? "") && Number.isInteger(lingering.traitRust.feet) && lingering.traitRust.feet > 0
          && Number.isInteger(lingering.traitRust.maxRadius) && lingering.traitRust.maxRadius > Number(lingering.area?.value) && /^[a-z]+$/.test(lingering.traitRust.type ?? "")
          && /^\([\d\s()+*\/@a-z.-]+\)d\d+$/.test(lingering.traitRust.formula ?? "") && lingering.centre === "placed" && lingering.area?.type === "burst"))
      && (lingering.gmAction == null || (Array.isArray(lingering.gmAction.actions) && lingering.gmAction.actions.length >= 1 && lingering.gmAction.actions.every(action => /^[A-Za-z]+$/.test(action))))
        // No new saves while holding this spell's condition: one a row applies.
        && (lingering.skipWhile == null || ((lingering.skipWhile.slugs ?? [lingering.skipWhile.slug]).every(slug => /^[a-z-]+$/.test(slug ?? "")
            && SAVE_DEGREES.some(degree => (plan.resolution.outcomes?.[degree]?.effects ?? []).some(effect => effect.slug === slug)))))
        // Each Sustain's damage to the creatures this spell holds (Gluttonous Growth, Grasping Earth): a held condition the rows apply, its dice and step.
        && (lingering.heldDamage == null || (lingering.sustained === true && Number.isInteger(lingering.heldDamage.baseRank) && Array.isArray(lingering.heldDamage.entries)
            && lingering.heldDamage.entries.length > 0 && lingering.heldDamage.entries.every(entry => ["grabbed", "restrained"].includes(entry.slug) && Number.isInteger(entry.count) && entry.count > 0
                && [4, 6, 8, 10, 12].includes(entry.faces) && /^[a-z]+$/.test(entry.type ?? "") && Number.isInteger(entry.step?.interval) && entry.step.interval > 0 && Number.isInteger(entry.step.dice)
                && SAVE_DEGREES.some(degree => (plan.resolution.outcomes?.[degree]?.effects ?? []).some(effect => effect.slug === entry.slug)))))
        && inspectSavePlan(lingeringExposurePlan(plan)).supported;
}

/**
 * The one-time save each exposure resolves. A Sustain exposure of an area whose
 * Sustain deals different damage rolls that formula instead of the item's damage.
 */
/** The failed-attack damage: the plan's one damage entry, on an aura whose failing rows carry the roll-twice Effect. */
export function isFailedAttackDamage(plan) {
    const damage = plan?.resolution?.lingering?.failedAttackDamage, components = plan?.resolution?.sharedDamage?.components ?? [];
    return damage != null && Object.keys(damage).every(key => ["componentId", "formula", "type", "sourceText", "heightening"].includes(key))
        && components.length === 1 && components[0].id === damage.componentId && String(components[0].formula).replace(/\s+/g, "") === damage.formula
        && String(components[0].type).toLowerCase() === damage.type && typeof damage.sourceText === "string" && damage.sourceText.length > 0
        && (damage.heightening == null || (Number.isInteger(damage.heightening.interval) && damage.heightening.interval > 0 && /^\d+d\d+$/.test(damage.heightening.dice)))
        && ["failure", "criticalFailure"].every(degree => (plan.resolution.outcomes?.[degree]?.nativeEffects ?? []).some(effect => effect.outcomeRule?.kind === "roll-twice-effect"))
        && plan.resolution.lingering.events?.join() === "turn-start" && plan.resolution.lingering.centre === "caster";
}

/** A growth on each round's first Sustain (Consuming Darkness: "the radius increases by 5 feet"): the record grows the area itself. */
export function isSustainGrowth(lingering) {
    const growth = lingering?.sustainGrowth;
    return lingering?.hazardMove == null && growth != null && Object.keys(growth).every(key => ["feet", "optional", "maximum", "dieSteps", "sourceText"].includes(key)) && growth.optional === false
        && Number.isInteger(growth.feet) && growth.feet > 0 && growth.feet % 5 === 0 && typeof growth.sourceText === "string" && lingering.sustained === true
        // (To a maximum radius; the dice stepping up with each growth — Awaken Entropy's listed formulas, read from the cast rank.)
        && (growth.maximum == null || (Number.isInteger(growth.maximum) && growth.maximum > Number(lingering.area?.value)))
        && (growth.dieSteps == null || (Array.isArray(growth.dieSteps) && growth.dieSteps.length >= 1 && growth.dieSteps.every(formula => /^\(\d+\+@item\.rank\)d(?:4|6|8|10|12)\[[a-z]+\]$/.test(formula))));
}

/** An optional growth after a Sustain (Conjured Clockwork): the caster's control, once a round, on a sustained placed burst. */
export function isOptionalExpansion(lingering) {
    const growth = lingering?.sustainGrowth;
    return lingering?.hazardMove == null && growth != null && Object.keys(growth).every(key => ["feet", "optional", "maximum", "sourceText"].includes(key)) && growth.optional === true
        && Number.isInteger(growth.feet) && growth.feet > 0 && growth.feet % 5 === 0 && typeof growth.sourceText === "string" && lingering.sustained === true
        && (growth.maximum == null || (Number.isInteger(growth.maximum) && growth.maximum > Number(lingering.area?.value)))
        // (Or the caster's own emanation, up to its stated maximum: Morass of Ages.)
        && ((lingering.centre === "placed" && lingering.area?.type === "burst") || (lingering.centre === "caster" && lingering.area?.type === "emanation" && Number.isInteger(growth.maximum))
            // (Or the caster's emanation as a region following its token: Unbreaking Wave Barrier.)
            || (lingering.centre === "placed" && lingering.areaOnCaster === true && lingering.area?.type === "emanation"));
}

/** The per-square hazard: the plan's one damage entry, on a sustained placed area that grows on each Sustain. */
export function isHazardMove(plan) {
    const lingering = plan?.resolution?.lingering, move = lingering?.hazardMove, growth = lingering?.sustainGrowth;
    const components = plan?.resolution?.sharedDamage?.components ?? [];
    // (Or the text's own amount beside the area's save damage — Roses' Thorns: 5, or a larger amount from a stated rank — from the sentences the compiler read.)
    if (move?.text === true) return Object.keys(move).every(key => ["text", "formula", "type", "fixed", "sourceText"].includes(key)) && /^\d+$/.test(move.formula) && /^[a-z]+$/.test(move.type ?? "")
        && (move.fixed == null || (Number.isInteger(move.fixed.rank) && Number.isInteger(move.fixed.value) && move.fixed.value > Number(move.formula)))
        && Array.isArray(move.sourceText) && move.sourceText.every(sentence => (plan.compilerEvidence?.growingThorns ?? []).includes(sentence))
        && growth != null && Number.isInteger(growth.feet) && growth.feet > 0 && growth.feet % 5 === 0 && lingering.sustained === true && lingering.centre === "placed" && lingering.terrain?.difficulty === 2;
    return move != null && growth != null && Object.keys(move).every(key => ["componentId", "formula", "type", "heightening", "sourceText"].includes(key))
        && components.length === 1 && components[0].id === move.componentId && String(components[0].formula).trim() === move.formula && /^\d+$/.test(move.formula)
        && String(components[0].type).toLowerCase() === move.type && Array.isArray(move.sourceText) && move.sourceText.length === 2
        && (move.heightening == null || (Number.isInteger(move.heightening.interval) && move.heightening.interval > 0 && Number.isInteger(move.heightening.increase) && move.heightening.increase > 0))
        && Number.isInteger(growth.feet) && growth.feet > 0 && growth.feet % 5 === 0 && typeof growth.sourceText === "string"
        && lingering.sustained === true && lingering.centre === "placed" && lingering.events?.join() === "turn-end";
}

/** The plan at a cast rank: a heightened variant's rows (Sleep at 4th, Mushroom Patch at 9th) replace the base rows from its rank. */
export function heightenedPlanAt(plan, castRank) {
    const variant = (plan?.resolution?.heightenedVariants ?? []).filter(entry => Number(castRank) >= entry.minRank).at(-1);
    return variant ? { ...plan, ...(variant.compilerEvidence ? { compilerEvidence: { ...plan.compilerEvidence, ...variant.compilerEvidence } } : {}),
        resolution: { ...plan.resolution, outcomes: variant.outcomes, ...(variant.afflictionHandoff ? { afflictionHandoff: variant.afflictionHandoff } : {}),
        heightenedVariant: { minRank: variant.minRank, sourceText: variant.sourceText } } } : plan;
}

export function lingeringExposurePlan(plan, { event = null } = {}) {
    const copy = structuredClone(plan);
    // The failed-attack damage and the per-square hazard are the record's controls, not the save's.
    if (plan.resolution?.lingering?.failedAttackDamage || (plan.resolution?.lingering?.hazardMove && plan.resolution.lingering.hazardMove.text !== true)) copy.resolution.sharedDamage = null;
    // Sustaining, or entering, may deal its own formula ("Any creature entering the square takes @Damage[…] damage …").
    const eventDamage = event === "sustain" ? plan.resolution?.lingering?.sustainDamage : event === "enter" ? plan.resolution?.lingering?.enterDamage
        : null;
    if (eventDamage) {
        copy.resolution.sharedDamage = { mode: "formula", rollOnce: true, formula: eventDamage.formula,
            components: [{ id: event, formula: eventDamage.formula, type: eventDamage.type, category: null, applyModifier: false, kinds: ["damage"], materials: [] }] };
        for (const outcome of Object.values(copy.resolution.outcomes ?? {})) if (outcome.damage?.mode === "shared") outcome.damage.sourceComponentIds = [event];
    }
    // (Voracious Gestalt: the turns' own dice, from the cast rank — "(@item.level-3)d6" is 6d6 at 9th.)
    const turn = event === "turn" ? plan.resolution?.lingering?.turnDamage : null;
    if (turn) {
        const formula = `${Math.max(1, Number(plan.rank) + turn.offset)}d${turn.faces}[${turn.type}]`;
        copy.resolution.sharedDamage = { mode: "formula", rollOnce: true, textDerived: true, formula,
            components: [{ id: "turn", formula: formula.replace(/\[[a-z]+\]$/, ""), type: turn.type, category: null, applyModifier: false, kinds: ["damage"], materials: [] }] };
        for (const outcome of Object.values(copy.resolution.outcomes ?? {})) if (outcome.damage?.mode === "shared") outcome.damage.sourceComponentIds = ["turn"];
    }
    // (Cyclone Rondo: the Sustain's exposures are a basic save of their own damage, not the rows.)
    const basic = event === "sustain" ? plan.resolution?.lingering?.sustainBasic : null;
    if (basic) {
        copy.resolution.check = { ...copy.resolution.check, basic: true };
        copy.resolution.sharedDamage = { mode: "formula", rollOnce: true, formula: basic.formula,
            components: [{ id: "sustain", formula: basic.formula, type: basic.type, category: null, applyModifier: false, kinds: ["damage"], materials: [] }] };
        const row = multiplier => ({ damage: multiplier ? { mode: "shared", multiplier, sourceComponentIds: ["sustain"] } : { mode: "none", multiplier: 0, sourceComponentIds: [] }, effects: [], noteEffects: [], semanticCoverage: { fullyCompiled: true } });
        copy.resolution.outcomes = { criticalSuccess: row(0), success: row(0.5), failure: row(1), criticalFailure: row(2) };
        // (Its own basic save, as the detonation's: nothing else to compile.)
        copy.automation = { ...copy.automation, level: "automatic", pendingCapabilities: [] };
    }
    // (Invoke Spirits: "except that critically failing doesn't make them flee" — the Sustain's exposures drop those conditions.)
    const drops = event === "sustain" ? plan.resolution?.lingering?.sustainDrops : null;
    if (drops) for (const [degree, slugs] of Object.entries(drops)) if (copy.resolution.outcomes?.[degree] && Array.isArray(slugs))
        copy.resolution.outcomes[degree].effects = (copy.resolution.outcomes[degree].effects ?? []).filter(effect => !slugs.includes(effect.slug));
    // (Sanguine Mist: each Sustain's exposures feed the caster's temporary Hit Points.)
    if (event === "sustain" && plan.resolution?.lingering?.casterSiphon) copy.resolution.casterSiphon = structuredClone(plan.resolution.lingering.casterSiphon);
    delete copy.resolution.lingering;
    // (Its rows may last while the creature is in the area: the exposure belongs to the area.)
    copy.compilerEvidence = { ...(copy.compilerEvidence ?? {}), lingeringExposure: true };
    // The area's own lifetime and Sustain belong to the ongoing workflow.
    // (A row lasting "until it Escapes" keeps the spell's own fixed time: Oneiric Mire's penalty.)
    const spellTime = plan.lifecycle?.durationSpec?.mode === "fixed" ? { value: Number(plan.lifecycle.durationSpec.value), unit: plan.lifecycle.durationSpec.unit } : null;
    copy.lifecycle = { ...copy.lifecycle, durationSpec: { mode: "instantaneous", raw: "" }, sustained: false, controller: null, ...(spellTime ? { spellDuration: spellTime } : {}) };
    return copy;
}

/**
 * The mark's explosion (Ymeri's Mark): the spell's plan as a basic save of its one damage entry with the explosion's statistic, the creatures around the
 * marked one, instantaneous.
 */
export function detonationPlan(plan) {
    const detonation = plan?.resolution?.detonation;
    if (!detonation) return null;
    const copy = structuredClone(plan);
    delete copy.resolution.detonation;
    copy.resolution.check = { ...structuredClone(plan.resolution.check), statistic: detonation.statistic, basic: true };
    const row = multiplier => ({ damage: multiplier ? { mode: "shared", multiplier, sourceComponentIds: [detonation.componentId] } : { mode: "none", multiplier: 0, sourceComponentIds: [] }, effects: [], semanticCoverage: { fullyCompiled: true } });
    copy.resolution.outcomes = { criticalSuccess: row(0), success: row(0.5), failure: row(1), criticalFailure: row(2) };
    copy.resolution.reminders = [];
    copy.targeting = { ...copy.targeting, target: null, area: { type: "emanation", value: detonation.emanation }, actorConstraints: { sourceText: "the creatures in the explosion", supportsActorTargets: true, complete: true, predicates: [] } };
    copy.lifecycle = { ...copy.lifecycle, durationSpec: { mode: "instantaneous", raw: "" }, sustained: false, controller: null };
    copy.compilerEvidence = { ...copy.compilerEvidence, detonationExposure: true };
    copy.automation = { ...copy.automation, level: "automatic", pendingCapabilities: [] };
    return copy;
}

/**
 * A move through the area (Etheric Shards): the spell's basic save whose damage is the die per square traversed (with the heightened increase per square).
 */
export function moveSaveExposurePlan(plan, squares, castRank) {
    const move = plan?.resolution?.lingering?.moveSave;
    if (!move || !(Number.isInteger(squares) && squares >= 1 && squares <= 100)) return null;
    const copy = lingeringExposurePlan(plan);
    const bonus = move.heightening ? Math.max(0, Math.floor((Number(castRank) - move.baseRank) / move.heightening.interval)) * move.heightening.increase : 0;
    const formula = bonus ? `${squares}d${move.die}+${squares * bonus}` : `${squares}d${move.die}`;
    copy.resolution.sharedDamage = { mode: "formula", textDerived: true, rollOnce: true, formula: `(${formula})[${move.type}]`,
        components: [{ id: "move", formula, type: move.type, category: null, applyModifier: false, kinds: ["damage"], materials: [] }] };
    for (const outcome of Object.values(copy.resolution.outcomes ?? {})) if (outcome.damage?.mode === "shared") outcome.damage.sourceComponentIds = ["move"];
    copy.compilerEvidence = { ...copy.compilerEvidence, moveSaveExposure: { squares, formula } };
    return copy;
}

/**
 * The basic save opened on each round's first Sustain for the targets the cast's save failed (Steal Shadow's throttled shadow): the spell's plan
 * with that basic save's check and rows (its own damage, no conditions), one creature, instantaneous.
 */
export function sustainStrikePlan(plan) {
    const strike = plan?.resolution?.sustainStrike;
    if (!strike) return null;
    const copy = structuredClone(plan);
    delete copy.resolution.sustainStrike;
    copy.resolution.check = { ...structuredClone(plan.resolution.check), statistic: strike.statistic, basic: true };
    const ids = (plan.resolution.sharedDamage?.components ?? []).map(component => component.id);
    const row = multiplier => ({ damage: multiplier ? { mode: "shared", multiplier, sourceComponentIds: [...ids] } : { mode: "none", multiplier: 0, sourceComponentIds: [] }, effects: [], semanticCoverage: { fullyCompiled: true } });
    copy.resolution.outcomes = { criticalSuccess: row(0), success: row(0.5), failure: row(1), criticalFailure: row(2) };
    copy.resolution.reminders = [];
    copy.targeting = { ...copy.targeting, area: null, actorConstraints: { sourceText: "the creature whose save failed", supportsActorTargets: true, complete: true, predicates: [] } };
    copy.lifecycle = { ...copy.lifecycle, durationSpec: { mode: "instantaneous", raw: "" }, sustained: false, controller: null };
    copy.compilerEvidence = { ...copy.compilerEvidence, sustainStrikeExposure: true };
    // (A plain basic save: the automatic route.)
    copy.automation = { ...copy.automation, level: "automatic", pendingCapabilities: [] };
    return copy;
}

/**
 * The additional save of a persistent-damage spell (Dehydrate), taken at the end of each of the creature's turns while that damage lasts: the
 * spell's plan with the additional save's check and degree table, no damage, no area, one creature.
 */
export function followUpExposurePlan(plan) {
    const follow = plan?.resolution?.followUpSave;
    if (!follow) return null;
    const copy = structuredClone(plan);
    delete copy.resolution.followUpSave;
    delete copy.resolution.degreeAdjustment;
    copy.resolution.check = structuredClone(follow.check);
    copy.resolution.outcomes = structuredClone(follow.outcomes);
    copy.resolution.sharedDamage = null;
    copy.compilerEvidence = { ...copy.compilerEvidence, basicDegreeAdjustment: undefined };
    copy.targeting = { ...copy.targeting, area: null, actorConstraints: { sourceText: "the creature taking the persistent damage", supportsActorTargets: true, complete: true, predicates: [] } };
    copy.lifecycle = { ...copy.lifecycle, durationSpec: { mode: "instantaneous", raw: "" }, sustained: false, controller: null };
    // A degree table (not a basic save) is the guided degree-outcome route.
    copy.automation = { ...copy.automation, level: "guided" };
    return copy;
}

/** A persistent-damage spell's additional save: at each turn's end, while that damage lasts, one creature, an executable degree save. */
export function isExecutableFollowUpSave(plan) {
    const follow = plan?.resolution?.followUpSave;
    if (follow == null) return true;
    const persistent = (plan.resolution.sharedDamage?.components ?? []).filter(component => component.category === "persistent").map(component => component.type);
    return follow.timing === "turn-end" && persistent.length === 1 && follow.damageType === persistent[0] && typeof follow.question === "string" && follow.question.length > 0
        && follow.check?.basic === false && follow.check.statistic === follow.statistic && Number.isInteger(follow.durationSeconds) && follow.durationSeconds > 0
        && Array.isArray(plan.compilerEvidence?.followUpSave) && inspectSavePlan(followUpExposurePlan(plan)).supported;
}

/** The triggering creature's save of a stored-trigger spell (the trigger itself is the Ongoing record's). */
export function storedTriggerExposurePlan(plan) {
    const copy = structuredClone(plan);
    const stored = copy.resolution.storedTrigger;
    delete copy.resolution.storedTrigger;
    // "The target is then temporarily immune for 1 minute.": after the triggered save.
    if (stored?.immunity) copy.resolution.temporaryImmunity = { key: copy.source.slug, duration: { value: stored.immunity.value, unit: stored.immunity.unit }, sourceText: stored.immunity.sourceText };
    return copy;
}

/** A spell that waits for its trigger (Animus Mine, Bandit's Doom, Crescent Scepter): a well-formed declaration and an executable save. */
/** A stored trigger's Hit Point pool: its starting HP, the per-step increase, the flat check DC, and the burst's range. */
export function isStoredPool(pool) {
    return typeof pool?.label === "string" && /^[a-z]+$/.test(pool.label) && Number.isInteger(pool.hp) && pool.hp > 0 && Number.isInteger(pool.perStep) && pool.perStep >= 0
        && (pool.perStep === 0 ? pool.interval == null : Number.isInteger(pool.interval) && pool.interval > 0)
        && Number.isInteger(pool.flatDC) && pool.flatDC >= 2 && pool.flatDC <= 20 && Number.isInteger(pool.range) && pool.range > 0;
}

/** A stored trigger's images: how many to start with and at most, one more a Sustain, the hit-you odds for each count, and the save's range. */
export function isStoredImages(images) {
    return typeof images?.noun === "string" && /^[a-z]+$/.test(images.noun) && Number.isInteger(images.start) && Number.isInteger(images.max)
        && images.start >= 1 && images.start <= images.max && images.max <= 6 && images.perSustain === 1 && Number.isInteger(images.range) && images.range > 0
        && Array.isArray(images.odds) && images.odds.length === images.max
        && images.odds.every((entry, index) => entry.count === index + 1 && /^1d\d+$/.test(entry.die) && Number.isInteger(entry.you) && entry.you >= 1 && entry.you < Number(entry.die.slice(2)));
}

/** A pool's Hit Points at a cast rank. */
export function storedPoolHp(pool, castRank, baseRank) {
    return pool.hp + (pool.perStep ? Math.floor(Math.max(0, castRank - baseRank) / pool.interval) * pool.perStep : 0);
}

export function isExecutableStoredTriggerPlan(plan) {
    const stored = plan?.resolution?.storedTrigger;
    if (!stored || plan.resolution.kind !== "save" || (plan.automation?.pendingCapabilities ?? []).length) return false;
    // A timed spell ends on its trigger; one lasting until the caster's next turn saves every triggering creature.
    const timed = stored.endsOnTrigger === true && Number.isInteger(stored.durationSeconds) && stored.durationSeconds > 0 && stored.markerDuration == null;
    const untilNextTurn = stored.endsOnTrigger === false && stored.durationSeconds == null
        && stored.markerDuration?.value === 1 && stored.markerDuration.unit === "rounds" && stored.markerDuration.expiry === "turn-start";
    // Held on the cast's target: any number of times while sustained, or once on the target's next turn.
    const held = stored.held === true && (
        (stored.endsOnTrigger === false && stored.sustained === true && Number.isInteger(stored.durationSeconds) && stored.durationSeconds > 0 && stored.markerDuration == null)
        || (stored.endsOnTrigger === true && stored.sustained === false && stored.durationSeconds == null && stored.markerDuration?.anchor === "target-turn"
            && stored.markerDuration.expiry === "turn-end" && stored.markerDuration.value === 1)
        // A Hit Point pool around the target for the spell's duration, ended when it's broken (Shattering Gem): the save is the attacker's.
        || (stored.pool != null && isStoredPool(stored.pool) && stored.saveTarget === "attacker" && stored.endsOnTrigger === true && stored.sustained === false
            && Number.isInteger(stored.durationSeconds) && stored.durationSeconds > 0 && stored.markerDuration == null))
        && (stored.pool == null || stored.saveTarget === "attacker")
        && (stored.immunity == null || (Number.isInteger(stored.immunity.value) && ["minutes", "hours", "days"].includes(stored.immunity.unit)));
    // PF2e's own Effect as the marker, until the start of the caster's next turn, ended by its one trigger (Glass Shield).
    const effectUntilNextTurn = stored.effectMarker != null && stored.endsOnTrigger === true && stored.durationSeconds == null
        && stored.markerDuration?.value === 1 && stored.markerDuration.unit === "rounds" && stored.markerDuration.expiry === "turn-start";
    // PF2e's own Effect as the marker of a sustained spell, triggered any number of times while it lasts (Crown of Prophets).
    const effectSustained = stored.effectMarker != null && stored.endsOnTrigger === false && stored.sustained === true && Number.isInteger(stored.durationSeconds) && stored.durationSeconds > 0
        && stored.markerDuration == null && !stored.held && !stored.aura;
    // A sustained aura on the caster: any number of triggers while sustained.
    const aura = stored.aura === true && stored.endsOnTrigger === false && stored.sustained === true && Number.isInteger(stored.durationSeconds) && stored.durationSeconds > 0
        && stored.markerDuration == null && !stored.held;
    // A ward on an entrance, triggered any number of times while it lasts (Devil's Horseshoe).
    const ward = stored.ward === true && stored.endsOnTrigger === false && stored.sustained !== true && Number.isInteger(stored.durationSeconds) && stored.durationSeconds > 0
        && stored.markerDuration == null && !stored.held && !stored.aura && stored.effectMarker == null;
    // Images on the caster that take hits, broken by misses, added on each Sustain (Trickster's Mirrors).
    const images = stored.images != null && isStoredImages(stored.images) && stored.saveTarget === "attacker" && stored.endsOnTrigger === false && stored.sustained === true
        && Number.isInteger(stored.durationSeconds) && stored.durationSeconds > 0 && stored.markerDuration == null && !stored.held && !stored.aura && stored.effectMarker == null;
    return typeof stored.trigger === "string" && stored.trigger.length > 0 && (stored.images != null ? images : stored.held ? held : stored.aura ? aura : stored.ward ? ward : (timed || untilNextTurn || effectUntilNextTurn || effectSustained)) && typeof stored.supersedes === "boolean"
        && Array.isArray(stored.notes) && stored.notes.every(note => typeof note === "string")
        && Array.isArray(stored.rowNotes) && stored.rowNotes.every(note => typeof note?.text === "string" && ["criticalSuccess", "success", "failure", "criticalFailure"].includes(note.degree))
        && inspectSavePlan(storedTriggerExposurePlan(plan)).supported;
}

export function inspectSavePlan(plan) {
    if (plan?.resolution?.storedTrigger) return {supported: false, route: "stored-trigger", blockers: [{code: "stored-trigger", path: "resolution.storedTrigger", message: "This spell waits for its trigger in Ongoing spells; it isn't a one-time save."}]};
    if (plan?.resolution?.lingering) return {supported: false, route: "lingering-area", blockers: [{code: "lingering-area", path: "resolution.lingering", message: "This area is resolved by the lingering-area workflow, not a one-time save."}]};
    // "If the target critically succeeds at any … save, … the spell ends": only on a lingering save's critical success, from the sentence the compiler read.
    const criticalEnds = Object.entries(plan?.resolution?.outcomes ?? {}).filter(([, outcome]) => outcome?.endsSpellOn != null);
    if (criticalEnds.some(([degree, outcome]) => degree !== "criticalSuccess" || outcome.endsSpellOn !== "critical-success" || outcome.endsSpell !== true
        || !(plan.compilerEvidence?.lingeringExposure === true || plan.resolution.lingering) || !Array.isArray(plan.compilerEvidence?.mirrorRing)))
        return {supported: false, route: "critical-end", blockers: [{code: "critical-end", path: "resolution.outcomes", message: "Ending the spell on a result needs a lingering save's critical success and its sentence."}]};
    // The spell's damage again on a turn event for the failing targets (Positive Attunement): the stated rows, a 1× or 2× multiplier, a known event.
    const turnHazard = plan?.resolution?.turnHazard;
    if (turnHazard != null && !(plan.resolution.check?.basic === false && Object.keys(turnHazard.multipliers ?? {}).length > 0
        && Object.entries(turnHazard.multipliers).every(([degree, value]) => ["success", "failure", "criticalFailure"].includes(degree) && [1, 2].includes(value))
        && Array.isArray(turnHazard.events) && turnHazard.events.length > 0 && turnHazard.events.every(event => ["source-turn-end", "turn-end", "turn-start"].includes(event))
        && Number.isInteger(turnHazard.durationSeconds) && turnHazard.durationSeconds > 0 && /^[a-z]+$/.test(turnHazard.type ?? "")
        && (plan.resolution.sharedDamage?.components ?? []).length === 1 && String(plan.resolution.sharedDamage.components[0].type).toLowerCase() === turnHazard.type
        && Array.isArray(plan.compilerEvidence?.turnHazard) && plan.compilerEvidence.turnHazard.includes(turnHazard.sourceText)))
        return {supported: false, route: "turn-hazard", blockers: [{code: "turn-hazard", path: "resolution.turnHazard", message: "Damage again on a turn event needs the stated rows, multiplier and event."}]};
    // Conditions gated on how many targets failed (Entangle Fate): the stated results and a minimum of two.
    const gated = Object.values(plan?.resolution?.outcomes ?? {}).flatMap(outcome => (outcome?.effects ?? []).filter(effect => effect.choiceGroup === "group-gate"));
    if (gated.length && !(typeof plan.compilerEvidence?.groupGate === "string" && gated.every(effect => Array.isArray(effect.groupGate?.degrees) && effect.groupGate.degrees.length > 0
        && effect.groupGate.degrees.every(degree => ["criticalSuccess", "success", "failure", "criticalFailure"].includes(degree)) && Number.isInteger(effect.groupGate.minimum) && effect.groupGate.minimum >= 2)))
        return {supported: false, route: "group-gate", blockers: [{code: "group-gate", path: "resolution.outcomes", message: "Conditions gated on other targets' results need the stated results and count."}]};
    // The target's choice of save (Shadow Blast's "Reflex or Will (target's choice)"): the two stated saves, the first the check's; the card
    // rolls the better.
    const saveChoice = plan?.resolution?.check?.saveChoice;
    // (Or a save and a skill check the text names together: "must each attempt a Reflex save or Acrobatics check".)
    const skillChoice = saveChoice != null && Array.isArray(saveChoice.statistics) && saveChoice.statistics.length === 2 && saveChoice.statistics[0] === plan.resolution.check.statistic
        && ["acrobatics", "athletics"].includes(saveChoice.statistics[1]) && saveChoice.chooser === "target" && typeof saveChoice.sourceText === "string"
        && plan.compilerEvidence?.saveChoice === saveChoice.sourceText && new RegExp(`\\b${saveChoice.statistics[0]} save or ${saveChoice.statistics[1]} check\\b`, "i").test(saveChoice.sourceText);
    if (saveChoice != null && !skillChoice && !(Array.isArray(saveChoice.statistics) && saveChoice.statistics.length === 2 && new Set(saveChoice.statistics).size === 2
        && saveChoice.statistics.every(statistic => ["fortitude", "reflex", "will"].includes(statistic)) && saveChoice.statistics[0] === plan.resolution.check.statistic
        && saveChoice.chooser === "target" && typeof saveChoice.sourceText === "string" && plan.compilerEvidence?.saveChoice === saveChoice.sourceText
        && saveChoice.statistics.every(statistic => saveChoice.sourceText.includes(`@Check[${statistic}|`))))
        return {supported: false, route: "save-choice", blockers: [{code: "save-choice", path: "resolution.check.saveChoice", message: "A target's choice of save needs the two stated saves."}]};
    // A rolled element's extras (Elemental Breath): the terrain the card places, and the caster's split of the heightened dice between two types.
    // Charges the save leaves, each popped for a basic save of its own (Blister): the counts by result and the pop's executable plan.
    const pop = plan?.resolution?.popSave;
    if (pop != null && !(pop.plan?.resolution?.kind === "save" && pop.plan.resolution.check?.basic === true && !pop.plan.resolution.popSave && inspectSavePlan(pop.plan).supported
        && Object.entries(pop.uses ?? {}).length > 0 && Object.entries(pop.uses).every(([degree, count]) => SAVE_DEGREES.includes(degree) && Number.isInteger(count) && count > 0)
        && /^[a-z]+$/.test(pop.noun ?? "") && (plan.compilerEvidence?.popSave ?? []).includes(pop.sourceText) && plan.resolution.check?.basic === false))
        return {supported: false, route: "pop-save", blockers: [{code: "pop-save", path: "resolution.popSave", message: "Popped charges need their counts and the pop's own executable plan."}]};
    // A second save for the creatures around the target, unless it got a stated result (Grisly Growths): its own executable plan.
    const follow = plan?.resolution?.areaFollowUp;
    if (follow != null && !(Number.isInteger(follow.radius) && follow.radius > 0 && Array.isArray(follow.unless) && follow.unless.every(degree => SAVE_DEGREES.includes(degree))
        && (plan.compilerEvidence?.areaFollowUp ?? []).includes(follow.sourceText) && follow.plan?.resolution?.kind === "save"
        // (Grisly Growths' second save with its immunity; or Propagating Arc's spread — a basic save for the others around the target, half beyond the inner
        // distance, only when one is within it.)
        && (follow.outer == null ? follow.plan.resolution.temporaryImmunity && follow.excludeCentre == null && follow.needsInner == null
            : Number.isInteger(follow.outer.radius) && follow.outer.radius > follow.radius && follow.outer.half === true && follow.excludeCentre === true && follow.needsInner === true
                && follow.plan.resolution.check?.basic === true && plan.resolution.check?.basic === true)
        && !follow.plan.resolution.areaFollowUp && inspectSavePlan(follow.plan).supported && !plan.targeting?.area))
        return {supported: false, route: "area-follow-up", blockers: [{code: "area-follow-up", path: "resolution.areaFollowUp", message: "The second save around the target needs its own executable plan, distance and sentence."}]};
    // Healing in a second area by the most a creature lost in the first (Blood-Feasting Breath).
    const spread = plan?.resolution?.healSpread;
    if (spread != null && !(Object.keys(spread).every(key => ["measure", "caster", "recipients", "sourceText"].includes(key)) && spread.measure === "most-lost" && spread.caster === true
        && spread.recipients === "living" && (plan.compilerEvidence?.healSpread ?? []).includes(spread.sourceText) && plan.resolution.check?.basic === true))
        return {supported: false, route: "heal-spread", blockers: [{code: "heal-spread", path: "resolution.healSpread", message: "Healing in the second area needs its stated measure, recipients and sentence."}]};
    // The caster's part after the target loses Hit Points (Call the Blood): by what the caster is.
    const draw = plan?.resolution?.casterDraw;
    if (draw != null && !isCasterDraw(plan))
        return {supported: false, route: "caster-draw", blockers: [{code: "caster-draw", path: "resolution.casterDraw", message: "The caster's part needs its stated conditions, times and sentences."}]};
    const areaTerrain = plan?.resolution?.areaTerrain;
    // (An incarnate's phase: "The area … becomes difficult terrain for 1 round.", whole rounds.)
    const roundTerrain = areaTerrain != null && Number.isInteger(areaTerrain.durationSeconds) && areaTerrain.durationSeconds > 0 && areaTerrain.durationSeconds % 6 === 0
        && areaTerrain.hazard == null && areaTerrain.sustained == null && (plan.compilerEvidence?.incarnateTerrain ?? []).includes(areaTerrain.sourceText);
    if (areaTerrain != null && !roundTerrain && !(Number.isInteger(areaTerrain.durationSeconds) && areaTerrain.durationSeconds > 0 && areaTerrain.durationSeconds % 60 === 0
        && typeof areaTerrain.sourceText === "string" && ((plan.compilerEvidence?.elementVariant ?? []).includes(areaTerrain.sourceText) && areaTerrain.hazard == null && areaTerrain.sustained == null
            || isStormArea(plan) || isReefTerrain(plan) || isWaveTerrain(plan) || isShadowTerrain(plan))))
        return {supported: false, route: "area-terrain", blockers: [{code: "area-terrain", path: "resolution.areaTerrain", message: "Terrain the card places needs its stated sentence and time."}]};
    const split = plan?.resolution?.sharedDamage?.diceSplit;
    const splitComponents = plan?.resolution?.sharedDamage?.components ?? [];
    if (split != null && !(plan.resolution.sharedDamage.mode === "pf2e-item-damage" && splitComponents.length === 2 && split.from !== split.to
        && splitComponents.some(component => String(component.type).toLowerCase() === split.from) && splitComponents.some(component => String(component.type).toLowerCase() === split.to)
        && [4, 6, 8, 10, 12].includes(split.faces) && splitComponents.every(component => new RegExp(`d${split.faces}$`).test(String(component.formula)))
        && Number.isInteger(split.baseRank) && typeof split.sourceText === "string" && /you can choose which damage type increases for each rank/.test(split.sourceText)))
        return {supported: false, route: "dice-split", blockers: [{code: "dice-split", path: "resolution.sharedDamage.diceSplit", message: "Splitting the heightened dice needs the two stated damage types."}]};
    return isExecutableBasicSavePlan(plan)
        ? {supported: true, route: "basic-save", blockers: []}
        : inspectDegreeSavePlan(plan);
}

export function isExecutableSavePlan(plan) {
    return inspectSavePlan(plan).supported;
}

/**
 * An incarnate's parts, each checked as the runtime will carry it out: a save, attack or lingering part's own plan; damage or healing dice; a generated
 * Effect's note (rules, granted conditions, d20 limit, time); PF2e's Effect; conditions reduced; a cast spell's own plan; a cloud's rules. Returns the
 * reasons a part can't run (empty when every part can).
 */
export function inspectIncarnatePlan(plan) {
    const data = plan?.resolution?.kind === "incarnate" ? plan.resolution.incarnate : null;
    if (!data) return ["Not an incarnate plan."];
    const sets = data.options ? (data.options.choices ?? []).map(choice => choice.phases ?? []) : [data.phases ?? []];
    // (A conjured creature's statistics: Dragon Turret's.)
    const c = data.conjure;
    const conjure = c == null || (typeof c.name === "string" && ["tiny", "sm", "med", "lg", "huge", "grg"].includes(c.size) && [c.ac, c.hp, c.rangeFeet].every(value => Number.isInteger(value) && value > 0) && Number.isInteger(c.saves) && c.saves >= 0
        && Array.isArray(c.immunities) && c.immunities.every(type => /^[a-z-]+$/.test(type)) && Array.isArray(c.weaknesses) && Array.isArray(c.resistances) && Array.isArray(c.traits)
        && Number.isFinite(c.durationSeconds) && c.durationSeconds > 0 && typeof c.sustained === "boolean"
        && (c.concealing == null || (Number.isInteger(c.concealing.radius) && c.concealing.radius > 0)) && (c.object == null || c.object === true)
        // (Ice Guardian: its statistics each rank up, and its side's cover beside it — circumstance AC only.)
        && (c.step == null || [c.step.baseRank, c.step.hp, c.step.ac, c.step.weakness].every(value => Number.isInteger(value) && value >= 0))
        && (c.coverAura == null || (Number.isInteger(c.coverAura.feet) && c.coverAura.feet > 0 && c.coverAura.rules?.length === 1 && c.coverAura.rules[0].key === "FlatModifier"
            && c.coverAura.rules[0].selector === "ac" && c.coverAura.rules[0].type === "circumstance" && [1, 2, 4].includes(c.coverAura.rules[0].value))));
    // (A card whose parts' Effects last the spell's time — Unbreaking Wave Containment's hold, Sustained; Doom Mark's marks — and the marks' payoff.)
    // (Parts whose Effects or watched triggers belong to the card's record need one.)
    const needsRecord = sets.some(phases => phases.some(part => ["link", "leech", "mimic", "death-mark", "word", "emblem", "revive", "shock", "seed", "pod", "gift"].includes(part?.kind)));
    const lasting = data.lasting == null ? !needsRecord : (Number.isInteger(data.lasting.seconds) && data.lasting.seconds > 0 && typeof data.lasting.sustained === "boolean");
    const mark = data.markTrigger == null || (data.lasting != null && Array.isArray(data.markTrigger.conditions) && data.markTrigger.conditions.length > 0
        && data.markTrigger.conditions.every(entry => /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(entry.uuid ?? "") && /^[a-z-]+$/.test(entry.slug ?? "") && (entry.value == null || Number.isInteger(entry.value)))
        && Number.isInteger(data.markTrigger.rounds) && data.markTrigger.rounds > 0);
    return [...(conjure ? [] : ["The conjured creature's statistics can't be read."]), ...(lasting ? [] : ["The card's time can't be read."]), ...(mark ? [] : ["The marks' payoff can't be read."]),
        ...sets.flatMap(phases => inspectParts(phases))];
}

/** The reasons a card's parts (an incarnate's phases, a spell's controls) can't run: empty when every part can. */
export function inspectParts(phases) {
    const problems = [];
    // (Fixed Heightened entries read as "ternary(gte(@item.rank,9),3,2)": Fire Seeds' flames.)
    const formula = value => typeof value === "string" && /^(?:[\d\s()+*\/,-]|@item\.(?:rank|level)|max|min|floor|ceil|ternary|gte|d(?=\d)|\{|\}|\[[a-z,]+\])+$/.test(value) && /\d+d\d+|\)d\d+/.test(value);
    {
        if (!phases.length) problems.push("A card has no parts.");
        const keys = new Set();
        for (const part of phases) {
            const where = `${part?.key ?? "?"} (${part?.title ?? "?"})`;
            if (!part?.key || keys.has(part.key)) problems.push(`${where}: a part needs its own key.`);
            keys.add(part?.key);
            if (part?.note) { if (part.kind != null && part.kind !== "note") problems.push(`${where}: a note part is only text.`); continue; }
            const kind = part?.kind ?? "save";
            if (kind === "save" || kind === "attack") {
                const ok = (part.linger ? isExecutableLingeringPlan(part.plan) : isExecutableSavePlan(part.plan))
                    && (part.byRank == null || (Array.isArray(part.byRank) && part.byRank.every(entry => Number.isInteger(entry.minRank) && isExecutableSavePlan(entry.plan))));
                if (!ok) problems.push(`${where}: its ${part.linger ? "lingering area" : "save"} plan isn't executable.`);
                if (kind === "attack" && !(part.plan?.resolution?.check?.statistic === "spell-attack" && Number.isInteger(part.count) && part.count > 0)) problems.push(`${where}: spell attacks need their count.`);
                if (part.repeat && !(typeof part.repeat.trigger === "string" && part.repeat.trigger.length > 0)) problems.push(`${where}: a repeated save needs its trigger.`);
                if (part.immunityRounds != null && !(Number.isInteger(part.immunityRounds) && part.immunityRounds > 0)) problems.push(`${where}: immunity needs whole rounds.`);
            } else if (kind === "damage" || kind === "heal") {
                if (!formula(part.formula)) problems.push(`${where}: its dice can't be read.`);
                if (part.count != null && !(Number.isInteger(part.count) && part.count > 0)) problems.push(`${where}: its creature count isn't whole.`);
            } else if (kind === "effect") {
                const grants = (part.grants ?? []).map(grant => ({ key: "GrantItem", uuid: grant.uuid, flag: `condition${String(grant.slug).split("-").map(word => word[0].toUpperCase() + word.slice(1)).join("")}`,
                    ...(grant.value ? { alterations: [{ mode: "override", property: "badge-value", value: grant.value }] } : {}), ...(grant.predicate ? { predicate: grant.predicate } : {}) }));
                if (!validNoteEffect({ label: part.label, text: part.text, sourceText: part.sourceText, rules: [...(part.rules ?? []), ...grants], duration: part.duration, ...(part.d20Clamp ? { d20Clamp: part.d20Clamp } : {}), ...(part.turnStartAttack ? { turnStartAttack: part.turnStartAttack } : {}), ...(part.endsInDeath ? { endsInDeath: true } : {}), ...(part.zeroToOne ? { zeroToOne: true } : {}) }))
                    problems.push(`${where}: its Effect's rules or time can't be made.`);
                const byRank = entry => entry == null || (Number.isInteger(entry.base) && entry.base > 0 && Object.entries(entry.byRank ?? {}).every(([rank, value]) => /^\d+$/.test(rank) && Number.isInteger(value) && value > 0));
                if (!byRank(part.acSet) || !byRank(part.tempHp)) problems.push(`${where}: its stated AC or temporary Hit Points can't be read.`);
            } else if (kind === "native-effect") {
                if (!/^Compendium\.pf2e\.spell-effects\.Item\.[^\]]+$/.test(part.uuid ?? "")) problems.push(`${where}: PF2e's Effect link is missing.`);
            } else if (kind === "reduce-conditions") {
                if (!(Array.isArray(part.slugs) && part.slugs.length && part.slugs.every(slug => /^[a-z-]+$/.test(slug)) && Number.isInteger(part.by) && part.by > 0)) problems.push(`${where}: the conditions to reduce can't be read.`);
            } else if (kind === "cast-spell") {
                if (!/^Compendium\.pf2e\.spells-srd\.Item\.[A-Za-z0-9]+$/.test(part.uuid ?? "") || !Number.isInteger(part.rank)) problems.push(`${where}: the cast spell or its rank is missing.`);
                const cast = part.plan;
                const runs = cast?.resolution?.kind === "save" ? (cast.resolution.lingering ? isExecutableLingeringPlan(cast) : isExecutableSavePlan(cast))
                    : !!cast?.resolution && !["unsupported", "unsafe"].includes(cast.automation?.level) && !(cast.automation?.pendingCapabilities ?? []).length;
                if (!runs) problems.push(`${where}: ${part.name ?? "the cast spell"} can't be resolved by its own route.`);
                if (part.durationRounds != null && !(Number.isInteger(part.durationRounds) && part.durationRounds > 0)) problems.push(`${where}: the shortened time isn't whole rounds.`);
            } else if (kind === "cloud") {
                if (!(part.durationSeconds > 0 && part.area?.value > 0 && Array.isArray(part.memberRules) && part.memberRules.every(rule => (rule.key === "GrantItem" && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(rule.uuid ?? "")
                    && Array.isArray(rule.predicate) && rule.predicate.every(term => /^self:trait:[a-z]+$/.test(term)))
                    || (rule.key === "Sense" && rule.selector === "truesight" && Array.isArray(rule.predicate) && rule.predicate.every(term => /^self:trait:[a-z]+$/.test(term))))))
                    problems.push(`${where}: the cloud's area, time or rules can't be read.`);
            } else if (kind === "check-copy") {
                // (Reanimate Foe: the caster's skill check against the level DC; a copy with stated Hit Points and loss, or a thrall.)
                const copy = result => Number.isInteger(result?.hp) && result.hp > 0 && /^(?:\d+|\d+d\d+)$/.test(String(result.hpLoss ?? "")) && Number.isInteger(result.seconds) && result.seconds > 0
                    && typeof result.halfDamage === "boolean";
                if (!/^[a-z-]+$/.test(part.skill ?? "") || !["criticalSuccess", "success", "failure", "criticalFailure"].every(degree => copy(part.results?.[degree]) || part.results?.[degree]?.thrall === true))
                    problems.push(`${where}: the check and its results can't be read.`);
            } else if (kind === "summon") {
                // (Gray Shadow's named creature, beside the dying target; Shambling Horror's listed stat blocks, at the corpse.)
                const uuidOk = uuid => /^Compendium\.pf2e\.[a-z-]+\.Actor\.[A-Za-z0-9]+$/.test(uuid ?? "");
                if (!((uuidOk(part.actorUuid) && !part.candidates) || (Array.isArray(part.candidates) && part.candidates.length > 0 && part.candidates.every(entry => (entry.uuid == null || uuidOk(entry.uuid))
                    && typeof entry.name === "string" && Number.isInteger(entry.level) && ["tiny", "sm", "med", "lg", "huge", "grg"].includes(entry.size)))) || !(Number.isFinite(part.seconds) && part.seconds > 0) || part.near !== "target")
                    problems.push(`${where}: the creature to summon, its place or its time can't be read.`);
            } else if (kind === "terrain") {
                // (Elemental Confluence's wood: difficult terrain in the conjured thing's area for whole rounds.)
                // (Or a placed shape — Flesh Tsunami's 60-foot cone of greater difficult terrain.)
                const placed = part.place != null && ["cone", "burst", "line", "emanation"].includes(part.place.type) && Number.isInteger(part.place.value) && part.place.value > 0 && [2, 3].includes(part.difficulty);
                if (!((part.onConjured === true || placed) && Number.isInteger(part.rounds) && part.rounds > 0)) problems.push(`${where}: the terrain's area or time can't be read.`);
            } else if (kind === "hazard") {
                // (Burning Blossoms' petals: a placed area dealing its damage, no save, to each creature ending its turn there, for whole rounds.)
                // (Or a flat amount of a type the caster picks, on difficult ground: Planar Collision's 15 of the plane's type.)
                // (Pierce the Sky's lines: one drawn from the caster to each targeted creature, damaging a creature entering or starting its turn there, once a round.)
                const between = part.between === true && part.place == null && JSON.stringify(part.events) === '["enter","turn-start"]' && part.oncePerRound === true;
                // (Or a square that burns a creature entering it or ending its turn there, for rounds rolled when it's placed: Dynamic Ignition.)
                const square = part.place?.type === "square" && JSON.stringify(part.events) === '["enter","turn-end"]' && /^\d+d\d+$/.test(part.roundsRoll ?? "");
                if (!((between || square || (part.place != null && ["burst", "emanation", "cone", "line"].includes(part.place.type) && Number.isInteger(part.place.value) && part.place.value > 0
                    && JSON.stringify(part.events) === '["turn-end"]')) && (formula(part.formula) || /^\d+$/.test(part.formula ?? "") || (square && /^\(\d+\+@item\.(?:rank|level)\)$/.test(part.formula ?? ""))) && (/^[a-z]+$/.test(part.type ?? "")
                        || (Array.isArray(part.typeChoice) && part.typeChoice.length > 1 && part.typeChoice.every(value => /^[a-z]+$/.test(value))))
                    && (part.terrain == null || [2, 3].includes(part.terrain)) && Number.isInteger(part.rounds) && part.rounds > 0 && typeof part.label === "string"))
                    problems.push(`${where}: the area's damage, its trigger or its time can't be read.`);
            } else if (["true-target", "covenant", "heartbolt"].includes(kind)) {
                // (support-cards.js: PF2e's Effect and the rest of the text — True Target's mark, Sacred Covenant's pact; Heartbolt's bolt and plume.)
                const whole = value => Number.isInteger(value) && value > 0;
                const effect = value => /^Compendium\.pf2e\.spell-effects\.Item\.[A-Za-z0-9]+$/.test(value ?? "");
                const ok = kind === "true-target" ? whole(part.count) && effect(part.effectUuid) && /^[a-z-]+$/.test(part.markSlug ?? "")
                    : kind === "covenant" ? whole(part.count) && whole(part.hp) && whole(part.wounded) && effect(part.effectUuid)
                    : whole(part.radius) && formula(part.boltFormula) && /floor\(@item\.rank \/ 2\) \* \d+/.test(part.plumeFormula ?? "") && isExecutableSavePlan(part.boltPlan) && isExecutableSavePlan(part.plumePlan);
                if (!ok) problems.push(`${where}: the Effect, its mark or the healing can't be read.`);
            } else if (["seed", "pod", "gift"].includes(kind)) {
                // (Things picked up and used, pickup-cards.js: a thrown burst's save and its burning ground; a season's pod; a gift's benefits.)
                const whole = value => Number.isInteger(value) && value > 0;
                const ok = kind === "gift" ? whole(part.radius) && formula(part.heal) && Array.isArray(part.conditions) && part.conditions.length > 1 && part.conditions.every(slug => /^[a-z-]+$/.test(slug))
                        && whole(part.by) && whole(part.eachBy) && Array.isArray(part.afflictions) && !!part.repeat
                    : isExecutableSavePlan(part.plan) && part.place?.type === "burst" && whole(part.place.value) && whole(part.range)
                        && (kind === "pod" || (whole(part.count) && formula(part.flames?.formula) && /^[a-z]+$/.test(part.flames?.type ?? "") && whole(part.flames?.seconds)
                            && JSON.stringify(part.flames?.events) === '["enter","turn-end"]' && !!part.repeat));
                if (!ok) problems.push(`${where}: the thing's burst, save or benefits can't be read.`);
            } else if (["raise", "revive", "shock", "renewal"].includes(kind)) {
                // (Spells bringing creatures back, revival-cards.js: the levels, the healing, the debilitation, the supercharge, the day's recovery.)
                const condition = entry => /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(entry?.uuid ?? "");
                const whole = value => Number.isInteger(value) && value > 0;
                const weak = value => Array.isArray(value?.conditions) && value.conditions.length > 0 && value.conditions.every(entry => condition(entry) && whole(entry.value)) && whole(value.days);
                const ok = kind === "raise" ? Object.entries(part.levels ?? {}).length > 0 && Object.entries(part.levels).every(([rank, level]) => /^\d+$/.test(rank) && whole(level)) && whole(part.hp) && weak(part.debilitation) && typeof part.question === "string"
                    : kind === "revive" ? /^\d+d\d+\+\d+$/.test(part.formula ?? "") && weak(part.debilitation) && typeof part.question === "string"
                    : kind === "shock" ? formula(part.formula) && whole(part.wounded) && condition(part.quickened) && /^Compendium\.pf2e\.spells-srd\.Item\.[A-Za-z0-9]+$/.test(part.innate?.uuid ?? "")
                        && whole(part.innate.rank) && whole(part.innate.baseRank) && Number.isInteger(part.innate.step) && condition(part.cloud) && whole(part.seconds)
                    : whole(part.count) && part.hours === 24 && whole(part.immuneDays);
                if (!ok) problems.push(`${where}: the revival's numbers or links can't be read.`);
            } else if (["link", "sacrifice", "fury", "leech", "mimic", "death-mark", "word", "emblem"].includes(kind)) {
                // (Spells answering a trigger, trigger-cards.js: each part's stated save, numbers and links.)
                const save = ["fortitude", "reflex", "will"].includes(part.statistic);
                const condition = entry => /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(entry?.uuid ?? "");
                const whole = value => Number.isInteger(value) && value > 0;
                const ok = kind === "link" ? save && whole(part.range) && whole(part.immunityRounds)
                    : kind === "sacrifice" ? save && typeof part.question === "string"
                    : kind === "fury" ? save && condition(part.hidden) && whole(part.minutes)
                    : kind === "leech" ? save && /^[a-z]+$/.test(part.tradition ?? "") && /^\d+d\d+$/.test(part.heal ?? "") && condition(part.stunned) && whole(part.stunned.value) && whole(part.stunned.criticalRounds) && !!part.repeat
                        && phases.some(other => other.leechTargets === true && other.kind === "save")
                    : kind === "mimic" ? whole(part.sustainMinutes) && part.sameTradition === true
                    : kind === "death-mark" ? typeof part.reminder === "string" && phases.some(other => other.kind === "word")
                    : kind === "word" ? save && whole(part.immuneHours) && [part.success, part.failure].every(row => condition(row) && /^[a-z-]+$/.test(row.slug ?? "") && whole(row.value) && whole(row.perRank)) && whole(part.failure.deathImmuneHours)
                    : whole(part.bonus) && [part.die, part.critDie, part.heightened?.die, part.heightened?.critDie, part.heightened?.minRank, part.rounds].every(whole) && /^[a-z]+$/.test(part.type ?? "") && condition(part.offGuard);
                if (!ok) problems.push(`${where}: the trigger's save, numbers or links can't be read.`);
            } else if (kind === "attack-save") {
                // (Ray of Corruption: the module's spell attack against the target's AC; a hit starts the save — a degree worse on a critical hit.)
                if (!(isExecutableSavePlan(part.plan) && part.plan.resolution?.check?.statistic !== "spell-attack" && Number.isInteger(part.range) && part.range > 0 && typeof part.critWorse === "boolean" && part.repeat))
                    problems.push(`${where}: the attack's save can't be read.`);
            } else if (kind === "charge") {
                // (Comet Charge: the caster's flight to a space beside the target, then a hidden attack part — one for a metal target when the text says so.)
                const hiddenAttack = name => phases.some(other => other.key === name && other.hidden === true && other.kind === "attack");
                if (!(Number.isInteger(part.feet) && part.feet > 0 && hiddenAttack(part.attack) && (part.metalAttack == null || (hiddenAttack(part.metalAttack) && typeof part.question === "string"))
                    && /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(part.offGuard?.uuid ?? "")))
                    problems.push(`${where}: the charge's distance or its attack can't be read.`);
            } else if (kind === "teeth") {
                // (Ravenous Darkness: the placed darkness, the spell attack against each creature's save DC, the teeth's damage and penalty.)
                if (!(part.place?.type === "burst" && Number.isInteger(part.place.value) && part.place.value > 0 && Number.isInteger(part.seconds) && part.seconds > 0
                    && /^Compendium\.pf2e\.spells-srd\.Item\.[A-Za-z0-9]+$/.test(part.darkness?.uuid ?? "") && Number.isInteger(part.darkness?.rank) && ["fortitude", "reflex", "will"].includes(part.statistic)
                    && /^\d+d\d+$/.test(part.formula ?? "") && /^\d+d\d+$/.test(part.gnaw ?? "") && /^[a-z]+$/.test(part.type ?? "") && /^[a-z]+$/.test(part.gnawType ?? "") && Number.isInteger(part.speedPenalty) && part.speedPenalty > 0))
                    problems.push(`${where}: the darkness, the attack or the teeth can't be read.`);
            } else if (kind === "teleport") {
                // (A teleport on the card: the targets or the caster moved within the stated feet, or two creatures swapping places.)
                if (!(["move", "swap"].includes(part.mode) && ["target", "caster", "targets"].includes(part.who) && (part.mode === "swap" || (Number.isInteger(part.within) && part.within > 0 && ["caster", "self"].includes(part.from)))
                    && (part.count == null || (Number.isInteger(part.count) && part.count > 0)) && (part.immunity == null || (typeof part.immunity.key === "string" && Number.isInteger(part.immunity.duration?.value)))))
                    problems.push(`${where}: the teleport's range or who moves can't be read.`);
            } else if (kind === "mode") {
                // (A mode card's mode: the area's state — generated or PF2e's member Effects, terrain — and its own action, a hidden part on the same card.)
                const member = entry => entry == null || (typeof entry.generated?.name === "string" && Array.isArray(entry.generated.rules) && entry.generated.rules.every(rule => ["FlatModifier", "GrantItem", "AdjustModifier", "RollOption", "Note"].includes(rule.key)))
                    || /^Compendium\.pf2e\.spell-effects\.Item\.[A-Za-z0-9]+$/.test(entry.uuid ?? "");
                const state = part.state ?? {};
                if (!(member(state.memberEffect) && (state.memberEffects ?? []).every(member) && member(state.member) && (state.slot == null || (Number.isInteger(state.slot) && state.slot > 0))
                    && (state.terrain == null || [2, 3].includes(state.terrain.difficulty))
                    // (Control Sand: a held shield's stats, the area's new size, a following hazard of stated dice and basic save.)
                    && (state.shield == null || (Number.isInteger(state.shield.hardness) && Number.isInteger(state.shield.hp) && state.shield.hp > 0))
                    && (state.radius == null || (Number.isInteger(state.radius) && state.radius > 0))
                    && (state.child == null || (Number.isInteger(state.child.radius) && /^\d+d\d+$/.test(state.child.formula ?? "") && /^[a-z]+$/.test(state.child.type ?? "")))
                    && (part.action == null || phases.some(other => other.key === part.action && other.hidden === true)) && part.repeat))
                    problems.push(`${where}: the mode's area state or its action can't be read.`);
            } else if (kind === "temp-share") {
                // (Vampiric Revelry: the caster's temporary Hit Points from another part's save card, for the allies.)
                if (!(typeof part.from === "string" && phases.some(other => other.key === part.from && other.plan?.resolution?.casterBenefit) && Number.isInteger(part.seconds) && part.seconds > 0))
                    problems.push(`${where}: the shared temporary Hit Points need the part they come from and their time.`);
            } else if (kind === "beam-roll" || kind === "sequence") {
                // (Prismatic Spray's beams: a die whose results name hidden parts on the card, and the "twice" result. Prismatic Wall's layers: hidden parts, in order.)
                const hiddenPart = name => phases.some(other => other.key === name && other.hidden === true && other !== part);
                if (!(kind === "sequence" ? Array.isArray(part.sequence) && part.sequence.length > 0 && part.sequence.every(hiddenPart)
                    : Number.isInteger(part.die) && part.die > 1 && part.table && Object.entries(part.table).every(([face, name]) => Number(face) >= 1 && Number(face) <= part.die && hiddenPart(name))
                        && Number.isInteger(part.twice) && part.twice >= 1 && part.twice <= part.die && !part.table[part.twice] && new Set(Object.values(part.table)).size >= 2 && Object.keys(part.table).length === part.die - 1))
                    problems.push(`${where}: the parts it runs can't be read.`);
            } else if (kind === "fumarole") {
                // (Rainbow Fumarole: each die result's damage and added effect, the "All" result, the save, the placed area and its time.)
                const formula = value => typeof value === "string" && /^\{?(\d+(d\d+)?\[[a-z]+(,[a-z]+)?\],?)+\}?$/.test(value);
                const effect = value => value == null || ((value.conditions ?? []).every(entry => /^Compendium\.pf2e\.conditionitems\.Item\.[A-Za-z0-9]+$/.test(entry.uuid ?? "") && /^[a-z-]+$/.test(entry.slug ?? ""))
                    && (value.push == null || Number.isInteger(value.push)) && (value.rounds == null || Number.isInteger(value.rounds)) && ((value.conditions?.length ?? 0) > 0 || value.push));
                const colors = Object.entries(part.colors ?? {});
                if (!(Number.isInteger(part.die) && colors.length >= 2 && colors.every(([face, entry]) => Number(face) >= 1 && Number(face) <= part.die && typeof entry.name === "string" && formula(entry.formula) && effect(entry.effect))
                    && (part.all == null || (Number.isInteger(part.all) && !part.colors[part.all])) && ["fortitude", "reflex", "will"].includes(part.statistic)
                    && ["burst", "cylinder", "emanation"].includes(part.area?.type) && Number.isInteger(part.area?.value) && Number.isInteger(part.seconds) && part.seconds > 0 && (part.terrain == null || [2, 3].includes(part.terrain))))
                    problems.push(`${where}: the colors, save or area can't be read.`);
            } else if (kind === "glyph") {
                if (!(["fortitude", "reflex", "will"].includes(part.statistic) && /^\d+d\d+\[[a-z]+\]$/.test(part.formula ?? "") && Number.isInteger(part.seconds) && part.seconds > 0))
                    problems.push(`${where}: the glyph's save, dice or time can't be read.`);
            } else if (kind === "launch") {
                // (Wrathful Storm's tornado: the targets thrown up the stated feet, then PF2e's falling.)
                if (!(Number.isInteger(part.feet) && part.feet > 0)) problems.push(`${where}: the launch's height can't be read.`);
            } else if (kind === "fuse") {
                // (Amalgamizing Leap: the target taken into the caster — the caster's stated temporary Hit Points and extra reach until the end of its next turn.)
                if (!(Number.isInteger(part.tempHP) && part.tempHP > 0 && Number.isInteger(part.reach) && part.reach > 0)) problems.push(`${where}: the fusion's temporary Hit Points or reach can't be read.`);
            } else if (kind === "hp-share" || kind === "elevate" || kind === "descend") {
                if ((kind !== "hp-share" && !(Number.isInteger(part.feet) && part.feet > 0)) || (kind === "descend" && part.stepFeet != null && !Number.isInteger(part.stepFeet))) problems.push(`${where}: the movement's distance can't be read.`);
            } else if (kind === "destroy-thrall") {
                if (typeof part.reminder !== "string" || !part.reminder) problems.push(`${where}: the thrall to destroy needs its reminder.`);
            } else problems.push(`${where}: the module doesn't carry out a ${kind} part.`);
        }
    }
    return problems;
}

export function outcomeForTarget(state, target) {
    // A creature with the trait the spell treats differently (Flense's undead) uses that table.
    const outcome = target?.traitVariant && state.traitVariant?.outcomes ? state.traitVariant.outcomes[target?.degree] ?? null : state.outcomes?.[target?.degree] ?? null;
    // (Split Shot's second target: "no effects beyond the spell's initial damage" — the row's damage alone.)
    if (target?.shapeDamageOnly && outcome) return outcome.damage ? { damage: outcome.damage } : null;
    return outcome;
}

export function targetParticipates(target) {
    // A heal-or-harm target being healed takes no save; it's healed by the spell's roll at Finalize.
    return target?.excluded !== true && target?.eligible !== false && target?.mode !== "healing" && target?.mode !== "splash" && target?.mode !== "ally" && target?.mode !== "trait-grant";
}

/** Creatures within the splash radius of the attack's target: they take only the splash, and only on a hit. */
export function splashTargets(state) {
    return (state?.targets ?? []).filter(target => target?.mode === "splash" && target.excluded !== true && target.eligible !== false);
}

/**
 * Splash damage in a spell attack: one target, splash entries named by the proof, and rows that are a
 * critical hit (×2), a hit (×1) or nothing. The card doubles only the non-splash part.
 */
export function executableSplash(plan) {
    const splash = plan?.resolution?.splash;
    if (splash == null) return true;
    const components = plan.resolution.sharedDamage?.components ?? [];
    const splashIds = components.filter(component => component.category === "splash").map(component => component.id);
    const rows = { criticalSuccess: 2, success: 1, failure: 0, criticalFailure: 0 };
    return splash.radius === 5 && Object.keys(splash).length === 2
        && JSON.stringify(splash.componentIds) === JSON.stringify(splashIds) && splashIds.length > 0
        && JSON.stringify(plan.compilerEvidence?.splashDamage?.componentIds ?? null) === JSON.stringify(splashIds)
        && plan.resolution.check?.statistic === "spell-attack" && plan.resolution.sharedDamage?.mode === "pf2e-item-damage"
        && !plan.compilerEvidence?.componentSelectiveDamage && !plan.resolution.check?.sharedMultipleAttackPenalty
        && /^(?:1|one) creature$/i.test(String(plan.targeting?.target ?? "").trim())
        && components.every(component => component.category == null || component.category === "splash")
        && Object.entries(rows).every(([degree, multiplier]) => {
            const damage = plan.resolution.outcomes?.[degree]?.damage;
            const shared = damage?.mode === "mixed" ? damage.shared : damage;
            return multiplier === 0 ? damage?.mode === "none"
                : ["shared", "mixed"].includes(damage?.mode) && shared?.multiplier === multiplier
                    && JSON.stringify(shared.sourceComponentIds) === JSON.stringify(components.map(component => component.id));
        });
}

/** Heal-or-harm targets that are healed rather than harmed. */
export function healingTargets(state) {
    return (state?.targets ?? []).filter(target => target?.mode === "healing" && target.excluded !== true && target.eligible !== false);
}

/**
 * Heal-or-harm mode for a creature: void energy heals undead (and void-healing creatures) and harms the
 * living; vitality energy the reverse. Anything else (a construct, an object) is unaffected.
 */
export function dualEnergyMode(dualMode, actor) {
    if (!actorIsCreature(actor)) return "unaffected";
    const traits = actorTraits(actor);
    const voidHealing = traits.has("undead") || actor?.system?.attributes?.hp?.negativeHealing === true || actor?.hitPoints?.negativeHealing === true;
    const living = !voidHealing && !traits.has("construct");
    if (dualMode?.energy === "void") return voidHealing ? "healing" : living ? "damage" : "unaffected";
    if (dualMode?.energy === "vitality") return living ? "healing" : voidHealing ? "damage" : "unaffected";
    return "damage";
}

export function synchronizeSecondary(state, target) {
    const followUp = (outcomeForTarget(state, target)?.followUps ?? [])[0] ?? null;
    if (!followUp) return target.secondary = null;
    // (Only when the GM says so: "If the creature would be pushed into another creature or object, it must attempt a Reflex save".)
    if (followUp.gate?.kind === "gm-question" && gateAnswerFor(target, followUp.gate) !== "yes") return target.secondary = null;
    // (Only creatures up to the stated level attempt it.)
    if (followUp.maxLevel != null && Number(target.level) > followUp.maxLevel) return target.secondary = null;
    if (target.secondary?.followUpId === followUp.id) return target.secondary;
    return target.secondary = {
        followUpId: followUp.id, degree: null, rollRevision: 0, reroll: false,
        saveTotal: null, saveNatural: null, saveModifier: null,
        lastSubmissionId: null, reviewRequired: false
    };
}

/** A target's row notes: a note chosen by the cast's roll applies only when that result was rolled. */
export function targetOutcomeNotes(state, target) {
    // (With a second save's row notes: Phantasmal Calamity's belief.)
    // (A note for a target with a trait only — Silver Spear's tether on a fiend —: the traits the card recorded for the creature.)
    return [...(outcomeForTarget(state, target)?.noteEffects ?? []), ...(secondaryOutcomeForTarget(state, target)?.noteEffects ?? [])]
        .filter(note => !note.targetTrait || (target?.traits ?? []).includes(note.targetTrait)).filter(note => !note.choiceGroup
        || (note.choiceGroup === "condition-roll" && state.conditionRoll?.slug != null && note.choice === state.conditionRoll.slug)
        // A form's note: only the form the caster picked.
        || (note.choiceGroup === "caster-option" && state.casterChoice?.kind === "option" && note.option === state.casterChoice.selected)
        // (The second pick, on its rows.)
        || (note.choiceGroup === "caster-option" && state.casterChoice?.also != null && (state.casterChoice.twoOn ?? []).includes(target?.degree) && note.option === state.casterChoice.also));
}

/** Outcome indices are scoped to the current branch, never reused after a reroll. */
export function targetOutcomeConditions(state, target) {
    const entries = [
        ...(outcomeForTarget(state, target)?.effects ?? []),
        ...(secondaryOutcomeForTarget(state, target)?.effects ?? [])
    // A condition chosen by the cast's roll: only the rolled (or chosen) one applies.
    ].filter(effect => !effect.choiceGroup
        || (effect.choiceGroup === "condition-roll" && state.conditionRoll?.slug != null && effect.slug === state.conditionRoll.slug)
        // (A critical failure's second rolled condition.)
        || (effect.choiceGroup === "condition-roll" && target?.degree === "criticalFailure" && state.conditionRoll?.second?.slug != null && effect.slug === state.conditionRoll.second.slug)
        // (Unfathomable Song: the roll's result for this target's degree — a critical failure's one higher.)
        || (effect.choiceGroup === "condition-roll-results" && Number.isInteger(state.conditionRoll?.rolled)
            && (effect.rollResults ?? []).includes(state.conditionRoll.rolled + (target?.degree === "criticalFailure" ? Number(state.conditionRoll.criticalOffset ?? 0) : 0)))
        // Only when the caster's damage-dice question was answered yes ("if the target can cast divine spells, it's Stupefied 1").
        || (effect.choiceGroup === "dice-upgrade-yes" && state.diceUpgrade?.answer === "yes")
        // The caster's pick between the row's two conditions.
        || (effect.choiceGroup === "caster-condition" && state.casterChoice?.kind === "condition" && effect.slug === state.casterChoice.selected)
        // The critical failure's extra for the option the caster picked.
        || (effect.choiceGroup === "caster-option" && state.casterChoice?.kind === "option" && effect.option === state.casterChoice.selected)
        // Chosen for this target by its highest attribute modifier (or its choice on a tie).
        || (effect.choiceGroup === "attribute" && target?.attributeCondition?.slug != null && effect.slug === target.attributeCondition.slug)
        // Only when enough targets got the stated results ("If more than one of the targets failed …").
        || (effect.choiceGroup === "group-gate" && (state.targets ?? []).filter(other => targetParticipates(other) && effect.groupGate?.degrees?.includes(other.degree)).length >= Number(effect.groupGate?.minimum ?? Infinity)));
    return entries.map((effect, index) => ({ ...effect, ...(target.conditionOverrides?.[index]?.changes ?? {}) }));
}

function validateConditionCorrection(effect, changes) {
    if (!effect || effect.kind !== "condition") throw new Error("This outcome has no adjustable condition.");
    if (Object.keys(changes).some(key => !["value", "duration"].includes(key))) throw new Error("Unsupported condition adjustment.");
    if ("value" in changes && isTimedStunned(effect)) throw new Error("Timed Stunned has a duration, not a value.");
    if ("value" in changes && (!VALUED_CONDITIONS.has(effect.slug)
        || !Number.isInteger(changes.value) || changes.value < 1)) {
        throw new Error("Condition value must be a positive integer for a valued condition.");
    }
    if ("duration" in changes) {
        const d = changes.duration;
        if (!d || !(d.mode === "unlimited" || (d.mode === "fixed"
            && Number.isFinite(d.value) && d.value > 0
            && ["rounds", "minutes", "hours", "days"].includes(d.unit)
            && [null, undefined, "turn-start", "turn-end"].includes(d.expiry)
            && [undefined, "target-turn", "effect-start"].includes(d.anchor)))) {
            throw new Error("Choose a supported positive duration or unlimited.");
        }
    }
    if (!isExecutableOutcomeCondition({ ...effect, ...changes })) throw new Error("That adjustment requires unsupported mechanics.");
}

export function correctSaveTarget(state, targetId, correction, userId) {
    const target = state.targets?.find(candidate => candidate.id === targetId);
    if (!target) throw new Error("The correction target is unavailable.");
    if (state.status !== "collecting" || state.reviewRequired || target.reviewRequired
        || !["pending", "unaffected"].includes(target.applicationStatus)) {
        throw new Error("Corrections are locked after finalization begins or while review is required.");
    }
    if (correction.expectedRevision != null
        && Number(correction.expectedRevision) !== Number(target.revision ?? 0)) {
        throw new Error("This target changed. Review the refreshed card before correcting it.");
    }
    switch (correction.action) {
        case "exclude": target.excluded = true; break;
        case "restore": target.excluded = false; break;
        case "unaffected":
        case "affected": {
            if (target.confirmation) target.confirmation = { ...target.confirmation, status: correction.action === "affected" ? "affected" : "immune", userId };
            target.originalEligibility ??= { eligible: target.eligible !== false, reason: target.eligibilityReason ?? null };
            target.eligibilityOverride = { eligible: correction.action === "affected", userId };
            target.eligible = target.eligibilityOverride.eligible;
            target.eligibilityReason = target.eligible ? null : "GM marked Unaffected for this cast";
            target.applicationStatus = target.eligible ? "pending" : "unaffected";
            break;
        }
        case "condition": {
            if (!targetParticipates(target) || !target.degree || (target.secondary && !target.secondary.degree)) {
                throw new Error("Complete the target's saves before adjusting conditions.");
            }
            const index = correction.conditionIndex;
            if (!Number.isInteger(index) || index < 0) throw new Error("Invalid condition selection.");
            const original = [
                ...(outcomeForTarget(state, target)?.effects ?? []),
                ...(secondaryOutcomeForTarget(state, target)?.effects ?? [])
            ][index];
            const changes = correction.changes ?? {};
            validateConditionCorrection(original, changes);
            target.conditionOverrides ??= {};
            if (Object.keys(changes).length === 0) delete target.conditionOverrides[index];
            else target.conditionOverrides[index] = { original: structuredClone(original), changes: structuredClone(changes), userId };
            break;
        }
        case "attribute-condition": {
            // The condition a tied creature takes ("On a tie, the creature decides …").
            const pending = target.attributeCondition;
            if (!pending || pending.status !== "pending" || !pending.options.includes(correction.degree)) throw new Error("This target has no tied attribute choice with that answer.");
            target.attributeCondition = { ...pending, status: "chosen", slug: correction.degree, userId };
            break;
        }
        case "gate-yes":
        case "gate-no": {
            // The GM's answer for a gated condition in the target's row ("Is it already exposed to bright light?").
            if (!target.degree || !gmQuestionGate(state, target)) throw new Error("This target's row has no question to answer.");
            // (A keyed question — Chrysopoetic Curse's armor and held objects — is answered on its own.)
            const gateKey = typeof correction.degree === "string" && correction.degree && gmQuestionGates(state, target).some(gate => gate.key === correction.degree) ? correction.degree : null;
            if (gateKey) target.gateAnswers = { ...(target.gateAnswers ?? {}), [gateKey]: { answer: correction.action === "gate-yes" ? "yes" : "no", userId } };
            else target.gateAnswer = { answer: correction.action === "gate-yes" ? "yes" : "no", userId };
            // (A second save the answer opens — Unhelpful Nudge's collision.)
            synchronizeSecondary(state, target);
            break;
        }
        case "upgrade-yes":
        case "upgrade-no": {
            // The caster's answer for one target ("chant those victims' names"): its damage is the larger roll.
            if (!state.targetUpgrade) throw new Error("This cast has no question for each target.");
            if (state.damage?.rollJSON) throw new Error(`${state.spellName}: the damage was already rolled.`);
            target.upgradeAnswer = { answer: correction.action === "upgrade-yes" ? "yes" : "no", userId };
            break;
        }
        case "attack-adjustment": {
            // The GM's answer to a target-dependent attack question ("wearing metal armor or made of metal?").
            const choice = (state.attackAdjustment?.choices ?? []).find(candidate => String(candidate.value) === String(correction.degree));
            if (!choice || !target.attackAdjustment) throw new Error("This target has no attack question with that answer.");
            if (target.degree) throw new Error("The attack was already rolled; answer the question before rolling it.");
            target.attackAdjustment = { status: "answered", value: choice.value, label: choice.label, userId };
            break;
        }
        case "zone": {
            // The square the GM places the creature in (Redistribute Potential): the second square's rows and damage type.
            if (!target.zone || !(state.traitVariant?.values ?? []).includes(correction.degree)) throw new Error("This target has no square to choose.");
            target.zone = { status: "chosen", value: correction.degree, userId };
            target.traitVariant = correction.degree === state.traitVariant.trait ? state.traitVariant.trait : null;
            break;
        }
        case "bolstered":
        case "not-bolstered": {
            // "X are bolstered … while all other creatures must attempt a … saving throw.": yes, no save and the spell's bonus Effect.
            if (!target.bolster) throw new Error("This target has no bolster question.");
            if (target.degree) throw new Error("The save was already rolled; answer the question before rolling it.");
            const bolstered = correction.action === "bolstered";
            target.bolster = { status: bolstered ? "bolstered" : "saves", userId };
            target.eligible = !bolstered;
            target.eligibilityReason = bolstered ? "bolstered: gains the spell's bonus instead of saving" : null;
            target.applicationStatus = bolstered ? "unaffected" : "pending";
            break;
        }
        case "adjustment-choice": {
            if (!target.degreeAdjustment?.choices?.some(choice => choice.key === correction.degree)) throw new Error("This target has no such degree adjustment.");
            target.degreeAdjustment = { ...target.degreeAdjustment, status: "applies", choice: correction.degree, userId };
            applyDegreeAdjustment(state, target);
            break;
        }
        case "adjustment-applies":
        case "adjustment-not-applicable": {
            if (!target.degreeAdjustment) throw new Error("This target has no degree adjustment to confirm.");
            target.degreeAdjustment = { ...target.degreeAdjustment, status: correction.action === "adjustment-applies" ? "applies" : "not-applicable", userId };
            applyDegreeAdjustment(state, target);
            break;
        }
        case "degree": {
            const record = correction.stage === "secondary" ? target.secondary : target;
            const degree = normalizeSaveDegree(correction.degree);
            if (!targetParticipates(target) || !record?.degree || !degree) {
                throw new Error("Roll the affected target's save before adjusting its degree.");
            }
            target.conditionOverrides = {};
            record.rolledDegree ??= record.degree;
            record.degree = degree;
            record.degreeOverride = degree === record.rolledDegree ? null
                : { from: record.rolledDegree, to: degree, userId };
            if (correction.stage !== "secondary") synchronizeSecondary(state, target);
            break;
        }
        default: throw new Error("Unknown GM correction.");
    }
    target.revision = Number(target.revision ?? 0) + 1;
    target.lastCorrection = { action: correction.action, userId };
    return target;
}

export function secondarySaveForTarget(state, target) {
    const followUpId = target?.secondary?.followUpId;
    return followUpId
        ? (outcomeForTarget(state, target)?.followUps ?? []).find(followUp => followUp.id === followUpId) ?? null
        : null;
}

export function secondaryOutcomeForTarget(state, target) {
    return secondarySaveForTarget(state, target)?.outcomes?.[target?.secondary?.degree] ?? null;
}

export function damageMultiplierForTarget(state, target) {
    // (A spellshape's second target — Split Shot: "half the amount of damage it would normally deal".)
    return baseDamageMultiplier(state, target) * (target?.shapeHalf ? 0.5 : 1);
}

function baseDamageMultiplier(state, target) {
    // Bony Barrage's bone armor: the caster and its allies in the area take no damage from the spell.
    if (target?.boneArmor === true) return 0;
    // (Damage only for creatures of the named traits: Life's Flowing River.)
    if (state?.damageTraits && target?.traitDamage === false) return 0;
    const damage = outcomeForTarget(state, target)?.damage;
    const secondaryDamage = secondaryOutcomeForTarget(state, target)?.damage;
    if (secondaryDamage?.mode === "primary-shared") return Number(secondaryDamage.multiplier ?? 0);
    if (state.outcomes) {
        return damage?.mode === "mixed"
            ? Number(damage.shared?.multiplier ?? 0)
            : damage?.mode === "shared" ? Number(damage.multiplier ?? 0) : 0;
    }
    return basicSaveMultiplier(target?.degree);
}

export function outcomeDamageRollIds(state, target) {
    return [
        ...(outcomeForTarget(state, target)?.damage?.formulas ?? []),
        ...(secondaryOutcomeForTarget(state, target)?.damage?.formulas ?? [])
    ]
        // (A row's damage behind the GM's question only on a yes.)
        .filter(entry => entry.gate?.kind !== "gm-question" || target?.gateAnswer?.answer === "yes")
        .map(entry => entry.rollId)
        .filter(Boolean);
}

export function requiredOutcomeDamageRolls(state) {
    const ids = new Set((state.targets ?? []).filter(targetParticipates)
        .flatMap(target => outcomeDamageRollIds(state, target)));
    return (state.damage?.outcomeRolls ?? []).filter(entry => ids.has(entry.id));
}

export function sharedDamageRequired(state) {
    if (state.damage?.enabled === false) return false;
    if (healingTargets(state).length) return true;
    if (!state.outcomes) return (state.targets ?? []).some(targetParticipates);
    return (state.targets ?? []).filter(targetParticipates).some(target => {
        const secondaryDamage = secondaryOutcomeForTarget(state, target)?.damage;
        if (secondaryDamage?.mode === "primary-shared" && Number(secondaryDamage.multiplier) > 0) return true;
        const damage = outcomeForTarget(state, target)?.damage;
        const shared = sharedDamagePart(damage);
        return Number(shared?.multiplier) > 0;
    });
}

export function recordProvisionalSave(state, targetId, result) {
    const target = state.targets?.find(candidate => candidate.id === targetId);
    if (!target) throw new Error("The saving-throw target is not part of this cast.");
    const degree = normalizeSaveDegree(result.degree);
    if (!degree) throw new Error("The saving throw has no recognized degree of success.");
    if (target.applicationStatus === "applied" || target.applicationStatus === "applying") {
        target.postApplicationDegree = degree;
        target.postApplicationMessageId = result.messageId ?? null;
        target.reviewRequired = true;
        state.reviewRequired = true;
        state.reviewReason = `${target.name} rolled again after result application.`;
        return { status: "manual-review", target };
    }
    if (Number(result.timestamp ?? 0) < Number(target.saveTimestamp ?? 0)) {
        return { status: "stale", target };
    }
    if ((state.status && state.status !== "collecting") || !targetParticipates(target)) return { status: "stale", target };
    target.conditionOverrides = {};
    target.degree = degree;
    target.rolledDegree = degree;
    target.degreeOverride = null;
    target.revision = Number(target.revision ?? 0) + 1;
    applyDegreeAdjustment(state, target);
    target.saveMessageId = result.messageId ?? null;
    target.saveTimestamp = Number(result.timestamp ?? Date.now());
    target.rollRevision = Number(target.rollRevision ?? 0) + 1;
    target.reroll = result.reroll === true || target.rollRevision > 1;
    target.saveTotal = Number.isFinite(Number(result.total)) ? Number(result.total) : null;
    target.saveNatural = Number.isFinite(Number(result.natural)) ? Number(result.natural) : null;
    target.saveModifier = Number.isFinite(Number(result.modifier)) ? Number(result.modifier) : null;
    target.lastSubmissionId = result.submissionId ?? null;
    return { status: "recorded", target };
}

export function recordSecondarySave(state, targetId, result) {
    const target = state.targets?.find(candidate => candidate.id === targetId);
    const secondary = target?.secondary;
    if (!target || !secondary) throw new Error("The target has no pending secondary saving throw.");
    const degree = normalizeSaveDegree(result.degree);
    if (!degree) throw new Error("The secondary saving throw has no recognized degree of success.");
    if (target.applicationStatus === "applied" || target.applicationStatus === "applying") {
        secondary.postApplicationDegree = degree;
        secondary.reviewRequired = true;
        target.reviewRequired = true;
        state.reviewRequired = true;
        state.reviewReason = `${target.name} rolled its secondary save again after result application.`;
        return { status: "manual-review", target, secondary };
    }
    if ((state.status && state.status !== "collecting") || !targetParticipates(target)) return { status: "stale", target, secondary };
    target.conditionOverrides = {};
    secondary.degree = degree;
    secondary.rolledDegree = degree;
    secondary.degreeOverride = null;
    target.revision = Number(target.revision ?? 0) + 1;
    secondary.rollRevision = Number(secondary.rollRevision ?? 0) + 1;
    secondary.reroll = result.reroll === true || secondary.rollRevision > 1;
    secondary.saveTotal = Number.isFinite(Number(result.total)) ? Number(result.total) : null;
    secondary.saveNatural = Number.isFinite(Number(result.natural)) ? Number(result.natural) : null;
    secondary.saveModifier = Number.isFinite(Number(result.modifier)) ? Number(result.modifier) : null;
    secondary.lastSubmissionId = result.submissionId ?? null;
    return { status: "recorded", target, secondary };
}

/** Every distinct GM question gating the target's row (by key; one unkeyed). */
export function gmQuestionGates(state, target) {
    if (!target?.degree) return [];
    const outcome = outcomeForTarget(state, target);
    const gates = [...(outcome?.effects ?? []).map(effect => effect.gate), ...(outcome?.damage?.formulas ?? []).map(entry => entry.gate), ...(outcome?.followUps ?? []).map(followUp => followUp.gate)]
        .filter(gate => gate?.kind === "gm-question");
    return gates.filter((gate, index) => gates.findIndex(other => (other.key ?? "") === (gate.key ?? "")) === index);
}

/** The GM's answer to a gate for this target: its key's, or the row's single answer. */
export function gateAnswerFor(target, gate) {
    return gate?.key ? target?.gateAnswers?.[gate.key]?.answer ?? null : target?.gateAnswer?.answer ?? null;
}

/** The GM question gating a condition in the target's row, or null. */
export function gmQuestionGate(state, target) {
    if (!target?.degree) return null;
    const outcome = outcomeForTarget(state, target);
    // (Or a row whose only gated part is its damage.)
    return (outcome?.effects ?? []).find(effect => effect.gate?.kind === "gm-question")?.gate ?? (outcome?.damage?.formulas ?? []).find(entry => entry.gate?.kind === "gm-question")?.gate
        ?? (outcome?.followUps ?? []).find(followUp => followUp.gate?.kind === "gm-question")?.gate ?? null;
}

export function saveCollectionReadiness(state) {
    if (state.status === "completed") return { ready: false, reason: "Resolution is already complete." };
    if (state.reviewRequired) return { ready: false, reason: state.reviewReason ?? "Manual review is required." };
    const unconfirmedShift = (state.targets ?? []).filter(target => targetParticipates(target) && target.degreeAdjustment?.status === "pending");
    if (unconfirmedShift.length) return { ready: false, reason: `GM must confirm ${unconfirmedShift.length} degree adjustment${unconfirmedShift.length === 1 ? "" : "s"}: ${unconfirmedShift[0].degreeAdjustment.question}` };
    if (state.castChoice && !state.castChoice.selected) return { ready: false, reason: `Choose the ${state.castChoice.label.toLowerCase()} before finalizing.` };
    const undecided = (state.targets ?? []).filter(target => targetParticipates(target) && target.attributeCondition?.status === "pending");
    if (undecided.length) return { ready: false, reason: `${undecided[0].name}: its highest attributes tie; choose which condition it takes.` };
    // (A condition choice is asked only when a target's row has it.)
    // (Or a row's own pick — Accelerated Decomposition's success — only when a target lands on that row.)
    const rowPick = state.casterChoice?.kind === "option" && state.casterChoice.pick === "row-condition";
    // (Necrotize's second part: only when a target critically failed.)
    const partPick = state.casterChoice?.kind === "option" && state.casterChoice.pick === "native-part";
    const choiceNeeded = (state.casterChoice?.kind !== "condition" && !rowPick && !partPick) || (state.targets ?? []).some(target => targetParticipates(target)
        && (partPick ? (outcomeForTarget(state, target)?.nativeEffects ?? []).some(effect => effect.outcomeRule?.pick === "caster")
            : (outcomeForTarget(state, target)?.effects ?? []).some(effect => effect.choiceGroup === (rowPick ? "caster-option" : "caster-condition"))));
    if (state.damageBonus && state.damageBonus.answer == null) return { ready: false, reason: `Caster: ${state.damageBonus.question}` };
    const unnamed = state.targetUpgrade ? (state.targets ?? []).filter(target => targetParticipates(target) && target.degree && damageMultiplierForTarget(state, target) > 0 && !target.upgradeAnswer) : [];
    if (unnamed.length) return { ready: false, reason: `Caster: ${unnamed[0].name}: ${state.targetUpgrade.question}` };
    if (state.persistentRider && !state.persistentRider.answer) return { ready: false, reason: `Caster: ${state.persistentRider.question}` };
    if (state.castGate && state.castGate.answer == null) return { ready: false, reason: `GM: ${state.castGate.question}` };
    if (state.sacrifice?.pick === "minion" && !state.sacrifice.selected) return { ready: false, reason: "Caster: choose the minion the spell destroys." };
    if (state.boneArmor && state.boneArmor.answer == null) return { ready: false, reason: `Caster: ${state.boneArmor.question}` };
    if (state.casterChoice && !state.casterChoice.selected && choiceNeeded) return { ready: false, reason: `Caster: choose the ${state.casterChoice.label.toLowerCase()} before finalizing.` };
    if (state.casterChoice?.twoOn?.length && state.casterChoice.selected && !state.casterChoice.also && (state.targets ?? []).some(target => state.casterChoice.twoOn.includes(target.degree)))
        return { ready: false, reason: `Choose the second ${String(state.casterChoice.label ?? "option").toLowerCase()} (a ${state.casterChoice.twoOn.join(" or ")} gets two).` };
    if (state.conditionRoll && !state.conditionRoll.slug) return { ready: false, reason: `The ${state.conditionRoll.formula} rolled ${state.conditionRoll.rolled ?? "?"}: the caster chooses the condition before finalizing.` };
    if (state.conditionRoll?.second && !state.conditionRoll.second.slug && (state.targets ?? []).some(target => target.degree === "criticalFailure"))
        return { ready: false, reason: `The critical failure's second ${state.conditionRoll.formula} rolled ${state.conditionRoll.second.rolled}: the caster chooses a different condition.` };
    const unzoned = (state.targets ?? []).filter(target => !target.excluded && target.zone?.status === "pending");
    if (unzoned.length) return { ready: false, reason: `GM: ${unzoned[0].name}: ${state.traitVariant?.question ?? "choose its square"}` };
    const unbolstered = (state.targets ?? []).filter(target => !target.excluded && target.bolster?.status === "pending");
    if (unbolstered.length) return { ready: false, reason: `GM: ${unbolstered[0].name}: ${state.bolster?.question ?? "answer the bolster question"}` };
    const unconfirmed = (state.targets ?? []).filter(target => !target.excluded && target.confirmation?.status === "pending");
    if (unconfirmed.length) return { ready: false, reason: `GM must confirm ${unconfirmed.length} target${unconfirmed.length === 1 ? "" : "s"}: ${unconfirmed[0].confirmation.question}` };
    const missing = (state.targets ?? []).filter(target => targetParticipates(target) && !target.degree);
    if (missing.length) return { ready: false, reason: `${missing.length} saving throw${missing.length === 1 ? " is" : "s are"} still required.` };
    // A condition gated on the GM's answer for that creature's row.
    const unanswered = (state.targets ?? []).filter(target => targetParticipates(target) && gmQuestionGates(state, target).some(gate => !gateAnswerFor(target, gate)));
    if (unanswered.length) return { ready: false, reason: `GM: ${unanswered[0].name}: ${gmQuestionGates(state, unanswered[0]).find(gate => !gateAnswerFor(unanswered[0], gate)).question}` };
    const missingSecondary = (state.targets ?? []).filter(target =>
        targetParticipates(target) && target.secondary && !target.secondary.degree);
    if (missingSecondary.length) {
        return {
            ready: false,
            reason: `${missingSecondary.length} secondary saving throw${missingSecondary.length === 1 ? " is" : "s are"} still required.`
        };
    }
    if ((state.targets ?? []).some(target => target.applicationStatus === "applying")) {
        return { ready: false, reason: "An interrupted result application requires manual review." };
    }
    return { ready: true, reason: null };
}

export function basicSaveReadiness(state) {
    const collection = saveCollectionReadiness(state);
    if (!collection.ready) return collection;
    if (sharedDamageRequired(state) && !state.damage?.rollJSON) {
        return { ready: false, reason: "Roll shared damage first." };
    }
    const missingOutcomeRolls = requiredOutcomeDamageRolls(state).filter(entry => !entry.rollJSON);
    if (missingOutcomeRolls.length) {
        return {
            ready: false,
            reason: `Roll ${missingOutcomeRolls.length} required outcome damage formula${missingOutcomeRolls.length === 1 ? "" : "s"} first.`
        };
    }
    return { ready: true, reason: null };
}
