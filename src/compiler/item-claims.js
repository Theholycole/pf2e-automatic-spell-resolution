// The items this module acts on, for other modules to leave alone (the item module, 2026-10-15): the spell-carrying kinds PF2e casts from — scrolls,
// wands, staves — and spellhearts and catalysts by trait or category, and any item one of this module's item readers reads (its casts, the wands that
// change their spell, the catalysts and item spellshapes, the "+" items' text rules, focus, counteract, ammunition, runes and essence activations).
// Pure: no Foundry needed, so an offline census can call it too.
import { readWand } from "./spellshape-readers.js";
import { readItemSpellshape } from "./item-spellshape.js";
import { readItemCasts } from "./item-casts.js";
import { readTextRules, readPassiveCastRider, readFocusRegain, readCastReaction, readActionCast } from "./plus-feature-rules.js";
import { readEssenceActivation } from "../../scripts/essence-runtime.js";
import { readEnergyRune } from "../../scripts/spellshape-runtime.js";
import { readBackfireAmmo } from "../../scripts/plus-ammo-runtime.js";
import { readFocusFeature } from "../../scripts/plus-focus-runtime.js";
import { readCounteractFeature } from "../../scripts/plus-counteract-runtime.js";
import { readCastAfter } from "../../scripts/plus-cast-riders-runtime.js";

// (The Spell Reservoir rune — its storing, Channeled Release and Safe Release this module's own, scripts/item-cast-runtime.js — 2026-10-29, the
// item module's ask: by its slug.)
const readReservoirRune = source => (source?.system?.slug === "spell-reservoir" ? { kind: "spell-reservoir" } : null);
const ITEM_TYPES = new Set(["consumable", "equipment", "weapon", "armor", "shield", "treasure", "backpack", "kit", "ammo"]);
const KINDS = ["scroll", "wand", "staff", "spellheart", "catalyst"];
const READERS = [["wand", readWand], ["item-spellshape", readItemSpellshape], ["item-casts", readItemCasts], ["text-rules", readTextRules], ["passive-cast", readPassiveCastRider],
    ["focus-regain", readFocusRegain], ["cast-reaction", readCastReaction], ["action-cast", readActionCast], ["essence-activation", readEssenceActivation], ["energy-rune", readEnergyRune],
    ["backfire-ammo", readBackfireAmmo], ["focus-feature", readFocusFeature], ["counteract-feature", readCounteractFeature], ["cast-after", readCastAfter], ["spell-reservoir", readReservoirRune]];

/** Why this module acts on an item (its source): the kinds and readers that claim it, or [] — never for feats, actions or spells (they aren't items). */
export function itemClaims(source) {
    if (!source || !ITEM_TYPES.has(source.type)) return [];
    const traits = new Set(source.system?.traits?.value ?? []);
    const category = String(source.system?.category ?? "");
    const reasons = KINDS.filter(kind => traits.has(kind) || category === kind);
    for (const [name, reader] of READERS) {
        let read = null;
        try { read = reader(source); } catch (_) { read = null; }
        if (read) reasons.push(name);
    }
    return reasons;
}

/** Whether this module acts on the item. */
export function claims(source) { return itemClaims(source).length > 0; }
