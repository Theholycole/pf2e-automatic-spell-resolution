import { minionControlOnEnd } from "./minion-control-runtime.js";
import { d20LimitsFor } from "./d20-clamp.js";
import { rulesFromText, cascadeTypeAhead, waywardSustain, textRulesOnCreate, focusRegainOnCard, actionCastOnCard, triplicateOnCast } from "./text-rules.js";
import { noteEndAfter, hpShareOnLoss, summonEndsAtZero, zeroToOneOnLoss, dyingLinkCheck, damageLimitOnLoss, withConditionSync } from "./note-end-runtime.js";
import { turnStartNoteDamage, turnEndHpLoss, halvedCopyDamage, turnEndRecovery, formTempHpExpiry, turnEndSaves } from "./incarnate-parts-runtime.js";
import { formEnded, syncToggleGrants } from "./form-aura-runtime.js";
import { markedAtZero } from "./attack-shapes-runtime.js";
import { linkOnDamage, furyOnDamage, leechOnCast } from "./trigger-runtime.js";
import { revivalEnded, holdNoHealing } from "./revival-runtime.js";
import { holdCovenant, covenantKept } from "./support-runtime.js";
import { recordShaping, shapeRidersFor, shapeTypeSwapFor, noteWandUse, armSpellshape, widenCastTemplate, shapeTieEnded, syncShapeFollow, shapeOnApplied, shapeTerrainFromTemplate, shapeTerrainMove, shapeTerrainTurnEnd, expireShapeTerrain, bindTerrainButtons, growGarland, refundSlot, runShapeCard, detonateShapeCircle, detonateOnTurn, bindShapeCardButtons, turnStartShapeHeal, shapeWatchMessage, shapeRollSpent, shapeAreaFromTemplate, shapeTurnStart, stillInFlames, shapeScaleOnCreate, energyRuneOnCard } from "./spellshape-runtime.js";
import { installFormGuards } from './form-native-guards.js';
import { registerPersistentLinks } from "./persistent-link-runtime.js";
import { registerSetAside } from "./set-aside-runtime.js";
import { registerStrikeRiders } from "./strike-prelude-runtime.js";
import { StrikeEffectsRuntime, registerStrikeEffects } from "./strike-effects-runtime.js";
import { FormRuntime } from './form-runtime.js';
import { ImmediateRuntime } from "./immediate-runtime.js";
import { OngoingRuntime } from "./ongoing-runtime.js";
import { OngoingFamilies } from "./ongoing-families.js";
import { EffectRuntime, MODULE_ID, removeSpellMarkWeakness, immunityOnEffectUsed, armorUpOnUse, dismantleOnEnd, hyphaeOnMove, outlineOnCondition, outlineOnInvisible, repulsionShapes } from "./effect-runtime.js";
import { registerTemporaryShields } from "./temporary-shield-runtime.js";
import { lethologicOnDamage } from "./impossible-runtime.js";
import { markWardOnAttack } from "./mark-ward-runtime.js";
import { aidModifier } from "../src/compiler/aid-prepare.js";
import { triggerAuraOnCondition, triggerAuraOnSave } from "./trigger-aura-runtime.js";
import { autoToggleNewRound, autoToggleOnDamage, climbAidOnCheck, cloudActionOnCondition, consumeUsedEffects, runeWardOnDamage, endAfterMovement, endMarksWithoutPersistent, expireTurnBound, lockToFirstItem, oncePerSourceOnCast, oncePerSourceOnHealing, retroBonusOnRoll, syncNearTokens, recordDamage, delayedDamageOnEnd, consumeOnDamageTaken, spellshapeOnEffect, sharedLoreOnEnd, attackWardOnAttack, lastDamageOf, summonOnEnd, conjuredOnEnd, hiddenTurnEnd, coverSquareSync, coverSquareOnEnd, sceneWallsOnEnd } from "./climb-aid-runtime.js";
import { isStrikeDamage } from "../src/compiler/ward-families.js";
import { BasicSaveRuntime, situationalCurseSync } from "./basic-save-runtime.js";
import { holdCurseStage, curseCreatureCheck, curseCreatureSlain } from "./curse-creature.js";
import { suppressionSave, suppressionEnded } from "./suppression-save-runtime.js";
import { explodeAtZero, rottenTurnStart } from "./summon-benefits.js";
import { EscapeTermination } from "./escape-termination.js";
import { AfflictionCareRuntime } from "./affliction-care-runtime.js";
import { MessageRuntime } from "./message-runtime.js";
import { StoredTriggerRuntime } from "./stored-trigger-runtime.js";
import { inspectSavePlan } from "./basic-save-core.js";
import { claimNativeSpellSaveButton, refreshSaveButtonAuthority, saveButtonRole } from "./chat-card-controls.js";
import { debugCast, debugEnabled, debugLatestCast, registerDebugSetting } from "./debug.js";
import { rememberCastSpell, rememberedCastSpell, spellFromSource, castSpellFromUuid } from './cast-spell.js';
import { loadNativeEffectTemplate, prepareNativeEffectSource, createNativeEffect } from './native-outcome-effects.js';
import { whisperGmNotes, hideGmNotes, markEffectGmNotes, markEffectGmNotesUpdate, markExistingGmNotes } from "./gm-notes.js";
import { noteWatchMessage, noteWatchEndTurn } from "./note-watchers.js";
import { bloodMagicOnCast, runBloodMagic, spiteStrikes, spiteTurnStart, bindBloodMagicButtons } from "./blood-magic-runtime.js";
import { castingRulesOnCast, runCastingRule, bindCastingRuleButtons, spellLikeCast, loseSpell } from "./casting-rules-runtime.js";
import { castRankOf } from "./runtime-utils.js";
import { armItemSpellshape, runItemShapeCard, bindItemShapeButtons, itemShapeTurnStart, itemShapeWatchMessage, starChartOnCast, catalystSporesOnDamage, shieldShardsBlock } from "./item-spellshape-runtime.js";
import { readItemSpellshape } from "../src/compiler/item-spellshape.js";
import { offerItemCasts, castFromItem, itemCastOnCard, bindItemCastButtons, reservoirOnCast, reservoirOnStrike, runReservoirButton, reservoirExpend, reservoirCast, reservoirHeld, castSpellForItem, sweepItemCastTemps } from "./item-cast-runtime.js";
import { readItemCasts } from "../src/compiler/item-casts.js";
import { claims as itemClaimed, itemClaims } from "../src/compiler/item-claims.js";
import { spellTriggerItemsOnCast, runTriggerItem, bindTriggerItemButtons } from "./spell-trigger-items-runtime.js";
import { spellActionsOnCast, runSpellAction, bindSpellActionButtons, deliveryOnStrike, slidecastNow, invigorateOnDamage } from "./spell-actions-runtime.js";
import { backfireAmmoOnCard, backfireAmmoOnStrike, backfireAmmoOnCast } from "./plus-ammo-runtime.js";
import { refocusMoreOnCard, freeFocusOnCard, freeFocusOnCast, freeFocusEnded, bargainOnCreate, bunOnCard, bindFocusButtons } from "./plus-focus-runtime.js";
import { counteractFeatureOnCard, bindCounteractButtons } from "./plus-counteract-runtime.js";
import { stigmataOnHealing, summonBurstOnCast, bindCastAfterButtons, surgeAddonOnCreate } from "./plus-cast-riders-runtime.js";
import { hexFamiliarOnCast } from "./plus-hex-familiar-runtime.js";
import { exploitOnCard, channelSmiteOnStrike, exploitAuraTurnStart, bindExploitButtons } from "./plus-exploit-runtime.js";
import { catalystOnDamage, catalystOnDecoy, catalystOnFlatCheck, catalystOnCast, catalystAfterResolve, catalystTurnStart, catalystOnMove, catalystOnEffectEnded, catalystShieldBlocked, bindCatalystButtons } from "./catalyst-runtime.js";
import { essenceOnCast, essenceOnCombatStart, essenceOnCombatEnd, lifeReservoirRank, lifeReservoirOnHealing, lifeReservoirOnRefocus, essenceConduitOnCard, essenceActivationOnCard, incantationsOnRefocus, unstableDrawOnCard } from "./essence-runtime.js";
import { creatureAbilitiesOnCast, runCreatureAbility, bindCreatureAbilityButtons, readCreatureSpellAbility } from "./creature-spell-abilities-runtime.js";
import { SUPPLEMENT_FILES, SUPPLEMENT_FOLDER, setSupplement } from "../src/compiler/supplements/supplement-store.js";

// The user's own copies of tables the module doesn't ship (Patron's Apocalypse's, from the book): Data/pf2e-automatic-resolution-supplements/, read as the module
// loads; a missing file leaves that spell unautomated.
for (const [name, file] of Object.entries(SUPPLEMENT_FILES)) {
    void fetch(`${globalThis.foundry?.utils?.getRoute?.(`${SUPPLEMENT_FOLDER}/${file}`) ?? `/${SUPPLEMENT_FOLDER}/${file}`}`, { cache: "no-store" })
        .then(response => response.ok ? response.json() : null).then(value => setSupplement(name, value)).catch(() => null);
}

