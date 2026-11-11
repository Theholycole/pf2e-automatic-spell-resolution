import { MODULE_ID } from "./effect-runtime.js";
import { escapeHTML, randomID } from "./runtime-utils.js";
import { ESSENCE_SCHOOLS, essenceShellSpellSource } from "../src/compiler/essence-shell.js";

import { noticeImmunity } from "./immunity-notice.js";
// Essence Eating Shell (Magus+), run by the module: after a Spellstrike of a magus who has the feat (its attack roll not a critical failure), a card asks whether the
// shell was an essence eating one and the shell spell's school — the caster's pick (the user, 2026-10-10: the remaster has no schools). Its control starts the
// school's effect (src/compiler/essence-shell.js) on the Spellstrike's initial target and on the magus, each on the module's save card at the caster's spell DC; the
// magus's save takes +3 status if the Spellstrike succeeded and is one degree better on a critical success. The parts the save card doesn't apply follow its
// result (saveApplied): a note Effect, a weakness for the Spellstrike's damage, the speed penalty while sickened.

const gmIds = () => game.users.filter(user => user.isGM).map(user => user.id);
const ownerIds = actor => game.users.filter(user => !user.isGM && actor?.testUserPermission?.(user, "OWNER")).map(user => user.id);
const title = school => `${school[0].toUpperCase()}${school.slice(1)}`;
const BETTER = { criticalFailure: "failure", failure: "success", success: "criticalSuccess", criticalSuccess: "criticalSuccess" };

/** A Spellstrike's after-feature: the card, when the magus has the feat and the attack wasn't a critical failure. */
export async function offerEssenceShell({ caster, cast, strike, degree }) {
    if (degree === "criticalFailure") return null;
    const feat = (caster?.itemTypes?.feat ?? []).find(item => item.slug === "essence-eating-shell" || item.name === "Essence Eating Shell");
    if (!feat) return null;
    const target = strike?.flags?.pf2e?.context?.target ?? null;
    const rank = Number(cast?.flags?.pf2e?.casting?.castRank ?? cast?.item?.rank ?? 1);
    const vitality = (cast?.item?.system?.traits?.value ?? []).includes("vitality");
    const message = await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), whisper: [...new Set([...gmIds(), ...ownerIds(caster)])],
        flags: { [MODULE_ID]: { kind: "essence-shell", essenceShell: { casterUuid: caster.uuid, targetTokenUuid: target?.token ?? null, targetActorUuid: target?.actor ?? null,
            degree, rank, vitality, spell: cast?.item?.name ?? null, done: false } } },
        content: `<h3>${escapeHTML(feat.name)}</h3><p>If ${escapeHTML(caster.name)}'s Spellstrike used an essence eating shell, pick the shell spell's school: its effect lands on the target and on ${escapeHTML(caster.name)} (+3 status to the magus's save on a hit, and a degree better on a critical hit). Resolve it before the Spellstrike's damage.</p>`
            + `<button type="button" class="pf2e-auto-card-action" data-action="essence-shell"><i class="fa-solid fa-egg"></i> Pick the school and resolve</button>` }).catch(() => null);
    return message ? { label: `${feat.name}: offered`, status: "note", messageId: message.id } : null;
}

/** The magus's spell DC (the shell's spell's casting statistic, else PF2e's spell DC). */
function spellDC(caster) {
    const dc = [caster?.getStatistic?.("spell-dc")?.dc?.value, ...(caster?.spellcasting?.contents ?? []).map(entry => entry.statistic?.dc?.value), caster?.system?.attributes?.spellDC?.value]
        .map(Number).find(value => Number.isFinite(value) && value > 0);
    if (!dc) throw new Error(`${caster?.name}: no spell DC.`);
    return dc;
}

