// Magic+'s essence casting (the user, 2026-10-07: "Automate the system"). Magic+'s own script keeps the essence pool through a cast: a draw cantrip draws, a 2- or 3-action
// essence spell raises it by 1 or completes a cycle (back to 0), a 1-action, reaction or free one leaks (back to 0), the bounded steps; and it locks the ranks above the current
// essence. What its texts tie to those moments is done here, from the rules' own words ("Essence Spellcasting", Magic+'s journal; the class feature feats):
//   - "When you start an encounter, you normally have 0 essence" — and Initial Draw: "you draw an amount of essence up to your essence draw when you roll initiative";
//   - a completed cycle: the caster's terminus ("Trigger You complete a cycle", its Effect at that cycle — 1, 2, 3 — of the encounter);
//   - "Unless you have the essence rebirth class feature, you can't gain essence again until the next time you're in a different encounter" (after a cycle), and after an
//     essence leak "you cannot draw essence again unless you have the essence rebirth class feature";
//   - "All essence spells end as soon as the encounter ends."
// The cast is read as its message is made: Magic+ changes the pool after it, so the pool then is the one before the cast.
import { riderChoice, shapeEffect, timedTempHp, castTargetActors } from "./spellshape-runtime.js";
import { MODULE_ID, activeGM, escapeHTML, plainText } from "./runtime-utils.js";

import { noticeImmunity } from "./immunity-notice.js";
const actionsOf = spell => String(spell?.system?.time?.value ?? "");

/** The actor's essence pool (Magic+'s special resource), or null. */
export function essencePool(actor) {
    const resource = actor?.getResource?.("essence-pool");
    return resource ? { value: Number(resource.value ?? 0), max: Number(resource.max ?? 0) } : null;
}

/** An essence spell: one with Magic+'s essence trait (its essence entries add it), not a cantrip. */
export const isEssenceSpell = spell => (spell?.system?.traits?.value ?? []).includes("essence") && !(spell.system.traits.value ?? []).includes("cantrip");
/** "Ordinary cantrips that use 2 actions or more (not focus cantrips, and not amped cantrips …) are called draw cantrips." */
export const isDrawCantrip = spell => {
    const traits = spell?.system?.traits?.value ?? [];
    return traits.includes("cantrip") && !traits.includes("focus") && ["2", "3"].includes(actionsOf(spell));
};
// (A feat's name may carry its choice — "Life Essence Reservoir (None)".)
const featOf = (actor, slug, name) => (actor?.itemTypes?.feat ?? []).find(item => item.slug === slug || item.name === name || item.name.startsWith(`${name} (`)) ?? null;
const hasFeat = (actor, slug, name) => Boolean(featOf(actor, slug, name));
const say = (actor, html) => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: html }).catch(() => null);

/** This encounter's essence record on the actor: {combatId, cycles, leaks}. */
function encounterOf(actor) {
    const combat = game.combat?.started ? game.combat : null;
    const record = actor.getFlag(MODULE_ID, "essenceEncounter");
    return combat && record?.combatId === combat.id ? record : { combatId: combat?.id ?? null, cycles: 0, leaks: 0 };
}

/** An essence caster's cast: a cycle (its terminus), a leak, or a draw it can't make. */
export async function essenceOnCast(message) {
    if (!activeGM() || !message?.flags?.pf2e?.casting) return null;
    const actor = message.actor, spell = message.item;
    const pool = essencePool(actor);
    if (!actor || !spell || !pool || (actor.getRollOptions?.() ?? []).includes("essence-blocked")) return null;
    const bounded = (actor.getRollOptions?.() ?? []).includes("essence-caster:bounded");
    const record = encounterOf(actor);
    const actions = actionsOf(spell);
    // (The essence before this cast — Essence Summoner's bonus reads it.)
    await message.setFlag(MODULE_ID, "essenceBefore", pool.value).catch(() => null);
    // (An incantation or an essence item's activation armed: this cast is done as it says — essenceArmedCast.)
    const armed = actor.getFlag(MODULE_ID, "essenceArmed");
    if (isEssenceSpell(spell) && armed?.kind !== "chalice") await essenceImmunity(actor, spell, message);
    if (armed && isEssenceSpell(spell)) return essenceArmedCast(actor, spell, message, armed, pool);
    // (Terminus of Life: temporary Hit Points on a cast that raises the essence and heals no one.)
    await lifeTerminusOnCast(actor, spell, message, pool).catch(() => null);
    // (Unstable Draw: its draw, and the leak it brings to the next essence spell.)
    const unstable = await unstableOnCast(actor, spell, pool, record);
    if (unstable) return unstable;
    if (isDrawCantrip(spell)) {
        // (After a cycle or a leak, no more drawing this encounter without Essence Rebirth: the pool Magic+ raises goes back to what it was.)
        if ((record.cycles > 0 || record.leaks > 0) && !hasFeat(actor, "essence-rebirth", "Essence Rebirth") && !bounded) {
            const before = pool.value;
            await waitForPool(actor, before);
            await actor.updateResource("essence-pool", before, { render: true });
            await say(actor, `<p><strong>Essence</strong>: ${escapeHTML(actor.name)} can't draw essence again this encounter (no Essence Rebirth).</p>`);
            return { refused: "rebirth", essence: before };
        }
        return { drew: true };
    }
    // (Essence Conduit armed: "the next time you Cast a Spell that takes 1 or 2 actions to cast, you increase your essence by 1 even if the spell would not normally increase your
    // essence (such as a focus spell). If the spell was a 1-action essence spell, you don't experience an essence leak.")
    const conduit = actor.getFlag(MODULE_ID, "essenceConduit");
    if (conduit && ["1", "2"].includes(actions)) {
        await actor.unsetFlag(MODULE_ID, "essenceConduit");
        const raises = !isEssenceSpell(spell) || actions === "1";
        if (raises) {
            const target = Math.min(pool.max, pool.value + 1);
            if (isEssenceSpell(spell) || pool.value !== target) await waitForPool(actor, pool.value);
            await actor.updateResource("essence-pool", target, { render: true });
            await say(actor, `<p><strong>Essence Conduit</strong>: ${escapeHTML(actor.name)}'s essence ${pool.value} → ${target}${isEssenceSpell(spell) ? " (no essence leak)" : ""}.</p>`);
            return { conduit: target };
        }
    }
    if (!isEssenceSpell(spell)) return null;
    if (["1", "reaction", "free"].includes(actions)) {
        record.leaks += 1;
        await actor.setFlag(MODULE_ID, "essenceEncounter", record);
        const channel = await channelLeak(actor, message);
        return { leak: true, leaks: record.leaks, channel };
    }
    // ("If gaining essence would put you above your essence pool …, if you're a normal spellcaster, you complete an essence cycle and your essence returns to 0.")
    if (bounded || pool.value !== pool.max || !["2", "3"].includes(actions)) return { raised: true };
    record.cycles += 1;
    await actor.setFlag(MODULE_ID, "essenceEncounter", record);
    const terminus = await terminusFor(actor, record, pool);
    return { cycle: record.cycles, terminus };
}