const immediate = new ImmediateRuntime();
const runtime = new EffectRuntime();
const basicSaves = new BasicSaveRuntime();
const escapes = new EscapeTermination();
const care = new AfflictionCareRuntime();
const strikeEffects = new StrikeEffectsRuntime();
const messages = new MessageRuntime();
const storedTriggers = new StoredTriggerRuntime();
const ongoing = new OngoingRuntime();
const ongoingFamilies = new OngoingFamilies(ongoing, basicSaves, runtime);
ongoing.connect(runtime, basicSaves, ongoingFamilies);
runtime.ongoing = ongoing;
// (A conjured structure's save when it breaks: Steel Fortifications.)
runtime.saves = basicSaves;
// (A ritual's drink casting care spells: Fortifying Brew, Winter's Breath.)
runtime.care = care;
basicSaves.ongoing = ongoing;
care.ongoing = ongoing;
care.saves = basicSaves;
messages.ongoing = ongoing;
ongoing.messages = messages;
storedTriggers.ongoing = ongoing;
storedTriggers.saves = basicSaves;
ongoing.storedTriggers = storedTriggers;
const forms = new FormRuntime(ongoing, basicSaves, ongoingFamilies);
ongoing.forms = forms;
basicSaves.forms = forms;
Hooks.on('preUpdateItem', (item, changes, options) => ongoingFamilies.conditions.protectCondition(item, changes, options));
// PF2e re-evaluates a GrantItem predicate on actor updates only. When a curse
// floor's situational toggle changes, touch the actor so the conditional grant
// (for example Slowed 1 while at sea) follows the toggle immediately.
Hooks.on('updateItem', (item, changes, _options, userId) => {
    if (userId !== game.user.id || !item.flags?.[MODULE_ID]?.conditionFloor || !changes.system?.rules || !item.actor) return;
    void item.actor.update({[`flags.${MODULE_ID}.situationalRefresh`]: Date.now()});
});
Hooks.on('preDeleteItem', (item, options) => ongoingFamilies.conditions.protectCondition(item, null, options, true));
// "Off-Guard against the triggering attack": once that attack roll against the creature is posted, the condition goes (the active GM).
Hooks.on('createChatMessage', message => {
    const context = message?.flags?.pf2e?.context;
    if (!['attack-roll', 'spell-attack-roll'].includes(context?.type) || !context.target?.actor || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void (async () => {
        const actor = await fromUuid(context.target.actor);
        // (And an effect-note Effect "against the triggering attack": Repel Metal's AC bonus.)
        const scoped = (actor?.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.nextAttack || effect.flags?.[MODULE_ID]?.runtime?.endsAfterAttack).map(effect => effect.id);
        if (scoped.length) await actor.deleteEmbeddedDocuments('Item', scoped);
    })().catch(error => console.warn(`${MODULE_ID} | The triggering attack's condition could not be removed.`, error));
});
// "+2 status bonus to the triggering save" (Battlefield Persistence): once the creature's next saving throw is posted, the bonus goes (the active GM).
Hooks.on('createChatMessage', message => {
    if (message?.flags?.pf2e?.context?.type !== 'saving-throw' || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void (async () => {
        const actor = message.actor ?? (message.speaker?.actor ? game.actors.get(message.speaker.actor) : null);
        const scoped = (actor?.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.runtime?.endsAfterSave).map(effect => effect.id);
        if (scoped.length) await actor.deleteEmbeddedDocuments('Item', scoped);
    })().catch(error => console.warn(`${MODULE_ID} | The triggering save's bonus could not be removed.`, error));
});
// A ritual's locked condition ("can't reduce the condition for 12 hours"): no reduction below the lock's value while its granter lasts.
// (An obligation's strain — Geas's Sickened: held at its value until the creature complies, the card's control.)
// (`releasing`: the ids of locks being deleted in the same operation — the curse and the condition it granted, PF2e's cascade.)
function conditionLock(item, releasing = []) {
    if (item.type !== 'condition' || !item.actor) return null;
    const granterId = item.flags?.pf2e?.grantedBy?.id;
    const lock = releasing.includes(granterId) ? null : item.actor.items.get(granterId)?.flags?.[MODULE_ID]?.ritualLock;
    if (lock) return Number(lock.value);
    const strained = (item.actor.itemTypes?.effect ?? []).filter(effect => !releasing.includes(effect.id)).map(effect => effect.flags?.[MODULE_ID]?.ritualStrain)
        .filter(strain => strain?.lock && strain.name.toLowerCase() === item.slug);
    return strained.length ? Math.max(...strained.map(strain => Number(strain.lock))) : null;
}
Hooks.on('preUpdateItem', (item, changes) => {
    const lock = conditionLock(item);
    const value = changes?.system?.value?.value ?? changes?.['system.value.value'];
    if (lock == null || value == null || Number(value) >= lock) return;
    ui.notifications.warn(`${item.name} can't be reduced below ${lock} yet.`);
    return false;
});
// (A locked condition at 1 is removed rather than reduced: refused the same way — unless its lock goes in the same deletion. PF2e deletes a
// granter and the conditions it cascades to in one operation, the granter first, and every item's pre-delete gets that operation's one options
// object: the lock marks itself there for the condition's.)
Hooks.on('preDeleteItem', (item, options) => {
    if (item.flags?.[MODULE_ID]?.ritualLock || item.flags?.[MODULE_ID]?.ritualStrain) (options.pf2eAutoReleasingLocks ??= []).push(item.id);
    const lock = conditionLock(item, options?.pf2eAutoReleasingLocks ?? []);
    if (lock == null || lock < 1) return;
    ui.notifications.warn(`${item.name} can't be removed yet.`);
    return false;
});

function actorFromMessage(message) {
    try { if (message.actor) return message.actor; } catch (_) {}
    const speaker = message.speaker ?? {};
    if (speaker.scene && speaker.token) {
        const actor = game.scenes.get(speaker.scene)?.tokens.get(speaker.token)?.actor;
        if (actor) return actor;
    }
    return speaker.actor ? game.actors.get(speaker.actor) ?? null : null;
}

function spellCardContext(message) {
    if (!String(message.content ?? "").includes("pf2e chat-card item-card")) return null;
    const actor = actorFromMessage(message);
    const itemId = message.content.match(/data-item-id=["']([^"']+)["']/i)?.[1];
    if (!actor || !itemId) return null;
    let item = null;
    try { item = message.item ?? null; } catch (_) {}
    item ??= actor.items.get(itemId) ?? null;
    // (A used-up scroll: PF2e deleted it and its card keeps no copy — the spell kept on the card, or remembered before the deletion.)
    const keptSource = message.flags?.[MODULE_ID]?.castSpellSource ?? rememberedCastSpell(message.flags?.pf2e?.origin?.uuid)?.source ?? null;
    const embeddedSource = message.flags?.pf2e?.casting?.embeddedSpell ?? (item ? null : keptSource);
    if (item?.type !== "spell" && embeddedSource?.type !== "spell") return null;
    const castRank = Number(
        message.content.match(/data-cast-rank=["'](\d+)["']/i)?.[1]
        ?? message.flags?.pf2e?.origin?.castRank
        ?? item?.rank
        ?? embeddedSource?.system?.level?.value
    );
    // (A wand or scroll's spell exists only for this card: an item built from its stored copy, owned by the caster, and remembered so
    // later steps can find it.)
    const spell = item?.type === "spell" && !item.spellcasting && item.parentItem ? spellFromSource(item.toObject(), actor)
        : item ?? (embeddedSource ? spellFromSource(embeddedSource, actor) : null);
    rememberCastSpell(spell);
    return {
        actor,
        item: spell,
        baseSource: embeddedSource ?? unheightenedSource(item, actor.items.get(itemId)),
        castRank: Number.isFinite(castRank) ? castRank : null,
        embedded: Boolean(message.flags?.pf2e?.casting?.embeddedSpell)
    };
}

const printings = new Map();
/**
 * A wand or scroll's stored copy of its spell is the printing current when the item was made. When the module can't resolve that copy and can
 * resolve the compendium's current printing of the same spell (Wand of Tormented Slumber's Sleep, Wand of Clinging Rime's Frigid Flurry), the card
 * uses the current printing at the stored rank.
 */
async function currentPrinting(context, message) {
    if (!context?.embedded || context.baseSource?.type !== "spell") return context;
    if (!printings.has(message.id)) printings.set(message.id, (async () => {
        const stored = context.baseSource;
        const uuid = stored._stats?.compendiumSource ?? stored.flags?.core?.sourceId ?? null;
        if (!String(uuid ?? "").startsWith("Compendium.")) return null;
        const current = await fromUuid(uuid).catch(() => null);
        if (current?.type !== "spell" || current.system?.description?.value === stored.system?.description?.value) return null;
        const api = game.modules.get(MODULE_ID).api;
        const storedItem = spellFromSource(foundry.utils.deepClone(stored), context.actor);
        if ((await api.diagnose(storedItem).catch(() => ({ route: "none" }))).route !== "none") return null;
        const source = current.toObject();
        source._id = stored._id;
        source.system.location = foundry.utils.deepClone(stored.system.location);
        source._stats = { ...(source._stats ?? {}), compendiumSource: uuid };
        const currentItem = spellFromSource(foundry.utils.deepClone(source), context.actor);
        if ((await api.diagnose(currentItem).catch(() => ({ route: "none" }))).route === "none") return null;
        return source;
    })());
    const source = await printings.get(message.id);
    if (!source) return context;
    context.baseSource = source;
    context.item = spellFromSource(foundry.utils.deepClone(source), context.actor);
    rememberCastSpell(context.item);
    return context;
}

/**
 * The plan is compiled from the spell's own text and data; PF2e's fixed-level heightening ("levels": 4d6 and a 10-foot burst at 3rd) is the
 * cast rank's, applied when the spell is rolled at that rank. A heightened chat-card copy has those values in its data, which its text
 * (1d6, a 5-foot burst) no longer matches: the fields the heightening changed are taken from the stored spell. (An action-count overlay stays.)
 */
function unheightenedSource(item, stored) {
    const levels = item?.system?.heightening?.type === "fixed" ? item.system.heightening.levels ?? {} : null;
    if (!levels || !stored || stored === item || typeof item?.toObject !== "function") return item;
    const keys = new Set(Object.values(levels).flatMap(level => Object.keys(level ?? {})));
    if (!keys.size) return item;
    const source = item.toObject();
    const base = stored.toObject();
    for (const key of keys) if (key in (base.system ?? {})) source.system[key] = foundry.utils.deepClone(base.system[key]);
    source.uuid ??= item.uuid ?? null;
    return source;
}

/** Rest for the Night: end a spell's "until it next rests" conditions, or lower "by 1 for each rest" ones. */
export async function restLifetimes(actor) {
    const results = [];
    for (const effect of actor.itemTypes.effect.filter(item => item.flags?.[MODULE_ID]?.outcomeEffect?.restLifetime)) {
        const mode = effect.flags[MODULE_ID].outcomeEffect.restLifetime.mode;
        if (mode === "end") { await effect.delete({ [MODULE_ID]: { reason: "rest" } }); results.push({ effect: effect.name, ended: true }); continue; }
        const granted = actor.items.filter(item => item.type === "condition" && item.flags?.pf2e?.grantedBy?.id === effect.id);
        let remaining = 0;
        for (const condition of granted) {
            const value = Number(condition.system?.value?.value ?? condition.value ?? 0);
            if (value > 1) { await condition.update({ "system.value.value": value - 1 }); remaining += 1; }
        }
        if (!remaining) { await effect.delete({ [MODULE_ID]: { reason: "rest" } }); results.push({ effect: effect.name, ended: true }); }
        else results.push({ effect: effect.name, lowered: granted.map(condition => condition.slug) });
    }
    return results;
}

/** A save plan with modes by the target's kind (Curse of Lost Time): the caster picks one; otherwise the plan itself. */
async function chooseSaveMode(plan) {
    const modes = plan?.resolution?.saveModes;
    if (!modes?.length) return plan;
    const key = await foundry.applications.api.DialogV2.wait({ window: { title: `${plan.source.name} — the target is` }, content: "<p>What is the target?</p>",
        buttons: modes.map(mode => ({ action: mode.key, label: mode.label })), close: () => null, rejectClose: false });
    const chosen = modes.find(mode => mode.key === key);
    if (!chosen) throw new Error(`${plan.source.name}: choose the target's kind.`);
    return chosen.plan;
}

function notifyError(context, error) {
    console.error(`PF2e Automatic Resolution | ${context}:`, error);
    ui.notifications.error(error instanceof Error ? error.message : String(error));
}

function bindReceiptButtons(root) {
    for (const button of root.querySelectorAll(".pf2e-auto-runtime-button")) {
        if (button.dataset.runtimeBound) continue;
        button.dataset.runtimeBound = "true";
        button.addEventListener("click", async event => {
            event.preventDefault();
            event.stopPropagation();
            if (button.disabled) return;
            button.disabled = true;
            const prior = button.innerHTML;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Working';
            try {
                await runtime.handleReceiptAction(button);
                // A control used again later (a bargain's price suppressed on each Sustain) stays available.
                if (button.dataset.repeatable === "true") { button.disabled = false; button.innerHTML = prior; }
                else button.innerHTML = '<i class="fa-solid fa-check"></i> Complete';
            } catch (error) {
                button.disabled = false;
                button.innerHTML = prior;
                notifyError("Effect control failed", error);
            }
        });
    }
}

function bindSaveButtons(root) {
    for (const control of root.querySelectorAll(".pf2e-auto-gm-corrections, .pf2e-auto-gm-correction")) {
        control.hidden = !game.user.isGM;
    }
    for (const button of root.querySelectorAll(".pf2e-auto-save-button")) {
        const card = game.messages.get(button.dataset.messageId);
        // (Who sees it: the GM every button; the caster the cast's own buttons; a target's owner its save.)
        const role = saveButtonRole(button, card, game.user);
        button.hidden = role === "hidden";
        if (role === "caster") { button.dataset.saveStateDisabled ??= String(button.disabled); button.disabled = button.dataset.saveStateDisabled === "true" || button.dataset.runtimeBusy === "true"; }
        else refreshSaveButtonAuthority(button, !!card && basicSaves.canCoordinate(card));
        if (button.dataset.runtimeBound) continue;
        button.dataset.runtimeBound = "true";
        button.addEventListener("click", async event => {
            event.preventDefault();
            event.stopPropagation();
            if (button.disabled) return;
            button.dataset.runtimeBusy = "true";
            button.disabled = true;
            const prior = button.innerHTML;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Working';
            try {
                await basicSaves.handleCardAction(button, event);
                button.disabled = false;
                button.innerHTML = prior;
            } catch (error) {
                button.disabled = false;
                button.innerHTML = prior;
                notifyError("Save-resolution control failed", error);
            } finally {
                delete button.dataset.runtimeBusy;
                if (saveButtonRole(button, card, game.user) !== "caster") refreshSaveButtonAuthority(button, basicSaves.canCoordinate(card));
            }
        });
    }
}

// Conjured food: the eater is the user's one targeted token, else their one controlled token, else their character.
/** A note card's heightened counteract button (Putrefy Food and Drink at 2nd rank). */
/** A GM-handled spell's options (user request 2026-10-04): GM only; each applies to the creatures the GM targets. */
function bindGmOptionButtons(message, root) {
    const data = message.getFlag(MODULE_ID, "gmOptions");
    for (const button of root.querySelectorAll(".pf2e-auto-gm-option")) {
        if (button.dataset.runtimeBound || !data) continue;
        button.dataset.runtimeBound = "true";
        if (!game.user.isGM) { button.hidden = true; continue; }
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            try { await runGmOption(message, button.dataset.option); } catch (error) { notifyError("GM option", error); }
        });
    }
}

async function runGmOption(message, key, { targets = null } = {}) {
    const data = message.getFlag(MODULE_ID, "gmOptions");
    const option = data?.options?.find(entry => entry.key === key);
    if (!game.user.isGM || !option) throw Error("Only the GM uses this spell's options.");
    const caster = await fromUuid(data.sourceActorUuid);
    if (!caster) throw Error(`${data.spellName}: the caster is unavailable.`);
    // (An option on the caster itself — Channel Imperial Dragon's Sustain.)
    const tokens = option.self ? (caster.getActiveTokens?.(true, true) ?? []).slice(0, 1) : [...(targets ?? game.user.targets)].map(token => token.document ?? token).filter(token => token?.actor);
    if (!tokens.length) throw Error(`${data.spellName}: ${option.self ? `${caster.name} needs a token on the scene` : "target the creatures first"}.`);
    const spell = await castSpellFromUuid({ sourceItemUuid: data.sourceItemUuid, sourceActorUuid: data.sourceActorUuid, spellSource: data.spellSource });
    if (option.kind === "save") {
        const source = spell?.toObject?.() ?? foundry.utils.deepClone(data.spellSource);
        if (option.patch) source.system = { ...source.system, ...foundry.utils.deepClone(option.patch) };
        const sub = spellFromSource(source, caster);
        const dc = Number(data.dc ?? sub.spellcasting?.statistic?.dc?.value ?? NaN);
        const started = await basicSaves.start(sub, { plan: foundry.utils.deepClone(option.plan), sourceActor: caster, targets: tokens.map(token => token.object ?? token), castRank: data.castRank,
            ...(Number.isFinite(dc) ? { dc } : {}), skipConfirmation: true });
        // ("… after which the spell immediately ends": the cast's marks removed — Hyper-Arcane Pressure Point Strike.)
        if (option.endsCast) {
            const castId = message.getFlag(MODULE_ID, "castInstanceId");
            for (const actor of new Set(canvas.scene?.tokens?.map(token => token.actor).filter(Boolean) ?? [])) {
                const marks = (actor.itemTypes?.effect ?? []).filter(effect => castId && effect.flags?.[MODULE_ID]?.runtime?.castInstanceId === castId).map(effect => effect.id);
                if (marks.length) await actor.deleteEmbeddedDocuments("Item", marks);
            }
        }
        return started;
    }
    // (Secret of the Forebearers: the forebearers' Aid — the chosen skill against the Aid DC, once a turn; a failure a success, legendary a critical success;
    // the bonus on the caster's next attack roll or skill check.)
    if (option.kind === "aid-roll") {
        const actor = tokens[0].actor;
        const turnKey = game.combat?.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : `t${Math.floor(game.time.worldTime / 6)}`;
        if (data.lastAid === turnKey) throw Error(`${data.spellName}: the forebearers already Aided this turn.`);
        await message.setFlag(MODULE_ID, "gmOptions", { ...data, lastAid: turnKey });
        const statistic = actor.skills?.[option.skill];
        if (!statistic) throw Error(`${data.spellName}: ${actor.name} has no ${option.skill} modifier.`);
        const rank = Number(statistic.rank ?? 0);
        let degree, total = null;
        if (option.legendaryCritical && rank >= 4) degree = "criticalSuccess";
        else {
            const roll = await statistic.check.roll({ dc: { value: option.dc }, extraRollOptions: ["action:aid"], skipDialog: true, label: `${data.spellName}: the forebearers Aid` });
            degree = ["criticalFailure", "failure", "success", "criticalSuccess"][Number(roll?.degreeOfSuccess ?? -1)] ?? "failure";
            total = roll?.total ?? null;
            if (option.failureToSuccess && degree === "failure") degree = "success";
        }
        const value = aidModifier(degree, rank);
        let effect = null;
        if (value) [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: the forebearers' Aid`, type: "effect", img: data.spellSource?.img ?? "icons/svg/aura.svg",
            flags: { [MODULE_ID]: { gmOption: { spell: data.spellName, key: option.key } } },
            system: { level: { value: data.castRank }, duration: { value: 1, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                description: { value: `<p>${value > 0 ? "+" : ""}${value} circumstance to your next attack roll or skill check (the forebearers' Aid).</p>` },
                rules: [{ key: "FlatModifier", selector: ["attack-roll", "skill-check"], type: "circumstance", value, label: `${data.spellName} (Aid)`, removeAfterRoll: true }] } }]);
        try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${foundry.utils.escapeHTML(data.spellName)}</strong>: the forebearers Aid ${foundry.utils.escapeHTML(actor.name)} — ${total ?? "automatic"} (${foundry.utils.escapeHTML(degree)}): ${value > 0 ? "+" : ""}${value} circumstance.</p>` }); } catch (_) {}
        return { status: "applied", degree, value, created: effect ? [effect.uuid] : [] };
    }
    const created = [];
    for (const token of tokens) {
        if (option.kind === "native-effect") {
            const template = await loadNativeEffectTemplate(option.uuid);
            if (!template) throw Error(`${data.spellName}: PF2e's ${option.label} Effect is unavailable.`);
            const source = prepareNativeEffectSource(template, { castInstanceId: message.getFlag(MODULE_ID, "castInstanceId") ?? foundry.utils.randomID(), castRank: data.castRank,
                sourceActorUuid: caster.uuid, sourceItemUuid: data.sourceItemUuid, sourceItemName: data.spellName, resolutionKind: "gm-option", targetActorUuid: token.actor.uuid });
            created.push(await createNativeEffect(token.actor, source));
        } else if (option.kind === "effect") {
            const [effect] = await token.actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: ${option.label.split(":")[0]}`, type: "effect", img: data.spellSource?.img ?? "icons/svg/aura.svg",
                flags: { [MODULE_ID]: { gmOption: { spell: data.spellName, key: option.key, ...(option.watch ? { watch: foundry.utils.deepClone(option.watch), casterUuid: caster.uuid } : {}) } } },
                system: { level: { value: data.castRank }, duration: { value: option.duration?.value ?? 1, unit: option.duration?.unit ?? "minutes", expiry: option.duration?.expiry ?? "turn-start", sustained: false },
                    start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null },
                    description: { value: `<p>${foundry.utils.escapeHTML(option.label)}.</p>${option.note ? `<p>${foundry.utils.escapeHTML(option.note)}</p>` : ""}` }, rules: foundry.utils.deepClone(option.rules ?? []) } }]);
            created.push(effect);
        }
    }
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id),
        content: `<p><strong>${foundry.utils.escapeHTML(data.spellName)}</strong> — ${foundry.utils.escapeHTML(option.label)}: ${tokens.map(token => foundry.utils.escapeHTML(token.name)).join(", ")}.</p>` }); } catch (_) {}
    return { status: "applied", created: created.map(effect => effect?.uuid) };
}

function bindNoteCounteractButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-note-counteract");
    if (!button || button.dataset.runtimeBound || !message.getFlag(MODULE_ID, "noteCounteract")) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await runtime.noteCounteract(message); } catch (error) { notifyError("Counteract", error); }
    });
}

// A note that lasts with a condition (Calcification, Vitrifying Blast): its condition changed — kept in step, or ended.
const conditionChanged = item => { if (item?.type === "condition" && item.actor && item.actor.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.runtime?.withCondition?.slug === item.slug))
    void withConditionSync(item.actor).catch(error => notifyError("Condition-linked note failed", error)); };
Hooks.on("createItem", conditionChanged);
Hooks.on("createItem", item => { if (item.type === "condition") void triggerAuraOnCondition(item).catch(error => notifyError("Aura damage failed", error)); });
Hooks.on("updateItem", conditionChanged);
Hooks.on("deleteItem", conditionChanged);
// (A form's temporary Hit Points that end with it: Corrosive Body; its auras, and Arcane Explosion's return at maximum Hit Points.)
Hooks.on("deleteItem", item => { void formTempHpExpiry(item).catch(error => notifyError("Temporary Hit Point expiry failed", error)); });
Hooks.on("deleteItem", item => { void formEnded(item, ongoing).catch(error => notifyError("A form's end failed", error)); });
// (A form's toggle granting a condition: Blanket of Stars' night sky.)
Hooks.on("updateItem", item => { void syncToggleGrants(item).catch(error => notifyError("A form's toggle failed", error)); });
// A dying creature's summon (Gray Shadow) ends when it dies or regains consciousness: its Dying condition gone, or Dead.
Hooks.on("deleteItem", item => { if (item.type === "condition" && item.slug === "dying" && item.actor) void dyingLinkCheck(item.actor).catch(error => notifyError("Dying link failed", error)); });
Hooks.on("updateActor", actor => { if (actor?.statuses?.has?.("dead")) void dyingLinkCheck(actor).catch(error => notifyError("Dying link failed", error)); });
// (Unleash True Power: its end — the caster's Effect gone — the final shock's save card.)
Hooks.on("deleteItem", (item, options) => {
    if (item?.type !== "effect" || !item.flags?.[MODULE_ID]?.truePower || options?.[MODULE_ID]?.ongoingCleanup || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void runtime.truePowerEnd(item).catch(error => notifyError("Unleash True Power's end failed", error));
});
// (Honorable Death: its target reduced to 0 Hit Points while the spell lasts is instantly killed.)
Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.getProperty(changes, "system.attributes.hp.value") === undefined || Number(actor.hitPoints?.value ?? 1) > 0) return;
    if (!game.user?.isGM || game.users.activeGM?.id !== game.user.id || !(actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.honorDuel)) return;
    void runtime.honorDeath(actor).catch(error => notifyError("Honorable Death failed", error));
});
// A creature lost Hit Points: the caster's share for its notes that share them (Temporary Possession).
Hooks.on("updateActor", (actor, _changes, options) => {
    if (Number(options?.damageTaken) > 0) void hpShareOnLoss(actor, Number(options.damageTaken)).catch(error => notifyError("Hit Point share failed", error));
    // (A note ended by the total damage taken: Volcanic Eruption's encasing rock.)
    if (Number(options?.damageTaken) > 0) void damageLimitOnLoss(actor, Number(options.damageTaken)).catch(error => notifyError("Damage-limited note failed", error));
    // (A conjured creature whose death ends its spell: Dragon Turret's dragon.)
    if (actor?.flags?.[MODULE_ID]?.summoned?.endsAtZero) void summonEndsAtZero(actor).catch(error => notifyError("Conjured creature ending failed", error));
    // (A form ending at 0 HP with 1 left: Patron's Protector.)
    if (actor?.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.runtime?.zeroToOne)) void zeroToOneOnLoss(actor).catch(error => notifyError("Form ending failed", error));
});
// A conjured structure brought to its Broken Threshold (Steel Fortifications): it crumbles (the active GM).
Hooks.on("updateActor", (actor, changes) => {
    if (!actor.flags?.[MODULE_ID]?.fortification || foundry.utils.getProperty(changes, "system.attributes.hp.value") === undefined) return;
    if (!game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void runtime.crumbleFortification(actor).catch(error => notifyError("The structure's crumbling failed", error));
});

/** Damage a creature took: a life link moves part of it (Bound in Death); a fury's curse blinds its attacker to it (Blinding Fury). */
Hooks.on("updateActor", (actor, _changes, options) => {
    if (!(Number(options?.damageTaken) > 0)) return;
    void linkOnDamage({ ongoing, actor, amount: Number(options.damageTaken) }).catch(error => notifyError("The life link failed", error));
    void furyOnDamage(actor).catch(error => notifyError("The fury's curse failed", error));
});
/** Revival's raised creatures: no other healing or temporary Hit Points; the spell's end kills them. */
Hooks.on("preUpdateActor", (actor, changes, options) => { holdNoHealing(actor, changes, options); });
Hooks.on("deleteItem", item => { void revivalEnded(item).catch(error => notifyError("Revival's end failed", error)); });
/** A spell cast: its spellshape feats and wand read onto its message, and PF2e's Spellshape selector switched off (spellshape-runtime.js). */
Hooks.on("createChatMessage", message => {
    void recordShaping(message).catch(error => notifyError("Spellshape", error));
    void armSpellshape(message).catch(error => notifyError("Spellshape", error));
});
Hooks.on("updateItem", (item, changes) => noteWandUse(item, changes));
Hooks.on("preCreateRegion", (region, data) => { try { widenCastTemplate(region, data); } catch (error) { console.warn(`${MODULE_ID} | The template couldn't be widened.`, error); } });
// (Spellshape riders tied to the spell's own Effects, and a condition following another the spell grants.)
Hooks.on("deleteItem", item => { void shapeTieEnded(item).catch(error => notifyError("A spellshape rider's end failed", error)); });
Hooks.on("createItem", item => { if (item.type === "condition" && item.actor) void syncShapeFollow(item.actor); });
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.appliedDamage) void shapeOnApplied(message).catch(error => notifyError("A spellshape's healing rider failed", error)); });
// (A spellshape's terrain: the cast's area copied, its hazard on a creature's turn end, removed when its time is up; its card's buttons.)
Hooks.on("createRegion", region => { void shapeTerrainFromTemplate(region).catch(error => notifyError("A spellshape's terrain failed", error)); });
// The wands that watch: their area at the template, PF2e's checks, the turns' echoes and shards, Continuation's longer Effects (spellshape-runtime.js).
Hooks.on("createRegion", region => { void shapeAreaFromTemplate(region).catch(error => notifyError("A wand's area failed", error)); });
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.context?.type) void shapeWatchMessage(message).catch(error => notifyError("A wand's watch failed", error)); });
// (A rule kept for one cast's roll — Sacrificial Spell's d12s — gone with that roll.)
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.context?.type === "damage-roll") void shapeRollSpent(message).catch(error => notifyError("A spellshape's roll rule failed", error)); });
Hooks.on("updateCombat", (combat, changes) => { if ("turn" in changes || "round" in changes) { void stillInFlames(combat).catch(error => notifyError("A wand's flames failed", error)); void shapeTurnStart(combat).catch(error => notifyError("A wand's turn failed", error)); } });
Hooks.on("createItem", item => { if (item.type === "effect") void shapeScaleOnCreate(item).catch(error => notifyError("A wand's duration failed", error)); });
Hooks.on("updateCombat", (combat, changes) => { if ("turn" in changes || "round" in changes) { void shapeTerrainTurnEnd(combat).catch(error => notifyError("A spellshape's terrain damage failed", error)); void expireShapeTerrain().catch(() => null); } });
Hooks.on("updateWorldTime", () => { void expireShapeTerrain().catch(() => null); });
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "spellshape-terrain" || message.flags?.[MODULE_ID]?.kind === "spellshape-garland") bindTerrainButtons(message, html); });
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "spellshape-card") bindShapeCardButtons(message, html); });
Hooks.on("updateCombat", (combat, changes) => { if ("turn" in changes || "round" in changes) { void detonateOnTurn(combat).catch(error => notifyError("A spellshape's circle failed", error)); void turnStartShapeHeal(combat).catch(error => notifyError("A wand's healing failed", error)); } });
Hooks.on("updateItem", item => { if (item.type === "condition" && item.actor) void syncShapeFollow(item.actor); });
/** Sacred Covenant: a pact-holder taken to 0 Hit Points stays at 1, then its temporary Hit Points, Wounded and immunity. */
Hooks.on("preUpdateActor", (actor, changes, options) => { holdCovenant(actor, changes, options); });
Hooks.on("updateActor", (actor, _changes, options) => { void covenantKept(actor, options).catch(error => notifyError("Sacred Covenant failed", error)); });
/** A spell cast: a leech on its caster reacts (Divinity Leech). */
Hooks.on("createChatMessage", message => {
    void leechOnCast({ ongoing, incarnatePhase: (card, key, options) => runtime.incarnatePhase(card, key, options) }, message).catch(error => notifyError("The leech failed", error));
});

