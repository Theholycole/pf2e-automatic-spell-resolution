// PF2e 8.5.0 native form rules and duration, before module corrections.
export const FORM_EFFECT_HASHES = {
    "0B3noZtrBfeHC7ye": "66c1d77e9884262388394d6ad1db2a7f02b1cfe666f896429da6b8da66b0fec8",
    "1Gax900IAwhLCi4q": "54aa9ed9a4686cf87a36811774965251f1a1215ba3fc28851766c1f1bcaaa7c0",
    "1pC1qjvCuAKzjYo8": "f194b5556d2366ef5aa97ffc63797d87406b64619add1192033c6c96ef2ecb6b",
    "BT1ofB6RvRocQOWO": "034cd47ea99656a80bca50b6e0a209ae97818617a86a10a821f96cca3a6d27a3",
    "F4DTpDXNu5IliyhJ": "e880c6f3a4641eec090e9a99c55233b2ffe76bb6c3daa2918498cd901b0d4324",
    "gQnDKDeBTtjwOWAk": "f8cef5be930f27ac0a23ba977b9dbfb210074db82a578403b393e38c8741a4a2",
    "j2LhQ7kEQhq3J3zZ": "a0cffe748e4f1a89bc98ea21c98c7dc3e92940d858fea86bae0ed45d773910be",
    "kz3mlFwb9tV9bFwu": "7f1ec5a6f9b7b397d77d915c30aa74bdc662384c566d8d5052b2945a20d06204",
    "ptOqsN5FS0nQh7RW": "be3fac2cd0128bd1a19cf52cc84b3dcc9b66d0756b290576600de05bbe6e2a66",
    "qPaEEhczUWCQo6ux": "358d2355742ba22bd9bc21ff7ec51de90a23479c43ca9dcdd6a0e6962a0b0b73",
    "rmtCkBCEwyg919N0": "358d2355742ba22bd9bc21ff7ec51de90a23479c43ca9dcdd6a0e6962a0b0b73",
    "sN3mQ7YrPBogEJRn": "6e5438cfad0ea081b963d8da855774e93d3f34a8471667ced1e5e87213649c1c",
    "tUelWvSaNZBng42K": "d59a7359eb9d999eebba2c208871f4b76c1684a0010f4763666c1b1e4b715206",
    "tk3go5Cl6Qt130Dk": "7b2ff587e23b2c81d353a3441b2ccf073510f0c6e6f926b97f530fc69e9d2db6",
    "ydsLEGjY89Akc4oZ": "2dd65dbbad6af39f13f63deb2919adcf654116977babdaa36f4fc3372e329f50"
};

// PF2e 8.6.1's, where its native form Effect changed (2026-10-29): Animal Form (Crocodile) only its jaws' icon; Dragon Form its burrow, climb
// and swim speeds moved from BaseSpeed rules into the choice and the BattleForm (PF2e 8.5.1's errata: a battle form removes unmentioned
// speeds) and its rank-8 status bonus to fly Speed now its own. Every other form Effect is the same as 8.5.0's.
export const FORM_EFFECT_HASHES_8_6 = {
    "0B3noZtrBfeHC7ye": "b37601ff7549264abc47fe2077d3f89ff1ff19586bc9f085354ae452e7b71ce3",
    "1pC1qjvCuAKzjYo8": "2df72779ec17c4f5b14bafe52c341406c043d153f9876707caacf54bb154ac10"
};

// Whether a native form Effect's digest is one verified: 8.5.0's, or 8.6.1's where that one changed.
export const formDigestVerified = (id, digest) => digest === FORM_EFFECT_HASHES[id] || digest === FORM_EFFECT_HASHES_8_6[id];
