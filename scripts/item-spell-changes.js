// An item's changes to a spell it casts through castFromItem (2026-10-29, the item module's asks): made to the entry's copy of the spell only,
// never its compendium. Read by the routes that check a spell against PF2e's own (the immediate route's Heal), so the copy is compared with PF2e's
// spell under the same changes. Pure.

import { MODULE_ID } from "./runtime-utils.js";

// The item's changes to the spell it casts (castFromItem's withoutTraits, addTraits, area, damageType): checked, with a key naming them — or null.
// (PF2e's damage types, physical, energy, then the rest.)
const DAMAGE_TYPES = new Set(["bludgeoning", "piercing", "slashing", "bleed", "acid", "cold", "electricity", "fire", "sonic", "force", "vitality", "void", "mental", "poison", "spirit", "untyped"]);
export function itemSpellChanges({ withoutTraits = null, addTraits = null, area = null, damageType = null } = {}) {
    const slugs = list => (Array.isArray(list) ? list : list ? [list] : []).map(entry => String(entry).trim().toLowerCase()).filter(Boolean);
    const out = {};
    if (slugs(withoutTraits).length) out.withoutTraits = slugs(withoutTraits);
    if (slugs(addTraits).length) out.addTraits = slugs(addTraits);
    if (area != null) {
        const value = Number(area.value);
        if (!["burst", "cone", "emanation", "line", "cube", "square", "cylinder"].includes(String(area.type)) || !(value > 0)) throw new Error("castFromItem: area is {type: burst|cone|emanation|line|…, value: feet}.");
        out.area = { type: String(area.type), value };
    }
    if (damageType != null) {
        if (!DAMAGE_TYPES.has(String(damageType))) throw new Error(`castFromItem: damageType ${damageType} isn't a damage type.`);
        out.damageType = String(damageType);
    }
    if (!Object.keys(out).length) return null;
    return { ...out, key: Object.entries(out).map(([name, value]) => `${name}=${typeof value === "object" ? JSON.stringify(value) : value}`).join(";") };
}

// A spell's source with the item's changes: its traits less and more, its area (its variants' overlays too), every damage of it the one type — its
// damage partials, its own and its overlays' inline @Damage rolls —, and that type kept on it for the damage this module builds itself from a
// weapon (Weapon Storm's held weapon: castDamageType). Pure.
export function changedSpellSource(source, changes) {
    const out = globalThis.foundry?.utils?.deepClone ? globalThis.foundry.utils.deepClone(source) : structuredClone(source);
    out.system ??= {};
    const traits = out.system.traits ??= {};
    if (changes.withoutTraits) traits.value = (traits.value ?? []).filter(trait => !changes.withoutTraits.includes(trait));
    if (changes.addTraits) traits.value = [...new Set([...(traits.value ?? []), ...changes.addTraits])];
    const overlays = Object.values(out.system.overlays ?? {});
    if (changes.area) {
        out.system.area = { ...(out.system.area ?? {}), type: changes.area.type, value: changes.area.value };
        for (const overlay of overlays) if (overlay?.system?.area) overlay.system.area = { ...overlay.system.area, type: changes.area.type, value: changes.area.value };
    }
    if (changes.damageType) {
        const type = changes.damageType;
        const retypeDamage = damage => { for (const partial of Object.values(damage ?? {})) if (partial && typeof partial === "object" && "type" in partial && !["healing", "temphp"].includes(partial.type) && !(partial.kinds ?? []).includes?.("healing")) partial.type = type; };
        // (An inline roll's damage types: "@Damage[(2d6+4)[fire]]", "@Damage[2d6[persistent,fire]]" — its category kept.)
        // (Healing isn't damage: Heal's healing rolls keep theirs.)
        const retypeText = text => String(text ?? "").replace(/@Damage\[((?:[^\[\]]|\[[^\[\]]*\])*)\]/g, (all, body) => `@Damage[${body.replace(/\[((?:persistent|precision|splash),)?([a-z]+)\]/g, (whole, category, was) => (["healing", "temphp"].includes(was) ? whole : `[${category ?? ""}${type}]`))}]`);
        retypeDamage(out.system.damage);
        if (out.system.description) out.system.description.value = retypeText(out.system.description.value);
        for (const overlay of overlays) {
            if (overlay?.system?.damage) retypeDamage(overlay.system.damage);
            if (overlay?.system?.description?.value) overlay.system.description.value = retypeText(overlay.system.description.value);
        }
        out.flags ??= {};
        out.flags[MODULE_ID] = { ...(out.flags[MODULE_ID] ?? {}), castDamageType: type };
    }
    // (The changes themselves on the copy: a route that checks a spell against PF2e's own compares it with PF2e's under them — samePF2eSpell.)
    const { key, ...kept } = changes;
    out.flags ??= {};
    out.flags[MODULE_ID] = { ...(out.flags[MODULE_ID] ?? {}), itemCastChanges: kept };
    return out;
}

// A spell's system data as PF2e's own spell would be under the same item changes (its copy's itemCastChanges), or PF2e's own when it has none.
export function expectedSpellSystem(official, item) {
    const changes = item?.flags?.[MODULE_ID]?.itemCastChanges ?? item?.getFlag?.(MODULE_ID, "itemCastChanges") ?? null;
    const source = official?.toObject?.() ?? official;
    return changes ? changedSpellSource(source, changes).system : source?.system;
}