/** A marked creature reduced to 0 Hit Points (Doom Mark): the other creatures the card marked get the stated conditions, by the active GM. */
Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.getProperty(changes, "system.attributes.hp.value") === undefined || Number(actor.hitPoints?.value ?? 1) > 0) return;
    if (!game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void markedAtZero(ongoing, actor).catch(error => notifyError("The marks' payoff failed", error));
});

/** A challenge ends when the caster or the challenged enemy is defeated (Dutiful Challenge): both Effects go, by the active GM. */
Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.getProperty(changes, "system.attributes.hp.value") === undefined || Number(actor.hitPoints?.value ?? 1) > 0) return;
    const pairs = (actor.itemTypes?.effect ?? []).map(effect => effect.flags?.[MODULE_ID]?.challengeCast).filter(Boolean);
    if (!pairs.length || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void (async () => {
        for (const pair of pairs) for (const uuid of [pair.casterUuid, pair.enemyUuid]) {
            const holder = await fromUuid(uuid);
            const ids = (holder?.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.challengeCast?.castId === pair.castId).map(effect => effect.id);
            if (ids.length) await holder.deleteEmbeddedDocuments("Item", ids);
        }
    })().catch(error => notifyError("The challenge's end failed", error));
});

/** A double whose 0 Hit Points end its spell (Replicate): the caster's Effect is removed (and with it the double), by the active GM. */
Hooks.on("updateActor", (actor, changes) => {
    const summoned = actor.flags?.[MODULE_ID]?.summoned;
    // (A thrall at 0 HP: destroyed on its own — its token and actor removed — by the active GM.)
    if (summoned?.removeAtZero && foundry.utils.getProperty(changes, "system.attributes.hp.value") !== undefined && Number(actor.hitPoints?.value ?? 1) <= 0
        && game.user?.isGM && game.users.activeGM?.id === game.user.id) {
        void (async () => { for (const scene of game.scenes) { const ids = scene.tokens.filter(token => token.actorId === actor.id).map(token => token.id); if (ids.length) await scene.deleteEmbeddedDocuments("Token", ids); }
            await actor.delete(); })().catch(error => notifyError("The thrall's removal failed", error));
        return;
    }
    if (!summoned?.endsAtZero || foundry.utils.getProperty(changes, "system.attributes.hp.value") === undefined || Number(actor.hitPoints?.value ?? 1) > 0) return;
    if (!game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void (async () => {
        const caster = await fromUuid(summoned.casterUuid);
        const effect = (caster?.itemTypes?.effect ?? []).find(entry => entry.flags?.[MODULE_ID]?.summon?.castId === summoned.castId);
        // (A ritual's hive: its destruction ends the ritual later — Mosquito Blight's hour.)
        if (effect && summoned.endsAfter) { if (!summoned.ending) { await actor.setFlag(MODULE_ID, "summoned.ending", true); await runtime.ritualHiveGone(effect); } return; }
        if (effect) await effect.delete();
    })().catch(error => notifyError("The double's end failed", error));
});

/** A region following a token (Magnetic Repulsion's adjacent squares): moved with it, by the active GM. */
Hooks.on("updateToken", (token, changes) => {
    if (!("x" in changes || "y" in changes || "width" in changes || "height" in changes) || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    for (const region of token.parent?.regions ?? []) {
        if (region.flags?.[MODULE_ID]?.followToken !== token.uuid) continue;
        // (Its own spaces — a conjured structure's — or the squares adjacent to it.)
        const size = canvas.grid.size;
        const follow = region.flags[MODULE_ID];
        const centre = { x: token.x + token.width * size / 2, y: token.y + token.height * size / 2 };
        const shapes = follow.followShape === "own" ? [{ type: "rectangle", x: token.x, y: token.y, width: token.width * size, height: token.height * size, rotation: 0, hole: false }]
            : follow.followShape === "emanation" ? [{ type: "circle", x: centre.x, y: centre.y, radiusX: follow.followRadius, radiusY: follow.followRadius, radius: follow.followRadius, rotation: 0, hole: false }]
            : repulsionShapes(token, size);
        void region.update({ shapes }).catch(error => notifyError("Moving the area with its token failed", error));
    }
});

/** Palm-Held Sun's pulse card: the GM's targets save against sunlight. */
function bindSunSunlightButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-sun-sunlight");
    const flag = message.getFlag(MODULE_ID, "sunSunlight");
    if (!button || button.dataset.runtimeBound || !flag) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await ongoing.request("sun-sunlight", { castId: flag.castId, tokenUuids: [...game.user.targets].map(token => token.document.uuid) }); } catch (error) { notifyError("Sunlight save", error); }
    });
}

/**
 * PF2e's applyDamage, through pf2e-resolution-core's damage patch (registered at init, below): a copy's halved Strikes before the damage; after it, awaited in
 * order before the caller's await resolves, what the module's Effects do with the Hit Points lost. Damage with a type in it that took Hit Points (Palm-Held
 * Sun's fire) is reported to the GM's record.
 */
function damageFollowUps(actor, params) {
    // (A copy that deals half damage with its Strikes — Duplicate Foe's on a success: the roll halved by PF2e's own multiplier.)
    try { params = halvedCopyDamage(params); } catch (error) { console.warn(`${MODULE_ID} | The copy's half damage failed.`, error); }
    const before = Number(actor.hitPoints?.value ?? actor.system?.attributes?.hp?.value ?? NaN);
    const beforeTemp = Number(actor.system?.attributes?.hp?.temp ?? 0);
    // (Shepherd of Souls: the reduction comes off this damage after resistances, before Hit Points — added for this application to the temporary Hit Points PF2e
    // reads as it starts, so its own sums absorb it — then the real temporary Hit Points restored, the reduction's excess healed, and the Effect used up. Not by healing.)
    const sacrifice = actor.itemTypes?.effect?.find(effect => effect.flags?.[MODULE_ID]?.sacrificeReduction);
    const harmful = typeof params?.damage === "number" ? params.damage > 0 : Number(params?.damage?.total ?? 0) > 0 && !params?.damage?.kinds?.has?.("healing");
    const held = sacrifice && harmful && actor.system?.attributes?.hp ? runtime.sacrificeBefore(actor, sacrifice) : null;
    return { params, after: async () => {
        try { if (held) await runtime.sacrificeAfter(actor, held); } catch (error) { console.warn(`${MODULE_ID} | The sacrifice's reduction failed.`, error); }
        // (Spiritual Guardian: a protected creature's damage beside the guardian, up to its amount, comes off the guardian instead.)
        try { if (actor.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.guardianProtect) && Number.isFinite(before)) await runtime.guardianAbsorb(actor, before, beforeTemp); } catch (error) { console.warn(`${MODULE_ID} | The guardian's protection failed.`, error); }
        // (Soulshelter Vessel: a creature that would drop to 0 HP regains the rescue from the stone instead.)
        try { if (actor.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.soulVessel) && Number.isFinite(before)) await runtime.soulRescue(actor, before); } catch (error) { console.warn(`${MODULE_ID} | The vessel's rescue failed.`, error); }
        // (Reflective Scales: what the scales' resistance prevented, counted.)
        try { if (actor.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.storedBurst)) await runtime.storedBurstPrevented(actor, params?.damage); } catch (error) { console.warn(`${MODULE_ID} | The stored burst count failed.`, error); }
        // (Phoenix Ward: damage of its type that dropped the caster to 0 leaves 1 Hit Point and heals.)
        try { if (actor.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.deathWard)) await runtime.deathWardTrigger(actor, before, params?.damage); } catch (error) { console.warn(`${MODULE_ID} | The ward failed.`, error); }
        // (Shielding Formation: a holder that switched on the resistance for this damage loses the bonus and is immune.)
        try { if (actor.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.shieldUse)) await runtime.shieldUsed(actor); } catch (error) { console.warn(`${MODULE_ID} | The shield's use failed.`, error); }
        try {
            const after = Number(actor.hitPoints?.value ?? actor.system?.attributes?.hp?.value ?? NaN);
            const types = [...new Set((params?.damage?.instances ?? []).map(instance => instance.type))];
            if (Number.isFinite(before) && after < before && types.includes("fire") && actor.isOfType?.("creature"))
                void ongoing.request("sun-fire", { actorUuid: actor.uuid }).catch(() => null);
        } catch (error) { console.warn(`${MODULE_ID} | The damage report failed.`, error); }
    } };
}

// PF2e's shared functions are wrapped once, by pf2e-resolution-core; this module's parts plug into its patches as the core's API appears (its
// pf2eResolutionCoreReady, during init: every module's script has loaded by then, whichever loaded first).
let pluggedIntoCore = false;
Hooks.once("pf2eResolutionCoreReady", api => {
    const patches = api.patches;
    pluggedIntoCore = true;
    // A module Effect's d20 limit ("… get a 10 instead"): set on PF2e's check roll before it's graded.
    patches.d20.registerLimitProvider({ module: MODULE_ID, name: "effect-d20-limits", limits: d20LimitsFor });
    // The "+" modules' passive features as their text says (text-rules.js), and an Arcane Cascade stance's damage type answered from the last spell
    // before PF2e asks (its items' creation runs the choice prompts: cascadeTypeAhead).
    patches.rules.registerRewriter({ module: MODULE_ID, name: "text-rules", rewrite: rulesFromText });
    patches.rules.registerCreateTransformer({ module: MODULE_ID, name: "arcane-cascade", transform: cascadeTypeAhead });
    // Terrain only for some creatures (Magnetic Repulsion): a movement-cost behavior flagged `selectiveTerrain` gives its difficulty per creature
    // (by actor, by size, to the living) instead of to everyone; any other behavior is Foundry's own.
    patches.terrain.registerProvider({ module: MODULE_ID, name: "selective-terrain",
        selective: behavior => behavior.behavior?.flags?.[MODULE_ID]?.selectiveTerrain ?? behavior.parent?.flags?.[MODULE_ID]?.selectiveTerrain ?? null });
    // Damage: a copy's halved Strikes, and what the module's Effects do with the Hit Points lost (damageFollowUps); then Demon Bone Tiles' shield,
    // marked after a Shield Block with it.
    patches.damage.onApply({ module: MODULE_ID, name: "damage-follow-ups", before: damageFollowUps });
    patches.damage.onApply({ module: MODULE_ID, name: "shield-shards", before: shieldShardsBlock });
    // This module's spell plans for the core's registry (the simulator's planner): the plans live play uses — compiling awaits the spells the text
    // names, so the core's preparePlan(s) fills its cache before planFor reads it.
    api.registry.registerCompiler({ module: MODULE_ID, name: "spells", handles: item => item?.type === "spell", compile: (item, options) => runtime.compile(item, options) });
});
Hooks.once("setup", () => { if (!pluggedIntoCore) console.error(`${MODULE_ID} | pf2e-resolution-core isn't active: d20 limits, text rules, selective terrain and what follows damage won't apply.`); });
Hooks.on("createChatMessage", message => { if (message.item?.slug === "sustain") void waywardSustain(message).catch(error => notifyError("Wayward Gifts failed", error)); });
Hooks.on("createItem", item => { if (item.type === "effect") void textRulesOnCreate(item).catch(error => notifyError("An Effect's value from its text failed", error)); });
// (A "+" feature regaining a Focus Point, its card posted.)
Hooks.on("createChatMessage", message => { if (["feat", "action"].includes(message.flags?.pf2e?.origin?.type)) void focusRegainOnCard(message).catch(error => notifyError("A Focus Point regained failed", error)); });
// (A "+" action spending residual energy to cast — Become Elemental, Create Elemental —, its card posted.)
Hooks.on("createChatMessage", message => { if (["feat", "action"].includes(message.flags?.pf2e?.origin?.type)) void actionCastOnCard(message).catch(error => notifyError("A feature's casting failed", error)); });

/** Radiant Field's turn-start save card. */
function bindRadiantSaveButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-radiant-save");
    const flag = message.getFlag(MODULE_ID, "radiantSave");
    if (!button || button.dataset.runtimeBound || !flag) return;
    button.dataset.runtimeBound = "true";
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        button.disabled = true;
        try { await ongoing.request("radiant-save", { castId: flag.castId, actorUuid: flag.actorUuid }); } catch (error) { button.disabled = false; notifyError("Save", error); }
    });
}

/** A lantern's save card (Reaper's Lantern): the creature's owner or the GM rolls it (the GM records it). */
function bindLanternSaveButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-lantern-save");
    const flag = message.getFlag(MODULE_ID, "lanternSave");
    if (!button || button.dataset.runtimeBound || !flag) return;
    button.dataset.runtimeBound = "true";
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        button.disabled = true;
        try { await ongoing.request("lantern-save", { castId: flag.castId, actorUuid: flag.actorUuid }); } catch (error) { button.disabled = false; notifyError("Save", error); }
    });
}

/**
 * "gain only half the normal benefit from healing effects while within the area" (Reaper's Lantern): PF2e's healing update (its negative
 * `damageTaken`) on a creature holding the half-healing Effect keeps half the Hit Points (rounded down).
 */
Hooks.on("preUpdateActor", (actor, changes, options) => {
    if (!(Number(options?.damageTaken) < 0)) return;
    const holder = (actor.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.halfHealing);
    if (!holder) return;
    const key = "system.attributes.hp.value";
    const flat = key in changes;
    const after = flat ? changes[key] : foundry.utils.getProperty(changes, key);
    const before = Number(actor._source?.system?.attributes?.hp?.value);
    if (typeof after !== "number" || !Number.isFinite(before) || after <= before) return;
    const kept = Math.floor((after - before) / 2);
    if (flat) changes[key] = before + kept; else foundry.utils.setProperty(changes, key, before + kept);
    options.damageTaken = -kept;
    // (A one-use halving — a path maiden's Blasphemous Aura on one healing spell: spent.)
    if (holder.flags[MODULE_ID].halfHealing?.once) void holder.delete().catch(() => null);
    // (This hook runs only on the client making the update.)
    void ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
        content: `<p><strong>${foundry.utils.escapeHTML(holder.name)}</strong>: ${foundry.utils.escapeHTML(actor.name)} regains ${kept} instead of ${after - before} Hit Points (half the healing).</p>` }).catch(() => null);
});

/**
 * "When a creature within the area would regain Hit Points, … it must attempt a Will save." (Fallow Field): PF2e's healing update on a creature
 * holding the area's marker (and not immune) is held — the Hit Points stay — and the area's save is rolled; the result's share is then restored.
 */
Hooks.on("preUpdateActor", (actor, changes, options) => {
    if (!(Number(options?.damageTaken) < 0) || options?.[MODULE_ID]?.healingSaveRestore) return;
    const watch = (actor.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.healingWatch);
    if (!watch) return;
    const castId = watch.flags[MODULE_ID].healingWatch.castId;
    if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.healingSaveImmune?.castId === castId && !effect.isExpired)) return;
    const key = "system.attributes.hp.value";
    const flat = key in changes;
    const after = flat ? changes[key] : foundry.utils.getProperty(changes, key);
    const before = Number(actor._source?.system?.attributes?.hp?.value);
    if (typeof after !== "number" || !Number.isFinite(before) || after <= before) return;
    if (flat) changes[key] = before; else foundry.utils.setProperty(changes, key, before);
    options.damageTaken = 0;
    void ongoing.request("healing-save", { castId, actorUuid: actor.uuid, amount: after - before }).catch(error => notifyError("Healing save", error));
});

/** A sustained dance's Escape card (Coiling Dance): the user's one selected token is the ally escaping; its target (if any) is what holds it. */
function bindEscapePromptButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-escape-prompt");
    if (!button || button.dataset.runtimeBound || !message.getFlag(MODULE_ID, "escapePrompt")) return;
    button.dataset.runtimeBound = "true";
    if (message.getFlag(MODULE_ID, "escapePrompt").used) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        const selected = canvas.tokens?.controlled ?? [];
        if (selected.length !== 1) { ui.notifications.warn("Select the one ally that escapes (and target the creature holding it, for its DC)."); return; }
        try { await ongoing.escapePrompt(message, { tokenUuid: selected[0].document.uuid }); button.disabled = true; } catch (error) { notifyError("Escape", error); }
    });
}

/** A ritual's card: the target asked against its nature rolls its save to end it (the GM). */
function bindRitualEndButtons(message, root) {
    if (!message.getFlag(MODULE_ID, "ritualEnd")) return;
    const button = root.querySelector(".pf2e-auto-ritual-end");
    if (!button || button.dataset.runtimeBound) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await runtime.ritualEndSave(message); } catch (error) { notifyError("Ritual", error); }
    });
}

