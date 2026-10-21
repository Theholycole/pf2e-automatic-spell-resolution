import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {readItemSpellshape} from '../src/compiler/item-spellshape.js';
import {unmetRequirement} from '../src/compiler/spellshape-readers.js';

// PF2e's grimoires and instruments whose activation changes the next spell (the item module's census, 2026-10-19; the user: build all 16). PF2e 8.6.1's items.
const items = JSON.parse(readFileSync(new URL('../.cache/pf2e-spell-features/grimoire-spellshapes-861.json', import.meta.url), 'utf8'));
const item = name => items.find(entry => entry.name === name);
const activation = (name, label = null) => { const read = readItemSpellshape(item(name)); assert.ok(read, name); return label ? read.activations.find(entry => entry.label === label) : read.activations[0]; };
const riders = (name, label) => activation(name, label).riders;
const facts = extra => ({name: 'Fireball', cantrip: false, damageTypes: ['fire'], hasDuration: false, traits: [], prepared: true, innate: false, ...extra});

test('all 18 items read, each with its activation', () => {
    assert.equal(items.length, 18);
    for (const entry of items) assert.ok(readItemSpellshape(entry), entry.name);
});

test('conditions on a failed save, Drained unless a critical success, persistent damage when frightened', () => {
    assert.deepEqual(riders('Instructions for Lasting Agony').map(rider => rider.type), ['conditions']);
    assert.deepEqual(Object.keys(riders('Instructions for Lasting Agony')[0].degrees), ['failure', 'criticalFailure']);
    const grudge = activation('Grudge Journal');
    assert.deepEqual(Object.keys(grudge.riders.find(rider => rider.type === 'conditions').degrees), ['success', 'failure', 'criticalFailure']);
    assert.equal(grudge.requires.singleTarget, true);
    assert.deepEqual(['Chapbook of Terrors', 'Chapbook of Terrors (Greater)', 'Chapbook of Terrors (Major)'].map(name => riders(name)[0].formula), ['1d6', '2d6', '4d6']);
    assert.equal(riders('Chapbook of Terrors')[0].whenCondition, 'frightened');
    assert.equal(unmetRequirement(activation('Chapbook of Terrors').requires, facts({traits: ['fear']})), null);
    assert.notEqual(unmetRequirement(activation('Chapbook of Terrors').requires, facts({traits: ['mental']})), null);
});

test('save penalties before the roll: Mocking Spell (−1 item, Off-Guard), the Pillow Book (−1), Cast Out (−2, −3 against a demon)', () => {
    const mock = riders("Mocker's Swazzle", 'Mocking Spell');
    assert.deepEqual(mock.find(rider => rider.type === 'save-penalty'), {type: 'save-penalty', value: -1, penaltyType: 'item'});
    assert.equal(mock.find(rider => rider.type === 'conditions').degrees.criticalSuccess[0].until, 'caster-turn-start');
    assert.deepEqual(riders("Courtier's Pillow Book").find(rider => rider.type === 'save-penalty'), {type: 'save-penalty', value: -1, penaltyType: 'circumstance'});
    const out = activation('What Doors We Open', 'Cast Out');
    assert.deepEqual(out.requires.spells, ['Banishment']);
    assert.deepEqual(out.riders.find(rider => rider.type === 'save-penalty'), {type: 'save-penalty', value: -2, penaltyType: 'circumstance', vsTraits: {demon: -3}});
});

test('fire resistance ignored, the subtle trait, a wider emanation, an unspent slot', () => {
    for (const name of ['Book of Lingering Blaze', 'Kindled Tome']) assert.deepEqual(riders(name)[0], {type: 'ignore-resistance', types: ['fire'], value: 10}, name);
    assert.equal(unmetRequirement(activation('Kindled Tome').requires, facts({damageTypes: ['cold']})) != null, true);
    assert.deepEqual(riders('Hollow Robes', 'Unseen Magic'), [{type: 'trait', trait: 'subtle'}]);
    assert.deepEqual(activation('Hollow Robes', 'Unseen Magic').requires.notTraits, ['manipulate']);
    assert.deepEqual(riders('Folding Drums'), [{type: 'area', grow: [{types: ['emanation'], add: 30}]}]);
    assert.deepEqual(riders('Dreamstone'), [{type: 'slot-refund'}]);
    assert.equal(activation('Dreamstone').requires.maxRank, 4);
});

test('Corrosive Engravings, Draxie\'s powder, Purging Spell, Arclord\'s Codex, Tyrant\'s Writs', () => {
    const corrosive = riders('Corrosive Engravings')[0];
    assert.deepEqual([corrosive.type, corrosive.list[0].slug, corrosive.list[0].value, corrosive.floor], ['persistent-condition', 'sickened', 2, 1]);
    const powder = riders("Draxie's Recipe Book").find(rider => rider.type === 'degree-note');
    assert.deepEqual([powder.degrees, powder.text.length], [['success', 'failure', 'criticalFailure'], 2]);
    assert.deepEqual(activation("Draxie's Recipe Book").requires.spells, ['Revealing Light']);
    assert.deepEqual(riders('Warding Tablets').map(rider => rider.type), ['counteract-effect', 'note']);
    const codex = riders("Arclord's Codex")[0];
    assert.deepEqual(codex, {type: 'restore-prepared', either: [{count: 2, maxRank: 4}, {count: 1, minRank: 5}]});
    assert.equal(activation("Arclord's Codex").requires.rank, 10);
    const writs = riders("Tyrant's Writs")[0];
    assert.deepEqual(writs.choices.map(choice => choice.key), ['bloody', 'explosive', 'speed', 'rotten']);
    assert.deepEqual(writs.choices[1].explode, {formula: '4d6', damageType: 'fire', statistic: 'reflex'});
    assert.deepEqual(activation("Tyrant's Writs").requires.spells, ['Animate Dead', 'Summon Undead']);
});
