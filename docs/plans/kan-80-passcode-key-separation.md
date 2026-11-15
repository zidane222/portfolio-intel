# Plan: passcode strength and key separation (roadmap 15, KAN-80)

Owner: architect. Status: draft for owner review. Plan only, no code in this PR.
Date: 2026-11-14. Base: `main` at `79098843ff50eb35a40b3d3fd7b4d7ba358dcf81`.
Jira: Epic KAN-80, stories KAN-90 (passcode strength) and KAN-91 (key separation and migration).
Game plan: G7 stage A, finding F12.

Short answer to the stage A question: **No.** The full change should not be built, tested and
released in one day. Run Stage B small on Sunday with the three additions in section 10, and build
the full change after the 16th on the schedule in section 11. The reasons are in section 12.

## 1. Goal and scope

Make the passcode strong enough to protect the vault, stop the vault key from being a direct
function of the passcode, and move existing vaults over without losing data.

In scope: passcode rules, lock screen, vault key handling, the sync row format, passkey wraps,
the wrong-try counter (KAN-112 part), tests, docs.

Out of scope: non-extractable keys and the session copy of the key (roadmap 16), gateway
authentication (roadmap 18), any change to email code sign-in, any Supabase schema change.

The on-device design stays. The passcode, the vault key and the passkey PRF output never leave the
device.

## 2. What main does today

How each row was checked: CODE means read in the file. PROBE means run here on 2026-11-14 in
headless Chromium against `main` at the base commit, with synthetic data and a fake Supabase (the
same harness as `tests/journeys/passcode-signin.mjs`). LIVE means a read-only count query on the
Supabase project. No real user data was read or stored.