/** A ritual's slip card: the save, the check, or no check (the GM or the caster's owner). */
function bindRitualSlipButtons(message, root) {
    if (!message.getFlag(MODULE_ID, "ritualSlip")) return;
    for (const button of root.querySelectorAll(".pf2e-auto-ritual-slip")) {
        if (button.dataset.runtimeBound) continue;
        button.dataset.runtimeBound = "true";
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            try { await runtime.ritualSlip(message, { act: button.dataset.act }); } catch (error) { notifyError("Ritual", error); }
        });
    }
}
// A caster with a ritual's phantom oil moved in combat: its first move each encounter gets the card (the active GM).
Hooks.on("updateToken", (token, changes) => {
    if (!("x" in changes || "y" in changes) || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void runtime.ritualSlipCheck(token).catch(error => notifyError("Ritual", error));
});

/** Illusory Creature's card: the image's Strike and a creature's Disbelieve (the GM's target). */
function bindIllusoryButtons(message, root) {
    if (!message.getFlag(MODULE_ID, "illusoryCard")) return;
    const buttons = [...root.querySelectorAll(".pf2e-auto-illusory")];
    if (!buttons.length || buttons[0].dataset.runtimeBound) return;
    for (const button of buttons) {
        button.dataset.runtimeBound = "true";
        if (!game.user.isGM) { button.disabled = true; continue; }
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            try { await runtime.illusoryAct(message, { act: button.dataset.act }); } catch (error) { notifyError("Illusory Creature", error); }
        });
    }
}
// The image hit, failing a save, or too far: the spell ends (the active GM).
Hooks.on("createChatMessage", message => {
    const type = message?.flags?.pf2e?.context?.type;
    if (!["attack-roll", "saving-throw"].includes(type) || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void runtime.illusoryCheck({ message }).catch(error => notifyError("Illusory Creature", error));
});
Hooks.on("updateToken", (token, changes) => {
    if (!("x" in changes || "y" in changes) || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void runtime.illusoryCheck().catch(error => notifyError("Illusory Creature", error));
});

/** One with Plants' merged card: the expulsions. */
function bindPlantExpelButtons(message, root) {
    if (!message.getFlag(MODULE_ID, "plantExpel")) return;
    const buttons = [...root.querySelectorAll(".pf2e-auto-plant-expel")];
    if (!buttons.length || buttons[0].dataset.runtimeBound) return;
    for (const button of buttons) {
        button.dataset.runtimeBound = "true";
        if (!game.user.isGM) { button.disabled = true; continue; }
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            buttons.forEach(entry => { entry.disabled = true; });
            try { await runtime.plantExpel(message, { damage: button.dataset.damage === "true" }); } catch (error) { buttons.forEach(entry => { entry.disabled = false; }); notifyError("One with Plants", error); }
        });
    }
}

/** Helpful Wood Spirits' Sustain card: this round's aid. */
function bindSpiritAidButtons(message, root) {
    const flag = message.getFlag(MODULE_ID, "spiritAid");
    if (!flag) return;
    const buttons = [...root.querySelectorAll(".pf2e-auto-spirit-aid")];
    if (!buttons.length || buttons[0].dataset.runtimeBound) return;
    for (const button of buttons) {
        button.dataset.runtimeBound = "true";
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            buttons.forEach(entry => { entry.disabled = true; });
            try { await ongoing.request("spirit-aid", { castId: flag.castId, aid: button.dataset.aid }); } catch (error) { buttons.forEach(entry => { entry.disabled = false; }); notifyError("Wood spirits", error); }
        });
    }
}

/** Web's check card: Athletics or the save, the creature's choice. */
function bindWebCheckButtons(message, root) {
    const flag = message.getFlag(MODULE_ID, "webCheck");
    if (!flag) return;
    const buttons = [...root.querySelectorAll(".pf2e-auto-web-check")];
    if (!buttons.length || buttons[0].dataset.runtimeBound) return;
    for (const button of buttons) {
        button.dataset.runtimeBound = "true";
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            buttons.forEach(entry => { entry.disabled = true; });
            try { await ongoing.request("web-check", { castId: flag.castId, actorUuid: flag.actorUuid, stat: button.dataset.stat }); } catch (error) { buttons.forEach(entry => { entry.disabled = false; }); notifyError("Web", error); }
        });
    }
}

/** Burrow Ward's card: the underground creatures' saves. */
function bindBurrowUnderButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-burrow-under");
    if (!button || button.dataset.runtimeBound || !message.getFlag(MODULE_ID, "burrowUnder")) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await runtime.burrowUnder(message); } catch (error) { notifyError("Burrow Ward", error); }
    });
}

/** Sea Surge's card: the wave moves on. */
function bindWaveRepeatButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-wave-repeat");
    const flag = message.getFlag(MODULE_ID, "waveRepeat");
    if (!button || button.dataset.runtimeBound || !flag) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM || flag.used) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        button.disabled = true;
        try { await basicSaves.waveRepeat(message); } catch (error) { button.disabled = false; notifyError("The wave", error); }
    });
}

/** Blister's card: pop one charge for the targeted creatures. */
function bindPopSaveButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-pop-save");
    const flag = message.getFlag(MODULE_ID, "popSave");
    if (!button || button.dataset.runtimeBound || !flag) return;
    button.dataset.runtimeBound = "true";
    if (!(flag.left > 0)) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        button.disabled = true;
        try { await basicSaves.popSave(message); } catch (error) { notifyError("The pop", error); }
        button.disabled = !(message.getFlag(MODULE_ID, "popSave")?.left > 0);
    });
}

/** Pack Breaker's card: the affected creature's former allies save. */
function bindChainSaveButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-chain-save");
    const flag = message.getFlag(MODULE_ID, "chainSave");
    if (!button || button.dataset.runtimeBound || !flag) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM || flag.used) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        button.disabled = true;
        try { await basicSaves.chainSave(message); if (flag.repeatable) button.disabled = false; } catch (error) { button.disabled = false; notifyError("The chained saves", error); }
    });
}

/** Grisly Growths' card: the second save around the target. */
function bindAreaFollowUpButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-area-follow-up");
    const flag = message.getFlag(MODULE_ID, "areaFollowUp");
    if (!button || button.dataset.runtimeBound || !flag) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM || flag.used) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        button.disabled = true;
        try { await basicSaves.areaFollowUp(message); } catch (error) { button.disabled = false; notifyError("The follow-up saves", error); }
    });
}

/** Blazing Armory's card: the touch damage to the GM's target. */
function bindConjuredTouchButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-conjured-touch");
    if (!button || button.dataset.runtimeBound || !message.getFlag(MODULE_ID, "conjuredTouch")) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await runtime.conjuredTouch(message); } catch (error) { notifyError("Touch damage", error); }
    });
}

/** Mark of Blood's cards: the struck creature's save, and the caster's Seek. */
function bindBloodMarkButtons(message, root) {
    for (const [selector, flag, run] of [[".pf2e-auto-blood-save", "bloodMarkSave", () => runtime.bloodMarkSave(message)], [".pf2e-auto-blood-seek", "bloodMarkSeek", () => runtime.bloodMarkSeek(message)]]) {
        const button = root.querySelector(selector);
        if (!button || button.dataset.runtimeBound || !message.getFlag(MODULE_ID, flag)) continue;
        button.dataset.runtimeBound = "true";
        if (message.getFlag(MODULE_ID, flag).used) { button.disabled = true; continue; }
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            button.disabled = true;
            try { await run(); } catch (error) { button.disabled = false; notifyError("Mark of Blood", error); }
        });
    }
}
// The marked weapon's next hit (the active GM reads the attack message).
Hooks.on("createChatMessage", message => {
    if (message?.flags?.pf2e?.context?.type !== "attack-roll" || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void runtime.bloodMarkHit(message).catch(error => notifyError("Mark of Blood", error));
});

/** Dancing Shield's card: the caster's Shield Block for the target. */
/** A card's repeatable roll for the GM to apply to an object (Rusting Grasp's rust on an item): the stated formula, posted with its flavor. */
function bindCardRollButtons(message, root) {
    if (!message.getFlag(MODULE_ID, "cardRoll")) return;
    for (const button of root.querySelectorAll(".pf2e-auto-card-roll")) {
        if (button.dataset.runtimeBound) continue;
        button.dataset.runtimeBound = "true";
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            try { await runtime.cardRoll(message, button.dataset.roll); } catch (error) { notifyError("Card roll", error); }
        });
    }
}

/** A card's control for the GM (Murderous Vine's destruction). */
function bindCardActionButtons(message, root) {
    for (const button of root.querySelectorAll(".pf2e-auto-card-action")) {
        if (button.dataset.runtimeBound) continue;
        button.dataset.runtimeBound = "true";
        if (!game.user.isGM) { button.disabled = true; continue; }
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            try { await runtime.cardAction(message, button.dataset.action); } catch (error) { notifyError("Card action", error); }
        });
    }
}

/** An imbued object's card (Necrotic Radiation): the GM moves the hazard to the creature now holding the object. */
function bindImbuedHazardButtons(message, root) {
    if (!message.getFlag(MODULE_ID, "imbuedHazard")) return;
    for (const button of root.querySelectorAll(".pf2e-auto-imbued-hazard")) {
        if (button.dataset.runtimeBound) continue;
        button.dataset.runtimeBound = "true";
        if (!game.user.isGM) { button.disabled = true; continue; }
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            try { await runtime.imbuedHazardHolder(message); } catch (error) { notifyError("Imbued object", error); }
        });
    }
}

/** An incarnate's card: a button per phase (Arrive, Depart) for the targeted creatures. */
function bindIncarnateButtons(message, root) {
    if (!message.getFlag(MODULE_ID, "incarnate")) return;
    for (const button of root.querySelectorAll(".pf2e-auto-incarnate")) {
        if (button.dataset.runtimeBound) continue;
        button.dataset.runtimeBound = "true";
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            try { await runtime.incarnatePhase(message, button.dataset.phase); } catch (error) { notifyError("Incarnate", error); }
        });
    }
}

/** A granted action's card (Swarm Form's crawl): its save for the targeted creature. */
function bindGrantedActionButtons(message, root) {
    if (!message.getFlag(MODULE_ID, "grantedAction")) return;
    for (const button of root.querySelectorAll(".pf2e-auto-granted-action")) {
        if (button.dataset.runtimeBound) continue;
        button.dataset.runtimeBound = "true";
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            try { await runtime.grantedAction(message, button.dataset.index); } catch (error) { notifyError("Granted action", error); }
        });
    }
}

function bindNoteShieldBlockButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-note-shield-block");
    if (!button || button.dataset.runtimeBound || !message.getFlag(MODULE_ID, "noteShieldBlock")) return;
    button.dataset.runtimeBound = "true";
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await runtime.noteShieldBlock(message); } catch (error) { notifyError("Shield Block", error); }
    });
}

/** Knock's card: the check made as part of casting. */
function bindNoteCheckButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-note-check");
    if (!button || button.dataset.runtimeBound || !message.getFlag(MODULE_ID, "noteCheck")) return;
    button.dataset.runtimeBound = "true";
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await runtime.noteCheck(message); button.disabled = true; } catch (error) { notifyError("Check", error); }
    });
}

/** A spell maneuver card (Telekinetic Maneuver): each button rolls PF2e's action with the spell attack against the card's target. */
function bindSpellManeuverButtons(message, root) {
    if (!message.getFlag(MODULE_ID, "spellManeuver")) return;
    for (const button of root.querySelectorAll(".pf2e-auto-spell-maneuver")) {
        if (button.dataset.runtimeBound) continue;
        button.dataset.runtimeBound = "true";
        button.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            const map = Number(root.querySelector(".pf2e-auto-spell-maneuver-map")?.value ?? 0);
            try { await runtime.spellManeuver(message, { action: button.dataset.action, map, event }); } catch (error) { notifyError("Maneuver", error); }
        });
    }
}

/** A trail left later (Burning Trail): the GM places the selected region. */
function bindPlaceWallButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-place-wall");
    const data = message.getFlag(MODULE_ID, "deferredWall");
    if (!button || !data || button.dataset.runtimeBound) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM || data.placed || game.time.worldTime > data.expiresAt) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await runtime.placeDeferredWall(message); } catch (error) { notifyError("Place", error); }
    });
}

/** The Steal card (Umbral Mindtheft, Umbral Extraction). */
function bindStealButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-steal");
    const data = message.getFlag(MODULE_ID, "stealDamage");
    if (!button || !data || button.dataset.runtimeBound) return;
    button.dataset.runtimeBound = "true";
    if (data.stolen || game.time.worldTime > data.expiresAt) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await runtime.stealDamage(message, { event }); } catch (error) { notifyError("Steal", error); }
    });
}

/** Extract Poison's Counteract button. */
function bindCounteractTransferButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-counteract-transfer");
    const data = message.getFlag(MODULE_ID, "counteractTransfer");
    if (!button || !data || button.dataset.runtimeBound) return;
    button.dataset.runtimeBound = "true";
    if (!game.user.isGM || data.result) { button.disabled = true; return; }
    button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        try { await runtime.counteractTransfer(message); } catch (error) { notifyError("Counteract", error); }
    });
}

/**
 * Extract Poison's coated weapon: the Effect goes after the next damage roll with that weapon, or a critically failed attack roll with it.
 * (The active GM removes it.)
 */
Hooks.on("createChatMessage", async message => {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    const context = message.flags?.pf2e?.context;
    const actor = message.actor ?? (message.speaker?.actor ? game.actors.get(message.speaker.actor) : null);
    if (!context || !actor) return;
    const coated = actor.itemTypes?.effect?.filter(effect => effect.flags?.[MODULE_ID]?.consumedBy?.actorUuid === actor.uuid) ?? [];
    if (!coated.length) return;
    const weaponId = message.flags?.pf2e?.origin?.uuid?.split(".").at(-1) ?? message.item?.id ?? null;
    const spent = coated.filter(effect => effect.flags[MODULE_ID].consumedBy.weaponId === weaponId
        && (context.type === "damage-roll" || (context.type === "attack-roll" && context.outcome === "criticalFailure")));
    if (spent.length) await actor.deleteEmbeddedDocuments("Item", spent.map(effect => effect.id)).catch(() => null);
});

function bindFoodButtons(message, root) {
    const button = root.querySelector(".pf2e-auto-food-button");
    const state = message.getFlag(MODULE_ID, "food");
    if (!button || !state || button.dataset.runtimeBound) return;
    button.dataset.runtimeBound = "true";
    if (game.time.worldTime > state.expiresAt) { button.disabled = true; button.textContent = "Withered away"; return; }
    button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const targets = [...game.user.targets], controlled = canvas.tokens?.controlled ?? [];
        const eater = targets.length === 1 ? targets[0].actor : targets.length ? null : controlled.length === 1 ? controlled[0].actor : controlled.length ? null : game.user.character;
        if (!eater) return notifyError("Food", new Error("Target (or control) exactly one creature to eat the food."));
        let count = 1;
        if (state.anyAmount && state.remaining > 1) {
            const value = await foundry.applications.api.DialogV2.prompt({ window: { title: `${state.spellName} — Eat` },
                content: `<label>Pieces ${foundry.utils.escapeHTML(eater.name)} eats (1–${state.remaining}) <input type="number" name="count" min="1" max="${state.remaining}" value="${state.remaining}" autofocus></label>`,
                ok: { label: "Eat", callback: (_event, dialogButton) => Number(dialogButton.form.elements.count.value) }, rejectClose: false });
            if (!value) return;
            count = value;
        }
        button.disabled = true;
        try { await runtime.consumeFood({ messageId: message.id, eaterUuid: eater.uuid, count }); }
        catch (error) { button.disabled = false; notifyError("Eating the food failed", error); }
    });
}

