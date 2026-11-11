// Creature abilities that act on spells (the spell features audit, batch G3, 2026-10-06), read from each creature's own copy of the ability on the scene
// (its numbers are the creature's), as each spell is cast:
//   - aura counteracts: "When a creature in the aura uses a vitality spell or ability, the graveknight automatically attempts to counteract it, with a
//     counteract modifier of +22" — rolled; counteract rank half the creature's level, rounded up;
//   - counteract reactions: "Trigger A spell or ability with the electricity trait is used within 30 feet of the shock zombie … counteract the spell or
//     ability (counteract rank 3, counteract modifier +17)" — a card for the GM;
//   - "Trigger A creature within 30 feet uses magic to summon or conjure a creature … a counteract check with a Hell Lore check (counteract rank equal to
//     half the dragon's level, rounded up)" — a card;
//   - aura saves on the caster: "When a creature in the aura uses a spell or ability with the healing trait, it must succeed at a Will save against the
//     path maiden's spell DC – 3. On a failure, the amount of Hit Points restored … is halved" — rolled; the healing halved once (main.js);
//   - "A creature who casts a spell within 30 feet of the mutant must succeed at a Will save or spend its next action to Stride toward the mutant" —
//     rolled; a note Effect on a failure;
//   - "immune to spells cast from a magic item without expending a spell slot, such as from a scroll or wand" — the creature left out of such a spell
//     (`targetMisses`), while its toggle is on.
// Spells delivered by a creature's Strike (Channel Magic) are spell-actions-runtime.js's; Metamagic Alteration is read with Draw From the Pages.
import { counters, loseSpell } from "./casting-rules-runtime.js";
import { castTargetActors } from "./spellshape-runtime.js";
import { tokenDistance } from "./token-distance.js";
import { DEGREES, MODULE_ID, activeGM, castRankOf, escapeHTML, gmIds, isCastMessage, degreeOf } from "./runtime-utils.js";

