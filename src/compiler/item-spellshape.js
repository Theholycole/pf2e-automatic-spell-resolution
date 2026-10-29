// Items whose activation is a spellshape (the spell features audit, batch F4, 2026-10-05): grimoires, rings, tattoos, runes, a weapon and a potion
// that change the next spell cast ("Activate … (concentrate, spellshape) … Effect If your next action is to Cast a Spell …"). Read from the item's
// text, each activation into:
//   - requires: the spell it applies to, the forms of the spellshape feats' (src/compiler/spellshape-readers.js unmetRequirement);
//   - riders: the spellshape riders the module already applies, and the items' own (scripts/item-spellshape-runtime.js);
//   - arm: what happens as the item is activated, before the spell (Hundred-Moth Caress's damage to the wielder, Djezet Dose's choice of feat,
//     Star Chart Tattoo's constellation on a creature).
// Any sentence these forms don't read leaves the item unread (null): rules from the text, never from names.
import { readSpellshapeFeat } from "./spellshape-readers.js";
import { readCatalyst } from "./catalysts.js";
import { CONDITION_LINK_HYPHENATED as COND, plain, sentenceSplit as split } from "./text-patterns.js";

const LINK = String.raw`@UUID\[(Compendium\.pf2e\.[a-z-]+\.Item\.[A-Za-z0-9]+)\]\{([^}]+)\}`;
// (Spells an item names by their pre-remaster names, and what PF2e calls them now.)
const REMASTERED = { "Animate Dead": ["Summon Undead"] };
const unlinkAction = text => text.replace(/@UUID\[Compendium\.pf2e\.actionspf2e\.Item\.[A-Za-z0-9]+\]\{([^}]+)\}/g, "$1");
const ORDINAL = String.raw`(\d+)(?:st|nd|rd|th)`;
const cond = (uuid, slug, value = null, extra = {}) => ({ uuid, slug: slug.toLowerCase(), value: value == null ? null : Number(value), ...extra });

