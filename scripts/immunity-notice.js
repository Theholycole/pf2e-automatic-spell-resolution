// (2026-11-11, Cole: "any time an effect wouldn't be applied due to an immunity on a creature, make sure there is a message to the GM".)
// The core's GM-only immunity notice (pf2e-resolution-core scripts/immunity-notice.js): { actor?, token?, target?, blocked, why?, source?, once? }.
// With a core too old to have it, a plain whisper to the GMs from this client instead. Never throws, never needs awaiting.

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export function noticeImmunity(fields) {
    try {
        const notify = game.modules?.get?.("pf2e-resolution-core")?.api?.immunity?.notify;
        if (notify) return Promise.resolve(notify(fields)).catch(() => null);
        const { actor = null, token = null, target = null, blocked, why = null, source = null } = fields ?? {};
        const whisper = ChatMessage.getWhisperRecipients("GM").map((user) => user.id);
        if (!whisper.length) return Promise.resolve(null);
        const name = target ?? token?.name ?? actor?.name ?? "A creature";
        const content = `<p><strong>Immunity</strong>: ${escape(name)} isn't affected by ${escape(blocked ?? "an effect")}${source ? ` from ${escape(source)}` : ""}${why ? ` (${escape(why)})` : ""}.</p>`;
        return ChatMessage.create({ content, whisper, speaker: ChatMessage.getSpeaker({ actor: actor ?? undefined }) }).catch(() => null);
    } catch {
        return Promise.resolve(null);
    }
}

// The words for a temporary immunity an earlier use left ("Immune: …" Effects).
export const TEMPORARY = "temporarily immune after an earlier use";

// The words for a creature's own immunity that blocks a PF2e condition or Effect (the core's blockedWords): "immune to fear effects".
export function immunityWordsFor(actor, effect) {
    try {
        return game.modules?.get?.("pf2e-resolution-core")?.api?.immunity?.blockedWords?.(actor, effect) ?? (typeof effect === "string" ? `immune to ${effect}` : "immune");
    } catch {
        return "immune";
    }
}
