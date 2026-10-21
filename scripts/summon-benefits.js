// Tyrant's Writs (2026-10-19): "If your next action is to Cast a Spell to cast an animate dead spell prepared with tyrant's writs, you can choose one of the following
// additional benefits to grant the summoned undead." — the caster's pick, on the summoned creature:
//   - Bloody: fast healing equal to its level; Necrotic Speed: +10-foot status bonus to its Speeds (rule Effects);
//   - Explosive: "When it reaches 0 Hit Points, the undead explodes, dealing 4d6 fire damage to adjacent creatures, with a basic Reflex save using the animate dead
//     spell's DC." — each adjacent creature rolls its save, the damage by its degree (the active GM, once);
//   - Rotten: "Any living creature who starts its turn adjacent to the undead who isn't at full Hit Points takes 1d6 poison damage" (the active GM, as the turn starts).
import { MODULE_ID, activeGM as leadGM } from "./runtime-utils.js";
import { tokenDistance } from "./token-distance.js";
import { applyDamageWithReceipt } from "./native-damage-receipt.js";

const escapeHTML = value => foundry.utils.escapeHTML?.(String(value ?? "")) ?? String(value ?? "");
const FLAG = "summonBenefit";
const MULTIPLIER = { criticalSuccess: 0, success: 0.5, failure: 1, criticalFailure: 2 };
const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];
const living = actor => !["undead", "construct"].some(trait => actor?.traits?.has?.(trait) ?? (actor?.system?.traits?.value ?? []).includes(trait));

/** The chosen benefit on the summoned creature: an Effect (its rules, or the watched explosion or aura). */
export async function grantSummonBenefit(shape, rider, summoned, { dc = null, casterUuid = null, choose }) {
    const choices = rider.choices ?? [];
    const key = choices.some(choice => choice.key === shape.choice) ? shape.choice
        : await choose(shape, "Which benefit for the undead?", choices.map(choice => ({ value: choice.key, label: `${choice.label}: ${choice.text.replace(/^[A-Z][a-z]+(?: [A-Z][a-z]+)? /, "")}` })));
    const picked = choices.find(choice => choice.key === key);
    if (!picked) return [{ label: `${shape.name}: no benefit chosen`, status: "skipped" }];
    const rules = (picked.rules ?? []).map(rule => rule.value === "level" ? { ...rule, value: Number(summoned.level ?? 1) } : { ...rule });
    const watch = picked.explode ? { kind: "explosive", ...picked.explode, dc: Number(dc), casterUuid, exploded: false }
        : picked.aura ? { kind: "rotten", ...picked.aura } : null;
    if (watch?.kind === "explosive" && !Number.isFinite(watch.dc)) return [{ label: `${shape.name}: ${picked.label} needs the animate dead spell's DC`, status: "failed" }];
    const [made] = await summoned.createEmbeddedDocuments("Item", [{ name: `${shape.name}: ${picked.label}`, type: "effect", img: "icons/svg/skull.svg",
        flags: { [MODULE_ID]: { spellshapeRider: { label: shape.name }, ...(watch ? { [FLAG]: watch } : {}) } },
        system: { duration: { value: -1, unit: "unlimited", expiry: null, sustained: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true },
            description: { value: `<p>${escapeHTML(picked.text)}</p>` }, rules } }]);
    return [{ label: `${shape.name}: ${summoned.name} — ${picked.label}`, status: "applied", effectUuid: made?.uuid ?? null }];
}