/** Magic+ updates the pool after the cast's message: wait for that (or a moment) before correcting it. */
async function waitForPool(actor, before) {
    for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 150)); if (essencePool(actor)?.value !== before) return; }
}

/**
 * The caster's terminus on a completed cycle ("Trigger You complete a cycle"): its feats with the terminus trait and an Effect, asked when it has several (or the actor flag
 * `essenceTerminusChoice`); the Effect at the encounter's cycle — "Cycle 1 … Cycle 2 As cycle 1, except … Cycle 3 …" — replacing the one before. Terminus of Renewal needs
 * incantations to undo ("Requirements Your essence draw and essence pool are currently reduced due to incantations"); Terminus of Ultima a cycle at 9 essence after another.
 */
async function terminusFor(actor, record, pool) {
    const termini = (actor.itemTypes?.feat ?? []).filter(item => (item.system?.traits?.value ?? []).includes("terminus") || /^Terminus of /.test(item.name))
        .filter(item => item.system?.actionType?.value === "free" || item.system?.selfEffect?.uuid);
    const incantations = (actor.itemTypes?.effect ?? []).find(effect => effect.name === "Effect: Maintaining Incantations");
    const eligible = termini.filter(item => {
        if (/Terminus of Renewal/.test(item.name)) return Boolean(incantations);
        if (/Terminus of Ultima/.test(item.name)) return pool.max >= 9 && record.cycles >= 2;
        if (/Terminus of Bounded Might/.test(item.name)) return false;
        return true;
    });
    if (!eligible.length) return null;
    const preset = actor.getFlag(MODULE_ID, "essenceTerminusChoice");
    const chosenName = eligible.length === 1 ? eligible[0].name : eligible.some(item => item.name === preset) ? preset
        : await riderChoice({ name: "Essence cycle", choice: null }, "Which terminus?", eligible.map(item => ({ value: item.name, label: item.name })));
    const chosen = eligible.find(item => item.name === chosenName) ?? eligible[0];
    const cycle = Math.min(3, record.cycles);
    if (/Terminus of Renewal/.test(chosen.name)) {
        // ("You Dismiss any number of active incantations. Then, you regain any reduced essence draw and essence pool from incantations …")
        await incantations.delete();
        await say(actor, `<p><strong>${escapeHTML(chosen.name)}</strong>: the incantations end; the essence draw and pool are restored.</p>`);
        return { name: chosen.name, cycle };
    }
    const uuid = chosen.system?.selfEffect?.uuid ?? null;
    const template = uuid ? await fromUuid(uuid).catch(() => null) : null;
    if (!template) { await say(actor, `<p><strong>${escapeHTML(chosen.name)}</strong> (cycle ${cycle}).</p>`); return { name: chosen.name, cycle }; }
    for (const old of (actor.itemTypes?.effect ?? []).filter(effect => effect.name.startsWith(template.name))) await old.delete();
    const source = template.toObject(); delete source._id;
    foundry.utils.setProperty(source, "_stats.compendiumSource", template.uuid);
    source.system.badge = { ...(source.system.badge ?? { type: "counter" }), type: source.system.badge?.type ?? "counter", value: cycle };
    // (The encounter's: it ends with it.)
    foundry.utils.setProperty(source, `flags.${MODULE_ID}.essenceEncounter`, record.combatId);
    const [made] = await actor.createEmbeddedDocuments("Item", [source]);
    await say(actor, `<p><strong>${escapeHTML(chosen.name)}</strong>: essence cycle ${record.cycles} — ${escapeHTML(template.name)} at cycle ${cycle}.</p>`);
    return { name: chosen.name, cycle, effect: made?.uuid ?? null };
}

/** An encounter starts: each essence caster's essence 0 — or, with Initial Draw, its essence draw ("you draw … up to your essence draw when you roll initiative"). */
export async function essenceOnCombatStart(combat) {
    if (!activeGM()) return [];
    const done = [];
    for (const combatant of combat?.combatants ?? []) {
        const actor = combatant.actor;
        const pool = essencePool(actor);
        if (!pool) continue;
        const draw = Number(actor.flags?.pf2e?.["essence-draw"] ?? 0);
        const start = hasFeat(actor, "initial-draw", "Initial Draw") ? Math.min(draw, pool.max) : 0;
        await actor.updateResource("essence-pool", start, { render: true });
        await actor.setFlag(MODULE_ID, "essenceEncounter", { combatId: combat.id, cycles: 0, leaks: 0 });
        done.push({ actor: actor.name, essence: start });
    }
    return done;
}

