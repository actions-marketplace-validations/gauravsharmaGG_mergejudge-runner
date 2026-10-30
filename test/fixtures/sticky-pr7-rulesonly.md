<!-- mergejudge:summary -->
## ⚖️ MergeJudge

**Overall lane:** 🟡 `review` · 6 of 6 files need a human look

*`review` is advisory: the `mergejudge/lane` check stays neutral; only `block` fails it.*

6 files changed, \+151 / -3 lines.

### What to check

Nothing specific flagged.

<details><summary><b>Why this lane?</b> 6 files matched 4 rules</summary>

- **Protected path:** `.github/workflows/ci.yml`, `.github/workflows/shepherd.yml`, `.mergejudge.yml`
- **MergeJudge config file \(.mergejudge.yml\):** `.mergejudge.yml`
- **Dependency manifest or lockfile change:** `package.json`
- **Code file:** `scripts/lint.mjs`, `test/math.test.js`

</details>

<details><summary><b>Files (6):</b> 6 review</summary>

- 🟡 `.github/workflows/ci.yml` — Protected path
- 🟡 `.github/workflows/shepherd.yml` — Protected path
- 🟡 `.mergejudge.yml` — MergeJudge config file \(.mergejudge.yml\), Protected path
- 🟡 `package.json` — Dependency manifest or lockfile change
- 🟡 `scripts/lint.mjs` — Code file
- 🟡 `test/math.test.js` — Code file

</details>

### Not checked

- Free AI review skipped: monthly free AI review limit reached for this repository; rules-only. Add [your provider key](https://app.mergejudge.si/app/i/170944538/keys) to keep AI reviews.

---

<!-- mergejudge:feedback -->
**Was this review right?**

- [ ] Correct
- [ ] Too lenient
- [ ] Too strict
- [ ] Wrong reason
- [ ] Missed something

<sub>Tick a box or comment <code>/mergejudge learn &lt;note&gt;</code>. Feedback is stored on the <code>mergejudge-learning</code> branch, never in this PR.</sub>

<sub>rules-only · ~0 tokens · MergeJudge doesn't merge PRs itself. · To make <code>block</code> stop merges, require <code>mergejudge/lane</code> in branch protection.</sub>

<details><summary><sub>Run details</sub></summary>

<sub>Mode: rules-only</sub>

</details>