/** updateActor: an Explosive undead brought to 0 Hit Points — each adjacent creature's basic save, the damage rolled once (the active GM, once). */
export async function explodeAtZero(actor) {
    if (!leadGM() || Number(actor?.system?.attributes?.hp?.value ?? 1) > 0) return null;
    const effect = (actor?.itemTypes?.effect ?? []).find(entry => entry.flags?.[MODULE_ID]?.[FLAG]?.kind === "explosive" && !entry.flags[MODULE_ID][FLAG].exploded);
    const token = actor?.getActiveTokens?.(true, true)?.[0];
    if (!effect || !token) return null;
    const data = effect.flags[MODULE_ID][FLAG];
    await effect.setFlag(MODULE_ID, `${FLAG}.exploded`, true);
    const DamageRoll = CONFIG.Dice.rolls.find(cls => cls.name === "DamageRoll");
    const roll = await new DamageRoll(`${data.formula}[${data.damageType}]`).evaluate();
    const adjacent = token.parent.tokens.filter(other => other.id !== token.id && other.actor && tokenDistance(token, other) <= 5);
    const lines = [];
    for (const other of adjacent) {
        const save = await other.actor.saves?.[data.statistic]?.roll({ dc: { value: data.dc }, skipDialog: true });
        const degree = DEGREES[Number(save?.degreeOfSuccess ?? 1)] ?? "failure";
        const multiplier = MULTIPLIER[degree];
        if (!(multiplier > 0)) { lines.push(`${other.name}: ${degree.replace(/([A-Z])/g, " $1").toLowerCase()}, no damage`); continue; }
        const damage = multiplier === 1 ? roll : roll.alter(multiplier, 0);
        const receipt = await applyDamageWithReceipt(other.actor, { damage, token: other.object ?? other, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
        lines.push(`${other.name}: ${degree.replace(/([A-Z])/g, " $1").toLowerCase()}, ${receipt?.damage ?? damage.total} ${data.damageType}`);
    }
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${escapeHTML(effect.name)}</strong>: ${escapeHTML(actor.name)} explodes (${roll.total} ${escapeHTML(data.damageType)}, basic ${escapeHTML(data.statistic)} DC ${escapeHTML(data.dc)}).</p>${lines.length ? `<ul>${lines.map(line => `<li>${escapeHTML(line)}</li>`).join("")}</ul>` : "<p>No creature is adjacent.</p>"}` }); } catch (_) {}
    return { total: roll.total, hit: lines.length };
}

/** updateCombat: a living creature not at full Hit Points starting its turn adjacent to a Rotten undead takes its damage (the active GM). */
export async function rottenTurnStart(combat) {
    if (!leadGM() || !combat?.started) return null;
    const current = combat.combatant?.token, actor = current?.actor;
    if (!current || !actor || !living(actor)) return null;
    const hp = actor.system?.attributes?.hp;
    if (!hp || Number(hp.value) >= Number(hp.max)) return null;
    const done = [];
    for (const other of current.parent.tokens.filter(token => token.id !== current.id && token.actor && tokenDistance(current, token) <= 5)) {
        for (const effect of (other.actor.itemTypes?.effect ?? []).filter(entry => entry.flags?.[MODULE_ID]?.[FLAG]?.kind === "rotten")) {
            const data = effect.flags[MODULE_ID][FLAG];
            // (Once for this creature's turn.)
            const key = `${combat.id}:${combat.round}:${combat.turn}:${actor.uuid}`;
            if (effect.getFlag(MODULE_ID, `${FLAG}.lastTurn`) === key) continue;
            await effect.setFlag(MODULE_ID, `${FLAG}.lastTurn`, key);
            const DamageRoll = CONFIG.Dice.rolls.find(cls => cls.name === "DamageRoll");
            const roll = await new DamageRoll(`${data.formula}[${data.damageType}]`).evaluate();
            const receipt = await applyDamageWithReceipt(actor, { damage: roll, token: current.object ?? current, skipIWR: false, rollOptions: new Set() }, foundry.utils.randomID());
            done.push(receipt?.damage ?? roll.total);
            try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: other.actor }), content: `<p><strong>${escapeHTML(effect.name)}</strong>: ${escapeHTML(actor.name)} starts its turn beside ${escapeHTML(other.name)} and takes ${escapeHTML(receipt?.damage ?? roll.total)} ${escapeHTML(data.damageType)} damage.</p>` }); } catch (_) {}
        }
    }
    return done;
}