/**
 * An encounter ends: "All essence spells end as soon as the encounter ends." — the Effects from essence spells (and the encounter's termini) removed, the module's areas from them
 * ended; each essence caster's essence back to 0.
 */
export async function essenceOnCombatEnd(combat, ongoing = null) {
    if (!activeGM()) return [];
    const done = [];
    // (The combat's essence casters: its combatants', or — the combatants may be gone with it — those whose encounter record is this combat's.)
    const casters = new Set([...(combat?.combatants ?? []).map(combatant => combatant.actor), ...game.actors.filter(actor => actor.getFlag(MODULE_ID, "essenceEncounter")?.combatId === combat?.id)]
        .filter(actor => essencePool(actor)));
    if (!casters.size) return done;
    const fromEssence = effect => {
        const origin = effect.system?.context?.origin?.item ?? effect.flags?.[MODULE_ID]?.runtime?.sourceItemUuid ?? null;
        const item = origin ? fromUuidSync(origin) : null;
        return Boolean(item && casters.has(item.actor) && isEssenceSpell(item));
    };
    const holders = new Set([...game.actors, ...(canvas?.scene?.tokens ?? []).map(token => token.actor).filter(Boolean)]);
    for (const holder of holders) {
        const ids = (holder.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.essenceEncounter === combat.id || fromEssence(effect)).map(effect => effect.id);
        if (ids.length) { await holder.deleteEmbeddedDocuments("Item", ids).catch(() => null); done.push({ holder: holder.name, ended: ids.length }); }
    }
    if (ongoing?.records) for (const record of Object.values(await ongoing.records() ?? {}).flat()) {
        const item = record?.sourceItemUuid ? fromUuidSync(record.sourceItemUuid) : null;
        if (record?.status === "active" && item && casters.has(item.actor) && isEssenceSpell(item)) { await ongoing.request("end", { castId: record.castId }).catch(() => null); done.push({ area: record.name }); }
    }
    for (const actor of casters) { await actor.updateResource("essence-pool", 0, { render: true }); await actor.unsetFlag(MODULE_ID, "essenceEncounter"); }
    return done;
}

/**
 * Channel Essence Leak: "When you cause an essence leak, either you gain a +1 status bonus to AC and saving throws until the end of your next turn or a creature affected by the
 * spell causing the leak takes a –1 status penalty to AC and saving throws until the end of your next turn, your choice." — asked (or the actor flag `essenceLeakChoice`:
 * "self" or a creature's uuid).
 */
async function channelLeak(actor, message) {
    if (!hasFeat(actor, "channel-essence-leak", "Channel Essence Leak")) return null;
    const affected = castTargetActors(message, actor).filter(creature => creature !== actor);
    const preset = actor.getFlag(MODULE_ID, "essenceLeakChoice");
    const options = [{ value: "self", label: `+1 to ${actor.name}'s AC and saves` }, ...affected.map(creature => ({ value: creature.uuid, label: `−1 to ${creature.name}'s AC and saves` }))];
    const choice = options.some(option => option.value === preset) ? preset : options.length === 1 ? "self" : await riderChoice({ name: "Channel Essence Leak", choice: null }, "Your choice", options);
    const self = choice === "self";
    const holder = self ? actor : affected.find(creature => creature.uuid === choice) ?? actor;
    const value = self || holder === actor ? 1 : -1;
    const made = await shapeEffect(holder, actor, `Channel Essence Leak: ${value > 0 ? "+1" : "−1"} AC and saves`, [{ key: "FlatModifier", selector: ["ac", "saving-throw"], type: "status", value }], { until: "caster-next-turn-end" });
    return { holder: holder.name, value, effect: made?.uuid ?? null };
}

/** Life Essence Reservoir's size per rank (12, or the healer adjustments' 18 and 24) and its Refocus recovery per rank (4, 6, 8). */
function reservoirOf(actor) {
    const feat = featOf(actor, "life-essence-reservoir", "Life Essence Reservoir");
    if (!feat) return null;
    const perRank = Number(feat.flags?.pf2e?.rulesSelections?.healerAdjustment ?? 12);
    const resource = actor.getResource?.("life-essence");
    return { feat, perRank, recovery: perRank / 3, value: Number(resource?.value ?? 0), max: Number(resource?.max ?? 0) };
}

/**
 * "You have a reservoir of life essence equal to the max rank healing spell you have prepared or in your repertoire times 12": the highest rank among the healing spells of the
 * actor's prepared or spontaneous entries (a signature spell's at the entry's highest slot), kept as Magic+'s flag the reservoir is computed from.
 */
export async function lifeReservoirRank(actor) {
    if (!activeGM() || !reservoirOf(actor)) return null;
    let rank = 0;
    for (const entry of actor.itemTypes?.spellcastingEntry ?? []) {
        if (!entry.isPrepared && !entry.isSpontaneous) continue;
        const slots = Object.entries(entry.system?.slots ?? {}).map(([key, slot]) => ({ rank: Number(key.replace("slot", "")), slot })).filter(entry => entry.rank > 0 && Number(entry.slot.max ?? 0) > 0);
        const highest = Math.max(0, ...slots.map(entry => entry.rank));
        for (const spell of actor.itemTypes.spell.filter(item => item.system?.location?.value === entry.id && (item.system?.traits?.value ?? []).includes("healing") && !(item.system.traits.value ?? []).includes("cantrip"))) {
            if (entry.isPrepared) rank = Math.max(rank, ...slots.filter(entry => Object.values(entry.slot.prepared ?? {}).some(prepared => prepared?.id === spell.id)).map(entry => entry.rank), 0);
            else rank = Math.max(rank, spell.system?.location?.signature ? highest : Number(spell.rank ?? spell.system?.level?.value ?? 0));
        }
    }
    if (Number(actor.flags?.pf2e?.maxhealingRank ?? 0) !== rank) await actor.update({ "flags.pf2e.maxhealingRank": rank });
    return rank;
}

