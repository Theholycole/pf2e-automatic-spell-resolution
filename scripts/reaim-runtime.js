// A cast another module's item turns back or redirects (src/compiler/reaim.js; 2026-10-29, the item module's Cayden's Tankard and Scale of
// Igroon): api.casting.reaimable finds the latest cast at the item's user that fits — not lost, not turned already, by another creature, its
// targets the user's (castTargets), or an area spell with none recorded —, and api.casting.reaim plays it:
//   - to "creator": the cast counteracted for all its targets (lost) and cast again at its caster alone, "as if it alone were the original
//     target";
//   - to "chosen": cast again at the creatures the user's player picks within what's left of its range (its caster's distance to the user
//     taken off), the user out of it; the cast's own other targets as they were.
// Either way at its caster's rank and DC, through castFromItem from its caster (its numbers its own).
import { castFits, remainingRange } from "../src/compiler/reaim.js";
import { castSpellForItem } from "./item-cast-runtime.js";
import { loseSpell } from "./casting-rules-runtime.js";
import { tokenDistance } from "./token-distance.js";
import { MODULE_ID, castRankOf, isCastMessage } from "./runtime-utils.js";

const tokenOf = token => token?.object ?? token ?? null;

/** Whether the cast's targets take in the user: its recorded targets, or an area spell's when none were recorded. */
function targetsUser(message, user) {
    const recorded = message.getFlag(MODULE_ID, "castTargets") ?? message.getFlag(MODULE_ID, "castFromItem")?.targets ?? null;
    const actorUuid = user.actor?.uuid, tokenUuid = user.document?.uuid ?? user.uuid;
    if (recorded?.length) return recorded.some(uuid => uuid === actorUuid || uuid === tokenUuid || fromUuidSync(uuid)?.actor?.uuid === actorUuid);
    return Boolean(message.item?.system?.area);
}

/** The latest cast that fits, among the last messages → the message, or null. */
export function reaimableCast({ reflect, userToken, messages = game.messages.contents } = {}) {
    const user = tokenOf(userToken);
    if (!reflect || !user?.actor) return null;
    return messages.slice(-40).reverse().find(message => isCastMessage(message) && message.item && message.actor && message.actor !== user.actor
        && !message.getFlag(MODULE_ID, "spellLost") && !message.getFlag(MODULE_ID, "reaimed") && castFits(message.item.toObject(), reflect) && targetsUser(message, user)) ?? null;
}

/** The cast turned back or redirected → { from, spell, card, at, beyond } or null when none fits. */
export async function reaimCast({ reflect, userToken, targets = [], item = {} } = {}) {
    const user = tokenOf(userToken);
    const message = reaimableCast({ reflect, userToken });
    if (!message) return null;
    const caster = message.actor, spell = message.item;
    const casterToken = tokenOf(message.token) ?? caster.getActiveTokens?.(true)?.[0] ?? null;
    const rank = castRankOf(message);
    const dc = Number(message.getFlag(MODULE_ID, "castFromItem")?.dc ?? spell.spellcasting?.statistic?.dc?.value) || null;
    const source = spell.toObject();
    const name = item.name ?? "the item";
    let at = [], beyond = [];
    if (reflect.to === "creator") {
        if (casterToken) at = [casterToken];
        await loseSpell(message, `counteracted for all its targets by ${user.name}'s ${name}`);
    } else {
        const chosen = (targets ?? []).map(tokenOf).filter(token => token?.actor && token.actor !== user.actor);
        if (!chosen.length) throw new Error(`${name}: target the creatures to turn it at.`);
        const remaining = remainingRange(source, casterToken && canvas?.ready ? tokenDistance(casterToken, user) : 0);
        at = chosen.filter(token => !Number.isFinite(remaining) || !canvas?.ready || tokenDistance(user, token) <= remaining);
        beyond = chosen.filter(token => !at.includes(token));
    }
    await message.setFlag(MODULE_ID, "reaimed", { by: name, to: reflect.to });
    const cast = at.length ? await castSpellForItem({ actor: caster, token: casterToken, spell: source, rank, dc, targets: at, item: { name: `${spell.name} (${reflect.to === "creator" ? "turned back" : "reflected"} by ${name})`, uuid: `reaim.${message.id}`, img: spell.img } }) : null;
    return { from: message.id, spell: spell.name, card: cast?.message?.id ?? null, at: at.map(token => token.name), beyond: beyond.map(token => token.name) };
}