async function addResolutionButton(message, root) {
    if (root.querySelector(".pf2e-auto-runtime-resolve")) return;
    const context = spellCardContext(message);
    if (!context) return;
    await currentPrinting(context, message);
    if (root.querySelector(".pf2e-auto-runtime-resolve")) return;
    const canPrepare = game.user.isGM || context.actor.canUserModify?.(game.user, "update");

    if (forms.supports(context.item)) {
        if (!canPrepare) return;
        const button = document.createElement('button');
        button.className = 'pf2e-auto-runtime-resolve';
        button.textContent = message.getFlag(MODULE_ID, 'ongoingCastId') ? 'Form resolved' : 'Choose and Apply Form';
        button.disabled = !!message.getFlag(MODULE_ID, 'ongoingCastId');
        root.appendChild(button);
        button.addEventListener('click', async () => {
            button.disabled = true;
            try { const result = await forms.start(context.item, {sourceMessageId:message.id,castRank:context.castRank});
                if(result.status==='cancelled')button.disabled=false;
            } catch(error){button.disabled=false;notifyError('Form resolution failed',error);}
        });
        return;
    }
    if (immediate.supports(context.item)) {
        if (!canPrepare) return;
        const button = document.createElement("button");
        button.className = "pf2e-auto-runtime-resolve";
        button.type = "button";
        button.textContent = message.getFlag(MODULE_ID, "immediateCast") ? "Immediate Resolution Prepared" : "Resolve Immediate Spell";
        button.disabled = !!message.getFlag(MODULE_ID, "immediateCast");
        (root.querySelector(".card-buttons") ?? root).appendChild(button);
        button.addEventListener("click", async () => {
            button.disabled = true;
            try { const result = await immediate.start(context.item, { sourceMessageId: message.id, castRank: context.castRank });
                if (result.status === "cancelled") button.disabled = false;
            } catch (error) { button.disabled = false; notifyError("Immediate resolution failed", error); }
        });
        return;
    }
    let plan;
    try { plan = await runtime.compile(context.baseSource); }
    catch (error) {
        console.warn("PF2e Automatic Resolution | Spell plan compilation failed:", error);
        return;
    }
    // A Strike spell carried by Effects on the caster: the caster's owner applies them, then Strikes with PF2e.
    if (strikeEffects.supports(plan)) {
        if (!canPrepare) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pf2e-auto-runtime-resolve";
        const done = message.getFlag(MODULE_ID, "resolvedCast");
        button.innerHTML = done ? '<i class="fa-solid fa-check"></i> Strike Effects Applied' : '<i class="fa-solid fa-hand-fist"></i> Resolve Strike Spell';
        button.disabled = !!done;
        (root.querySelector(".card-buttons") ?? root).appendChild(button);
        button.addEventListener("click", async () => {
            button.disabled = true;
            try { await strikeEffects.start(context.item, plan, { sourceActor: context.item.actor, castRank: context.castRank, sourceMessageId: message.id }); }
            catch (error) { button.disabled = false; notifyError("Strike spell resolution failed", error); }
        });
        return;
    }
    // A spell that waits for its trigger: casting sets it; Ongoing spells fires it at the triggering creature.
    if (storedTriggers.supports(plan)) {
        if (!canPrepare) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pf2e-auto-runtime-resolve";
        const set = message.getFlag(MODULE_ID, "ongoingCastId");
        button.innerHTML = set ? '<i class="fa-solid fa-check"></i> Waiting for its trigger' : '<i class="fa-solid fa-bomb"></i> Set (waits for its trigger)';
        button.disabled = !!set;
        (root.querySelector(".card-buttons") ?? root).appendChild(button);
        button.addEventListener("click", async () => {
            button.disabled = true;
            try { await storedTriggers.start(context.item, plan, { sourceActor: context.actor, castRank: context.castRank, sourceMessageId: message.id, targets: [...game.user.targets] }); }
            catch (error) { button.disabled = false; notifyError("Setting the spell failed", error); }
        });
        return;
    }
    // A messaging spell: the caster writes the message; it's whispered to the target's owners.
    if (messages.supports(plan)) {
        if (!canPrepare) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pf2e-auto-runtime-resolve";
        const sent = message.getFlag(MODULE_ID, "messageCast");
        button.innerHTML = sent ? '<i class="fa-solid fa-check"></i> Message Sent' : '<i class="fa-solid fa-comment"></i> Send Message';
        button.disabled = !!sent;
        (root.querySelector(".card-buttons") ?? root).appendChild(button);
        button.addEventListener("click", async () => {
            button.disabled = true;
            try {
                const result = await messages.start(context.item, plan, { sourceActor: context.actor, castRank: context.castRank, sourceMessageId: message.id });
                if (result.status === "cancelled") button.disabled = false;
            } catch (error) { button.disabled = false; notifyError("Message failed", error); }
        });
        return;
    }
    if (care.supports(plan)) {
        if (!game.user.isGM) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pf2e-auto-runtime-resolve";
        button.textContent = message.getFlag(MODULE_ID, "careResolved") ? "Affliction Care Resolved" : `Resolve ${context.item.name}`;
        button.disabled = !!message.getFlag(MODULE_ID, "careResolved");
        (root.querySelector(".card-buttons") ?? root).appendChild(button);
        button.addEventListener("click", async () => {
            button.disabled = true;
            try {
                const result = await care.start(context.item, plan, { castRank: context.castRank });
                if (result.status === "cancelled") button.disabled = false;
                else await message.setFlag(MODULE_ID, "careResolved", result.message?.id ?? true);
            } catch (error) { button.disabled = false; notifyError("Affliction care failed", error); }
        });
        return;
    }
    if (ongoingFamilies.supportsLingering(plan)) {
        if (!game.user.isGM) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pf2e-auto-runtime-resolve";
        const placed = message.getFlag(MODULE_ID, "ongoingCastId");
        button.textContent = placed ? "Lingering Area Active" : plan.resolution.lingering.centre === "placed" ? "Place Lingering Area"
            : plan.resolution.lingering.centre === "targets" ? "Start Sustained Spell (targeted creature)" : "Start Lingering Emanation";
        button.disabled = !!placed;
        (root.querySelector(".card-buttons") ?? root).appendChild(button);
        button.addEventListener("click", async () => {
            button.disabled = true;
            try {
                // (Pyrotechnics: the mode chosen when casting — each its own lingering area.)
                const modes = plan.resolution.lingeringModes ?? null;
                const key = modes ? await foundry.applications.api.DialogV2.wait({ window: { title: `${plan.source.name} — which?` }, content: `<p>Choose the spell's form.</p>`,
                    buttons: modes.map(mode => ({ action: mode.key, label: mode.label })), close: () => null, rejectClose: false }) : null;
                if (modes && !key) { button.disabled = false; return; }
                const chosen = modes ? modes.find(mode => mode.key === key).plan : plan;
                const targeted = [...game.user.targets];
                const result = await ongoingFamilies.startLingering(context.item, chosen, { sourceMessageId: message.id, castRank: context.castRank, targets: targeted });
                if (result.status === "cancelled") button.disabled = false;
                // (Pyrotechnics: a creature as the fire source takes the stated damage.)
                else await sourceCreatureDamage(plan, context.item, targeted);
            } catch (error) { button.disabled = false; notifyError("Lingering area failed", error); }
        });
        return;
    }
    const ongoingPlan = ongoingFamilies.supports(context.item);
    const effectPlan = !ongoingPlan && runtime.supportedResolutionKinds.includes(plan.resolution?.kind);
    const savePlan = basicSaves.supports(plan);
    // A spell attack, a Strike spell, or a save the PF2e item doesn't declare has no native save button: add our own.
    const checkStatistic = plan.resolution.check?.statistic;
    const attackPlan = savePlan && (["spell-attack", "strike"].includes(checkStatistic) || !root.querySelector('button[data-action="spell-save"]'));
    const ownLabel = checkStatistic === "spell-attack" ? ["Spell Attack Prepared", '<i class="fa-solid fa-crosshairs"></i> Resolve Spell Attack']
        : checkStatistic === "strike" ? ["Strike Spell Prepared", '<i class="fa-solid fa-hand-fist"></i> Resolve Strike Spell']
            : ["Saves Prepared", '<i class="fa-solid fa-shield-halved"></i> Prepare Saves'];
    if (!effectPlan && !savePlan && !ongoingPlan) {
        if (!root.querySelector('.pf2e-auto-coverage-note')) {
            // A spell with PF2e variants (action counts): each chosen variant has its own card.
            const variantNames = [];
            if (context.item?.hasVariants && !context.item.isVariant) {
                for (const id of Object.keys(context.item.system?.overlays ?? {})) {
                    try {
                        const variant = context.item.loadVariant({ overlayIds: [id] });
                        const variantPlan = variant ? await runtime.compile(variant) : null;
                        const resolvable = variantPlan && (basicSaves.supports(variantPlan)
                            || (runtime.supportedResolutionKinds.includes(variantPlan.resolution?.kind) && variantPlan.automation?.level === "automatic"));
                        if (resolvable) variantNames.push({ time: variant.system?.time?.value ?? null, name: variant.name });
                    } catch (_) { /* an unreadable variant is simply not offered */ }
                }
            }
            // Named by action count, or by name where two variants share one (Lay on Hands: Healing / Vs. Undead).
            const times = variantNames.map(entry => entry.time);
            const labels = variantNames.map(({ time, name }) => time && times.indexOf(time) === times.lastIndexOf(time)
                ? `${time} action${time === "1" ? "" : "s"}` : name);
            const note = document.createElement('p');
            note.className = 'pf2e-auto-coverage-note';
            note.textContent = labels.length
                ? `Choose a variant above; the resolution button appears on its card (automated: ${labels.join(", ")}).`
                : 'Manual resolution: this spell is not yet automated. Native save rolls will not apply its damage or conditions.';
            root.appendChild(note);
        }
        return;
    }
    if ((effectPlan || ongoingPlan) && !canPrepare) return;

    const nativeSaveButton = ((savePlan && !attackPlan) || (ongoingPlan && context.item.system.defense?.save))
        ? root.querySelector('button[data-action="spell-save"]')
        : null;
    if (((savePlan && !attackPlan) || nativeSaveButton) && !claimNativeSpellSaveButton(nativeSaveButton)) return;
    const button = nativeSaveButton ?? document.createElement("button");
    if (effectPlan || ongoingPlan || attackPlan) {
        button.type = "button";
        button.className = "pf2e-auto-runtime-resolve";
    }
    const nativeSaveLabel = savePlan && !attackPlan ? button.textContent.trim() : null;
    const savedSaveCast = savePlan
        ? message.getFlag(MODULE_ID, "saveCast") ?? message.getFlag(MODULE_ID, "basicSaveCast")
        : null;
    const resolved = ongoingPlan ? message.getFlag(MODULE_ID, "ongoingCastId") : effectPlan
        ? message.getFlag(MODULE_ID, "resolvedCast")
        : savedSaveCast && game.messages.get(savedSaveCast.resolutionMessageId)
            ? savedSaveCast
            : null;
    // Blasts repeated during the turn: each click is one blast (its own attack card) until the caster's turn passes.
    // Attacks repeated on the caster's later turns ("can repeat the attack once on each of your subsequent turns … After your third
    // attack total, the spell ends."): one per turn of the caster's, up to the total, within the spell's duration.
    const repeatable = savePlan && ["turn", "subsequent-turns", "sustain", "duration"].includes(plan.resolution.repeatable?.window) ? plan.resolution.repeatable : null;
    // (An attack on each Sustain works like one on each later turn: once per turn of the caster's, while the spell lasts.)
    const laterTurns = ["subsequent-turns", "sustain", "duration"].includes(repeatable?.window);
    const onSustain = repeatable?.window === "sustain";
    // (Any number of single-action attacks while the spell lasts, on any turn: Blazing Blade.)
    const anyTime = repeatable?.window === "duration";
    // A breath weapon gained by a counteract (Swallow Light): nothing until the card's counteract succeeds, and not again until it recharges.
    const gate = anyTime ? repeatable.gate ?? null : null;
    const gateState = () => message.getFlag(MODULE_ID, "repeatGate") ?? null;
    const recharging = () => { const until = message.getFlag(MODULE_ID, "repeatWindow")?.rechargeUntil; return until != null && game.time.worldTime < until ? until : null; };
    const attacksMade = () => message.getFlag(MODULE_ID, "repeatWindow")?.attacks?.length ?? 0;
    // (A save repeated on each Sustain ends when a result row ends the spell: Lurking Doom's critical success — the card sets "ended".)
    const attacksLeft = () => { const opened = message.getFlag(MODULE_ID, "repeatWindow");
        return !opened || (!opened.ended && (anyTime || attacksMade() < repeatable.attacks) && (opened.endsAt == null || game.time.worldTime <= opened.endsAt)); };
    const windowOpen = () => {
        const opened = message.getFlag(MODULE_ID, "repeatWindow");
        if (laterTurns) {
            if (!attacksLeft()) return false;
            if (anyTime) return (!gate || gateState()?.countered === true) && recharging() == null;
            if (!opened || !opened.combatId || !game.combat?.started || opened.combatId !== game.combat.id) return true;
            // ("You can Sustain the Spell multiple times in the same round": any number on the caster's turn.)
            return game.combat.combatant?.actorId === context.actor?.id && (repeatable.perTurn === "any" || !opened.attacks.some(attack => attack.round === game.combat.round && attack.turn === game.combat.turn));
        }
        if (!opened || !game.combat?.started || opened.combatId !== game.combat.id) return !opened || !opened.combatId;
        return opened.round === game.combat.round && opened.turn === game.combat.turn;
    };
    const againLabel = () => anyTime ? `<i class="fa-solid fa-crosshairs"></i> ${repeatable.actions === 1 ? "Attack (1 action)" : `Use again (${repeatable.actions} actions)`} — ${attacksMade() + 1}` : onSustain && repeatable.trigger === "turn-start" ? `<i class="fa-solid fa-crosshairs"></i> Start of turn: Attack (${attacksMade() + 1})` : onSustain ? `<i class="fa-solid fa-crosshairs"></i> Sustain: ${plan.resolution.check?.statistic === "spell-attack" ? "Attack" : "Again"} (${attacksMade() + 1})` : laterTurns ? `<i class="fa-solid fa-crosshairs"></i> Attack Again (${attacksMade() + 1} of ${repeatable.attacks})` : '<i class="fa-solid fa-crosshairs"></i> Blast Again';
    // Later-turn attacks stay available until they're used up; a click off the caster's turn explains why it can't attack yet.
    const again = () => repeatable && (laterTurns ? attacksLeft() : windowOpen());
    button.disabled = (!!resolved && !again()) || (savePlan && !canPrepare);
    // (Only the GM and the caster prepare the cast: hidden from everyone else — targets roll on the save card.)
    if (savePlan && !canPrepare) button.hidden = true;
    button.innerHTML = repeatable && resolved && again() ? againLabel()
        : laterTurns && resolved ? '<i class="fa-solid fa-check"></i> Attacks Used'
        : resolved
        ? `<i class="fa-solid fa-check"></i> ${effectPlan ? "Native Effect Resolved" : attackPlan ? ownLabel[0] : "Saves Prepared"}`
        : ongoingPlan ? '<i class="fa-solid fa-clock"></i> Manage Ongoing Spell' : effectPlan
            ? plan.resolution?.kind === "healing" ? '<i class="fa-solid fa-heart"></i> Resolve Healing' : plan.resolution?.kind === "direct-damage" ? '<i class="fa-solid fa-burst"></i> Deal Damage' : plan.resolution?.kind === "spell-note" ? '<i class="fa-solid fa-book"></i> Apply Spell Note' : plan.resolution?.kind === "effect-note" ? '<i class="fa-solid fa-book-medical"></i> Apply Effect + Note' : plan.resolution?.kind === "condition-note" ? '<i class="fa-solid fa-wand-magic-sparkles"></i> Apply Condition' : plan.resolution?.kind === "stabilize" ? '<i class="fa-solid fa-heart-pulse"></i> Stabilize' : plan.resolution?.kind === "retaliation" ? '<i class="fa-solid fa-shield-virus"></i> Set (retaliates)' : plan.resolution?.kind === "damage-share" ? '<i class="fa-solid fa-link"></i> Link (heal, then share damage)' : plan.resolution?.kind === "hp-transfer" ? '<i class="fa-solid fa-link"></i> Link (transfer Hit Points)' : plan.resolution?.kind === "turn-healing" ? '<i class="fa-solid fa-heart"></i> Start Healing' : plan.resolution?.kind === "healing-pulse" ? '<i class="fa-solid fa-heart"></i> Start (heals creatures in the emanation)' : plan.resolution?.kind === "offer-effect" ? '<i class="fa-solid fa-handshake"></i> Accept the offer (choose a skill, roll the price)' : plan.resolution?.kind === "size-bond" ? '<i class="fa-solid fa-link"></i> Stick (target the creature)' : plan.resolution?.kind === "weapon-throw" ? '<i class="fa-solid fa-hand-fist"></i> Hurl the weapon (target the creature)' : plan.resolution?.kind === "spell-mark" ? '<i class="fa-solid fa-eye"></i> Invoke (target the creature)' : plan.resolution?.kind === "temporary-shield" ? '<i class="fa-solid fa-shield"></i> Shield the arm (target the creature)' : plan.resolution?.kind === "aid-prepare" ? '<i class="fa-solid fa-hands-helping"></i> Aid (target the ally)' : plan.resolution?.kind === "thrall-strike" ? '<i class="fa-solid fa-person-running"></i> Command the thrall (target it)' : plan.resolution?.kind === "temp-hp" ? '<i class="fa-solid fa-heart-circle-plus"></i> Gain Temporary HP (target the triggering creature)' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Resolve Native Effect'
            : attackPlan ? ownLabel[1]
            : `<i class="fa-solid fa-shield-halved"></i> Prepare Saves — ${nativeSaveLabel}`;
    button.title = effectPlan && plan.automation.level === "guided"
        ? `Guided plan: ${plan.automation.pendingCapabilities.join(", ")}`
        : ongoingPlan ? 'Prepare saves and manage this spell in Ongoing spells.' : effectPlan
            ? "Choose and confirm the official PF2e Effect application."
            : canPrepare
                ? "Snapshot current targets for interactive native saves and confirmed damage."
                : "The caster's owner or a GM must prepare this basic-save resolution.";
    if (effectPlan || ongoingPlan || attackPlan) (root.querySelector(".card-buttons") ?? root).appendChild(button);
    // The gate's counteract (Swallow Light): the GM gives the counteracted thing's DC and rank; a success opens the repeat window.
    if (gate && !gateState() && !root.querySelector(".pf2e-auto-repeat-gate")) {
        const gateButton = document.createElement("button");
        gateButton.type = "button"; gateButton.className = "pf2e-auto-repeat-gate";
        gateButton.innerHTML = `<i class="fa-solid fa-ban"></i> Counteract the ${foundry.utils.escapeHTML(gate.target)}`;
        gateButton.disabled = !game.user.isGM;
        button.parentElement?.insertBefore(gateButton, button);
        gateButton.addEventListener("click", async event => {
            event.preventDefault(); event.stopPropagation();
            gateButton.disabled = true;
            try {
                await message.setFlag(MODULE_ID, "noteCounteract", { target: `the ${gate.target}`, text: gate.text, result: "is swallowed: the breath weapon is gained", castRank: context.castRank,
                    sourceItemUuid: context.item?.uuid ?? null, spellName: plan.source.name });
                const result = await runtime.noteCounteract(message);
                if (!result) { gateButton.disabled = false; return; }
                await message.setFlag(MODULE_ID, "repeatGate", { countered: result.countered === true, degree: result.degree });
                gateButton.remove();
            } catch (error) { gateButton.disabled = false; notifyError("Counteract", error); }
        });
    }

    button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        button.disabled = true;
        const prior = button.innerHTML;
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Resolving';
        try {
            const result = ongoingPlan ? await ongoingFamilies.start(context.item, {
                sourceMessageId: message.id, castRank: context.castRank, targets: game.user.targets
            }) : effectPlan
                ? await runtime.execute(context.item, {
                    plan,
                    baseSource: context.baseSource,
                    sourceActor: context.actor,
                    sourceMessageId: message.id,
                    castRank: context.castRank
                })
                : repeatable && !windowOpen() ? (() => { throw new Error(gate && !gateState() ? `${plan.source.name}: counteract the ${gate.target} first (the card's Counteract button).`
                    : gate && gateState()?.countered !== true ? `${plan.source.name}: the counteract failed, so there's no breath weapon.`
                    : anyTime && attacksLeft() && recharging() != null ? `${plan.source.name}: it recharges in ${Math.ceil((recharging() - game.time.worldTime) / 6)} round(s).`
                    : laterTurns
                    ? attacksLeft() ? `${plan.source.name}: attack again on a later turn of ${context.actor?.name ?? "the caster"}'s (once per turn).` : `${plan.source.name}: the spell has ended.`
                    : `${plan.source.name}: the blasts ended with your turn.`); })()
                : await basicSaves.start(context.item, {
                    // (Curse of Lost Time: the target's kind, asked here, picks its own save plan.)
                    plan: await chooseSaveMode(plan),
                    sourceActor: context.actor,
                    sourceMessageId: message.id,
                    castRank: context.castRank,
                    targets: game.user.targets,
                    skipConfirmation: true
                });
            if (laterTurns && (result.status === "applied" || result.status === "prepared" || result.card)) {
                // Each attack is recorded with its turn; the first sets when the spell's duration runs out.
                const opened = message.getFlag(MODULE_ID, "repeatWindow");
                const spec = plan.lifecycle?.durationSpec;
                const span = spec?.mode === "fixed" ? spec : spec?.mode === "sustained" && spec.maximum?.mode === "fixed" ? spec.maximum : null;
                const seconds = span ? Number(span.value) * ({ rounds: 6, minutes: 60, hours: 3600 }[span.unit] ?? 0) : null;
                // ("Once activated, you can't use the breath weapon again for 1d4 rounds.": rolled now.)
                let rechargeUntil = null;
                if (repeatable.recharge) {
                    const roll = await new Roll(repeatable.recharge.formula).evaluate();
                    rechargeUntil = game.time.worldTime + roll.total * 6;
                    try { await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: context.actor }), flavor: `<strong>${foundry.utils.escapeHTML(plan.source.name)}</strong>: can't be used again for ${roll.total} round${roll.total === 1 ? "" : "s"}` }); } catch (_) {}
                }
                await message.setFlag(MODULE_ID, "repeatWindow", { combatId: game.combat?.started ? game.combat.id : null,
                    endsAt: opened?.endsAt ?? (seconds ? game.time.worldTime + seconds : null), ...(rechargeUntil != null ? { rechargeUntil } : {}),
                    attacks: [...(opened?.attacks ?? []), { round: game.combat?.started ? game.combat.round : null, turn: game.combat?.started ? game.combat.turn : null }] });
                button.disabled = !attacksLeft();
                button.innerHTML = attacksLeft() ? againLabel() : '<i class="fa-solid fa-check"></i> Attacks Used';
            } else if (repeatable && (result.status === "applied" || result.status === "prepared" || result.card)) {
                // The first blast opens the window: the current combat turn (none outside combat).
                if (!message.getFlag(MODULE_ID, "repeatWindow")) await message.setFlag(MODULE_ID, "repeatWindow", game.combat?.started
                    ? { combatId: game.combat.id, round: game.combat.round, turn: game.combat.turn } : { combatId: null });
                button.disabled = false;
                button.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Blast Again';
            } else if (result.status === "applied" || result.status === "prepared") {
                button.innerHTML = `<i class="fa-solid fa-check"></i> ${effectPlan ? "Native Effect Resolved" : attackPlan ? ownLabel[0] : "Saves Prepared"}`;
            } else {
                button.disabled = false;
                button.innerHTML = prior;
            }
        } catch (error) {
            button.disabled = false;
            button.innerHTML = prior;
            notifyError(`${plan.source.name} resolution failed`, error);
        }
    });
}