/**
 * Healing from the caster's essence spell: "Each time you heal a creature with an essence spell, you reduce the reservoir by the same amount. You can never restore more Hit Points
 * to a creature with your essence spells than you have Hit Points in your reservoir." — the Hit Points restored (PF2e's message keeps the change) taken from the reservoir;
 * beyond it, taken back from the creature. (Magic Chalice's activation: no cost — E3.)
 */
export async function lifeReservoirOnHealing(message) {
    if (!activeGM() || message?.flags?.pf2e?.context?.type !== "damage-taken") return null;
    const origin = message.flags?.pf2e?.origin;
    const spell = origin?.uuid ? fromUuidSync(origin.uuid) : null;
    const caster = spell?.actor;
    const reservoir = reservoirOf(caster);
    if (!spell || !isEssenceSpell(spell) || !reservoir) return null;
    const target = message.actor;
    // (PF2e keeps the change it made to the Hit Points — negative for healing — for its undo.)
    const applied = message.flags.pf2e.appliedDamage;
    const healed = applied?.isHealing ? -Number((applied.updates ?? []).find(update => update.path === "system.attributes.hp.value")?.value ?? NaN) : NaN;
    if (!target || !Number.isFinite(healed) || healed <= 0) return null;
    // (Magic Chalice: that cast's healing — every creature it heals as it resolves — costs nothing.)
    const chalice = caster.getFlag(MODULE_ID, "chaliceFree");
    if (chalice?.spellId === spell.id && Date.now() - Number(chalice.at ?? 0) < 120000) return { free: true, healed };
    const spent = Math.min(healed, reservoir.value), excess = healed - spent;
    await caster.updateResource("life-essence", reservoir.value - spent, { render: true });
    if (excess > 0) await target.update({ "system.attributes.hp.value": Number(target.hitPoints.value) - excess });
    await say(caster, `<p><strong>Life Essence Reservoir</strong>: ${escapeHTML(target.name)} healed ${spent}${excess ? ` (${excess} more than the reservoir held: not restored)` : ""}; ${reservoir.value - spent} left.</p>`);
    return { healed: spent, excess, left: reservoir.value - spent };
}

/** "Each time you Refocus, you also recover an amount of healing in your reservoir equal to your max rank healing spell times 4" (6, 8 with the healer adjustments). */
export async function lifeReservoirOnRefocus(message) {
    if (!activeGM() || message?.item?.slug !== "refocus") return null;
    const actor = message.actor, reservoir = reservoirOf(actor);
    if (!reservoir) return null;
    const rank = Number(actor.flags?.pf2e?.maxhealingRank ?? 0);
    const value = Math.min(reservoir.max, reservoir.value + rank * reservoir.recovery);
    await actor.updateResource("life-essence", value, { render: true });
    return { recovered: value - reservoir.value, value };
}

/**
 * Essence Conduit, its card: armed for the next 1- or 2-action cast this turn (essenceOnCast). With Weave Conduit: "choose a benefit based on one of the two essences matching
 * your tradition … Life You gain temporary Hit Points equal to your level that last until the end of your next turn. Matter You Step or Stride up to half your Speed … Mind You
 * Recall Knowledge. Spirit You Seek and gain a spiritsense as an imprecise sense with a range of 30 feet that lasts until the end of your next turn." — Life and Spirit's sense
 * applied; the moves and checks the table's. (Arcane: matter and mind; divine: spirit and life; occult: spirit and mind; primal: matter and life.)
 */
export const TRADITION_ESSENCES = { arcane: ["matter", "mind"], divine: ["spirit", "life"], occult: ["spirit", "mind"], primal: ["matter", "life"] };
export async function essenceConduitOnCard(message) {
    if (!activeGM() || !["action", "feat"].includes(message?.flags?.pf2e?.origin?.type)) return null;
    const item = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    const actor = item?.actor;
    if (!actor || !essencePool(actor) || !/^You transform yourself into a conduit for your magical essences\./.test(String(item.system?.description?.value ?? "").replace(/<[^>]+>/g, "").trim())) return null;
    await actor.setFlag(MODULE_ID, "essenceConduit", { at: Date.now() });
    const result = { armed: true };
    if (hasFeat(actor, "weave-conduit", "Weave Conduit")) {
        const tradition = actor.itemTypes.spellcastingEntry.find(entry => (entry.system?.rules ?? []).some(rule => rule.value === "essence"))?.system?.tradition?.value ?? null;
        const essences = TRADITION_ESSENCES[tradition] ?? ["life", "matter", "mind", "spirit"];
        const preset = actor.getFlag(MODULE_ID, "weaveConduitChoice");
        const essence = essences.includes(preset) ? preset : await riderChoice({ name: "Weave Conduit", choice: null }, "Which essence's benefit?", essences.map(value => ({ value, label: value })));
        result.weave = essence;
        if (essence === "life") await timedTempHp(actor, Number(actor.level ?? 1), "Weave Conduit (life)", 1);
        else if (essence === "spirit") await shapeEffect(actor, actor, "Weave Conduit: spiritsense", [{ key: "Sense", selector: "spiritsense", acuity: "imprecise", range: 30 }], { until: "caster-next-turn-end" });
        else await say(actor, `<p><strong>Weave Conduit</strong> (${escapeHTML(essence)}): ${essence === "matter" ? "Step or Stride up to half your Speed" : "Recall Knowledge"} (the table's).</p>`);
    }
    return result;
}

