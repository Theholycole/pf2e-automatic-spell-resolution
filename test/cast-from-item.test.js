import assert from 'node:assert/strict';
import test from 'node:test';

import {changedSpellSource, itemSpellChanges, spellDurationSeconds} from '../scripts/item-cast-runtime.js';

// api.castFromItem (2026-10-15, for the item module): the temporary entry and spell stay for the spell's duration — at least 10 minutes, at most an hour.
test("a spell's stated duration in seconds", () => {
    const at = value => spellDurationSeconds({system: {duration: {value}}});
    assert.deepEqual(['1 minute', '10 minutes', '1 hour', 'until the end of your next turn', '', 'sustained up to 1 minute', '1 day'].map(at),
        [60, 600, 3600, 12, 0, 60, 86400]);
});

// (2026-10-29, the item module's asks) An item's changes to the spell it casts, on the entry's copy only.
test("an item's changes to its spell: traits less and more, its area with its variants', every damage one type but healing", () => {
    assert.equal(itemSpellChanges({}), null);
    assert.throws(() => itemSpellChanges({area: {type: 'blob', value: 30}}), /area/);
    assert.throws(() => itemSpellChanges({damageType: 'plasma'}), /damage type/);
    const changes = itemSpellChanges({withoutTraits: ['mental'], addTraits: 'air', area: {type: 'cone', value: 30}, damageType: 'spirit'});
    assert.deepEqual([changes.withoutTraits, changes.addTraits, changes.area, changes.damageType], [['mental'], ['air'], {type: 'cone', value: 30}, 'spirit']);
    assert.match(changes.key, /withoutTraits=.*area=.*damageType=spirit/);
    const source = {name: 'Test', type: 'spell', system: {
        traits: {value: ['mental', 'manipulate']},
        area: {type: 'emanation', value: 30},
        damage: {a: {formula: '2d6', type: 'fire', kinds: ['damage']}, b: {formula: '1d8', type: 'vitality', kinds: ['healing']}},
        description: {value: '<p>@Damage[(2d6+4)[fire]] and @Damage[1d6[persistent,fire]|options:area-damage] and @Damage[1d8[healing]]</p>'},
        overlays: {x: {system: {area: {type: 'emanation', value: 30}, description: {value: '@Damage[3d6[cold]]'}}}}
    }};
    const before = structuredClone(source);
    const out = changedSpellSource(source, changes);
    assert.deepEqual(source, before);
    assert.deepEqual(out.system.traits.value, ['air', 'manipulate']);
    assert.deepEqual([out.system.area, out.system.overlays.x.system.area], [{type: 'cone', value: 30}, {type: 'cone', value: 30}]);
    assert.deepEqual([out.system.damage.a.type, out.system.damage.b.type], ['spirit', 'vitality']);
    assert.equal(out.system.description.value, '<p>@Damage[(2d6+4)[spirit]] and @Damage[1d6[persistent,spirit]|options:area-damage] and @Damage[1d8[healing]]</p>');
    assert.equal(out.system.overlays.x.system.description.value, '@Damage[3d6[spirit]]');
    assert.equal(out.flags['pf2e-automatic-resolution'].castDamageType, 'spirit');
});

test("an item's damage type reaches the spell's damage stated in words, its own types only (Everburning Coal's Wall of Ice in fire)", () => {
    const wall = {name: 'Wall of Ice', type: 'spell', system: {traits: {value: ['cold', 'concentrate', 'manipulate', 'water']}, damage: {0: {formula: '2d6', type: 'cold', kinds: ['damage']}},
        description: {value: '<p>A section … deals 2d6 cold damage to any creature passing through it. Its weakness to fire stays.</p><hr /><p>Heightened (+2) … the cold damage dealt to creatures crossing a destroyed section increases by 1d6.</p>'}}};
    const out = changedSpellSource(wall, itemSpellChanges({withoutTraits: ['cold', 'water'], addTraits: ['fire'], damageType: 'fire'}));
    assert.deepEqual([out.system.traits.value, out.system.damage[0].type], [['concentrate', 'fire', 'manipulate'], 'fire']);
    assert.equal(out.system.description.value, '<p>A section … deals 2d6 fire damage to any creature passing through it. Its weakness to fire stays.</p><hr /><p>Heightened (+2) … the fire damage dealt to creatures crossing a destroyed section increases by 1d6.</p>');
});
