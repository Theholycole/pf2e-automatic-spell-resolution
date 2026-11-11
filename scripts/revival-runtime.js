// Spells bringing creatures back (revival-cards.js):
//   - Raise Dead's return: the GM's answer on the soul, then 1 Hit Point, alive, and the week's debilitation (PF2e's conditions, granted by an Effect so
//     they can't be removed or reduced);
//   - Revival: one healing roll; the living heal, the dead (not undead) come back with that many temporary Hit Points and none else, can't regain Hit
//     Points or temporary Hit Points otherwise (`noHealing`), and die when the spell ends (`revivalRaised`);
//   - Shock to the System: a corpse back to life (0 Hit Points, Dying gone, Wounded +1, its initiative just before the caster's), the healing and the
//     waking, the supercharge (Quickened, the innate spell at the caster's DC) and the cloud (Hidden inside) until the end of its next turn;
//   - Moment of Renewal: Effects that would end within 24 hours end (not the spells' running ones); a full day's rest's Hit Points (Constitution
//     modifier × twice the level) and conditions (Fatigued gone, Drained and Doomed down by 1, Wounded gone at full Hit Points); immunity for a day.
import { applyDamageWithReceipt } from "./native-damage-receipt.js";
import { ONGOING_FLAG } from "./ongoing-core.js";
import { DamageRollClass, MODULE_ID, escapeHTML, post as say } from "./runtime-utils.js";

import { noticeImmunity } from "./immunity-notice.js";
const isDead = actor => actor.statuses?.has?.("dead") || Number(actor.hitPoints?.value ?? 1) <= 0;
const isUndead = actor => { const traits = actor.traits ?? new Set(actor.system?.traits?.value ?? []); return traits.has?.("undead") ?? traits.includes?.("undead"); };
const recordOf = (ongoing, castId) => { const journal = castId ? ongoing.find(castId) : null; const record = journal?.getFlag(MODULE_ID, ONGOING_FLAG); return record?.status === "active" ? { journal, record } : null; };
const timed = (value, unit) => ({ duration: { value, unit, expiry: unit === "rounds" ? "turn-start" : null, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null } });
const grants = conditions => conditions.map(entry => ({ key: "GrantItem", uuid: entry.uuid, onDeleteActions: { grantee: "restrict" }, ...(entry.value ? { alterations: [{ mode: "override", property: "badge-value", value: entry.value }] } : {}) }));

/** Wounded set to a value (PF2e raises it itself when Dying is removed). */
async function setWounded(actor, value) {
    let now = Number(actor.getCondition?.("wounded")?.value ?? 0);
    // (PF2e adds the value to an existing condition.)
    if (now < value) await actor.increaseCondition("wounded", { value: value - now });
    while (now > value) { await actor.decreaseCondition("wounded"); const next = Number(actor.getCondition?.("wounded")?.value ?? 0); if (next >= now) break; now = next; }
}

/** Back to life: no Dead status, no Dying or Unconscious, the stated Hit Points, Wounded as it was (plus the spell's own increase). */
async function backToLife(actor, hp, { temp = null, wounded = 0 } = {}) {
    const woundedBefore = Number(actor.getCondition?.("wounded")?.value ?? 0);
    if (actor.statuses?.has?.("dead")) await actor.toggleStatusEffect("dead", { active: false });
    for (const slug of ["dying", "unconscious"]) if (actor.hasCondition?.(slug)) await actor.decreaseCondition(slug, { forceRemove: true });
    await setWounded(actor, woundedBefore + wounded);
    await actor.update({ "system.attributes.hp.value": hp, ...(temp != null ? { "system.attributes.hp.temp": temp } : {}) }, { [MODULE_ID]: { revival: true } });
}

async function debilitate(actor, spellName, debilitation, img) {
    const [effect] = await actor.createEmbeddedDocuments("Item", [{ name: `${spellName}: debilitated`, type: "effect", img: img ?? "icons/svg/skull.svg",
        system: { ...timed(debilitation.days, "days"), tokenIcon: { show: true }, rules: grants(debilitation.conditions),
            description: { value: `<p>Debilitated by the time in the Boneyard: these conditions can't be removed or reduced until the week has passed.</p>` } } }]);
    return effect;
}