// The essence items' activations and the Incantations action, read from their texts.
const ACTIVATIONS = [
    // Magic Bell: "Activate—Cast a Spell Frequency once per day You Cast an 1st-Rank or lower Essence Spell as though using an incantation but using its normal casting time,
    // without needing to increase it and without reducing your essence draw or essence pool."
    [/Activate\s*[—-]\s*Cast a Spell Frequency once per day You Cast an? (\d+)(?:st|nd|rd|th)-Rank or lower Essence Spell as though using an incantation but using its normal casting time, without needing to increase it and without reducing your essence draw or essence pool\./i,
        m => ({ kind: "bell", maxRank: Number(m[1]), noReduce: true, inEncounter: true, perDay: true })],
    // Magic Amulet: "Activate—Extend Incantation (manipulate) Frequency once per day If your next action is to Cast a 1st-rank or lower Essence Spell using an incantation, …
    // This allows the spell's effects to last as long as its duration and the amulet remains in place, without reducing your essence draw or essence pool and without ending any
    // previous long incantations."
    [/Activate\s*[—-]\s*Extend Incantation .*?Frequency once per day If your next action is to Cast a (\d+)(?:st|nd|rd|th)-rank or lower Essence Spell using an incantation,.*without reducing your essence draw or essence pool and without ending any previous long incantations\./i,
        m => ({ kind: "amulet", maxRank: Number(m[1]), noReduce: true, inEncounter: false, perDay: true })],
    // Magic Chalice: "Activate—Repeat Recovery (manipulate) Frequency once per day If your next action is to Cast a 1st-Rank or lower Essence Spell that heals, counteracts effects,
    // reduces or removes conditions or afflictions, or the like, your essence spell doesn't cost Hit Points from your life essence reservoir and ignores the typical 1 day
    // temporary immunity for counteracting and removal spells …"
    [/Activate\s*[—-]\s*Repeat Recovery .*?Frequency once per day If your next action is to Cast a (\d+)(?:st|nd|rd|th)-Rank or lower Essence Spell that heals, counteracts effects, reduces or removes conditions or afflictions, or the like, your essence spell doesn't cost Hit Points from your life essence reservoir and ignores the typical 1 day temporary immunity/i,
        m => ({ kind: "chalice", maxRank: Number(m[1]), keepsEssence: false, perDay: true })],
    // Incantations: "At the end of the incantation, you cast an essence spell with a rank up to your current essence pool without needing essence to do so. However, … an
    // incantation reduces both your essence draw and your essence pool by 1 … A long incantation … comes with none of the same drawbacks as a normal incantation, but its effects
    // end if you use an incantation again."
    [/At the end of the incantation, you cast an essence spell with a rank up to your current essence pool without needing essence to do so\. However, this comes at a cost: an incantation reduces both your essence draw and your essence pool by 1/,
        () => ({ kind: "incantation", inEncounter: false })]
];
export function readEssenceActivation(source) {
    const text = plainText(source?.system?.description?.value);
    for (const [pattern, build] of ACTIVATIONS) { const m = pattern.exec(text); if (m) return { name: source.name, ...build(m) }; }
    return null;
}
const MAINTAINING = "Compendium.pf2e-team-plus-magic.items.Item.mU4bcDt3wpVZ1cuE";
const dayOf = () => Math.floor(Number(game.time.worldTime ?? 0) / 86400);
const inEncounter = actor => Boolean(game.combat?.started && game.combat.combatants.some(combatant => combatant.actor === actor));

/**
 * The card of the Incantations action or of an essence item's activation: armed for the caster's next essence spell. An incantation (or the bell's, the amulet's) needs no
 * essence: the pool is opened to its maximum for that cast (Magic+ unlocks those ranks), then put back. "Incantations … can't be used during an encounter" (the bell can); once a
 * day for the items. Incantation: normal or long, asked (actor flag `essenceIncantationMode`).
 */
export async function essenceActivationOnCard(message) {
    if (!activeGM() || !["action", "feat", "equipment"].includes(message?.flags?.pf2e?.origin?.type)) return null;
    const item = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    const actor = item?.actor;
    const read = item ? readEssenceActivation(item.toObject()) : null;
    const pool = essencePool(actor);
    if (!read || !pool) return null;
    if (read.inEncounter === false && inEncounter(actor)) { await say(actor, `<p><strong>${escapeHTML(item.name)}</strong>: not during an encounter.</p>`); return { refused: "encounter" }; }
    if (read.perDay) {
        const used = actor.getFlag(MODULE_ID, "essenceItemDays") ?? {};
        if (used[item.id] === dayOf()) { await say(actor, `<p><strong>${escapeHTML(item.name)}</strong>: already used today.</p>`); return { refused: "frequency" }; }
        await actor.setFlag(MODULE_ID, "essenceItemDays", { ...used, [item.id]: dayOf() });
    }
    let mode = null;
    if (read.kind === "incantation") {
        const preset = actor.getFlag(MODULE_ID, "essenceIncantationMode");
        mode = ["normal", "long"].includes(preset) ? preset : await riderChoice({ name: "Incantation", choice: null }, "Which incantation?", [{ value: "normal", label: "Incantation (20 seconds)" }, { value: "long", label: "Long incantation (1 hour)" }]);
    }
    const armed = { kind: read.kind, name: item.name, maxRank: read.maxRank ?? null, noReduce: read.noReduce === true, mode, prior: pool.value };
    // (The chalice's spell is an ordinary essence cast: only its cost and immunity change.)
    if (read.kind !== "chalice") await actor.updateResource("essence-pool", pool.max, { render: true });
    await actor.setFlag(MODULE_ID, "essenceArmed", armed);
    return armed;
}