import { noticeImmunity } from "./immunity-notice.js";
const plain = html => String(html ?? "").replace(/\[\[\/r [^\]]+\]\]\{([^}]+)\}/g, "$1").replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, "$1").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** A creature ability's rule on spells, from its text: { type, ... } or null. */
export function readCreatureSpellAbility(source) {
    const text = plain(source?.system?.description?.value);
    const aura = (source?.system?.rules ?? []).find(rule => rule.key === "Aura");
    const radius = Number(aura?.radius ?? /^(\d+) feet\./.exec(text)?.[1] ?? NaN);
    let m;
    if ((m = /When a creature in the aura uses an? ([a-z]+) spell or ability, the [a-z' -]+ automatically attempts to counteract it, with (?:a counteract modifier of \+(\d+)|an? \+(\d+) counteract modifier)/.exec(text)) && Number.isFinite(radius))
        return { type: "aura-counteract", trait: m[1], modifier: Number(m[2] ?? m[3]), radius };
    if ((m = /Trigger A spell or ability with the ([a-z]+) trait is used within (\d+) feet of the [a-z' -]+ Effect The [a-z' -]+ attempts to counteract the spell or ability \(counteract rank (\d+), counteract modifier \+(\d+)\)/.exec(text)))
        return { type: "reaction-counteract", trait: m[1], within: Number(m[2]), rank: Number(m[3]), modifier: Number(m[4]) };
    if ((m = /Trigger A creature within (\d+) feet uses magic to summon or conjure a creature Effect The [a-z' -]+ attempts a counteract check with an? ([A-Za-z ]+?) Lore check \(counteract rank equal to half the [a-z' -]+'s level, rounded up\)/.exec(text)))
        return { type: "summon-counteract", within: Number(m[1]), lore: `${m[2].toLowerCase().replace(/ /g, "-")}-lore`, loreName: `${m[2]} Lore`, text };
    if ((m = /When a creature in the aura uses a spell or ability with the ([a-z]+) trait, it must succeed at a (Will|Fortitude|Reflex) save against the [a-z' -]+'s spell DC(?: [–-] ?(\d+))?\. On a failure, the amount of Hit Points restored by the spell or ability is halved\.(?: On a critical failure, (.+?)\.)?/.exec(text)) && Number.isFinite(radius))
        return { type: "aura-halve-healing", trait: m[1], statistic: m[2].toLowerCase(), less: Number(m[3] ?? 0), criticalFailure: m[4] ?? null, radius };
    if ((m = /A creature who casts a spell within (\d+) feet of the [a-z' -]+ must succeed at a @Check\[(will|fortitude|reflex)\|dc:(\d*)[^\]]*\] save or (spend its next action to Stride toward the [a-z' -]+)\./.exec(text)))
        return { type: "cast-compulsion", within: Number(m[1]), statistic: m[2], dc: m[3] ? Number(m[3]) : null, compulsion: m[4] };
    if (/is immune to spells cast from a magic item without expending a spell slot, such as from a scroll or wand/.test(text))
        return { type: "item-spell-immunity", toggle: (source?.system?.rules ?? []).find(rule => rule.key === "RollOption" && rule.toggleable)?.option ?? null };
    return null;
}

/** The creatures on the scene with such abilities: [{ actor, token, ability, rule }]. */
function sceneAbilities() {
    const found = [];
    for (const token of canvas.scene?.tokens ?? []) for (const item of token.actor?.items ?? []) {
        if (!["action", "melee"].includes(item.type)) continue;
        const rule = readCreatureSpellAbility(item.toObject());
        if (rule) found.push({ actor: token.actor, token, ability: item, rule });
    }
    return found;
}

async function counteract(actor, cast, { name, modifier, rank }) {
    const dc = Number(cast.item?.spellcasting?.statistic?.dc?.value ?? cast.actor?.attributes?.spellDC?.value ?? NaN);
    if (!Number.isFinite(dc)) return { skipped: "no DC" };
    const roll = await new Roll(`1d20 + ${modifier}`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(name)}</strong>: counteract ${escapeHTML(cast.item?.name ?? "the spell")} (DC ${dc}, rank ${rank} against ${castRankOf(cast)})` }).catch(() => null);
    const degree = degreeOf(roll.total, dc, roll.dice[0]?.results?.[0]?.result ?? null);
    const countered = counters(degree, rank, castRankOf(cast));
    if (countered) await loseSpell(cast, `counteracted by ${actor.name}'s ${name}`);
    return { degree: DEGREES[degree], countered, total: roll.total, dc };
}

/** A spell cast: the scene's creatures' abilities on it. */
export async function creatureAbilitiesOnCast(message) {
    if (!activeGM() || !isCastMessage(message)) return [];
    const caster = message.actor, spell = message.item;
    const casterToken = caster?.getActiveTokens?.(true, true)?.[0] ?? null;
    if (!caster || !spell) return [];
    const traits = spell.system?.traits?.value ?? [];
    const done = [];
    for (const { actor, token, ability, rule } of sceneAbilities()) {
        if (actor === caster) continue;
        const near = feet => casterToken && tokenDistance(token, casterToken) <= feet;
        if (rule.type === "aura-counteract" && traits.includes(rule.trait) && near(rule.radius)) {
            done.push({ [ability.name]: await counteract(actor, message, { name: ability.name, modifier: rule.modifier, rank: Math.ceil(Number(actor.level ?? 1) / 2) }) });
            if (message.getFlag(MODULE_ID, "spellLost")) break;
        } else if (rule.type === "reaction-counteract" && traits.includes(rule.trait) && near(rule.within)) {
            await reactionCard(actor, message, ability, `Counteract (rank ${rule.rank}, +${rule.modifier})`, { modifier: rule.modifier, rank: rule.rank });
            done.push({ [ability.name]: "card" });
        } else if (rule.type === "summon-counteract" && traits.includes("summon") && near(rule.within)) {
            const modifier = Number(actor.skills?.[rule.lore]?.mod ?? Object.values(actor.skills ?? {}).find(skill => skill.label === rule.loreName)?.mod ?? NaN);
            if (Number.isFinite(modifier)) {
                await reactionCard(actor, message, ability, `Counteract with ${rule.loreName} (rank ${Math.ceil(Number(actor.level ?? 1) / 2)}, +${modifier})`,
                    { modifier, rank: Math.ceil(Number(actor.level ?? 1) / 2), note: `On a success ${actor.name} seizes the effect: it casts summon fiend of rank ${Math.max(5, castRankOf(message))} to summon a creature with the devil trait.` });
                done.push({ [ability.name]: "card" });
            }
        } else if (rule.type === "aura-halve-healing" && traits.includes(rule.trait) && near(rule.radius)) {
            const dc = Number(actor.attributes?.spellDC?.value ?? actor.spellcasting?.contents?.[0]?.statistic?.dc?.value ?? NaN) - rule.less;
            if (!Number.isFinite(dc)) continue;
            const roll = await caster.saves?.[rule.statistic]?.roll({ dc: { value: dc }, skipDialog: true, label: `${ability.name}: ${spell.name}` });
            const degree = DEGREES[Number(roll?.degreeOfSuccess ?? 2)];
            if (degree === "failure" || degree === "criticalFailure") {
                // (The spell's targets — or the caster — regain half: the module's half-healing Effect, used once.)
                for (const target of new Set([...castTargetActors(message, caster)])) await target.createEmbeddedDocuments("Item", [{ name: `${ability.name}: half healing from ${spell.name}`, type: "effect", img: "icons/svg/degen.svg",
                    flags: { [MODULE_ID]: { halfHealing: { once: true, castId: message.id } } },
                    system: { duration: { value: 1, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true } } }]);
                if (degree === "criticalFailure" && rule.criticalFailure) try { await ChatMessage.create({ whisper: gmIds(), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(ability.name)}</strong> (GM): ${escapeHTML(caster.name)} critically failed — ${escapeHTML(rule.criticalFailure)}.</p>` }); } catch (_) {}
            }
            done.push({ [ability.name]: degree });
        } else if (rule.type === "cast-compulsion" && near(rule.within)) {
            const dc = rule.dc ?? Number(actor.attributes?.spellDC?.value ?? actor.system?.attributes?.classDC?.value ?? NaN);
            if (!Number.isFinite(dc)) continue;
            const roll = await caster.saves?.[rule.statistic]?.roll({ dc: { value: dc }, skipDialog: true, label: `${ability.name}: ${spell.name}` });
            const degree = DEGREES[Number(roll?.degreeOfSuccess ?? 2)];
            if (degree === "failure" || degree === "criticalFailure") await caster.createEmbeddedDocuments("Item", [{ name: `${ability.name}: Stride toward ${actor.name}`, type: "effect", img: "icons/svg/daze.svg",
                flags: { [MODULE_ID]: { creatureCompulsion: { actorUuid: actor.uuid } } },
                system: { duration: { value: 1, unit: "rounds", expiry: "turn-end", sustained: false }, start: { value: game.time.worldTime, initiative: null }, tokenIcon: { show: true },
                    description: { value: `<p>${escapeHTML(caster.name)} must ${escapeHTML(rule.compulsion)}. It can't Delay or take any reactions until it has obeyed the compulsion.</p>` } } }]);
            done.push({ [ability.name]: degree });
        } else if (rule.type === "item-spell-immunity") {
            // (A spell from a scroll, wand or staff — PF2e's cast from a consumable's embedded spell, or a staff's charges.)
            const fromItem = Boolean(message.flags?.pf2e?.casting?.embeddedSpell);
            const on = !rule.toggle || actor.rollOptions?.all?.[rule.toggle] !== false;
            if (!fromItem || !on || !castTargetActors(message, caster).includes(actor)) continue;
            const misses = [...new Set([...(message.getFlag(MODULE_ID, "targetMisses") ?? []), actor.uuid])];
            await message.setFlag(MODULE_ID, "targetMisses", misses);
            try { await ChatMessage.create({ speaker: message.speaker, content: `<p><strong>${escapeHTML(spell.name)}</strong> doesn't affect ${escapeHTML(actor.name)} (${escapeHTML(ability.name)}: immune to spells from a magic item).</p>` }); } catch (_) {}
            noticeImmunity({ actor, blocked: spell.name, why: `${ability.name}: immune to spells from a magic item` });
            done.push({ [ability.name]: "immune" });
        }
    }
    return done;
}

async function reactionCard(actor, cast, ability, label, data) {
    try { await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: gmIds(),
        flags: { [MODULE_ID]: { kind: "creature-spell-ability", creatureAbility: { ...data, name: ability.name, actorUuid: actor.uuid, castId: cast.id } } },
        content: `<section class="pf2e-auto-runtime-card"><p><strong>${escapeHTML(ability.name)}</strong> (reaction, GM): ${escapeHTML(actor.name)} against ${escapeHTML(cast.actor?.name ?? "a caster")}'s ${escapeHTML(cast.item?.name ?? "spell")} (rank ${castRankOf(cast)}).</p><button type="button" data-pf2e-auto-creature-ability="counteract">${escapeHTML(label)}</button></section>` }); } catch (_) {}
}

export async function runCreatureAbility(message) {
    const data = message.flags?.[MODULE_ID]?.creatureAbility;
    const cast = game.messages.get(data?.castId ?? "");
    const actor = data ? await fromUuid(data.actorUuid).catch(() => null) : null;
    if (!cast || !actor) throw new Error("The spell or the creature is gone.");
    if (message.getFlag(MODULE_ID, "creatureAbilityUsed")) throw new Error(`${data.name} has already been used.`);
    if (cast.getFlag(MODULE_ID, "spellLost")) throw new Error("That spell is already lost.");
    await message.setFlag(MODULE_ID, "creatureAbilityUsed", true);
    const result = await counteract(actor, cast, data);
    if (result.countered && data.note) try { await ChatMessage.create({ whisper: gmIds(), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(data.name)}</strong> (GM): ${escapeHTML(data.note)}</p>` }); } catch (_) {}
    return result;
}

export function bindCreatureAbilityButtons(message, html) {
    const root = html instanceof HTMLElement ? html : html?.[0];
    for (const button of root?.querySelectorAll?.("[data-pf2e-auto-creature-ability]") ?? []) button.addEventListener("click", async () => {
        try { await runCreatureAbility(message); } catch (error) { ui.notifications.error(error.message); }
    });
}
