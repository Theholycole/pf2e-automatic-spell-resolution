import { assertSpellNotLost } from "./casting-rules-runtime.js";
import { forcedMove, nearestRegionPoint } from "./forced-movement.js";
import { MODULE_ID } from "./effect-runtime.js";
import { ONGOING_FLAG, turnAdvance, boundaryKey, addObligation, dueWorldTime, petrifyProgress } from "./ongoing-core.js";
import { clone, randomID, escapeHTML, confirmAction, spellAtCastRank, terrainDifficulties, actorOf } from "./runtime-utils.js";
import { ConditionSpellRuntime } from './condition-spell-runtime.js';
import { makeThralls, isThrall, destroyThrall } from './thrall-tokens.js';
import { prepareSickenedRecovery,assertSickenedRecovery,finalizeSickenedRecovery,sickenedControls } from './sickened-recovery.js';
import { assertRecurringSave, finalizeRecurringSave, recurringControls, recurringObligation } from './recurring-save-recovery.js';
import { heightenedPlanAt, isExecutableLingeringPlan, validateActorTarget, lingeringExposurePlan, moveSaveExposurePlan } from './basic-save-core.js';
import { tokenDistance } from './token-distance.js';
import { applyDamageWithReceipt } from './native-damage-receipt.js';
import { isDying, recoverFromDying } from './dying-recovery.js';
import { loadNativeEffectTemplate, prepareNativeEffectSource, createNativeEffect } from './native-outcome-effects.js';
import { violentLightEffectMatches } from '../src/compiler/violent-light.js';
import { blessingMatches } from '../src/compiler/divine-eclipse.js';
import { ensureSpellShield } from './effect-runtime.js';
import { inspectCasterBenefitClaim } from './effect-modifier-proof.js';
import { heightenedComponentFormula } from '../src/compiler/retaliation.js';
import { hasPersistentDamage } from './persistent-link-runtime.js';
import { tentacleAttempt } from './tentacle-grab.js';
import { castSpellFromUuid } from './cast-spell.js';
import { spellAttack } from './attack-shapes-runtime.js';
import { grantMinionControl } from './minion-control-runtime.js';
import { disbeliefPain } from "./disbelief-pain.js";

// The lantern's light: bright in the area, dim to its multiple.
const lanternLightRule = (radius, light) => ({ key: "TokenLight", value: { bright: Number(radius) * light.brightTimes, dim: Number(radius) * light.dimTimes } });
// Which of the lantern's rows a creature takes: living, undead, or none (a construct).
const lanternMode = actor => { if (!actor) return null; const traits = actor.traits ?? new Set(actor.system?.traits?.value ?? []);
    if (traits.has?.("undead")) return "undead"; const mode = actor.modeOfBeing ?? (traits.has?.("construct") ? "construct" : "living"); return mode === "living" ? "living" : null; };

// PF2e's Light Blindness ability on a creature (by its compendium source, slug or name).
const hasLightBlindness = (actor, ability) => (actor?.items ?? []).some(item => item._stats?.compendiumSource === ability.uuid || item.flags?.core?.sourceId === ability.uuid
    || item.slug === ability.slug || item.system?.slug === ability.slug || item.name === ability.name);

// A living creature (not undead or a construct).
const livingMode = actor => actor != null && (actor.modeOfBeing ?? (actor.traits?.has?.("undead") ? "undead" : actor.traits?.has?.("construct") ? "construct" : "living")) === "living";
const state = journal => journal.getFlag(MODULE_ID, ONGOING_FLAG);
const SAVE_DEGREES = ["criticalSuccess", "success", "failure", "criticalFailure"];
// (Petrify left this list 2026-10-03: its text compiles to the save card's escalating Slowed, Petrified at the creature's action count — escalating-rows.js.)
const IDS = { "floating-flame": "2ZdHjnpEQJuqOYSG", bless: "XSujb7EsSwKl19Uu" };
// Casts whose caster must Sustain each turn.
const sustainable = record => ["floating-flame", "bless"].includes(record.kind) || (record.kind === "lingering" && (record.declaration?.sustained === true || record.declaration?.optionalSustain === true))
    || (record.kind === "native" && record.sustained === true);
// Casts whose Sustain must be used every turn; a missed Sustain ends them (Bless is optional growth).
const mustSustain = record => record.kind === "floating-flame" || (record.kind === "lingering" && record.declaration?.sustained === true)
    || (record.kind === "native" && record.sustained === true && record.growth?.optional !== true);

/** Baseline-specific adapters: changed official text never silently inherits these mechanics. */
/** Whether circular areas overlap (other shapes are the GM's to place apart). */
// Voracious Gestalt's turn damage: its dice from the cast rank ("(@item.level-3)d6" is 6d6 at 9th), plus a die for each soul added.
function turnDamagePlan(exposurePlan, turnDamage, rank, extra) {
    const copy = clone(exposurePlan), damage = copy.resolution?.sharedDamage;
    if (!damage?.components?.length) return copy;
    const dice = Math.max(1, Number(rank) + turnDamage.offset + Number(extra)), formula = `${dice}d${turnDamage.faces}[${turnDamage.type}]`;
    copy.resolution.sharedDamage = { mode: "formula", rollOnce: true, textDerived: true, formula, components: [{ ...damage.components[0], formula: `${dice}d${turnDamage.faces}` }] };
    return copy;
}

function overlappingAreas(regions) {
    const circles = regions.map(region => region.shapes ?? []).map(shapes => shapes.length === 1 && ["circle", "emanation"].includes(shapes[0].type)
        ? { x: shapes[0].x, y: shapes[0].y, r: shapes[0].radius } : null);
    if (circles.some(circle => !circle || ![circle.x, circle.y, circle.r].every(Number.isFinite))) return false;
    return circles.some((a, i) => circles.slice(i + 1).some(b => Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r));
}