/** The armed cast: within the rank; the pool put back; an incantation's cost (Maintaining Incantations), a long one's predecessor ended; the chalice's free healing. */
async function essenceArmedCast(actor, spell, message, armed, pool) {
    await actor.unsetFlag(MODULE_ID, "essenceArmed");
    const rank = Number(message.flags?.pf2e?.casting?.castRank ?? spell.rank ?? 1);
    if (armed.maxRank && rank > armed.maxRank) {
        await say(actor, `<p><strong>${escapeHTML(armed.name)}</strong>: ${escapeHTML(spell.name)} is above rank ${armed.maxRank}; not used.</p>`);
        if (armed.kind !== "chalice") { await waitForPool(actor, pool.value); await actor.updateResource("essence-pool", armed.prior, { render: true }); }
        return { refused: "rank" };
    }
    if (armed.kind === "chalice") { await actor.setFlag(MODULE_ID, "chaliceFree", { spellId: spell.id, at: Date.now() }); return { chalice: spell.name }; }
    await waitForPool(actor, pool.value);
    await actor.updateResource("essence-pool", armed.prior, { render: true });
    const duration = Boolean(String(spell.system?.duration?.value ?? "").trim()) || spell.system?.duration?.sustained === true;
    const draw = Number(actor.flags?.pf2e?.["essence-draw"] ?? 0);
    // (Incantation Mastery: "when you use an incantation for a spell of lower rank than your current essence draw, you can increase the casting time to 1 minute; if you do, and
    // the spell doesn't have a duration, you don't reduce your essence draw or essence pool.")
    const mastered = hasFeat(actor, "incantation-mastery", "Incantation Mastery") && rank < draw && !duration;
    const reduces = armed.kind === "incantation" && armed.mode === "normal" && !armed.noReduce && !mastered;
    const list = actor.getFlag(MODULE_ID, "essenceIncantations") ?? [];
    // ("its effects end if you use an incantation again": a long incantation's, at the next incantation — not with the amulet's.)
    if (armed.kind === "incantation") for (const entry of list.filter(entry => entry.long)) await endSpellEffects(entry.spellUuid);
    const kept = armed.kind === "incantation" ? list.filter(entry => !entry.long) : list;
    kept.push({ spellUuid: spell.uuid, name: spell.name, duration, reduces, long: armed.mode === "long", at: game.time.worldTime });
    await actor.setFlag(MODULE_ID, "essenceIncantations", kept);
    if (reduces) await maintainingBy(actor, 1);
    await say(actor, `<p><strong>${escapeHTML(armed.name)}</strong>: ${escapeHTML(spell.name)} at rank ${rank}${armed.mode === "long" ? " (long incantation)" : ""}${reduces ? " — the essence draw and pool reduced by 1" : mastered ? " (Incantation Mastery: no reduction)" : ""}.</p>`);
    return { incantation: spell.name, reduces, mastered, long: armed.mode === "long" };
}

/** Effect: Maintaining Incantations — "Reduces your essence draw and essence pool by the amount on the effect counter." — changed by `delta` (gone at 0). */
async function maintainingBy(actor, delta) {
    const effect = (actor.itemTypes?.effect ?? []).find(entry => entry.name.startsWith("Effect: Maintaining Incantations"));
    const value = Number(effect?.system?.badge?.value ?? 0) + delta;
    if (effect && value <= 0) return effect.delete();
    if (effect) return effect.update({ "system.badge.value": value });
    if (value <= 0) return null;
    const template = await fromUuid(MAINTAINING).catch(() => null);
    if (!template) return null;
    const source = template.toObject(); delete source._id;
    source.system.badge = { ...(source.system.badge ?? {}), value };
    return actor.createEmbeddedDocuments("Item", [source]);
}

/** The Effects a spell left (its origin or the module's source item that spell), on every creature. */
async function endSpellEffects(spellUuid) {
    const holders = new Set([...game.actors, ...(canvas?.scene?.tokens ?? []).map(token => token.actor).filter(Boolean)]);
    for (const holder of holders) {
        const ids = (holder.itemTypes?.effect ?? []).filter(effect => (effect.system?.context?.origin?.item ?? effect.flags?.[MODULE_ID]?.runtime?.sourceItemUuid) === spellUuid).map(effect => effect.id);
        if (ids.length) await holder.deleteEmbeddedDocuments("Item", ids, { [MODULE_ID]: { ongoingCleanup: true } }).catch(() => null);
    }
}

/**
 * Refocus: "When you Refocus, you can choose to Dismiss any incantations you have active. Then, you regain any reduced essence draw and essence pool from the incantations that
 * have ended or had no duration to begin with." — asked (actor flag `essenceDismissIncantations`); an incantation with a duration has ended when no Effect from it is left.
 */
export async function incantationsOnRefocus(message) {
    if (!activeGM() || message?.item?.slug !== "refocus") return null;
    const actor = message.actor;
    const list = actor?.getFlag(MODULE_ID, "essenceIncantations") ?? [];
    if (!list.some(entry => entry.reduces)) return null;
    const preset = actor.getFlag(MODULE_ID, "essenceDismissIncantations");
    const dismiss = typeof preset === "boolean" ? preset : await riderChoice({ name: "Refocus", choice: null }, "Dismiss your incantations?", [{ value: "yes", label: "Dismiss them" }, { value: "no", label: "Keep them" }]) === "yes";
    const lasting = entry => [...game.actors].some(holder => (holder.itemTypes?.effect ?? []).some(effect => (effect.system?.context?.origin?.item ?? effect.flags?.[MODULE_ID]?.runtime?.sourceItemUuid) === entry.spellUuid));
    let regained = 0;
    const kept = [];
    for (const entry of list) {
        if (dismiss && entry.duration) await endSpellEffects(entry.spellUuid);
        const over = !entry.duration || dismiss || !lasting(entry);
        if (over && entry.reduces) regained += 1;
        if (!over || entry.long) kept.push(entry);
    }
    await actor.setFlag(MODULE_ID, "essenceIncantations", kept);
    if (regained) await maintainingBy(actor, -regained);
    if (regained) await say(actor, `<p><strong>Refocus</strong>: ${escapeHTML(actor.name)} regains ${regained} essence draw and pool from incantations${dismiss ? " (dismissed)" : ""}.</p>`);
    return { regained, dismissed: dismiss };
}

