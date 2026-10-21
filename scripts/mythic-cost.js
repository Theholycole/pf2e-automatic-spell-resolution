// A spell with the mythic trait costs a Mythic Point to cast ("require the expenditure of a Mythic Point in order to be cast"; the user, 2026-10-19: option A —
// refused before any slot or Focus Point is spent when the caster has none, otherwise 1 spent; the GM can Shift-click past it). Paid with Hero Points
// instead when the item module's world setting "heroPointsForMythic" is on (both modules charge alike). A cast made for an item (castFromItem's
// temporary spell) is the item module's to pay — never charged here.
import { MODULE_ID } from "./runtime-utils.js";

const ITEM_MODULE = "pf2e-automatic-item-resolution";
const escapeHTML = value => foundry.utils.escapeHTML?.(String(value ?? "")) ?? String(value ?? "");

/** Which resource pays mythic costs: "heroPoints" when the item module's setting says so (and it's active), else "mythicPoints". */
export function mythicResource() {
    const key = `${ITEM_MODULE}.heroPointsForMythic`;
    try { if (game.modules.get(ITEM_MODULE)?.active && game.settings.settings.has(key) && game.settings.get(ITEM_MODULE, "heroPointsForMythic") === true) return "heroPoints"; } catch (_) {}
    return "mythicPoints";
}
const LABELS = { mythicPoints: ["Mythic Point", "Mythic Points"], heroPoints: ["Hero Point", "Hero Points"] };

/** Whether a cast must pay: the spell has the mythic trait and isn't an item's cast. */
export function mythicCastDue(spell) {
    const traits = spell?.system?.traits?.value ?? [];
    return traits.includes("mythic") && !spell?.flags?.[MODULE_ID]?.castFromItemTemp;
}

/** Before PF2e's cast: {resource} to spend after it, or null (nothing due, or the GM's Shift-click past it); throws when the caster has none. */
export function mythicCastCheck(actor, spell, { bypass = false } = {}) {
    if (!actor || !mythicCastDue(spell)) return null;
    if (bypass) return null;
    const resource = mythicResource();
    const value = Number(actor.system?.resources?.[resource]?.value ?? 0);
    if (!(value >= 1)) throw Error(`${actor.name} has no ${LABELS[resource][0]} to spend: ${spell.name} has the mythic trait and can't be cast. No resource was spent.`);
    return { resource };
}

/** After PF2e's cast: 1 point spent, a chat line. */
export async function spendMythicCast(actor, spell, { resource }) {
    const value = Number(actor.system?.resources?.[resource]?.value ?? 0);
    if (!(value >= 1)) return null;
    await actor.update({ [`system.resources.${resource}.value`]: value - 1 });
    const left = value - 1;
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${escapeHTML(actor.name)} spends 1 ${LABELS[resource][0]} to cast <strong>${escapeHTML(spell.name)}</strong> (${left} left).</p>` }); } catch (_) {}
    return left;
}