| # | Fact | Source |
|---|---|---|
| M1 | The passcode dialog accepts 4 characters and refuses 3 ("Use at least 4 characters."). `pass-1`, `pass-2` and the lock screen field `lock-in` all use `inputmode="numeric"`. | PROBE, `js/16-lock.js` line 69, `index.html` lines 1019, 1042, 1043 |
| M2 | A 4 character vault on main is `pi.lock.v1` = `{salt, iter: 210000, hash, encSalt}` plus `enc1:` values in the vault item keys. It locks, and opens again with the same 4 characters. | PROBE |
| M3 | The vault key is derived straight from the passcode: PBKDF2-SHA256, 210,000 rounds, random 16 byte `encSalt`. There is no separate data key. | CODE, `js/02-state.js` `vaultDerive` |
| M4 | The sign-in secret is already a separate derivation: PBKDF2-SHA256, 600,000 rounds, salt `pi-login-v1:` plus the email. It is sent to Supabase as the account password. | CODE, `js/29a-account.js` `loginSecret` |
| M5 | Sync and passcode sign-in already need 8 characters when they are set up (`SYNC_MIN_PASS = 8`, checked in `sync-create`, in "Turn on sync" and in `pwLink`). The 4 character rule only applies to a passcode set from the passcode dialog on one device. | CODE, `js/29a-account.js` |
| M6 | Loading synced data on a new device does not check the length. A synced vault made before the 8 character rule existed could still have a short passcode. Not checkable from here. | CODE |
| M7 | Five wrong tries give "Too many tries. Wait 30 seconds." After a reload the next wrong try shows "Wrong passcode." The counter and the wait are gone. | PROBE |
| M8 | **Changing the passcode while sync is on breaks sync on main.** After the change the lock settings lose `sync`, the local salt is new, the synced row still has the old salt and old payload, no upload happens, and the Supabase sign-in secret is already the new one. After a reload the app asks for "the passcode you use on your other device", and the new passcode answers "That passcode doesn't open your synced data." The on-screen text right after the change still says "All set. Sync is on". | PROBE |
| M9 | A passcode change re-encrypts every vault item in place, one `localStorage` write at a time, and writes the new salt last. A crash or a full storage error part way leaves items under the new key and settings that still point at the old key. | CODE, `vaultSeal` and the `pass-form` handler |
| M10 | The same change also drops the saved passkey wraps (`pk`) from the lock settings. | CODE, `pass-form` handler writes a fresh object |
| M11 | There are three values that let someone test a passcode guess: the lock check hash (210k, on the device), the vault ciphertext with its salt (210k, on the device and in `synced_data`), and the sign-in secret (600k, then Supabase's own password hash, and the live sign-in endpoint). | CODE |
| M12 | Live project: 2 accounts, both with a passcode sign-in secret set, 1 synced row (format `enc1`), 0 accounts with a passkey wrap in their metadata. | LIVE |
| M13 | The existing passcode sign-in journey passes on main: 13 of 13 checks. | PROBE |
| M14 | Journeys are not run by any workflow. They are run by hand or by qa in a session. | CODE, `.github/workflows` |

## 3. What this changes about the finding

- F12 says one passcode derives both the vault key and the sign-in secret. That is true, but the two
  derivations are already separate (M3, M4). Neither value can be turned into the other without
  guessing the passcode. What is missing is not a second derivation. It is passcode strength, and a
  data key that does not depend on the passcode at all.
- As long as the app offers email plus passcode sign-in, a single memorized secret feeds both the
  sign-in secret and the key that protects the data key. No design removes that link. It can only
  be made expensive to guess. The owner asked to keep all three sign-in options, so the link stays
  and the plan makes it costly. This residual risk goes in `RISK_REGISTER.md`.
- The largest real exposure is the 4 character passcode on a device-only vault (M1, M2), and the
  numeric keypad that pushes users toward digits.
- M8 and M9 are new findings. They matter more than the roadmap assumed, because every plan for
  short passcodes sends users through the passcode change path. M8 is a bug today for any synced
  user who changes a passcode.

## 4. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | 8 or more characters, typed on the full keyboard, for every new or changed passcode. Passkey stays an optional faster unlock. Passkey does not become the default. | PRF unlock is not available on every device (the code already handles that case), passkeys are tied to the pages.dev address, and no account uses a passkey wrap today (M12). A longer passcode works everywhere. |
| D2 | Existing short passcodes always keep unlocking. After unlock the user is asked to set a longer one. The prompt can be dismissed and comes back at the next unlock. | No lockout, no forced change before the data is open. |
| D3 | Envelope design. A random 256 bit data key (DEK) encrypts the vault. The passcode derives a key-encryption key (KEK) with PBKDF2-SHA256, 600,000 rounds, random salt. The KEK only wraps the DEK. | The data key no longer depends on the passcode. A passcode change becomes one small write. Passkey wraps survive a passcode change. |
| D4 | The sign-in secret derivation does not change (`pi-login-v1`, 600k, email salt). | It is already separate. Changing it would add a second one-way step on the server side and would break passcode sign-in after a rollback. |
| D5 | The separate lock check hash is dropped for migrated vaults. Unwrapping the DEK is the check. | One guess oracle fewer (M11), and every remaining one costs 600k. |
| D6 | Migration writes the new format next to the old one. It never edits or deletes a v1 value. v1 is removed only after 7 days and 3 good unlocks on the new format. | This is the rollback path. Old code can open the device again for a week. |
| D7 | Migration and new-format vaults sit behind a new flag `vault_v2`: default false, fail closed, kind client. The flag never triggers a move back to v1. | The change ships dark. The owner turns it on, tests on a phone, and can stop new migrations in about a minute. Fail closed means a flags outage does nothing. |
| D8 | A short passcode vault stays v1 until the user sets a longer passcode. That change is its migration, and it always creates a new DEK. | Wrapping a 4 character passcode at 600k gains nothing, and the new data must not be readable from the old passcode. |
| D9 | No Supabase schema change. The row keeps `enc_salt` and `payload`. The new payload starts with `enc2:`. | No owner SQL step. Old code fails closed on an `enc2` row with "That passcode doesn't open your synced data." and changes nothing. |
| D10 | A normal passcode change re-wraps the same DEK. It keeps `sync`, keeps passkey wraps, uploads the new wrap, and re-links the sign-in secret. | Fixes M8, M9 and M10. |
| D11 | The wrong-try counter and the wait time are stored on the device. The rule stays 5 tries, then 30 seconds. | KAN-112 part. It is a speed bump only. Someone who can read the device storage can also clear it. The real protection is D1 and D3. |

## 5. Target design

### 5.1 Device storage

Lock settings, new key `pi.lock.v2`:

```json
{"v": 2, "kid": "<random id of the DEK>", "ks": "<KEK salt, base64>", "it": 600000,
 "w": "<iv>:<DEK wrapped with the KEK, AES-GCM>",
 "sync": true, "pk": {"<credential id>": "<DEK wrapped with the passkey PRF key>"},
 "mig": {"from": 1, "at": "<ISO time>", "ok": 0, "v1fp": "<SHA-256 of the v1 settings and items at migration>"}}
```

Vault items in the new format live under new names, so old code never reads them:
`pi.e2.` plus the old name without its `pi.` prefix (for example `pi.e2.portfolio.v2`). The value is
`enc2:<iv>:<ciphertext>` under the DEK. All names start with `pi.` so "Forgot passcode" still wipes
them.

Three storage modes, decided at boot: `v2` when `pi.lock.v2` exists, `v1` when `pi.lock.v1` has
`encSalt`, otherwise plain. Plain mode is unchanged. The v1 read and write path stays in the code,
untouched, for vaults that have not moved.

Try counter: `pi.lock.tries` = `{"n": 0, "until": 0}`.

### 5.2 Synced row (`public.synced_data`, no schema change)

| Column | v1 today | v2 |
|---|---|---|
| `enc_salt` | salt for the passcode key | KEK salt (`ks`). Still "salt for the passcode key (not secret)". |
| `payload` | `enc1:<iv>:<ct>` | `enc2:<kid>:<it>:<wrap iv>:<wrapped DEK>:<iv>:<ct>` |

The plain text inside is the same `{v: 1, data, watch}` object as today.
Passkey metadata keeps its shape `{w, s}`. In v2, `s` holds `kid` instead of the salt, so a passcode
change does not cut passkey unlock off.

### 5.3 Flows

- **Unlock, v2:** derive KEK from the typed passcode and `ks`, unwrap `w`. Success opens the vault.
  Failure counts a wrong try.
- **Set a passcode (new vault, flag on):** 8 or more characters. New DEK, new `ks`, wrap, write items,
  write settings last.
- **Change passcode, v2:** verify the old passcode by unwrapping. New `ks`, re-wrap the same DEK,
  verify the new wrap opens, then one write of `pi.lock.v2`. Keep `sync` and `pk`. If signed in,
  upload the row with the new wrap, then `pwLink`. If not signed in, clear `pi.pw.linked` so the
  next session links again.
- **Second device:** sign in by email code, passkey or email plus passcode as today. Read the row.
  `enc2`: unwrap with the passcode. `enc1`: derive the old key as today, then follow the migration
  rules in section 6.
- **Other device after a passcode change:** same `kid`, different wrap. The device takes the new
  wrap from the row. From then on it needs the new passcode.

## 6. Migration

It runs only at a passcode unlock, when the passcode is in memory, the flag is on, and every v1
item opened without error. A vault where any item fails to decrypt is never migrated.

Steps, in order:

1. Read all plain values from the open v1 vault into memory. Compute `v1fp`.
2. Make a new DEK. Encrypt every value. Decrypt each one again and compare with the original.
3. Derive the KEK, wrap the DEK, unwrap it again and compare.
4. Write one staging value `pi.vault.next` holding the new settings and the new items. If storage is
   full, stop here. Nothing has changed.
5. Commit: write the `pi.e2.*` items, then `pi.lock.v2`, then remove `pi.vault.next`.
   At boot, a leftover `pi.vault.next` means step 5 was interrupted. Finish it. Every write in it is
   the same value, so it is safe to repeat.
6. Read everything back from storage, open it with the passcode, compare with step 1.
   On any difference: delete the v2 values, stay on v1, show nothing destructive, log one line.
7. If sync is on: upload the `enc2` row. The device keeps working if the upload fails and tries
   again later, as today.
8. Do not touch `pi.lock.v1` or any v1 item. They stay exactly as they were.

Who migrates when:

| Vault | When | Result |
|---|---|---|
| Passcode of 8 or more | Silently at the next passcode unlock | New DEK, 600k KEK |
| Short passcode | When the user sets a longer one from the prompt | New DEK. Stays v1 until then |
| Old passcode with no encryption (`hash` only) | Same prompt path | As above |
| Passkey-only device (`check`, no `hash`) | When the passcode is next typed on that device | Stays v1 until then |
| Saved passkey wraps | Dropped at migration, with the line "Add your passkey again to unlock with it." | They wrap the old key and cannot be re-wrapped without the passkey |

Device and row combinations the new code must handle (local state by row state):

| Local | Row | Action |
|---|---|---|
| none | none | New v2 vault |
| none | v1 | Open with the passcode as today, then write local v2 and upload v2 |
| none | v2 | Unwrap, write local v2 |
| v1 | none | Migrate local |
| v1 | v1 | Newest side wins as today, then migrate and upload v2 |
| v1 | v2 | Another device moved first. Unwrap the row's DEK with the passcode and adopt it. Newest side wins |
| v2 | none | Upload |
| v2 | v2 | Normal sync. Take a newer wrap when `kid` matches |
| v2 | v1 | An old tab or a rolled back device wrote v1. Ask for the passcode, read v1, newest side wins, upload v2 |

Cleanup: at a v2 unlock, when `mig.at` is 7 or more days old and `mig.ok` is 3 or more, remove
`pi.lock.v1` and the v1 item names.

If v1 changed after migration (its fingerprint no longer matches `v1fp`), old code has been running
on this device after a rollback. v1 wins: drop v2 and migrate again from v1.

## 7. Rollback path

| Level | When | Step | Effect | Data loss |
|---|---|---|---|---|
| 1 | Anything looks wrong | Owner turns `vault_v2` off on the flags page | No new migrations, no new v2 vaults. Migrated devices keep working on v2 | None |
| 2 | A migrated device cannot open v2 | Automatic. The passcode matches the v1 check but the v2 unwrap fails: the app opens the untouched v1 copy, drops v2 and reports it | That device is back on v1 | Changes made on that device after migration that were not synced. A user who changed a short passcode must type the old one |
| 3 | The new code itself is broken | Owner rolls Cloudflare Pages back to the previous deployment, or merges a revert PR | Old code opens the untouched v1 copy. It cannot read an `enc2` row and fails closed. Its next edit uploads v1 again, and the fixed code later handles that as "v2 local, v1 row" | Changes made after migration on that device |
| After 7 days | v1 copy is gone | Roll forward only | Old code would show an empty app and leave the v2 values alone | None, but no way back |

Notes:
- Levels 1 to 3 need no SQL and no Supabase setting. The sign-in secret never changes (D4), so email
  plus passcode sign-in works on old and new code alike.
- For one week the old ciphertext stays on the device under the old key. That is the price of
  level 3. For a short passcode vault it means the weak copy lives 7 more days.
- Level 3 has a real loss window. It is the reason the owner test and the one week wait in
  section 11 are part of the plan and not optional.

## 8. Tests

### 8.1 Required: a 4 character vault from current main still opens

This test is needed for Stage B small as well as the full change.

Fixture, made before any code change on the branch:
1. qa checks out `main` at the base commit above into a separate worktree and serves it.
2. A generator journey sets synthetic values for all five vault items (portfolio, snapshots, cash,
   Plaid link placeholder, news list), then sets the passcode `1234` through the real passcode
   dialog.
3. It saves `pi.lock.v1`, the five stored strings, the expected plain values and the commit SHA to
   `tests/journeys/fixtures/vault-v1-4char.json`. Synthetic data only. The file is committed and is
   never made again from changed code.
4. A small Node check decrypts the fixture with the v1 rule (PBKDF2-SHA256 210k, AES-GCM) without
   the app, so the fixture is proven readable on its own.

The probe on 2026-11-14 already showed steps 2 and 3 work on main (M2).

Journey `tests/journeys/vault-v1-4char.mjs`, on the changed code, at 390px and desktop width:

| Run | Flag | Steps | Must hold |
|---|---|---|---|
| a | off | Load the fixture into storage, open the app, type `1234` | Unlocks. All five values equal the expected plain values. Storage is byte for byte the fixture. Lock and unlock again works |
| b | flags endpoint not answering | Same | Same as run a |
| c | on | Same, then dismiss the "set a longer passcode" prompt | Unlocks. Prompt shown. Storage still byte for byte the fixture. Next unlock with `1234` works and asks again |
| d | on | Unlock with `1234`, set `longer pass 99` | v2 values exist. v1 values still byte for byte the fixture. Unlock with the new passcode shows the same five values. `1234` is refused |
| e | rollback | Take the storage from run d and open it with the base commit's code on the same origin | Old code unlocks with `1234` and shows the fixture values |
| f | on | 7 character passcode at setup and at change | Refused. 8 accepted |

More fixtures made the same way: an 8 or more character synced vault with its row, an old
`hash` only passcode with no encryption, and a passkey-only device (`check`, no `hash`).

### 8.2 Other journeys

- Setup, change, and sign-in on a second device (extend `passcode-signin.mjs`, keep its 13 checks).
- Migration of an 8 or more character synced vault on device A, then device B on old state: all nine
  combinations in section 6, one check each.
- Change passcode with sync on: `sync` kept, row uploaded with the new wrap, second device opens with
  the new passcode, sign-in secret changed. This is the M8 regression test.
- Interrupted migration: stop after the staging write, and after the first item write. Next boot
  finishes or leaves v1 intact. No state where neither format opens.
- Storage full at the staging write: v1 unchanged.
- Level 2: corrupt `pi.lock.v2`, unlock, v1 opens and v2 is dropped.
- Wrong tries: 5 wrong, reload, the wait is still running.
- Passkey: virtual authenticator with PRF. Add after migration, unlock with it, change passcode,
  passkey still unlocks.
- The passcode, the DEK and the KEK never appear in any request body.
- Flag tests in the worker suite for `vault_v2` (default, fail closed).
- The insights journey already fails on main. Note it and move on.

## 9. Work by role (Stage B full)

| Role | Part | Files |
|---|---|---|
| frontend | v2 vault engine, storage modes, staged commit and recovery, migration, cleanup | `js/02-state.js` |
| frontend | Lock screen on both formats, 8 character rule, full keyboard, prompt for short passcodes, change as re-wrap, stored try counter | `js/16-lock.js`, `index.html` |
| frontend | Sync for the nine combinations, create, turn on, second device, sign out, delete | `js/29a-account.js` |
| frontend | `kid` in passkey wraps, passkey-only prompt | `js/29c-passkey.js` |
| frontend | Flag default in the app, version bumps, cache name | `js/30-init.js`, `index.html`, `sw.js` |
| microservices | Add `vault_v2` to the flag registry | `worker/src/lib/flags.js`, `scripts/flags_registry.json`, worker tests |
| server | Nothing to build. Confirm the Render flags fallback serves the new flag from the registry file | `backend/main.py` read only |
| qa | Fixtures, the journeys in section 8, phone width | `tests/journeys/` |
| appsec | Review. Update the checklist: passcode length 8, KEK 600k, random DEK, no lock hash in v2, v1 copy removed after 7 days | `.claude/agents/appsec.md` |
| compliance | Evidence rows, C-16, C-18, C-27, new risk for the single memorized secret, R-03 wording | `docs/compliance/` |
| architect | `docs/ARCHITECTURE.md` data table and sync section, `docs/runbooks/sync.md` rollback steps, final review | docs |

Contracts that must not change: the `synced_data` columns, the passkey registration and sign-in
calls, `loginSecret`, the `{v: 1, data, watch}` plain payload.

## 10. Stage B small: three additions

Stage B small is still the right Sunday package. Its prompt says existing short passcodes are asked
to change. That sends users through the change path in M8 and M9, so add these lines to the
frontend part of the prompt:

1. When the passcode is changed while sync is on, keep `sync` in the lock settings, upload the
   re-keyed data right away, then link the sign-in secret. Do not show "Sync is on" unless the
   upload worked.
2. Before the first write of a passcode change, encrypt every item in memory and check each one
   decrypts. Keep a copy of the old settings and old items under one backup key until the new
   settings are written. At boot, if the backup key is still there, put the old values back.
3. Add the fixture and runs a and b from section 8.1, plus the M8 regression journey, to the qa
   part.

These do not change key derivation or the vault format, so they fit the small slice's limits.

## 11. Schedule for the full change

| Day | Work | Gate |
|---|---|---|
| 1 | frontend builds the v2 engine, lock and migration behind the flag. microservices adds the flag. qa makes the fixtures first | Flag off: journeys a, b and the existing 13 checks pass |
| 2 | Sync combinations, passkey, interrupted migration, level 2. appsec review | Every journey in section 8 passes at both widths |
| 3 | Owner merges with the flag off. Owner turns the flag on and tests on a real phone with a copy of real data: unlock, change passcode, second device, passkey | Owner go |
| 3 to 10 | v1 copies stay on devices. Watch the SOC monitor channel for sync errors | No level 2 or level 3 event |
| 10 | Nothing to do. Devices clean up by themselves | C-16, C-18 evidence updated |

Estimate: three working days of agent sessions plus the seven day wait. The times are estimates,
not measurements.

## 12. Risks and open questions

Risks:
- A migration bug locks a user out of the new format. Covered by D6 and rollback levels 2 and 3.
- A tab left open on old code writes a v1 row over a v2 row. Covered by the "v2 local, v1 row" rule.
  The cost is the same last-writer-wins loss that two devices can already cause today.
- Storage doubles for 7 days. A very large snapshot history could hit the browser limit. Then
  migration stops at step 4 and the vault stays v1.
- 600k rounds make unlock slower on old phones. qa measures it at phone settings. If it is over
  2 seconds the owner decides, the count is not lowered silently.
- One memorized secret still feeds both sign-in and the KEK (section 3). Accepted residual risk.

Questions for the owner:
1. Is the passcode on the one live synced row 8 or more characters (M6)? If not, that account gets
   the "set a longer passcode" prompt.
2. Is 7 days the right time to keep the old copy? Shorter is safer for short passcodes. Longer
   keeps level 3 open.
3. Does anyone use passkey unlock today? The live count says no remote wraps (M12). A device may
   still hold a local one, and it will have to be added again.

## 13. Answer

**Can the full change (key separation and vault migration) be built and tested in one day with a
safe rollback? No.**

Why:
1. **The rollback needs time, not only code.** The safe path is to keep the old copy untouched for
   a week and watch real unlocks on more than one device. A one day build and release has no such
   window. Without it, the first sign of a migration bug is a user who cannot open the vault.
2. **The base it builds on is broken today.** Changing a passcode while synced already breaks sync
   on main (M8), and the re-key is not crash safe (M9). The migration is a re-key. Those two have
   to be fixed and tested first, which the roadmap did not count.
3. **The test surface is larger than one day.** Nine device and row combinations, interrupted
   migration, passkey wraps, two widths. There is no passkey journey today, journeys run by hand
   (M14), and the owner must test on a real phone with a copy of real data before the merge.
4. **Waiting costs little.** The sign-in secret is already a separate derivation (M4), and sync
   already needs 8 characters at setup (M5). The urgent gap is the 4 character device passcode, the
   numeric keypad and the try counter. Stage B small closes those on Sunday.

Recommendation: run Stage B small on Sunday with the three additions in section 10. Build the full
change after the 16th on the three day schedule in section 11, behind the `vault_v2` flag.