/**
 * "All of your essence spells that counteract effects, reduce or remove conditions or afflictions, and so on grant temporary immunity to their target for 1 day after you cast
 * them. This temporary immunity only applies to the same spell cast by you." — a target immune is left out of this cast (`targetMisses`); the others gain the immunity.
 * (Magic Chalice's cast ignores it.)
 */
const REMOVES = /\bcounteract|\b(?:reduce|remove|end|cure|suppress)(?:s|ing)?\b[^.]*\b(?:conditions?|afflictions?|curses?|diseases?|poisons?|clumsy|drained|enfeebled|stupefied|frightened|sickened|blinded|deafened|dazzled|paralyzed|petrified|slowed|stunned|confused|controlled)\b/i;
export const essenceGrantsImmunity = spell => REMOVES.test(plainText(spell?.system?.description?.value));
async function essenceImmunity(actor, spell, message) {
    if (!essenceGrantsImmunity(spell)) return null;
    const key = `essence-immunity:${actor.uuid}:${spell.slug ?? spell.name}`;
    const targets = castTargetActors(message, actor);
    const immune = targets.filter(target => (target.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.spellImmunity?.key === key));
    if (immune.length) {
        for (const target of immune) noticeImmunity({ actor: target, blocked: spell.name, why: `temporarily immune to ${actor.name}'s ${spell.name} (cast within a day)` });
        await message.setFlag(MODULE_ID, "targetMisses", [...new Set([...(message.getFlag(MODULE_ID, "targetMisses") ?? []), ...immune.map(target => target.uuid)])]);
        await say(actor, `<p><strong>${escapeHTML(spell.name)}</strong>: ${escapeHTML(immune.map(target => target.name).join(", "))} ${immune.length === 1 ? "is" : "are"} temporarily immune to it (cast by ${escapeHTML(actor.name)} within a day).</p>`);
    }
    for (const target of targets.filter(target => !immune.includes(target))) await target.createEmbeddedDocuments("Item", [{ name: `${spell.name}: temporary immunity (${actor.name})`, type: "effect", img: "icons/svg/shield.svg",
        flags: { [MODULE_ID]: { spellImmunity: { key } } }, system: { duration: { value: 1, unit: "days", expiry: "turn-start", sustained: false }, start: { value: game.time.worldTime, initiative: null }, rules: [],
            description: { value: `<p>Temporarily immune to ${escapeHTML(actor.name)}'s ${escapeHTML(spell.name)} for 1 day.</p>` } } }]);
    return { immune: immune.map(target => target.name) };
}

/**
 * Terminus of Life's Effect: "if you Cast a Spell that would increase your essence and doesn't heal a creature, you or one of the spell's targets of your choice gains 2 temporary
 * Hit Points per spell rank or 4 temporary Hit Points per spell rank for an essence spell" (3 and 6 at cycle 2, 4 and 8 at cycle 3) — the recipient asked (actor flag
 * `lifeTerminusTarget`: "self" or a uuid).
 */
async function lifeTerminusOnCast(actor, spell, message, pool) {
    const effect = (actor.itemTypes?.effect ?? []).find(entry => entry.name.startsWith("Effect: Terminus of Life") && !/Temp HP/.test(entry.name));
    if (!effect) return null;
    const increases = isDrawCantrip(spell) || (isEssenceSpell(spell) && ["2", "3"].includes(actionsOf(spell)) && pool.value < pool.max);
    if (!increases || (spell.system?.traits?.value ?? []).includes("healing")) return null;
    const cycle = Math.min(3, Math.max(1, Number(effect.system?.badge?.value ?? 1)));
    const rank = Number(message.flags?.pf2e?.casting?.castRank ?? spell.rank ?? 1);
    const amount = rank * (cycle + 1) * (isEssenceSpell(spell) ? 2 : 1);
    const targets = castTargetActors(message, actor).filter(target => target !== actor);
    const preset = actor.getFlag(MODULE_ID, "lifeTerminusTarget");
    const options = [{ value: "self", label: actor.name }, ...targets.map(target => ({ value: target.uuid, label: target.name }))];
    const choice = options.some(option => option.value === preset) ? preset : options.length === 1 ? "self" : await riderChoice({ name: "Terminus of Life", choice: null }, "Who gains the temporary Hit Points?", options);
    const recipient = choice === "self" ? actor : targets.find(target => target.uuid === choice) ?? actor;
    // (Temporary Hit Points with no stated end: they don't stack — the higher kept.)
    const current = Number(recipient.system?.attributes?.hp?.temp ?? 0);
    if (amount > current) await recipient.update({ "system.attributes.hp.temp": amount });
    await say(actor, `<p><strong>Terminus of Life</strong> (cycle ${cycle}): ${escapeHTML(recipient.name)} ${amount > current ? `gains ${amount}` : `keeps ${current}`} temporary Hit Points.</p>`);
    return { recipient: recipient.name, amount };
}

