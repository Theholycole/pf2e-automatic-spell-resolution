import assert from 'node:assert/strict';
import test from 'node:test';

import {mythicCastCheck, mythicCastDue, mythicResource} from '../scripts/mythic-cost.js';

// A spell with the mythic trait costs a Mythic Point (the user, 2026-10-19: refused before the cast without one; paid with Hero Points under the item module's
// setting; an item's cast is the item module's to pay).
const withGame = (settings, fn) => {
    const saved = globalThis.game;
    globalThis.game = {modules: new Map([['pf2e-automatic-item-resolution', {active: settings != null}]]),
        settings: {settings: new Map(settings != null ? [['pf2e-automatic-item-resolution.heroPointsForMythic', {}]] : []), get: () => settings === true}};
    try { return fn(); } finally { globalThis.game = saved; }
};
const actor = (mythic, hero) => ({name: 'Caster', system: {resources: {mythicPoints: {value: mythic, max: 3}, heroPoints: {value: hero, max: 3}}}});
const spell = (traits, flags = {}) => ({name: 'Freedom', system: {traits: {value: traits}}, flags});

test('due only for the mythic trait, and never for an item\'s cast', () => {
    assert.equal(mythicCastDue(spell(['mythic', 'manipulate'])), true);
    assert.equal(mythicCastDue(spell(['manipulate'])), false);
    assert.equal(mythicCastDue(spell(['mythic'], {'pf2e-automatic-resolution': {castFromItemTemp: {until: 1}}})), false);
});

test('refused without a Mythic Point, the spend otherwise, the GM\'s bypass; Hero Points under the item module\'s setting', () => {
    withGame(null, () => {
        assert.equal(mythicResource(), 'mythicPoints');
        assert.throws(() => mythicCastCheck(actor(0, 2), spell(['mythic'])), /no Mythic Point to spend: Freedom has the mythic trait/);
        assert.deepEqual(mythicCastCheck(actor(1, 0), spell(['mythic'])), {resource: 'mythicPoints'});
        assert.equal(mythicCastCheck(actor(0, 0), spell(['mythic']), {bypass: true}), null);
        assert.equal(mythicCastCheck(actor(0, 0), spell(['concentrate'])), null);
    });
    withGame(true, () => {
        assert.equal(mythicResource(), 'heroPoints');
        assert.deepEqual(mythicCastCheck(actor(0, 1), spell(['mythic'])), {resource: 'heroPoints'});
        assert.throws(() => mythicCastCheck(actor(3, 0), spell(['mythic'])), /no Hero Point to spend/);
    });
    withGame(false, () => assert.equal(mythicResource(), 'mythicPoints'));
});