/** The card's control: the school (asked unless given), then the target's and the magus's save cards. */
export async function resolveEssenceShell(message, { school = null } = {}) {
    const data = message?.getFlag?.(MODULE_ID, "essenceShell");
    if (!data) throw new Error("This card has no essence eating shell.");
    if (data.done) throw new Error("The essence eating shell's effect was already resolved.");
    const picked = school ?? await foundry.applications.api.DialogV2.wait({ window: { title: "Essence Eating Shell — the shell spell's school" },
        content: `<p>The school of the spell in the shell${data.spell ? ` (${escapeHTML(data.spell)})` : ""}:</p>`,
        buttons: ESSENCE_SCHOOLS.map(entry => ({ action: entry, label: title(entry) })), close: () => null, rejectClose: false });
    if (!ESSENCE_SCHOOLS.includes(picked)) return { status: "cancelled" };
    const caster = await fromUuid(data.casterUuid);
    const casterToken = caster?.getActiveTokens?.(true, true)?.[0];
    const targetToken = data.targetTokenUuid ? await fromUuid(data.targetTokenUuid).catch(() => null) : null;
    if (!caster || !casterToken) throw new Error("Essence Eating Shell: the magus needs a token on the scene.");
    if (!targetToken?.actor) throw new Error("Essence Eating Shell: the Spellstrike's target isn't on the scene.");
    const stance = (caster.itemTypes?.effect ?? []).find(effect => /^Stance: (?:Arcane|Havok) Cascade/.test(effect.name));
    const cascadeType = caster.flags?.pf2e?.arcaneCascade?.damageType || stance?.flags?.pf2e?.rulesSelections?.stanceArcaneCascade || "force";
    const api = game.modules.get(MODULE_ID).api;
    const dc = spellDC(caster);
    const sides = [{ token: targetToken, magus: false }, { token: casterToken.document ?? casterToken, magus: true }];
    const built = essenceShellSpellSource(picked, { rank: data.rank, cascadeType, vitality: data.vitality });
    await message.setFlag(MODULE_ID, "essenceShell", { ...data, done: true, school: picked });
    // (Necromancy: "If any creature would not be affected by the type of damage dealt by this effect, this effect does not occur for any creature".)
    if (built.effect.fizzleType && sides.some(side => (side.token.actor.attributes?.immunities ?? []).some(entry => entry.type === built.effect.fizzleType))) {
        for (const side of sides.filter(one => (one.token.actor.attributes?.immunities ?? []).some(entry => entry.type === built.effect.fizzleType)))
            noticeImmunity({ actor: side.token.actor, token: side.token, blocked: `Essence Eating Shell (${title(picked)})`, why: `immune to ${built.effect.fizzleType}; the effect fizzles for both creatures` });
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), content: `<p><strong>Essence Eating Shell (${title(picked)})</strong>: a creature isn't affected by ${built.effect.fizzleType} damage, so the effect fizzles for both (the Spellstrike still applies).</p>` }).catch(() => null);
        return { status: "fizzled", school: picked };
    }
    const cards = [];
    for (const side of sides) {
        // (Transmutation on a creature immune to sickened: its basic Fortitude damage instead, and the Speed penalty for a round after a failure.)
        const immune = picked === "transmutation" && (side.token.actor.attributes?.immunities ?? []).some(entry => entry.type === "sickened");
        if (immune) noticeImmunity({ actor: side.token.actor, token: side.token, blocked: "sickened", why: "immune to sickened; its basic Fortitude damage instead", source: "Essence Eating Shell (Transmutation)" });
        const { effect, source } = immune ? essenceShellSpellSource("transmutation-immune", { rank: data.rank }) ?? built : built;
        const item = new CONFIG.Item.documentClass({ ...source, _id: randomID() }, { parent: caster });
        const plan = await api.compile(item);
        if (!api.saves.supports(plan)) throw new Error(`${source.name}: its save isn't one the module resolves.`);
        const hit = data.degree === "success" || data.degree === "criticalSuccess";
        const { card } = await api.saves.start(item, { plan, sourceActor: caster, targets: [side.token], castRank: data.rank, dc, skipConfirmation: true,
            ...(side.magus && hit ? { saveModifier: { value: 3, type: "status", label: "Essence Eating Shell (Spellstrike hit)" } } : {}),
            ...(side.magus && data.degree === "criticalSuccess" ? { degreeAdjustment: { predicate: { kind: "everyone" }, map: { ...BETTER } } } : {}) });
        if (card) await card.setFlag(MODULE_ID, "essenceShellNote", { school: picked, immune, note: effect.note ?? null, sickenedSpeed: effect.sickenedSpeed ?? null, casterUuid: caster.uuid });
        cards.push({ magus: side.magus, cardId: card?.id ?? null });
    }
    return { status: "started", school: picked, cards };
}

