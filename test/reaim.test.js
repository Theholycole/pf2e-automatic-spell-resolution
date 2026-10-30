import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';

import {castFits, castKindsOf, damageTypesOf, rangeFeetOf, remainingRange} from '../src/compiler/reaim.js';

// (2026-10-29, the item module's ask, its row 17) A cast an item turns back (Cayden's Tankard's fear effect) or redirects (Scale of Igroon's
// energy from a line, a ray or a direct attack), read from the installed PF2e's spells.
test('which casts a reflection takes: a fear spell, an energy line, ray or direct attack; their ranges', async t => {
    const packs = `${process.env.HOME}/.local/share/FoundryVTT/Data/systems/pf2e/packs/spells`;
    if (!existsSync(packs)) return t.skip('PF2e isn\'t installed here');
    const {readDocuments} = await import('../../pf2e-automatic-ability-resolution/tools/leveldb.mjs');
    const spells = readDocuments(packs).filter(entry => entry.type === 'spell');
    const named = name => spells.find(entry => entry.name === name);
    const fear = {trait: 'fear', to: 'creator'};
    const energy = {kinds: ['line', 'ray', 'attack'], to: 'chosen'};
    assert.deepEqual(['Fear', 'Lightning Bolt', 'Force Barrage', 'Heal'].map(name => castFits(named(name), fear)), [true, false, false, false]);
    assert.deepEqual(['Lightning Bolt', 'Force Barrage', 'Fireball', 'Fear', 'Heal'].map(name => castFits(named(name), energy)), [true, true, false, false, false]);
    assert.deepEqual([castKindsOf(named('Lightning Bolt')).line, castKindsOf(named('Force Barrage')).attack, castKindsOf(named('Fireball')).attack], [true, true, false]);
    assert.deepEqual(damageTypesOf(named('Lightning Bolt')), ['electricity']);
    assert.deepEqual([rangeFeetOf(named('Lightning Bolt')), rangeFeetOf(named('Force Barrage')), remainingRange(named('Force Barrage'), 40), remainingRange(named('Lightning Bolt'), 150)], [120, 120, 80, 0]);
});

test('a reflection with neither trait nor kind takes nothing; no spell, nothing', () => {
    assert.equal(castFits({system: {traits: {value: ['fear']}}}, {to: 'creator'}), false);
    assert.equal(castFits(null, {trait: 'fear'}), false);
    assert.equal(rangeFeetOf({system: {range: {value: 'touch'}}}), 5);
    assert.equal(rangeFeetOf({system: {}}), Infinity);
});