registerPersistentLinks();
registerTemporaryShields();
registerSetAside();
// Wards lasting "until the next time you make your daily preparations" end when the caster rests for the night.
Hooks.on("pf2e.restForTheNight", actor => { ongoing.dailyPreparations(actor).catch(error => console.error(`${MODULE_ID} | A ward could not be ended at daily preparations.`, error)); });
// Conditions that last until the creature rests, or drop by 1 with each rest (the lead GM applies it).
Hooks.on("pf2e.restForTheNight", actor => { if (game.user.isGM && ongoing.isCoordinator()) restLifetimes(actor).catch(error => console.error(`${MODULE_ID} | Rest-bound conditions could not be updated.`, error)); });
registerStrikeRiders();
registerStrikeEffects();

Hooks.once("init", () => {
    registerDebugSetting();
    // Ended Ongoing-spell records (their journal entries) are deleted once nothing still needs them, unless the GM keeps them.
    game.settings.register(MODULE_ID, "keepEndedOngoing", {
        name: "Keep ended Ongoing-spell journals",
        hint: "Ongoing spells are tracked in journal entries. By default an entry is deleted once its spell has ended and nothing it created (Effects, conditions, areas, save cards) still needs it. Turn this on to keep them as a history.",
        scope: "world", config: true, type: Boolean, default: false
    });
    const module = game.modules.get(MODULE_ID);
    if (module) {
        const saveApi = {
            start: (spell, options) => basicSaves.start(spell, options),
            waveRepeat: (message, options) => basicSaves.waveRepeat(message, options),
            areaFollowUp: message => basicSaves.areaFollowUp(message),
            chainSave: (message, targets) => basicSaves.chainSave(message, targets),
            popSave: (message, targets) => basicSaves.popSave(message, targets),
            rollDamage: card => basicSaves.rollDamage(card),
            rollAll: (card, options) => basicSaves.rollAll(card, options),
            rollSave: (card, targetId, options) => basicSaves.rollSave(card, targetId, options),
            counteractReminder: (card, index, options) => basicSaves.counteractReminder(card, index, options),
            addTargets: (card, targets) => basicSaves.addTargets(card, targets),
            chooseCastOption: (card, name) => basicSaves.chooseCastOption(card, name),
            answerDiceUpgrade: (card, answer) => basicSaves.answerDiceUpgrade(card, answer),
            answerPersistentRider: (card, answer) => basicSaves.answerPersistentRider(card, answer),
            answerDamageBonus: (card, answer) => basicSaves.answerDamageBonus(card, answer),
            // The caster's split of the heightened dice between two types (a number of dice), and the terrain the card places on a region.
            answerDiceSplit: (card, answer) => basicSaves.answerDiceSplit(card, answer),
            placeAreaTerrain: (card, region) => basicSaves.placeAreaTerrain(card, region),
            drawBlood: (card, choice) => basicSaves.drawBlood(card, choice),
            spreadHealing: (card, targets) => basicSaves.spreadHealing(card, targets),
            answerCastGate: (card, answer) => basicSaves.answerCastGate(card, answer),
            // Final Sacrifice's minion (a token UUID) and Bony Barrage's bone armor ("yes"/"no").
            answerSacrifice: (card, tokenUuid) => basicSaves.answerSacrifice(card, tokenUuid),
            answerBoneArmor: (card, answer) => basicSaves.answerBoneArmor(card, answer),
            grantBeneficiaryEffect: (card, targets) => basicSaves.grantBeneficiaryEffect(card, targets),
            healBack: (card, targets) => basicSaves.healBack(card, targets),
            // The other target's condition by the foe's result (Tortoise and the Hare): the one creature targeted.
            grantPartner: (card, targets) => basicSaves.grantPartner(card, targets),
            chooseRolledCondition: (card, slug) => basicSaves.chooseRolledCondition(card, slug),
            chooseCasterOption: (card, value) => basicSaves.chooseCasterOption(card, value),
            correctTarget: (card, targetId, correction) => basicSaves.correctTarget(card, targetId, correction),
            finalize: card => basicSaves.finalize(card),
            apply: (card, options) => basicSaves.apply(card, options),
            supports: plan => basicSaves.supports(plan)
        };
        module.api = {
            compile: (item, options) => runtime.compile(item, options),
            gmOption: (message, key, options) => runGmOption(message, key, options),
            sourceCreatureDamage: (plan, item, targets) => sourceCreatureDamage(plan, item, targets),
            // (Rude Awakening's card button: the ally's save to suppress — {choice, dc} given, or asked.)
            suppressionSave: (effect, options) => suppressionSave(effect, options),
            castingRules: { onCast: message => castingRulesOnCast(message), run: (message, button) => runCastingRule(message, button),
                // (A card that counts as a spell — a kineticist's 2-action impulse —: Counterspell, the spellshapes and, if asked, the casting conditions.)
                onSpellLike: (message, like) => spellLikeCast(message, like) },
            // (A cast's spellshape riders for a module resolving its own card — a spell-like card's, or a spell's: the riders, the damage type swap, the area.)
            spellshapes: { riders: messageId => shapeRidersFor(messageId), typeSwap: messageId => shapeTypeSwapFor(messageId),
                area: messageId => game.messages.get(messageId)?.getFlag(MODULE_ID, "shaping")?.area ?? null },
            triggerItems: { onCast: message => spellTriggerItemsOnCast(message), run: (message, button) => runTriggerItem(message, button) },
            castActions: { onCast: message => spellActionsOnCast(message), run: (message, button) => runSpellAction(message, button) },
            creatureAbilities: { read: source => readCreatureSpellAbility(source), onCast: message => creatureAbilitiesOnCast(message), run: message => runCreatureAbility(message) },
            // (Another module's item casting a spell — the item module's consumables: cast through PF2e from a temporary entry with the item's numbers.)
            castFromItem: options => castSpellForItem(options),
            // (The options castFromItem takes beyond the basics, for other modules to check before passing them: an older module ignores unknown keys.)
            castFromItemOptions: Object.freeze(["attackDegree", "saveFirst", "withoutTraits", "addTraits", "area", "damageType", "actions", "growth"]),
            // (A cast another module's item acts on, by its message — Starless Scope's reaction, 2026-10-29: its spell lost (disrupted), or its slot
            // given back.)
            casting: {
                lose: (messageId, reason) => { const message = game.messages.get(messageId); if (!message) throw new Error("casting.lose: no such cast message."); return loseSpell(message, reason); },
                refundSlot: (messageId, label) => { const message = game.messages.get(messageId); const spell = message?.item; if (!spell?.actor) throw new Error("casting.refundSlot: no such cast."); return refundSlot(spell.actor, spell, castRankOf(message) ?? spell.rank, label ?? spell.name); }
            },
            // (The items this module acts on — scrolls, wands, staves, spellhearts, catalysts, and what its item readers read — for other modules to leave alone.)
            claims: source => itemClaimed(source?.toObject?.() ?? source), claimsWhy: source => itemClaims(source?.toObject?.() ?? source),
            itemCasts: { read: source => readItemCasts(source), offer: item => offerItemCasts(item), cast: (item, index, options) => castFromItem(item, index, options), reservoir: (message, action) => runReservoirButton(message, action), reservoirExpend: options => reservoirExpend(options), reservoirCast: options => reservoirCast(options), reservoirHeld: options => reservoirHeld(options) },
            itemShapes: { read: source => readItemSpellshape(source), arm: (message, item) => armItemSpellshape(message, item), run: (message, button) => runItemShapeCard(message, button), turnStart: combat => itemShapeTurnStart(combat), watch: message => itemShapeWatchMessage(message) },
            bloodMagic: { onCast: message => bloodMagicOnCast(message), run: (message, choice, options) => runBloodMagic(message, choice, options), spite: (uuid, token) => spiteStrikes(uuid, token) },
            // Authoring aid: which route a spell takes and what blocks it.
            // (The spell a cast's card resolves: a wand or scroll's stored copy, or its current printing — for scripted runs.)
            cardSpell: async message => { const context = spellCardContext(message); return context ? currentPrinting(context, message) : null; },
            // (A spellshape's terrain, for scripted runs: a creature moved through it; Garland Spell's burst grown at a token.)
            spellshapeTerrainMove: (regionUuid, tokenUuid, squares) => shapeTerrainMove(regionUuid, tokenUuid, squares),
            spellshapeGrowGarland: (message, options) => growGarland(message, options),
            spellshapeCard: (message, options) => runShapeCard(message, options),
            spellshapeDetonate: region => detonateShapeCircle(region),
            diagnose: async item => {
                const plan = await runtime.compile(item);
                const save = inspectSavePlan(plan);
                const route = forms.supports(item) ? "form" : immediate.supports(item) ? "immediate" : care.supports(plan) ? "affliction-care"
                    : messages.supports(plan) ? "message" : storedTriggers.supports(plan) ? "stored-trigger" : ongoingFamilies.supports(item) ? "ongoing" : runtime.supportedResolutionKinds.includes(plan.resolution?.kind) ? "effect"
                    : save.supported ? "save" : "none";
                const unclaimed = Object.entries(plan.resolution?.outcomes ?? {}).flatMap(([degree, outcome]) => (outcome.semanticCoverage?.clauses ?? [])
                    .filter(clause => clause.status !== "compiled").map(clause => ({ degree, text: clause.text, signals: clause.unexplainedSignals, guided: clause.guidedClaims })));
                return { route, level: plan.automation?.level, pending: plan.automation?.pendingCapabilities ?? [],
                    blockers: route === "none" ? save.blockers.map(blocker => `${blocker.code}: ${blocker.message}`) : [], unclaimed, plan };
            },
            execute: (item, options) => runtime.execute(item, options),
            // (A spell's Strike button, for scripted runs: Tracking Mayflies' Off-Guard answer and its hit condition.)
            spellStrikeRoll: (actor, itemId, variant, options) => runtime.spellStrikeRoll(actor, itemId, variant, options),
            strikeWardRoll: (actor, itemId, castId, options) => runtime.strikeWardRoll(actor, itemId, castId, options),
            intervalHealTick: effect => runtime.intervalHealTick(effect ?? null),
            intervalHealBonus: effect => runtime.intervalHealBonus(effect),
            ruleSetSnag: (effect, options) => runtime.ruleSetSnag(effect, options),
            ruleSetSwitch: (effect, options) => runtime.ruleSetSwitch(effect, options),
            minionHordeAct: (effect, options) => runtime.minionHordeAct(effect, options),
            mischiefAct: (effect, options) => runtime.mischiefAct(effect, options),
            checkMarkAgain: (effect, options) => runtime.checkMarkAgain(effect, options),
            storedBurstExplode: (effect, options) => runtime.storedBurstExplode(effect, options),
            familiarSwarmBites: (effect, options) => runtime.familiarSwarmBites(effect, options),
            seedErupt: effect => runtime.seedErupt(effect),
            sceneEnd: (effect, options) => runtime.sceneEnd(effect, options),
            sustainOption: (effect, key, options) => runtime.sustainOption(effect, key, options),
            storedChargeRelease: (effect, options) => runtime.storedChargeRelease(effect, options),
            colorArmorAttacker: (effect, options) => runtime.colorArmorAttacker(effect, options),
            protagonistAct: (effect, options) => runtime.protagonistAct(effect, options),
            challengeExempt: (effect, options) => runtime.challengeExempt(effect, options),
            // (Gruesome Marionettist's card controls, for scripted runs: "prohibited" or "directed".)
            marionetteAct: (effect, option) => runtime.marionetteAct(effect, option),
            // (Lucky Decision's reactions, for scripted runs: "good" or "bad" — the enemy targeted, `degree` to set its save's result.)
            fateAct: (effect, which, options) => runtime.fateAct(effect, which, options),
            // (Wooden Engulfment's grab, for scripted runs.)
            treeGrab: (effect, options) => runtime.treeGrab(effect, options),
            // (Coiling Grasp's Grapple again on a Sustain, for scripted runs.)
            weaponGrapple: (effect, options) => runtime.weaponGrapple(effect, options),
            // (Honorable Death's end-of-turn control, for scripted runs: "peace" (no hostile action) or "hostile".)
            honorAct: (effect, which, options) => runtime.honorAct(effect, which, options),
            // (Shine Spotlight's Perform control, for scripted runs.)
            spotlightPerform: (effect, options) => runtime.spotlightPerform(effect, options),
            // (Coiling Creepers' controls, for scripted runs: "maneuver" or "clear".)
            creepersAct: (effect, which, options) => runtime.creepersAct(effect, which, options),
            // (Long Live the Revolution, for scripted runs: the saves (the Sustain's newcomers) and a rebel's controls.)
            rallySaves: (effect, options) => runtime.rallySaves(effect, options),
            rallyAct: (effect, which, options) => runtime.rallyAct(effect, which, options),
            // (Unleash True Power's spell cast through the patron, for scripted runs.)
            truePowerCast: (effect, options) => runtime.truePowerCast(effect, options),
            // (Mystic Bomb's controls, for scripted runs: "explode", "grow" or "aid".)
            bombAct: (effect, which, options) => runtime.bombAct(effect, which, options),
            // (Seeds of Divinity's controls, for scripted runs: "sprout", "grow" or "eat".)
            seedsAct: (effect, which, options) => runtime.seedsAct(effect, which, options),
            // (Prism of Power's controls, for scripted runs: "scatter" or "diffract".)
            prismAct: (effect, which, options) => runtime.prismAct(effect, which, options),
            // (Animated Spark's disperse, for scripted runs.)
            sparkDisperse: (effect, options) => runtime.sparkDisperse(effect, options),
            // (Patron's Apocalypse's Sustain move, for scripted runs.)
            apocalypseMove: (effect, options) => runtime.apocalypseMove(effect, options),
            spellStealAttempt: (effect, options) => runtime.spellStealAttempt(effect, options),
            spellStealTransfer: (effect, options) => runtime.spellStealTransfer(effect, options),
            flashCloakAttacker: (effect, options) => runtime.flashCloakAttacker(effect, options),
            wardStrike: (message, options) => runtime.wardStrike(message, options),
            skillDemoralize: (effect, options) => runtime.skillDemoralize(effect, options),
            fumeDetonate: (message, options) => runtime.fumeDetonate(message, options),
            frenzyEnd: (effect, options) => runtime.frenzyEnd(effect, options),
            mantleSwap: (effect, options) => runtime.mantleSwap(effect, options),
            mantleRetaliate: (effect, options) => runtime.mantleRetaliate(effect, options),
            forceHandAct: (effect, option, options) => runtime.forceHandAct(effect, option, options),
            rewriteReroll: (effect, options) => runtime.rewriteReroll(effect, options),
            guardianAct: (effect, option, options) => runtime.guardianAct(effect, option, options),
            soulTransfer: (effect, options) => runtime.soulTransfer(effect, options),
            discThrow: (effect, options) => runtime.discThrow(effect, options),
            mireRetaliate: (effect, options) => runtime.mireRetaliate(effect, options),
            emberBlast: (effect, options) => runtime.emberBlast(effect, options),
            strikeHeal: (effect, options) => runtime.strikeHeal(effect, options),
            ritualStrain: (effect, options) => runtime.ritualStrain(effect, options),
            ritualCast: (effect, index, options) => runtime.ritualCast(effect, index, options),
            ritualCarry: (effect, options) => runtime.ritualCarry(effect, options),
            ritualSiege: (effect, options) => runtime.ritualSiege(effect, options),
            ritualCompanions: (effect, options) => runtime.ritualCompanions(effect, options),
            ritualWard: (effect, options) => runtime.ritualWard(effect, options),
            ritualArea: (effect, key, options) => runtime.ritualArea(effect, key, options),
            cannibalHunger: (effect, options) => runtime.cannibalHunger(effect, options),
            spellStorm: (effect, options) => runtime.spellStorm(effect, options),
            giantThrallStrikes: (effect, options) => runtime.giantThrallStrikes(effect, options),
            thrallControl: (effect, index, options) => runtime.thrallControl(effect, index, options),
            thrallOnCrit: (effect, options) => runtime.thrallOnCrit(effect, options),
            ritualFall: (effect, options) => runtime.ritualFall(effect, options),
            ritualHiveGone: effect => runtime.ritualHiveGone(effect),
            portalCross: (effect, options) => runtime.portalCross(effect, options),
            imbuedHazardHolder: (message, options) => runtime.imbuedHazardHolder(message, options),
            cardRoll: (message, key) => runtime.cardRoll(message, key),
            cardAction: (message, action, options) => runtime.cardAction(message, action, options),
            // A note card's heightened counteract (Putrefy Food and Drink): {choice: {name, dc, rank}} skips the GM's prompt.
            noteCounteract: (message, options) => runtime.noteCounteract(message, options),
            noteShieldBlock: (message, options) => runtime.noteShieldBlock(message, options),
            incarnatePhase: (message, key, options) => runtime.incarnatePhase(message, key, options),
            grantedAction: (message, index, options) => runtime.grantedAction(message, index, options),
            bloodMarkSave: message => runtime.bloodMarkSave(message),
            conjuredTouch: (message, options) => runtime.conjuredTouch(message, options),
            burrowUnder: (message, options) => runtime.burrowUnder(message, options),
            plantExpel: (message, options) => runtime.plantExpel(message, options),
            illusoryAct: (message, options) => runtime.illusoryAct(message, options),
            ritualEndSave: (message, options) => runtime.ritualEndSave(message, options),
            ritualSlip: (message, options) => runtime.ritualSlip(message, options),
            bloodMarkSeek: message => runtime.bloodMarkSeek(message),
            noteCheck: (message, options) => runtime.noteCheck(message, options),
            // A spell maneuver card: {action: "trip"|…, map: 0|1|2, skipDialog} rolls it and applies its result.
            spellManeuver: (message, options) => runtime.spellManeuver(message, options),
            // The Steal card: {target (a token), amount (the proficiency or spell rank), skipDialog}.
            stealDamage: (message, options) => runtime.stealDamage(message, options),
            // A deferred trail's card: {region} places it for the rest of the duration.
            placeDeferredWall: (message, options) => runtime.placeDeferredWall(message, options),
            // Extract Poison's counteract: {choice: {name, level, dc}, weaponId}.
            counteractTransfer: (message, options) => runtime.counteractTransfer(message, options),
            dismiss: (effect, options) => runtime.dismiss(effect, options),
            // Conjured food: a creature eats pieces from the food card ({messageId, eaterUuid, count}).
            eatFood: data => runtime.consumeFood(data),
            triggerActionUsed: (actor, actionUuid) => runtime.triggerActionUsed(actor, actionUuid),
            ongoing: {
                startLingering: (item, plan, options) => ongoingFamilies.startLingering(item, plan, options),
                open: () => ongoing.open(),
                start: (item, options) => ongoingFamilies.start(item, options),
                startAura: (item, declaration) => ongoingFamilies.startAura(item, declaration),
                reconcile: options => ongoing.reconcile(options),
                request: (action, data) => ongoing.request(action, data),
                // (A cast's journal and its record saved in the queue; a cloud over a Region — the catalysts' riders on what a spell made: catalyst-runtime.js.)
                journalFor: castId => ongoing.find(castId) ?? null,
                saveRecord: (journal, record) => ongoing.enqueue(() => ongoing.save(journal, record)),
                startCloud: args => ongoing.startCloud(args),
                records: () => ongoing.records().filter(journal => game.user.isGM || journal.testUserPermission(game.user, "OBSERVER")).map(journal => ({ journalId: journal.id, ...journal.getFlag(MODULE_ID, "ongoingCast") }))
            },
            forms: { start: (item, options) => forms.start(item, options), request: (action, data) => ongoing.request(action, data) },
            spellActions: { cloudAction: (effect, options) => runtime.cloudAction(effect, options), strideHide: (effect, options) => runtime.strideHide(effect, options), grantedBlock: (effect, options) => runtime.grantedBlock(effect, options) },
            strikeEffects: {
                supports: plan => strikeEffects.supports(plan),
                start: (item, plan, options) => strikeEffects.start(item, plan, options)
            },
            storedTriggers: {
                supports: plan => storedTriggers.supports(plan),
                start: (item, plan, options) => storedTriggers.start(item, plan, options),
                trigger: data => storedTriggers.trigger(data),
                poolCheck: data => storedTriggers.poolCheck(data),
                poolAbsorb: data => storedTriggers.poolAbsorb(data),
                images: data => storedTriggers.images(data)
            },
            messages: {
                supports: plan => messages.supports(plan),
                start: (item, plan, options) => messages.start(item, plan, options),
                reply: data => messages.reply(data),
                deliver: data => messages.deliver(data)
            },
            care: {
                supports: plan => care.supports(plan),
                start: (item, plan, options) => care.start(item, plan, options)
            },
            immediate: {
                start: (item, options) => immediate.start(item, options),
                roll: (card, targetId, stage, options) => immediate.roll(card, targetId, stage, options),
                request: (action, data) => immediate.request(action, data),
                recover: () => immediate.recover()
            },
            escape: { handleMessage: message => escapes.handleMessage(message), end: (message, entryId) => escapes.end(message, entryId) },
            saves: saveApi,
            basicSaves: saveApi,
            debug: {
                enabled: () => debugEnabled(),
                cast: cardOrId => debugCast(cardOrId),
                latest: () => debugLatestCast()
            },
            debugCast: cardOrId => debugCast(cardOrId),
            refreshCatalog: () => runtime.refreshCatalog(),
            supportedResolutionKinds: runtime.supportedResolutionKinds
        };
    }
});