/** After an essence card's saves are applied: each creature's note, the weakness for the Spellstrike's damage, or the speed penalty while sickened, by its degree. */
export async function essenceShellAfterSave(card, state) {
    const data = card?.getFlag?.(MODULE_ID, "essenceShellNote");
    if (!data) return [];
    const done = [];
    for (const target of state?.targets ?? []) {
        const actor = target.actorUuid ? await fromUuid(target.actorUuid).catch(() => null) : null;
        if (!actor || !target.degree) continue;
        const failed = target.degree === "failure" || target.degree === "criticalFailure";
        const base = { type: "effect", img: card.flags?.[MODULE_ID]?.img ?? "icons/magic/symbols/runes-star-pentagon-blue.webp",
            system: { start: { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }, tokenIcon: { show: true }, traits: { value: [] } } };
        const name = `Essence Eating Shell (${title(data.school)})`;
        if (data.sickenedSpeed && (failed || data.immune) && (actor.hasCondition?.("sickened") || data.immune && failed)) {
            const [made] = await actor.createEmbeddedDocuments("Item", [{ ...base, name: `${name}: −10 feet to Speeds while sickened`,
                flags: { [MODULE_ID]: { essenceShellSpeed: { whileSickened: !data.immune } } },
                system: { ...base.system, description: { value: "<p>While sickened, a −10-foot status penalty to its Speeds.</p>" },
                    duration: data.immune ? { value: 1, unit: "rounds", expiry: "turn-start", sustained: false } : { value: -1, unit: "unlimited", expiry: null, sustained: false },
                    rules: [{ key: "FlatModifier", selector: "all-speeds", type: "status", value: data.sickenedSpeed, ...(data.immune ? {} : { predicate: ["self:condition:sickened"] }) }] } }]);
            done.push({ actorUuid: actor.uuid, speed: made?.uuid ?? null });
        }
        const note = data.note;
        if (!note || !note.degrees?.includes(target.degree)) continue;
        if (note.weakness) {
            const [made] = await actor.createEmbeddedDocuments("Item", [{ ...base, name: `${name}: weakness ${note.weakness.value} to ${note.weakness.type}`,
                system: { ...base.system, description: { value: `<p>${escapeHTML(note.text)}</p>` }, duration: { value: 0, unit: "rounds", expiry: "turn-end", sustained: false },
                    rules: [{ key: "Weakness", type: note.weakness.type, value: note.weakness.value }] } }]);
            done.push({ actorUuid: actor.uuid, weakness: made?.uuid ?? null });
            continue;
        }
        if (!note.rounds) {
            await ChatMessage.create({ whisper: gmIds(), content: `<p class="pf2e-auto-gm-reminder"><strong>${escapeHTML(name)}</strong> (GM): ${escapeHTML(actor.name)} — ${escapeHTML(note.text)}</p>` }).catch(() => null);
            done.push({ actorUuid: actor.uuid, reminder: true });
            continue;
        }
        const text = target.degree === "criticalFailure" && note.critical ? `${note.text} (Critical failure: ${note.critical}.)` : note.text;
        const [made] = await actor.createEmbeddedDocuments("Item", [{ ...base, name: `${name}: ${target.degree === "criticalFailure" && note.critical ? note.critical : "note"}`,
            flags: { [MODULE_ID]: { runtime: { schema: 1, kind: "note-effect", sourceActorUuid: data.casterUuid, sourceItemName: name, ...(note.castFlatCheck ? { castFlatCheck: { ...note.castFlatCheck } } : {}) } } },
            system: { ...base.system, description: { value: `<p>${escapeHTML(text)}</p>` }, duration: { value: note.rounds, unit: "rounds", expiry: "turn-start", sustained: false }, rules: [] } }]);
        done.push({ actorUuid: actor.uuid, note: made?.uuid ?? null });
    }
    return done;
}

/** Sickened gone: transmutation's speed penalty with it. */
export async function essenceShellSickenedGone(item) {
    if (item?.type !== "condition" || item.slug !== "sickened" || !item.actor || item.actor.hasCondition?.("sickened")) return;
    const ids = (item.actor.itemTypes?.effect ?? []).filter(effect => effect.flags?.[MODULE_ID]?.essenceShellSpeed?.whileSickened).map(effect => effect.id);
    if (ids.length) await item.actor.deleteEmbeddedDocuments("Item", ids);
}