export class OngoingFamilies {
    #starts = new Set();
    constructor(ongoing, saves, effects) { this.ongoing = ongoing; this.saves = saves; this.effects = effects; this.conditions = new ConditionSpellRuntime(ongoing, saves); }
    supports(item) { return this.conditions.supports(item) || Object.hasOwn(IDS, item?.slug ?? item?.system?.slug); }
    async verify(item) {
        const slug = item.slug ?? item.system.slug;
        const original = await fromUuid(`Compendium.pf2e.spells-srd.Item.${IDS[slug]}`);
        const plain = text => String(text).replace(/<hr\s*\/?\s*>/gi, "<hr>").replace(/@UUID\[[^\]]+\]/g, "@UUID").replace(/\s+/g, " ").trim();
        if (!original || plain(item.system.description.value) !== plain(original.system.description.value)) throw Error("This spell's mechanics differ from the verified ongoing profile. GM review is required.");
        for (const field of ["damage", "defense", "duration", "heightening", "traits", "range", "area", "target"]) {
            if (JSON.stringify(item.system[field]) !== JSON.stringify(original.system[field])) throw Error(`This spell's ${field} differs from the verified ongoing profile. GM review is required.`);
        }
        return slug;
    }
    plan(item, kind, recurring = false) {
        const basic = kind === "floating-flame" || kind === "aura";
        const components = Object.entries(item.system.damage ?? {}).map(([id, value]) => ({ id, ...clone(value) }));
        if (basic && !components.length) throw Error("This save-bearing area needs native spell damage data.");
        return { compilerVersion: "ongoing-1", source: { name: item.name, uuid: item.uuid }, rank: item.baseRank ?? item.system.level.value,
            automation: { level: basic ? "automatic" : "guided", pendingCapabilities: [], delegatedCapabilities: [] },
            targeting: { actorConstraints: { supportsActorTargets: true, complete: true, predicates: [] } },
            lifecycle: { durationSpec: { mode: "instantaneous" }, controller: { required: false } },
            resolution: { kind: "save", check: { basic, purpose: kind === "petrify" && recurring ? "condition-recovery" : "spell-outcome", statistic: basic ? item.system.defense.save.statistic : "fortitude", traits: recurring ? ["incapacitation"] : [] },
                sharedDamage: basic ? { mode: "pf2e-item-damage", rollOnce: true, components } : null,
                outcomes: Object.fromEntries(SAVE_DEGREES.map(degree => { const multiplier = basic ? { criticalSuccess: 0, success: .5, failure: 1, criticalFailure: 2 }[degree] : 0;
                    return [degree, { damage: { mode: multiplier ? "shared" : "none", multiplier, sourceComponentIds: components.map(c => c.id) }, effects: [], nativeEffects: [], followUps: [], terminal: null, semanticCoverage: { fullyCompiled: true } }]; })) } };
    }
    async start(item, options = {}) {
        const key = options.sourceMessageId;
        if (key && this.#starts.has(key)) throw Error("This ongoing cast is already being prepared.");
        if (key) this.#starts.add(key);
        try { return await this.#start(item, options); } finally { if (key) this.#starts.delete(key); }
    }
    async #start(item, options = {}) {
        if (!this.ongoing.isCoordinator()) return this.ongoing.request("start-family", { itemUuid: item.uuid, castRank: options.castRank,
            sourceMessageId: options.sourceMessageId, targetUuids: [...(options.targets ?? game.user.targets)].map(t => (t.document ?? t).uuid) });
        if (this.conditions.supports(item)) return this.conditions.start(item, options);
        const kind = await this.verify(item);
        const prior = options.sourceMessageId && game.messages.get(options.sourceMessageId)?.getFlag(MODULE_ID, "ongoingCastId");
        if (prior) throw Error("This source card already has an ongoing cast.");
        const targets = [...(options.targets ?? game.user.targets)].map(t => t.document ?? t);
        if (kind === "petrify" && targets.length !== 1) throw Error("Target one creature made of organic material for Petrify.");
        const rank = Number(options.castRank ?? item.rank);
        if (!Number.isInteger(rank) || rank < item.system.level.value || rank > 10) throw Error("Choose a legal cast rank.");
        let actionBudget = 3;
        if (kind === "petrify") {
            const answer = options.verifiedTarget ? options.actionBudget ?? 3 : await foundry.applications.api.DialogV2.prompt({
                window: { title: "Petrify — confirm target" },
                content: `<p>Confirm ${escapeHTML(actorOf(targets[0]).name)} is made of organic material. How many actions can this creature gain before this spell's slowed condition? Account for quickened or unusual action rules; do not include unrelated slowed conditions.</p><input name="actions" type="number" min="1" step="1" value="3">`,
                ok: { label: "Confirm organic target", callback: (_e, b) => Number(b.form.elements.actions.value) }, rejectClose: false, modal: true });
            if (answer == null) return { status: "cancelled" };
            if (!Number.isInteger(answer) || answer < 1) throw Error("An action budget must be confirmed.");
            actionBudget = answer;
        }
        const record = { castId: randomID(), name: item.name, kind, sourceActorUuid: item.actor.uuid, sourceItemUuid: item.uuid,
            sourceMessageId: options.sourceMessageId ?? null, rank, recipientUuids: targets.map(t => actorOf(t).uuid),
            recipients: targets.map(t => ({ actorUuid: actorOf(t).uuid, tokenUuid: t.documentName === "Token" ? t.uuid : null, value: 0, actionBudget, status: "initial" })),
            exposure: [], sustainedRound: null, castRound: this.ongoing.clock().round };
        const journal = await this.ongoing.begin(record);
        if (options.sourceMessageId) await game.messages.get(options.sourceMessageId).setFlag(MODULE_ID, "ongoingCastId", record.castId);
        try {
            if (kind === "bless") {
                const template = await fromUuid("Compendium.pf2e.spell-effects.Item.Gqy7K6FnbLtwGpud");
                const source = template.toObject(); delete source._id;
                source.system.level.value = rank;
                // (An item's own growth, Shining Wayfinder's 5 feet a step — castFromItem's growth, on its cast's message: its aura still 15 feet at
                // the start, each step the item's feet instead of 10. 2026-10-29.)
                const growth = Number(options.sourceMessageId ? game.messages.get(options.sourceMessageId)?.getFlag(MODULE_ID, "castFromItem")?.growth?.feet : NaN);
                if (growth > 0) for (const rule of source.system.rules ?? []) if (rule.key === "Aura" && /badge/.test(String(rule.radius))) rule.radius = `${15 - growth} + @item.badge.value * ${growth}`;
                source.flags ??= {}; source.flags[MODULE_ID] = { runtime: { castInstanceId: record.castId, sourceActorUuid: item.actor.uuid, sourceItemName: item.name } };
                const [effect] = await item.actor.createEmbeddedDocuments("Item", [source]);
                await this.ongoing.attach(journal, effect);
            }
            if (kind === "floating-flame") {
                const region = options.region ?? await item.placeTemplate(game.messages.get(options.sourceMessageId));
                if (!region) { const cancelled = clone(state(journal)); cancelled.status = "ended"; cancelled.endReason = "placement-cancelled"; await this.ongoing.save(journal, cancelled); return { status: "cancelled" }; }
                const data = clone(state(journal));
                data.regionUuid = region.uuid; data.position = clone(region.shapes);
                data.entries.push({ uuid: region.uuid, actorUuid: item.actor.uuid, status: "active", permanent: false });
                data.sustainDueAt = game.time.worldTime + 12;
                data.maximumAt = game.time.worldTime + 60;
                await this.ongoing.save(journal, data);
                if (!options.verifiedTargets && !await confirmAction({ title: "Floating Flame — targets", content: "<p>Confirm the flame is within 30 feet and your current targets are exactly the creatures in its initial square. No resources are refunded if you cancel.</p>", label: "Confirm targets" })) {
                    await this.ongoing.activate(journal); await this.ongoing.review(journal, "Initial placement/targets await GM review."); return { status: "review" };
                }
            }
            if (kind !== "bless" && targets.length) await this.prepareSave(journal, targets, "initial");
            await this.ongoing.activate(journal);
            return { status: "prepared", castId: record.castId, journal };
        } catch (error) { await this.ongoing.review(journal, `Initial ongoing setup interrupted: ${error.message}`); throw error; }
    }
    /** A compiled lingering damage area (placed burst, or an emanation around the caster). */
    supportsLingering(plan) { return isExecutableLingeringPlan(plan); }
    /** "… and the spell ends" after the GM's control (Incendiary Fog's ignition): once every exposure it made is resolved, the cast ends. */
    async endAfterGmAction(journal) {
        const record = state(journal);
        if (record?.kind !== "lingering" || record.status !== "active" || record.declaration?.gmAction?.endsSpell !== true) return false;
        const made = record.obligations.filter(o => o.event === "gm-action" || String(o.key ?? "").startsWith("lingering:gm-action:"));
        if (!made.length || made.some(o => !["completed", "skipped"].includes(o.status))) return false;
        await this.ongoing.end(journal, { reason: "gm-action-ends-spell" });
        return true;
    }
    /** A placed area's region (one circle) grows by this many feet; the declaration's radius with it. */
    /** The caster's thrall tokens (the module's) inside the cast's area. */
    async casterThrallsIn(record) {
        const region = record.regionUuid ? await fromUuid(record.regionUuid) : null;
        if (!region) return [];
        return region.parent.tokens.filter(token => isThrall(token.actor) && token.actor.flags[MODULE_ID].thrall.casterUuid === record.sourceActorUuid && token.object
            && region.testPoint?.({ x: token.object.center.x, y: token.object.center.y, elevation: token.elevation ?? 0 }));
    }

    async growRegion(record, feet) {
        const pixels = Number(feet) * canvas.grid.size / canvas.grid.distance;
        // (An emanation measured from the caster has no region of its own: its radius is the record's.)
        const regions = record.regionUuids ?? (record.regionUuid ? [record.regionUuid] : []);
        if (!regions.length && record.declaration?.centre !== "caster") throw Error("The area's region is missing.");
        for (const uuid of regions) {
            const region = await fromUuid(uuid);
            if (!region) throw Error("The area's region is missing.");
            if (region.shapes.length !== 1 || !["circle", "emanation"].includes(region.shapes[0].type)) throw Error("Grow the area's region yourself: it isn't one circle.");
            await region.update({ shapes: [{ ...region.shapes[0].toObject?.() ?? region.shapes[0], radius: Number(region.shapes[0].radius) + pixels }],
                // (A region following a token keeps its new radius when the token moves.)
                ...(region.flags?.[MODULE_ID]?.followRadius ? { [`flags.${MODULE_ID}.followRadius`]: Number(region.flags[MODULE_ID].followRadius) + pixels } : {}) });
        }
        record.declaration.area.value = Number(record.declaration.area.value) + Number(feet);
    }
    async startLingering(item, plan, options = {}) {
        // (A spell lost to a disruption or a counterspell has no effect: casting-rules-runtime.js.)
        assertSpellNotLost(options?.sourceMessageId ?? null);
        this.ongoing.assertCoordinator();
        if (!game.user.isGM) throw Error("The GM places and runs lingering damage areas.");
        if (!isExecutableLingeringPlan(plan)) throw Error(`${item.name} is not an executable lingering damage area.`);
        const prior = options.sourceMessageId && game.messages.get(options.sourceMessageId)?.getFlag(MODULE_ID, "ongoingCastId");
        if (prior) throw Error("This source card already has an ongoing cast.");
        const rank = Number(options.castRank ?? item.rank);
        // The caster's choice (a damage type) is made once, when the area starts; every exposure's Effect uses it.
        const casterChoice = plan.resolution.casterChoice;
        let chosen = null;
        if (casterChoice) {
            chosen = options.casterChoice ?? await foundry.applications.api.DialogV2.prompt({ window: { title: `${item.name} — ${casterChoice.label.toLowerCase()}` },
                content: `<p>Choose the ${casterChoice.label.toLowerCase()} for this cast.</p><select name="choice">${casterChoice.values.map(value => `<option value="${value}">${value}</option>`).join("")}</select>`,
                ok: { label: "Choose", callback: (_event, button) => button.form.elements.choice.value }, rejectClose: false });
            if (!chosen) return { status: "cancelled" };
            if (!casterChoice.values.includes(chosen)) throw Error(`${item.name}: choose one of ${casterChoice.values.join(", ")}.`);
        }
        const declaration = clone(plan.resolution.lingering);
        // "No matter the result, it's then temporarily immune for 24 hours.": a creature holding this spell's immunity isn't exposed again.
        if (plan.resolution.temporaryImmunity?.key) declaration.immunityKey = plan.resolution.temporaryImmunity.byCaster ? `${plan.resolution.temporaryImmunity.key}:${item.actor?.uuid}` : plan.resolution.temporaryImmunity.key;
        // (Visions of Danger: a creature that disbelieved holds this key and isn't exposed again.)
        if (declaration.disbelief?.key) declaration.immunityKey = declaration.disbelief.key;
        // "When you Cast this Spell, choose one condition from among …" (one more each heightened step): chosen when the area starts.
        if (declaration.gmTrigger) {
            const trigger = declaration.gmTrigger;
            const count = trigger.count + (trigger.step ? Math.max(0, Math.floor((rank - trigger.baseRank) / trigger.step.interval)) * trigger.step.add : 0);
            const picked = options.chosenConditions ?? await foundry.applications.api.DialogV2.prompt({ window: { title: `${item.name} — chosen conditions` },
                content: `<p>Choose ${count} condition${count === 1 ? "" : "s"}.</p>${trigger.choices.map(choice => `<label><input type="checkbox" name="${choice}"> ${choice}</label>`).join("<br>")}`,
                ok: { label: "Choose", callback: (_event, button) => trigger.choices.filter(choice => button.form.elements[choice]?.checked) }, rejectClose: false });
            if (!picked) return { status: "cancelled" };
            const unique = [...new Set(picked)];
            if (unique.length !== Math.min(count, trigger.choices.length) || unique.some(choice => !trigger.choices.includes(choice)))
                throw Error(`${item.name}: choose ${Math.min(count, trigger.choices.length)} of ${trigger.choices.join(", ")}.`);
            declaration.gmTrigger = { ...trigger, chosen: unique };
            declaration.notes = [...(declaration.notes ?? []), `Chosen conditions: ${unique.join(", ")}. When a creature in the area inflicts one, target it and use the spell's control in Ongoing spells (once a round per creature).`];
        }
        // The spell at the cast rank (PF2e's heightened variant: "Heightened (3rd) … the area increases to a 20-foot burst").
        const variant = spellAtCastRank(item, rank);
        const variantArea = variant.system?.area;
        if (declaration.area && variantArea?.type === declaration.area.type && Number(variantArea.value) > 0) declaration.area = { ...declaration.area, value: Number(variantArea.value) };
        // ("Heightened (+2) Increase the area of the spell … by 5 feet": the text's step at the cast rank, which PF2e's item doesn't heighten.)
        if (declaration.areaStep && declaration.area) declaration.area = { ...declaration.area, value: Number(declaration.area.value)
            + Math.max(0, Math.floor((Number(rank) - declaration.areaStep.baseRank) / declaration.areaStep.interval)) * declaration.areaStep.feet };
        // "For each additional action you use when Casting the Spell, increase the burst's radius by 5 feet.": the actions spent (asked when the
        // cast didn't say).
        if (declaration.actionStep && declaration.area) {
            let actions = Number(options.actions ?? 0);
            if (![1, 2, 3].includes(actions)) actions = Number(await foundry.applications.api.DialogV2.prompt({ window: { title: `${item.name} — actions` },
                content: `<select name="actions">${[1, 2, 3].map(count => `<option value="${count}">${count} action${count === 1 ? "" : "s"}: ${Number(declaration.area.value) + (count - 1) * declaration.actionStep.feet}-foot ${declaration.area.type}</option>`).join("")}</select>`,
                ok: { label: "Cast", callback: (_event, button) => button.form.elements.actions.value }, rejectClose: false }) ?? 0);
            if (![1, 2, 3].includes(actions)) return { status: "cancelled" };
            declaration.area = { ...declaration.area, value: Number(declaration.area.value) + (actions - 1) * declaration.actionStep.feet };
            declaration.actions = actions;
        }
        // "If you cast this spell again, any previous … you've cast ends."
        if (declaration.recastEnds) for (const previous of this.ongoing.records().filter(journal => { const entry = state(journal);
            return entry.kind === "lingering" && entry.status === "active" && entry.sourceActorUuid === item.actor.uuid && entry.name === item.name; }))
            await this.ongoing.end(previous, { reason: "recast" });
        let region = null, regions = [];
        // ("Heightened (+2) Create an additional 10-foot burst.": the count at the cast rank.)
        if (declaration.areaCountStep && declaration.areaCount > 1)
            declaration.areaCount = Math.min(5, declaration.areaCount + Math.max(0, Math.floor((rank - declaration.areaCountStep.baseRank) / declaration.areaCountStep.interval)) * declaration.areaCountStep.add);
        if (declaration.centre === "placed" && declaration.areaCount > 1) {
            // Several separate areas ("three 5-foot bursts that don't overlap"): each placed in turn (the plan's shape when PF2e's item has none).
            const placer = variant.system?.area ? variant : variant.clone({ "system.area": { type: declaration.area.type, value: declaration.area.value } });
            if (options.regions) regions = [...options.regions];
            else for (let index = 0; index < declaration.areaCount; index++) {
                const placed = await placer.placeTemplate(game.messages.get(options.sourceMessageId));
                if (!placed) { for (const earlier of regions) await earlier.delete().catch(() => {}); return { status: "cancelled" }; }
                regions.push(placed);
            }
            const problem = regions.length !== declaration.areaCount ? `${item.name} needs ${declaration.areaCount} areas.` : overlappingAreas(regions) ? `${item.name}'s areas can't overlap.` : null;
            if (problem) { if (!options.regions) for (const placed of regions) await placed.delete().catch(() => {}); throw Error(problem); }
            region = regions[0];
        } else if (declaration.centre === "placed") {
            // (A target object's area — Metal Reverberation's space and adjacent spaces — is the plan's, not the item's.)
            const placing = variant.system?.area && !declaration.areaStep ? variant : variant.clone({ "system.area": { type: declaration.area.type, value: declaration.area.value } });
            // (A shape the GM draws — Bridge of Vines' 10-foot-wide bridge — selected as a region.)
            if (declaration.drawnArea && !options.region && !canvas.regions?.controlled?.[0]) throw Error(`${item.name}: draw ${declaration.drawnArea} as a region and select it first.`);
            // (The caster's emanation as a region that follows its token: Unbreaking Wave Barrier.)
            const casterToken = declaration.areaOnCaster ? item.actor.getActiveTokens?.(true, true)?.[0] ?? null : null;
            if (declaration.areaOnCaster && !casterToken) throw Error(`${item.name}: ${item.actor.name} needs a token on the scene.`);
            if (casterToken) {
                const size = canvas.scene.grid.size, pixels = (Number(declaration.area.value) / canvas.scene.grid.distance + casterToken.width / 2) * size;
                const centre = { x: casterToken.x + casterToken.width * size / 2, y: casterToken.y + casterToken.height * size / 2 };
                [region] = await canvas.scene.createEmbeddedDocuments("Region", [{ name: `${item.name}: around ${casterToken.name}`, color: "#3388cc",
                    shapes: [{ type: "circle", x: centre.x, y: centre.y, radius: pixels }], flags: { [MODULE_ID]: { followToken: casterToken.uuid, followShape: "emanation", followRadius: pixels } } }]);
            }
            else region = options.region ?? (declaration.drawnArea ? canvas.regions.controlled[0].document : await placing.placeTemplate(game.messages.get(options.sourceMessageId)));
            if (!region) return { status: "cancelled" };
            regions = [region];
            // (Cast through "1 of your thralls" that it destroys — Zombie Horde: the targeted module thrall token removed.)
            if (/^1 of your thralls$/i.test(String(item.system?.target?.value ?? "").trim())) {
                const thrall = [...(options.targets ?? game.user.targets)].map(target => target?.document ?? target).find(token => token?.actor && isThrall(token.actor));
                if (thrall) await destroyThrall(thrall);
            }
        } else if (declaration.centre === "targets") {
            // The cast's own targets, exposed again on each Sustain.
            let tokens = [...(options.targets ?? game.user.targets)].map(target => target?.document ?? target).filter(token => token?.documentName === "Token" && token.actor);
            // (Or several: Bloody Tendrils' thralls, up to the count at the cast rank.)
            const most = declaration.maxTargets ? declaration.maxTargets.count + (declaration.maxTargets.step ? Math.max(0, Math.floor((rank - declaration.maxTargets.baseRank) / declaration.maxTargets.step.interval)) * declaration.maxTargets.step.add : 0) : 1;
            // (Thralls the spell creates — Bloody Tendrils' tendrils: made as tokens by the thrall rules when none are targeted, for the spell's time.)
            if (!tokens.length && declaration.thrallTokens) {
                const range = Number(/^(\d+) feet$/.exec(String(item.system?.range?.value ?? "").trim())?.[1] ?? 30);
                const made = await makeThralls(item.actor, { count: options.thrallCount ?? most, spell: item.name, itemOrSource: item, ...declaration.thrallTokens, seconds: declaration.durationSeconds ?? 60,
                    positions: options.positions ?? null, feet: range, notes: (declaration.notes ?? []).slice(0, 1) });
                tokens = made.thralls.map(entry => entry.token);
            }
            if (!tokens.length) throw Error(`${item.name}: target the creature before starting the spell.`);
            if (tokens.length > most) throw Error(`${item.name} targets ${most === 1 ? "1 creature" : `up to ${most}`}.`);
            // (A willing ally's aura — Aura of Violent Light: an ally of the caster, not the caster.)
            if (declaration.anchorAlly && tokens.some(token => token.actor === item.actor || !(item.actor.isAllyOf?.(token.actor) ?? token.actor.alliance === item.actor.alliance)))
                throw Error(`${item.name} targets 1 willing ally.`);
            declaration.targetTokenUuids = tokens.map(token => token.uuid);
        } else if ((item.actor.getActiveTokens?.() ?? []).length !== 1) throw Error(`${item.actor.name} needs exactly one token on the scene for the emanation.`);
        // (Divine Eclipse: the creatures the caster blesses — the cast's targets in the area, up to the number.)
        if (declaration.blessed) {
            const casterToken = item.actor.getActiveTokens?.()?.[0]?.document;
            const blessed = [...(options.targets ?? game.user.targets)].map(target => target?.document ?? target).filter(token => token?.documentName === "Token" && token.actor);
            if (blessed.length > declaration.blessed.max) throw Error(`${item.name} blesses up to ${declaration.blessed.max} creatures.`);
            if (blessed.some(token => casterToken && token.id !== casterToken.id && tokenDistance(casterToken, token) > Number(declaration.area.value))) throw Error(`${item.name}: bless creatures in the area.`);
            declaration.blessed.tokenUuids = blessed.map(token => token.uuid);
        }
        // (Fallow Field's saves are rolled by the module when healing is held: the caster's spell DC when the cast didn't give one.)
        if (declaration.healingSave && !Number.isFinite(Number(options.dc))) options = { ...options, dc: variant.spellcasting?.statistic?.dc?.value ?? item.spellcasting?.statistic?.dc?.value ?? null };
        const record = { castId: randomID(), name: item.name, kind: "lingering", sourceActorUuid: item.actor.uuid, sourceItemUuid: item.uuid, rank,
            // (The cast's message: its spellshapes and catalysts ride on the area's initial save.)
            sourceMessageId: options.sourceMessageId ?? null,
            // (The rows at the cast rank: a heightened variant's, Mushroom Patch at 9th.)
            dc: options.dc ?? null, recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: lingeringExposurePlan(heightenedPlanAt(plan, rank)),
            ...(declaration.sustainDamage || declaration.sustainDrops || declaration.sustainBasic ? { sustainExposurePlan: lingeringExposurePlan(heightenedPlanAt(plan, rank), { event: "sustain" }) } : {}),
            ...(declaration.enterDamage ? { enterExposurePlan: lingeringExposurePlan(heightenedPlanAt(plan, rank), { event: "enter" }) } : {}),
            // (Voracious Gestalt: the turns' own damage, its dice from the cast rank.)
            ...(declaration.turnDamage ? { turnExposurePlan: turnDamagePlan(lingeringExposurePlan(heightenedPlanAt(plan, rank), { event: "turn" }), declaration.turnDamage, rank, 0) } : {}),
            // An area ending at the start of the caster's next turn ends on that turn in combat (the round's clock would end it at
            // the round's start); out of combat, after its round.
            regionUuid: region?.uuid ?? null, ...(regions.length > 1 ? { regionUuids: regions.map(placed => placed.uuid) } : {}), maximumAt: declaration.endsAt === "caster-turn-start" && this.ongoing.clock().started ? null : game.time.worldTime + declaration.durationSeconds,
            castRound: this.ongoing.clock().round,
            // "You can Dismiss the spell.": the caster ends the whole cast.
            ...(declaration.dismissible ? { dismissal: { authority: "source-actor", scope: "cast", action: "Dismiss" } } : {}),
            ...(chosen ? { casterChoice: chosen } : {}) };
        const journal = await this.ongoing.begin(record);
        if (options.sourceMessageId) await game.messages.get(options.sourceMessageId).setFlag(MODULE_ID, "ongoingCastId", record.castId);
        const data = clone(state(journal));
        // "… decompressive effects deal 4d6 slashing damage to any creature or object that ends its turn adjacent to the door.": the squares around the
        // area's centre (the door's space) as a second area, a child of this one, dealing the damage at the cast rank as turns end (not to the caster).
        if (declaration.doorHazard && region) {
            const g = canvas.grid.size, bounds = region.object?.bounds ?? null;
            const centre = bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : { x: Number(region.shapes?.[0]?.x ?? 0), y: Number(region.shapes?.[0]?.y ?? 0) };
            const door = { x: Math.floor(centre.x / g) * g, y: Math.floor(centre.y / g) * g };
            const [adjacent] = await canvas.scene.createEmbeddedDocuments("Region", [{ name: `${item.name}: beside the door`, color: "#7744aa",
                shapes: [{ type: "rectangle", x: door.x - g, y: door.y - g, width: 3 * g, height: 3 * g, rotation: 0, hole: false }], visibility: CONST.REGION_VISIBILITY.ALWAYS }]);
            const hazard = declaration.doorHazard;
            const steps = hazard.heightening ? Math.max(0, Math.floor((rank - hazard.baseRank) / hazard.heightening.interval)) : 0;
            const child = await this.startRegionArea({ spellName: `${item.name} (beside the door)`, sourceActorUuid: item.actor.uuid, sourceItemUuid: item.uuid, castRank: rank, region: adjacent,
                durationSeconds: declaration.durationSeconds, events: ["turn-end"], hazardDamage: { formula: `${hazard.dice + steps * (hazard.heightening?.dice ?? 0)}d${hazard.die}`, type: hazard.type, label: hazard.label },
                excludeCaster: true, parentCastId: record.castId });
            data.childCastIds = [...(data.childCastIds ?? []), child.castId];
            data.entries.push({ uuid: adjacent.uuid, actorUuid: item.actor.uuid, status: "active", permanent: false });
        }
        // "There's an additional 5-foot burst in the center of the area …" (Tear the Veil): a child area at the region's centre that drains each living creature
        // starting its turn in it, and gives the death save to one already at the maximum.
        if (declaration.drainCenter && region) {
            const g = canvas.grid.size, bounds = region.object?.bounds ?? null;
            const centre = bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : { x: Number(region.shapes?.[0]?.x ?? 0), y: Number(region.shapes?.[0]?.y ?? 0) };
            const drain = declaration.drainCenter;
            const [burst] = await canvas.scene.createEmbeddedDocuments("Region", [{ name: `${item.name}: the centre`, color: "#331144",
                shapes: [{ type: "circle", x: centre.x, y: centre.y, radius: drain.radius * g / canvas.grid.distance, hole: false }], visibility: CONST.REGION_VISIBILITY.ALWAYS }]);
            const child = await this.startRegionArea({ spellName: `${item.name} (the centre)`, sourceActorUuid: item.actor.uuid, sourceItemUuid: item.uuid, castRank: rank, region: burst,
                durationSeconds: declaration.durationSeconds, events: ["turn-start"], turnEffect: { drain: { ...drain } }, dc: options.dc ?? item.spellcasting?.statistic?.dc?.value ?? null,
                parentCastId: record.castId, seedMembers: true });
            data.childCastIds = [...(data.childCastIds ?? []), child.castId];
            data.entries.push({ uuid: burst.uuid, actorUuid: item.actor.uuid, status: "active", permanent: false });
        }
        // "You glow with bright light in a 30-foot radius and dim light to the next 30 feet.": the caster's light, ending with the area.
        if (declaration.casterLight) {
            const [light] = await item.actor.createEmbeddedDocuments("Item", [{ name: `${item.name} (light)`, type: "effect", img: "icons/svg/light.svg",
                flags: { [MODULE_ID]: { casterLight: { castId: record.castId } } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: false },
                    rules: [{ key: "TokenLight", value: { bright: declaration.casterLight.bright, dim: declaration.casterLight.dim } }] } }]);
            data.entries.push({ uuid: light.uuid, actorUuid: item.actor.uuid, status: "active", permanent: false });
        }
        for (const placed of regions) data.entries.push({ uuid: placed.uuid, actorUuid: item.actor.uuid, status: "active", permanent: false });
        // Difficult terrain: PF2e's movement cost on each area, removed with it.
        if (declaration.terrain) for (const placed of regions) await placed.createEmbeddedDocuments("RegionBehavior", [{ name: `${item.name}: difficult terrain`,
            type: "modifyMovementCost", system: { difficulties: terrainDifficulties(declaration.terrain.movement, declaration.terrain.difficulty) },
            // (Only for living creatures: the module's per-creature terrain.)
            ...(declaration.terrain.living ? { flags: { [MODULE_ID]: { selectiveTerrain: { actions: ["walk", "travel"], default: 1, living: { difficulty: declaration.terrain.difficulty } } } } } : {}) }]);
        // Darklight: the region fully dark (Foundry's darkness level override), removed with it.
        if (declaration.darkness) for (const placed of regions) await placed.createEmbeddedDocuments("RegionBehavior", [{ name: `${item.name}: darkness`,
            type: "adjustDarknessLevel", system: { mode: declaration.darkness.mode, modifier: declaration.darkness.modifier } }]);
        // "choose up to four allies in the area to spare from darklight's effects": the caster's targeted allies (up to the count) hold the area's immunity
        // for its duration, so its exposures skip them.
        if (declaration.spared) {
            const allies = [...(options.targets ?? [])].map(token => token.document ?? token).filter(token => token?.actor && token.actor !== item.actor && item.actor.isAllyOf?.(token.actor));
            if (allies.length > declaration.spared.count) throw Error(`${item.name} spares at most ${declaration.spared.count} allies: target fewer.`);
            data.declaration.immunityKey = `spared:${record.castId}`;
            for (const token of allies) {
                const [marker] = await token.actor.createEmbeddedDocuments("Item", [{ name: `${item.name}: spared`, type: "effect", img: "icons/svg/eye.svg",
                    flags: { [MODULE_ID]: { spellImmunity: { key: data.declaration.immunityKey } } },
                    system: { description: { value: `<p>Spared by the caster: immune to this ${escapeHTML(item.name)}'s damage, and sees through its darkness as though with greater darkvision.</p>` },
                        level: { value: rank }, duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, rules: [] } }]);
                data.entries.push({ uuid: marker.uuid, actorUuid: token.actor.uuid, status: "active", permanent: false });
            }
            data.spared = allies.map(token => token.actor.uuid);
        }
        // Notes the GM acts on ("A creature can Interact to clear a square of this scree.").
        if (declaration.notes?.length) await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: item.actor }), whisper: game.users.filter(user => user.isGM).map(user => user.id),
            content: `<p><strong>${escapeHTML(item.name)}</strong></p>${declaration.notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note)}${/clear a square/.test(note) ? " (edit the area's region to remove that square)" : /^Only squares|move the area's region|^Creatures in the area can't|^Unattended objects in the area|melts on any object|^When a creature in the spell's area would be healed|can Interact to pick up/.test(note) ? "" : " End the spell in Ongoing spells when it does."}</p>`).join("")}` });
        // "…, granting you a +1 status bonus to Will saving throws against emotion effects for 1 minute.": PF2e's Effect on the caster,
        // proved again from the live template.
        if (declaration.casterEffect) {
            const template = await loadNativeEffectTemplate(declaration.casterEffect.uuid);
            const live = { mechanics: { rules: template.system?.rules, duration: template.system?.duration } };
            if (!inspectCasterBenefitClaim(live, declaration.casterEffect.claimText, { rank, spellDuration: declaration.sustained ? "sustained" : null }).supported) throw Error(`${item.name}: PF2e's Effect no longer gives the stated benefit.`);
            const source = prepareNativeEffectSource(template, { castInstanceId: record.castId, castRank: rank, sourceActorUuid: item.actor.uuid, sourceItemUuid: item.uuid,
                sourceItemName: item.name, resolutionKind: "lingering-caster" });
            const effect = await createNativeEffect(item.actor, source);
            data.entries.push({ uuid: effect.uuid, actorUuid: item.actor.uuid, status: "active", permanent: false });
        }
        // (Aura of Violent Light: the module's Effect on the ally, proved again from the live template — its Aura of 5 × its badge, the badge the text's radii.)
        if (declaration.anchorEffect) {
            const template = await loadNativeEffectTemplate(declaration.anchorEffect.uuid);
            if (!violentLightEffectMatches(template, { feet: declaration.aura.feet, step: declaration.auraGrowth.feet, maximum: declaration.auraGrowth.maximum }))
                throw Error(`${item.name}: the module's Effect no longer matches the text's aura.`);
            const source = prepareNativeEffectSource(template, { castInstanceId: record.castId, castRank: rank, sourceActorUuid: item.actor.uuid, sourceItemUuid: item.uuid,
                sourceItemName: item.name, resolutionKind: "lingering-anchor" });
            for (const uuid of declaration.targetTokenUuids ?? []) {
                const token = await fromUuid(uuid);
                const effect = await createNativeEffect(token.actor, clone(source));
                data.entries.push({ uuid: effect.uuid, actorUuid: token.actor.uuid, status: "active", permanent: false, anchorEffect: true });
            }
        }
        // (Shroud of Flame: the caster's retaliation marker for the area's lifetime; the Retaliate control in Ongoing spells deals its damage.)
        if (declaration.retaliation) {
            const metadata = { schema: 1, kind: "retaliation", castInstanceId: record.castId, sourceActorUuid: item.actor.uuid, sourceItemUuid: item.uuid, sourceItemName: item.name,
                castRank: rank, baseRank: Number(plan.rank), retaliation: clone(declaration.retaliation) };
            const [marker] = await item.actor.createEmbeddedDocuments("Item", [{ name: `${item.name} (retaliates)`, type: "effect", img: item.img ?? "icons/svg/fire.svg",
                flags: { [MODULE_ID]: { runtime: metadata } },
                system: { level: { value: rank }, duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, rules: [],
                    description: { value: declaration.retaliation.triggers.map(trigger => `<p><strong>When:</strong> ${escapeHTML(trigger.trigger)} Use “Retaliate” in Ongoing spells with that creature targeted.</p>`).join("") } } }]);
            data.entries.push({ uuid: marker.uuid, actorUuid: item.actor.uuid, status: "active", permanent: false, metadata: clone(metadata) });
        }
        // Creatures already inside don't "enter"; they're exposed on their turn (or now, when the spell says so).
        const members = await this.lingeringMembership(data) ?? [];
        data.members = members.map(member => member.tokenUuid);
        await this.syncLingeringConcealment(data, members);
        await this.syncHealingWatch(data, members);
        await this.syncLingeringMembers(data, members);
        await this.syncBlessed(data);
        await this.syncMemberCondition(data, members);
        await this.syncMemberEffect(data, members);
        if (declaration.initial) for (const member of members.filter(entry => !this.heldBySpell(data, entry.actorUuid))) addObligation(data, { key: `lingering:initial:${member.actorUuid}`, kind: "membership",
            label: `Review ${member.name}'s exposure when ${item.name} was cast`, actorUuid: member.actorUuid, tokenUuid: member.tokenUuid });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        // (Brimstone Rain: the blast's basic save card for the creatures inside as the area starts.)
        let castSaveCard = null;
        if (plan.resolution.castSavePlan && members.length) {
            const tokens = (await Promise.all(members.map(member => fromUuid(member.tokenUuid)))).filter(Boolean).map(token => token.object ?? token);
            const started = await this.saves.start(item, { plan: clone(plan.resolution.castSavePlan), sourceActor: item.actor, targets: tokens, castRank: rank,
                ...(options.dc ? { dc: options.dc } : {}), sourceMessageId: options.sourceMessageId ?? null, skipConfirmation: options.skipConfirmation ?? true });
            castSaveCard = started?.card?.id ?? null;
        }
        return { status: "prepared", castId: record.castId, journal, regionUuid: region?.uuid ?? null, members, ...(castSaveCard ? { castSaveCard } : {}) };
    }
    /**
     * A hazard left in a target's squares by a save or attack (“the ground in the target's space catches fire, dealing 1d6 fire damage
     * to each creature that ends its turn in one of the squares”): a region over the target's squares, run as a lingering area whose
     * trigger deals the damage itself (no save, no review): when a creature ends (or starts) its turn inside, or enters it. It lasts
     * the spell's duration: “until the end of the target's next turn” ends it after that turn's damage.
     */
    async startGroundHazard({ hazard, castId, spellName, sourceActorUuid, sourceItemUuid, castRank, targetActorUuid, targetTokenUuid }) {
        this.ongoing.assertCoordinator();
        const token = targetTokenUuid ? await fromUuid(targetTokenUuid) : null;
        const scene = token?.parent;
        if (!scene || token.documentName !== "Token") throw Error("the target's token isn't on a scene");
        const size = scene.grid.size;
        // The target's squares, or with the squares adjacent to them ("in the target's space and all spaces adjacent to the target").
        const ring = hazard.where === "target-and-adjacent" ? 1 : 0;
        const [region] = await scene.createEmbeddedDocuments("Region", [{ name: `${spellName}: ${hazard.label}`, color: "#e8590c",
            shapes: [{ type: "rectangle", x: token.x - ring * size, y: token.y - ring * size, width: (token.width + 2 * ring) * size, height: (token.height + 2 * ring) * size, rotation: 0, hole: false }],
            visibility: CONST.REGION_VISIBILITY.ALWAYS, flags: { [MODULE_ID]: { groundHazard: castId } } }]);
        const clock = this.ongoing.clock();
        const spec = hazard.duration;
        const targetTurn = spec.mode === "turn-boundary" && spec.anchor === "target-turn" && spec.expiry === "turn-end";
        const seconds = spec.unit === "minutes" ? spec.value * 60 : spec.value * 6;
        const declaration = { centre: "placed", events: [...hazard.events], hazardDamage: { formula: hazard.formula, type: hazard.damage.type, label: hazard.label },
            oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false, area: null, sustained: false, durationSeconds: seconds,
            ...(targetTurn ? { endsAt: "target-turn-end", targetActorUuid, skipTurn: clock.started && clock.actorUuid === targetActorUuid } : {}),
            sourceText: [hazard.sourceText] };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            // In combat, “until the end of the target's next turn” ends on that turn; out of combat, after the round.
            maximumAt: targetTurn && clock.started ? null : game.time.worldTime + seconds, castRound: clock.round, hazardOf: castId };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        // Creatures already inside don't “enter”.
        data.members = (await this.lingeringMembership(data) ?? []).map(member => member.tokenUuid);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "placed", regionUuid: region.uuid, journalId: journal.id };
    }
    /**
     * Spirit Link's transfer: the target regains up to the amount (never past its maximum) and the caster loses as many, both as direct
     * Hit Point changes (no modifiers, temporary Hit Points ignored). At 0 Hit Points the caster's spell ends.
     */
    async transferHitPoints(record, target) {
        const caster = await fromUuid(record.sourceActorUuid);
        const hp = actor => actor?.system?.attributes?.hp;
        const amount = Math.max(0, Math.min(record.declaration.hazardDamage.transfer, Number(hp(target)?.max ?? 0) - Number(hp(target)?.value ?? 0)));
        if (amount > 0) {
            await target.update({ "system.attributes.hp.value": Number(hp(target).value) + amount });
            await caster.update({ "system.attributes.hp.value": Math.max(0, Number(hp(caster).value) - amount) });
        }
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), flags: { [MODULE_ID]: { kind: "hp-transfer", castId: record.castId } },
            content: `<p><strong>${escapeHTML(record.name)}</strong>: ${amount ? `${escapeHTML(target.name)} regains ${amount} Hit Points; ${escapeHTML(caster.name)} loses ${amount}.` : `${escapeHTML(target.name)} is at maximum Hit Points; nothing is transferred.`}</p>` }); } catch (_) {}
        return { total: amount, transferred: amount };
    }
    /** Spirit Link: an ongoing record on the target, transferring at cast and at the start of each of the caster's turns. */
    async startHpTransfer({ spellName, sourceActorUuid, sourceItemUuid, castRank, targetTokenUuid, amount, durationSeconds, endsAtZero, notes }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const token = await fromUuid(targetTokenUuid);
        const declaration = { centre: "targets", targetTokenUuids: [targetTokenUuid], events: ["source-turn-start"], hazardDamage: { transfer: amount, label: "Hit Point transfer" },
            oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false, area: null, sustained: false, durationSeconds, endsAtZero, sourceText: notes };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: token?.actor ? [token.actor.uuid] : [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round,
            dismissal: { authority: "source-actor", scope: "cast", action: "Dismiss" } };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.members = (await this.lingeringMembership(data) ?? []).map(member => member.tokenUuid);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        // "When you Cast this Spell …": the first transfer now.
        const first = await this.transferHitPoints(data, token.actor);
        return { status: "started", journalId: journal.id, castId: record.castId, first };
    }
    /**
     * Healing at the end of one target's own turns (Fated Healing): a lingering record centred on that creature, whose turn-end trigger
     * heals it. The GM ends the record when the spell ends for that target.
     */
    async startTurnHealing({ spellName, sourceActorUuid, sourceItemUuid, castRank, targetTokenUuid, formula, durationSeconds, note }) {
        return this.startTurnHazard({ spellName, sourceActorUuid, sourceItemUuid, castRank, targetTokenUuid, formula, heal: true, events: ["turn-end"], sustained: false, durationSeconds, note });
    }
    /**
     * Healing or damage to one creature on a turn event (Fated Healing at the end of its own turns; Positive Attunement at the end of the
     * caster's turns, sustained, doubled after a critical failure): a lingering record centred on that creature.
     */
    async startTurnHazard({ spellName, sourceActorUuid, sourceItemUuid, castRank, targetTokenUuid, formula, type = null, heal = false, multiplier = 1, events = ["turn-end"], sustained = false, durationSeconds, note, whileHeld = null }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        // (Murderous Vine: only while the creature still holds the condition Effect that cast's card gave it.)
        const hazardDamage = heal ? { formula, type: "healing", heal: true, label: "regains Hit Points" }
            : { formula, type, label: "the spell", ...(multiplier === 2 ? { multiplier: 2 } : {}), ...(whileHeld ? { whileHeld } : {}) };
        const declaration = { centre: "targets", targetTokenUuids: [targetTokenUuid], events: [...events], hazardDamage,
            oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false, area: null, sustained: sustained === true, durationSeconds, sourceText: [note ?? ""] };
        const token = await fromUuid(targetTokenUuid);
        const record = { castId: randomID(), name: `${spellName} (${token?.name ?? "target"})`, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: token?.actor ? [token.actor.uuid] : [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.members = (await this.lingeringMembership(data) ?? []).map(member => member.tokenUuid);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", journalId: journal.id, castId: record.castId };
    }
    /**
     * The additional save of a persistent-damage spell (Dehydrate) for one creature: a lingering record centred on it whose turn-end exposure
     * (the GM confirms it didn't drink) opens the additional save's card. It ends when the creature's persistent damage of that type ends,
     * or when the spell's duration runs out.
     */
    async startFollowUpSave({ spellName, sourceActorUuid, sourceItemUuid, castRank, dc, targetTokenUuid, followUp }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const token = await fromUuid(targetTokenUuid);
        if (!token?.actor || !followUp?.exposurePlan) throw Error(`${spellName}: the creature or the additional save is missing.`);
        const declaration = { centre: "targets", targetTokenUuids: [targetTokenUuid], events: [followUp.timing], oncePerRound: false, excludeCaster: false, enemiesOnly: false,
            initial: false, concealment: false, area: null, sustained: false, durationSeconds: followUp.durationSeconds, endsWithPersistent: followUp.damageType,
            reviewQuestion: followUp.question, sourceText: [followUp.sourceText, followUp.note] };
        const record = { castId: randomID(), name: `${spellName} (${token.name})`, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: dc ?? null,
            recipientUuids: [token.actor.uuid], recipients: [], exposure: [], members: [], declaration, exposurePlan: clone(followUp.exposurePlan),
            maximumAt: game.time.worldTime + followUp.durationSeconds, castRound: clock.round };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.members = (await this.lingeringMembership(data) ?? []).map(member => member.tokenUuid);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", journalId: journal.id, castId: record.castId };
    }
    /**
     * An emanation whose Effect each creature gets as it begins its turn inside (Manifest Will): a lingering record on the caster, sustained,
     * applying PF2e's Spell Effect with the caster's tradition to the creatures the tradition names (the caster included).
     */
    /**
     * A concealing cloud left by a spell's action (Eat Fire's Belch Smoke): a lingering area on the placed region for its duration; creatures
     * inside are Concealed with the flat-check note for creatures outside (syncLingeringConcealment). Notes go to the GM.
     */
    /**
     * An area that is only difficult terrain (Mud Pit, Earthworks, Warped Terrain, 500 Toads): PF2e's movement cost on the placed region, as a
     * lingering record for the duration (a 1-round area ends at the start of the caster's next turn). Notes go to the GM.
     */
    async startTerrainArea({ spellName, sourceActorUuid, sourceItemUuid, castRank, region, durationSeconds, endsAt = null, movement = ["walk"], notes = [] }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const declaration = { centre: "placed", events: [], oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false,
            sustained: false, durationSeconds, terrain: { difficulty: 2, movement, hazardous: false }, ...(endsAt ? { endsAt } : {}), notes, sourceText: [] };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            maximumAt: endsAt === "caster-turn-start" && clock.started ? null : game.time.worldTime + durationSeconds, castRound: clock.round };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        await region.createEmbeddedDocuments("RegionBehavior", [{ name: `${spellName}: difficult terrain`, type: "modifyMovementCost",
            system: { difficulties: terrainDifficulties(movement, 2) } }]);
        if (notes.length) await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id),
            content: `<p><strong>${escapeHTML(spellName)}</strong></p>${notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, "$1"))}</p>`).join("")}` });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId, regionUuid: region.uuid };
    }
    /**
     * A placed area whose region carries Foundry behaviours for the duration (Darkness's darkness level): a lingering record with no save;
     * the behaviours go with the region when the spell ends. Notes go to the GM.
     */
    /**
     * An aura around a target creature for a time (Rallying Banner): a lingering record centred on its token, the caster's allies inside (the target too)
     * holding the generated member Effect, lost on leaving; the bearer's note; the GM's control moves the aura to another creature.
     */
    async startTargetAura({ spellName, sourceActorUuid, sourceItemUuid, castRank, targetTokenUuid, radius, durationSeconds, member, notes = [], bearerNote = null, everyone = false, transferable = true,
        sides = false, events = [], hazardDamage = null, sustained = false, includeTargets = true }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const declaration = { centre: "targets", targetTokenUuids: [targetTokenUuid], aura: { feet: radius, includeTargets: includeTargets !== false }, events: [...events], oncePerRound: false, excludeCaster: false, enemiesOnly: false,
            initial: false, concealment: false, sustained: sustained === true, durationSeconds, notes, sourceText: [], ...(hazardDamage ? { hazardDamage } : {}),
            // (Circle of Protection: every creature inside, not only the caster's allies; Radiant Heart of Devotion: the "good" side only.)
            memberEffect: { ...(everyone || sides ? { all: true } : { allies: true }), ...(sides ? { sides: true } : {}), generated: clone(member) }, transferable, ...(sides ? { alignment: [] } : {}) };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null, recipientUuids: [], recipients: [], exposure: [], members: [],
            declaration, exposurePlan: null, maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        if (bearerNote) {
            const bearer = (await fromUuid(targetTokenUuid))?.actor;
            const [note] = bearer ? await bearer.createEmbeddedDocuments("Item", [{ name: `${spellName}: the banner's bearer`, type: "effect", img: "icons/svg/banner.svg",
                flags: { [MODULE_ID]: { runtime: { schema: 1, kind: "lingering-bearer", castInstanceId: record.castId, sourceActorUuid, sourceItemUuid, sourceItemName: spellName } } },
                system: { level: { value: castRank }, duration: { value: Math.max(1, Math.round(durationSeconds / 60)), unit: "minutes", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                    description: { value: `<p>${escapeHTML(bearerNote)}</p>` }, rules: [] } }]) : [];
            if (note) data.entries.push({ uuid: note.uuid, actorUuid: bearer.uuid, status: "active", permanent: false, bearerNote: true });
        }
        if (notes.length) await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id),
            content: `<p><strong>${escapeHTML(spellName)}</strong></p>${notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note)}</p>`).join("")}` });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId };
    }
    /** Rallying Banner's transfer: the aura now around the touched creature (the bearer's note moves with it). */
    async transferAura({ castId, tokenUuid }, user = game.user) {
        if (!user.isGM) throw Error("The GM moves the banner.");
        const journal = this.ongoing.find(castId), record = journal ? clone(state(journal)) : null;
        if (!record?.declaration?.transferable || record.status !== "active") throw Error("This aura can't be moved.");
        const token = await fromUuid(tokenUuid);
        if (!token?.actor) throw Error("Target the new bearer.");
        record.declaration.targetTokenUuids = [tokenUuid];
        for (const entry of record.entries.filter(entry => entry.bearerNote && entry.status === "active")) {
            const note = await fromUuid(entry.uuid);
            if (note && note.actor !== token.actor) {
                const [moved] = await token.actor.createEmbeddedDocuments("Item", [note.toObject()]);
                await note.delete({ [MODULE_ID]: { ongoingCleanup: true } });
                entry.status = "ended"; entry.reason = "transferred";
                record.entries.push({ uuid: moved.uuid, actorUuid: token.actor.uuid, status: "active", permanent: false, bearerNote: true });
            }
        }
        await this.ongoing.save(journal, record);
        return { status: "transferred" };
    }
    async startRegionArea({ spellName, sourceActorUuid, sourceItemUuid, castRank, region, durationSeconds, behaviors = [], notes = [], gmHazard = null, casterTurnEnd = null, followToken = null,
        events = [], hazardDamage = null, sustained = false, excludeCaster = false, parentCastId = null, hazardOncePerTurn = false, hazardOncePerRound = false, seedMembers = false, regionGrowth = null,
        turnEffect = null, dc = null, disbelief = null, memberEffect = null, memberEffects = null, endsAtTurnEndOf = null, sustainPulse = false,
        memberRules = null, memberAllies = false, memberCaster = false, memberCasterOnly = false, excludeTokenUuids = null, extraEntryUuids = [], enemiesOnly = false, concealment = false }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        // (A region around the caster's token that moves with it: Magnetic Repulsion's adjacent squares.)
        // (Damage the area deals by itself on an event: Wall of Fire's "occupying the wall's area at the start of its turn".)
        const declaration = { centre: "placed", events: [...events], ...(hazardDamage ? { hazardDamage } : {}), ...(hazardOncePerTurn ? { hazardOncePerTurn: true } : {}), ...(hazardOncePerRound ? { hazardOncePerRound: true } : {}), oncePerRound: false, excludeCaster: excludeCaster === true, enemiesOnly: enemiesOnly === true, initial: false, concealment: concealment === true,
            sustained: sustained === true, durationSeconds, notes, sourceText: [], ...(gmHazard ? { gmHazard } : {}), ...(casterTurnEnd ? { casterTurnEnd } : {}), ...(followToken ? { followToken } : {}),
            // (A turn-start effect of the area itself: Tear the Veil's draining centre.)
            ...(turnEffect ? { turnEffect } : {}),
            // (Shadow Puppetry: the area's damage to everyone in it when cast and on the first Sustain each turn — areaPulse.)
            ...(sustainPulse ? { sustainPulse: true } : {}),
            // (Ice Guardian's cover: its rules on the caster and its allies inside, not on the guardian itself.)
            ...(memberRules?.length ? { memberRules, ...(memberAllies ? { memberAllies: true } : {}), ...(memberCaster ? { memberCaster: true } : {}), ...(memberCasterOnly ? { memberCasterOnly: true } : {}) } : {}),
            ...(excludeTokenUuids?.length ? { excludeTokenUuids: [...excludeTokenUuids] } : {}),
            // (Fateful Condemnation: a generated Effect on the creatures inside — the aura's own creature and its allies.)
            ...(memberEffect ? { memberEffect } : {}),
            // ("until the end of the target's next turn": Shock to the System's cloud.)
            ...(endsAtTurnEndOf ? { endsAt: "target-turn-end", targetActorUuid: endsAtTurnEndOf, skipTurn: clock.started && clock.actorUuid === endsAtTurnEndOf } : {}),
            // (A mode card's area: several member Effects in their own slots — Musical Shift's enemies and allies.)
            ...(memberEffects?.length ? { memberEffects } : {}),
            // (Shadow Raid: the GM's disbelief control; a success halves the area's damage.)
            ...(disbelief ? { disbelief: { ...disbelief, key: `disbelieved:${spellName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${randomID()}` } } : {}),
            // (Field of Razors: the burst the caster's reaction grows, a stated number of times.)
            ...(regionGrowth ? { regionGrowth: { feet: regionGrowth.feet, times: regionGrowth.times, maximum: regionGrowth.maximum, types: regionGrowth.types }, area: { type: "burst", value: Number(regionGrowth.radius) } } : {}) };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: dc ?? null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            // (No duration — Garden of Crystals' crystals: until the GM ends it.)
            maximumAt: durationSeconds == null ? null : game.time.worldTime + durationSeconds, castRound: clock.round, ...(parentCastId ? { parentCastId } : {}) };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        // (What else the cast made that ends with the area: Garden of Crystals' terrain region, walls and the caster's reminder.)
        for (const uuid of extraEntryUuids) data.entries.push({ uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        // (Creatures already inside when it's made didn't "enter" it — Flammable Fumes: they take it as their turn starts.)
        if (seedMembers) data.members = ((await this.lingeringMembership(data)) ?? []).map(member => member.tokenUuid);
        if (behaviors.length) await region.createEmbeddedDocuments("RegionBehavior", clone(behaviors));
        if (notes.length) await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id),
            content: `<p><strong>${escapeHTML(spellName)}</strong></p>${notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note)}</p>`).join("")}` });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId, regionUuid: region.uuid };
    }
    /**
     * A placed absorber (Protector Tree): a lingering record on the region holding the tree's Hit Points; `absorberOnDamage` takes Strike damage
     * to the caster's allies adjacent to it from the tree first; at 0 the record (and the region) ends.
     */
    async startAbsorber({ spellName, sourceActorUuid, sourceItemUuid, castRank, region, durationSeconds, hp, notes = [] }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const declaration = { centre: "placed", events: [], oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false,
            sustained: false, durationSeconds, notes, sourceText: [] };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round, absorber: { hp, remaining: hp } };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        if (notes.length) await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id),
            content: `<p><strong>${escapeHTML(spellName)}</strong> (${hp} Hit Points)</p>${notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note)}</p>`).join("")}` });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId, regionUuid: region.uuid };
    }
    /** Strike damage to an ally adjacent to an absorber: the absorber takes it first (the ally's Hit Points restored by that much). */
    async absorberOnDamage(message, { isStrike, lastDamage }) {
        const applied = message?.flags?.pf2e?.appliedDamage;
        if (!applied || applied.isHealing || message.flags.pf2e.context?.type !== "damage-taken" || !isStrike(message.flags.pf2e.context.options)) return null;
        const victim = await fromUuid(applied.uuid);
        const token = victim?.getActiveTokens?.(true, false)?.[0];
        if (!token) return null;
        for (const journal of this.ongoing.records()) {
            const record = state(journal);
            if (record?.status !== "active" || !record.absorber || record.absorber.remaining <= 0) continue;
            const caster = await fromUuid(record.sourceActorUuid);
            if (!caster || victim === caster || !caster.isAllyOf?.(victim)) continue;
            const region = await fromUuid(record.regionUuid);
            const shape = region?.shapes?.[0] ?? region?.shapes?.contents?.[0];
            if (!shape) continue;
            const centre = { x: shape.x + (shape.width ?? 0) / 2, y: shape.y + (shape.height ?? 0) / 2 };
            const tokenCentre = token.center ?? { x: token.document.x + canvas.grid.size / 2, y: token.document.y + canvas.grid.size / 2 };
            const squares = Math.max(Math.abs(tokenCentre.x - centre.x), Math.abs(tokenCentre.y - centre.y)) / canvas.grid.size;
            if (squares > 1.01) continue;
            const amount = Number(lastDamage(victim)?.amount ?? 0);
            if (!(amount > 0)) continue;
            const absorbed = Math.min(record.absorber.remaining, amount);
            const hp = victim.system.attributes.hp;
            await victim.update({ "system.attributes.hp.value": Math.min(Number(hp.max), Number(hp.value) + absorbed) });
            const data = clone(record);
            data.absorber.remaining -= absorbed;
            await this.ongoing.save(journal, data);
            try { await ChatMessage.create({ content: `<p><strong>${escapeHTML(record.name)}</strong> takes ${absorbed} of the Strike's damage to ${escapeHTML(victim.name)} (${data.absorber.remaining} Hit Points left).</p>` }); } catch (_) {}
            if (data.absorber.remaining <= 0) await this.ongoing.end(journal, { reason: "destroyed" });
            return { absorbed, remaining: data.absorber.remaining };
        }
        return null;
    }
    async startCloud({ spellName, sourceActorUuid, sourceItemUuid, castRank, region, durationSeconds, notes = [], dismissible = false, memberRules = [], turnCondition = null,
        hazardDamage = null }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        if (turnCondition && hazardDamage) throw Error(`${spellName}: a cloud has either a turn condition or hazard damage.`);
        // (Quicken Time: a condition on each creature as its turn starts inside, until that turn ends. Dust Storm: damage as a creature enters or
        // starts its turn inside.)
        const declaration = { centre: "placed", events: turnCondition ? ["turn-start"] : hazardDamage ? ["enter", "turn-start"] : [], ...(hazardDamage ? { hazardDamage } : {}), oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: true,
            sustained: false, durationSeconds, notes, sourceText: [], ...(memberRules.length ? { memberRules } : {}), ...(turnCondition ? { turnEffect: { condition: turnCondition } } : {}) };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round,
            ...(dismissible ? { dismissal: { authority: "source-actor", scope: "cast", action: "Dismiss" } } : {}) };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        const members = await this.lingeringMembership(data) ?? [];
        data.members = members.map(member => member.tokenUuid);
        await this.syncLingeringConcealment(data, members);
        if (notes.length) await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id),
            content: `<p><strong>${escapeHTML(spellName)}</strong></p>${notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note)}</p>`).join("")}` });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", journalId: journal.id, castId: record.castId, members: members.map(member => member.actorUuid), memberTokens: members.map(member => member.tokenUuid) };
    }
    /**
     * An emanation on the caster whose Effect the caster and its allies hold while inside (Frenzied Revelry): a lingering record for the
     * duration, synced on every reconcile (leaving removes it). `memberCriticalSave` adds the critical rider.
     */
    async startAllyAura({ spellName, sourceActorUuid, sourceItemUuid, castRank, radius, durationSeconds, effect, critical = null, trait = null, ruleOverrides = null, sustained = false,
        alliesOnly = false, escapePrompt = null }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        // (A sustained dance: its allies only, not the caster, and the Escape it offers on the cast and each Sustain — Coiling Dance.)
        const declaration = { centre: "caster", events: [], oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false,
            area: { type: "emanation", value: Number(radius) }, sustained, durationSeconds, sourceText: [], ...(escapePrompt ? { escapePrompt } : {}),
            memberEffect: { allies: true, ...(alliesOnly ? { excludeCaster: true } : {}), uuid: effect.uuid, label: effect.label, critical, trait, ...(ruleOverrides ? { ruleOverrides } : {}) } };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round,
            ...(sustained ? { sustained: true } : {}) };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        const members = await this.lingeringMembership(data) ?? [];
        data.members = members.map(member => member.tokenUuid);
        await this.syncMemberEffect(data, members);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        if (escapePrompt) await this.postEscapePrompt(data);
        return { status: "started", castId: record.castId, holders: [...new Set(data.entries.map(entry => entry.actorUuid))] };
    }
    /**
     * A placed area whose occupants hold PF2e's Effect (Gentle Breeze): a lingering record for the duration, synced on every reconcile (leaving
     * removes it). The living creatures inside when it's cast are tracked: one that leaves is dropped, and when the duration runs out the rest
     * regain the Hit Points (applyStayHealing).
     */
    async startAreaBoon({ spellName, sourceActorUuid, sourceItemUuid, castRank, region, durationSeconds, effect, ruleAdditions = null, stayHealing = null, notes = [], selection = null, sustained = false, assistedRecovery = false,
        allies = false, ruleOverrides = null, includeCaster = false, followToken = null, turnEnd = false, shieldUse = null }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        // (A region following the caster's token, Shielding Formation's emanation: still a placed region for membership.)
        const declaration = { centre: "placed", events: [], oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false,
            area: null, sustained: sustained === true, durationSeconds, sourceText: [], notes, ...(assistedRecovery ? { assistedRecovery: true } : {}), ...(followToken ? { followToken } : {}),
            // ("Allies within the area …", Font of Serenity: the caster's allies inside, not the caster; "You and each ally …", Shielding Formation: both.)
            // (Shielding Formation: only on ending a turn inside; its resistance's use ends the Effect with an immunity.)
            memberEffect: { ...(allies ? { allies: true, excludeCaster: !includeCaster } : { all: true }), uuid: effect.uuid, label: effect.label, ...(ruleAdditions ? { ruleAdditions } : {}),
                ...(ruleOverrides ? { ruleOverrides } : {}), ...(selection ? { selection } : {}), ...(turnEnd ? { turnEnd: true } : {}), ...(shieldUse ? { shieldUse } : {}) }, stayHealing };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        const members = await this.lingeringMembership(data) ?? [];
        data.members = members.map(member => member.tokenUuid);
        data.stayers = [];
        if (stayHealing) for (const member of members) if (livingMode(await fromUuid(member.actorUuid))) data.stayers.push(member.actorUuid);
        await this.syncMemberEffect(data, members);
        // "assisted recovery … when the spell is cast": each occupant's recovery flat checks now.
        const recovered = assistedRecovery ? await this.assistedRecovery(data, members) : null;
        // (Cast on the caster's own turn: that turn's start has passed.)
        if (assistedRecovery && clock.started && clock.actorUuid === sourceActorUuid)
            data.exposure.push({ key: `caster-turn-start:${clock.combatId}:${clock.round}:${clock.turn ?? 0}`, event: "caster-turn-start", actorUuid: sourceActorUuid });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId, ...(recovered ? { recovered } : {}), holders: [...new Set(data.entries.filter(entry => entry.uuid !== region.uuid).map(entry => entry.actorUuid))], stayers: [...data.stayers] };
    }
    /** Assisted recovery for the area's occupants: PF2e's recovery flat check for each persistent damage each one has. */
    async assistedRecovery(record, members) {
        const rolled = [];
        for (const { actorUuid } of members) {
            const actor = await fromUuid(actorUuid);
            for (const condition of (actor?.itemTypes?.condition ?? []).filter(item => item.slug === "persistent-damage")) {
                await condition.rollRecovery?.();
                rolled.push({ actorUuid, damageType: condition.system?.persistent?.damageType ?? null });
            }
        }
        if (rolled.length) await new Promise(resolve => setTimeout(resolve, 500));
        return rolled;
    }
    /** "if it remains within the area for the full duration, regains 10 Hit Points": the creatures inside from the cast to the end. */
    async applyStayHealing(record) {
        const healing = record.declaration.stayHealing;
        const healed = [];
        for (const actorUuid of record.stayers ?? []) {
            const actor = await fromUuid(actorUuid);
            if (!actor || (healing.living && !livingMode(actor))) continue;
            const wasDying = isDying(actor);
            const token = actor.getActiveTokens?.()?.[0]?.document;
            await applyDamageWithReceipt(actor, { damage: -healing.amount, token: token ?? undefined, item: (await castSpellFromUuid(record)) ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            await recoverFromDying(actor, wasDying);
            healed.push(actor.name);
        }
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), flags: { [MODULE_ID]: { kind: "stay-healing", castId: record.castId } },
            content: `<p><strong>${escapeHTML(record.name)}</strong> ran its full duration: ${healed.length ? `${healed.map(name => `<strong>${escapeHTML(name)}</strong>`).join(", ")} regain${healed.length === 1 ? "s" : ""} ${healing.amount} Hit Points` : "no living creature stayed inside the whole time"}.</p>` }); }
        catch (_) {}
        return healed;
    }
    /** Helpful Wood Spirits: a sustained placed area whose aid is chosen on the cast and each Sustain (its card). */
    async startSpiritAid({ spellName, sourceActorUuid, sourceItemUuid, castRank, dc, region, durationSeconds, spirit, aid }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const declaration = { centre: "placed", events: [], oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false,
            area: clone(spirit.area), sustained: true, durationSeconds, sourceText: [], spiritAid: clone(spirit) };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round, spiritAidRound: null };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        const members = await this.lingeringMembership(data) ?? [];
        data.members = members.map(member => member.tokenUuid);
        const result = await this.spiritPulse(data, aid);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId, ...result };
    }
    /** The aid this round: the previous one's terrain and Off-Guard go; Chores (the GM's), Distract, Obstacle or Search. */
    async spiritPulse(record, aid) {
        const spirit = record.declaration.spiritAid;
        if (!spirit.aids[aid]) throw Error(`Choose one of: ${Object.keys(spirit.aids).join(", ")}.`);
        const region = await fromUuid(record.regionUuid);
        const obstacles = (region?.behaviors?.contents ?? []).filter(behavior => behavior.flags?.[MODULE_ID]?.spiritObstacle === record.castId).map(behavior => behavior.id);
        if (obstacles.length) await region.deleteEmbeddedDocuments("RegionBehavior", obstacles);
        for (const entry of (record.entries ?? []).filter(entry => entry.status === "active" && entry.spiritAid)) {
            const effect = await fromUuid(entry.uuid);
            if (effect) await effect.delete();
            entry.status = "ended";
        }
        const caster = await fromUuid(record.sourceActorUuid);
        const lines = [];
        const result = { aid };
        if (aid === "Distract") {
            const data = spirit.aids.Distract;
            const members = await this.lingeringMembership(record) ?? [];
            result.offGuard = [];
            for (const member of members) {
                const actor = await fromUuid(member.actorUuid);
                if (!actor || actor === caster || caster?.isAllyOf?.(actor)) continue;
                const roll = await actor.saves?.[data.statistic]?.roll({ dc: { value: Number(record.dc) }, skipDialog: true });
                if (Number(roll?.degreeOfSuccess ?? 0) >= 2) { lines.push(`${actor.name} succeeds.`); continue; }
                const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: off-guard`, type: "effect", img: "icons/svg/daze.svg",
                    flags: { [MODULE_ID]: { leaveArea: { castId: record.castId } } },
                    system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true },
                        rules: [{ key: "GrantItem", uuid: data.condition, flag: "spiritOffGuard", allowDuplicate: true, onDeleteActions: { granter: "cascade", grantee: "cascade" } }] } }]);
                record.entries.push({ uuid: effect.uuid, actorUuid: actor.uuid, status: "active", permanent: false, spiritAid: true });
                result.offGuard.push(actor.uuid);
                lines.push(`${actor.name} is Off-Guard while in the area (until the next aid).`);
            }
        } else if (aid === "Obstacle") {
            await region.createEmbeddedDocuments("RegionBehavior", [{ name: `${record.name}: obstacle`, type: "modifyMovementCost", system: { difficulties: { walk: 2, travel: 2 } }, flags: { [MODULE_ID]: { spiritObstacle: record.castId } } }]);
            lines.push("The area is difficult terrain (until the next aid).");
        } else if (aid === "Search") {
            await caster?.perception?.roll({ extraRollOptions: ["action:seek"], skipDialog: true });
            lines.push(`The spirits Seek in the area with ${caster?.name ?? "the caster"}'s Perception; the caster learns what they find (the GM tells).`);
        } else lines.push(`GM: the spirits perform the chosen minor task — ${spirit.aids.Chores.text}`);
        record.spiritAidCurrent = aid;
        record.spiritAidRound = game.combat?.started ? `${game.combat.id}:${game.combat.round}` : null;
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(record.name)} — ${escapeHTML(aid)}</strong></p>${lines.map(line => `<p>${escapeHTML(line)}</p>`).join("")}` }); } catch (_) {}
        return result;
    }
    /** The aid chosen on a Sustain's card (once a round). */
    async spiritAidChoice({ castId, aid }, user = game.user) {
        const journal = this.ongoing.find(castId);
        const record = journal ? clone(state(journal)) : null;
        if (!record?.declaration?.spiritAid || record.status !== "active") throw Error("The spell has ended.");
        const caster = await fromUuid(record.sourceActorUuid);
        if (!user.isGM && !caster?.testUserPermission(user, "OWNER")) throw Error("You don't control this caster.");
        const round = game.combat?.started ? `${game.combat.id}:${game.combat.round}` : null;
        if (round && record.spiritAidRound === round) throw Error("The spirits already gave their aid this round.");
        const result = await this.spiritPulse(record, aid);
        await this.ongoing.save(journal, record);
        return result;
    }
    /**
     * Web: a placed lingering area that's difficult terrain; a creature entering it, or moving while in it, gets the check card (Athletics or the
     * save, its choice), and the outcome is applied (a penalty lost on leaving, or Immobilized then the penalty); a critical success frees it for
     * the rest of its turn.
     */
    async startWeb({ spellName, sourceActorUuid, sourceItemUuid, castRank, dc, region, durationSeconds, web }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const declaration = { centre: "placed", events: [], oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false,
            area: { type: "burst", value: web.radius }, sustained: false, durationSeconds, notes: web.notes, sourceText: [], web: clone(web) };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round, webSeen: [], webFree: [], webPending: [] };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        await region.createEmbeddedDocuments("RegionBehavior", [{ name: `${spellName}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: { walk: 2, travel: 2 } } }]);
        // (The creatures already in it when it's cast check only once they start moving.)
        const members = await this.lingeringMembership(data) ?? [];
        data.members = members.map(member => member.tokenUuid);
        data.webSeen = await Promise.all(members.map(async member => { const token = await fromUuid(member.tokenUuid); return { actorUuid: member.actorUuid, x: token?.x ?? null, y: token?.y ?? null }; }));
        await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id), content: `<p><strong>${escapeHTML(spellName)}</strong></p>${web.notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note)}</p>`).join("")}` });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId };
    }
    /**
     * An area whose creatures hold an Effect of the given rules while inside (Oil-Slicked Walls' Climb DC): a placed lingering area; a creature
     * that leaves loses it (clearLeaveArea), and it ends with the area.
     */
    async startAreaRules({ spellName, sourceActorUuid, sourceItemUuid, castRank, region, durationSeconds, areaRules }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const declaration = { centre: "placed", events: [], oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false,
            area: { type: "emanation", value: 0 }, sustained: false, durationSeconds, notes: areaRules.notes ?? [], sourceText: [], areaRules: clone(areaRules) };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        const members = await this.lingeringMembership(data) ?? [];
        data.members = members.map(member => member.tokenUuid);
        await this.syncAreaRules(data, members);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId };
    }
    async syncAreaRules(record, members) {
        const area = record.declaration?.areaRules;
        if (!area) return;
        // (One creature's only — Establish Ward's caster — with its own Effect while outside: Slowed 1, ended on re-entering and when the area ends.)
        if (area.only && area.outside) {
            const actor = await fromUuid(area.only);
            const held = (actor?.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.areaOutside?.castId === record.castId);
            const inside = members.some(member => member.actorUuid === area.only);
            if (inside && held.length) await actor.deleteEmbeddedDocuments("Item", held.map(effect => effect.id), { [MODULE_ID]: { ongoingCleanup: true, reason: "entered-area" } });
            if (actor && !inside && !held.length) {
                const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: area.outside.name, type: "effect", img: area.outside.img ?? "icons/svg/downgrade.svg",
                    flags: { [MODULE_ID]: { areaOutside: { castId: record.castId }, areaLifetime: { castId: record.castId } } },
                    system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, level: { value: record.rank }, fromSpell: true,
                        description: { value: area.outside.description ?? "" }, rules: clone(area.outside.rules) } }]);
                record.entries.push({ uuid: effect.uuid, actorUuid: area.only, status: "active", permanent: false });
                record.recipientUuids = [...new Set([...(record.recipientUuids ?? []), area.only])];
            }
        }
        for (const { actorUuid } of members) {
            if (area.only && actorUuid !== area.only) continue;
            const actor = await fromUuid(actorUuid);
            if (!actor || (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.leaveArea?.castId === record.castId)) continue;
            const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: area.name, type: "effect", img: area.img ?? "icons/svg/net.svg",
                flags: { [MODULE_ID]: { leaveArea: { castId: record.castId } } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, level: { value: record.rank }, fromSpell: true,
                    description: { value: area.description ?? "" }, rules: clone(area.rules) } }]);
            record.entries.push({ uuid: effect.uuid, actorUuid, status: "active", permanent: false });
            record.recipientUuids = [...new Set([...(record.recipientUuids ?? []), actorUuid])];
        }
    }
    /** Who entered the web, or moved while in it, since the last look: their check cards. */
    async syncWeb(record, members) {
        const web = record.declaration?.web;
        if (!web) return;
        record.webSeen = Array.isArray(record.webSeen) ? record.webSeen : [];
        record.webPending = Array.isArray(record.webPending) ? record.webPending : [];
        const turnKey = `${game.combat?.id ?? "none"}:${game.combat?.round ?? 0}:${game.combat?.turn ?? 0}`;
        const now = [];
        for (const member of members) {
            const token = await fromUuid(member.tokenUuid);
            if (!token) continue;
            now.push({ actorUuid: member.actorUuid, x: token.x, y: token.y });
            const before = record.webSeen.find(entry => entry.actorUuid === member.actorUuid);
            const entered = !before, moved = before && (before.x !== token.x || before.y !== token.y);
            if (!entered && !moved) continue;
            if ((record.webFree ?? []).some(entry => entry.actorUuid === member.actorUuid && entry.turn === turnKey)) continue;
            if (record.webPending.includes(member.actorUuid)) continue;
            record.webPending.push(member.actorUuid);
            const statistic = web.statistic[0].toUpperCase() + web.statistic.slice(1);
            await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), flags: { [MODULE_ID]: { webCheck: { castId: record.castId, actorUuid: member.actorUuid } } },
                content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(record.name)} — ${escapeHTML(member.name)}</strong></header><p>${escapeHTML(member.name)} ${entered ? "entered the web" : "moves in the web"}: an Athletics check or a ${statistic} save against DC ${escapeHTML(record.dc)} (its choice).</p><button type="button" class="pf2e-auto-web-check" data-stat="${web.skill}"><i class="fa-solid fa-person-running"></i> Athletics</button><button type="button" class="pf2e-auto-web-check" data-stat="${web.statistic}"><i class="fa-solid fa-shield-halved"></i> ${statistic}</button></section>` });
        }
        record.webSeen = now;
    }
    /** The check: the outcome's penalty (lost on leaving the web), Immobilized then the penalty, or freedom for the turn on a critical success. */
    async webCheck({ castId, actorUuid, stat }, user = game.user) {
        const journal = this.ongoing.find(castId);
        const record = journal ? clone(state(journal)) : null;
        const web = record?.declaration?.web;
        if (!web || record.status !== "active") throw Error("The web is gone.");
        const actor = await fromUuid(actorUuid);
        if (!actor) throw Error("The creature is gone.");
        if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw Error("You don't control this creature.");
        if (![web.skill, web.statistic].includes(stat)) throw Error("Choose Athletics or the save.");
        const statistic = stat === web.skill ? actor.skills?.[stat] : actor.saves?.[stat];
        const roll = await statistic?.roll({ dc: { value: Number(record.dc) }, skipDialog: true });
        const degree = roll?.degreeOfSuccess;
        if (!Number.isInteger(degree)) throw Error(`${actor.name}'s check wasn't rolled.`);
        record.webPending = (record.webPending ?? []).filter(uuid => uuid !== actorUuid);
        const start = { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null };
        const penalty = rounds => ({ name: `${record.name}: −${web.penalty}-foot Speeds`, type: "effect", img: "icons/svg/net.svg", flags: { [MODULE_ID]: { leaveArea: { castId } } },
            system: { duration: { value: rounds, unit: "rounds", expiry: "turn-start", sustained: false }, start, tokenIcon: { show: true },
                rules: [{ key: "FlatModifier", selector: "all-speeds", type: "circumstance", value: -web.penalty, label: record.name }] } });
        const made = [];
        if (degree === 3) record.webFree = [...(record.webFree ?? []), { actorUuid, turn: `${game.combat?.id ?? "none"}:${game.combat?.round ?? 0}:${game.combat?.turn ?? 0}` }];
        if (degree === 1) made.push(...await actor.createEmbeddedDocuments("Item", [penalty(1)]));
        if (degree === 0) made.push(...await actor.createEmbeddedDocuments("Item", [
            { name: `${record.name}: immobilized`, type: "effect", img: "icons/svg/net.svg", flags: { [MODULE_ID]: { webImmobilized: { castId } } },
                system: { duration: { value: 1, unit: "rounds", expiry: "turn-start", sustained: false }, start, tokenIcon: { show: true },
                    rules: [{ key: "GrantItem", uuid: web.immobilized, flag: "webImmobilized", allowDuplicate: true, onDeleteActions: { granter: "cascade", grantee: "cascade" } }] } },
            // (Then the penalty for its round after: it lasts through both — moot while it's immobilized.)
            penalty(1 + web.afterRounds)]));
        for (const effect of made) record.entries.push({ uuid: effect.uuid, actorUuid, status: "active", permanent: false });
        await this.ongoing.save(journal, record);
        return { degree: ["criticalFailure", "failure", "success", "criticalSuccess"][degree], stat };
    }
    /**
     * Radiant Field: a placed lingering area with a light; creatures with Light Blindness inside are blinded by it (once), and the start of each
     * of their turns while blinded by it (inside, or anywhere from the heightened rank) brings their save card.
     */
    async startRadiantField({ spellName, sourceActorUuid, sourceItemUuid, castRank, dc, region, durationSeconds, field }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const heightened = castRank >= field.fromRank.rank;
        const declaration = { centre: "placed", events: [], oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: heightened && field.fromRank.concealed,
            area: clone(field.area), sustained: false, durationSeconds, notes: field.notes, sourceText: [], radiant: { ...clone(field), castRank, outside: heightened && field.fromRank.outside } };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, regionUuid: region.uuid,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round, radiantExposed: [], radiantAsked: [] };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.entries.push({ uuid: region.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        // "You create an area of bright light.": a light on the area's centre, its radius the burst's.
        const shape = region.shapes?.[0] ?? region.shapes?.contents?.[0];
        const bounds = region.object?.bounds ?? null;
        const centre = shape?.type === "circle" ? { x: shape.x, y: shape.y } : bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : null;
        if (centre) {
            const [light] = await canvas.scene.createEmbeddedDocuments("AmbientLight", [{ x: centre.x, y: centre.y, config: { bright: field.area.value, dim: field.area.value }, flags: { [MODULE_ID]: { radiantLight: record.castId } } }]);
            data.entries.push({ uuid: light.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        }
        const members = await this.lingeringMembership(data) ?? [];
        data.members = members.map(member => member.tokenUuid);
        await this.syncLingeringConcealment(data, members);
        await this.syncRadiant(data, members);
        if (field.notes.length) await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id),
            content: `<p><strong>${escapeHTML(spellName)}</strong></p>${field.notes.map(note => `<p class="pf2e-auto-gm-reminder">${escapeHTML(note)}</p>`).join("")}${heightened ? `<p class="pf2e-auto-gm-reminder">Creatures inside are Concealed to those outside (the module gives them Concealed); light-blind creatures that can see the field stay subject to it outside.</p>` : ""}` });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId, exposed: [...data.radiantExposed] };
    }
    /** A creature with Light Blindness in the field the first time: blinded by it (its ability: until the end of its next turn). */
    async syncRadiant(record, members) {
        const radiant = record.declaration?.radiant;
        if (!radiant) return;
        record.radiantExposed = Array.isArray(record.radiantExposed) ? record.radiantExposed : [];
        for (const member of members) {
            if (record.radiantExposed.includes(member.actorUuid)) continue;
            const actor = await fromUuid(member.actorUuid);
            if (!hasLightBlindness(actor, radiant.ability)) continue;
            record.radiantExposed.push(member.actorUuid);
            await this.radiantBlind(record, actor, { value: 1, unit: "rounds", expiry: "turn-end" });
        }
    }
    async radiantBlind(record, actor, duration) {
        for (const effect of (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.radiantBlind?.castId === record.castId)) await effect.delete();
        const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: blinded (light blindness)`, type: "effect", img: "icons/svg/blind.svg",
            flags: { [MODULE_ID]: { radiantBlind: { castId: record.castId } } },
            system: { duration: { ...duration, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                rules: [{ key: "GrantItem", uuid: record.declaration.radiant.blinded, flag: "radiantBlinded", allowDuplicate: true, onDeleteActions: { granter: "cascade", grantee: "cascade" } }] } }]);
        record.entries.push({ uuid: effect.uuid, actorUuid: actor.uuid, status: "active", permanent: false });
        return effect;
    }
    /** The start of a creature's turn: blinded by the field and inside (or anywhere from the heightened rank), its save card. */
    async radiantTurnStart(record, actorUuid, members) {
        const radiant = record.declaration?.radiant;
        if (!radiant || !actorUuid) return;
        const actor = await fromUuid(actorUuid);
        const blind = (actor?.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.radiantBlind?.castId === record.castId && !effect.isExpired);
        if (!blind || (!radiant.outside && !members.some(member => member.actorUuid === actorUuid))) return;
        record.radiantAsked = Array.isArray(record.radiantAsked) ? record.radiantAsked : [];
        const key = `${game.combat?.id ?? "none"}:${game.combat?.round ?? 0}:${actorUuid}`;
        if (record.radiantAsked.includes(key)) return;
        record.radiantAsked.push(key);
        const statistic = radiant.statistic[0].toUpperCase() + radiant.statistic.slice(1);
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), flags: { [MODULE_ID]: { radiantSave: { castId: record.castId, actorUuid } } },
            content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(record.name)} — ${escapeHTML(actor.name)}</strong></header><p>${escapeHTML(actor.name)} starts its turn blinded by the field: a ${statistic} save (DC ${escapeHTML(record.dc)}; incapacitation). On a failure it remains blinded for ${radiant.failRounds} round.</p><button type="button" class="pf2e-auto-radiant-save"><i class="fa-solid fa-dice-d20"></i> Roll ${statistic} (DC ${escapeHTML(record.dc)})</button></section>` });
    }
    /** The save at the start of its turn (incapacitation: one degree better for a creature above twice the spell's rank); a failure keeps it blinded. */
    async radiantSave({ castId, actorUuid }, user = game.user) {
        const journal = this.ongoing.find(castId);
        const record = journal ? clone(state(journal)) : null;
        if (!record?.declaration?.radiant || record.status !== "active") throw Error("The spell has ended.");
        const actor = await fromUuid(actorUuid);
        if (!actor) throw Error("The creature is gone.");
        if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw Error("You don't control this creature.");
        const radiant = record.declaration.radiant;
        const roll = await actor.saves?.[radiant.statistic]?.roll({ dc: { value: Number(record.dc) }, skipDialog: true, extraRollOptions: ["incapacitation"] });
        let degree = roll?.degreeOfSuccess;
        if (!Number.isInteger(degree)) throw Error(`${actor.name}'s save wasn't rolled.`);
        const level = Number(actor.level ?? actor.system?.details?.level?.value ?? 0);
        const incapacitated = radiant.incapacitation && level > 2 * Number(radiant.castRank);
        if (incapacitated) degree = Math.min(3, degree + 1);
        const name = ["criticalFailure", "failure", "success", "criticalSuccess"][degree];
        if (degree <= 1) await this.radiantBlind(record, actor, { value: radiant.failRounds, unit: "rounds", expiry: "turn-start" });
        await this.ongoing.save(journal, record);
        return { degree: name, incapacitated };
    }
    /** The creatures in a caster-centred aura of a native record (the caster included): tokens within its radius. */
    async auraCreatures(record, radius) {
        const caster = await fromUuid(record.sourceActorUuid);
        const casterToken = caster?.getActiveTokens?.(true, true)?.[0];
        if (!casterToken) return [];
        return (casterToken.parent?.tokens ?? []).filter(token => token.actor?.isOfType?.("creature") && (token.id === casterToken.id || tokenDistance(casterToken, token) <= radius));
    }
    /**
     * Palm-Held Sun's pulse, when cast and on each Sustain: the void-healing creatures in the aura take the vitality damage, and a card lets the
     * GM target the creatures vulnerable to sunlight for their save.
     */
    /**
     * A cast's timeline (Impending Doom): each of the spell's rounds begins at the caster's turn (the cast's initiative), a round after the cast's world
     * time; as each begins, the affected targets' conditions for it (a valued one raised to its value, the others an Effect that lasts the cast); when the
     * duration's last round is over, the damage rolled once and dealt to each target at its multiplier (half rounded down), and the cast ends.
     */
    async reconcileTimeline(journal) {
        let record = clone(state(journal));
        const timeline = record.timeline;
        if (!timeline || timeline.ended || record.status !== "active") return;
        const combat = game.combat;
        const begun = round => {
            const at = timeline.start + 6 * (round - 1), now = game.time?.worldTime ?? 0;
            if (round <= 1 || now > at) return true;
            if (now < at) return false;
            if (!combat?.started || timeline.initiative == null) return true;
            const current = combat.combatant?.initiative;
            return current != null && current <= timeline.initiative;
        };
        for (const [targetIndex, target] of timeline.targets.entries()) for (const [stepIndex, step] of target.steps.entries()) {
            if (step.done || !begun(step.round)) continue;
            // (At most once: recorded before it's applied.)
            record = clone(state(journal));
            record.timeline.targets[targetIndex].steps[stepIndex].done = true;
            await this.ongoing.save(journal, record);
            const actor = await fromUuid(target.actorUuid);
            if (!actor) continue;
            for (const condition of step.conditions) {
                const template = game.pf2e?.ConditionManager?.getCondition(condition.slug);
                // Like a save row's condition: an Effect granting it for the cast (Frightened decays at the end of its turns, Stunned's action loss is
                // reminded — the save rows' recovery), so the same condition from a row and a later round behave alike.
                const label = `${condition.name}${condition.value ? ` ${condition.value}` : ""}`;
                const recovery = condition.slug === "frightened" ? { recovery: "frightened" } : condition.slug === "stunned" ? { recovery: "stunned-actions" } : {};
                const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${label}`, type: "effect",
                    img: template?.img ?? "icons/svg/aura.svg",
                    flags: { [MODULE_ID]: { outcomeEffect: { castId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemUuid: record.sourceItemUuid,
                        sourceItemName: record.name, conditions: [{ slug: condition.slug, label, ruleFlag: "timelineCondition", ...recovery }], timelineRound: step.round } } },
                    system: { description: { value: `<p>${escapeHTML(label)} from <strong>${escapeHTML(record.name)}</strong> from its round ${step.round}, until the spell ends.</p>` },
                        duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, fromSpell: true, level: { value: Number(record.rank ?? 1) },
                        start: { value: game.time.worldTime, initiative: combat?.combatant?.initiative ?? null },
                        rules: [{ key: "GrantItem", uuid: condition.uuid, flag: "timelineCondition", allowDuplicate: true, onDeleteActions: { grantee: "cascade" },
                            ...(condition.value ? { alterations: [{ mode: "override", property: "badge-value", value: condition.value }] } : {}) }] } }]);
                await this.ongoing.attach(journal, effect);
            }
        }
        record = clone(state(journal));
        if (!begun(record.timeline.rounds + 1)) return;
        record.timeline.ended = true;
        await this.ongoing.save(journal, record);
        const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
        const caster = await fromUuid(record.sourceActorUuid), spell = (await castSpellFromUuid(record)) ?? undefined;
        const roll = await new DamageRoll(`{${record.timeline.formula}[${record.timeline.damageType}]}`).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `${escapeHTML(record.name)}: the doom arrives` });
        const dealt = [];
        for (const target of record.timeline.targets) {
            const actor = await fromUuid(target.actorUuid);
            if (!actor) continue;
            const token = target.tokenUuid ? await fromUuid(target.tokenUuid) : null;
            const amount = Math.floor(roll.total * target.multiplier);
            const part = await new DamageRoll(`{${amount}[${record.timeline.damageType}]}`).evaluate();
            await applyDamageWithReceipt(actor, { damage: part, token: token ?? undefined, item: spell, rollOptions: new Set(), skipIWR: false }, randomID());
            dealt.push({ actorUuid: target.actorUuid, amount });
        }
        record = clone(state(journal));
        record.timeline.dealt = { total: roll.total, formula: roll.formula, targets: dealt };
        await this.ongoing.save(journal, record);
        await this.ongoing.end(journal, { reason: "maximum-duration" });
    }

    async sunPulse(castId) {
        const journal = this.ongoing.find(castId);
        const record = journal ? state(journal) : null;
        const sun = record?.sunAura;
        if (!sun || record.status !== "active") return null;
        const caster = await fromUuid(record.sourceActorUuid);
        const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
        const harmed = [];
        for (const token of await this.auraCreatures(record, sun.radius)) {
            const actor = token.actor;
            if (!(actor.attributes?.hp?.negativeHealing ?? actor.system?.attributes?.hp?.negativeHealing)) continue;
            const roll = await new DamageRoll(`{${sun.voidHealing.damage}[${sun.voidHealing.type}]}`).evaluate();
            await applyDamageWithReceipt(actor, { damage: roll, token, item: (await castSpellFromUuid(record)) ?? undefined, rollOptions: new Set(["area-damage"]), skipIWR: false }, randomID());
            harmed.push(actor.name);
        }
        const statistic = sun.sunlight.statistic[0].toUpperCase() + sun.sunlight.statistic.slice(1);
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), flags: { [MODULE_ID]: { sunSunlight: { castId, round: game.combat?.round ?? null } } },
            content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(record.name)}</strong></header><p>${harmed.length ? `${harmed.map(name => escapeHTML(name)).join(", ")} (void healing) took ${sun.voidHealing.damage} ${sun.voidHealing.type} damage.` : "No creature with void healing is in the aura."}</p><p class="pf2e-auto-gm-reminder"><strong>GM:</strong> target the creatures in the aura with a particular vulnerability to sunlight (PF2e can't tell), then: a ${statistic} save or ${escapeHTML(sun.sunlight.condition)} ${sun.sunlight.value} for ${sun.sunlight.rounds} round.</p><button type="button" class="pf2e-auto-sun-sunlight"><i class="fa-solid fa-sun"></i> Sunlight save for the targeted creatures</button></section>` }); }
        catch (error) { console.warn(`${MODULE_ID} | The pulse card could not be posted.`, error); }
        return { harmed };
    }
    /** A placed area's damage to every creature in it at once (Shadow Puppetry: when cast and on the first Sustain each turn). */
    async areaPulse(castId) {
        const journal = this.ongoing.find(castId);
        const record = journal ? clone(state(journal)) : null;
        if (!record?.declaration?.hazardDamage || record.status !== "active") return null;
        const members = await this.lingeringMembership(record) ?? [];
        const results = [];
        for (const member of members) {
            const result = await this.applyHazardDamage(record, member, "pulse");
            record.exposure.push({ key: `pulse:${randomID()}:${member.actorUuid}`, event: "pulse", actorUuid: member.actorUuid, total: result.total });
            results.push({ name: member.name, total: result.total });
        }
        record.pulses = [...(record.pulses ?? []), { at: game.time.worldTime, round: game.combat?.round ?? null, results }];
        await this.ongoing.save(journal, record);
        return { results };
    }
    /** The sunlight save for the creatures the GM targeted (inside the aura): the compiled save card at the spell's DC. */
    async sunSunlight({ castId, tokenUuids = [] }, user = game.user) {
        if (!user.isGM) throw Error("The GM decides which creatures are vulnerable to sunlight.");
        const journal = this.ongoing.find(castId);
        const record = journal ? state(journal) : null;
        if (!record?.sunAura || record.status !== "active") throw Error("The spell has ended.");
        const inside = new Set((await this.auraCreatures(record, record.sunAura.radius)).map(token => token.uuid));
        const tokens = (await Promise.all(tokenUuids.map(uuid => fromUuid(uuid)))).filter(token => token?.actor);
        if (!tokens.length) throw Error("Target the creatures vulnerable to sunlight first.");
        const outside = tokens.filter(token => !inside.has(token.uuid));
        if (outside.length) throw Error(`${outside.map(token => token.name).join(", ")} ${outside.length === 1 ? "isn't" : "aren't"} in the aura.`);
        const caster = await fromUuid(record.sourceActorUuid), spell = await castSpellFromUuid(record);
        const started = await this.saves.start(spell, { plan: record.sunAura.sunlightPlan, sourceActor: caster, targets: tokens.map(token => token.object ?? token), castRank: record.castRank ?? record.rank,
            dc: record.dc, skipConfirmation: true });
        return { cardId: started?.card?.id ?? null };
    }
    /** "After a creature in the aura loses HP due to fire damage from any source, it takes 1 vitality damage." */
    async sunFire({ actorUuid }) {
        const actor = await fromUuid(actorUuid);
        if (!actor) return null;
        const applied = [];
        for (const journal of this.ongoing.records()) {
            const record = state(journal);
            if (record?.status !== "active" || !record.sunAura) continue;
            const token = (await this.auraCreatures(record, record.sunAura.radius)).find(entry => entry.actor === actor);
            if (!token) continue;
            const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
            const roll = await new DamageRoll(`{${record.sunAura.fire.damage}[${record.sunAura.fire.type}]}`).evaluate();
            // (PF2e decides what vitality does to it: nothing to a living creature.)
            const before = Number(actor.hitPoints?.value ?? 0);
            await actor.applyDamage({ damage: roll, token, item: (await castSpellFromUuid(record)) ?? undefined });
            applied.push({ castId: record.castId, damage: before - Number(actor.hitPoints?.value ?? 0) });
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), content: `<p><strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} lost Hit Points to fire damage in the aura and takes ${record.sunAura.fire.damage} ${record.sunAura.fire.type} damage.</p>` }); } catch (_) {}
        }
        return { applied };
    }
    /**
     * An emanation whose save each creature makes once, the outcome holding while it's inside (Reaper's Lantern): a lingering record centred
     * on the caster with an optional growing Sustain; its light is an Effect on the caster; `syncLantern` asks the creatures that haven't saved
     * (a card each) and keeps the failed ones' Effects while they're inside.
     */
    async startLanternAura({ spellName, sourceActorUuid, sourceItemUuid, castRank, dc, radius, durationSeconds, lantern }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const declaration = { centre: "caster", events: [], oncePerRound: false, excludeCaster: true, enemiesOnly: false, initial: false, concealment: false,
            area: { type: "emanation", value: Number(radius) }, sustained: lantern.sustained === true, ...(lantern.growth ? { optionalSustain: true, growth: { feet: lantern.growth.feet } } : {}), durationSeconds, sourceText: [],
            // (Or the degree table's rows, each an Effect held while inside — Infinitesimal Collapse Field, Repulsion; enemies only when the text says so.)
            lantern: { statistic: lantern.statistic, ...(lantern.rows ? { rows: lantern.rows, enemiesOnly: lantern.enemiesOnly === true } : { failed: lantern.failed }), light: lantern.light ?? null,
                // (Pied Piping: the rows' Effects last for the spell wherever the creature goes; a save makes it immune for a while.)
                ...(lantern.heldOutside ? { heldOutside: true } : {}), ...(lantern.immunity ? { immunity: { ...lantern.immunity, key: `${spellName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:saved` } } : {}) } };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round,
            lanternOutcomes: [], lanternAsked: [], ...(lantern.dismissible ? { dismissal: { authority: "source-actor", scope: "cast", action: "Dismiss" } } : {}) };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        const caster = await fromUuid(sourceActorUuid);
        if (lantern.light) {
            const [light] = await caster.createEmbeddedDocuments("Item", [{ name: `${spellName} (light)`, type: "effect", img: "icons/svg/light.svg",
                flags: { [MODULE_ID]: { lanternLight: { castId: record.castId } } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: false }, rules: [lanternLightRule(radius, lantern.light)] } }]);
            data.entries.push({ uuid: light.uuid, actorUuid: sourceActorUuid, status: "active", permanent: false });
        }
        const members = await this.lingeringMembership(data) ?? [];
        data.members = members.map(member => member.tokenUuid);
        await this.syncLantern(data, members);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", castId: record.castId, asked: [...data.lanternAsked] };
    }
    /** The creatures inside: a save card for each living or undead one that hasn't saved; the failed ones' Effects while inside. */
    async syncLantern(record, members) {
        const lantern = record.declaration?.lantern;
        if (!lantern) return;
        record.lanternOutcomes = Array.isArray(record.lanternOutcomes) ? record.lanternOutcomes : [];
        record.lanternAsked = Array.isArray(record.lanternAsked) ? record.lanternAsked : [];
        const caster = await fromUuid(record.sourceActorUuid);
        for (const member of members) {
            const actor = await fromUuid(member.actorUuid);
            const mode = lantern.rows ? (actor && actor !== caster && !(lantern.enemiesOnly && caster?.isAllyOf?.(actor)) ? "rows" : null) : lanternMode(actor);
            if (!mode) continue;
            const outcome = record.lanternOutcomes.find(entry => entry.actorUuid === member.actorUuid);
            if (!outcome) {
                if (record.lanternAsked.includes(member.actorUuid)) continue;
                // (Immune after an earlier save against this spell: not asked.)
                if (lantern.immunity && (actor.itemTypes?.effect ?? []).some(effect => !effect.isExpired && effect.flags?.[MODULE_ID]?.spellImmunity?.key === lantern.immunity.key)) continue;
                record.lanternAsked.push(member.actorUuid);
                const statistic = lantern.statistic[0].toUpperCase() + lantern.statistic.slice(1);
                try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), flags: { [MODULE_ID]: { lanternSave: { castId: record.castId, actorUuid: member.actorUuid } } },
                    content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(record.name)} — ${escapeHTML(actor.name)}</strong></header><p>${escapeHTML(actor.name)} is in the area: a ${statistic} save against DC ${escapeHTML(record.dc)} (once for this casting).</p><button type="button" class="pf2e-auto-lantern-save"><i class="fa-solid fa-dice-d20"></i> Roll ${statistic} (DC ${escapeHTML(record.dc)})</button></section>` }); }
                catch (error) { console.warn(`${MODULE_ID} | The save card could not be posted.`, error); }
                continue;
            }
            const row = mode === "rows" ? lantern.rows[outcome.degree] : null;
            if (mode === "rows" ? !row : !["failure", "criticalFailure"].includes(outcome.degree)) continue;
            if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.leaveArea?.castId === record.castId)) continue;
            // (Kept outside the area: given once, never again after it ends — a hostile action, the GM.)
            record.lanternApplied = Array.isArray(record.lanternApplied) ? record.lanternApplied : [];
            if (lantern.heldOutside && record.lanternApplied.includes(member.actorUuid)) continue;
            const failed = mode === "rows" ? null : lantern.failed[mode];
            const named = condition => `${condition.slug[0].toUpperCase()}${condition.slug.slice(1)}${condition.value ? ` ${condition.value}` : ""}`;
            const source = mode === "rows"
                ? { name: `${record.name}: ${row.conditions.length ? row.conditions.map(named).join(", ") : row.label}`, type: "effect", img: row.conditions.length ? "icons/svg/downgrade.svg" : "icons/svg/book.svg",
                    flags: { [MODULE_ID]: lantern.heldOutside ? { areaLifetime: { castId: record.castId } } : { leaveArea: { castId: record.castId } } },
                    system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true },
                        rules: row.conditions.map(condition => ({ key: "GrantItem", uuid: condition.uuid, flag: `lantern${condition.slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^./, c => c.toUpperCase())}`,
                            allowDuplicate: true, onDeleteActions: { granter: "cascade", grantee: "cascade" }, ...(condition.value ? { alterations: [{ mode: "override", property: "badge-value", value: condition.value }] } : {}) })),
                        description: { value: `<p>${escapeHTML(row.label)} against ${escapeHTML(record.name)}${lantern.heldOutside ? " (for the spell's duration)" : ", while within its area"}${row.conditions.length ? `: ${escapeHTML(row.conditions.map(named).join(", "))}` : ""}.</p>${row.notes.map(note => `<p>${escapeHTML(note)}</p>`).join("")}` } } }
                : mode === "living"
                ? { name: `${record.name}: half healing`, type: "effect", img: "icons/svg/degen.svg", flags: { [MODULE_ID]: { leaveArea: { castId: record.castId }, halfHealing: { castId: record.castId } } },
                    system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true }, rules: [],
                        description: { value: `<p>While within ${escapeHTML(record.name)}, this creature gains only half the normal benefit from healing effects (the module halves it).</p>` } } }
                : { name: `${record.name}: ${failed.condition} ${failed.value}`, type: "effect", img: "icons/svg/downgrade.svg", flags: { [MODULE_ID]: { leaveArea: { castId: record.castId } } },
                    system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true },
                        rules: [{ key: "GrantItem", uuid: /@UUID\[([^\]]+)\]/.exec(failed.link)[1], flag: "lanternCondition", allowDuplicate: true, onDeleteActions: { granter: "cascade", grantee: "cascade" },
                            alterations: [{ mode: "override", property: "badge-value", value: failed.value }] }],
                        description: { value: `<p>${escapeHTML(failed.condition[0].toUpperCase() + failed.condition.slice(1))} ${failed.value} while within ${escapeHTML(record.name)}.</p>` } } };
            const [effect] = await actor.createEmbeddedDocuments("Item", [source]);
            record.entries.push({ uuid: effect.uuid, actorUuid: member.actorUuid, status: "active", permanent: false });
            record.recipientUuids = [...new Set([...(record.recipientUuids ?? []), member.actorUuid])];
            if (lantern.heldOutside) record.lanternApplied.push(member.actorUuid);
            // ("The target gains the minion trait and is controlled by you": the caster's players own it while the Effect lasts.)
            if (row?.minion) await grantMinionControl(effect, actor, record.sourceActorUuid);
        }
    }
    /** A creature's save against the lantern (the card): rolled against the spell DC, kept for the cast, its Effect if inside. */
    async lanternSave({ castId, actorUuid }, user = game.user) {
        const journal = this.ongoing.find(castId);
        const record = journal ? clone(state(journal)) : null;
        if (!record || record.status !== "active") throw Error("The spell has ended.");
        const actor = await fromUuid(actorUuid);
        if (!actor) throw Error("The creature is gone.");
        if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw Error("You don't control this creature.");
        if ((record.lanternOutcomes ?? []).some(entry => entry.actorUuid === actorUuid)) throw Error(`${actor.name} already saved against ${record.name}.`);
        const statistic = actor.saves?.[record.declaration.lantern.statistic];
        if (!statistic) throw Error(`${actor.name} has no ${record.declaration.lantern.statistic} save.`);
        const caster = await fromUuid(record.sourceActorUuid), spell = await castSpellFromUuid(record);
        const roll = await statistic.roll({ dc: { value: Number(record.dc) }, skipDialog: true, ...(spell ? { item: spell, origin: caster } : {}) });
        const degree = ["criticalFailure", "failure", "success", "criticalSuccess"][roll?.degreeOfSuccess ?? -1];
        if (!degree) throw Error(`${actor.name}'s save wasn't rolled.`);
        record.lanternOutcomes = [...(record.lanternOutcomes ?? []), { actorUuid, degree }];
        // ("after which they become temporarily immune for 1 day")
        const immunity = record.declaration.lantern.immunity;
        if (immunity) {
            const [marker] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: immune`, type: "effect", img: "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { spellImmunity: { key: immunity.key } } },
                system: { description: { value: `<p>Temporarily immune to ${escapeHTML(record.name)}.</p>` }, level: { value: record.rank }, tokenIcon: { show: false },
                    duration: { value: immunity.value, unit: immunity.unit, expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, rules: [] } }]);
            record.immunityMarkers = [...(record.immunityMarkers ?? []), marker.uuid];
        }
        const members = await this.lingeringMembership(record) ?? [];
        await this.syncLantern(record, members);
        await this.ongoing.save(journal, record);
        return { degree, total: roll.total };
    }
    /** The Escape a sustained dance offers (Coiling Dance): a card whose button the targeted ally inside uses. */
    async postEscapePrompt(record) {
        const prompt = record.declaration.escapePrompt;
        const caster = await fromUuid(record.sourceActorUuid);
        const skills = prompt.skills.map(skill => skill[0].toUpperCase() + skill.slice(1)).join(" or ");
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), flags: { [MODULE_ID]: { escapePrompt: { castId: record.castId, used: false } } },
            content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(record.name)} — Escape</strong></header><p>An ally in the area that's ${prompt.conditions.join(", ")} can use its reaction to Escape, with ${escapeHTML(caster?.name ?? "the caster")}'s ${escapeHTML(skills)} modifier if that's better. Select the ally (and target the creature holding it, for its DC), then:</p><button type="button" class="pf2e-auto-escape-prompt"><i class="fa-solid fa-person-running"></i> Escape (reaction)</button></section>` }); }
        catch (error) { console.warn(`${MODULE_ID} | The Escape card could not be posted.`, error); }
    }
    /** The targeted ally's Escape: inside the area, an ally of the caster, with one of the conditions; its best modifier raised to the caster's. */
    async escapePrompt(message, { tokenUuid } = {}) {
        const flag = message?.getFlag?.(MODULE_ID, "escapePrompt");
        if (!flag) throw Error("This card has no Escape.");
        if (flag.used) throw Error("This Escape was already used.");
        const journal = this.ongoing.find(flag.castId);
        const record = journal ? state(journal) : null;
        if (!record || record.status !== "active") throw Error("The spell has ended.");
        const prompt = record.declaration.escapePrompt;
        const token = await fromUuid(tokenUuid);
        const ally = token?.actor, caster = await fromUuid(record.sourceActorUuid);
        if (!ally) throw Error(`${record.name}: select the ally first.`);
        if (ally === caster || !caster?.isAllyOf?.(ally)) throw Error(`${record.name}: ${ally.name} isn't one of ${caster?.name ?? "the caster"}'s allies.`);
        const members = await this.lingeringMembership(record) ?? [];
        if (!members.some(member => member.actorUuid === ally.uuid)) throw Error(`${record.name}: ${ally.name} isn't in the area.`);
        const held = prompt.conditions.filter(slug => ally.hasCondition?.(slug));
        if (!held.length) throw Error(`${record.name}: ${ally.name} isn't ${prompt.conditions.join(", ")}.`);
        // Its own best (unarmed attack, Acrobatics, Athletics) and the caster's better skill.
        const unarmed = (ally.system?.actions ?? []).filter(action => action.item?.category === "unarmed" || action.item?.system?.category === "unarmed" || (action.traits ?? []).some(trait => (trait.name ?? trait) === "unarmed"))
            .map(action => Number(action.totalModifier ?? action.modifier)).filter(Number.isFinite);
        const own = Math.max(Number(ally.skills?.acrobatics?.mod ?? -99), Number(ally.skills?.athletics?.mod ?? -99), ...unarmed);
        const best = prompt.skills.map(skill => ({ skill, mod: Number(caster.skills?.[skill]?.mod ?? -99) })).sort((a, b) => b.mod - a.mod)[0];
        const raise = best.mod > own ? best.mod - own : 0;
        const modifiers = raise ? [new game.pf2e.Modifier({ label: `${record.name}: ${caster.name}'s ${best.skill[0].toUpperCase() + best.skill.slice(1)}`, slug: "escape-aura", modifier: raise, type: "untyped" })] : [];
        await message.setFlag(MODULE_ID, "escapePrompt", { ...flag, used: true, allyUuid: ally.uuid });
        await game.pf2e.actions.escape({ actors: [ally], modifiers });
        return { ally: ally.name, held, own, caster: best, raise };
    }
    /** A holder's critically successful save against an enemy's effect of the trait: PF2e's critical Effect, for its rounds (the active GM). */
    async memberCriticalSave(message) {
        const context = message?.flags?.pf2e?.context;
        if (context?.type !== "saving-throw" || context.outcome !== "criticalSuccess" || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return null;
        const actor = game.actors.get(context.actor ?? message.speaker?.actor) ?? (message.speaker?.token ? canvas.scene?.tokens.get(message.speaker.token)?.actor : null);
        const held = (actor?.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.leaveArea?.castId);
        if (!held) return null;
        const journal = this.ongoing.find(held.flags[MODULE_ID].leaveArea.castId);
        const record = journal ? state(journal) : null;
        const member = record?.declaration?.memberEffect;
        if (!member?.critical || record.status !== "active") return null;
        const options = new Set(context.options ?? []);
        if (!options.has(`item:trait:${member.trait}`)) return null;
        const origin = context.origin?.actor ? await fromUuid(context.origin.actor) : null;
        const enemy = options.has("origin:enemy") || (origin && origin !== actor && !actor.isAllyOf?.(origin));
        if (!enemy) return null;
        const template = await loadNativeEffectTemplate(member.critical.uuid);
        const rules = template?.system?.rules ?? [];
        if (!(rules.length === 1 && rules[0].key === "FlatModifier" && rules[0].type === "status" && Number(rules[0].value) === member.critical.bonus
            && JSON.stringify([rules[0].selector].flat().sort()) === JSON.stringify(["attack-roll", "damage"]))) throw Error(`${record.name}: PF2e's ${member.critical.label} no longer gives the stated bonus.`);
        const source = prepareNativeEffectSource(template, { castInstanceId: record.castId, castRank: record.rank, sourceActorUuid: record.sourceActorUuid,
            sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name, resolutionKind: "lingering" });
        source.system.duration = { value: member.critical.rounds, unit: "rounds", expiry: "turn-end", sustained: false };
        const effect = await createNativeEffect(actor, source);
        return { actorUuid: actor.uuid, effectUuid: effect?.uuid ?? null };
    }
    async startTurnEffectAura({ spellName, sourceActorUuid, sourceItemUuid, castRank, dc, area, durationSeconds, turnEffect, auraEffect = null, sustained = true }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        // (A damaging aura — Unblinking Flame Ignition — burns the others, not the caster; it isn't sustained.)
        const declaration = { centre: "caster", events: ["turn-start"], turnEffect, includeCaster: !turnEffect.damage?.excludeCaster, oncePerRound: false, excludeCaster: turnEffect.damage?.excludeCaster === true, enemiesOnly: false, initial: false,
            concealment: false, area: { type: area.type, value: Number(area.value) }, sustained, durationSeconds, sourceText: [] };
        const record = { castId: randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: dc ?? null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round, dismissal: { authority: "source-actor", scope: "cast", action: "Dismiss" } };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.members = (await this.lingeringMembership(data) ?? []).map(member => member.tokenUuid);
        if (auraEffect) data.entries.push({ uuid: auraEffect.uuid, actorUuid: auraEffect.actor.uuid, status: "active", permanent: false });
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", journalId: journal.id, castId: record.castId };
    }
    /** One creature beginning its turn inside: PF2e's Spell Effect with the tradition, if the tradition names it (replacing this cast's earlier one). */
    async applyTurnEffect(record, member) {
        const turnEffect = record.declaration.turnEffect;
        if (turnEffect.drain) return this.applyDrainTurn(record, member);
        // A damaging aura (Unblinking Flame Ignition): the stated damage, no save, to each other creature starting its turn inside.
        if (turnEffect.damage) {
            const actor = await fromUuid(member.actorUuid);
            if (!actor || member.actorUuid === record.sourceActorUuid) return { status: "not-affected" };
            const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
            const roll = await new DamageRoll(turnEffect.damage.formula).evaluate();
            const token = member.tokenUuid ? await fromUuid(member.tokenUuid) : null;
            try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), flavor: `<strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} starts its turn in the aura` }); } catch (_) {}
            await actor.applyDamage({ damage: roll, token: token?.object ?? token ?? undefined, item: (await castSpellFromUuid(record)) ?? undefined });
            return { status: "applied", damage: roll.total };
        }
        // A condition until the end of this turn (Quicken Time's Quickened), replacing this cast's earlier one.
        if (turnEffect.condition) {
            const actor = await fromUuid(member.actorUuid);
            if (!actor) return { status: "missing" };
            // (Only that creature's allies, not itself: Fateful Condemnation's mist.)
            if (turnEffect.alliesOf) { const anchor = await fromUuid(turnEffect.alliesOf); if (!anchor || actor === anchor || !anchor.isAllyOf?.(actor)) return { status: "not-affected", reason: "not an ally" }; }
            const earlier = actor.itemTypes.effect.filter(effect => effect.flags?.[MODULE_ID]?.turnEffectCast === record.castId).map(effect => effect.id);
            if (earlier.length) await actor.deleteEmbeddedDocuments("Item", earlier);
            const condition = turnEffect.condition;
            const [created] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${condition.name}`, type: "effect", img: "icons/svg/clockwork.svg",
                flags: { [MODULE_ID]: { turnEffectCast: record.castId, runtime: { castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemName: record.name } } },
                system: { description: { value: `<p>${escapeHTML(condition.note)}</p>` }, level: { value: record.rank }, tokenIcon: { show: true },
                    duration: { value: 0, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                    rules: [{ key: "GrantItem", uuid: condition.uuid, allowDuplicate: true, flag: "condition", onDeleteActions: { granter: "cascade", grantee: "cascade" } }] } }]);
            return { status: "applied", effectUuid: created?.uuid ?? null };
        }
        const actor = await fromUuid(member.actorUuid), caster = await fromUuid(record.sourceActorUuid);
        if (!actor) return { status: "missing" };
        const who = turnEffect.recipients[turnEffect.tradition];
        const mode = actor.modeOfBeing ?? (actor.traits?.has?.("undead") ? "undead" : actor.traits?.has?.("construct") ? "construct" : "living");
        if (who === "living-or-undead" && !["living", "undead"].includes(mode)) return { status: "not-affected", reason: mode };
        if (who === "allies" && !(actor === caster || caster?.isAllyOf?.(actor))) return { status: "not-affected", reason: "not an ally" };
        const earlier = actor.itemTypes.effect.filter(effect => effect.flags?.[MODULE_ID]?.turnEffectCast === record.castId).map(effect => effect.id);
        if (earlier.length) await actor.deleteEmbeddedDocuments("Item", earlier);
        const template = await loadNativeEffectTemplate(turnEffect.uuid);
        if (!template) throw Error(`${record.name}: PF2e's ${turnEffect.label} is unavailable.`);
        const source = prepareNativeEffectSource(template, { castInstanceId: record.castId, castRank: record.rank, sourceActorUuid: record.sourceActorUuid, sourceItemUuid: record.sourceItemUuid,
            sourceItemName: record.name, resolutionKind: "aura-turn-effect" });
        const rule = source.system?.rules?.[turnEffect.choiceRuleIndex];
        if (rule?.key !== "ChoiceSet") throw Error(`${record.name}: PF2e's tradition choice changed.`);
        rule.selection = turnEffect.tradition;
        // "has Lesser Cover": PF2e's Cover Effect asks for the level, and its GrantItem can't preset an object choice. The module creates the
        // Cover Effect itself with lesser selected, for 1 round (renewed at each turn start inside), instead of the grant.
        const covers = [];
        for (const grant of (source.system?.rules ?? []).filter(entry => entry.key === "GrantItem" && (entry.predicate ?? []).includes(`${rule.rollOption}:${turnEffect.tradition}`))) {
            const granted = await fromUuid(grant.uuid);
            const coverSource = granted?.toObject?.();
            const choice = (coverSource?.system?.rules ?? []).find(entry => entry.key === "ChoiceSet" && Array.isArray(entry.choices));
            const lesser = choice?.choices?.find(entry => entry?.level === "lesser" || entry?.value?.level === "lesser");
            if (!coverSource || !lesser) throw Error(`${record.name}: PF2e's cover Effect couldn't be set to lesser.`);
            delete coverSource._id;
            choice.selection = lesser.value ?? lesser;
            coverSource.system.duration = { value: 1, unit: "rounds", expiry: "turn-start", sustained: false };
            coverSource.system.start = { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null };
            coverSource.flags = { ...(coverSource.flags ?? {}), [MODULE_ID]: { turnEffectCast: record.castId } };
            covers.push(coverSource);
            source.system.rules = source.system.rules.filter(entry => entry !== grant);
        }
        source.flags = { ...(source.flags ?? {}), [MODULE_ID]: { ...(source.flags?.[MODULE_ID] ?? {}), turnEffectCast: record.castId,
            // "… or until it Escapes": an Escape against the spell DC ends it.
            ...(turnEffect.escapeEnds.includes(turnEffect.tradition) && Number.isFinite(Number(record.dc)) ? { outcomeEffect: { castId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemUuid: record.sourceItemUuid,
                sourceItemName: record.name, conditions: [], escape: { dc: Number(record.dc), event: "escape", expirationMode: "first" } } } : {}) } };
        const created = await createNativeEffect(actor, source);
        if (covers.length) await actor.createEmbeddedDocuments("Item", covers);
        return { status: "applied", effectUuid: created?.uuid ?? null, cover: covers.length > 0 };
    }
    /**
     * A healing pulse (Garden of Healing): a sustained emanation on the caster that heals each creature inside when cast and on the first
     * Sustain each round, except creatures still holding the spell's after-Effect (from an earlier casting). When it ends, each creature it
     * healed gets PF2e's Effect.
     */
    async startHealingPulse({ spellName, sourceActorUuid, sourceItemUuid, castRank, formula, area, durationSeconds, afterEffect, castId = null }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        // The Effect's own uuid too: a copy dragged from the compendium carries that, not the name-keyed link.
        const template = await loadNativeEffectTemplate(afterEffect.uuid);
        afterEffect = { ...afterEffect, resolvedUuid: template.uuid, label: afterEffect.label ?? template.name };
        const declaration = { centre: "caster", events: [], healingPulse: { formula, afterEffect, includeCaster: true },
            oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: true, concealment: false, area: { type: area.type, value: Number(area.value) }, sustained: true, durationSeconds, sourceText: [] };
        const record = { castId: castId ?? randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null, healedActorUuids: [],
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round,
            dismissal: { authority: "source-actor", scope: "cast", action: "Dismiss" } };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        data.members = (await this.lingeringMembership(data) ?? []).map(member => member.tokenUuid);
        // "When you cast this spell …": the first pulse now.
        const first = await this.pulseHealing(data);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", journalId: journal.id, castId: record.castId, first };
    }
    /**
     * A self pulse (Gloom Mantle): a sustained record on the caster whose Effect grants the condition until the end of the caster's next turn, made when cast
     * and again the first time each round the spell is Sustained (the newest replaces the last).
     */
    async startSelfPulse({ spellName, sourceActorUuid, sourceItemUuid, castRank, durationSeconds, selfPulse, castId = null }) {
        this.ongoing.assertCoordinator();
        const clock = this.ongoing.clock();
        const declaration = { centre: "caster", events: [], selfPulse: clone(selfPulse), oncePerRound: false, excludeCaster: false, enemiesOnly: false, initial: false, concealment: false,
            area: { type: "emanation", value: 0 }, sustained: true, durationSeconds, sourceText: [] };
        const record = { castId: castId ?? randomID(), name: spellName, kind: "lingering", sourceActorUuid, sourceItemUuid, rank: castRank, dc: null,
            recipientUuids: [], recipients: [], exposure: [], members: [], declaration, exposurePlan: null,
            maximumAt: game.time.worldTime + durationSeconds, castRound: clock.round, dismissal: { authority: "source-actor", scope: "cast", action: "Dismiss" } };
        const journal = await this.ongoing.begin(record);
        const data = clone(state(journal));
        const first = await this.applySelfPulse(data);
        await this.ongoing.save(journal, data);
        await this.ongoing.activate(journal);
        return { status: "started", journalId: journal.id, castId: record.castId, effectUuid: first?.uuid ?? null };
    }
    /** The caster's Effect for the self pulse: the condition until the end of its next turn, and the note; an earlier one of this cast goes. */
    async applySelfPulse(record) {
        const pulse = record.declaration.selfPulse;
        const caster = await fromUuid(record.sourceActorUuid);
        if (!caster) throw Error(`${record.name}: the caster is gone.`);
        const old = (caster.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.selfPulse?.castId === record.castId).map(effect => effect.id);
        if (old.length) await caster.deleteEmbeddedDocuments("Item", old);
        const [effect] = await caster.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${pulse.condition.name}`, type: "effect", img: "icons/magic/perception/shadow-stealth-eyes-purple.webp",
            flags: { [MODULE_ID]: { selfPulse: { castId: record.castId } } },
            system: { description: { value: `<p>${escapeHTML(pulse.condition.name)} until the end of your next turn.</p><p class="pf2e-auto-gm-reminder">${escapeHTML(pulse.note)}</p>` },
                duration: { value: 1, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                rules: [{ key: "GrantItem", uuid: pulse.condition.uuid, onDeleteActions: { grantee: "restrict" } }], tokenIcon: { show: true }, traits: { value: [] } } }]);
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(caster.name)} is ${escapeHTML(pulse.condition.slug)} until the end of its next turn. ${escapeHTML(pulse.note)}</p>` }); } catch (_) {}
        return effect ?? null;
    }
    /** Whether the actor holds the pulse's after-Effect (from any casting). */
    static holdsPulseEffect(actor, afterEffect) {
        const uuids = [afterEffect.uuid, afterEffect.resolvedUuid].filter(Boolean);
        return (actor?.itemTypes?.effect ?? []).some(effect => [effect._stats?.compendiumSource, effect._stats?.duplicateSource, effect.sourceId, effect.flags?.core?.sourceId].some(uuid => uuids.includes(uuid)));
    }
    /** One pulse: a single healing roll, applied to each creature inside (the caster too) that doesn't hold the after-Effect. Records who was healed. */
    async pulseHealing(record) {
        const pulse = record.declaration.healingPulse;
        const members = await this.lingeringMembership(record);
        if (!members) throw Error(`${record.name}: the emanation's membership can't be determined on the active scene.`);
        const caster = await fromUuid(record.sourceActorUuid);
        const casterToken = caster?.getActiveTokens?.()?.[0]?.document;
        if (pulse.includeCaster && casterToken && !members.some(member => member.actorUuid === caster.uuid)) members.unshift({ actorUuid: caster.uuid, tokenUuid: casterToken.uuid, name: casterToken.name });
        const healed = [], skipped = [];
        let roll = null;
        for (const member of members) {
            const actor = await fromUuid(member.actorUuid);
            if (!actor) continue;
            if (OngoingFamilies.holdsPulseEffect(actor, pulse.afterEffect)) { skipped.push(member.name); continue; }
            roll ??= await new Roll(String(pulse.formula)).evaluate();
            const wasDying = isDying(actor);
            const token = await fromUuid(member.tokenUuid);
            await applyDamageWithReceipt(actor, { damage: -roll.total, token: token ?? undefined, item: (await castSpellFromUuid(record)) ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            await recoverFromDying(actor, wasDying);
            healed.push(member.name);
            if (!record.healedActorUuids.includes(actor.uuid)) record.healedActorUuids.push(actor.uuid);
        }
        const content = `<p><strong>${escapeHTML(record.name)}</strong>: ${healed.length ? `${healed.map(name => escapeHTML(name)).join(", ")} regain${healed.length === 1 ? "s" : ""} ${roll.total} Hit Points` : "no creature in the emanation is healed"}.</p>`
            + (skipped.length ? `<p>${skipped.map(name => escapeHTML(name)).join(", ")}: still under ${escapeHTML(pulse.afterEffect.label ?? "the spell's Effect")}, so not healed by another casting.</p>` : "");
        try {
            if (roll) await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: content, flags: { [MODULE_ID]: { kind: "healing-pulse", castId: record.castId } } });
            else await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content, flags: { [MODULE_ID]: { kind: "healing-pulse", castId: record.castId } } });
        } catch (_) {}
        return { total: roll?.total ?? 0, healed, skipped };
    }
    /** When the spell ends: PF2e's after-Effect on each creature the pulses healed (once per cast). */
    async applyPulseAfterEffect(record) {
        const pulse = record.declaration.healingPulse;
        let template = null;
        for (const actorUuid of record.healedActorUuids ?? []) {
            const actor = await fromUuid(actorUuid);
            if (!actor || (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.runtime?.castInstanceId === record.castId && effect.flags?.[MODULE_ID]?.runtime?.resolutionKind === "healing-pulse")) continue;
            template ??= await loadNativeEffectTemplate(pulse.afterEffect.resolvedUuid ?? pulse.afterEffect.uuid);
            const source = prepareNativeEffectSource(template, { castInstanceId: record.castId, castRank: record.rank, sourceActorUuid: record.sourceActorUuid,
                sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name, resolutionKind: "healing-pulse", targetActorUuid: actorUuid });
            source.system.start = { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null };
            await createNativeEffect(actor, source);
        }
    }
    /** The hazard's damage on one creature: PF2e's damage roll at the cast rank, applied with its IWR, and a chat card. */
    /** Each creature this spell holds (its outcome Effect's Grabbed or Restrained, still on the creature) takes that condition's damage. */
    async applyHeldDamage(record) {
        const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
        if (!DamageRoll) throw Error("PF2e's damage roll is unavailable.");
        const held = record.declaration.heldDamage, spell = await castSpellFromUuid(record), caster = await fromUuid(record.sourceActorUuid);
        const results = [];
        for (const token of canvas.scene?.tokens ?? []) {
            const actor = token.actor;
            if (!actor) continue;
            const holds = slug => actor.hasCondition?.(slug) && (actor.itemTypes?.effect ?? []).some(effect => { const outcome = effect.flags?.[MODULE_ID]?.outcomeEffect;
                return outcome && outcome.sourceItemUuid === record.sourceItemUuid && (outcome.conditions ?? []).some(condition => condition.slug === slug); });
            // (Restrained is the stronger hold: its damage when both apply.)
            const entry = [...held.entries].sort((a, b) => (a.slug === "restrained" ? -1 : 1) - (b.slug === "restrained" ? -1 : 1)).find(candidate => holds(candidate.slug));
            if (!entry) continue;
            const steps = Math.max(0, Math.floor((Number(record.rank) - held.baseRank) / entry.step.interval));
            const roll = await new DamageRoll(`${entry.count + steps * entry.step.dice}d${entry.faces}[${entry.type}]`).evaluate();
            try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} is ${escapeHTML(entry.slug)} by the spell (Sustain)`,
                flags: { [MODULE_ID]: { kind: "held-damage", castId: record.castId, actorUuid: actor.uuid } } }); } catch (_) {}
            const receipt = await applyDamageWithReceipt(actor, { damage: roll, token, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            results.push({ actorUuid: actor.uuid, slug: entry.slug, formula: roll.formula, total: roll.total, healthLost: receipt?.hpLost ?? null });
        }
        return results;
    }
    /**
     * A living creature starting its turn in the draining centre (Tear the Veil): Drained 1, or one more (to the maximum); one already at the maximum
     * attempts the death save (incapacitation: a degree better above twice the rank) — on a failure it's at 0 Hit Points and dead (the GM places what it
     * becomes, its gear in its space).
     */
    async applyDrainTurn(record, member) {
        const drain = record.declaration.turnEffect.drain;
        const actor = await fromUuid(member.actorUuid);
        if (!actor) return { status: "missing" };
        if ((actor.modeOfBeing ?? "living") !== "living") return { status: "not-affected", reason: "not living" };
        const caster = await fromUuid(record.sourceActorUuid);
        const drained = Number(actor.getCondition?.("drained")?.value ?? 0);
        if (drained < drain.max) {
            if (drained > 0) await actor.increaseCondition("drained");
            else await actor.increaseCondition("drained", { value: 1 });
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} starts its turn in the centre: Drained ${drained + 1}.</p>` }); } catch (_) {}
            return { status: "drained", value: drained + 1 };
        }
        const statistic = actor.saves?.[drain.statistic];
        if (!statistic || !Number.isFinite(Number(record.dc))) throw Error(`${record.name}: ${actor.name}'s ${drain.statistic} save or the spell DC is unavailable.`);
        const spell = await castSpellFromUuid(record);
        const roll = await statistic.roll({ dc: { value: Number(record.dc) }, skipDialog: true, extraRollOptions: ["death", "incapacitation"], ...(spell ? { item: spell, origin: caster } : {}) });
        let degree = Number(roll?.degreeOfSuccess ?? -1);
        if (degree < 0) throw Error(`${actor.name}'s save wasn't rolled.`);
        // (Incapacitation: a creature of more than twice the spell's rank uses the next better result.)
        const incapacitated = Number(actor.level ?? 0) > 2 * Number(record.rank);
        if (incapacitated) degree = Math.min(3, degree + 1);
        const failed = degree <= 1;
        if (failed) {
            await actor.update({ "system.attributes.hp.temp": 0, "system.attributes.hp.value": 0 });
            if (!actor.statuses?.has?.("dead")) await actor.toggleStatusEffect?.("dead", { overlay: true, active: true });
        }
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }),
            content: `<p><strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} is drained ${drain.max} in the centre: ${escapeHTML(drain.statistic)} save ${["critically fails", "fails", "succeeds", "critically succeeds"][degree]}${incapacitated ? " (incapacitation: one degree better)" : ""}.${failed ? ` It's reduced to 0 Hit Points, crumbles into ash and becomes a ${escapeHTML(drain.becomes)}.` : ""}</p>${failed ? `<p class="pf2e-auto-gm-reminder"><strong>GM:</strong> place the ${escapeHTML(drain.becomes)}; its gear falls in its space.</p>` : ""}` }); } catch (_) {}
        return { status: failed ? "destroyed" : "saved", degree: ["criticalFailure", "failure", "success", "criticalSuccess"][degree], incapacitated };
    }
    /** Each exposed creature takes the area's stated damage (no save). */
    async applyExposureDamage(record, targets) {
        const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
        if (!DamageRoll) throw Error("PF2e's damage roll is unavailable.");
        const exposure = record.declaration.exposureDamage, spell = await castSpellFromUuid(record), caster = await fromUuid(record.sourceActorUuid);
        const results = [];
        for (const target of targets) {
            const actor = actorOf(target);
            if (!actor) continue;
            const roll = await new DamageRoll(`${exposure.formula}[${exposure.type}]`).evaluate();
            try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} is exposed (no save)`,
                flags: { [MODULE_ID]: { kind: "exposure-damage", castId: record.castId, actorUuid: actor.uuid } } }); } catch (_) {}
            const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: target.documentName === "Token" ? target : null, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            results.push({ actorUuid: actor.uuid, total: roll.total, healthLost: receipt?.hpLost ?? null });
        }
        return results;
    }
    /** The exposed creatures that are unconscious take the sleepers' damage (at the cast rank); it doesn't wake them. */
    async applySleeperDamage(record, targets) {
        const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
        if (!DamageRoll) throw Error("PF2e's damage roll is unavailable.");
        const sleeper = record.declaration.sleeperDamage, spell = await castSpellFromUuid(record), caster = await fromUuid(record.sourceActorUuid);
        const steps = sleeper.step ? Math.max(0, Math.floor((Number(record.rank) - Number(sleeper.baseRank)) / sleeper.step.interval)) : 0;
        const results = [];
        for (const target of targets) {
            const actor = actorOf(target);
            if (!actor?.hasCondition?.(sleeper.slug)) continue;
            const roll = await new DamageRoll(`${sleeper.dice + steps * (sleeper.step?.dice ?? 0)}d${sleeper.faces}[${sleeper.type}]`).evaluate();
            try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} is unconscious in the area (this doesn't wake it)`,
                flags: { [MODULE_ID]: { kind: "sleeper-damage", castId: record.castId, actorUuid: actor.uuid } } }); } catch (_) {}
            const token = target.documentName === "Token" ? target : null;
            const receipt = await applyDamageWithReceipt(actor, { damage: roll, token, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            // (PF2e wakes a creature that takes damage: this damage doesn't.)
            if (!actor.hasCondition?.(sleeper.slug) && Number(actor.system?.attributes?.hp?.value ?? 0) > 0) await actor.increaseCondition?.(sleeper.slug);
            results.push({ actorUuid: actor.uuid, formula: roll.formula, total: roll.total, healthLost: receipt?.hpLost ?? null });
        }
        return results;
    }
    async applyHazardDamage(record, member, event) {
        const actor = await fromUuid(member.actorUuid);
        const token = await fromUuid(member.tokenUuid);
        const spell = await castSpellFromUuid(record);
        const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
        if (!actor || !DamageRoll) throw Error(`${record.name}: the creature or PF2e's damage roll is unavailable.`);
        let hazard = record.declaration.hazardDamage;
        // (Field of Life: the living healed, the undead harmed, anyone else untouched.)
        if (hazard.lifeField) {
            const undead = actor.traits?.has?.("undead") ?? (actor.system?.traits?.value ?? []).includes("undead");
            if (livingMode(actor)) hazard = { ...hazard, heal: true, label: "regains Hit Points from the field" };
            else if (undead) hazard = { ...hazard, heal: false, label: "the field (undead)" };
            else return { total: 0, skipped: true };
        }
        if (hazard.transfer) return this.transferHitPoints(record, actor);
        // (Vibrant Vibrato: one save per creature for the casting, kept; its row's damage at the end of each of its turns inside.)
        if (hazard.remembered) {
            // (A list, not a map: actor UUIDs hold dots, which flag keys would expand.)
            record.remembered = Array.isArray(record.remembered) ? record.remembered : [];
            const caster = await fromUuid(record.sourceActorUuid);
            if (!caster || actor === caster) return { total: 0, skipped: true };
            let degree = record.remembered.find(entry => entry.actorUuid === actor.uuid)?.degree ?? null;
            if (!degree) {
                const roll = await actor.saves?.[hazard.remembered.statistic]?.roll({ dc: { value: Number(hazard.remembered.dc) }, item: spell ?? undefined, skipDialog: true });
                const index = Number(roll?.degreeOfSuccess ?? -1);
                if (index < 0) throw Error(`${actor.name}'s save wasn't rolled.`);
                degree = SAVE_DEGREES[3 - index];
                record.remembered.push({ actorUuid: actor.uuid, degree });
                if (event !== "turn-end") return { total: 0, status: degree };
            }
            const row = hazard.remembered.rows[degree];
            if (event !== "turn-end" || !row?.turnEnd) return { total: 0, status: degree };
            const rolled = await new DamageRoll(`{${row.turnEnd.formula}[${row.turnEnd.type}]}`).evaluate();
            try { await rolled.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} ends its turn in the area` }); } catch (_) {}
            const receipt = await applyDamageWithReceipt(actor, { damage: rolled, token: token ?? undefined, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            return { total: receipt.damage, status: degree };
        }
        // (A form's saving aura — Nature Incarnate's Green Caress: each enemy without the excepted trait saves; its row's condition for the stated rounds.)
        if (hazard.conditionSave) {
            const save = hazard.conditionSave, caster = await fromUuid(record.sourceActorUuid);
            if (!caster || actor === caster || (save.enemiesOnly && (!caster.isAllyOf || caster.isAllyOf(actor)))) return { total: 0, skipped: true };
            const traits = actor.traits ?? new Set(actor.system?.traits?.value ?? []);
            if (save.exceptTrait && traits.has?.(save.exceptTrait)) return { total: 0, skipped: true };
            // ("this is a mental, visual effect": a creature immune to one of them is unaffected.)
            if ((save.traits ?? []).some(trait => (actor.attributes?.immunities ?? []).some(immunity => immunity.type === trait))) return { total: 0, skipped: true, immune: true };
            // ("it is then temporarily immune to this dazzling effect for 10 minutes": not again while the marker lasts.)
            if (save.immunity && (actor.itemTypes?.effect ?? []).some(effect => !effect.isExpired && effect.flags?.[MODULE_ID]?.spellImmunity?.key === save.immunity.key)) return { total: 0, skipped: true, immune: true };
            const roll = await actor.saves?.[save.statistic]?.roll({ dc: { value: Number(save.dc) }, item: spell ?? undefined, skipDialog: true, ...(save.traits?.length ? { traits: [...save.traits] } : {}) });
            const degree = Number(roll?.degreeOfSuccess ?? -1);
            if (degree < 0) throw Error(`${actor.name}'s save wasn't rolled.`);
            const row = degree === 0 ? save.rows.criticalFailure : degree === 1 ? save.rows.failure : null;
            // (A row's conditions: one — Green Caress's Clumsy — or several — Blanket of Stars' Confused and Dazzled — for its rounds.)
            const conditions = row ? row.conditions ?? [{ uuid: row.uuid, slug: row.slug, value: row.value }] : [];
            if (save.immunity) await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: Temporary immunity`, type: "effect", img: "icons/svg/shield.svg",
                flags: { [MODULE_ID]: { spellImmunity: { key: save.immunity.key } } },
                system: { duration: { value: Math.round(Number(save.immunity.seconds) / 60), unit: "minutes", expiry: "turn-start", sustained: false }, rules: [],
                    start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, description: { value: `<p>Temporarily immune to ${escapeHTML(record.name)}'s save.</p>` } } }]);
            if (row?.direct) {
                // (Conditions as such — Colossal Summon's Megalophobia: "frightened 2 (frightened 3 and fleeing …)" — frightened decaying as PF2e does; one "while" another
                // lasts as an Effect that goes with it.)
                for (const entry of conditions) {
                    if (entry.whileCondition) {
                        await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${entry.slug} while ${entry.whileCondition}`, type: "effect", img: "icons/svg/downgrade.svg",
                            flags: { [MODULE_ID]: { spellshapeWhileCondition: entry.whileCondition, runtime: { schema: 1, kind: "aura-condition", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemName: record.name } } },
                            system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true }, description: { value: `<p>${escapeHTML(entry.slug)} while ${escapeHTML(entry.whileCondition)}, from <strong>${escapeHTML(record.name)}</strong>.</p>` },
                                rules: [{ key: "GrantItem", uuid: entry.uuid, allowDuplicate: true, onDeleteActions: { grantee: "cascade" } }] } }]);
                    } else if (entry.value) {
                        // (PF2e adds the value to an existing condition: raised to the row's value, never lowered.)
                        const current = Number(actor.getCondition?.(entry.slug)?.value ?? 0);
                        if (current < Number(entry.value)) await actor.increaseCondition(entry.slug, { value: Number(entry.value) - current });
                    } else if (!actor.hasCondition?.(entry.slug)) await actor.increaseCondition(entry.slug);
                }
                return { total: 0, status: conditions.map(entry => `${entry.slug} ${entry.value ?? ""}`.trim()).join(", ") };
            }
            if (row && row.expiry === "leave-area") {
                // ("… for as long as it remains in the area": an Effect the area removes when the creature leaves it.)
                const name = conditions.map(entry => `${entry.slug[0].toUpperCase()}${entry.slug.slice(1)}${entry.value ? ` ${entry.value}` : ""}`).join(" and ");
                await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${name}`, type: "effect", img: "icons/svg/downgrade.svg",
                    flags: { [MODULE_ID]: { leaveArea: { castId: record.castId, slot: 99 }, runtime: { schema: 1, kind: "aura-condition", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemName: record.name } } },
                    system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true }, description: { value: `<p>${escapeHTML(name)} while in <strong>${escapeHTML(record.name)}</strong>.</p>` },
                        rules: conditions.map((entry, index) => ({ key: "GrantItem", uuid: entry.uuid, flag: `auraCondition${index}`, allowDuplicate: true, onDeleteActions: { grantee: "cascade" } })) } }]);
                record.recipientUuids = [...new Set([...(record.recipientUuids ?? []), actor.uuid])];
                return { total: 0, status: name };
            }
            if (row) {
                const name = conditions.map(entry => `${entry.slug[0].toUpperCase()}${entry.slug.slice(1)}${entry.value ? ` ${entry.value}` : ""}`).join(" and ");
                await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${name}`, type: "effect", img: "icons/svg/downgrade.svg",
                    flags: { [MODULE_ID]: { runtime: { schema: 1, kind: "aura-condition", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemName: record.name } } },
                    system: { duration: { value: Number(row.rounds), unit: "rounds", expiry: row.expiry === "turn-end" ? "turn-end" : "turn-start", sustained: false },
                        start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                        tokenIcon: { show: true }, description: { value: `<p>${escapeHTML(name)} from <strong>${escapeHTML(record.name)}</strong>.</p>` },
                        rules: conditions.map((entry, index) => ({ key: "GrantItem", uuid: entry.uuid, flag: `auraCondition${index}`, allowDuplicate: true, onDeleteActions: { grantee: "cascade" },
                            ...(entry.value ? { alterations: [{ mode: "override", property: "badge-value", value: entry.value }] } : {}) })) } }]);
            }
            return { total: 0, status: row ? conditions.map(entry => `${entry.slug} ${entry.value ?? ""}`.trim()).join(", ") : "unaffected" };
        }
        // (Shadow Raid: only the caster's enemies.)
        if (hazard.enemiesOnly) { const caster = await fromUuid(record.sourceActorUuid); if (!caster || actor === caster || caster.isAllyOf?.(actor)) return { total: 0, skipped: true }; }
        // (… and half for a creature that disbelieved it.)
        const disbelieved = hazard.halvedOnDisbelief && record.declaration?.disbelief?.key && (actor.itemTypes?.effect ?? []).some(effect => !effect.isExpired && effect.flags?.[MODULE_ID]?.spellImmunity?.key === record.declaration.disbelief.key);
        // ("A living creature …": Tree of Life and Death's emanations.)
        if (hazard.living && !livingMode(actor)) return { total: 0, skipped: true };
        // (Rainbow Fumarole's "All": the caster chooses the color for each affected creature — its damage and added effect.)
        if (hazard.colors) {
            const entries = Object.values(hazard.colors);
            const picked = await foundry.applications.api.DialogV2.wait({ window: { title: `${record.name}: ${actor.name}` }, rejectClose: false,
                content: `<p>Choose the color for ${escapeHTML(actor.name)}.</p>`,
                buttons: entries.map((entry, index) => ({ action: `color-${index}`, label: entry.name, default: index === 0, callback: () => index })) });
            const color = entries[Number.isInteger(picked) ? picked : 0];
            hazard = { ...hazard, colors: null, formula: color.formula, failureEffect: color.effect ?? null, label: `${color.name}` };
        }
        // (A basic save against the area's damage: the creature's save first, PF2e's multiplier for its result.)
        let basicMultiplier = disbelieved ? 0.5 : 1, basicDegree = null;
        if (hazard.basic) {
            const roll = await actor.saves?.[hazard.basic.statistic]?.roll({ dc: { value: Number(hazard.basic.dc) }, item: spell ?? undefined, extraRollOptions: ["damaging-effect"], skipDialog: true });
            const degree = Number(roll?.degreeOfSuccess ?? -1);
            if (degree < 0) throw Error(`${actor.name}'s save wasn't rolled.`);
            basicMultiplier = [2, 1, 0.5, 0][degree];
            basicDegree = degree;
            if (!basicMultiplier) return { total: 0, saved: true };
        }
        // Blossoming Gore: a bleeding creature ending its turn in the field — its save; Drained by the result; the thralls created the GM's.
        if (hazard.goreSave) {
            const gore = hazard.goreSave;
            const bleeding = (actor.itemTypes?.condition ?? []).some(condition => condition.slug === "persistent-damage" && (condition.system?.persistent?.damageType ?? condition.system?.damageType) === "bleed");
            if (!bleeding) return { total: 0, skipped: true };
            const roll = await actor.saves?.[gore.statistic]?.roll({ dc: { value: Number(gore.dc) }, item: spell ?? undefined, skipDialog: true });
            const degree = Number(roll?.degreeOfSuccess ?? -1);
            if (degree < 0) throw Error(`${actor.name}'s save wasn't rolled.`);
            const row = degree === 0 ? gore.rows.criticalFailure : degree === 1 ? gore.rows.failure : degree === 2 ? gore.rows.success : null;
            // (PF2e adds the value to an existing condition: raise it by the difference.)
            const drainedNow = Number(actor.getCondition?.("drained")?.value ?? 0);
            if (row?.value && drainedNow < row.value) await actor.increaseCondition("drained", { value: row.value - drainedNow });
            // (The thralls created: tokens by the thrall rules in the free squares adjacent to the field, outside it.)
            let made = null;
            if (row?.thralls) {
                const caster = await fromUuid(record.sourceActorUuid), region = record.regionUuid ? await fromUuid(record.regionUuid) : null;
                const shape = region?.shapes?.[0], grid = canvas.scene.grid;
                if (caster && shape) {
                    const radius = Number(shape.radius ?? shape.radiusX ?? 0) / grid.size * grid.distance;
                    const inside = point => region.testPoint?.({ x: point.x, y: point.y, elevation: 0 }) ?? false;
                    made = await makeThralls(caster, { count: row.thralls, spell: record.name, castId: randomID(), itemOrSource: spell ?? null, near: { x: Number(shape.x), y: Number(shape.y) }, feet: radius + grid.distance,
                        accept: point => !inside(point) }).catch(error => { console.warn(`${MODULE_ID} | The field's thralls couldn't be placed.`, error); return null; });
                }
                if (!made) try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }),
                    content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(record.name)}:</strong> ${row.thralls} thrall${row.thralls === 1 ? " is" : "s are"} created adjacent to the field, but there was no free space for ${row.thralls === 1 ? "it" : "them"}.</p>` }); } catch (_) {}
            }
            return { total: 0, status: row ? `drained ${row.value}` : "unaffected", thralls: made?.thralls.map(entry => entry.token.uuid) ?? [] };
        }
        // Wall of Flesh's mouths: the caster's spell attack against a creature ending its turn beside the wall, the dice on a hit (doubled on a critical hit).
        if (hazard.fleshMouths) {
            const statistic = spell?.spellcasting?.statistic;
            if (!statistic?.check?.roll) throw Error(`${record.name}: the caster's spell attack is unavailable.`);
            const attack = await statistic.check.roll({ dc: { value: Number(actor.armorClass?.value ?? actor.system?.attributes?.ac?.value) }, item: spell, traits: [...new Set([...(spell.traits ?? []), "attack"])],
                extraRollOptions: ["attack", "item:trait:attack", "item:melee"], skipDialog: true });
            const degree = Number(attack?.degreeOfSuccess ?? -1);
            if (degree < 2) return { total: 0, status: "missed" };
            const rolled = await new DamageRoll(degree === 3 ? `{(2*${hazard.fleshMouths.formula})[${hazard.fleshMouths.type}]}` : `{${hazard.fleshMouths.formula}[${hazard.fleshMouths.type}]}`).evaluate();
            try { await rolled.toMessage({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), flavor: `<strong>${escapeHTML(record.name)}</strong>: the mouths bite ${escapeHTML(actor.name)}${degree === 3 ? " (critical hit, doubled)" : ""}` }); } catch (_) {}
            const receipt = await applyDamageWithReceipt(actor, { damage: rolled, token: token ?? undefined, item: spell ?? undefined, rollOptions: new Set(["item:trait:attack"]), skipIWR: false }, randomID());
            return { total: receipt.damage, status: "hit" };
        }
        // Wall of Flesh's arms: the creature's save; a failure Grabbed, a critical failure Restrained, for the stated rounds (or until it Escapes).
        if (hazard.fleshArms) {
            const arms = hazard.fleshArms;
            const roll = await actor.saves?.[arms.statistic]?.roll({ dc: { value: Number(arms.dc) }, item: spell ?? undefined, skipDialog: true });
            const degree = Number(roll?.degreeOfSuccess ?? -1);
            if (degree < 0) throw Error(`${actor.name}'s save wasn't rolled.`);
            const result = degree === 0 ? arms.criticalFailure : degree === 1 ? arms.failure : null;
            if (result) await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${result.name} by the wall`, type: "effect", img: spell?.img ?? "icons/svg/net.svg",
                flags: { [MODULE_ID]: { areaLifetime: { castId: record.castId }, fleshHold: record.castId } },
                system: { level: { value: record.rank }, duration: { value: result.rounds, unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                    description: { value: `<p>${escapeHTML(result.name)} by the wall for ${result.rounds} round or until it Escapes (DC ${escapeHTML(arms.dc)}).</p>` }, rules: [{ key: "GrantItem", uuid: result.uuid, onDeleteActions: { grantee: "restrict" } }] } }]);
            return { total: 0, status: result ? result.name.toLowerCase() : "unaffected" };
        }
        // Ravenous Darkness: a creature ending its turn inside — the teeth's damage if attached, else their attack.
        if (hazard.teeth) return this.teethBite(record, actor, token, spell);
        // Black Tentacles: a creature ending its turn inside — the held damage if the tentacles hold it, else their attempt to grab it (no damage with that grab).
        if (hazard.tentacles) {
            if (!spell) throw Error(`${record.name}: the spell is unavailable.`);
            const result = await tentacleAttempt({ spell, actor, token: token ?? null, castId: record.castId, castRank: record.rank, data: hazard.tentacles, turnEnd: true });
            return { total: result.damage ?? 0, status: result.status };
        }
        // Radiant Heart of Devotion: a neutral creature's save against Dazzled, an evil one's against Blinded; the good are spared. (No side yet: the GM is asked.)
        if (hazard.radiantSides) {
            const side = await this.radiantSide(record, actor);
            if (!side) { await this.askRadiantSide(record, actor); return { total: 0, skipped: true, unassigned: true }; }
            if (side === "good") return { total: 0, skipped: true };
            const result = hazard.radiantSides[side];
            const roll = await actor.saves?.[hazard.radiantSides.statistic]?.roll({ dc: { value: Number(hazard.radiantSides.dc) }, item: spell ?? undefined, skipDialog: true });
            const degree = Number(roll?.degreeOfSuccess ?? -1);
            if (degree < 0) throw Error(`${actor.name}'s save wasn't rolled.`);
            if (degree <= 1) {
                const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${result.name}`, type: "effect", img: "icons/svg/sun.svg",
                    flags: { [MODULE_ID]: { runtime: { schema: 1, kind: "lingering", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name } } },
                    system: { duration: { value: result.rounds, unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                        rules: [{ key: "GrantItem", uuid: result.uuid, onDeleteActions: { grantee: "restrict" } }] } }]);
                record.entries.push({ uuid: effect.uuid, actorUuid: actor.uuid, status: "active", permanent: false });
            }
            return { total: 0, side, saved: degree >= 2 };
        }
        // Life's Fresh Bloom: an undead (or the named fiends) saves against the condition; a living creature on the ground heals and gets PF2e's Effect.
        if (hazard.bloom) {
            const traits = actor.traits ?? new Set(actor.system?.traits?.value ?? []);
            const has = trait => traits.has?.(trait) ?? traits.includes?.(trait);
            if (hazard.bloom.harmedTraits.some(has) || (has("fiend") && has(hazard.bloom.harmedFiend))) {
                const roll = await actor.saves?.[hazard.bloom.statistic]?.roll({ dc: { value: Number(hazard.bloom.dc) }, item: spell ?? undefined, skipDialog: true });
                const degree = Number(roll?.degreeOfSuccess ?? -1);
                if (degree < 0) throw Error(`${actor.name}'s save wasn't rolled.`);
                // (PF2e adds the value to an existing condition: raise it by the difference.)
                const bloomNow = Number(actor.getCondition?.(hazard.bloom.condition)?.value ?? 0);
                if (degree <= 1 && bloomNow < hazard.bloom.value)
                    await actor.increaseCondition(hazard.bloom.condition, { value: hazard.bloom.value - bloomNow });
                return { total: 0, saved: degree >= 2 };
            }
            // ("standing on the ground": not flying above it.)
            if (!livingMode(actor) || has(hazard.bloom.harmedFiend) || Number(token?.elevation ?? 0) > 0) return { total: 0, skipped: true };
            const template = await loadNativeEffectTemplate(hazard.bloom.effectUuid);
            if (template) await createNativeEffect(actor, prepareNativeEffectSource(template, { castInstanceId: record.castId, castRank: record.rank, sourceActorUuid: record.sourceActorUuid,
                sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name, resolutionKind: "lingering", targetActorUuid: actor.uuid }));
        }
        if (hazard.heal) {
            // Healing: PF2e's roll, applied as healing (and back from Dying at 1 HP or more).
            const roll = await new Roll(String(hazard.formula)).evaluate();
            try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), flavor: `<strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} ${escapeHTML(hazard.label)} ${event === "enter" ? "on entering" : event === "turn-start" ? "as its turn starts" : "at the end of its turn"}`,
                flags: { [MODULE_ID]: { kind: "turn-healing", castId: record.castId, actorUuid: actor.uuid } } }); } catch (_) {}
            const wasDying = isDying(actor);
            const receipt = await applyDamageWithReceipt(actor, { damage: -roll.total, token: token ?? undefined, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            await recoverFromDying(actor, wasDying);
            return { total: roll.total, formula: roll.formula, receipt };
        }
        // ("if it's still grabbed by the vine": the condition Effect from that cast's card.)
        if (hazard.whileHeld && !(actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.outcomeEffect?.castId === hazard.whileHeld.castId)) return { total: 0, skipped: true };
        // ("to fiends, undead, and creatures that have a weakness to spirit damage": only those take it.)
        if (hazard.qualifies) {
            const traits = actor.traits ?? new Set(actor.system?.traits?.value ?? []);
            const weak = (actor.system?.attributes?.weaknesses ?? []).some(weakness => weakness.type === hazard.qualifies.weakness);
            if (!hazard.qualifies.traits.some(trait => traits.has?.(trait) ?? traits.includes?.(trait)) && !weak) return { total: 0, skipped: true };
        }
        // (A formula with its own instances — "{1d8[spirit],1d8[vitality]}" — carries its types.)
        // (A creature that critically failed the spell's save: Positive Attunement's damage doubled each time.)
        const base = hazard.multiplier === 2 ? `(2*(${hazard.formula}))` : hazard.formula;
        const rolled = await new DamageRoll(hazard.type ? `${base}[${hazard.type}]` : base).evaluate();
        // "Creatures that have the water trait … take double damage."
        const doubled = hazard.doubleTrait && (actor.traits?.has?.(hazard.doubleTrait) ?? (actor.system?.traits?.value ?? []).includes(hazard.doubleTrait));
        const roll = doubled ? rolled.alter(2, 0) : rolled;

        const why = event === "enter" ? "entered" : event === "turn-start" ? "started its turn in" : ["source-turn-end", "pulse"].includes(event) ? "was in" : "ended its turn in";
        try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }),
            flavor: `<strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} ${why} the area (${escapeHTML(hazard.label)}${doubled ? `, doubled: ${escapeHTML(hazard.doubleTrait)} trait` : ""}), ${hazard.basic ? `basic ${escapeHTML(hazard.basic.statistic)} save (${["critical failure", "failure", "success"][basicDegree] ?? ""})` : "no save"}${disbelieved ? " (disbelieved: half)" : ""}`,
            flags: { [MODULE_ID]: { kind: "ground-hazard", castId: record.castId, actorUuid: actor.uuid } } }); }
        catch (error) { console.warn(`${MODULE_ID} | The hazard damage message could not be posted.`, error); }
        const receipt = await applyDamageWithReceipt(actor, { damage: basicMultiplier === 1 ? roll : roll.alter(basicMultiplier, 0), token: token ?? undefined, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
        // ("on a failure, takes any added effect listed": the color's conditions — for the stated rounds through an Effect — or its push for the GM.)
        const added = hazard.failureEffect && basicDegree !== null && basicDegree <= 1 ? await this.hazardFailureEffect(record, actor, hazard.failureEffect, spell) : null;
        // (What the area does to every creature it damages, whatever the save — Patron's Apocalypse's bleed or slowing frost.)
        const always = hazard.alwaysEffect ? await this.hazardFailureEffect(record, actor, hazard.alwaysEffect, spell) : null;
        return { total: roll.total, formula: roll.formula, receipt, ...(basicDegree !== null ? { degree: basicDegree } : {}), ...(added ? { added } : {}), ...(always ? { always } : {}) };
    }
    /** The teeth on a creature in the area: attached, they deal their smaller damage; else the caster's spell attack against its save DC — on a success,
     *  the bite's damage and the teeth attached (an Effect: the Speed penalty, no Step) until it leaves the area or the spell ends. */
    async teethBite(record, actor, token, spell, { degree = null } = {}) {
        const teeth = record.declaration.hazardDamage.teeth;
        const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
        if (!spell || !DamageRoll) throw Error(`${record.name}: the spell or PF2e's damage roll is unavailable.`);
        const attached = (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.leaveArea?.castId === record.castId && effect.flags[MODULE_ID].teeth);
        const speaker = ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) });
        if (attached) {
            const rolled = await new DamageRoll(`${teeth.gnaw}[${teeth.gnawType}]`).evaluate();
            try { await rolled.toMessage({ speaker, flavor: `<strong>${escapeHTML(record.name)}</strong>: the teeth gnaw ${escapeHTML(actor.name)}` }); } catch (_) {}
            const receipt = await applyDamageWithReceipt(actor, { damage: rolled, token: token ?? undefined, item: spell, rollOptions: new Set(), skipIWR: false }, randomID());
            return { total: receipt.damage, status: "gnawed" };
        }
        const attack = await spellAttack(spell, actor, { against: teeth.statistic, degree, label: "the teeth" });
        if (!["success", "criticalSuccess"].includes(attack.degree)) return { total: 0, status: "missed" };
        const rolled = await new DamageRoll(`${teeth.formula}[${teeth.type}]`).evaluate();
        try { await rolled.toMessage({ speaker, flavor: `<strong>${escapeHTML(record.name)}</strong>: the teeth attach to ${escapeHTML(actor.name)}` }); } catch (_) {}
        const receipt = await applyDamageWithReceipt(actor, { damage: rolled, token: token ?? undefined, item: spell, rollOptions: new Set(), skipIWR: false }, randomID());
        await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: teeth attached`, type: "effect", img: spell.img ?? "icons/svg/teeth.svg",
            flags: { [MODULE_ID]: { leaveArea: { castId: record.castId }, teeth: true } },
            system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
                rules: [{ key: "FlatModifier", selector: "all-speeds", type: "circumstance", value: -teeth.speedPenalty, label: `${record.name}: teeth` }],
                description: { value: `<p>The teeth are attached: a –${teeth.speedPenalty}-foot circumstance penalty to its Speeds, and it can't Step. They let go when it leaves the area.</p>` } } }]);
        return { total: receipt.damage, status: "attached" };
    }
    async teethAttemptFor(castId, token, { degree = null } = {}) {
        const journal = this.ongoing.find(castId);
        if (!journal) throw Error("The spell's area has ended.");
        const record = clone(state(journal));
        const doc = token.document ?? token;
        return this.teethBite(record, doc.actor, doc, await castSpellFromUuid(record), { degree });
    }
    async hazardFailureEffect(record, actor, effect, spell) {
        const added = [];
        if (effect.rounds && effect.conditions?.length) {
            const [made] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${effect.conditions.map(entry => entry.slug + (entry.value ? ` ${entry.value}` : "")).join(", ")}`, type: "effect", img: spell?.img ?? "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { runtime: { schema: 1, kind: "lingering", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name } } },
                system: { duration: { value: effect.rounds, unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                    rules: effect.conditions.map(entry => ({ key: "GrantItem", uuid: entry.uuid, onDeleteActions: { grantee: "restrict" },
                        ...(entry.value ? { alterations: [{ mode: "override", property: "badge-value", value: entry.value }] } : {}) })) } }]);
            added.push(made?.uuid ?? null);
        } else for (const entry of effect.conditions ?? []) {
            const current = Number(actor.getCondition?.(entry.slug)?.value ?? 0);
            // (PF2e adds the value to an existing condition: the difference raises it to the stated value.)
            if (!actor.hasCondition?.(entry.slug) || (entry.value && current < entry.value)) await actor.increaseCondition(entry.slug, entry.value ? { value: entry.value - current } : {});
            added.push(entry.slug);
        }
        // (A rule for some rounds — "a –10 foot status penalty to their speeds for 1 round".)
        if (effect.rules?.length) {
            const [made] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${effect.label ?? "the area"}`, type: "effect", img: spell?.img ?? "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { runtime: { schema: 1, kind: "lingering", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name } } },
                system: { duration: { value: Number(effect.rounds ?? 1), unit: "rounds", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                    rules: clone(effect.rules) } }]);
            added.push(made?.uuid ?? null);
        }
        // (Persistent damage — "10 persistent bleed damage".)
        if (effect.persistent) {
            const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
            const roll = await new DamageRoll(`(${effect.persistent.formula})[persistent,${effect.persistent.type}]`).evaluate();
            const token = actor.getActiveTokens?.(true, true)?.[0] ?? null;
            await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            added.push(`${effect.persistent.formula} persistent ${effect.persistent.type}`);
        }
        if (effect.push) {
            // (Pushed away from the area — the nearest point of its wall or shape — by the module; never ending in another creature's space.)
            const token = actor.getActiveTokens?.(true, true)?.[0] ?? null;
            const region = record.regionUuid ? await fromUuid(record.regionUuid).catch(() => null) : null;
            const here = token ? { x: token.x + Number(token.width ?? 1) * canvas.grid.size / 2, y: token.y + Number(token.height ?? 1) * canvas.grid.size / 2 } : null;
            const point = region && here ? nearestRegionPoint(region, here) : null;
            const moved = point && token ? await forcedMove(token, { point, direction: "away", feet: Number(effect.push), reason: record.name }).catch(() => null) : null;
            if (!moved?.moved) try { await ChatMessage.create({ whisper: game.users.filter(user => user.isGM).map(user => user.id),
                content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(record.name)}:</strong> ${escapeHTML(actor.name)} is pushed ${effect.push} feet (move its token).</p>` }); } catch (_) {}
            added.push(`push ${effect.push}${moved?.moved ? " (moved)" : ""}`);
        }
        return added;
    }
    /**
     * "All creatures within the area become concealed, and creatures outside are
     * concealed to creatures within it": creatures inside get PF2e's Concealed
     * condition and a note on their attack rolls. PF2e doesn't automate
     * concealment flat checks, so the table rolls the DC 5 flat check.
     */
    /** Removes this area's leave-area Effects from every creature not inside (all of them when `inside` is null). */
    /** "A creature currently Fascinated by hypnotize doesn't attempt new saves.": it holds that condition from this spell's save (or this
     *  spell's temporary immunity). */
    heldBySpell(record, actorUuid) {
        // (One condition, or several: Gluttonous Growth's "unless it's already Grabbed or Restrained".)
        const slugs = record.declaration?.skipWhile?.slugs ?? (record.declaration?.skipWhile?.slug ? [record.declaration.skipWhile.slug] : []), immunityKey = record.declaration?.immunityKey;
        if (!slugs.length && !immunityKey) return false;
        let actor = null; try { actor = fromUuidSync(actorUuid); } catch (_) {}
        if (immunityKey && (actor?.itemTypes?.effect ?? []).some(effect => !effect.isExpired && effect.flags?.[MODULE_ID]?.spellImmunity?.key === immunityKey)) return true;
        return slugs.some(slug => actor?.hasCondition?.(slug) && (actor.itemTypes?.effect ?? []).some(effect => { const held = effect.flags?.[MODULE_ID]?.outcomeEffect;
            return held && held.sourceItemUuid === record.sourceItemUuid && (held.conditions ?? []).some(condition => condition.slug === slug); }));
    }
    async clearLeaveArea(record, inside = null) {
        const keep = new Set(inside ?? []);
        const actors = new Map();
        for (const token of canvas.scene?.tokens ?? []) if (token.actor) actors.set(token.actor.uuid, token.actor);
        for (const uuid of record.recipientUuids ?? []) if (!actors.has(uuid)) { const actor = await fromUuid(uuid); if (actor) actors.set(uuid, actor); }
        for (const [uuid, actor] of actors) {
            if (keep.has(uuid)) continue;
            // (When the area ends, its "fascinated by the cloud" Effects end too.)
            const stale = (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.leaveArea?.castId === record.castId
                || (inside === null && effect.flags?.[MODULE_ID]?.areaLifetime?.castId === record.castId)
                // (The grasping hands hold "until it Escapes" — or until the spell ends.)
                || (inside === null && record.declaration?.heldDamage && effect.flags?.[MODULE_ID]?.outcomeEffect?.sourceItemUuid === record.sourceItemUuid
                    && (effect.flags[MODULE_ID].outcomeEffect.conditions ?? []).some(condition => record.declaration.heldDamage.entries.some(entry => entry.slug === condition.slug)))).map(effect => effect.id);
            // ("… until they leave the area and for 1 round after": on leaving, the note runs that many rounds more instead.)
            const lingering = inside === null ? [] : (actor.itemTypes?.effect ?? []).filter(effect => stale.includes(effect.id) && Number(effect.flags?.[MODULE_ID]?.leaveArea?.afterRounds) > 0);
            const replaced = [];
            for (const effect of lingering) {
                const duration = { value: Number(effect.flags[MODULE_ID].leaveArea.afterRounds), unit: "rounds", expiry: "turn-end", sustained: false };
                const start = { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null };
                // (Other rules for those rounds — "stupefied 1 for 1 round after": a fresh Effect holding them, the old one and what it granted removed.)
                const afterRules = effect.flags[MODULE_ID].leaveArea.afterRules;
                if (Array.isArray(afterRules) && afterRules.length) {
                    const source = effect.toObject();
                    delete source._id;
                    delete source.flags[MODULE_ID].leaveArea;
                    delete source.flags.pf2e?.itemGrants;
                    await actor.createEmbeddedDocuments("Item", [{ ...source, system: { ...source.system, duration, start, rules: clone(afterRules) } }]);
                    replaced.push(effect.id);
                    continue;
                }
                await effect.update({ "system.duration": duration, "system.start": start, [`flags.${MODULE_ID}.-=leaveArea`]: null });
            }
            const gone = stale.filter(id => replaced.includes(id) || !lingering.some(effect => effect.id === id));
            if (gone.length) await actor.deleteEmbeddedDocuments("Item", gone, { [MODULE_ID]: { ongoingCleanup: true, reason: "left-area" } });
        }
    }
    async syncLingeringConcealment(record, members) {
        if (!record.declaration?.concealment) return;
        const inside = new Set(members.map(member => member.actorUuid));
        if (record.declaration.centre === "caster") inside.add(record.sourceActorUuid);
        // A list, not a map: flag keys containing dots (actor UUIDs) would be expanded into nested objects.
        record.concealment = Array.isArray(record.concealment) ? record.concealment : [];
        for (const { actorUuid, effectUuid } of record.concealment.filter(held => !inside.has(held.actorUuid))) {
            const effect = await fromUuid(effectUuid);
            if (effect) await effect.delete({ [MODULE_ID]: { ongoingCleanup: true, skipSequence: true, skipCascade: true, reason: "left-area" } });
            record.concealment = record.concealment.filter(held => held.actorUuid !== actorUuid);
            const entry = record.entries.find(candidate => candidate.uuid === effectUuid);
            if (entry) { entry.status = "ended"; entry.reason = "left-area"; }
        }
        const template = game.pf2e.ConditionManager.getCondition("concealed");
        const uuid = template._stats?.compendiumSource ?? `Compendium.pf2e.conditionitems.Item.${template.id}`;
        for (const actorUuid of inside) {
            if (record.concealment.some(held => held.actorUuid === actorUuid)) continue;
            const actor = await fromUuid(actorUuid);
            if (!actor) continue;
            const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: inside (concealed)`, type: "effect", img: template.img,
                flags: { [MODULE_ID]: { lingeringConcealment: record.castId } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, level: { value: record.rank },
                    description: { value: `<p>Inside <strong>${escapeHTML(record.name)}</strong>: concealed. Creatures outside the area are concealed to this creature (DC 5 flat check).</p>${(record.declaration.notes ?? []).map(note => `<p>${escapeHTML(note)} End the spell in Ongoing spells when it does.</p>`).join("")}` },
                    rules: [{ key: "GrantItem", uuid, flag: "concealed", allowDuplicate: true, onDeleteActions: { granter: "cascade", grantee: "cascade" } },
                        { key: "Note", selector: ["attack-roll"], title: record.name, text: `Creatures outside the ${record.name} area are concealed to you: DC 5 flat check.` },
                        // The cloud's own rules for those inside (Confetti Cloud's toggled penalty to Perception checks to hear).
                        ...clone(record.declaration.memberRules ?? []).map(rule => ({ ...rule, ...(rule.key === "FlatModifier" ? { label: record.name } : {}) }))] } }]);
            record.concealment.push({ actorUuid, effectUuid: effect.uuid });
            record.entries.push({ uuid: effect.uuid, actorUuid, status: "active", permanent: false });
        }
    }
    /**
     * "When a creature within the area would regain Hit Points, … it must attempt a Will save." (Fallow Field): each creature inside holds a marker
     * the healing watch (main.js) reads; a creature that leaves loses it.
     */
    /**
     * The area's own rules for each creature standing in it (Shifting Sand's skill penalty; not a concealing area, which carries them itself): an Effect
     * while it's inside, at the cast rank; a creature that leaves loses it.
     */
    async syncLingeringMembers(record, members) {
        if (!record.declaration?.memberRules?.length || record.declaration.concealment) return;
        // (Divine Aura: the caster's allies inside, not the caster or its enemies.)
        const caster = record.declaration.memberAllies ? await fromUuid(record.sourceActorUuid) : null;
        // (Cosmic Glow: the caster too. Manifest Wicket Dominion: the caster alone.)
        const allied = async member => { const actor = await fromUuid(member.actorUuid); return !!actor && (actor === caster ? record.declaration.memberCaster === true : !record.declaration.memberCasterOnly && !!caster?.isAllyOf?.(actor)); };
        const kept = (record.declaration.memberAllies ? (await Promise.all(members.map(async member => (await allied(member)) ? member : null))).filter(Boolean) : members)
            .filter(member => !(record.declaration.excludeTokenUuids ?? []).includes(member.tokenUuid));
        const inside = new Set(kept.map(member => member.actorUuid));
        record.memberEffects = Array.isArray(record.memberEffects) ? record.memberEffects : [];
        for (const { actorUuid, effectUuid } of record.memberEffects.filter(held => !inside.has(held.actorUuid))) {
            const effect = await fromUuid(effectUuid);
            if (effect) await effect.delete({ [MODULE_ID]: { ongoingCleanup: true, skipSequence: true, skipCascade: true, reason: "left-area" } });
            record.memberEffects = record.memberEffects.filter(held => held.actorUuid !== actorUuid);
            const entry = record.entries.find(candidate => candidate.uuid === effectUuid);
            if (entry) { entry.status = "ended"; entry.reason = "left-area"; }
        }
        for (const actorUuid of inside) {
            if (record.memberEffects.some(held => held.actorUuid === actorUuid)) continue;
            const actor = await fromUuid(actorUuid);
            if (!actor) continue;
            const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: in the area`, type: "effect", img: "icons/svg/downgrade.svg",
                flags: { [MODULE_ID]: { lingeringMember: record.castId } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, level: { value: record.rank },
                    description: { value: `<p>Standing in <strong>${escapeHTML(record.name)}</strong>.</p>${record.declaration.memberAllies ? (record.declaration.notes ?? []).map(note => `<p>${escapeHTML(note)}</p>`).join("") : ""}` },
                    rules: clone(record.declaration.memberRules).map(rule => ({ ...rule, ...(rule.key === "FlatModifier" ? { label: record.name } : {}) })) } }]);
            record.memberEffects.push({ actorUuid, effectUuid: effect.uuid });
            record.entries.push({ uuid: effect.uuid, actorUuid, status: "active", permanent: false });
        }
    }
    /** Divine Eclipse: each blessed creature holds the module's Effect (its light and fast healing) while it's inside the caster's emanation. */
    async syncBlessed(record) {
        const blessed = record.declaration?.blessed;
        if (!blessed?.tokenUuids?.length) return;
        const casterToken = (await fromUuid(record.sourceActorUuid))?.getActiveTokens?.()?.[0]?.document;
        record.blessedEffects = Array.isArray(record.blessedEffects) ? record.blessedEffects : [];
        for (const uuid of blessed.tokenUuids) {
            const token = await fromUuid(uuid);
            if (!token?.actor) continue;
            const inside = !!casterToken && (token.id === casterToken.id || tokenDistance(casterToken, token) <= Number(record.declaration.area.value));
            const held = record.blessedEffects.find(entry => entry.actorUuid === token.actor.uuid);
            if (!inside && held) {
                const effect = await fromUuid(held.effectUuid);
                if (effect) await effect.delete({ [MODULE_ID]: { ongoingCleanup: true, reason: "left-area" } });
                record.blessedEffects = record.blessedEffects.filter(entry => entry !== held);
                const entry = record.entries.find(candidate => candidate.uuid === held.effectUuid);
                if (entry) { entry.status = "ended"; entry.reason = "left-area"; }
            } else if (inside && !held) {
                const template = await loadNativeEffectTemplate(blessed.effect.uuid);
                if (!template || !blessingMatches(template, { bright: blessed.bright, dim: blessed.dim, healing: Number(record.rank), step: 1, rank: Number(record.rank) })) throw Error(`${record.name}: the module's Effect no longer gives the blessing's light and fast healing.`);
                const effect = await createNativeEffect(token.actor, prepareNativeEffectSource(template, { castInstanceId: record.castId, castRank: record.rank, sourceActorUuid: record.sourceActorUuid,
                    sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name, resolutionKind: "lingering-blessing", targetActorUuid: token.actor.uuid }));
                record.blessedEffects.push({ actorUuid: token.actor.uuid, effectUuid: effect.uuid });
                record.entries.push({ uuid: effect.uuid, actorUuid: token.actor.uuid, status: "active", permanent: false });
            }
        }
    }
    async syncHealingWatch(record, members) {
        if (!record.declaration?.healingSave) return;
        const inside = new Set(members.map(member => member.actorUuid));
        record.healingWatch = Array.isArray(record.healingWatch) ? record.healingWatch : [];
        for (const { actorUuid, effectUuid } of record.healingWatch.filter(held => !inside.has(held.actorUuid))) {
            const effect = await fromUuid(effectUuid);
            if (effect) await effect.delete({ [MODULE_ID]: { ongoingCleanup: true, skipSequence: true, skipCascade: true, reason: "left-area" } });
            record.healingWatch = record.healingWatch.filter(held => held.actorUuid !== actorUuid);
            const entry = record.entries.find(candidate => candidate.uuid === effectUuid);
            if (entry) { entry.status = "ended"; entry.reason = "left-area"; }
        }
        for (const actorUuid of inside) {
            if (record.healingWatch.some(held => held.actorUuid === actorUuid)) continue;
            const actor = await fromUuid(actorUuid);
            if (!actor) continue;
            const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: inside (healing withheld)`, type: "effect", img: "icons/svg/degen.svg",
                flags: { [MODULE_ID]: { healingWatch: { castId: record.castId } } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, level: { value: record.rank }, rules: [],
                    description: { value: `<p>Inside <strong>${escapeHTML(record.name)}</strong>: when this creature would regain Hit Points, the module holds the healing and rolls its ${escapeHTML(record.declaration.healingSave.statistic)} save; it regains all, all, half or none of it by the result.</p>` } } }]);
            record.healingWatch.push({ actorUuid, effectUuid: effect.uuid });
            record.entries.push({ uuid: effect.uuid, actorUuid, status: "active", permanent: false });
        }
    }
    /** The held healing's save (Fallow Field): the creature's save at the spell DC, then the result's share of the healing; immune after a critical success. */
    async healingSave({ castId, actorUuid, amount }) {
        const journal = this.ongoing.find(castId);
        const record = journal ? clone(state(journal)) : null;
        if (!record || record.status !== "active" || !record.declaration?.healingSave) throw Error("The spell has ended.");
        const actor = await fromUuid(actorUuid);
        if (!actor) throw Error("The creature is gone.");
        const held = Math.floor(Number(amount));
        if (!(held > 0)) throw Error("No healing was held.");
        const spec = record.declaration.healingSave;
        const statistic = actor.saves?.[spec.statistic];
        if (!statistic) throw Error(`${actor.name} has no ${spec.statistic} save.`);
        const caster = await fromUuid(record.sourceActorUuid), spell = await castSpellFromUuid(record);
        const roll = await statistic.roll({ dc: { value: Number(record.dc) }, skipDialog: true, ...(spell ? { item: spell, origin: caster } : {}) });
        const degree = ["criticalFailure", "failure", "success", "criticalSuccess"][roll?.degreeOfSuccess ?? -1];
        if (!degree) throw Error(`${actor.name}'s save wasn't rolled.`);
        const regained = Math.floor(held * Number(spec.shares[degree] ?? 0));
        const hp = actor.system?.attributes?.hp;
        const after = Math.min(Number(hp?.max ?? 0), Number(hp?.value ?? 0) + regained);
        if (after > Number(hp?.value ?? 0)) await actor.update({ "system.attributes.hp.value": after }, { [MODULE_ID]: { healingSaveRestore: castId } });
        if (degree === spec.immunity?.degree) await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: immune`, type: "effect", img: "icons/svg/aura.svg",
            flags: { [MODULE_ID]: { healingSaveImmune: { castId } } },
            system: { duration: { value: spec.immunity.value, unit: spec.immunity.unit, expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                level: { value: record.rank }, rules: [], description: { value: `<p>Temporarily immune to ${escapeHTML(record.name)}: its healing isn't withheld.</p>` } } }]);
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)}'s ${escapeHTML(spec.statistic)} save is a ${escapeHTML(degree.replace(/([A-Z])/g, " $1").toLowerCase())}: it regains ${regained} of the ${held} Hit Points${degree === spec.immunity?.degree ? " and is temporarily immune" : ""}.</p>` }); } catch (_) {}
        record.healingSaves = [...(record.healingSaves ?? []), { actorUuid, amount: held, degree, regained }];
        await this.ongoing.save(journal, record);
        return { degree, regained, held };
    }
    /** "The target is Fatigued for as long as the effect persists": each member holds the condition while the cast lasts. */
    /**
     * PF2e's Effect on the creatures of a trait while they're inside (Hallowed Ground's weakness): given to each such member without it,
     * flagged to the area so a creature that leaves loses it (clearLeaveArea), and it ends with the area.
     */
    /**
     * Radiant Heart of Devotion's side for a creature: PF2e's remaster has no alignment, so the GM assigns each one (the user, 2026-10-10) — null until then.
     */
    async radiantSide(record, actor) {
        // (A list, not a map: a flag's keys can't hold the dots of a UUID.)
        return (Array.isArray(record.declaration?.alignment) ? record.declaration.alignment : []).find(entry => entry.actorUuid === actor.uuid)?.side ?? null;
    }
    /** A creature in the radiance with no side yet: the GM is asked once (per cast, this session), its card's buttons setting that creature's side. */
    async askRadiantSide(record, actor) {
        const key = `${record.castId}|${actor.uuid}`;
        if ((this._radiantAsked ??= new Set()).has(key)) return;
        this._radiantAsked.add(key);
        const caster = await fromUuid(record.sourceActorUuid).catch(() => null);
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster ?? undefined }), whisper: game.users.filter(user => user.isGM).map(user => user.id),
            flags: { [MODULE_ID]: { kind: "radiant-heart", radiantHeart: { castId: record.castId, actorUuid: actor.uuid } } },
            content: `<h3>${escapeHTML(record.name)}</h3><p><strong>GM:</strong> ${escapeHTML(actor.name)} is in the radiance with no side set. Good holds the bonuses; neutral and evil save at the start of their turns.</p>`
                + ["good", "neutral", "evil"].map(side => `<button type="button" class="pf2e-auto-card-action" data-action="radiant-${side}"><i class="fa-solid fa-scale-balanced"></i> ${escapeHTML(actor.name)} is ${side}</button>`).join("") }); } catch (_) {}
    }
    /** The area is difficult terrain for this creature (each of the record's regions, a per-creature movement cost); until the spell ends or its turn starts. */
    async addRowTerrain(record, actorUuid) {
        const regions = (await Promise.all((record.regionUuids ?? [record.regionUuid]).map(uuid => fromUuid(uuid)))).filter(Boolean);
        for (const region of regions) {
            let behavior = region.behaviors?.find(entry => entry.flags?.[MODULE_ID]?.rowTerrain);
            if (!behavior) [behavior] = await region.createEmbeddedDocuments("RegionBehavior", [{ name: `${record.name}: difficult terrain for some creatures`, type: "modifyMovementCost",
                system: { difficulties: { walk: 1 } }, flags: { [MODULE_ID]: { rowTerrain: true, selectiveTerrain: { actions: ["walk", "travel"], default: 1, creatures: [] } } } }]);
            const creatures = (behavior.flags[MODULE_ID].selectiveTerrain.creatures ?? []).filter(entry => entry.actorUuid !== actorUuid);
            await behavior.update({ [`flags.${MODULE_ID}.selectiveTerrain.creatures`]: [...creatures, { actorUuid, difficulty: 2 }] });
        }
        record.rowTerrainHolders = [...new Set([...(record.rowTerrainHolders ?? []), actorUuid])];
    }
    /** Its turn starts: the area is no longer difficult terrain for it ("until the start of its next turn"). */
    async clearRowTerrain(record, actorUuid) {
        const regions = (await Promise.all((record.regionUuids ?? [record.regionUuid]).map(uuid => fromUuid(uuid)))).filter(Boolean);
        for (const region of regions) {
            const behavior = region.behaviors?.find(entry => entry.flags?.[MODULE_ID]?.rowTerrain);
            if (behavior) await behavior.update({ [`flags.${MODULE_ID}.selectiveTerrain.creatures`]: (behavior.flags[MODULE_ID].selectiveTerrain.creatures ?? []).filter(entry => entry.actorUuid !== actorUuid) });
        }
        record.rowTerrainHolders = (record.rowTerrainHolders ?? []).filter(entry => entry !== actorUuid);
    }
    async syncMemberEffect(record, members) {
        // (One Effect for the area's members, or several in their own slots — Musical Shift's key for enemies, time for allies.)
        const entries = [record.declaration?.memberEffect, ...(record.declaration?.memberEffects ?? [])];
        for (const [slot, member] of entries.entries()) if (member) await this.syncOneMemberEffect(record, members, member, slot);
    }
    async syncOneMemberEffect(record, members, member, slot) {
        let template = null;
        const sourceCaster = member.enemies ? await fromUuid(record.sourceActorUuid) : null;
        // "You and your allies … while in the area": the caster (at the emanation's centre) and its allies inside.
        // (Or another creature's — Fateful Condemnation's condemned target and its allies: `alliesOf`.)
        const anchorUuid = member.alliesOf ?? record.sourceActorUuid;
        const caster = member.allies ? await fromUuid(anchorUuid) : null;
        // (In a placed area the caster too only while inside: Personal Runewell.)
        const casterIn = record.declaration.centre === "caster" || members.some(entry => entry.actorUuid === anchorUuid);
        const candidates = member.allies ? [...(member.excludeCaster || !casterIn ? [] : [{ actorUuid: anchorUuid }]), ...members.filter(entry => entry.actorUuid !== anchorUuid)] : members;
        for (const { actorUuid } of candidates) {
            const actor = await fromUuid(actorUuid);
            if (member.all ? !actor : member.allies ? !(actor && (actor === caster || caster?.isAllyOf?.(actor)))
                : member.enemies ? !(actor && sourceCaster && actor !== sourceCaster && !sourceCaster.isAllyOf?.(actor)) : !actor?.traits?.has?.(member.trait)) continue;
            // (Radiant Heart of Devotion: only the creatures on the "good" side; one with no side yet: the GM is asked.)
            if (member.sides) {
                const side = await this.radiantSide(record, actor);
                if (!side) await this.askRadiantSide(record, actor);
                if (side !== "good") continue;
            }
            if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.leaveArea?.castId === record.castId && (effect.flags[MODULE_ID].leaveArea.slot ?? 0) === slot)) continue;
            // (Only a creature ending its turn inside — the turn that just ended; not one that used the resistance in the last 10 minutes.)
            if (member.turnEnd && record.turnEndedActor !== actorUuid) continue;
            if (member.shieldUse && (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.spellImmunity?.key === member.shieldUse.immunityKey && !effect.isExpired)) continue;
            // (A generated Effect — Rallying Banner's bonuses — instead of PF2e's.)
            if (member.generated) {
                const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${member.generated.name}`, type: "effect", img: "icons/svg/banner.svg",
                    flags: { [MODULE_ID]: { leaveArea: { castId: record.castId, slot }, runtime: { schema: 1, kind: "lingering", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name } } },
                    system: { level: { value: record.rank }, duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                        description: { value: `<p>${escapeHTML(member.generated.text)}</p>` }, rules: clone(member.generated.rules) } }]);
                record.entries.push({ uuid: effect.uuid, actorUuid, status: "active", permanent: false });
                record.recipientUuids = [...new Set([...(record.recipientUuids ?? []), actorUuid])];
                continue;
            }
            template ??= await loadNativeEffectTemplate(member.uuid);
            // (The area's own spell isn't amplified by its Effect: Personal Runewell's bolts — PF2e's item option on that spell's rolls.)
            const ownSpell = member.notOwnSpell ? [{ index: 0, key: "FlatModifier", patch: { predicate: [{ not: `item:id:${String(record.sourceItemUuid).split(".").pop()}` }] } }] : null;
            const source = prepareNativeEffectSource(template, { castInstanceId: record.castId, castRank: record.rank, sourceActorUuid: record.sourceActorUuid,
                sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name, resolutionKind: "lingering", ...(member.ruleOverrides || ownSpell ? { ruleOverrides: [...(member.ruleOverrides ?? []), ...(ownSpell ?? [])] } : {}),
                ...(member.ruleAdditions ? { ruleAdditions: member.ruleAdditions } : {}) });
            source.flags[MODULE_ID].leaveArea = { castId: record.castId, slot };
            if (member.shieldUse) source.flags[MODULE_ID].shieldUse = clone(member.shieldUse);
            source.system.duration = { value: -1, unit: "unlimited", expiry: null, sustained: false };
            // The caster's pick for the area (a ChoiceSet's value), preset so PF2e doesn't prompt.
            if (member.selection) {
                const choice = source.system.rules[member.selection.index];
                if (choice?.key !== "ChoiceSet" || choice.flag !== member.selection.flag) throw Error(`${record.name}: PF2e's Effect changed since it was compiled.`);
                choice.selection = member.selection.value;
                source.flags.system ??= {}; source.flags.system.rulesSelections ??= {};
                source.flags.system.rulesSelections[choice.flag] = member.selection.value;
            }
            const effect = await createNativeEffect(actor, source);
            record.entries.push({ uuid: effect.uuid, actorUuid, status: "active", permanent: false });
            record.recipientUuids = [...new Set([...(record.recipientUuids ?? []), actorUuid])];
        }
    }
    /**
     * A mode card's area changing state (Storm Lord's rain, Musical Shift's keys): the members' Effects from the old state removed, the new member
     * Effects (or none) and the region's terrain set, then applied to the creatures inside now.
     */
    async setAreaMode({ castId, memberEffect = null, memberEffects = [], terrain = null, slot = null, member = null }) {
        this.ongoing.assertCoordinator();
        const journal = this.ongoing.find(castId);
        if (!journal) throw Error("The spell's area has ended.");
        const record = clone(state(journal));
        if (record.status !== "active") throw Error(`${record.name}: its area isn't active.`);
        // (One slot only — Musical Shift's key or time: that slot's Effects replaced, the rest kept.)
        if (Number.isInteger(slot) && slot > 0) {
            for (const token of canvas.scene?.tokens ?? []) {
                const stale = (token.actor?.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.leaveArea?.castId === record.castId && effect.flags[MODULE_ID].leaveArea.slot === slot).map(effect => effect.id);
                if (stale.length) await token.actor.deleteEmbeddedDocuments("Item", stale, { [MODULE_ID]: { ongoingCleanup: true, reason: "mode-changed" } });
            }
            const slots = clone(record.declaration.memberEffects ?? []);
            while (slots.length < slot) slots.push(null);
            slots[slot - 1] = member ? clone(member) : null;
            record.declaration.memberEffects = slots;
            const members = (await this.lingeringMembership(record)) ?? [];
            await this.syncMemberEffect(record, members);
            await this.ongoing.save(journal, record);
            return { members: members.length };
        }
        // (The old mode's member Effects; a save's "while in the area" condition — Control Sand's dazzle — stays.)
        for (const token of canvas.scene?.tokens ?? []) {
            const stale = (token.actor?.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.leaveArea?.castId === record.castId && (effect.flags[MODULE_ID].leaveArea.slot ?? 0) < 99).map(effect => effect.id);
            if (stale.length) await token.actor.deleteEmbeddedDocuments("Item", stale, { [MODULE_ID]: { ongoingCleanup: true, reason: "mode-changed" } });
        }
        record.declaration.memberEffect = memberEffect ? clone(memberEffect) : undefined;
        record.declaration.memberEffects = clone(memberEffects ?? []);
        const region = record.regionUuid ? await fromUuid(record.regionUuid) : null;
        if (region) {
            const old = region.behaviors.filter(behavior => behavior.getFlag?.(MODULE_ID, "areaMode")).map(behavior => behavior.id);
            if (old.length) await region.deleteEmbeddedDocuments("RegionBehavior", old);
            if (terrain) await region.createEmbeddedDocuments("RegionBehavior", [{ name: `${record.name}: ${terrain.difficulty === 3 ? "greater " : ""}difficult terrain`, type: "modifyMovementCost",
                system: { difficulties: terrainDifficulties(terrain.movement ?? ["walk"], terrain.difficulty) }, flags: { [MODULE_ID]: { areaMode: true } } }]);
        }
        const members = (await this.lingeringMembership(record)) ?? [];
        await this.syncMemberEffect(record, members);
        await this.ongoing.save(journal, record);
        return { members: members.length };
    }
    /**
     * Vibrant Vibrato's shattering sound: each creature whose kept result has a leaving row and that was inside but no longer is (it left, or the caster
     * moved away) takes the row's damage (more at higher ranks, doubled on a critical failure) and its Stunned value, then is Deafened for the rest of the
     * spell (an Effect ending with the area); once each.
     */
    async rememberedLeave(record, members) {
        const hazard = record.declaration.hazardDamage.remembered;
        const inside = new Set(members.map(member => member.tokenUuid));
        record.shattered = Array.isArray(record.shattered) ? record.shattered : [];
        const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
        const spell = await castSpellFromUuid(record);
        const caster = await fromUuid(record.sourceActorUuid);
        for (const tokenUuid of record.members ?? []) {
            if (inside.has(tokenUuid)) continue;
            const token = await fromUuid(tokenUuid), actor = token?.actor;
            const degree = actor ? (record.remembered ?? []).find(entry => entry.actorUuid === actor.uuid)?.degree ?? null : null;
            const row = degree ? hazard.rows[degree] : null;
            if (!row?.leave || record.shattered.includes(actor.uuid)) continue;
            record.shattered.push(actor.uuid);
            const dice = Number(hazard.leaveDice.base) + Math.max(0, Number(record.rank) - Number(hazard.leaveDice.baseRank)) * Number(hazard.leaveDice.step);
            const formula = `${dice}d${hazard.leaveDice.die}`;
            const rolled = await new DamageRoll(row.leave.multiplier === 2 ? `{(2*${formula})[${hazard.leaveDice.type}]}` : `{${formula}[${hazard.leaveDice.type}]}`).evaluate();
            try { await rolled.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} hears a shattering sound${row.leave.multiplier === 2 ? " (double)" : ""}` }); } catch (_) {}
            await applyDamageWithReceipt(actor, { damage: rolled, token: token ?? undefined, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            const stunned = Number(actor.getCondition?.("stunned")?.value ?? 0);
            if (stunned < row.leave.stunned) await actor.increaseCondition?.("stunned", { value: row.leave.stunned });
            if (hazard.deafened) await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: Deafened`, type: "effect", img: "icons/svg/deaf.svg",
                flags: { [MODULE_ID]: { areaLifetime: { castId: record.castId } } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true }, description: { value: `<p>Deafened for the rest of <strong>${escapeHTML(record.name)}</strong>.</p>` },
                    rules: [{ key: "GrantItem", uuid: hazard.deafened, flag: "vibratoDeafened", allowDuplicate: true, onDeleteActions: { grantee: "cascade" } }] } }]);
            record.recipientUuids = [...new Set([...(record.recipientUuids ?? []), actor.uuid])];
        }
    }
    /** A mode area's size changed (Control Sand's sandstorm: 5 → 30 feet): the region's circle around its centre (the following radius too). */
    async resizeArea({ castId, feet }) {
        this.ongoing.assertCoordinator();
        const journal = this.ongoing.find(castId);
        const record = journal ? state(journal) : null;
        const region = record?.regionUuid ? await fromUuid(record.regionUuid) : null;
        const shape = region?.shapes?.[0];
        if (!shape) throw Error("The spell's area has no region to resize.");
        const followed = region.flags?.[MODULE_ID]?.followToken ? await fromUuid(region.flags[MODULE_ID].followToken) : null;
        const size = canvas.scene.grid.size, pixels = (Number(feet) / canvas.scene.grid.distance + (followed ? Number(followed.width ?? 1) / 2 : 0)) * size;
        const shapes = foundry.utils.deepClone(region.shapes.map(entry => entry.toObject?.() ?? entry));
        shapes[0].radius = pixels;
        await region.update({ shapes, ...(followed ? { [`flags.${MODULE_ID}.followRadius`]: pixels } : {}) });
        return { feet: Number(feet) };
    }
    async syncMemberCondition(record, members) {
        const held = record.declaration?.memberCondition;
        if (!held) return;
        record.memberConditions = Array.isArray(record.memberConditions) ? record.memberConditions : [];
        const inside = new Set(members.map(member => member.actorUuid));
        for (const { actorUuid, effectUuid } of record.memberConditions.filter(entry => !inside.has(entry.actorUuid))) {
            const effect = await fromUuid(effectUuid);
            if (effect) await effect.delete({ [MODULE_ID]: { ongoingCleanup: true, skipSequence: true, skipCascade: true, reason: "left-area" } });
            record.memberConditions = record.memberConditions.filter(entry => entry.actorUuid !== actorUuid);
            const entry = record.entries.find(candidate => candidate.uuid === effectUuid);
            if (entry) { entry.status = "ended"; entry.reason = "left-area"; }
        }
        const template = game.pf2e.ConditionManager.getCondition(held.slug);
        if (!template) throw Error(`PF2e condition ${held.slug} is unavailable.`);
        const uuid = template._stats?.compendiumSource ?? `Compendium.pf2e.conditionitems.Item.${template.id}`;
        for (const actorUuid of inside) {
            if (record.memberConditions.some(entry => entry.actorUuid === actorUuid)) continue;
            const actor = await fromUuid(actorUuid);
            if (!actor) continue;
            const label = `${template.name}${held.value ? ` ${held.value}` : ""}`;
            const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${label}`, type: "effect", img: template.img,
                flags: { [MODULE_ID]: { lingeringMemberCondition: record.castId } },
                system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, level: { value: record.rank },
                    description: { value: `<p>${escapeHTML(label)} while <strong>${escapeHTML(record.name)}</strong> lasts.</p>` },
                    // (A held value the creature "can't reduce" is restricted: PF2e won't lower or remove it while this lasts.)
                    rules: [{ key: "GrantItem", uuid, flag: "memberCondition", allowDuplicate: true, onDeleteActions: { granter: "cascade", grantee: held.locked ? "restrict" : "cascade" },
                        ...(held.value ? { alterations: [{ mode: "override", property: "badge-value", value: held.value }] } : {}) }] } }]);
            record.memberConditions.push({ actorUuid, effectUuid: effect.uuid });
            record.entries.push({ uuid: effect.uuid, actorUuid, status: "active", permanent: false });
        }
    }
    async lingeringMembership(record) {
        const caster = await fromUuid(record.sourceActorUuid);
        const casterTokens = caster?.getActiveTokens?.() ?? [];
        // Token updates reconcile before the canvas finishes animating: test the
        // document's own centre, and let emanation distances wait for movement.
        const moving = canvas.tokens.placeables.map(token => token.movementAnimationPromise).filter(promise => typeof promise?.then === "function");
        await Promise.race([Promise.all(moving), new Promise(resolve => setTimeout(resolve, 1500))]);
        let inside;
        if (record.declaration.centre === "targets") {
            // The cast's targets, while their tokens are on the scene.
            inside = (record.declaration.targetTokenUuids ?? []).map(uuid => canvas.tokens.placeables.find(token => token.document.uuid === uuid)).filter(token => token?.actor);
            // (Or the creatures adjacent to them, not the targets themselves: Gleaming Pet.)
            if (record.declaration.aura) {
                const centres = inside;
                // (Rallying Banner: the bearer too.)
                inside = canvas.tokens.placeables.filter(token => token.actor && (record.declaration.aura.includeTargets || !centres.includes(token)) && centres.some(centre => tokenDistance(centre, token) <= record.declaration.aura.feet));
            }
        } else if (record.declaration.centre === "placed") {
            // In any of the spell's areas.
            const regions = await Promise.all((record.regionUuids ?? [record.regionUuid]).map(uuid => fromUuid(uuid)));
            if (regions.some(region => !region)) return null;
            inside = canvas.tokens.placeables.filter(token => {
                const centre = token.document.getCenterPoint?.() ?? token.center;
                return token.actor && regions.some(region => region.testPoint({ x: centre.x, y: centre.y, elevation: token.document.elevation ?? 0 }));
            });
        } else {
            // (Odious Token: "The spell then treats the ally as you" — the emanation around the ally the token was hurled to.)
            const centreActor = record.declaration.centreActorUuid ? await fromUuid(record.declaration.centreActorUuid).catch(() => null) : null;
            const centreTokens = centreActor ? centreActor.getActiveTokens?.() ?? [] : casterTokens;
            if (centreTokens.length !== 1) return null;
            inside = canvas.tokens.placeables.filter(token => token.actor && token.id !== centreTokens[0].id && tokenDistance(centreTokens[0], token) <= record.declaration.area.value);
        }
        if (record.declaration.excludeCaster) inside = inside.filter(token => token.actor?.uuid !== record.sourceActorUuid);
        // ("Additionally, you're immune to the spell": the caster and the ally holding it.)
        if (record.declaration.excludeActorUuids?.length) inside = inside.filter(token => !record.declaration.excludeActorUuids.includes(token.actor?.uuid));
        // (Divine Eclipse: the blessed, and creatures in a blessed one's bright light, aren't in the dark.)
        if (record.declaration.blessed?.tokenUuids?.length) {
            const lit = canvas.tokens.placeables.filter(token => record.declaration.blessed.tokenUuids.includes(token.document.uuid));
            inside = inside.filter(token => !lit.includes(token) && !lit.some(light => tokenDistance(light.document, token.document) <= record.declaration.blessed.bright));
        }
        // "Each enemy that …": the caster and its allies are never exposed; neutral creatures
        // are, and their save card asks the GM whether they're enemies.
        if (record.declaration.enemiesOnly) inside = inside.filter(token => token.actor?.uuid !== record.sourceActorUuid && !caster?.isAllyOf?.(token.actor));
        // "living creatures in its area": the undead and constructs never exposed.
        if (record.declaration.livingOnly) inside = inside.filter(token => validateActorTarget({ supportsActorTargets: true, complete: true, predicates: [{ kind: "living-creature" }] }, token.actor).eligible);
        return inside.map(token => ({ actorUuid: token.actor.uuid, tokenUuid: token.document.uuid, name: token.name }));
    }
    async startAura(item, declaration) {
        this.ongoing.assertCoordinator();
        if (!game.user.isGM || !Number.isFinite(declaration.radius) || declaration.radius <= 0
            || !Number.isFinite(declaration.durationSeconds) || declaration.durationSeconds <= 0
            || declaration.frequency !== "once-per-round" || !Array.isArray(declaration.events)
            || !declaration.events.length || declaration.events.some(event => !["enter", "turn-start"].includes(event))
            || item.system.defense?.save?.basic !== true) throw Error("This custom aura needs an explicit basic-save, radius, duration, enter/turn-start trigger and once-per-round declaration.");
        this.plan(item, "aura");
        const journal = await this.ongoing.begin({ castId: randomID(), name: item.name, kind: "aura", sourceActorUuid: item.actor.uuid,
            sourceItemUuid: item.uuid, rank: item.rank, recipientUuids: [], recipients: [], exposure: [], members: [], declaration: clone(declaration),
            maximumAt: game.time.worldTime + declaration.durationSeconds });
        await this.ongoing.activate(journal);
        return { status: "prepared", castId: state(journal).castId };
    }
    async auraMembership(record) {
        const caster = await fromUuid(record.sourceActorUuid);
        const tokens = caster?.getActiveTokens?.() ?? [];
        if (tokens.length !== 1) return null;
        return canvas.tokens.placeables.filter(token => token.actor && token.id !== tokens[0].id
            && tokenDistance(tokens[0], token) <= record.declaration.radius).map(token => ({ actorUuid: token.actor.uuid, tokenUuid: token.document.uuid, name: token.name }));
    }

    async prepareSave(journal, targets, key, recurring = false, event = null) {
        const record = clone(state(journal));
        const existing = record.obligations.find(o => o.key === key);
        if (existing?.cardId) return game.messages.get(existing.cardId);
        const spell = await castSpellFromUuid(record);
        if (!spell) throw Error("The original spell is unavailable. Review the cast.");
        // (One save a round per creature; "only once per turn" — Ephemeral Hazards — one a turn.)
        const clock = this.ongoing.clock();
        const exposureKey = target => record.declaration?.oncePerTurn ? `${clock.combatId}:${clock.round}:${clock.turn ?? 0}:${actorOf(target).uuid}` : `${clock.combatId}:${clock.round}:${actorOf(target).uuid}`;
        const eligible = targets.filter(target => record.kind === "petrify" || !record.exposure.some(e => e.key === exposureKey(target)));
        if (!eligible.length) return null;
        // (Indolent Haze: a creature already unconscious at this exposure takes the sleepers' damage, whatever its save.)
        if (record.kind === "lingering" && record.declaration?.sleeperDamage?.events?.includes(event ?? "initial"))
            record.sleeperResults = [...(record.sleeperResults ?? []), ...await this.applySleeperDamage(record, eligible)];
        // (Dread Mosquito Storm: the bites' damage at this exposure, before the save.)
        if (record.kind === "lingering" && record.declaration?.exposureDamage?.events?.includes(event ?? "initial"))
            record.exposureResults = [...(record.exposureResults ?? []), ...await this.applyExposureDamage(record, eligible)];
        record.recipientUuids = [...new Set([...(record.recipientUuids ?? []), ...eligible.map(target => actorOf(target).uuid)])];
        const ownership = {};
        for (const user of game.users) if (!user.isGM && eligible.some(target => actorOf(target).testUserPermission(user, "OWNER"))) ownership[`ownership.${user.id}`] = 2;
        if (Object.keys(ownership).length) await journal.update(ownership);
        const { card } = await this.saves.start(spell, { plan: record.kind === "lingering" ? clone(event === "sustain" && record.sustainExposurePlan ? record.sustainExposurePlan : event === "enter" && record.enterExposurePlan ? record.enterExposurePlan
            : ["turn-start", "turn-end"].includes(event) && record.turnExposurePlan ? record.turnExposurePlan : record.exposurePlan) : this.plan(spell, record.kind, recurring), sourceActor: spell.actor,
            targets: eligible, castRank: record.rank, dc: record.dc, skipConfirmation: true, ...(record.casterChoice ? { casterChoice: record.casterChoice } : {}),
            ...(record.kind === "lingering" ? { lingeringCastId: record.castId } : {}),
            // (The cast's spellshapes and catalysts — Broken Ram's Thorn — on the cast's own save, not the later exposures.)
            ...(record.kind === "lingering" && (event ?? "initial") === "initial" && record.sourceMessageId ? { shapeMessageId: record.sourceMessageId } : {}),
            // (Blade Barrier: a creature that succeeds as the wall is created moves out of it — the area's shapes, on the cast's own saves only.)
            ...(record.kind === "lingering" && (event ?? "initial") === "initial" && record.regionUuid ? { exitArea: ((await fromUuid(record.regionUuid).catch(() => null))?.shapes ?? []).map(shape => shape.toObject?.() ?? shape) } : {}) });
        await card.setFlag(MODULE_ID, "ongoingCastId", record.castId);
        record.dc ??= card.getFlag(MODULE_ID, "basicSaveState").dc;
        if (existing) { existing.cardId = card.id; existing.status = "collecting"; }
        else addObligation(record, { key, actorUuid: actorOf(eligible[0]).uuid, tokenUuid: eligible[0].documentName === "Token" ? eligible[0].uuid : null, kind: "save", label: recurring ? "Recurring save" : "Initial save", cardId: card.id, status: "collecting", recurring });
        if (record.kind !== "petrify") for (const target of eligible) record.exposure.push({ key: exposureKey(target), cardId: card.id });
        await this.ongoing.save(journal, record);
        return card;
    }
    hasSave(cardId) { return this.ongoing.records().some(j => state(j).obligations.some(o => o.cardId === cardId)); }
    assertSave(cardId) {
        const journal = this.ongoing.records().find(j => state(j).obligations.some(o => o.cardId === cardId));
        if (journal && state(journal).status !== "active") throw Error("This ongoing cast is not active. Reconcile it before finalizing saves.");
        if (journal && state(journal).kind === 'condition-spell') this.conditions.assertSave(journal, cardId);
        if (journal && state(journal).kind === 'native') {
            const saveState = game.messages.get(cardId).getFlag(MODULE_ID,'basicSaveState');
            if (recurringObligation(journal, cardId)) assertRecurringSave(journal, cardId, saveState);
            else assertSickenedRecovery(journal,cardId,saveState);
        }
    }
    async finalizeSave(card, saveState) {
        const journal = this.ongoing.records().find(j => state(j).obligations.some(o => o.cardId === card.id));
        if (!journal) return;
        if (state(journal).kind === 'condition-spell') return this.conditions.finalize(journal, card, saveState);
        if (state(journal).kind === 'native') return recurringObligation(journal, card.id)
            ? finalizeRecurringSave(this, journal, card, saveState) : finalizeSickenedRecovery(this,journal,card,saveState);
        const record = clone(state(journal)), obligation = record.obligations.find(o => o.cardId === card.id);
        if (obligation.status === "completed") throw Error("This recurring step already completed.");
        this.assertSave(card.id);
        record.status = "applying"; obligation.status = "applying"; await this.ongoing.save(journal, record);
        try {
            if (record.kind === "petrify") for (const target of saveState.targets) {
                const recipient = record.recipients.find(r => r.actorUuid === target.actorUuid);
                if (target.excluded || target.eligible === false) {
                    // Skipping a recurring save does not remove the already confirmed condition.
                    if (!obligation.recurring) recipient.status = "excluded";
                    continue;
                }
                const actor = await fromUuid(recipient.actorUuid);
                if (!actor) throw Error("The recurring-save target disappeared.");
                let progress;
                if (obligation.recurring) progress = petrifyProgress(recipient.value, target.degree, recipient.actionBudget);
                else progress = { value: { criticalSuccess: 0, success: 1, failure: 1, criticalFailure: 2 }[target.degree], end: target.degree === "criticalSuccess" ? "unaffected" : null };
                if (!obligation.recurring && ["failure", "criticalFailure"].includes(target.degree) && progress.value >= recipient.actionBudget) progress.end = "petrified";
                const previous = recipient.effectUuid && await fromUuid(recipient.effectUuid);
                if (previous) await previous.delete({ [MODULE_ID]: { ongoingCleanup: true, skipSequence: true } });
                for (const entry of record.entries.filter(e => e.uuid === recipient.effectUuid)) entry.status = "ended";
                recipient.value = progress.value;
                recipient.status = progress.end ?? (!obligation.recurring && target.degree === "success" ? "success-duration" : "recurring");
                if (progress.value > 0) {
                    const petrified = progress.end === "petrified";
                    const duration = recipient.status === "success-duration" ? { value: 1, unit: "rounds", expiry: "turn-start" } : { value: -1, unit: "unlimited", expiry: null };
                    const template = game.pf2e.ConditionManager.getCondition(petrified ? "petrified" : "slowed");
                    const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${petrified ? "Petrified" : `Slowed ${progress.value}`}`, type: "effect", img: template.img,
                        flags: { [MODULE_ID]: { ongoingOperation: `${record.castId}:${obligation.key}`, runtime: { castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemName: record.name } } },
                        system: { duration, level: { value: record.rank }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, rules: [{ key: "GrantItem", uuid: template._stats.compendiumSource, allowDuplicate: true, flag: "condition", alterations: petrified ? [] : [{ mode: "override", property: "badge-value", value: progress.value }], onDeleteActions: { granter: "cascade", grantee: "cascade" } }] } }]);
                    recipient.effectUuid = effect.uuid;
                    record.entries.push({ uuid: effect.uuid, actorUuid: actor.uuid, status: "active", permanent: petrified, duration });
                    target.conditionResults = [{ label: petrified ? "Petrified permanently" : `Slowed ${progress.value}`, status: "applied", effectUuid: effect.uuid, duration }];
                    target.effectUuids = [effect.uuid];
                }
            }
            // "If an attack roll modified in this way results in a failure, …": a failed save leaves a control for that attack.
            if (record.kind === "lingering" && record.declaration?.failedAttackDamage) for (const target of saveState.targets) {
                if (target.excluded || target.eligible === false || !["failure", "criticalFailure"].includes(target.degree)) continue;
                record.failedAttacks = [...(record.failedAttacks ?? []).filter(entry => entry.actorUuid !== target.actorUuid),
                    { actorUuid: target.actorUuid, tokenUuid: target.tokenUuid ?? null, name: target.name ?? (await fromUuid(target.actorUuid))?.name ?? "creature" }];
            }
            // "When a metal creature takes damage from the cloud, …": it rusts (the persistent damage at the cast rank) and the area grows.
            const rust = record.kind === "lingering" ? record.declaration?.traitRust : null;
            if (rust) for (const target of saveState.targets) {
                if (target.excluded || target.eligible === false || !(target.damageResults ?? []).some(result => result.receipt?.damage > 0)) continue;
                const actor = await fromUuid(target.actorUuid);
                if (!actor || !(actor.traits?.has?.(rust.trait) ?? (actor.system?.traits?.value ?? []).includes(rust.trait))) continue;
                const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
                const roll = await new DamageRoll(`(${rust.formula.replace(/@item\.(?:level|rank)\b/g, String(Number(record.rank)))})[persistent,${rust.type}]`).evaluate();
                const token = target.tokenUuid ? await fromUuid(target.tokenUuid) : actor.getActiveTokens?.()?.[0]?.document;
                await applyDamageWithReceipt(actor, { damage: roll, token, item: (await castSpellFromUuid(record)) ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
                const grow = Math.min(rust.feet, rust.maxRadius - Number(record.declaration.area.value));
                if (grow > 0) await this.growRegion(record, grow);
                try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), content: `<p><strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} starts to rust (${escapeHTML(roll.formula)})${grow > 0 ? `; the cloud grows to a ${record.declaration.area.value}-foot burst` : ""}.</p>` }); } catch (_) {}
            }
            // "The target treats the length of the bridge as difficult terrain.": the area is difficult terrain for that creature (the region's per-creature cost).
            const rowTerrain = record.kind === "lingering" ? record.declaration?.rowTerrain : null;
            if (rowTerrain) for (const target of saveState.targets) {
                if (target.excluded || target.eligible === false || !rowTerrain.degrees.includes(target.degree)) continue;
                await this.addRowTerrain(record, target.actorUuid);
            }
            // "on future Will saves against the hazards, the creature continues to use this result unless it rolls a critical success": PF2e's degree
            // adjustment on its saves against this spell (a failure or worse becomes a success) while the spell lasts.
            const lock = record.kind === "lingering" ? record.declaration?.successLock : null;
            if (lock) for (const target of saveState.targets) {
                if (target.excluded || target.eligible === false || target.degree !== "success") continue;
                const actor = await fromUuid(target.actorUuid), spell = await castSpellFromUuid(record);
                if (!actor || actor.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.successLock?.castId === record.castId)) continue;
                const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: sees through them`, type: "effect", img: "icons/svg/eye.svg",
                    flags: { [MODULE_ID]: { successLock: { castId: record.castId }, runtime: { schema: 1, kind: "lingering", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name } } },
                    system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                        description: { value: `<p>${escapeHTML(lock.sourceText.replace(/^Success /, ""))}</p>` },
                        rules: [{ key: "AdjustDegreeOfSuccess", selector: lock.statistic, predicate: [`item:slug:${spell?.slug ?? ""}`], adjustment: { failure: "to-success", criticalFailure: "to-success" } }] } }]);
                record.entries.push({ uuid: effect.uuid, actorUuid: actor.uuid, status: "active", permanent: false });
            }
            // A save with no damage (a degree-save area) is an exposure whatever the result.
            const damaging = record.kind !== "lingering" || record.exposurePlan?.resolution?.sharedDamage != null;
            if (record.kind !== "petrify" && damaging) for (const target of saveState.targets) {
                const tookDamage = (target.damageResults ?? []).some(result => result.receipt?.damage > 0);
                if (!tookDamage) record.exposure = record.exposure.filter(e => !(e.key.endsWith(`:${target.actorUuid}`) && e.cardId === card.id));
            }
            obligation.status = "completed"; record.status = "active"; record.nextSaveAt = record.kind === "petrify" && record.recipients.some(r => r.status === "recurring") ? game.time.worldTime + 6 : null;
            await this.ongoing.save(journal, record);
            // "You are Stunned 1 and the spell ends.": a result whose row ends the spell ends the cast.
            if (record.kind === "lingering" && saveState.targets.some(target => !target.excluded && target.eligible !== false && (saveState.outcomes?.[target.degree]?.endsSpell === true
                || (saveState.criticalEndsSpell === true && target.degree === "criticalSuccess"))))
                await this.ongoing.end(journal, { reason: "outcome-ends-spell" });
            else await this.endAfterGmAction(journal);
        } catch (error) { await this.ongoing.review(journal, `Recurring outcome interrupted: ${error.message}`); throw error; }
    }
    /**
     * Sustain for a sustained degree save's native outcome record. It keeps its own
     * clock (`sustainClock`) so the recurring-save steps still see theirs. Returns
     * true when the cast ended or needs review.
     */
    async reconcileSustainedNative(journal, record, { recover }) {
        const clock = this.ongoing.clock();
        if (record.maximumAt != null && clock.worldTime >= record.maximumAt) { await this.ongoing.end(journal, { reason: "maximum-duration" }); return true; }
        const previous = record.sustainClock ?? null;
        const advance = turnAdvance(previous, clock);
        if (recover && (previous?.started || clock.started) && advance !== "same") {
            await this.ongoing.review(journal, "Turns changed while this coordinator was unavailable. Confirm whether the spell was sustained before continuing.", { resumable: true });
            return true;
        }
        const data = clone(record);
        if (advance === "next" && mustSustain(data) && previous.actorUuid === data.sourceActorUuid && previous.round > data.castRound
            && data.sustainedRound !== previous.round) { await this.ongoing.end(journal, { reason: "missed-sustain" }); return true; }
        const started = clock.started && !previous?.started;
        if ((advance === "next" || started) && clock.actorUuid === data.sourceActorUuid && clock.round > data.castRound)
            addObligation(data, { key: boundaryKey(clock, data.sourceActorUuid, "sustain"), kind: "sustain", label: data.growth?.optional ? `Optional Sustain to expand ${data.name}` : "Sustain before this turn ends, or its conditions end" });
        data.sustainClock = clock;
        await this.ongoing.save(journal, data);
        return false;
    }
    async reconcile(journal, record, { clockEvent, recover }) {
        if (record.kind === 'condition-spell') return this.conditions.reconcile(journal, record, { clockEvent, recover });
        const clock = this.ongoing.clock();
        const caster = await fromUuid(record.sourceActorUuid);
        if (!caster) return this.ongoing.review(journal, "The caster is missing. Token deletion or disconnection does not by itself end this spell.");
        if (record.kind === "floating-flame" && !await fromUuid(record.regionUuid)) return this.ongoing.review(journal, "The flame area is missing. Review its placement before continuing.");
        if (!await castSpellFromUuid(record)) return this.ongoing.review(journal, "The original spell is missing. The durable cast remains available for GM review.");
        if (record.kind === "floating-flame" && (caster.statuses.has("dead") || caster.hasCondition("unconscious"))) return this.ongoing.end(journal, { reason: "caster-cannot-sustain" });
        for (const recipient of record.recipients ?? []) if (!await fromUuid(recipient.actorUuid)) return this.ongoing.review(journal, "A recipient is missing. Review its last confirmed state before continuing.");
        if (record.obligations.some(o => o.kind === "save" && o.status === "collecting" && !game.messages.get(o.cardId))) return this.ongoing.review(journal, "A pending save card disappeared. Review its outcome; no replacement save was rolled.");
        if (record.maximumAt != null && clock.worldTime >= record.maximumAt) return this.ongoing.end(journal, { reason: "maximum-duration" });
        const advance = turnAdvance(record.clock, clock);
        if (recover && (record.clock?.started || clock.started) && advance !== "same") return this.ongoing.review(journal, "Turns changed while this coordinator was unavailable. Review missed saves or Sustain before continuing.", { resumable: true });
        if (clockEvent && ["jump", "backward", "unknown"].includes(advance) && (record.kind === "petrify" || record.kind === "floating-flame") && clock.started) {
            return this.ongoing.review(journal, "Turn order jumped, moved backward, or changed. Review unresolved obligations in order.", { resumable: true });
        }
        if (record.kind === "lingering") {
            if (record.regionUuid && !record.regionUuids && !await fromUuid(record.regionUuid)) return this.ongoing.end(journal, { reason: "area-removed" });
            if (record.regionUuids) {
                // Every area removed ends the spell; only some removed is the GM's to review.
                const present = await Promise.all(record.regionUuids.map(uuid => fromUuid(uuid)));
                if (present.every(region => !region)) return this.ongoing.end(journal, { reason: "area-removed" });
                if (present.some(region => !region)) return this.ongoing.review(journal, "One of the spell's areas was removed. Review its placement before continuing.", { resumable: true });
            }
            if (record.declaration.endsAt === "caster-turn-start" && clock.started && clock.actorUuid === record.sourceActorUuid && clock.round > record.castRound)
                return this.ongoing.end(journal, { reason: "duration" });
            // "The spell ends for a creature when its persistent damage ends." The additional save at the end of its turn comes before its recovery
            // roll, so the turn that just ended still exposes it, and a pending save is finished first.
            if (record.declaration.endsWithPersistent) {
                const target = await fromUuid(record.declaration.targetTokenUuids?.[0]);
                const turnJustEnded = advance === "next" && record.clock?.actorUuid === target?.actor?.uuid;
                const pending = record.obligations.some(o => ["membership", "save"].includes(o.kind) && !["completed", "skipped"].includes(o.status));
                if ((!target?.actor || !hasPersistentDamage(target.actor, record.declaration.endsWithPersistent)) && !turnJustEnded && !pending)
                    return this.ongoing.end(journal, { reason: "persistent-damage-ended" });
            }
            const members = await this.lingeringMembership(record);
            if (!members) return this.ongoing.review(journal, "The lingering area's membership can't be determined on the active scene. GM review is required.", { resumable: true });
            // "When you end your turn on the path, you gain the Quickened condition until the end of your next turn …" (Glacial Causeway): the
            // caster's token in the area as its turn ends.
            // "… at the start of each of your turns" (Soothing Blossoms): the occupants' assisted recovery as the caster's turn begins.
            const startKey = `caster-turn-start:${clock.combatId}:${clock.round}:${clock.turn ?? 0}`;
            if (record.declaration.assistedRecovery && clock.started && clock.actorUuid === record.sourceActorUuid && !record.exposure.some(entry => entry.key === startKey)) {
                record.exposure.push({ key: startKey, event: "caster-turn-start", actorUuid: record.sourceActorUuid });
                await this.assistedRecovery(record, members);
                await this.ongoing.save(journal, record);
            }
            const turnEnd = record.declaration.casterTurnEnd;
            const turnEndKey = `caster-turn-end:${record.clock?.combatId}:${record.clock?.round}:${record.clock?.turn ?? 0}`;
            if (turnEnd && advance === "next" && record.clock?.actorUuid === record.sourceActorUuid && members.some(member => member.actorUuid === record.sourceActorUuid)
                && !record.exposure.some(entry => entry.key === turnEndKey)) {
                record.exposure.push({ key: turnEndKey, event: "caster-turn-end", actorUuid: record.sourceActorUuid });
                const initiative = game.combat?.combatants?.find(combatant => combatant.actor?.uuid === record.sourceActorUuid)?.initiative ?? null;
                await caster.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${turnEnd.label}`, type: "effect", img: "icons/svg/wing.svg",
                    flags: { [MODULE_ID]: { runtime: { schema: 1, kind: "caster-turn-end", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemName: record.name } } },
                    system: { duration: { value: 1, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative },
                        rules: [{ key: "GrantItem", uuid: turnEnd.uuid, flag: "conditionGranted", allowDuplicate: true, onDeleteActions: { granter: "cascade", grantee: "cascade" } }],
                        description: { value: `<p>${escapeHTML(turnEnd.note)}</p>` } } }]);
                await this.ongoing.save(journal, record);
            }
            const events = record.declaration.events;
            // ("only once per turn", Diamond Dust: one exposure during each creature's turn — the combat's current turn.)
            const exposedThisRound = actorUuid => (record.declaration.oncePerRound && (record.exposure.some(e => e.key === `${clock.combatId}:${clock.round}:${actorUuid}`)
                || record.obligations.some(o => o.kind === "membership" && o.actorUuid === actorUuid && o.round === `${clock.combatId}:${clock.round}` && o.status !== "skipped")))
                || (record.declaration.oncePerTurn && record.obligations.some(o => o.kind === "membership" && o.actorUuid === actorUuid && o.status !== "skipped"
                    && new RegExp(`^lingering:[a-z-]+:${clock.combatId}:${clock.round}:${clock.turn ?? 0}:`).test(o.key)));
            const hazardHits = [];
            const expose = (member, event) => {
                // A hazard deals its damage itself, once per creature per trigger.
                if (record.declaration.hazardDamage || record.declaration.turnEffect) {
                    // ("A creature can take this damage only once per turn": one hit per turn, whatever the event; a turn's end belongs to the turn just ended.)
                    const turnOf = event === "turn-end" && record.clock ? record.clock : clock;
                    // ("only once per round", Flammable Fumes: one hit per creature each round, whichever event comes first.)
                    const key = record.declaration.hazardOncePerTurn ? `${turnOf.combatId}:${turnOf.round}:${turnOf.turn ?? 0}:once:${member.actorUuid}`
                        : record.declaration.hazardOncePerRound ? `${clock.combatId}:${clock.round}:round:${member.actorUuid}`
                        : `${clock.combatId}:${clock.round}:${clock.turn ?? 0}:${event}:${member.actorUuid}`;
                    if (record.exposure.some(e => e.key === key)) return;
                    record.exposure.push({ key, event, actorUuid: member.actorUuid });
                    hazardHits.push({ member, event });
                    return;
                }
                if (exposedThisRound(member.actorUuid) || this.heldBySpell(record, member.actorUuid)) return;
                // "the first time a creature enters … each round": one enter exposure per creature per round.
                if (event === "enter" && record.declaration.enterOncePerRound && record.obligations.some(o => o.kind === "membership" && o.actorUuid === member.actorUuid
                    && o.key.startsWith(`lingering:enter:${clock.combatId}:${clock.round}:`))) return;
                addObligation(record, { key: `lingering:${event}:${clock.combatId}:${clock.round}:${clock.turn ?? 0}:${member.actorUuid}`, kind: "membership", round: `${clock.combatId}:${clock.round}`, event,
                    label: record.declaration.reviewQuestion ? `${member.name} ended its turn: additional save. ${record.declaration.reviewQuestion}`
                        : `Review ${member.name}'s exposure (${event === "enter" ? "entered the area" : event === "turn-start" ? "started its turn in the area" : event === "round-start" ? "in the area as the round began" : "ended its turn in the area"})`,
                    actorUuid: member.actorUuid, tokenUuid: member.tokenUuid });
            };
            // The failed-attack control lasts as long as PF2e's Effect: until the end of that creature's turn.
            if (record.failedAttacks?.length && advance === "next")
                record.failedAttacks = record.failedAttacks.filter(entry => entry.actorUuid !== record.clock?.actorUuid);
            for (const member of members) {
                if (events.includes("enter") && !record.members.includes(member.tokenUuid)) expose(member, "enter");
                if ((advance === "next" || clock.started && !record.clock?.started) && events.includes("turn-start") && clock.actorUuid === member.actorUuid) expose(member, "turn-start");
                // At the start of each of the caster's turns (Spirit Link's transfer).
                if (advance === "next" && events.includes("source-turn-start") && clock.actorUuid === record.sourceActorUuid) expose(member, "source-turn-start");
                // At the end of each of the caster's turns (Sacred Nimbus's rain).
                if (advance === "next" && events.includes("source-turn-end") && record.clock?.actorUuid === record.sourceActorUuid) expose(member, "source-turn-end");
                if (advance === "next" && events.includes("turn-end") && record.clock?.actorUuid === member.actorUuid) expose(member, "turn-end");
                // "at the beginning of each round": every creature inside, when a round begins (combat starting is round 1's beginning).
                if (events.includes("round-start") && clock.started && (!record.clock?.started || Number(clock.round) > Number(record.clock.round ?? clock.round))) expose(member, "round-start");
            }
            // The caster is inside its own emanation (Manifest Will): its turn start too.
            if (record.declaration.turnEffect && record.declaration.includeCaster && advance === "next" && clock.actorUuid === record.sourceActorUuid) {
                const casterToken = (await fromUuid(record.sourceActorUuid))?.getActiveTokens?.()?.[0];
                if (casterToken) expose({ actorUuid: record.sourceActorUuid, tokenUuid: casterToken.document.uuid, name: casterToken.name }, "turn-start");
            }
            for (const hit of hazardHits) {
                if (record.declaration.turnEffect) {
                    try { const result = await this.applyTurnEffect(record, hit.member);
                        Object.assign(record.exposure.at(record.exposure.findLastIndex(e => e.actorUuid === hit.member.actorUuid && e.event === hit.event)), { status: result.status }); }
                    catch (error) { return this.ongoing.review(journal, `${record.name}: the Effect on ${hit.member.name} failed (${error.message}). Apply it yourself.`, { resumable: true }); }
                    continue;
                }
                try { const result = await this.applyHazardDamage(record, hit.member, hit.event);
                    Object.assign(record.exposure.at(record.exposure.findLastIndex(e => e.actorUuid === hit.member.actorUuid && e.event === hit.event)), { total: result.total }); }
                catch (error) { return this.ongoing.review(journal, `${record.name}: the hazard's damage on ${hit.member.name} failed (${error.message}). Apply it yourself.`, { resumable: true }); }
            }
            // "if you're ever at 0 Hit Points, spirit link ends automatically"
            if (record.declaration.endsAtZero && Number((await fromUuid(record.sourceActorUuid))?.system?.attributes?.hp?.value ?? 1) <= 0) {
                record.clock = clock; await this.ongoing.save(journal, record); return this.ongoing.end(journal, { reason: "caster-at-0-hp" });
            }
            // “until the end of the target's next turn”: the hazard ends once that turn (and its damage) is over.
            if (record.declaration.endsAt === "target-turn-end" && advance === "next" && record.clock?.actorUuid === record.declaration.targetActorUuid) {
                if (record.declaration.skipTurn) record.declaration.skipTurn = false;
                else { record.members = members.map(member => member.tokenUuid); record.clock = clock; await this.ongoing.save(journal, record); return this.ongoing.end(journal, { reason: "duration" }); }
            }
            // (Vibrant Vibrato: a creature that failed and is no longer inside hears the shattering sound.)
            if (record.declaration.hazardDamage?.remembered) {
                try { await this.rememberedLeave(record, members); }
                catch (error) { return this.ongoing.review(journal, `${record.name}: the shattering sound failed (${error.message}). Apply it yourself.`, { resumable: true }); }
            }
            // "until it leaves the area": a creature no longer inside loses this area's penalties.
            await this.clearLeaveArea(record, [...members.map(member => member.actorUuid), ...(record.declaration.memberEffect?.allies && record.declaration.centre === "caster" ? [record.sourceActorUuid] : [])]);
            record.members = members.map(member => member.tokenUuid);
            // (A creature that left hasn't stayed the full duration.)
            if (Array.isArray(record.stayers)) record.stayers = record.stayers.filter(actorUuid => members.some(member => member.actorUuid === actorUuid));
            await this.syncLingeringConcealment(record, members);
            await this.syncHealingWatch(record, members);
            await this.syncLingeringMembers(record, members);
            await this.syncBlessed(record);
            await this.syncMemberCondition(record, members);
            // ("until the start of its next turn": the creature whose turn starts loses its row terrain.)
            if (record.declaration?.rowTerrain?.until === "next-turn-start" && advance === "next" && (record.rowTerrainHolders ?? []).includes(clock.actorUuid)) await this.clearRowTerrain(record, clock.actorUuid);
            // (The creature whose turn just ended: an Effect granted on ending a turn inside.)
            record.turnEndedActor = advance === "next" ? record.clock?.actorUuid ?? null : null;
            await this.syncMemberEffect(record, members);
            delete record.turnEndedActor;
            await this.syncLantern(record, members);
            await this.syncRadiant(record, members);
            await this.syncWeb(record, members);
            await this.syncAreaRules(record, members);
            if (record.declaration.radiant && (advance === "next" || (clock.started && !record.clock?.started))) await this.radiantTurnStart(record, clock.actorUuid, members);
        }
        if (record.kind === "aura") {
            const members = await this.auraMembership(record);
            if (!members) return this.ongoing.review(journal, "Aura membership cannot be suggested reliably on the active scene. GM review is required.", { resumable: true });
            for (const member of members) {
                const entered = !record.members.includes(member.tokenUuid) && record.declaration.events.includes("enter");
                const turnStart = advance === "next" && clock.actorUuid === member.actorUuid && record.declaration.events.includes("turn-start");
                if ((entered || turnStart) && !record.exposure.some(e => e.key === `${clock.combatId}:${clock.round}:${member.actorUuid}`)) addObligation(record, {
                    key: `aura:${clock.combatId}:${clock.round}:${member.actorUuid}`, kind: "membership", label: `Review ${member.name}'s aura exposure`, actorUuid: member.actorUuid, tokenUuid: member.tokenUuid
                });
            }
            record.members = members.map(member => member.tokenUuid);
        }
        if (advance === "next" && record.kind === "floating-flame" && record.clock.actorUuid === record.sourceActorUuid
            && record.obligations.some(o => o.kind === "flame-path" && o.status === "pending")) {
            return this.ongoing.review(journal, "A sustained flame path was not resolved before the turn ended. Reconcile that exposure manually; it cannot be attributed to a later round.");
        }
        // Combat starting on the caster's turn is also a turn the caster must Sustain on (spells cast before initiative).
        const combatStarted = clock.started && !record.clock?.started;
        if (advance === "next" || combatStarted) {
            if (sustainable(record) && clock.actorUuid === record.sourceActorUuid && clock.round > record.castRound) {
                addObligation(record, { key: boundaryKey(clock, record.sourceActorUuid, "sustain"), kind: "sustain", label: record.kind === "bless" ? "Optional Sustain to expand Bless" : record.growth?.optional || record.declaration?.optionalSustain ? `Optional Sustain to expand ${record.name}` : "Sustain before this turn ends" });
            }
        }
        if (advance === "next") {
            if (record.kind === "petrify") for (const recipient of record.recipients.filter(r => r.status === "recurring" && r.actorUuid === record.clock.actorUuid)) {
                addObligation(record, { key: boundaryKey(record.clock, recipient.actorUuid, "turn-end"), kind: "save", label: `${record.name} — end-of-turn Fortitude save`, recurring: true, actorUuid: recipient.actorUuid });
            }
            if (mustSustain(record) && record.clock.actorUuid === record.sourceActorUuid && record.clock.round > record.castRound) {
                if (record.sustainedRound !== record.clock.round) return this.ongoing.end(journal, { reason: "missed-sustain" });
            }
        }
        if (!clock.started && dueWorldTime(record, clock.worldTime)) return this.ongoing.review(journal, "World time crossed an unresolved save or Sustain deadline. Review missed events in order; none were rolled automatically.", { resumable: true });
        for (const recipient of record.recipients ?? []) if (recipient.status === "recurring" && recipient.effectUuid && !await fromUuid(recipient.effectUuid)) recipient.status = "recovered";
        record.clock = clock; record.lastWorldTime = clock.worldTime;
        if (record.kind === "petrify" && record.recipients.every(r => !["initial", "recurring", "success-duration"].includes(r.status))) {
            record.status = "ended"; record.endedAt = clock.worldTime;
        }
        if (record.kind === "petrify") for (const recipient of record.recipients.filter(r => r.status === "success-duration")) {
            if (!await fromUuid(recipient.effectUuid)) recipient.status = "recovered";
        }
        if (record.kind === "bless" && record.entries.every(e => e.status === "ended" || e.detached)) record.status = "ended";
        await this.ongoing.save(journal, record);
    }
    async action(journal, action, data, user) {
        if (action === 'condition-retch' && state(journal).kind === 'native') return prepareSickenedRecovery(this,journal,data,user);
        if (state(journal).kind === 'condition-spell') return this.conditions.action(journal, action, data, user);
        const record = clone(state(journal)), clock = this.ongoing.clock();
        if (record.status !== "active") throw Error("This spell needs GM review before another action.");
        if (action === "review-targets") {
            if (!user.isGM) throw Error("The GM must confirm aura membership.");
            const obligation = record.obligations.find(o => o.key === data.key && o.kind === "membership" && o.status === "pending");
            if (!obligation) throw Error("This exposure was already reviewed.");
            if (!data.affected) { obligation.status = "skipped"; await this.ongoing.save(journal, record); await this.endAfterGmAction(journal); return { status: "unaffected" }; }
            const target = await fromUuid(obligation.tokenUuid);
            if (!target?.actor) throw Error("The aura target token is missing.");
            await this.prepareSave(journal, [target], `${obligation.key}:save`, false, obligation.event ?? null);
            const fresh = clone(state(journal)); fresh.obligations.find(o => o.key === data.key).status = "completed";
            await this.ongoing.save(journal, fresh); return { status: "prepared" };
        }
        if (action === "roll") {
            const obligation = record.obligations.find(o => o.key === data.key);
            if (!obligation || obligation.status === "completed") throw Error("This save is no longer pending.");
            const actor = await fromUuid(obligation.actorUuid ?? record.recipients[0]?.actorUuid);
            if (!user.isGM && !actor?.testUserPermission(user, "OWNER")) throw Error("You do not own this save target.");
            const recipient = record.recipients.find(r => r.actorUuid === actor.uuid);
            const tokenUuid = recipient?.tokenUuid ?? obligation.tokenUuid;
            const target = tokenUuid ? await fromUuid(tokenUuid) : actor;
            if (!target) throw Error("The saved target token is missing; review it before rolling.");
            const card = await this.prepareSave(journal, [target], obligation.key, obligation.recurring);
            return { status: "prepared", cardId: card.id };
        }
        if (action === "action-budget") {
            if (!user.isGM || record.kind !== "petrify" || !Number.isInteger(data.value) || data.value < 1) throw Error("The GM must confirm a positive action budget.");
            for (const recipient of record.recipients.filter(r => r.status === "recurring" || r.status === "initial")) recipient.actionBudget = data.value;
            await this.ongoing.save(journal, record); return { status: "updated" };
        }
        // Zombie Horde: the caster's thralls destroyed in the area — the burst grows by the stated feet for each, to its maximum.
        if (action === "thrall-growth") {
            const growth = record.declaration?.thrallGrowth;
            if (!growth) throw Error(`${record.name} doesn't grow.`);
            if (!user.isGM) throw Error("The GM reports the thralls destroyed.");
            // ("all of your thralls in the horde are destroyed": the caster's thrall tokens inside the area, destroyed and counted — or the GM's count.)
            let count = Number(data.count);
            if (data.auto) {
                const inside = await this.casterThrallsIn(record);
                for (const token of inside) await destroyThrall(token);
                count = inside.length;
                if (!count) return { status: "none", radius: Number(record.declaration.area?.value ?? 0) };
            }
            if (!Number.isInteger(count) || count < 1) throw Error("Give how many thralls were destroyed.");
            const now = Number(record.declaration.area?.value ?? 0), feet = Math.min(count * growth.feet, growth.maximum - now);
            if (feet <= 0) return { status: "at-maximum", radius: now };
            await this.growRegion(record, feet);
            await this.ongoing.save(journal, record);
            return { status: "grown", radius: record.declaration.area.value };
        }
        // Voracious Gestalt: a slain creature's soul added at the end of the caster's turn — the GM's call (the threat it posed); once a round, the
        // emanation grows and the turn damage gains a die.
        if (action === "soul-growth") {
            const growth = record.declaration?.soulGrowth, round = this.ongoing.clock().round;
            if (!growth) throw Error(`${record.name} doesn't grow.`);
            if (!user.isGM) throw Error("The GM decides whether a slain creature empowers it.");
            if (record.souledRound === round) throw Error(`${record.name} already grew this turn (only once, however many creatures were slain).`);
            await this.growRegion(record, growth.feet);
            record.souls = Number(record.souls ?? 0) + 1; record.souledRound = round;
            if (record.turnExposurePlan) record.turnExposurePlan = turnDamagePlan(record.turnExposurePlan, record.declaration.turnDamage, record.rank, record.souls * growth.dice);
            await this.ongoing.save(journal, record);
            return { status: "grown", radius: record.declaration.area.value, formula: record.turnExposurePlan?.resolution?.sharedDamage?.formula ?? null };
        }
        // Field of Razors: "If a creature takes slashing, piercing, or persistent bleed damage while inside …, you can spend a reaction to … [expand] the burst by
        // 5 feet. You can grow the area four times in this way": the caster's (or the GM's) report, the region grown, to the stated count.
        if (action === "region-growth") {
            const growth = record.declaration?.regionGrowth;
            if (!growth) throw Error(`${record.name} doesn't grow.`);
            const caster = await fromUuid(record.sourceActorUuid);
            if (!user.isGM && !caster?.testUserPermission?.(user, "OWNER")) throw Error("The caster (or the GM) grows the area.");
            const grown = Number(record.regionGrown ?? 0);
            if (grown >= growth.times) throw Error(`${record.name} has already grown ${growth.times} times (its maximum).`);
            await this.growRegion(record, growth.feet);
            record.regionGrown = grown + 1;
            await this.ongoing.save(journal, record);
            return { status: "grown", radius: record.declaration.area.value, left: growth.times - record.regionGrown };
        }
        // An optional growth (Conjured Clockwork): once a round, after that round's Sustain.
        if (action === "expand-area") {
            const growth = record.declaration?.sustainGrowth, round = this.ongoing.clock().round;
            if (!growth?.optional) throw Error(`${record.name} doesn't expand.`);
            if (record.sustainedRound !== round) throw Error(`${record.name}: Sustain it this round first.`);
            if (record.expandedRound === round) throw Error(`${record.name} was already expanded this round.`);
            // (Up to its stated maximum: "to a maximum of 60 feet".)
            if (growth.maximum && Number(record.declaration.area?.value ?? 0) + growth.feet > growth.maximum) throw Error(`${record.name} is already at its maximum of ${growth.maximum} feet.`);
            await this.growRegion(record, growth.feet);
            record.expandedRound = round;
            await this.ongoing.save(journal, record);
            return { status: "expanded", radius: record.declaration.area.value };
        }
        // "A creature who enters a square with an invisible mine triggers it, causing an explosion that deals … to the creature and every creature in a
        // 5-foot emanation from the mine's square.": one card for the creatures the GM targets; after the last mine the spell ends.
        if (action === "mine-exploded") {
            const mines = record.declaration?.mines;
            if (!user.isGM || !mines) throw Error("Only the GM reports a mine exploding.");
            const used = Number(record.minesUsed ?? 0);
            if (used >= mines.count) throw Error(`${record.name}: every mine has exploded.`);
            const tokens = (await Promise.all((data.tokenUuids ?? []).map(uuid => fromUuid(uuid)))).filter(token => token?.actor);
            if (!tokens.length) throw Error(`${record.name}: target the creatures the explosion catches.`);
            const spell = await castSpellFromUuid(record);
            if (!spell) throw Error(`${record.name}: the spell is unavailable.`);
            const plan = lingeringExposurePlan(heightenedPlanAt(await game.modules.get(MODULE_ID).api.compile(spell), record.rank));
            const { card } = await this.saves.start(spell, { plan, sourceActor: spell.actor, targets: tokens.map(token => token.object ?? token), castRank: record.rank, dc: record.dc ?? undefined, skipConfirmation: true });
            record.minesUsed = used + 1;
            await this.ongoing.save(journal, record);
            if (record.minesUsed >= mines.count) await this.ongoing.end(journal, { reason: "mines-spent" });
            return { status: "exploded", cardId: card.id, minesLeft: mines.count - record.minesUsed };
        }
        // "… takes 1d4 piercing damage per square traversed, with a basic Reflex save made at the end of each move action": the creature's save card for
        // the squares it moved through.
        if (action === "move-save") {
            const squares = Number(data.squares);
            if (!record.declaration?.moveSave || !Number.isInteger(squares) || squares < 1 || squares > 100) throw Error("Give the number of squares (1 or more) the creature moved through.");
            const token = await fromUuid(data.tokenUuid), spell = await castSpellFromUuid(record);
            if (!token?.actor || !spell) throw Error(`${record.name}: the creature or the spell is unavailable.`);
            const plan = moveSaveExposurePlan(await game.modules.get(MODULE_ID).api.compile(spell), squares, record.rank);
            if (!plan) throw Error(`${record.name}: the spell no longer has a move save.`);
            const { card } = await this.saves.start(spell, { plan, sourceActor: spell.actor, targets: [token.object ?? token], castRank: record.rank, dc: record.dc ?? undefined, skipConfirmation: true });
            return { status: "save", cardId: card.id, formula: plan.resolution.sharedDamage.formula };
        }
        // Hazardous terrain: a creature moved into this many squares of the area; each square is its own damage (PF2e's IWR on each).
        if (action === "hazard-move") {
            const move = record.declaration?.hazardMove;
            const squares = Number(data.squares);
            if (!move || !Number.isInteger(squares) || squares < 1 || squares > 100) throw Error("Give the number of squares (1 or more) the creature moved into.");
            const token = await fromUuid(data.tokenUuid), actor = token?.actor;
            const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
            if (!actor || !DamageRoll) throw Error(`${record.name}: the creature or PF2e's damage roll is unavailable.`);
            const base = Number((await castSpellFromUuid(record))?.system?.level?.value ?? record.rank);
            const amount = move.fixed && Number(record.rank) >= move.fixed.rank ? Number(move.fixed.value)
                : Number(move.formula) + (move.heightening ? Math.max(0, Math.floor((Number(record.rank) - base) / move.heightening.interval)) * move.heightening.increase : 0);
            const spell = await castSpellFromUuid(record);
            let lost = 0;
            for (let square = 0; square < squares; square++) {
                const roll = await new DamageRoll(`${amount}[${move.type}]`).evaluate();
                const before = Number(actor.system?.attributes?.hp?.value ?? 0) + Number(actor.system?.attributes?.hp?.temp ?? 0);
                await applyDamageWithReceipt(actor, { damage: roll, token, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
                lost += before - (Number(actor.system?.attributes?.hp?.value ?? 0) + Number(actor.system?.attributes?.hp?.temp ?? 0));
            }
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), flags: { [MODULE_ID]: { kind: "hazard-move", castId: record.castId, actorUuid: actor.uuid } },
                content: `<p><strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)} moved into ${squares} square${squares === 1 ? "" : "s"} of hazardous terrain: ${amount} ${escapeHTML(move.type)} damage each (${lost} Hit Points lost after resistances and weaknesses).</p>` }); } catch (_) {}
            return { status: "damaged", squares, amount, lost };
        }
        // A GM-triggered exposure (Bralani Referendum: the targeted creatures in the area inflicted a chosen condition): each one's save, once a
        // round.
        if (action === "gm-trigger") {
            const trigger = record.declaration?.gmTrigger;
            if (!user.isGM || !trigger?.chosen) throw Error("Only the GM triggers this area's save.");
            const members = await this.lingeringMembership(record);
            if (!members) throw Error(`${record.name}: the area's membership can't be determined on the active scene.`);
            const round = clock.started ? `${clock.combatId}:${clock.round}` : `time:${clock.worldTime}`;
            const added = [], refused = [];
            for (const uuid of data.tokenUuids ?? []) {
                const member = members.find(candidate => candidate.tokenUuid === uuid);
                if (!member) { refused.push({ tokenUuid: uuid, reason: "not in the area" }); continue; }
                if (clock.started && record.obligations.some(o => o.kind === "membership" && o.actorUuid === member.actorUuid && o.round === round && o.status !== "skipped")) {
                    refused.push({ tokenUuid: uuid, reason: "already took this damage this round" }); continue; }
                addObligation(record, { key: `lingering:gm-trigger:${round}:${member.actorUuid}`, kind: "membership", round, event: "gm-trigger",
                    label: `Review ${member.name}'s exposure (inflicted ${trigger.chosen.join(" or ")})`, actorUuid: member.actorUuid, tokenUuid: member.tokenUuid });
                added.push(member.actorUuid);
            }
            await this.ongoing.save(journal, record);
            return { status: added.length ? "exposed" : "none", added, refused };
        }
        // A creature tries to disbelieve the area (Visions of Danger): its Perception against the spell DC; a success exempts it while the area lasts.
        if (action === "area-disbelieve") {
            const disbelief = record.declaration?.disbelief;
            if (!user.isGM || !disbelief) throw Error("Only the GM runs this area's disbelief.");
            const results = [];
            for (const uuid of data.tokenUuids ?? []) {
                const token = await fromUuid(uuid), actor = token?.actor;
                if (!actor) continue;
                if (this.heldBySpell(record, actor.uuid)) { results.push({ actorUuid: actor.uuid, status: "already disbelieved" }); continue; }
                const roll = await actor.perception?.roll({ dc: { value: Number(record.dc) }, extraRollOptions: ["action:disbelieve"], skipDialog: true });
                if (roll) await disbeliefPain({ casterUuid: record.sourceActorUuid, itemUuid: record.sourceItemUuid ?? null, rank: record.rank ?? record.castRank, target: actor, spellName: record.name }).catch(() => null);
                const success = Number(roll?.degreeOfSuccess ?? 0) >= 2;
                if (success) await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: disbelieved`, type: "effect", img: "icons/svg/eye.svg",
                    flags: { [MODULE_ID]: { spellImmunity: { key: disbelief.key }, runtime: { castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid, sourceItemName: record.name } } },
                    system: { description: { value: disbelief.halves ? `<p>Disbelieved ${escapeHTML(record.name)}: it takes half the damage from the shadows, and they no longer impede its vision.</p>` : `<p>Disbelieved ${escapeHTML(record.name)}: it takes no damage from the illusion.</p>` }, level: { value: record.rank },
                        duration: { value: Math.max(1, Math.ceil((Number(record.maximumAt ?? game.time.worldTime) - game.time.worldTime) / 6)), unit: "rounds", expiry: "turn-start", sustained: false },
                        start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, rules: [] } }]);
                results.push({ actorUuid: actor.uuid, status: success ? "disbelieved" : "fooled", roll: roll?.total ?? null });
            }
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), content: `<p><strong>${escapeHTML(record.name)}</strong>: ${results.map(result => `${escapeHTML((game.actors.get(result.actorUuid?.split(".").pop())?.name) ?? "a creature")} ${result.status}`).join("; ")}.</p>` }); } catch (_) {}
            return { status: "resolved", results };
        }
        // A creature used an action on the area the module can't see (Hypnotize's Seek or Interact on the cloud): its exposure.
        // The GM's mark on a creature (Stars of Another Sky's top of the cylinder): an Effect dealing the stated damage as each of its turns starts, until the area ends.
        if (action === "gm-mark") {
            const mark = record.declaration?.gmMark;
            if (!user.isGM || !mark) throw Error("Only the GM marks a creature for this spell.");
            const tokens = (await Promise.all((data.tokenUuids ?? []).map(uuid => fromUuid(uuid)))).filter(token => token?.actor);
            if (!tokens.length) throw Error(`${record.name}: target the creature(s) first.`);
            const marked = [];
            for (const token of tokens) {
                const actor = token.actor;
                if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.gmMark === record.castId)) continue;
                const formula = data.soulless ? `(${mark.dice}*${mark.soulless})` : mark.dice;
                const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${record.name}: ${mark.label.replace(/^reached /, "at ")}`, type: "effect", img: "icons/svg/sun.svg",
                    flags: { [MODULE_ID]: { gmMark: record.castId, areaLifetime: { castId: record.castId }, runtime: { schema: 1, kind: "gm-mark", castInstanceId: record.castId, sourceActorUuid: record.sourceActorUuid,
                        sourceItemUuid: record.sourceItemUuid, sourceItemName: record.name, turnStartDamage: { formula, type: mark.type, ...(mark.diesAtZero ? { diesAtZero: true } : {}) } } } },
                    system: { level: { value: record.rank }, duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true }, rules: [],
                        description: { value: `<p>At the top of the cylinder: it takes ${escapeHTML(formula)} ${escapeHTML(mark.type)} damage as each of its turns starts${data.soulless ? " (no soul: double)" : ""}${mark.diesAtZero ? "; if this drops it to 0 Hit Points, it dies" : ""}. Remove this when it comes down.</p>` } } }]);
                record.entries.push({ uuid: effect.uuid, actorUuid: actor.uuid, status: "active", permanent: false });
                record.recipientUuids = [...new Set([...(record.recipientUuids ?? []), actor.uuid])];
                marked.push(actor.uuid);
            }
            await this.ongoing.save(journal, record);
            return { status: marked.length ? "marked" : "none", marked };
        }
        if (action === "gm-action") {
            const trigger = record.declaration?.gmAction;
            if (!user.isGM || !trigger) throw Error("Only the GM says a creature used that action.");
            const members = await this.lingeringMembership(record);
            if (!members) throw Error(`${record.name}: the area's membership can't be determined on the active scene.`);
            const round = clock.started ? `${clock.combatId}:${clock.round}:${clock.turn ?? 0}` : `time:${clock.worldTime}`;
            const tokens = (await Promise.all((data.tokenUuids ?? []).map(uuid => fromUuid(uuid)))).filter(token => token?.actor);
            const added = [], refused = [];
            for (const token of tokens) {
                const member = members.find(candidate => candidate.tokenUuid === token.uuid) ?? { actorUuid: token.actor.uuid, tokenUuid: token.uuid, name: token.name };
                if (this.heldBySpell(record, member.actorUuid)) { refused.push({ tokenUuid: token.uuid, reason: record.declaration.skipWhile ? `already ${record.declaration.skipWhile.slugs?.join(" or ") ?? record.declaration.skipWhile.slug}` : "immune to this casting" }); continue; }
                const key = `lingering:gm-action:${round}:${member.actorUuid}`;
                if (record.obligations.some(o => o.key === key)) { refused.push({ tokenUuid: token.uuid, reason: "already exposed for this action" }); continue; }
                addObligation(record, { key, kind: "membership", round, event: "gm-action",
                    label: `Review ${member.name}'s exposure (${trigger.label ?? `used ${trigger.actions.join(" or ")} on the area`})`, actorUuid: member.actorUuid, tokenUuid: member.tokenUuid });
                added.push(member.actorUuid);
            }
            await this.ongoing.save(journal, record);
            return { status: added.length ? "exposed" : "none", added, refused };
        }
        // A GM-triggered area's damage (Explosive Dust per square passed through; Tacky Pine Sap igniting under the targeted creatures).
        if (action === "gm-hazard") {
            const hazard = record.declaration?.gmHazard;
            if (!user.isGM || !hazard) throw Error("Only the GM triggers this area's damage.");
            const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
            const spell = await castSpellFromUuid(record);
            const tokens = (await Promise.all((data.tokenUuids ?? []).map(uuid => fromUuid(uuid)))).filter(token => token?.actor);
            if (!DamageRoll || !tokens.length) throw Error(`${record.name}: target the creature(s) first.`);
            // (A wall's damage per move action: the thorns, once for each move action into its spaces.)
            const counted = hazard.kind === "per-square" || hazard.perAction === true;
            const squares = counted ? Number(data.squares) : 1;
            if (counted && (tokens.length !== 1 || !Number.isInteger(squares) || squares < 1 || squares > 100)) throw Error(hazard.perAction ? "Target the one creature and give its move actions into the wall (1 or more)." : "Target the one enemy and give the squares it passed through (1 or more).");
            const results = [];
            for (const token of tokens) {
                let lost = 0;
                for (let square = 0; square < squares; square++) {
                    const roll = await new DamageRoll(hazard.formula).evaluate();
                    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), flavor: `${escapeHTML(record.name)}: ${escapeHTML(token.name)}${hazard.kind === "wall" ? ` ${escapeHTML(hazard.label)}` : ""}${squares > 1 ? ` (${hazard.perAction ? "move action" : "square"} ${square + 1} of ${squares})` : ""}` });
                    const before = Number(token.actor.system?.attributes?.hp?.value ?? 0) + Number(token.actor.system?.attributes?.hp?.temp ?? 0);
                    await applyDamageWithReceipt(token.actor, { damage: roll, token, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
                    lost += before - (Number(token.actor.system?.attributes?.hp?.value ?? 0) + Number(token.actor.system?.attributes?.hp?.temp ?? 0));
                }
                results.push({ actorUuid: token.actor.uuid, lost });
            }
            await this.ongoing.save(journal, record);
            // "this burns up the sap, removing it and its difficult terrain": the spell ends.
            if (hazard.endsSpell) await this.ongoing.end(journal, { reason: "hazard-spent" });
            return { status: "damaged", results, squares };
        }
        // The creature's attack rolled twice failed (or didn't): the item's damage at the cast rank, with PF2e's IWR.
        if (action === "failed-attack") {
            const damage = record.declaration?.failedAttackDamage;
            const entry = (record.failedAttacks ?? []).find(candidate => candidate.actorUuid === data.actorUuid);
            if (!damage || !entry) throw Error("This creature has no pending attack from this spell.");
            record.failedAttacks = record.failedAttacks.filter(candidate => candidate !== entry);
            if (data.failed === false) { await this.ongoing.save(journal, record); return { status: "cleared" }; }
            const actor = await fromUuid(entry.actorUuid), token = entry.tokenUuid ? await fromUuid(entry.tokenUuid) : null;
            const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
            if (!actor || !DamageRoll) throw Error(`${record.name}: the creature or PF2e's damage roll is unavailable.`);
            const steps = damage.heightening ? Math.max(0, Math.floor((Number(record.rank) - Number((await castSpellFromUuid(record))?.system?.level?.value ?? record.rank)) / damage.heightening.interval)) : 0;
            const formula = heightenedComponentFormula(damage.formula, damage.heightening?.dice, steps);
            const roll = await new DamageRoll(`${formula}[${damage.type}]`).evaluate();
            try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }),
                flavor: `<strong>${escapeHTML(record.name)}</strong>: ${escapeHTML(actor.name)}'s attack roll (rolled twice) failed`, flags: { [MODULE_ID]: { kind: "failed-attack", castId: record.castId, actorUuid: actor.uuid } } }); } catch (_) {}
            const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, item: (await castSpellFromUuid(record)) ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
            await this.ongoing.save(journal, record);
            return { status: "damaged", total: roll.total, formula, receipt };
        }
        if (action === "sustain") {
            if (!clock.started || clock.actorUuid !== record.sourceActorUuid || clock.round <= record.castRound) throw Error("Use Sustain on the caster's subsequent turn; outside combat requires GM timing review.");
            if (record.kind === "bless" && record.sustainedRound === clock.round) throw Error("This spell's Sustain benefit was already resolved this round.");
            if (record.obligations.some(o => o.kind === "save" && ["pending", "collecting", "applying"].includes(o.status))) throw Error("Resolve the previous save before sustaining again.");
            if (record.kind === "bless") {
                const effect = await fromUuid(record.entries[0]?.uuid);
                if (!effect) throw Error("The Bless Effect is missing.");
                record.status = "applying"; await this.ongoing.save(journal, record);
                try { await effect.update({ "system.badge.value": effect.system.badge.value + 1 }); }
                catch (error) { await this.ongoing.review(journal, `Sustain application interrupted: ${error.message}`); throw error; }
                record.status = "active";
            } else if (record.kind === "floating-flame") {
                const region = await fromUuid(record.regionUuid);
                if (!region) throw Error("The flame's area is missing.");
                const targets = await Promise.all((data.targetUuids ?? []).map(uuid => fromUuid(uuid)));
                if (targets.some(t => !t?.actor)) throw Error("Select valid target tokens.");
                // GM confirms the path and membership; the spell's once-per-round
                // exposure is enforced on actor identity, including repeated Sustain.
                if (!user.isGM) {
                    addObligation(record, { key: `flame-path:${clock.combatId}:${clock.round}:${record.sustainSequence ?? 0}`, kind: "flame-path", label: "GM: review the sustained flame's path and targets", targetUuids: data.targetUuids ?? [] });
                    record.sustainSequence = (record.sustainSequence ?? 0) + 1;
                    record.sustainedRound = clock.round; record.sustainDueAt = clock.worldTime + 6;
                    for (const o of record.obligations.filter(o => o.kind === "sustain" && o.status === "pending")) o.status = "completed";
                    await this.ongoing.save(journal, record); return { status: "awaiting-gm-path-review" };
                }
                if (!data.pathConfirmed) throw Error("A GM must confirm the flame moved at most 10 feet and the selected targets crossed its path.");
                await this.prepareSave(journal, targets, `sustain:${clock.combatId}:${clock.round}:${record.sustainSequence ?? 0}`);
                Object.assign(record, clone(state(journal)));
                record.position = clone(region.shapes);
                if (data.key) { const reviewed = record.obligations.find(o => o.key === data.key && o.kind === "flame-path"); if (reviewed) reviewed.status = "completed"; }
            } else if (record.kind === "native" && record.sustained) {
                // An animated object's commands: each Sustain gives more (once per round).
                if (record.commands && record.sustainedRound !== clock.round) record.commands.available += record.commands.perSustain;
                // "On subsequent rounds, the first time each round you Sustain the Spell, you can throttle the shadow …": a basic save card for the targets
                // that failed (the caster can leave it unfinalized).
                if (record.sustainStrike?.targetTokenUuids?.length && record.sustainedRound !== clock.round) {
                    const spell = await castSpellFromUuid(record);
                    const tokens = (await Promise.all(record.sustainStrike.targetTokenUuids.map(uuid => fromUuid(uuid)))).filter(token => token?.actor);
                    if (spell && tokens.length) {
                        const { card } = await this.saves.start(spell, { plan: clone(record.sustainStrike.plan), sourceActor: spell.actor, targets: tokens.map(token => token.object ?? token), castRank: record.rank, dc: record.dc, skipConfirmation: true });
                        record.sustainStrikeCards = [...(record.sustainStrikeCards ?? []), card.id];
                    }
                }
                // "The first time you Sustain the spell each turn, one of the target creature's allies within 30 feet of the target must attempt a … save"
                // (Warped Visage): the ally the caster names (or the only one there) gets the save card; with none in reach, nothing.
                if (record.sustainAllySave?.centreTokenUuids?.length && record.sustainedRound !== clock.round) {
                    const spec = record.sustainAllySave;
                    const centres = (await Promise.all(spec.centreTokenUuids.map(uuid => fromUuid(uuid)))).filter(token => token?.actor);
                    const eligible = canvas.scene.tokens.filter(token => token.actor && !centres.includes(token) && centres.some(centre =>
                        (centre.actor.isAllyOf?.(token.actor) ?? centre.actor.alliance === token.actor.alliance) && tokenDistance(centre, token) <= spec.radius));
                    const named = [...(data.allyTokenUuids ?? []), ...[...game.user.targets].map(target => target.document?.uuid)].filter(Boolean);
                    let ally = eligible.find(token => named.includes(token.uuid)) ?? (eligible.length === 1 ? eligible[0] : null);
                    if (!ally && eligible.length > 1) {
                        const picked = await foundry.applications.api.DialogV2.wait({ window: { title: `${record.name}: Sustain` }, rejectClose: false,
                            content: `<p>Which of the target's allies within ${spec.radius} feet must save?</p><select name="ally">${eligible.map(token => `<option value="${token.uuid}">${escapeHTML(token.name)}</option>`).join("")}</select>`,
                            buttons: [{ action: "ok", label: "Save", default: true, callback: (event, button) => button.form.elements.ally.value }] });
                        ally = eligible.find(token => token.uuid === picked) ?? null;
                    }
                    const spell = ally ? await castSpellFromUuid(record) : null;
                    if (spell && ally) {
                        const { card } = await this.saves.start(spell, { plan: clone(spec.plan), sourceActor: spell.actor, targets: [ally.object ?? ally], castRank: record.rank, dc: record.dc, skipConfirmation: true });
                        record.sustainAllyCards = [...(record.sustainAllyCards ?? []), card.id];
                    }
                }
                // "On subsequent turns, if the target is still immobilized by the lasso, you can Sustain the spell to deal … damage and keep the target
                // immobilized until the end of your next turn.": the flat damage to each creature this cast still holds, and its hold renewed.
                if (record.sustainHold?.targetActorUuids?.length && record.sustainedRound !== clock.round) {
                    const spec = record.sustainHold;
                    const DamageRoll = (CONFIG.Dice?.rolls ?? []).find(candidate => candidate?.name === "DamageRoll");
                    const caster = await fromUuid(record.sourceActorUuid), spell = await castSpellFromUuid(record);
                    record.sustainHoldResults ??= [];
                    for (const actorUuid of spec.targetActorUuids) {
                        const actor = await fromUuid(actorUuid);
                        const holds = (actor?.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.outcomeEffect?.castId === record.castId && effect.flags[MODULE_ID].outcomeEffect.escape && !effect.isExpired);
                        if (!actor || !holds.length) continue;
                        const amount = String(spec.formula).replace(/@item\.rank\b/g, String(Number(record.rank)));
                        const roll = await new DamageRoll(`(${amount})[${spec.type}]`).evaluate();
                        try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(record.name)}</strong>: Sustained — ${escapeHTML(actor.name)} is still held` }); } catch (_) {}
                        const token = actor.getActiveTokens?.()?.[0]?.document;
                        await applyDamageWithReceipt(actor, { damage: roll, token: token ?? undefined, item: spell ?? undefined, rollOptions: new Set(), skipIWR: false }, randomID());
                        // (The hold lasts to the end of the caster's next turn again: restarted now, on the caster's turn.)
                        for (const effect of holds) await effect.update({ "system.start.value": game.time.worldTime, "system.start.initiative": game.combat?.combatant?.initiative ?? null });
                        record.sustainHoldResults.push({ actorUuid, total: roll.total, round: clock.round });
                    }
                }
                // Palm-Held Sun: each Sustain pulses again (once a round).
                if (record.sunAura && record.sustainedRound !== clock.round) Promise.resolve().then(() => this.ongoing.sunPulse(record.castId)).catch(error => console.warn(`${MODULE_ID} | The pulse failed.`, error));
                // A spell shield: each Sustain recreates it if destroyed and raises it (Bone Shield).
                if (record.spellShield && record.sustainedRound !== clock.round) {
                    const caster = await fromUuid(record.sourceActorUuid);
                    if (caster) await ensureSpellShield(caster, record.spellShield);
                }
                // Sustaining keeps the conditions this cast applied. An aura that grows on Sustain ("the emanation's radius
                // increases by 5 feet, to a maximum of 30 feet") raises its Effect's badge, once per round, up to its maximum.
                if (record.growth) {
                    if (record.sustainedRound === clock.round) throw Error("This spell was already sustained this round.");
                    const effect = await fromUuid(record.entries.find(entry => entry.status === "active")?.uuid);
                    if (!effect) throw Error("The aura Effect is missing.");
                    const next = Math.min(Number(effect.system.badge?.value ?? 1) + 1, record.growth.badgeMax);
                    record.status = "applying"; await this.ongoing.save(journal, record);
                    try { if (next !== effect.system.badge?.value) await effect.update({ "system.badge.value": next }); }
                    catch (error) { await this.ongoing.review(journal, `Sustain growth interrupted: ${error.message}`); throw error; }
                    record.status = "active";
                }
            } else if (record.kind === "lingering" && (record.declaration?.sustained || record.declaration?.optionalSustain)) {
                // Sustaining keeps the area. "The first time you Sustain it each round" also
                // exposes every creature inside (after any move the spell allows), once per round.
                // (Shadow Puppetry: the first Sustain each turn deals the area's damage again.)
                if (record.declaration.sustainPulse && record.sustainedRound !== clock.round) Promise.resolve().then(() => this.ongoing.areaPulse(record.castId)).catch(error => console.warn(`${MODULE_ID} | The pulse failed.`, error));
                // An aura growing on an optional Sustain: once per round, the radius grows, then the enemies inside not yet affected
                // (without this cast's penalty Effect) save.
                if (record.declaration.growth) {
                    if (record.sustainedRound === clock.round) throw Error("This spell was already sustained this round.");
                    record.declaration.area.value = Number(record.declaration.area.value) + Number(record.declaration.growth.feet);
                    // (The lantern's light grows with it; the creatures now inside that haven't saved are asked on the reconcile.)
                    if (record.declaration.lantern) for (const entry of record.entries.filter(entry => entry.status === "active")) {
                        const light = await fromUuid(entry.uuid);
                        if (light?.flags?.[MODULE_ID]?.lanternLight) await light.update({ "system.rules": [lanternLightRule(record.declaration.area.value, record.declaration.lantern.light)] });
                    }
                }
                // "On subsequent turns, the first time each round you Sustain the spell, you increase the emanation by 5 feet up to a maximum of 15 feet.":
                // the ally's aura grows (once a round, to its maximum), and the module's Effect badge with it.
                if (record.declaration.auraGrowth && record.sustainedRound !== clock.round) {
                    const grown = Math.min(Number(record.declaration.aura.feet) + Number(record.declaration.auraGrowth.feet), Number(record.declaration.auraGrowth.maximum));
                    if (grown !== record.declaration.aura.feet) {
                        record.declaration.aura.feet = grown;
                        for (const entry of record.entries.filter(entry => entry.anchorEffect && entry.status === "active")) {
                            const effect = await fromUuid(entry.uuid);
                            if (effect) await effect.update({ "system.badge.value": grown / Number(record.declaration.auraGrowth.feet) });
                        }
                    }
                }
                // "Each time you sustain this spell, the radius of the burst increases by 5 feet.": the placed region grows. (An optional growth —
                // "you can expand the radius …" — is the caster's control after the Sustain.)
                if (record.declaration.sustainGrowth && !record.declaration.sustainGrowth.optional && record.sustainedRound !== clock.round) {
                    const growth = record.declaration.sustainGrowth;
                    // (Up to a stated maximum radius: Awaken Entropy's 40 feet.)
                    const feet = growth.maximum ? Math.max(0, Math.min(growth.feet, growth.maximum - Number(record.declaration.area.value))) : growth.feet;
                    if (feet > 0) await this.growRegion(record, feet);
                    // (Its dice one step larger each time — the next listed formula at the cast rank — for the exposures from now on.)
                    if (growth.dieSteps?.length) {
                        record.growthSteps = Math.min(growth.dieSteps.length, Number(record.growthSteps ?? 0) + 1);
                        const formula = growth.dieSteps[record.growthSteps - 1].replace(/@item\.rank/g, String(Number(record.rank)));
                        for (const key of ["exposurePlan", "enterExposurePlan"]) {
                            const damage = record[key]?.resolution?.sharedDamage;
                            if (!damage?.components?.length) continue;
                            const [component] = damage.components;
                            // (The formula at the cast rank: its dice count worked out — "(2+7)d8[void]" is "9d8[void]".)
                            const resolved = formula.replace(/^\((\d+)\+(\d+)\)d/, (all, a, b) => `${Number(a) + Number(b)}d`);
                            record[key].resolution.sharedDamage = { mode: "formula", rollOnce: true, textDerived: true, formula: resolved, components: [{ ...component, formula: resolved.replace(/\[[a-z]+\]$/, "") }] };
                        }
                    }
                }
                // "When you cast or Sustain this spell, you can choose an ally … They can immediately use a reaction to Escape": a card for it.
                if (record.declaration.escapePrompt && record.sustainedRound !== clock.round) await this.postEscapePrompt(record);
                // Helpful Wood Spirits: each Sustain offers the aid's card (and the move of the area, which is the GM's).
                if (record.declaration.spiritAid && record.sustainedRound !== clock.round) {
                    const aids = Object.keys(record.declaration.spiritAid.aids);
                    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: await fromUuid(record.sourceActorUuid) }), flags: { [MODULE_ID]: { spiritAid: { castId: record.castId } } },
                        content: `<section class="pf2e-auto-runtime-card"><header><strong>${escapeHTML(record.name)} — this round's aid</strong></header><p>The area can move up to ${record.declaration.spiritAid.moveFeet} feet (move the region). Choose the aid:</p>${aids.map(aid => `<button type="button" class="pf2e-auto-spirit-aid" data-aid="${aid}">${aid}</button>`).join("")}</section>` });
                }
                // Gloom Mantle: "the first time each round you Sustain it, you become Concealed until the end of your next turn".
                if (record.declaration.selfPulse && record.sustainedRound !== clock.round) await this.applySelfPulse(record);
                // "the first time you Sustain it on each subsequent round, you generate a pulse …"
                if (record.declaration.healingPulse && record.sustainedRound !== clock.round) {
                    record.status = "applying"; await this.ongoing.save(journal, record);
                    try { await this.pulseHealing(record); }
                    catch (error) { await this.ongoing.review(journal, `The pulse was interrupted: ${error.message}`); throw error; }
                    record.status = "active";
                }
                // "When you Sustain this spell, each creature grabbed or restrained by the plants takes 4d6 piercing damage."
                if (record.declaration.heldDamage && record.sustainedRound !== clock.round) {
                    record.status = "applying"; await this.ongoing.save(journal, record);
                    try { record.heldDamageResults = [...(record.heldDamageResults ?? []), ...await this.applyHeldDamage(record)]; }
                    catch (error) { await this.ongoing.review(journal, `The held creatures' damage was interrupted: ${error.message}`); throw error; }
                    record.status = "active";
                }
                if (record.declaration.events.includes("sustain") && record.sustainedRound !== clock.round) {
                    let members = await this.lingeringMembership(record);
                    if (members && record.declaration.unaffectedOnly) {
                        const affected = async member => ((await fromUuid(member.actorUuid))?.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.leaveArea?.castId === record.castId);
                        const flags = await Promise.all(members.map(affected));
                        members = members.filter((member, index) => !flags[index]);
                    }
                    if (!members) throw Error("The area's membership can't be determined; review it before sustaining.");
                    for (const member of members) addObligation(record, { key: `lingering:sustain:${clock.combatId}:${clock.round}:${member.actorUuid}`, kind: "membership",
                        round: `${clock.combatId}:${clock.round}`, event: "sustain", label: `Review ${member.name}'s exposure (the spell was sustained)`, actorUuid: member.actorUuid, tokenUuid: member.tokenUuid });
                    record.members = members.map(member => member.tokenUuid);
                }
            } else throw Error("This cast has no Sustain control.");
            record.sustainSequence = (record.sustainSequence ?? 0) + 1;
            for (const obligation of record.obligations.filter(o => o.kind === "sustain" && o.status === "pending")) obligation.status = "completed";
            record.sustainedRound = clock.round;
            if (record.kind === "floating-flame") record.sustainDueAt = clock.worldTime + 6;
            await this.ongoing.save(journal, record); return { status: "sustained" };
        }
        throw Error("Unknown ongoing spell control.");
    }
    async controls(journal, record) {
        if (record.kind === 'native') {
            const native = [...await sickenedControls(this,journal,record), ...await recurringControls(this,journal,record)];
            const caster = await fromUuid(record.sourceActorUuid);
            if (record.status === "active" && record.sustained && (game.user.isGM || caster?.testUserPermission(game.user, "OWNER")))
                native.push({ action: `sustain-${journal.id}`, label: `Sustain ${record.name} — 1 action (its conditions end if not sustained)`,
                    callback: () => this.ongoing.request("sustain", { castId: record.castId, revision: record.revision }) });
            return native;
        }
        if (record.kind === 'condition-spell') return this.conditions.controls(journal, record);
        const controls = [], caster = await fromUuid(record.sourceActorUuid);
        if (record.status !== "active") return controls;
        const owner = game.user.isGM || caster?.testUserPermission(game.user, "OWNER");
        if (owner && sustainable(record)) controls.push({ action: `sustain-${journal.id}`, label: `Sustain ${record.name} — 1 action${record.kind === "lingering" && record.declaration?.events?.includes("sustain") ? " (move the area first if the spell allows; creatures inside are exposed)" : ""}`, callback: async () => {
            const pathConfirmed = record.kind === "floating-flame" && await confirmAction({ title: "Floating Flame — review targets", content: "<p>Move the flame at most 10 feet. Target every creature whose space it crossed. Confirm that path, range, and membership have been reviewed; recipients already exposed this round are excluded.</p>", label: "Confirm path and targets" });
            if (record.kind === "floating-flame" && !pathConfirmed) return;
            return this.ongoing.request("sustain", { castId: record.castId, revision: record.revision, pathConfirmed, targetUuids: [...game.user.targets].map(t => t.document.uuid) });
        } });
        if (game.user.isGM && record.kind === "petrify") controls.push({ action: `budget-${journal.id}`, label: "Review Petrify action budget", callback: async () => {
            const value = await foundry.applications.api.DialogV2.prompt({ window: { title: "Petrify action budget" }, content: `<p>Confirm actions the target can gain before this spell's slowed contribution. Account for quickened or unusual action rules.</p><input name="actions" type="number" min="1" step="1" value="${record.recipients[0].actionBudget}">`, ok: { label: "Confirm", callback: (_e, b) => Number(b.form.elements.actions.value) }, rejectClose: false });
            if (value != null) return this.ongoing.request("action-budget", { castId: record.castId, revision: record.revision, value });
        } });
        for (const obligation of record.obligations.filter(o => o.kind === "flame-path" && o.status === "pending")) if (game.user.isGM) controls.push({ action: `path-${journal.id}-${controls.length}`, label: obligation.label, callback: async () => {
            const confirmed = await confirmAction({ title: "Review sustained flame", content: "<p>Confirm the flame's movement was at most 10 feet and the saved target list covers creatures along its path. Select corrected targets now if necessary.</p>", label: "Confirm current targets" });
            if (confirmed) return this.ongoing.request("sustain", { castId: record.castId, revision: record.revision, key: obligation.key, pathConfirmed: true, targetUuids: [...game.user.targets].map(t => t.document.uuid) });
        } });
        for (const obligation of record.obligations.filter(o => o.kind === "membership" && o.status === "pending")) if (game.user.isGM) {
            controls.push({ action: `aura-${journal.id}-${controls.length}`, label: obligation.label, callback: async () => {
                const affected = await foundry.applications.api.DialogV2.wait({ window: { title: "Aura — confirm exposure" }, content: "<p>Review distance, walls, eligibility and this trigger.</p>", buttons: [
                    { action: "affected", label: "Affected", callback: () => true }, { action: "unaffected", label: "Unaffected", callback: () => false }
                ], close: () => null, rejectClose: false });
                if (affected == null) return;
                return this.ongoing.request("review-targets", { castId: record.castId, revision: record.revision, key: obligation.key, affected });
            } });
        }
        if (game.user.isGM && record.status === "active" && record.declaration?.gmTrigger?.chosen) controls.push({ action: `gm-trigger-${journal.id}`,
            label: `${record.name}: a creature in the area inflicted ${record.declaration.gmTrigger.chosen.join(" or ")} (target it)`, callback: async () => {
                const tokens = [...game.user.targets];
                if (!tokens.length) return ui.notifications.warn("Target the creature(s) first.");
                return this.ongoing.request("gm-trigger", { castId: record.castId, revision: record.revision, tokenUuids: tokens.map(token => token.document.uuid) });
            } });
        if (game.user.isGM && record.status === "active" && record.declaration?.disbelief) controls.push({ action: `disbelieve-${journal.id}`,
            label: `${record.name}: a creature ${record.declaration.disbelief.label} (target it)`, callback: async () => {
                const tokens = [...game.user.targets];
                if (!tokens.length) return ui.notifications.warn("Target the creature(s) first.");
                return this.ongoing.request("area-disbelieve", { castId: record.castId, revision: record.revision, tokenUuids: tokens.map(token => token.document.uuid) });
            } });
        // (Stars of Another Sky: a creature at the top of the cylinder, with or without a soul.)
        if (game.user.isGM && record.status === "active" && record.declaration?.gmMark) for (const soulless of [false, true]) controls.push({ action: `gm-mark-${soulless ? "soulless-" : ""}${journal.id}`,
            label: `${record.name}: a creature ${record.declaration.gmMark.label}${soulless ? " (no soul: double damage)" : ""} (target it)`, callback: async () => {
                const tokens = [...game.user.targets];
                if (!tokens.length) return ui.notifications.warn("Target the creature(s) first.");
                return this.ongoing.request("gm-mark", { castId: record.castId, revision: record.revision, tokenUuids: tokens.map(token => token.document.uuid), soulless });
            } });
        if (game.user.isGM && record.status === "active" && record.declaration?.gmAction) controls.push({ action: `gm-action-${journal.id}`,
            label: `${record.name}: a creature ${record.declaration.gmAction.label ?? `used ${record.declaration.gmAction.actions.join(" or ")} on the area`} (target it)`, callback: async () => {
                const tokens = [...game.user.targets];
                if (!tokens.length) return ui.notifications.warn("Target the creature(s) first.");
                return this.ongoing.request("gm-action", { castId: record.castId, revision: record.revision, tokenUuids: tokens.map(token => token.document.uuid) });
            } });
        if (game.user.isGM && record.declaration?.gmHazard) controls.push({ action: `gm-hazard-${journal.id}`, label: record.declaration.gmHazard.kind === "per-square"
                ? `${record.name}: ${record.declaration.gmHazard.enemiesOnly === false ? `a creature moved ${record.declaration.gmHazard.groundOnly === false ? "" : "on the ground "}through the area` : "an enemy passed through the area"} (target it)` : record.declaration.gmHazard.kind === "wall" ? `${record.name}: a creature ${record.declaration.gmHazard.label} (target ${record.declaration.gmHazard.perAction ? "it" : "each"})`
                : `${record.name}: it ignites (target each creature standing on it)`, callback: async () => {
            const tokens = [...game.user.targets];
            if (!tokens.length) return ui.notifications.warn("Target the creature(s) first.");
            let squares = 1;
            if (record.declaration.gmHazard.perAction) {
                if (tokens.length !== 1) return ui.notifications.warn("Target the one creature that entered the wall.");
                squares = await foundry.applications.api.DialogV2.prompt({ window: { title: `${record.name} — move actions` },
                    content: `<p>How many move actions did ${escapeHTML(tokens[0].name)} use to enter the wall's spaces?</p><input name="squares" type="number" min="1" step="1" value="1">`,
                    ok: { label: "Deal damage", callback: (_event, button) => Number(button.form.elements.squares.value) }, rejectClose: false });
                if (!squares) return;
            }
            if (record.declaration.gmHazard.kind === "per-square") {
                if (tokens.length !== 1) return ui.notifications.warn("Target the one creature that passed through the area.");
                squares = await foundry.applications.api.DialogV2.prompt({ window: { title: `${record.name} — squares` },
                    content: `<p>How many ${record.declaration.gmHazard.enemiesOnly === false ? "of the area's squares did" : "squares holding dust did"} ${escapeHTML(tokens[0].name)} ${record.declaration.gmHazard.enemiesOnly === false ? "move into" : "pass through"}?</p><input name="squares" type="number" min="1" step="1" value="1">`,
                    ok: { label: "Deal damage", callback: (_event, button) => Number(button.form.elements.squares.value) }, rejectClose: false });
                if (!squares) return;
            }
            return this.ongoing.request("gm-hazard", { castId: record.castId, revision: record.revision, tokenUuids: tokens.map(token => token.document.uuid), squares });
        } });
        if ((game.user.isGM || owner) && record.declaration?.regionGrowth && record.status === "active" && Number(record.regionGrown ?? 0) < record.declaration.regionGrowth.times)
            controls.push({ action: `region-growth-${journal.id}`, label: `${record.name}: a creature took ${record.declaration.regionGrowth.types.join(", ").replace(/, ([^,]+)$/, " or $1")} damage inside (your reaction: +${record.declaration.regionGrowth.feet} feet; ${record.declaration.regionGrowth.times - Number(record.regionGrown ?? 0)} left)`,
                callback: () => this.ongoing.request("region-growth", { castId: record.castId, revision: record.revision }) });
        if (game.user.isGM && record.declaration?.soulGrowth && record.status === "active") controls.push({ action: `soul-growth-${journal.id}`,
            label: `${record.name}: a slain creature's soul joins it (+${record.declaration.soulGrowth.feet} feet, +${record.declaration.soulGrowth.dice}d${record.declaration.soulGrowth.faces}; once a turn)`,
            callback: () => this.ongoing.request("soul-growth", { castId: record.castId, revision: record.revision }) });
        if (game.user.isGM && record.declaration?.thrallGrowth && record.status === "active") controls.push({ action: `thrall-growth-${journal.id}`,
            label: `${record.name}: thralls destroyed in the area (+${record.declaration.thrallGrowth.feet} feet each, to ${record.declaration.thrallGrowth.maximum})`,
            callback: async () => {
                // (The caster's own thrall tokens in the area: destroyed and counted by the module.)
                if ((await this.casterThrallsIn(record)).length) return this.ongoing.request("thrall-growth", { castId: record.castId, revision: record.revision, auto: true });
                const count = await foundry.applications.api.DialogV2.prompt({ window: { title: record.name }, rejectClose: false,
                    content: `<label>Thralls destroyed <input type="number" name="count" min="1" value="1"></label>`, ok: { label: "Grow", callback: (_event, button) => Number(button.form.elements.count.value) } });
                if (!count) return;
                return this.ongoing.request("thrall-growth", { castId: record.castId, revision: record.revision, count });
            } });
        if (owner && record.declaration?.sustainGrowth?.optional && record.sustainedRound === this.ongoing.clock().round && record.expandedRound !== record.sustainedRound)
            controls.push({ action: `expand-area-${journal.id}`, label: `${record.name}: expand the radius by ${record.declaration.sustainGrowth.feet} feet`,
                callback: () => this.ongoing.request("expand-area", { castId: record.castId, revision: record.revision }) });
        if (game.user.isGM && record.declaration?.mines && record.status === "active") controls.push({ action: `mine-exploded-${journal.id}`,
            label: `${record.name}: a mine exploded (target the creature and every creature within ${record.declaration.mines.emanation} feet of the mine; ${record.declaration.mines.count - Number(record.minesUsed ?? 0)} left)`,
            callback: async () => {
                const tokens = [...game.user.targets];
                if (!tokens.length) return ui.notifications.warn("Target the creatures the explosion catches.");
                return this.ongoing.request("mine-exploded", { castId: record.castId, tokenUuids: tokens.map(token => token.document.uuid) });
            } });
        if (game.user.isGM && record.declaration?.moveSave && record.status === "active") controls.push({ action: `move-save-${journal.id}`, label: `${record.name}: a creature ended a move action through the area (target it; give the squares)`,
            callback: async () => {
                const [target] = [...game.user.targets];
                if (!target) throw Error(`${record.name}: target the creature first.`);
                const squares = Number(await foundry.applications.api.DialogV2.prompt({ window: { title: `${record.name} — squares traversed` },
                    content: `<p>How many squares of the area did ${escapeHTML(target.name)} move through?</p><input type="number" name="squares" min="1" value="1">`,
                    ok: { label: "Save", callback: (_event, button) => button.form.elements.squares.value }, rejectClose: false }) ?? 0);
                if (!squares) return;
                return this.ongoing.request("move-save", { castId: record.castId, tokenUuid: target.document.uuid, squares });
            } });
        if (game.user.isGM && record.declaration?.hazardMove) controls.push({ action: `hazard-move-${journal.id}`, label: `${record.name}: a creature moved on the ground through the area (target it)`, callback: async () => {
            const [token] = [...game.user.targets];
            if (!token || game.user.targets.size !== 1) return ui.notifications.warn("Target the one creature that moved through the area.");
            const squares = await foundry.applications.api.DialogV2.prompt({ window: { title: `${record.name} — hazardous terrain` },
                content: `<p>How many squares of the area did ${escapeHTML(token.name)} move into (on the ground)?</p><input name="squares" type="number" min="1" step="1" value="1">`,
                ok: { label: "Deal damage", callback: (_event, button) => Number(button.form.elements.squares.value) }, rejectClose: false });
            if (squares) return this.ongoing.request("hazard-move", { castId: record.castId, revision: record.revision, tokenUuid: token.document.uuid, squares });
        } });
        if (owner) for (const entry of record.failedAttacks ?? []) {
            const damage = record.declaration.failedAttackDamage;
            controls.push({ action: `failed-attack-${journal.id}-${controls.length}`, label: `${entry.name}'s attack roll (rolled twice) failed: ${damage.formula}${damage.heightening ? "+" : ""} ${damage.type} damage`,
                callback: () => this.ongoing.request("failed-attack", { castId: record.castId, revision: record.revision, actorUuid: entry.actorUuid }) });
            controls.push({ action: `failed-attack-clear-${journal.id}-${controls.length}`, label: `${entry.name}'s attack roll (rolled twice) didn't fail`,
                callback: () => this.ongoing.request("failed-attack", { castId: record.castId, revision: record.revision, actorUuid: entry.actorUuid, failed: false }) });
        }
        for (const obligation of record.obligations.filter(o => o.kind === "save" && !["completed", "skipped"].includes(o.status))) {
            const actor = await fromUuid(obligation.actorUuid ?? record.recipients[0]?.actorUuid);
            if (!game.user.isGM && !actor?.testUserPermission(game.user, "OWNER")) continue;
            controls.push({ action: `save-${journal.id}-${controls.length}`, label: `Roll ${record.name} save`, callback: async () => {
                const result = obligation.cardId ? { cardId: obligation.cardId } : await this.ongoing.request("roll", { castId: record.castId, revision: record.revision, key: obligation.key });
                const card = game.messages.get(result.cardId);
                if (!card) throw Error("The save card is missing. The GM must review its result before any replacement.");
                const save = card.getFlag(MODULE_ID, "basicSaveState");
                for (const target of save.targets.filter(t => !t.excluded && t.eligible !== false && t.degree == null)) {
                    const recipient = await fromUuid(target.actorUuid);
                    if (game.user.isGM || recipient?.testUserPermission(game.user, "OWNER")) await this.saves.rollSave(card, target.id);
                }
                ui.chat.scrollBottom();
            } });
        }
        return controls;
    }
}
