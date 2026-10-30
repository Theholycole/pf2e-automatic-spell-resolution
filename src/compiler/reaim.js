// A cast another module's item turns back or redirects (2026-10-29, the item module's ask — its docs/spell-module-requests.md row 17: Cayden's
// Tankard's fear effect, Scale of Igroon's reflected energy). reflect { trait?, kinds?, to: "creator" | "chosen" }, as the item module and
// the ability module read it: a spell of one of the traits, or of one of the kinds ("line", "ray", "attack" — a direct attack, a spell attack
// or a targeted spell's damage, Force Barrage's) dealing energy damage. Pure: the spell's source.

const listOf = value => [value ?? []].flat().filter(entry => typeof entry === "string" && entry);
const ENERGY = ["acid", "cold", "electricity", "fire", "force", "sonic"];

/** The spell's damage types (its damage entries', and its heightened ones'). */
export function damageTypesOf(source) {
    const entries = Object.values(source?.system?.damage ?? {});
    return [...new Set(entries.map(entry => String(entry?.type ?? "")).filter(Boolean))];
}

/** What kind of cast it is: { line, ray, attack } — its area a line, "ray" in its name or text, a spell attack or a targeted spell's damage. */
export function castKindsOf(source) {
    const system = source?.system ?? {};
    const traits = system.traits?.value ?? [];
    const targeted = Boolean(String(system.target?.value ?? "").trim()) && !system.area;
    return {
        line: system.area?.type === "line",
        ray: /\bray\b/i.test(`${source?.name ?? ""} ${String(system.description?.value ?? "").replace(/<[^>]+>/g, " ")}`),
        attack: traits.includes("attack") || (targeted && damageTypesOf(source).length > 0)
    };
}

/** Whether a reflection takes the spell: one of its traits, or one of its kinds with energy damage. */
export function castFits(source, reflect) {
    if (!source || !reflect) return false;
    const traits = listOf(reflect.trait);
    const has = source.system?.traits?.value ?? [];
    if (traits.length && !traits.some(trait => has.includes(trait))) return false;
    const kinds = listOf(reflect.kinds);
    if (!kinds.length) return traits.length > 0;
    const kind = castKindsOf(source);
    return kinds.some(one => kind[one]) && damageTypesOf(source).some(type => ENERGY.includes(type));
}

/** Its range in feet: "120 feet", touch 5; a line's own length when it has none; none (Infinity) when it says nothing. */
export function rangeFeetOf(source) {
    const system = source?.system ?? {};
    const text = String(system.range?.value ?? "");
    const feet = /(\d+)\s*(?:feet|foot|ft\.?)/i.exec(text);
    if (system.area?.type === "line" && Number(system.area.value) > 0) return Number(system.area.value);
    if (feet) return Number(feet[1]);
    if (/^touch$/i.test(text.trim())) return 5;
    return Infinity;
}

/** What's left of its range once it has come as far as the user. */
export const remainingRange = (source, travelled) => Math.max(0, rangeFeetOf(source) - (Number(travelled) || 0));