/** The spell an item's lead names ("If your next action is to Cast a prepared Spell with the light trait"): requires, or null. */
export function readItemRequirements(text) {
    const requires = {};
    let rest = unlinkAction(text).trim();
    // ("prepared from this grimoire": the spell must be prepared — PF2e's entry says — and from this book, the table's.)
    if (/ prepared from this grimoire\b/.test(rest)) { requires.prepared = true; requires.table = ["prepared from this grimoire"]; rest = rest.replace(/(?: that you)? prepared from this grimoire\b/, ""); }
    // ("a Spell to cast an animate dead spell prepared with tyrant's writs": that spell, prepared from the item.)
    const preparedWith = / prepared with ([a-z' ]+)$/.exec(rest);
    if (preparedWith) { requires.prepared = true; requires.table = [...(requires.table ?? []), `prepared with ${preparedWith[1]}`]; rest = rest.slice(0, preparedWith.index).replace(/^a Spell to cast /, ""); }
    if (/^(?:a |an )?prepared /i.test(rest)) { requires.prepared = true; rest = rest.replace(/^(a |an )?prepared /i, "$1"); }
    const table = text => { requires.table = [...(requires.table ?? []), text]; };
    let m;
    // (A school the remaster has done away with — no spell has its trait now —: the caster's call, as the user ruled for schools on 2026-10-10;
    // In the Shadows of Toil's "necromancy spell that you prepared from this grimoire and that allows a saving throw", its "and" left by the
    // grimoire's words taken out. Illusion is still a trait, so it's read as one below.)
    if ((m = /^(?:a |an )?(abjuration|conjuration|divination|enchantment|evocation|necromancy|transmutation) spell (?:and )?that allows a saving throw$/i.exec(rest))) {
        requires.saves = ["fortitude", "reflex", "will"];
        table(`${/^[aeiou]/i.test(m[1]) ? "an" : "a"} ${m[1].toLowerCase()} spell (its caster's call: the remaster has no schools)`);
        return requires;
    }
    if (/^a Spell that requires a spell attack roll against Armor Class$/.test(rest)) requires.attack = true;
    else if ((m = new RegExp(`^a Spell of ${ORDINAL} level or lower that affects or targets only you$`).exec(rest))) { requires.maxRank = Number(m[1]); table("it affects or targets only you"); }
    else if (/^a Spell with an area of effect that deals the same type of damage as the depicted dragon's breath weapon$/.test(rest)) { requires.area = true; requires.damaging = true; table("it deals the depicted dragon's damage type"); }
    else if (/^a damage-dealing spell$/.test(rest)) requires.damaging = true;
    else if (/^a healing spell that restores Hit Points$/.test(rest)) requires.healing = true;
    // ("a prepared Spell that manipulates blood, such as …, or a spell dealing piercing or slashing damage": either — the blood the table's.)
    else if (/^(?:a )?Spell that manipulates blood, such as [^,]+, or a spell dealing piercing or slashing damage$/.test(rest)) table("it manipulates blood, or deals piercing or slashing damage");
    else if ((m = /^an? ([a-z]+) spell that creates illusory terrain or creatures, such as @UUID\[[^\]]+\]\{[^}]+\}$/.exec(rest))) { requires.anyTraits = [m[1]]; table("it creates illusory terrain or creatures"); }
    else if ((m = /^(?:a |an )?([a-z]+) spell$/.exec(rest)) && m[1] !== "wall") requires.anyTraits = [m[1]];
    else if (/^(?:a |an )?wall spell, such as .+$/.test(rest)) table("a wall spell");
    else if ((m = /^(?:a |an )?Spell with the ([a-z]+) trait$/i.exec(rest))) requires.anyTraits = [m[1]];
    else if ((m = /^(?:a |an )?Spell with the ([a-z]+) or ([a-z]+) trait$/i.exec(rest))) requires.anyTraits = [m[1], m[2]];
    else if ((m = /^a Spell that has the ([a-z]+) trait and that targets 1 creature$/i.exec(rest))) { requires.anyTraits = [m[1]]; requires.singleTarget = true; }
    else if ((m = /^a spell that has the ([a-z]+) trait$/i.exec(rest))) requires.anyTraits = [m[1]];
    else if ((m = new RegExp(`^a ${LINK}, ${LINK}, or ${LINK} spell$`).exec(rest))) requires.spells = [m[2], m[4], m[6]];
    else if (/^a spell your familiar learned from a lesson \(whether a cantrip or from a spell slot\)$/.test(rest)) table("a spell your familiar learned from a lesson");
    // (PF2e's grimoires and instruments, 2026-10-19.)
    else if ((m = /^(?:a |an )?([a-z]+) Spell that allows a saving throw$/i.exec(rest))) { requires.anyTraits = [m[1].toLowerCase()]; requires.saves = ["fortitude", "reflex", "will"]; }
    else if ((m = /^(?:a |an )?spell with the ([a-z]+) trait that requires a saving throw$/i.exec(rest))) { requires.anyTraits = [m[1]]; requires.saves = ["fortitude", "reflex", "will"]; }
    else if ((m = /^(?:a |an )?([a-z]+) spell that targets only that creature$/.exec(rest))) { requires.anyTraits = [m[1]]; requires.singleTarget = true; table("it targets only that creature"); }
    else if ((m = /^(?:a |an )?([a-z]+) spell on a target about whom you've written an entry in the book$/.exec(rest))) { requires.anyTraits = [m[1]]; requires.singleTarget = true; table("its target has an entry in the book"); }
    else if ((m = /^(?:a |an )?([a-z]+) cantrip that has an? (burst|cone|emanation|line)$/.exec(rest))) { requires.anyTraits = [m[1]]; requires.area = true; requires.areaTypes = [m[2]]; table("a cantrip"); }
    else if ((m = new RegExp(`^a Spell of ${ORDINAL} level or lower that has the ([a-z]+) trait or is associated with dreams$`).exec(rest))) { requires.maxRank = Number(m[1]); table(`it has the ${m[2]} trait or is associated with dreams`); }
    else if ((m = /^(?:a |an )?([a-z]+) or ([a-z]+) spell that deals persistent damage$/.exec(rest))) { requires.damaging = true; requires.damageTypesAny = [m[1], m[2]]; table("it deals persistent damage"); }
    else if ((m = new RegExp(`^a ${ORDINAL}-rank ([a-z]+) spell$`).exec(rest))) { requires.rank = Number(m[1]); table(`${/^[aeiou]/.test(m[2]) ? "an" : "a"} ${m[2]} spell`); }
    else if ((m = /^(?:a |an )?Spell (?:that deals|dealing) ([a-z]+) damage$/i.exec(rest))) { requires.damaging = true; requires.damageType = m[1]; }
    // (Tome of Scintillating Sleet's "a cold spell that deals damage", 2026-10-29.)
    else if ((m = /^(?:a |an )?([a-z]+) spell that deals damage$/i.exec(rest))) { requires.anyTraits = [m[1].toLowerCase()]; requires.damaging = true; }
    else if ((m = /^(?:a |an )?Spell that (?:doesn't|does not) have the ([a-z]+) trait$/i.exec(rest))) requires.notTraits = [m[1]];
    else if (/^(?:a |an )?Spell on yourself or a single ally that grants a bonus to AC$/i.test(rest)) { requires.singleTarget = true; table("it's on you or a single ally and grants a bonus to AC"); }
    // (A spell by its name, unlinked: "a revealing light spell", "banishment", "an animate dead spell".)
    else if ((m = /^(?:an? )(?!(?:wall|an?)\b)([a-z][a-z']*(?: [a-z][a-z']*)+) spell$|^(?!an?\b)([a-z][a-z']+)$/.exec(rest))) {
        const name = String(m[1] ?? m[2]).replace(/\b[a-z]/g, letter => letter.toUpperCase());
        // (A pre-remaster name the item still uses: the remastered spell too — "animate dead" is Summon Undead.)
        requires.spells = [name, ...(REMASTERED[name] ?? [])];
    }
    else if (/^(?:a )?Spell$/i.test(rest)) {}
    else return null;
    return requires;
}

/** A listed benefit added to the last summon-benefit rider: [] (claimed), or null when there's none. */
function benefit(context, entry) {
    const rider = context.riders.findLast(candidate => candidate.type === "summon-benefit");
    if (!rider) return null;
    rider.choices.push(entry);
    return [];
}

// The effect's sentences after the lead: [pattern, (match, context) => rider(s) | { requires } | { arm }].
const FORMS = [
    // Shadow Signet.
    [/^choose (Fortitude|Reflex) DC or (Fortitude|Reflex) DC\.$/, m => ({ type: "attack-defense", choice: [m[1].toLowerCase(), m[2].toLowerCase()] })],
    [/^You make your spell attack roll against that defense instead of AC\.$|^If the spell has multiple targets, the choice of DC applies to all of them\.$/, () => []],
    // Reflexive Tattoo, Dragon's Breath, Djezet Dose: a spellshape feat's effects.
    [/^you can hide that you're casting it\.$/, () => []],
    [new RegExp(String.raw`^This has the same effect as the ${LINK} feat\.$`), m => ({ type: "as-feat", feats: [{ uuid: m[1], name: m[2] }] })],
    [new RegExp(String.raw`^the spell gains the effects of the ${LINK} feat\.$`), m => ({ type: "as-feat", feats: [{ uuid: m[1], name: m[2] }] })],
    [new RegExp(String.raw`^you can apply the effects of the ${LINK} or ${LINK} spellshape feats\.$`), m => ({ type: "as-feat", feats: [{ uuid: m[1], name: m[2] }, { uuid: m[3], name: m[4] }], pick: true })],
    [new RegExp(`^The rune can only affect spells of ${ORDINAL} (?:level|rank)(?: or lower)?\\.$`), m => ({ requires: { maxRank: Number(m[1]) } })],
    // Codex of Destruction and Renewal.
    [/^the spell wreaks even greater destruction\.$/, () => []],
    [/^The spell ignores (\d+) resistance and you reroll any damage dice that roll a 1\.$/, m => [{ type: "ignore-resistance", types: null, value: Number(m[1]) }, { type: "reroll-ones" }]],
    [/^If the spell reduces a creature to 0 Hit Points, they're torn apart at an infinitesimal level, not even leaving a fine ash; this is a death effect\.$/, m => ({ type: "note", wandRule: true, text: m[0] })],
    [/^the spell renews the target constantly and perfectly\.$/, () => []],
    [/^The spell grants the target regeneration (\d+), restoring \1 Hit Points at the start of its turn and preventing the target both from dying due to damage and from its dying condition increasing to a value that would result in its death\.$/,
        m => ({ type: "healed-generated", name: `regeneration ${m[1]}`, rules: [{ key: "FastHealing", type: "regeneration", value: Number(m[1]) }], rounds: null })],
    [/^Each time the creature regains Hit Points from regeneration, it regrows all damaged or ruined organs; .*\.$/, () => []],
    [/^The effect lasts for (\d+) rounds\.$/, (m, context) => { const rider = context.riders.findLast(entry => entry.type === "healed-generated"); if (!rider) return null; rider.rounds = Number(m[1]); return []; }],
    // Bloodstained Treatise.
    [/^all targets of the triggering spell take @Damage\[(\d+d\d+)\[persistent,([a-z]+)\](?:\|[^\]]*)?\] damage; if the spell already causes \2 damage, the \2 damage increases by \1\.$/,
        m => ({ type: "persistent", when: "all", formula: m[1], damageType: m[2], raisesOwn: true })],
    [new RegExp(String.raw`^The wounds of one affected target \(chosen by you\) gush uncontrollably, covering the ground with blood in a @Template\[type:emanation\|distance:(\d+)\] that lasts for (\d+) rounds?\.$`),
        m => ({ type: "turn-save-area", center: "chosen-target", radius: Number(m[1]), rounds: Number(m[2]), who: "all", statistic: null, outcomes: {} })],
    [new RegExp(String.raw`^Creatures that begin their turn in the blood must succeed at a (Reflex|Fortitude|Will) save against your spell DC or fall ${COND}\.$`),
        (m, context) => { const rider = context.riders.findLast(entry => entry.type === "turn-save-area"); if (!rider) return null; rider.statistic = m[1].toLowerCase();
            const fall = [cond(m[2], m[3], m[4])]; rider.outcomes = { failure: fall, criticalFailure: fall }; return []; }],
    // Amazing Pop-up Book: the disbelief is the GM's (decisions 2026-10-01), the damage the card's button.
    [/^you draw forth the pop-up scene\.$/, () => []],
    [/^If a creature succeeds, but doesn't critically succeed, at a saving throw to disbelieve the illusion, then .*, dealing (mental) damage equal to the spell's rank\.$/,
        m => ({ type: "damage-card", formula: "rank", damageType: m[1], label: "A creature succeeded (not critically) at disbelieving it: the pop-up's damage" })],
    // Summoning Handscroll.
    [/^you infuse one of the summoned creatures with the spell's energies, causing it to arrive with (\d+) temporary Hit Points that last for up to 1 minute\.$/,
        m => ({ type: "temp-hp-card", amount: Number(m[1]), rounds: 10, label: "one of the summoned creatures" })],
    // Architect's Pattern Book: the room the GM's; PF2e's Effect for the well-rested.
    [/^you add a room to the structure that is up to 10 feet per side per rank of the spell\.$|^This room is outfitted with all the accoutrements for a particular type of recreation, determined by you when you cast the spell\.$/,
        m => ({ type: "note", wandRule: true, text: m[0] })],
    [/^Any character who spends at least 1 hour using this recreational facility and then sleeps a full 8 hours inside the location created by the spell is exceptionally well-rested\.$/, () => []],
    [/^They regain double the amount of Hit Points they would normally receive for an 8-hour rest, and when they make the next day's preparations, they gain a \+1 circumstance bonus to Athletics checks and Will saves for the next 12 hours\.$/,
        () => ({ type: "effect-card", uuid: null, label: "Well-rested (after the hour's recreation and 8 hours' sleep): the targeted characters", doubleRest: true })],
    // Sparking Grimoire: the Strikes' dice on an Effect, the retaliation watched.
    [/^you charge yourself with electrical energy\.$/, () => []],
    [/^Until the end of your next turn, (your|you and your allies') Strikes deal an additional @Damage\[(\d+)d(\d+)\[([a-z]+)\]\] damage, and creatures targeting you with a melee Strike or spell with a range of touch take @Damage\[(\d+d\d+)\[([a-z]+)\]\] damage, with a basic (Reflex|Fortitude|Will) save against your spell DC\.$/,
        m => [{ type: "strike-dice", allies: m[1] !== "your", diceNumber: Number(m[2]), dieSize: `d${m[3]}`, damageType: m[4], until: "caster-next-turn-end" },
            { type: "retaliate", formula: m[5], damageType: m[6], statistic: m[7].toLowerCase(), until: "caster-next-turn-end" }]],
    // Hundred-Moth Caress: the activation's damage to the wielder, then the spell's extra damage.
    [/^You deal @Damage\[(\d+d\d+)\[([a-z]+)\]\] damage to yourself\.$/, m => ({ arm: { type: "self-damage", formula: m[1], damageType: m[2] } })],
    [/^This damage ignores all resistances and immunities, and you take it even if you would be healed by ([a-z]+) effects\.$/, (m, context) => { if (!context.arm) return null; context.arm.ignoreIWR = true; return []; }],
    // Nine Void Sleeves.
    [/^your spell loses the manipulate trait and gains the ([a-z]+) trait, as .*\.$/, m => [{ type: "trait", trait: m[1] }, { type: "table", text: "the spell loses the manipulate trait" }]],
    // Juubun's One Thousand Poems.
    [/^you're overtaken by Juubun's spirit, and the spoken elements of your spell become impressively poetic\.$/, () => []],
    [/^If the target is an ally, your words inspire them and they gain (\d+) temporary Hit Points that last for 1 minute\.$/, m => ({ type: "ally-temp-hp", amount: Number(m[1]), rounds: 10, uuid: null })],
    [new RegExp(String.raw`^If the targeted creature is an enemy and the spell requires a saving throw, and if the enemy fails its saving throw, they become ${COND} as a result of .*\.$`),
        m => ({ type: "conditions", enemiesOnly: true, degrees: { failure: [cond(m[1], m[2], m[3])], criticalFailure: [cond(m[1], m[2], m[3])] } })],
    // Liar's Lexicon.
    [/^your skill at manipulation and exploiting emotion enhance the spell\.$/, () => []],
    [/^The spell gains the ([a-z]+) trait\.$/, m => ({ type: "trait", trait: m[1] })],
    [/^Attempt a Deception check to Lie as you cast the spell against the Perception DC of all those observing you\.$/, () => ({ type: "lie-check" })],
    [/^Those you succeed against think you were merely talking, not casting a spell on a creature\.$/, () => []],
    // Book of Endless Walls: the wall's spaces aren't the module's — a card for the creature that begins its turn in or passes through them.
    [/^you imbue the wall with an uncanny sense of disorientation, causing creatures to perceive it as an endless labyrinth\.$/, () => []],
    [/^Any creature that begins its turn within the wall's spaces or passes through the wall's spaces must attempt a (Will|Reflex|Fortitude) save against your spell DC, in addition to the wall's normal effect\.$/,
        m => ({ type: "save-card", statistic: m[1].toLowerCase(), label: "A creature began its turn in or passed through the wall: the targeted creature saves", outcomes: {}, immuneHours: null })],
    [/^Regardless of the results, the target then becomes immune to ([A-Za-z ]+) for (\d+) hours\.$/, (m, context) => { const rider = context.riders.findLast(entry => entry.type === "save-card"); if (!rider) return null; rider.immuneHours = Number(m[2]); return []; }],
    // Radiant Tome: an emanation around the caster, the enemies' save as their turns start.
    [/^the luminescence of the book grows even more intense, emitting bright light in a @Template\[type:emanation\|distance:(\d+)\] for 1 minute\.$/,
        m => ({ type: "turn-save-area", center: "caster", radius: Number(m[1]), rounds: 10, who: null, statistic: null, outcomes: {}, light: { bright: Number(m[1]) } })],
    [/^(Enemies|Creatures) that start their turn in this bright light must attempt a (Fortitude|Reflex|Will) save against your spell DC\.$/,
        (m, context) => { const rider = context.riders.findLast(entry => entry.type === "turn-save-area"); if (!rider) return null; rider.who = m[1] === "Enemies" ? "enemies" : "all"; rider.statistic = m[2].toLowerCase(); return []; }],
    // PF2e's grimoires and instruments (2026-10-19):
    // Instructions for Lasting Agony (Excruciating Spell), Grudge Journal (Air Grievance).
    [/^you warp and twist the energy of the spell to cause intense pain\.$/, () => []],
    // Tome of Scintillating Sleet (2026-10-29, the item module's ask): Dazzled for the rounds on each creature the spell damages; a critically
    // failed save against it, or a critical spell attack, Blinded for its round and Dazzled the rounds after it instead.
    [new RegExp(String.raw`^all creatures damaged by the spell are also ${COND} for (\d+) rounds? by light refracting and reflecting within and around the spell's chilling effects\.$`),
        m => ({ type: "conditions", when: "damaged", list: [cond(m[1], m[2], m[3], { rounds: Number(m[4]) })] })],
    [new RegExp(String.raw`^If an affected creature critically failed its save against the required spell, or if you critically succeeded on your spell attack roll against the creature, it's instead ${COND} for (\d+) rounds? and then dazzled for (\d+) rounds\.$`),
        (m, context) => { const before = context.riders.findLast(rider => rider.type === "conditions" && rider.when === "damaged" && rider.list?.[0]?.slug === "dazzled"); if (!before) return null;
            const blind = cond(m[1], m[2], m[3], { rounds: Number(m[4]) }), dazzled = { ...before.list[0], rounds: Number(m[4]) + Number(m[5]) };
            // (A save spell's degree is its target's, an attack spell's the caster's: each row only for its kind.)
            return [{ type: "conditions", saveOnly: true, degrees: { criticalFailure: [blind, dazzled] } }, { type: "conditions", attackOnly: true, degrees: { criticalSuccess: [{ ...blind }, { ...dazzled }] } }]; }],
    // In the Shadows of Toil (2026-10-29, the item module's ask): Fatigued for a time on a failed save.
    [/^you infuse the magic with sensations of endless toil\.$/, () => []],
    [new RegExp(String.raw`^If the target fails its saving throw against the spell, it becomes ${COND} for (\d+) minutes? by the sense of exhaustion imbued in the magic\.$`),
        m => ({ type: "conditions", degrees: { failure: [cond(m[1], m[2], m[3], { rounds: Number(m[4]) * 10 })], criticalFailure: [cond(m[1], m[2], m[3], { rounds: Number(m[4]) * 10 })] } })],
    [new RegExp(String.raw`^If the target fails its saving throw against the spell, it becomes ${COND} by the pain\.$`), m => ({ type: "conditions", degrees: { failure: [cond(m[1], m[2], m[3])], criticalFailure: [cond(m[1], m[2], m[3])] } })],
    [/^You inscribe the name or description of a creature you can see that has wronged you in some way\.$/, () => ({ type: "table", text: "the creature you inscribed" })],
    [new RegExp(String.raw`^the creature also becomes ${COND} unless it critically succeeds its saving throw\.$`),
        m => ({ type: "conditions", degrees: { success: [cond(m[1], m[2], m[3])], failure: [cond(m[1], m[2], m[3])], criticalFailure: [cond(m[1], m[2], m[3])] } })],
    // Chapbook of Terrors (Horrify): the persistent damage on each creature the spell frightened.
    [/^creatures (frightened|stupefied|sickened) by the spell also take @Damage\[(\d+d\d+)\[persistent,([a-z]+)\](?:\|[^\]]*)?\] damage as they dwell on your terrifying tale\.$/,
        m => ({ type: "persistent", whenCondition: m[1], degrees: [], formula: m[2], damageType: m[3] })],
    // Book of Lingering Blaze (Overheat Spell), Kindled Tome.
    [/^you superheat the flames, allowing the spell to ignore up to (\d+) resistance to ([a-z]+) of creatures affected by the spell\.$/, m => ({ type: "ignore-resistance", types: [m[2]], value: Number(m[1]) })],
    // Mocker's Swazzle (Mocking Spell), Courtier's Pillow Book, What Doors We Open (Cast Out): a penalty to the target's save against the spell, before it rolls.
    [/^You direct a quick bit of insulting mockery at a creature who can understand you that's within earshot\.$/, () => ({ type: "table", text: "the creature you mocked, who can understand you and is within earshot" })],
    [new RegExp(String.raw`^that creature takes a [–-](\d+) (item|circumstance|status) penalty to any saving throw against the spell and, regardless of the result of the saving throw, becomes ${COND} until the start of your next turn\.$`),
        m => { const off = cond(m[3], m[4], m[5], { until: "caster-turn-start" }); return [{ type: "save-penalty", value: -Number(m[1]), penaltyType: m[2] },
            { type: "conditions", degrees: { criticalSuccess: [off], success: [{ ...off }], failure: [{ ...off }], criticalFailure: [{ ...off }] } }]; }],
    [/^you can state that secret or foible before Casting the Spell to give the target a [–-](\d+) (item|circumstance|status) penalty to their saving throw against the spell\.$/,
        m => ({ type: "save-penalty", value: -Number(m[1]), penaltyType: m[2] })],
    [/^The inscription then disappears from the grimoire\.$/, () => ({ type: "table", text: "the inscription then disappears from the book" })],
    [/^it counts as the extra cost of adding an object that is anathema to the creature and gives the creature a [–-](\d+) (item|circumstance|status) penalty to its save\.$/,
        m => [{ type: "save-penalty", value: -Number(m[1]), penaltyType: m[2] }, { type: "table", text: "it counts as the anathema object of the spell's extra cost" }]],
    [/^If the targeted creature is an? ([a-z]+), increase this to a [–-](\d+) (?:item |circumstance |status )?penalty\.$/,
        (m, context) => { const rider = context.riders.findLast(entry => entry.type === "save-penalty"); if (!rider) return null; rider.vsTraits = { ...(rider.vsTraits ?? {}), [m[1]]: -Number(m[2]) }; return []; }],
    // Hollow Robes (Unseen Magic).
    [/^that spell gains the ([a-z]+) trait\.$/, m => ({ type: "trait", trait: m[1] })],
    // Folding Drums.
    [/^You play a pounding rhythm on the drum\.$/, () => []],
    [/^increase the area of the (burst|cone|emanation|line) by (\d+) feet\.$/, m => ({ type: "area", grow: [{ types: [m[1]], add: Number(m[2]) }] })],
    // Dreamstone.
    [/^the spell slot is not expended\.$/, () => ({ type: "slot-refund" })],
    // Corrosive Engravings: the condition while the spell's persistent damage lasts.
    [new RegExp(String.raw`^any creature who takes persistent damage from the spell is also ${COND} until the persistent damage ends\.$`),
        m => ({ type: "persistent-condition", list: [cond(m[1], m[2], m[3])] })],
    [/^Using an action to retch can reduce the sickened value as normal, but it can't reduce the sickened value below (\d+) until the persistent damage ends\.$/,
        (m, context) => { const rider = context.riders.findLast(entry => entry.type === "persistent-condition"); if (!rider) return null; rider.floor = Number(m[1]); return []; }],
    // Draxie's Recipe Book: a note on each creature the spell reaches unless it critically succeeds.
    [/^all creatures within the spell's area who don't critically succeed at their save are covered with a spicy red powder\.$/,
        () => ({ type: "degree-note", degrees: ["success", "failure", "criticalFailure"], label: "Spicy red powder", text: [] })],
    [/^(Any attempt to grab or grapple a creature affected in this way, or to swallow such a creature whole, gains a \+1 circumstance bonus to the attempt, or a \+2 circumstance bonus if the attempt is made using a jaws or similar mouth-based attack, due to the target's extra deliciousness and savory smell|An affected creature can remove the powder by thoroughly cleaning themselves \(a process that typically takes about 10 minutes\) or by completely immersing themselves in water)\.$/,
        (m, context) => { const rider = context.riders.findLast(entry => entry.type === "degree-note"); if (!rider) return null; rider.text.push(`${m[1]}.`); return []; }],
    [/^This ability can also be used to properly season up to 100 pounds of prepared food within the area of the revealing light spell instantaneously\.$/, m => ({ type: "table", text: m[0] })],
    // Warding Tablets (Purging Spell): the counteract on the target; a failure costs the spell its effects (the GM's).
    [/^you use the tablets' power to infuse the warding with additional magic and attempt to remove a harmful effect\.$/, () => []],
    [/^Attempt to counteract a harmful spell effect of your choice on the target\.$/, () => ({ type: "counteract-effect", traits: [], rankBonus: 0 })],
    [/^This isn't without risks, however\.$/, () => []],
    [/^If your attempt fails to remove the harmful effect, the warding energy is consumed by the unyielding malediction, and you lose the original spell's normal effects\.$/,
        m => ({ type: "note", text: "If the counteract fails, the spell's own effects are lost: remove its Effect from the target." })],
    // Arclord's Codex (Third Eye Rejuvenation): prepared spells already cast today, regained.
    [/^the magical energies reinvigorate your spellcasting\.$/, () => []],
    [new RegExp(`^You regain access to (two|one|\\d+) spells? of ${ORDINAL} rank or lower or (one|two|\\d+) spells? of ${ORDINAL} rank or higher that you've prepared and already cast today\\.$`),
        m => { const count = word => ({ one: 1, two: 2 })[word] ?? Number(word); return { type: "restore-prepared", either: [{ count: count(m[1]), maxRank: Number(m[2]) }, { count: count(m[3]), minRank: Number(m[4]) }] }; }],
    // Tyrant's Writs: one benefit of the list for the summoned undead, the caster's pick.
    [/^you can choose one of the following additional benefits to grant the summoned undead\.$/, () => ({ type: "summon-benefit", choices: [] })],
    [/^(Bloody) The undead gains fast healing equal to its level\.$/, (m, context) => benefit(context, { key: "bloody", label: m[1], text: m[0], rules: [{ key: "FastHealing", value: "level" }] })],
    [/^(Explosive) When it reaches 0 Hit Points, the undead explodes, dealing @Damage\[(\d+d\d+)\[([a-z]+)\]\] damage to adjacent creatures, with a basic (Fortitude|Reflex|Will) save using the [a-z ]+ spell's DC\.$/,
        (m, context) => benefit(context, { key: "explosive", label: m[1], text: m[0].replace(/@Damage\[(\d+d\d+)\[([a-z]+)\]\]/, "$1 $2"), explode: { formula: m[2], damageType: m[3], statistic: m[4].toLowerCase() } })],
    [/^As normal, since the final sacrifice spell doesn't reduce the target to 0 Hit Points, it doesn't cause this explosion\.$/, () => []],
    [/^(Necrotic Speed) The undead gains a \+(\d+)-foot status bonus to all its Speeds\.$/,
        (m, context) => benefit(context, { key: "speed", label: m[1], text: m[0], rules: [{ key: "FlatModifier", selector: "all-speeds", type: "status", value: Number(m[2]) }] })],
    [/^(Rotten) Any living creature who starts its turn adjacent to the undead who isn't at full Hit Points takes @Damage\[(\d+d\d+)\[([a-z]+)\]\] damage\.?$/,
        (m, context) => benefit(context, { key: "rotten", label: m[1], text: m[0].replace(/@Damage\[(\d+d\d+)\[([a-z]+)\]\]/, "$1 $2"), aura: { formula: m[2], damageType: m[3], adjacent: true, livingOnly: true, notFull: true } })],
    // Communion Mat: the familiar's Sustain is the player's.
    [/^your patron notices that you're putting their power to good use and strengthens your familiar with a surge of magic\.$/, () => []],
    [/^Your familiar Sustains one of your spells\.$/, m => ({ type: "note", wandRule: true, text: m[0] })]
];

// The degree entries after an effect: "Critical Success …", "Success …", "Failure …", "Critical Failure …" (for the save card or the area's save).
function readDegree(text, rider) {
    const m = /^(Critical Success|Success|Failure|Critical Failure) (.+)$/.exec(text);
    if (!m) return false;
    const degree = { "Critical Success": "criticalSuccess", Success: "success", Failure: "failure", "Critical Failure": "criticalFailure" }[m[1]];
    const body = m[2].replace(/\.$/, "");
    const list = [];
    let r;
    if (/^The (?:wall|creature) (?:has no additional effect for that creature|is unaffected)$/.test(body)) {}
    else if ((r = /^The creature is unaffected and becomes temporarily immune to this bright light for (\d+) minutes?$/.exec(body))) rider.immuneRounds = Number(r[1]) * 10;
    else if ((r = new RegExp(String.raw`^The creature is bewildered by its perceptions of labyrinthine walls and treats all other creatures as ${COND} for (\d+) rounds?$`).exec(body)))
        list.push({ generated: "treats all other creatures as concealed", rounds: Number(r[4]) });
    else if ((r = /^The creature treats all other creatures as hidden for (\d+) rounds?$/.exec(body))) list.push({ generated: "treats all other creatures as hidden", rounds: Number(r[1]) });
    else if ((r = /^The creature treats all other creatures as hidden for (\d+) rounds? and concealed for (\d+) minutes?$/.exec(body)))
        list.push({ generated: "treats all other creatures as hidden", rounds: Number(r[1]) }, { generated: "treats all other creatures as concealed", rounds: Number(r[2]) * 10 });
    else if ((r = new RegExp(String.raw`^The creature is ${COND} until the start of your next turn$`).exec(body))) list.push(cond(r[1], r[2], r[3], { until: "caster-turn-start" }));
    else if ((r = new RegExp(String.raw`^The creature is blinded until the start of your next turn and ${COND} for (\d+) minutes?$`).exec(body))) {
        const blinded = (rider.outcomes.failure ?? []).find(entry => entry.slug === "blinded");
        if (!blinded) return null;
        list.push({ ...blinded }, cond(r[1], r[2], r[3], { rounds: Number(r[4]) * 10 }));
    } else return null;
    rider.outcomes[degree] = list;
    return true;
}

/** An item's spellshape activations: { name, kind: "item", activations: [{ label, frequency, requires, riders, arm, claimed }] }, or null. */
export function readItemSpellshape(source) {
    // (A catalyst: catalysts.js.)
    return readCatalyst(source) ?? readOfficialItemSpellshape(source) ?? readPlusItemSpellshape(source);
}

/**
 * The "+" modules' items (docs/planning/third-party-features-audit.md): each spellshape activation — "Activate—Veracious Spell f (flourish, manipulate,
 * spellshape) Frequency once per 10 minutes The ring's magic guides your attack. If the next action you use is to Cast a Spell …" — read as the spellshape
 * feats are (spellshape-readers.js). An item whose spellshape activations none of those forms read stays unread.
 */
function readPlusItemSpellshape(source) {
    const text = plain(source?.system?.description?.value ?? "");
    // (A catalyst — Blue Salt Crystal: "Activate Cast a Spell … Adding this catalyst to a casting of Drown transforms the summoned water into deadly brine, causing the target to
    // take [persistent acid] damage for the duration of the spell equal to the rank of the spell." — the rank the text's, not the module's item level.)
    const catalyst = /^Activate Cast a Spell .*?Adding this catalyst to a casting of (?:@UUID\[[^\]]+\]\{)?([A-Z][A-Za-z' ]+?)\}? transforms the summoned water into deadly brine, causing the target to take @Damage\[[^\]]*\[persistent,([a-z]+)\]\] damage for the duration of the spell equal to the rank of the spell\.$/.exec(text);
    if (catalyst) return { name: source.name, kind: "item", activations: [{ label: source.name, frequency: null, requires: { spells: [catalyst[1]] },
        riders: [{ type: "spell-persistent", formula: "rank", damageType: catalyst[2], when: "affected" }], arm: null, claimed: [text] }] };
    const parts = text.split(/(?=\bActivate\b)/).filter(part => part.startsWith("Activate"));
    const activations = [];
    for (const part of parts) {
        const header = /^Activate—(.+?) [0-9AFfR] \(([^)]*)\) /.exec(part);
        if (!header || !header[2].split(/,\s*/).includes("spellshape")) continue;
        // (The next activation's own header ends this one; the item's Craft Requirements too.)
        const body = part.slice(header[0].length).replace(/ Craft Requirements .*$/, "").trim();
        const frequency = /^Frequency (once per [a-z0-9 ]+?)(?= [A-Z])/.exec(body)?.[1] ?? null;
        const read = readSpellshapeFeat({ name: header[1], system: { slug: null, traits: { value: ["spellshape"] }, description: { value: body } } });
        if (!read) return null;
        activations.push({ label: header[1].trim(), frequency, requires: read.requires, riders: read.riders, arm: null, claimed: read.claimed });
    }
    return activations.length ? { name: source.name, kind: "item", activations } : null;
}

function readOfficialItemSpellshape(source) {
    const text = plain(source?.system?.description?.value ?? "");
    // (Each activation from its "Activate"; the potion's "When you drink …, if your next action is to Cast a Spell" its activation's effect.)
    const parts = text.split(/(?=\bActivate\b)/).filter(part => part.startsWith("Activate"));
    if (!parts.length) return null;
    const activations = [];
    for (const part of parts) {
        // ("Activate—Pallid Reaping f (concentrate, …)": the name before the action glyph; the traits the first parentheses before the effect.)
        const name = /^Activate—(.+?) [0-9AFfR] (?:Interact |envision )?\(/.exec(part)?.[1] ?? null;
        const head = part.split(/ (?:Effect|Frequency|Requirements) /)[0];
        const traits = (/\(([^)]*)\)/.exec(head)?.[1] ?? "").split(/,\s*/);
        const body = part;
        const header = [null, name];
        const potion = /(?:^|\. )When you drink an? [^,]+?\s?, if your next action is to Cast a Spell, (.+?)(?= Craft Requirements |$)/.exec(body);
        // (A grimoire's or instrument's activation without the spellshape trait whose effect is the next cast's: Draxie's Recipe Book, Folding Drums.)
        const nextCast = /\bEffect (?:[^.]+\. )?If (?:your next action|the next action you use|the next activity you take this round) is to (?:Cast|cast|target that creature with) /.test(body);
        if (!traits.includes("spellshape") && !potion && !nextCast) continue;
        const frequency = /Frequency (once per [a-z0-9 ]+?)(?= Effect| Requirements)/.exec(body)?.[1] ?? null;
        const precondition = /Requirements (.+?) Effect /.exec(body)?.[1] ?? null;
        // (The item's Craft Requirements after the last activation aren't its effect.)
        let effect = (potion ? `If your next action is to Cast a Spell, ${potion[1]}` : /Effect (.+)$/.exec(body)?.[1])?.replace(/ Craft Requirements .*$/, "").trim();
        if (!effect) return null;
        // (A trailing link to PF2e's Effect — "@UUID[…]{Effect: Juubun's One Thousand Poems}" — is the Effect the text's benefit uses.)
        const effectLink = new RegExp(String.raw`\s*@UUID\[(Compendium\.pf2e\.equipment-effects\.Item\.[A-Za-z0-9]+)\]\{(Effect: [^}]+)\}\s*$`).exec(effect);
        if (effectLink) effect = effect.slice(0, effectLink.index).trim();
        const sentences = split(effect);
        const context = { riders: [], arm: null, requires: null };
        const claimed = [];
        // (Star Chart Tattoo: no next spell — the constellation on a creature, its range a benefit the module doesn't measure.)
        if (/^The dots of the tattoo turn to points of light and fly above the head of a creature within (\d+) feet, where they form a three-star constellation/.test(sentences[0] ?? "")) {
            const within = Number(/within (\d+) feet/.exec(sentences[0])[1]);
            const last = /^Each time you use this benefit, one of the stars above the creature's head winks out; when all three have winked out or after (\d+) minutes? has passed, the effect ends\.$/.exec(sentences.at(-1) ?? "");
            if (!last) return null;
            activations.push({ label: header[1]?.trim() || source.name, frequency, requires: null, riders: [], arm: { type: "mark-creature", within, rounds: Number(last[1]) * 10, uses: 3,
                text: sentences.slice(1, -1).map(sentence => unlinkAction(sentence)) }, claimed: sentences });
            continue;
        }
        let at = 0;
        // (Sentences before the lead: the activation's own effect — Hundred-Moth Caress's damage.)
        const LEAD = /^If (?:your next action|the next action you use|the next activity you take this round) is to (?:Strike with the [a-z ]+ or to )?(?:Cast|cast|target that creature with) (.+?), (.+)$/;
        while (at < sentences.length && !LEAD.test(unlinkAction(sentences[at]))) {
            const read = readSentence(sentences[at], context);
            if (!read) return null;
            claimed.push(sentences[at]);
            at++;
        }
        const lead = LEAD.exec(unlinkAction(sentences[at] ?? ""));
        if (!lead) return null;
        // ("…Cast a Spell with the disease or void trait, that Strike or spell deals additional void damage equal to the damage you took.")
        const strikeToo = /^If your next action is to Strike with the [a-z ]+ or to /.test(unlinkAction(sentences[at]));
        // (The requirement ends at the comma before the effect; a requirement with its own commas — "such as …, or a spell dealing …" — tried longer.)
        let requires = null, rest = null;
        const pieces = `${lead[1]}, ${lead[2]}`.split(", ");
        for (let cut = 1; cut < pieces.length && !requires; cut++) {
            requires = readItemRequirements(pieces.slice(0, cut).join(", "));
            if (requires) rest = pieces.slice(cut).join(", ");
        }
        if (!requires) { unreadSentence = sentences[at]; return null; }
        // ("to target that creature with a prepared spell …": one target, the creature the activation named.)
        if (/^If your next action is to target that creature with /.test(unlinkAction(sentences[at]))) { requires.singleTarget = true; requires.table = [...(requires.table ?? []), "it targets the creature you inscribed"]; }
        context.requires = requires;
        if (strikeToo) {
            const extra = /^that Strike or spell deals additional ([a-z]+) damage equal to the damage you took\.$/.exec(rest);
            if (!extra || context.arm?.type !== "self-damage") return null;
            context.riders.push({ type: "flat-damage", when: "damaged", formula: "armed", damageType: extra[1] }, { type: "table", text: "or the next Strike with the weapon" });
        } else if (!readSentence(`${rest[0].toLowerCase()}${rest.slice(1)}`, context)) return null;
        claimed.push(sentences[at]);
        for (const sentence of sentences.slice(at + 1)) {
            if (!readSentence(sentence, context)) return null;
            claimed.push(sentence);
        }
        if (precondition) requires.table = [...(requires.table ?? []), precondition];
        for (const rider of context.riders) {
            if (["effect-card", "ally-temp-hp"].includes(rider.type)) rider.uuid = effectLink?.[1] ?? null;
            if (rider.type === "effect-card" && !rider.uuid) return null;
            if (["turn-save-area", "save-card"].includes(rider.type) && (!rider.statistic || !Object.keys(rider.outcomes).length && rider.type === "save-card")) return null;
            if (rider.type === "turn-save-area" && !rider.outcomes.failure) return null;
            if (rider.type === "healed-generated" && !rider.rounds) return null;
        }
        activations.push({ label: header[1]?.trim() || source.name, frequency, requires, riders: context.riders, arm: context.arm, claimed });
    }
    return activations.length ? { name: source.name, kind: "item", activations } : null;
}

/** The sentence the last unread item stopped at (for the audit). */
export let unreadSentence = null;

function readSentence(sentence, context) {
    unreadSentence = sentence;
    // (A degree entry for the save last read: "Success The creature is …".)
    const saveRider = context.riders.findLast(entry => ["save-card", "turn-save-area"].includes(entry.type));
    if (saveRider && /^(?:Critical Success|Success|Failure|Critical Failure) /.test(sentence)) {
        // ("Critical Success … Success … Failure … Critical Failure …": PF2e's description runs them together.)
        const entries = sentence.split(/(?<!Critical) (?=(?:Critical Success|Success|Failure|Critical Failure) [A-Z])/);
        return entries.every(entry => readDegree(entry, saveRider) === true);
    }
    for (const [pattern, make] of FORMS) {
        const m = pattern.exec(sentence);
        if (!m) continue;
        const made = make(m, context);
        if (made == null) return false;
        for (const entry of [made].flat()) {
            if (entry.requires) Object.assign(context.requires ?? (context.requires = {}), entry.requires);
            else if (entry.arm) context.arm = entry.arm;
            else context.riders.push(entry);
        }
        return true;
    }
    return false;
}