Hooks.once("ready", async () => {
    installFormGuards();
    game.socket.on(`module.${MODULE_ID}`, payload => {
        void immediate.socket(payload).catch(error => notifyError("Immediate synchronization failed", error));
        void ongoing.socket(payload).catch(error => notifyError("Ongoing synchronization failed", error));
        basicSaves.handleSocket(payload).catch(error => notifyError("Save-result synchronization failed", error));
    });
    try {
        await runtime.refreshCatalog();
        await immediate.recover();
        await ongoing.reconcile({ recover: true });
        console.log("PF2e Automatic Ability Resolution | Runtime ready");
    } catch (error) {
        notifyError("Native Effect catalog initialization failed", error);
    }
});

Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    immediate.bind(root);
    forms.bind(message, root);
    bindReceiptButtons(root);
    bindSaveButtons(root);
    escapes.bind(message, root);
    bindFoodButtons(message, root);
    bindNoteCounteractButtons(message, root);
    bindGmOptionButtons(message, root);
    bindEscapePromptButtons(message, root);
    bindNoteShieldBlockButtons(message, root);
    bindIncarnateButtons(message, root);
    bindImbuedHazardButtons(message, root);
    bindCardRollButtons(message, root);
    bindCardActionButtons(message, root);
    bindGrantedActionButtons(message, root);
    bindBloodMarkButtons(message, root);
    bindConjuredTouchButtons(message, root);
    bindWaveRepeatButtons(message, root);
    bindAreaFollowUpButtons(message, root);
    bindChainSaveButtons(message, root);
    bindPopSaveButtons(message, root);
    bindBurrowUnderButtons(message, root);
    bindWebCheckButtons(message, root);
    bindSpiritAidButtons(message, root);
    bindPlantExpelButtons(message, root);
    bindIllusoryButtons(message, root);
    bindRitualEndButtons(message, root);
    bindRitualSlipButtons(message, root);
    bindLanternSaveButtons(message, root);
    bindRadiantSaveButtons(message, root);
    bindSunSunlightButtons(message, root);
    bindNoteCheckButtons(message, root);
    bindSpellManeuverButtons(message, root);
    bindStealButtons(message, root);
    bindPlaceWallButtons(message, root);
    bindCounteractTransferButtons(message, root);
    messages.bind(message, root);
    void addResolutionButton(message, root);
});

Hooks.on("createChatMessage", message => {
    void runtime.handleActionMessage(message)
        .catch(error => notifyError("Action-triggered Effect sequence failed", error));
    void basicSaves.handleSaveMessage(message)
        .catch(error => notifyError("Save result recording failed", error));
    void escapes.handleMessage(message)
        .catch(error => notifyError("Escape review failed", error));
    void removeSpellMarkWeakness(message)
        .catch(error => notifyError("Spell-mark weakness removal failed", error));
    void lethologicOnDamage(message)
        .catch(error => notifyError("Lethologic mark failed", error));
    void climbAidOnCheck(message)
        .catch(error => notifyError("Climb fall check failed", error));
    void consumeUsedEffects(message)
        .catch(error => notifyError("Used Effect removal failed", error));
    void autoToggleOnDamage(message)
        .catch(error => notifyError("First-Strike toggle failed", error));
    void lockToFirstItem(message).catch(error => notifyError("Penalty lock failed", error));
    void retroBonusOnRoll(message).catch(error => notifyError("Retroactive bonus failed", error));
    void consumeOnDamageTaken(message).catch(error => notifyError("Damage reduction ending failed", error));
    void runeWardOnDamage(message).catch(error => notifyError("Spell damage runes failed", error));
    // (Warding Aggression: a melee Strike that hits the warded foe keeps the ward this turn.)
    const strikeContext = message?.flags?.pf2e?.context;
    if (game.user.isGM && strikeContext?.type === "attack-roll" && ["success", "criticalSuccess"].includes(strikeContext.outcome) && (strikeContext.options ?? []).includes("item:melee")
        && strikeContext.target?.token) {
        const striker = game.actors.get(String(strikeContext.actor ?? message.speaker?.actor ?? "").split(".").pop());
        const tokenUuid = String(strikeContext.target.token).includes(".") ? String(strikeContext.target.token) : canvas.scene?.tokens.get(strikeContext.target.token)?.uuid;
        if (striker && tokenUuid) void ongoing.wardHit(striker.uuid, tokenUuid).catch(error => notifyError("Ward hit failed", error));
    }
    void attackWardOnAttack(message).catch(error => notifyError("Attack ward failed", error));
    void markWardOnAttack(message, (spell, options) => basicSaves.start(spell, options)).catch(error => notifyError("Mark ward failed", error));
    void triggerAuraOnSave(message).catch(error => notifyError("Aura damage failed", error));
    if (message?.flags?.pf2e?.appliedDamage && game.user?.isGM && game.users.activeGM?.id === game.user.id)
        void ongoing.absorberOnDamage(message, { isStrike: isStrikeDamage, lastDamage: lastDamageOf }).catch(error => notifyError("Absorber failed", error));
    // (Spirit Boundary: damage whose origin is across the shield's edge, reduced.)
    if (message?.flags?.pf2e?.appliedDamage && game.user?.isGM && game.users.activeGM?.id === game.user.id)
        void runtime.boundaryOnDamage(message, { lastDamage: lastDamageOf }).catch(error => notifyError("Spirit shield failed", error));
    void oncePerSourceOnHealing(message).catch(error => notifyError("Once-per-spell bonus failed", error));
    void oncePerSourceOnCast(message).catch(error => notifyError("Once-per-spell bonus failed", error));
    void ongoing.memberCriticalSave(message)
        ?.catch(error => notifyError("Critical-save rider failed", error));
});

// Turn-bound Effects end when PF2e's duration expires them (a turn or round change, or world time passing).
Hooks.on("updateCombat", (_combat, changes) => {
    if ("turn" in changes || "round" in changes) void expireTurnBound().catch(error => notifyError("Turn-bound Effect expiry failed", error));
    // (A note's damage as its creature's turn starts: Garden of the Green Man's squeezing vines.)
    if ("turn" in changes || "round" in changes) void turnStartNoteDamage(_combat).catch(error => notifyError("Turn-start damage failed", error));
    // (A copy's Hit Points lost after its turn: Duplicate Foe, Reanimate Foe.)
    if ("turn" in changes || "round" in changes) void turnEndHpLoss(_combat).catch(error => notifyError("Turn-end Hit Point loss failed", error));
    // (A form's recovery as its creature's turn ends: Monstrosity Form's Inexorable.)
    if ("turn" in changes || "round" in changes) void turnEndRecovery(_combat).catch(error => notifyError("Turn-end recovery failed", error));
    // (A glyph's smaller meteor as its creature's turn ends: Metallic Meteorite Glyph.)
    if ("turn" in changes || "round" in changes) void turnEndSaves(_combat).catch(error => notifyError("Turn-end save failed", error));
    if ("round" in changes) void autoToggleNewRound().catch(error => notifyError("First-Strike toggle failed", error));
});
// (A curse's situational condition — Mariner's Curse's Slowed at sea —: kept in step with its toggle, its floor condition and the curse itself.)
Hooks.on("updateItem", item => { if (item?.type === "effect" && item.flags?.[MODULE_ID]?.situationalToggle) void situationalCurseSync(item.actor).catch(error => notifyError("The curse's situational condition failed", error)); });
Hooks.on("deleteItem", item => { if (item?.actor && (item.flags?.[MODULE_ID]?.situationalToggle || (item.type === "condition" && item.actor.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.situationalOf))))
    void situationalCurseSync(item.actor).catch(error => notifyError("The curse's situational condition failed", error)); });
// (The casts made for other modules: their temporary entries and spells go once their time has passed, or with the encounter they were cast in.)
Hooks.on("updateWorldTime", () => { void sweepItemCastTemps().catch(error => notifyError("Removing an item's temporary spells failed", error)); });
Hooks.on("deleteCombat", combat => { void sweepItemCastTemps({ combatId: combat?.id ?? null }).catch(error => notifyError("Removing an item's temporary spells failed", error)); });
Hooks.once("ready", () => { void sweepItemCastTemps().catch(error => notifyError("Removing an item's temporary spells failed", error)); });
Hooks.on("deleteCombat", () => { void expireTurnBound().catch(error => notifyError("Turn-bound Effect expiry failed", error)); });
Hooks.on("updateWorldTime", () => {
    void expireTurnBound().catch(error => notifyError("Turn-bound Effect expiry failed", error));
    if (!game.combat?.started) void autoToggleNewRound().catch(error => notifyError("First-Strike toggle failed", error));
});

// A token moved: Effects bound to a nearby token re-check their distance; an Effect lasting to the end of a movement ends.
Hooks.on("updateToken", (tokenDocument, changes) => {
    if (!("x" in changes || "y" in changes)) return;
    void endAfterMovement(tokenDocument, changes).catch(error => notifyError("Movement-bound Effect failed", error));
    setTimeout(() => void syncNearTokens().catch(error => notifyError("Distance-bound Effect failed", error)), 400);
    void coverSquareSync(tokenDocument, changes).catch(error => notifyError("Cover square failed", error));
});
Hooks.on("createToken", tokenDocument => { void coverSquareSync(tokenDocument, {}, { push: false }).catch(error => notifyError("Cover square failed", error)); });
Hooks.on("deleteToken", () => { void syncNearTokens().catch(error => notifyError("Distance-bound Effect failed", error)); });

/**
 * "… resistance 5 to all damage against the triggering effect" (Warping Pull): the Effect is removed once the creature has taken that damage —
 * PF2e's applied-damage message (even when resisted to 0), or a damage update (the active GM).
 */