/**
 * Unstable Draw (its card arms it): "you draw up to 1 more than your essence draw from a Draw Cantrip … the exact result depends on a DC 10 flat check. Critical Success … normally.
 * Success …, but … you experience an essence leak the next time you cast an essence spell. Failure The only essence spells you can cast are two-action or three-action essence
 * spells with a rank exactly equal to your current essence …, and when you cast it, you experience an essence leak. Critical Failure As failure, and you are also stupefied 1
 * until you attempt to cast the essence spell and experience the essence leak." With Unstable Aura: "Until you use the unstable essence to cast an essence spell, all ranged
 * attacks against you must succeed at a DC 5 flat check, or they miss" (a reminder Effect; the flat check the table's).
 */
async function unstableOnCast(actor, spell, pool, record) {
    const armed = actor.getFlag(MODULE_ID, "unstableDraw");
    const pending = actor.getFlag(MODULE_ID, "unstableLeak");
    if (armed && isDrawCantrip(spell)) {
        await actor.unsetFlag(MODULE_ID, "unstableDraw");
        const draw = Number(actor.flags?.pf2e?.["essence-draw"] ?? 1);
        const target = Math.min(pool.max, Math.max(pool.value, draw) + 1);
        await waitForPool(actor, pool.value);
        await actor.updateResource("essence-pool", target, { render: true });
        const roll = await new Roll("1d20").evaluate();
        const degree = roll.total >= 20 ? 3 : roll.total >= 10 ? 2 : roll.total <= 1 ? 0 : 1;
        const outcome = ["criticalFailure", "failure", "success", "criticalSuccess"][degree];
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>Unstable Draw</strong>: DC 10 flat check — ${outcome} (essence ${target})` }).catch(() => null);
        if (outcome !== "criticalSuccess") await actor.setFlag(MODULE_ID, "unstableLeak", { outcome, essence: target });
        if (outcome === "criticalFailure") await shapeEffect(actor, actor, "Unstable Draw: stupefied 1", [{ key: "GrantItem", uuid: "Compendium.pf2e.conditionitems.Item.e1XGnhKNSQIm5IXg", onDeleteActions: { grantee: "cascade" }, alterations: [{ mode: "override", property: "badge-value", value: 1 }] }],
            { rounds: 100, flags: { unstableUntilLeak: true } });
        if (hasFeat(actor, "unstable-aura", "Unstable Aura")) await shapeEffect(actor, actor, "Unstable Aura: ranged attacks need a DC 5 flat check", [], { rounds: 100, flags: { unstableUntilLeak: true },
            description: "Until you use the unstable essence to cast an essence spell, all ranged attacks against you must succeed at a DC 5 flat check, or they miss." });
        return { unstable: outcome, essence: target };
    }
    if ((pending || (actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.unstableUntilLeak)) && isEssenceSpell(spell)) {
        await actor.unsetFlag(MODULE_ID, "unstableLeak");
        const ending = (actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.unstableUntilLeak).map(effect => effect.id);
        if (ending.length) await actor.deleteEmbeddedDocuments("Item", ending).catch(() => null);
        if (!pending) return null;
        const rank = Number(spell.rank ?? 1);
        if (pending.outcome !== "success" && (rank !== pending.essence || !["2", "3"].includes(actionsOf(spell))))
            await say(actor, `<p><strong>Unstable Draw</strong> (${escapeHTML(pending.outcome)}): only a 2- or 3-action essence spell of rank ${pending.essence} could be cast (the GM's to undo).</p>`);
        // ("you experience an essence leak": the essence to 0 after the cast, counted.)
        await waitForPool(actor, pool.value);
        await actor.updateResource("essence-pool", 0, { render: true });
        record.leaks += 1;
        await actor.setFlag(MODULE_ID, "essenceEncounter", record);
        await say(actor, `<p><strong>Unstable Draw</strong>: ${escapeHTML(spell.name)} — an essence leak.</p>`);
        return { leak: true, unstable: pending.outcome };
    }
    return null;
}

/** Unstable Draw's card (a free action): armed for the next draw. */
export async function unstableDrawOnCard(message) {
    if (!activeGM() || message?.flags?.pf2e?.origin?.type !== "feat") return null;
    const item = await fromUuid(message.flags.pf2e.origin.uuid ?? "").catch(() => null);
    if (!item?.actor || !essencePool(item.actor) || !/you can choose to make an unstable draw, where you draw up to 1 more than your essence draw/.test(plainText(item.system?.description?.value))) return null;
    await item.actor.setFlag(MODULE_ID, "unstableDraw", { at: Date.now() });
    return { armed: true };
}

/**
 * Essence Summoner: "Your creatures summoned with essence spells gain a +2 status bonus to attack rolls, AC, saving throws, and skill checks if they are from a spell with a rank 2
 * lower than your essence pool value, or a +1 status bonus … if … a rank 1 lower …" — the essence before the cast; the evolving action the table's.
 */
export async function essenceSummoned(caster, summoned, castRank, sourceMessageId) {
    if (!hasFeat(caster, "essence-summoner", "Essence Summoner")) return null;
    const message = sourceMessageId ? game.messages.get(sourceMessageId) : null;
    if (!message || !isEssenceSpell(message.item)) return null;
    const essence = Number(message.getFlag(MODULE_ID, "essenceBefore") ?? NaN);
    const gap = essence - Number(castRank);
    const bonus = gap === 2 ? 2 : gap === 1 ? 1 : 0;
    if (!bonus) return { bonus: 0 };
    await summoned.createEmbeddedDocuments("Item", [{ name: `Essence Summoner: +${bonus}`, type: "effect", img: "icons/svg/upgrade.svg", system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true },
        rules: ["attack-roll", "ac", "saving-throw", "skill-check"].map(selector => ({ key: "FlatModifier", selector, type: "status", value: bonus, label: "Essence Summoner" })) } }]);
    return { bonus };
}