export async function raisePart({ caster, spell, data, phase, token, options }) {
    const actor = token.actor, rank = Number(data.castRank);
    if (!isDead(actor)) throw new Error(`${data.spellName}: ${token.name} isn't dead.`);
    const max = Object.entries(phase.levels).filter(([at]) => rank >= Number(at)).sort(([a], [b]) => Number(a) - Number(b)).at(-1)?.[1];
    if (Number(actor.level ?? 0) > Number(max)) throw new Error(`${data.spellName}: ${token.name} is above level ${max} at rank ${rank}.`);
    const returns = options.returns ?? await foundry.applications.api.DialogV2.confirm({ window: { title: data.spellName }, content: `<p>${escapeHTML(phase.question)}</p>`, rejectClose: false });
    if (!returns) { await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong> fails for ${escapeHTML(token.name)}; the cost isn't consumed.</p>`); return { returned: false }; }
    // (The debilitation first: PF2e takes Hit Points as Drained is gained — the creature then has its 1 Hit Point.)
    const effect = await debilitate(actor, data.spellName, phase.debilitation, spell.img);
    await backToLife(actor, phase.hp);
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(token.name)} returns to life with ${phase.hp} Hit Point${phase.hp === 1 ? "" : "s"}, debilitated for a week.</p>`);
    return { returned: true, effectUuid: effect?.uuid ?? null };
}

export async function revivePart({ ongoing, caster, spell, data, phase, tokens, options }) {
    const found = recordOf(ongoing, data.lastingCastId);
    if (!found) throw new Error(`${data.spellName}: the spell has ended.`);
    const roll = await new (DamageRollClass())(`(${phase.formula})[healing]`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(data.spellName)}</strong>: the burst of healing` }).catch(() => null);
    const out = { total: roll.total, healed: [], raised: [], skipped: [] };
    for (const token of tokens) {
        const actor = token.actor;
        if (isUndead(actor)) { out.skipped.push(token.name); continue; }
        if (!isDead(actor)) {
            await applyDamageWithReceipt(actor, { damage: -roll.total, token: token.document ?? token, item: spell, rollOptions: new Set(), skipIWR: false }, foundry.utils.randomID());
            out.healed.push(token.name); continue;
        }
        const returns = options.returns ?? await foundry.applications.api.DialogV2.confirm({ window: { title: `${data.spellName}: ${token.name}` }, content: `<p>${escapeHTML(phase.question)}</p>`, rejectClose: false });
        if (!returns) { out.skipped.push(token.name); continue; }
        const weak = await debilitate(actor, data.spellName, phase.debilitation, spell.img);
        await backToLife(actor, 0, { temp: roll.total });
        const [raised] = await actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: raised for the spell`, type: "effect", img: spell.img ?? "icons/svg/angel.svg",
            flags: { [MODULE_ID]: { revivalRaised: { castId: data.lastingCastId, spell: data.spellName }, noHealing: { spell: data.spellName } } },
            system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, tokenIcon: { show: true },
                description: { value: `<p>Alive with ${roll.total} temporary Hit Points and no others; it can't regain Hit Points or gain temporary Hit Points in other ways. When the spell ends, it loses them and dies.</p>` } } }]);
        await ongoing.attach(found.journal, raised); await ongoing.attach(found.journal, weak);
        out.raised.push(token.name);
    }
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${out.healed.length ? `${escapeHTML(out.healed.join(", "))} regain ${roll.total} Hit Points. ` : ""}${out.raised.length ? `${escapeHTML(out.raised.join(", "))} return with ${roll.total} temporary Hit Points while the spell lasts.` : ""}</p>`);
    return out;
}

/** A raised creature's Effect ended (the spell's end): it loses its temporary Hit Points and dies. */
export async function revivalEnded(item) {
    const data = item?.flags?.[MODULE_ID]?.revivalRaised;
    const actor = item?.actor;
    if (!data || !actor || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) return null;
    await actor.update({ "system.attributes.hp.temp": 0, "system.attributes.hp.value": 0 }, { [MODULE_ID]: { revival: true } });
    if (!actor.statuses?.has?.("dead")) await actor.toggleStatusEffect("dead", { active: true });
    await say(actor, `<p><strong>${escapeHTML(data.spell)}</strong> ends: ${escapeHTML(actor.name)} loses its temporary Hit Points and dies.</p>`);
    return { died: actor.uuid };
}

/** "can't regain Hit Points or gain temporary Hit Points in other ways": an update raising either is held (the spell's own updates pass). */
export function holdNoHealing(actor, changes, options) {
    if (options?.[MODULE_ID]?.revival) return false;
    const holder = (actor.itemTypes?.effect ?? []).find(effect => effect.flags?.[MODULE_ID]?.noHealing);
    if (!holder) return false;
    let held = false;
    for (const key of ["system.attributes.hp.value", "system.attributes.hp.temp"]) {
        const flat = key in changes, after = flat ? changes[key] : foundry.utils.getProperty(changes, key);
        const before = Number(foundry.utils.getProperty(actor._source, key));
        if (typeof after !== "number" || !Number.isFinite(before) || after <= before) continue;
        if (flat) changes[key] = before; else foundry.utils.setProperty(changes, key, before);
        held = true;
    }
    if (held && Number(options?.damageTaken) < 0) options.damageTaken = 0;
    return held;
}

export async function shockPart({ ongoing, caster, spell, data, phase, token, options }) {
    const found = recordOf(ongoing, data.lastingCastId);
    if (!found) throw new Error(`${data.spellName}: the spell has ended.`);
    const actor = token.actor, rank = Number(data.castRank), doc = token.document ?? token;
    const out = { revived: false };
    if (isDead(actor)) {
        const recent = options.recent ?? await foundry.applications.api.DialogV2.confirm({ window: { title: data.spellName }, content: `<p>${escapeHTML(phase.question)}</p>`, rejectClose: false });
        if (!recent) throw new Error(`${data.spellName}: only a corpse that died within the last round comes back.`);
        await backToLife(actor, 0, { wounded: phase.wounded });
        // ("The creature's initiative is right before yours.")
        const combat = game.combat, mine = combat?.combatants.find(entry => entry.actor === caster);
        if (combat && mine?.initiative != null) {
            const theirs = combat.combatants.find(entry => entry.actor === actor || entry.tokenId === doc.id);
            if (theirs) await theirs.update({ initiative: mine.initiative + 0.5 });
            else await combat.createEmbeddedDocuments("Combatant", [{ tokenId: doc.id, sceneId: doc.parent.id, actorId: actor.id, initiative: mine.initiative + 0.5 }]);
        }
        out.revived = true;
    }
    const roll = await new (DamageRollClass())(`(${phase.formula})[healing]`, { item: { rank, level: rank } }).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: `<strong>${escapeHTML(data.spellName)}</strong>: the jolt` }).catch(() => null);
    await applyDamageWithReceipt(actor, { damage: -roll.total, token: doc, item: spell, rollOptions: new Set(), skipIWR: false }, foundry.utils.randomID());
    if (actor.hasCondition?.("unconscious")) await actor.decreaseCondition("unconscious", { forceRemove: true });
    if (actor.hasCondition?.("dying")) await actor.decreaseCondition("dying", { forceRemove: true });
    out.healed = roll.total;
    // (The supercharge: Quickened for the spell's time, and the innate spell at the caster's DC and rank.)
    const [charge] = await actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: supercharged`, type: "effect", img: spell.img ?? "icons/svg/lightning.svg",
        system: { ...timed(phase.seconds / 60, "minutes"), tokenIcon: { show: true }, rules: grants([{ uuid: phase.quickened.uuid }]),
            description: { value: `<p>Quickened: the extra action can be used only to ${escapeHTML(phase.quickened.actions)} (Fly only with a fly Speed). It can cast ${escapeHTML(phase.innate.name)} as an innate spell at will.</p>` } } }]);
    const innateRank = phase.innate.rank + phase.innate.step * (rank - phase.innate.baseRank);
    const statistic = spell.spellcasting?.statistic;
    const [entry] = await actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: innate`, type: "spellcastingEntry",
        system: { tradition: { value: spell.spellcasting?.tradition ?? "primal" }, prepared: { value: "innate" }, spelldc: { dc: Number(statistic?.dc?.value ?? 10), value: Number(statistic?.check?.mod ?? 0) } } }]);
    const innate = (await fromUuid(phase.innate.uuid))?.toObject();
    if (!innate) throw new Error(`${data.spellName}: ${phase.innate.name} is unavailable.`);
    delete innate._id;
    innate.system.location = { value: entry.id, heightenedLevel: innateRank };
    const [copy] = await actor.createEmbeddedDocuments("Item", [innate]);
    for (const made of [charge, copy, entry]) await ongoing.attach(found.journal, made);
    // (The cloud in its space until the end of its next turn: a creature inside is Hidden.)
    const size = canvas.grid.size;
    const [region] = await canvas.scene.createEmbeddedDocuments("Region", [{ name: `${data.spellName}: the cloud`, color: "#aabbff",
        shapes: [{ type: "rectangle", x: doc.x, y: doc.y, width: (Number(doc.width) || 1) * size, height: (Number(doc.height) || 1) * size, rotation: 0, hole: false }] }]);
    const cloud = await ongoing.startRegionArea({ spellName: data.spellName, sourceActorUuid: caster.uuid, sourceItemUuid: spell.uuid, castRank: rank, region, durationSeconds: 12, seedMembers: true,
        notes: ["Anything outside the cloud is hidden to a creature inside it (the GM's)."], endsAtTurnEndOf: actor.uuid,
        memberEffect: { all: true, generated: { name: "in the cloud", text: "Hidden while inside the cloud.", rules: grants([{ uuid: phase.cloud.uuid }]) } } });
    out.cloud = cloud.castId; out.innateRank = innateRank; out.copyUuid = copy.uuid;
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${escapeHTML(token.name)}${out.revived ? " comes back to life and" : ""} regains ${roll.total} Hit Points; supercharged for ${phase.seconds / 60} minute (${escapeHTML(phase.innate.name)} at rank ${innateRank}).</p>`);
    return out;
}