async function endAfterDamage(actor) {
    if (!actor || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    const ids = actor.items.filter(item => item.type === "effect" && item.flags?.[MODULE_ID]?.runtime?.endsAfterDamage).map(item => item.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids).catch(() => null);
}
Hooks.on("createChatMessage", message => {
    void armorUpOnUse(message).catch(error => notifyError("Armor Up! failed", error));
    const applied = message.flags?.pf2e?.appliedDamage;
    if (!applied?.uuid || applied.isHealing) return;
    void fromUuid(applied.uuid).then(actor => endAfterDamage(actor)).catch(error => notifyError("Ending after damage failed", error));
});
Hooks.on("updateActor", (actor, _changes, options) => {
    if (options?.damageTaken > 0) void endAfterDamage(actor).catch(error => notifyError("Ending after damage failed", error));
    if (options?.damageTaken > 0) recordDamage(actor, options.damageTaken);
    if (options?.damageTaken > 0) void runtime.grantedBlockOffer(actor, options).catch(error => notifyError("Granted reaction offer failed", error));
});

Hooks.on("updateToken", (token, changes) => { void hyphaeOnMove(token, changes).catch(error => notifyError("Ending on movement failed", error)); });

Hooks.on("createItem", item => {
    void outlineOnCondition(item).catch(error => notifyError("Faerie Fire's outline failed", error));
    void outlineOnInvisible(item).catch(error => notifyError("Faerie Fire's outline failed", error));
    void cloudActionOnCondition(item).catch(error => notifyError("Condition-ended Effect failed", error));
    void spellshapeOnEffect(item).catch(error => notifyError("Spellshape duration failed", error));
});

Hooks.on("deleteItem", (item, options) => {
    void endMarksWithoutPersistent(item).catch(error => notifyError("Caster mark ending failed", error));
    void delayedDamageOnEnd(item).catch(error => notifyError("Delayed damage failed", error));
    void sharedLoreOnEnd(item).catch(error => notifyError("Shared Lore ending failed", error));
    // (The summons' Ongoing areas — Tree of Life and Death's emanations, Colossal Summon's Megalophobia — end with them: first, while the creature they come from is
    // still there (an area whose source is gone waits for review instead of ending).)
    const summonEnding = item?.flags?.[MODULE_ID]?.summon;
    const ownAreas = summonEnding && item.type === "effect" && game.user?.isGM && game.users.activeGM?.id === game.user.id ? summonEnding.ongoingCastIds ?? [] : [];
    void (async () => {
        for (const castId of ownAreas) await ongoing.request("end", { castId }).catch(() => null);
        await summonOnEnd(item);
    })().catch(error => notifyError("Summon ending failed", error));
    void minionControlOnEnd(item).catch(error => notifyError("Minion control ending failed", error));
    // (A note's condition after it, and its creature's death when the spell ends: note-end-runtime.js.)
    void noteEndAfter(item, options).catch(error => notifyError("Note ending failed", error));
    void dismantleOnEnd(item).catch(error => notifyError("Dismantle ending failed", error));
    void outlineOnInvisible(item, { deleted: true }).catch(error => notifyError("Faerie Fire's outline failed", error));
    void conjuredOnEnd(item).catch(error => notifyError("Conjured item ending failed", error));
    void hiddenTurnEnd(item, options).catch(error => notifyError("Hidden ending failed", error));
    void coverSquareOnEnd(item).catch(error => notifyError("Cover square ending failed", error));
    void sceneWallsOnEnd(item).catch(error => notifyError("Spell walls ending failed", error));
    void runtime.ritualTerrainOnEnd(item).catch(error => notifyError("Ritual terrain ending failed", error));
    void immunityOnEffectUsed(item, options).catch(error => notifyError("Temporary immunity failed", error));
    void runtime.handleDeletedEffect(item, options)
        .catch(error => notifyError("Effect termination failed", error));
});

Hooks.on("updateItem", item => {
    void runtime.handleUpdatedEffect(item)
        .catch(error => notifyError("Effect expiration transition failed", error));
});

// Client-local refresh: authority changes must not rewrite persisted cast state.
Hooks.on("userConnected", () => bindSaveButtons(document));
Hooks.on("updateUser", () => bindSaveButtons(document));

// A scroll (or other consumable) used up by its cast: its stored spell remembered just before PF2e deletes it, and kept on the spell card
// it posted so the card's resolution still finds the spell (after a reload too).
Hooks.on("preDeleteItem", item => { try { if (item.type === "consumable" && item.embeddedSpell) rememberCastSpell(item.embeddedSpell); } catch (_) {} });
Hooks.on("createChatMessage", message => {
    try {
        if (message.author?.id !== game.user?.id || message.flags?.pf2e?.origin?.type !== "spell" || message.flags?.pf2e?.casting?.embeddedSpell) return;
        const uuid = message.flags.pf2e.origin.uuid, kept = rememberedCastSpell(uuid);
        if (!kept || fromUuidSync(uuid)) return;
        void message.setFlag(MODULE_ID, "castSpellSource", kept.source).catch(() => {});
    } catch (_) {}
});

Hooks.on("getSceneControlButtons", controls => {
    if (controls.tokens) controls.tokens.tools.ongoingSpells = { name: "ongoingSpells", title: "Ongoing spells", icon: "fa-solid fa-clock", button: true, onChange: () => { void ongoing.open(); } };
});
Hooks.on("updateWorldTime", () => { void ongoing.reconcile().catch(error => notifyError("Ongoing world-time reconciliation failed", error)); });
// Life Pact: damage about to reduce a pact member to 0 Hit Points is first offset by the other members' Hit Points.
Hooks.on("preUpdateActor", (actor, changes, options) => { try { runtime.hpPactTrigger(actor, changes, options); } catch (error) { notifyError("Life Pact failed", error); } });
// Moth's Supper: healing for each interval of world time passed (and the last ones when the Effect ends).
Hooks.on("updateWorldTime", () => { void runtime.intervalHealTick().catch(error => notifyError("Interval healing failed", error)); });
// Mad Monkeys: the spell's end ends the clinging notes (the active GM).
Hooks.on("deleteItem", item => {
    const castId = item.flags?.[MODULE_ID]?.mischief?.castId;
    if (!castId || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    const actors = new Set([...(canvas.scene?.tokens ?? [])].map(token => token.actor).filter(Boolean));
    for (const actor of actors) {
        const ids = (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.mischiefCling?.castId === castId).map(effect => effect.id);
        if (ids.length) void actor.deleteEmbeddedDocuments("Item", ids, { [MODULE_ID]: { reason: "spell-ended" } }).catch(error => notifyError("Mad Monkeys' end failed", error));
    }
});
Hooks.on("deleteItem", item => { if (item.flags?.[MODULE_ID]?.intervalHeal) void runtime.intervalHealTick(item).catch(error => notifyError("Interval healing failed", error)); });
// (Only when the encounter's clock moves: a flag-only Combat update cost every client up to a second of reconciling.)
Hooks.on("updateCombat", (_combat, changes) => { if ("turn" in changes || "round" in changes) void ongoing.reconcile({ clockEvent: true }).catch(error => notifyError("Ongoing turn reconciliation failed", error)); });
Hooks.on("deleteCombat", () => { void ongoing.reconcile({ clockEvent: true }).catch(error => notifyError("Ongoing encounter review failed", error)); });
Hooks.on("userConnected", () => { void ongoing.reconcile({ recover: true }).catch(error => notifyError("Ongoing GM handoff failed", error)); });
// (Who coordinates follows the GMs' roles and presence, not a user's flags.)
Hooks.on("updateUser", (_user, changes) => { if ("role" in changes || "active" in changes) void ongoing.reconcile({ recover: true }).catch(error => notifyError("Ongoing authority refresh failed", error)); });

// (Membership follows where a token is, its size and height, whether it's hidden, its side and its actor; not a flag-only update.)
const MEMBERSHIP_KEYS = ["x", "y", "elevation", "width", "height", "hidden", "disposition", "actorId", "actorLink", "delta"];
Hooks.on("updateToken", (_token, changes) => { if (MEMBERSHIP_KEYS.some(key => key in changes)) void ongoing.reconcile().catch(error => notifyError("Ongoing target review failed", error)); });
// (Promised Renewal: the growth around a creature its save killed.)
Hooks.on(`${MODULE_ID}.saveApplied`, ({ card, state }) => {
    if (!game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    // (Essence Eating Shell: each creature's note, weakness or speed penalty by its degree.)
    if (card?.flags?.[MODULE_ID]?.essenceShellNote) void import("./essence-shell-runtime.js").then(module => module.essenceShellAfterSave(card, state)).catch(error => notifyError("Essence Eating Shell's effect failed", error));
    if (!state?.renewalGrowth) return;
    void runtime.renewalOnKill(state).catch(error => notifyError("Promised Renewal's growth failed", error));
});
// (Essence Eating Shell's transmutation: the speed penalty goes with the sickened condition.)
Hooks.on("deleteItem", item => {
    if (item?.type !== "condition" || item.slug !== "sickened" || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return;
    void import("./essence-shell-runtime.js").then(module => module.essenceShellSickenedGone(item)).catch(error => notifyError("Essence Eating Shell's speed penalty failed", error));
});

Hooks.on("updateActor", () => { void ongoing.reconcile().catch(error => notifyError("Ongoing source review failed", error)); });
Hooks.on("deleteActor", () => { void ongoing.reconcile().catch(error => notifyError("Ongoing source review failed", error)); });
Hooks.on("deleteRegion", () => { void ongoing.reconcile().catch(error => notifyError("Ongoing area review failed", error)); });
/** "If the fire source is a creature, the creature takes 1d6 points of cold damage" (Pyrotechnics): the targeted creature, as the area starts. */
async function sourceCreatureDamage(plan, item, targets) {
    const data = plan.resolution?.sourceCreatureDamage;
    const token = targets.length === 1 ? (targets[0].document ?? targets[0]) : null;
    if (!data || !token?.actor) return null;
    const DamageRoll = CONFIG.Dice.rolls.find(roll => roll.name === "DamageRoll");
    const roll = await new DamageRoll(`${data.formula}[${data.type}]`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: item?.actor }), flavor: `<strong>${foundry.utils.escapeHTML(item?.name ?? "")}</strong>: the fire source ${foundry.utils.escapeHTML(token.name)} is a creature` }).catch(() => null);
    await token.actor.applyDamage({ damage: roll, token, item, rollOptions: new Set() });
    return roll.total;
}

Hooks.on("renderChatMessageHTML", (_message, html) => {
    html.querySelector?.("[data-pf2e-ongoing-open]")?.addEventListener("click", () => void ongoing.open());
});

// GM notes only for the GM (the user, 2026-10-05): a message of GM notes alone is whispered to the GMs; a shared card's GM notes are removed on players' screens.
// Casting rules (casting-rules-runtime.js): the stupefied flat check, Steady Spellcasting, Counterspell and Communal Healing as a spell is cast.
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.casting || message.flags?.pf2e?.context?.type === "spell-cast") void castingRulesOnCast(message).catch(error => notifyError("A casting rule failed", error)); });
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "casting-rule") bindCastingRuleButtons(message, html); });
// (Items whose activation is a spellshape — spell features batch F4: their cards, the areas' turn-start saves, the charged caster's retaliation, the star chart's stars.)
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "item-shape-card") bindItemShapeButtons(message, html); });
// (Creature abilities that act on spells — spell features batch G3: aura and reaction counteracts, aura saves, compulsions, item-spell immunity.)
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "creature-spell-ability") bindCreatureAbilityButtons(message, html); });
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.casting || message.flags?.pf2e?.context?.type === "spell-cast") void creatureAbilitiesOnCast(message).catch(error => notifyError("A creature's ability failed", error)); });
// (Actions that change a spell's casting or resolution — spell features batch G2: Spellstrike and the shots, Intercession Spell, Absorb into the Aegis,
// Ring Bell, Only You and I; Dueling Counter in casting-rules-runtime.js; Draw From the Pages in spellshape-runtime.js.)
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "spell-action") bindSpellActionButtons(message, html); });
Hooks.on("createChatMessage", message => {
    if (message.flags?.pf2e?.casting || message.flags?.pf2e?.context?.type === "spell-cast") void spellActionsOnCast(message).catch(error => notifyError("A spell action failed", error));
    if (message.flags?.pf2e?.context?.type === "attack-roll") void deliveryOnStrike(message).catch(error => notifyError("Spellstrike failed", error));
    if (message.flags?.pf2e?.context?.type === "damage-taken") void invigorateOnDamage(message).catch(error => notifyError("Invigorate failed", error));
});
// (Items that act on a spell cast — spell features batch F6: Rune of Sin, Book of Warding Prayers, Reflecting Shield, Spell Duelist's Siphon.)
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "spell-trigger-item") bindTriggerItemButtons(message, html); });
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.casting || message.flags?.pf2e?.context?.type === "spell-cast") void spellTriggerItemsOnCast(message).catch(error => notifyError("An item's trigger failed", error)); });
// (Items that cast a spell with numbers of their own — spell features batch F5: the spellhearts, weapons and charms; the Spell Reservoir rune.)
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "item-cast-card") bindItemCastButtons(message, html); });
Hooks.on("createChatMessage", message => {
    if (message.flags?.pf2e?.origin && !message.flags.pf2e.context && !message.flags.pf2e.casting) void itemCastOnCard(message).catch(error => notifyError("An item's spells failed", error));
    if (message.flags?.pf2e?.casting || message.flags?.pf2e?.context?.type === "spell-cast") void reservoirOnCast(message).catch(error => notifyError("The Spell Reservoir failed", error));
    if (message.flags?.pf2e?.context?.type === "attack-roll") void reservoirOnStrike(message).catch(error => notifyError("The Spell Reservoir failed", error));
});
Hooks.on("updateCombat", (combat, changes) => { if ("turn" in changes || "round" in changes) void itemShapeTurnStart(combat).catch(error => notifyError("An item's area failed", error)); });
Hooks.on("createChatMessage", message => {
    if (message.flags?.pf2e?.context?.type || message.flags?.pf2e?.casting) void itemShapeWatchMessage(message).catch(error => notifyError("An item's watch failed", error));
    if (message.flags?.pf2e?.casting || message.flags?.pf2e?.context?.type === "spell-cast") void starChartOnCast(message).catch(error => notifyError("The star chart failed", error));
});
// Sorcerer blood magic (blood-magic-runtime.js): its card as a blood magic spell is cast (or Blood Rising used); an unspent spite's temporary Hit Points.
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.casting || message.flags?.pf2e?.origin?.type === "feat") void bloodMagicOnCast(message).catch(error => notifyError("Blood magic failed", error)); });
Hooks.on("renderChatMessageHTML", (message, html) => { if (["blood-magic", "blood-spite"].includes(message.flags?.[MODULE_ID]?.kind)) bindBloodMagicButtons(message, html); });
Hooks.on("updateCombat", (combat, changes) => { if ("turn" in changes || "round" in changes) void spiteTurnStart(combat).catch(error => notifyError("Blood magic's spite failed", error)); });
// Notes carried out by watching PF2e's messages: Theogeny's critical punishment, Musical Shift's flat and sharp (note-watchers.js).
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.context?.type) void noteWatchMessage(message).catch(error => notifyError("A watched note failed", error)); });
Hooks.on("pf2e.endTurn", combatant => { void noteWatchEndTurn(combatant).catch(error => notifyError("A watched note failed", error)); });
Hooks.on("preCreateChatMessage", message => { try { whisperGmNotes(message); } catch (error) { console.warn(`${MODULE_ID} | GM note whisper failed.`, error); } });
// (Effects: their descriptions' GM notes carry PF2e's data-visibility="gm", hidden from players by PF2e.)
Hooks.on("preCreateItem", item => { try { markEffectGmNotes(item); } catch (error) { console.warn(`${MODULE_ID} | GM note marking failed.`, error); } });
Hooks.on("preUpdateItem", (item, changes) => { try { markEffectGmNotesUpdate(item, changes); } catch (error) { console.warn(`${MODULE_ID} | GM note marking failed.`, error); } });
// A curse stage that brings a creature (Gift of Dusk): placed when the curse reaches it; the stage held while it lives; the curse ended when it's slain.
Hooks.on("preUpdateItem", (item, changes) => { try { holdCurseStage(item, changes); } catch (error) { console.warn(`${MODULE_ID} | The curse's stage hold failed.`, error); } });
for (const event of ["createItem", "updateItem"]) Hooks.on(event, item => { if (item?.flags?.[MODULE_ID]?.stageCreature) void curseCreatureCheck(item).catch(error => notifyError("The curse's creature failed", error)); });
Hooks.on("updateActor", actor => { if (actor?.flags?.[MODULE_ID]?.curseCreature) void curseCreatureSlain(actor).catch(error => notifyError("The curse's ending failed", error)); });
// Tyrant's Writs: an Explosive undead at 0 Hit Points explodes; a Rotten one hurts the wounded living creatures starting their turns beside it.
Hooks.on("updateActor", actor => { if ((actor?.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.summonBenefit?.kind === "explosive")) void explodeAtZero(actor).catch(error => notifyError("The undead's explosion failed", error)); });
Hooks.on("updateCombat", (combat, changes) => { if ("turn" in changes || "round" in changes) void rottenTurnStart(combat).catch(error => notifyError("The rotten undead's damage failed", error)); });
// Rude Awakening: what the ally suppressed comes back when the spell's Effect ends, if it would still apply.
Hooks.on("deleteItem", (item, options) => { if (item?.flags?.[MODULE_ID]?.suppressionSave?.suppressed) void suppressionEnded(item, options).catch(error => notifyError("The suppressed effect's return failed", error)); });
Hooks.once("ready", () => { void markExistingGmNotes().catch(error => console.warn(`${MODULE_ID} | GM note marking failed.`, error)); });
Hooks.on("renderChatMessageHTML", (message, html) => { try { hideGmNotes(message, html); } catch (error) { console.warn(`${MODULE_ID} | GM note hiding failed.`, error); } });

Hooks.on("deleteToken", () => { void ongoing.reconcile().catch(error => notifyError("Ongoing target review failed", error)); });

Hooks.on("userConnected", () => { immediate.bind(document); void immediate.recover().catch(error => notifyError("Immediate recovery failed", error)); });
Hooks.on("updateUser", () => { immediate.bind(document); void immediate.recover().catch(error => notifyError("Immediate recovery failed", error)); });

Hooks.on('renderActorSheet', (app, html) => forms.bindSheet(app, html));

// (Magus+'s Slidecasting: a Step or Stride in a turn the magus also casts — spell-actions-runtime.js slidecastNow.)
Hooks.on("updateToken", (token, changes) => {
    if (("x" in changes || "y" in changes) && token.actor) void slidecastNow(token.actor, "move").catch(error => notifyError("Slidecasting failed", error));
});

// (Magic+'s essence casting around its own pool: cycles and termini, the redraw gate, the encounter's start and end — essence-runtime.js.)
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.casting) void essenceOnCast(message).catch(error => notifyError("Essence casting failed", error)); });
Hooks.on("createChatMessage", message => { if (message.flags?.pf2e?.casting) void triplicateOnCast(message).catch(error => notifyError("Triplicate Casting failed", error)); });
// (The "+" features that give or spare Focus Points: plus-focus-runtime.js.)
Hooks.on("createChatMessage", message => {
    void refocusMoreOnCard(message).catch(error => notifyError("Golden Core's Refocus failed", error));
    void freeFocusOnCard(message).catch(error => notifyError("I Am Omnipotent! failed", error));
    void freeFocusOnCast(message).catch(error => notifyError("I Am Omnipotent!'s focus spell failed", error));
    void bunOnCard(message).catch(error => notifyError("Revitalizing Bun failed", error));
});
Hooks.on("createItem", item => { void bargainOnCreate(item).catch(error => notifyError("Bargain Soul failed", error)); });
Hooks.on("deleteItem", item => { void freeFocusEnded(item).catch(error => notifyError("I Am Omnipotent!'s immunity failed", error)); });
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "focus-card") bindFocusButtons(message, html); });
// (The "+" features that counteract: plus-counteract-runtime.js.)
Hooks.on("createChatMessage", message => { void counteractFeatureOnCard(message).catch(error => notifyError("A counteract feature failed", error)); });
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "counteract-card") bindCounteractButtons(message, html); });
// (Stigmata's Heal, Outsider Caller's burst: plus-cast-riders-runtime.js.)
Hooks.on("createChatMessage", message => {
    void stigmataOnHealing(message).catch(error => notifyError("Stigmata's Heal failed", error));
    void summonBurstOnCast(message).catch(error => notifyError("Outsider Caller failed", error));
    void hexFamiliarOnCast(message).catch(error => notifyError("A hex familiar ability failed", error));
});
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "cast-after-card") bindCastAfterButtons(message, html); });
Hooks.on("createItem", item => { void surgeAddonOnCreate(item).catch(error => notifyError("An Evolution Surge add-on failed", error)); });
// (Wizards+'s exploits and Channel Smite+: plus-exploit-runtime.js.)
Hooks.on("createChatMessage", message => {
    void exploitOnCard(message).catch(error => notifyError("An exploit's card failed", error));
    void channelSmiteOnStrike(message).catch(error => notifyError("Channel Smite+ failed", error));
});
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "exploit-card") bindExploitButtons(message, html); });
Hooks.on("updateCombat", (combat, changes) => { if ("turn" in changes || "round" in changes) void exploitAuraTurnStart(combat).catch(error => notifyError("An exploit's aura failed", error)); });
Hooks.on("createChatMessage", message => { void catalystSporesOnDamage(message).catch(error => notifyError("A catalyst's spores failed", error)); });
// (PF2e's catalysts beyond the save card: catalyst-runtime.js.)
Hooks.on("createChatMessage", message => {
    void catalystOnDamage(message).catch(error => notifyError("A catalyst's damage rider failed", error));
    void catalystOnDecoy(message).catch(error => notifyError("A catalyst's image rider failed", error));
    void catalystOnFlatCheck(message).catch(error => notifyError("A catalyst's flat-check rider failed", error));
    void catalystOnCast(message).catch(error => notifyError("A catalyst's battle-form speech failed", error));
});
// (A cast resolved — or its lingering area started from the card: "ongoingCastId".)
Hooks.on("updateChatMessage", (message, changes) => { if (foundry.utils.getProperty(changes, `flags.${MODULE_ID}.resolvedCast`) || foundry.utils.getProperty(changes, `flags.${MODULE_ID}.ongoingCastId`)) void catalystAfterResolve(message).catch(error => notifyError("A catalyst's rider after the spell failed", error)); });
Hooks.on("updateCombat", (combat, changes) => { if ("turn" in changes || "round" in changes) void catalystTurnStart(combat).catch(error => notifyError("A catalyst's turn rider failed", error)); });
Hooks.on("updateToken", (token, changes) => { void catalystOnMove(token, changes).catch(error => notifyError("A catalyst's movement rider failed", error)); });
Hooks.on("deleteItem", item => { void catalystOnEffectEnded(item).catch(error => notifyError("A catalyst's rider as an Effect ended failed", error)); });
Hooks.on("updateItem", (item, changes) => { if (foundry.utils.getProperty(changes, `flags.${MODULE_ID}.shieldShards.blockedAt`)) void catalystShieldBlocked(item).catch(error => notifyError("A catalyst's shield shards failed", error)); });
Hooks.on("renderChatMessageHTML", (message, html) => { if (message.flags?.[MODULE_ID]?.kind === "catalyst-card") bindCatalystButtons(message, html); });
Hooks.on("combatStart", combat => { void essenceOnCombatStart(combat).catch(error => notifyError("Essence casting's encounter start failed", error)); });
Hooks.on("deleteCombat", combat => { void essenceOnCombatEnd(combat, game.modules.get(MODULE_ID)?.api?.ongoing ?? null).catch(error => notifyError("Essence casting's encounter end failed", error)); });
Hooks.on("createChatMessage", message => {
    if (message.flags?.pf2e?.context?.type === "damage-taken") void lifeReservoirOnHealing(message).catch(error => notifyError("Life Essence Reservoir failed", error));
    if (message.item?.slug === "refocus") void lifeReservoirOnRefocus(message).catch(error => notifyError("Life Essence Reservoir's Refocus failed", error));
    if (["action", "feat"].includes(message.flags?.pf2e?.origin?.type)) void essenceConduitOnCard(message).catch(error => notifyError("Essence Conduit failed", error));
    if (["action", "feat", "equipment"].includes(message.flags?.pf2e?.origin?.type)) void essenceActivationOnCard(message).catch(error => notifyError("An essence activation failed", error));
    if (message.flags?.pf2e?.origin?.type === "equipment") void energyRuneOnCard(message).catch(error => notifyError("The Energy rune's card failed", error));
    void backfireAmmoOnCard(message).catch(error => notifyError("Gray Dust Ammunition's card failed", error));
    void backfireAmmoOnStrike(message).catch(error => notifyError("Gray Dust Ammunition's Strike failed", error));
    void backfireAmmoOnCast(message).catch(error => notifyError("Gray Dust Ammunition's backfire failed", error));
    if (message.item?.slug === "refocus") void incantationsOnRefocus(message).catch(error => notifyError("Incantations' Refocus failed", error));
    if (message.flags?.pf2e?.origin?.type === "feat") void unstableDrawOnCard(message).catch(error => notifyError("Unstable Draw failed", error));
});
// (Life Essence Reservoir's size: the actor's highest healing spell, kept as its spells change.)
for (const event of ["createItem", "updateItem", "deleteItem"]) Hooks.on(event, item => { if (item.actor && ["spell", "spellcastingEntry", "feat"].includes(item.type)) void lifeReservoirRank(item.actor).catch(() => null); });
