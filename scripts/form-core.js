export const FORM_PROFILES = {
    'animal-form': { id: 'wp09USMB3GIW1qbp', minRank: 2 },
    'dragon-form': { id: '5c692cCcTDXjSEzk', minRank: 6, effectId: '1pC1qjvCuAKzjYo8' },
    'pest-form': { id: 'gfPjmG6Fe6D3MFjl', minRank: 1, effectId: 'ydsLEGjY89Akc4oZ' }
};
export function validateFormRank(kind, rank) {
    if (!FORM_PROFILES[kind] || !Number.isInteger(rank) || rank < FORM_PROFILES[kind].minRank || rank > 10) throw Error('Choose a legal form spell rank.');
}
export function formSize(kind, rank) {
    validateFormRank(kind, rank);
    return kind === 'pest-form' ? 'tiny' : kind === 'dragon-form' ? rank >= 8 ? 'huge' : 'lg' : rank >= 5 ? 'huge' : rank >= 4 ? 'lg' : 'med';
}
export function rechargeReady(use, clock) {
    if (!use) return true;
    if (clock.worldTime < use.worldTime) return false;
    if (use.combatId && use.started !== false && use.roster && JSON.stringify(use.roster)!==JSON.stringify(clock.roster)) return false;
    if (use.combatId && use.started !== false) return clock.started && clock.combatId === use.combatId && clock.round >= use.round + use.rounds
        && (clock.round > use.round + use.rounds || clock.turn >= use.turn);
    return clock.worldTime >= use.worldTime + use.rounds * 6;
}
/** Corrections apply only to our cloned, pinned 8.5.0 Effect, never its compendium. */
export function prepareFormSource(template, { kind, rank, choice, flying = false }) {
    validateFormRank(kind, rank);
    const source = structuredClone(template); delete source._id;
    source.system.level.value = rank;
    const rules = source.system.rules;
    const battle = rules.find(r => r.key === 'BattleForm');
    if (!battle) throw Error('The native battle form is unavailable.');
    if (kind === 'dragon-form') {
        const selector = rules.find(r => r.key === 'ChoiceSet' && r.flag === 'dragonForm');
        const selected = structuredClone(selector?.choices.find(c => c.value.dragonType === choice)?.value);
        if (!selected) throw Error('Choose a listed dragon with confirmed access.');
        if (selected.dragonType === 'sovereign') throw Error('Sovereign Dragon save sources disagree; this option requires separate source clarification.');
        if (selected.dragonType === 'despair') { selected.saveType = 'will'; selector.choices.find(c => c.value.dragonType === 'despair').value.saveType = 'will'; }
        selector.selection = selected;
        source.flags ??= {}; source.flags.pf2e ??= {}; source.flags.pf2e.rulesSelections ??= {};
        source.flags.pf2e.rulesSelections.dragonForm = selected;
        // hasHands is a BattleForm field, not an override statistic.
        battle.hasHands = true;
        // (PF2e 8.6's Effect gives its rank-8 status bonus to fly Speed itself: ours only where it doesn't.)
        const ownFly = rules.some(r => r.key === 'FlatModifier' && r.selector === 'fly-speed' && r.type === 'status');
        if (rank >= 8 && !ownFly) rules.push({ key: 'FlatModifier', selector: 'fly-speed', type: 'status', value: 20, label: 'Dragon Form (rank 8)', battleForm: true });
        const grant = rules.find(r => r.key === 'GrantItem' && r.flag === 'dragonBreath');
        grant.onDeleteActions = { granter: 'cascade', grantee: 'detach' };
    }
    if (kind === 'pest-form' && !flying) battle.brackets = [];
    return source;
}
export function canonicalFormMechanics(value) {
    const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
    return JSON.stringify(sorted({rules:value.system.rules,duration:value.system.duration}));
}