export async function renewalPart({ caster, spell, data, phase, tokens }) {
    if (tokens.length > phase.count) throw new Error(`${data.spellName}: at most ${phase.count} creatures.`);
    const key = spell.slug ?? spell.name;
    const out = [];
    for (const token of tokens) {
        const actor = token.actor;
        if ((actor.itemTypes?.effect ?? []).some(effect => effect.flags?.[MODULE_ID]?.renewalImmune?.key === key && !effect.isExpired)) { out.push({ name: token.name, immune: true }); noticeImmunity({ actor, token, blocked: data.spellName, why: "temporarily immune" }); continue; }
        // ("detrimental effects that would be gone after 24 hours": Effects running out within the day that grant conditions or penalties — not a
        // running spell's, which keep their time.)
        const ongoingUuids = new Set(game.journal.contents.flatMap(journal => { const record = journal.getFlag(MODULE_ID, ONGOING_FLAG); return record?.status === "active" ? (record.entries ?? []).map(entry => entry.uuid) : []; }));
        const ended = (actor.itemTypes?.effect ?? []).filter(effect => {
            const remaining = effect.remainingDuration?.remaining;
            const within = Number.isFinite(remaining) && remaining <= phase.hours * 3600 && effect.system.duration?.unit !== "unlimited";
            const harmful = (effect.system.rules ?? []).some(rule => (rule.key === "GrantItem" && /conditionitems/.test(rule.uuid ?? "")) || (rule.key === "FlatModifier" && Number(rule.value) < 0));
            const spellRunning = ongoingUuids.has(effect.uuid) || effect.system.duration?.sustained === true;
            return within && harmful && !spellRunning;
        });
        if (ended.length) await actor.deleteEmbeddedDocuments("Item", ended.map(effect => effect.id), { [MODULE_ID]: { reason: "moment-of-renewal" } });
        // (A full day's rest: Constitution modifier, at least 1, times twice the level.)
        const con = Math.max(1, Number(actor.system?.abilities?.con?.mod ?? 0)), amount = con * 2 * Math.max(1, Number(actor.level ?? 1));
        await applyDamageWithReceipt(actor, { damage: -amount, token: token.document ?? token, item: spell, rollOptions: new Set(), skipIWR: true }, foundry.utils.randomID());
        if (actor.hasCondition?.("fatigued")) await actor.decreaseCondition("fatigued", { forceRemove: true });
        for (const slug of ["drained", "doomed"]) if (actor.hasCondition?.(slug)) await actor.decreaseCondition(slug);
        if (actor.hasCondition?.("wounded") && Number(actor.hitPoints?.value) >= Number(actor.hitPoints?.max)) await actor.decreaseCondition("wounded", { forceRemove: true });
        await actor.createEmbeddedDocuments("Item", [{ name: `${data.spellName}: immune`, type: "effect", img: "icons/svg/aura.svg", flags: { [MODULE_ID]: { renewalImmune: { key } } },
            system: { ...timed(phase.immuneDays, "days"), tokenIcon: { show: true }, description: { value: `<p>Temporarily immune to ${escapeHTML(data.spellName)} for ${phase.immuneDays} day.</p>` } } }]);
        out.push({ name: token.name, ended: ended.map(effect => effect.name), healed: amount });
    }
    await say(caster, `<p><strong>${escapeHTML(data.spellName)}</strong>: ${out.map(entry => entry.immune ? `${escapeHTML(entry.name)} is immune` : `${escapeHTML(entry.name)} regains ${entry.healed} Hit Points${entry.ended.length ? ` (${entry.ended.length} Effect${entry.ended.length === 1 ? "" : "s"} ended)` : ""}`).join("; ")}.</p>`);
    return { results: out };
}
