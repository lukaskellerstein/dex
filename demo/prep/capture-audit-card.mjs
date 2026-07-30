#!/usr/bin/env node
/**
 * Regenerate section 06's code card from the project's real state.
 *
 * Section 06 claims "no database — every run is a JSON file and every stage is
 * a commit you can grep". The card must therefore show real output, and it must
 * show output from the run the video actually recorded: every reset mints new
 * SHAs, so a card captured from an earlier validation run would print commit
 * hashes that do not appear in the timeline the viewer just watched.
 *
 * Run this after the recorded run finishes and before the final render.
 *
 * usage: node demo/prep/capture-audit-card.mjs [projectDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const storyboardPath = path.resolve(here, '..', 'storyboard.json');
const projectDir =
  process.argv[2] ?? path.join(process.env.HOME, 'Projects/Github/lukaskellerstein/dex-ecommerce');

const git = (...args) =>
  execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' }).trimEnd();

// Name the run branch explicitly rather than logging HEAD or --all. HEAD is wrong
// because promoting squash-merges the run into a single commit on main, and --all is
// worse: it sweeps in every other run branch in the repo, so "commits in this run"
// would count someone else's history.
const runBranch = git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/dex')
  .split('\n')
  .filter(Boolean)[0];
if (!runBranch) {
  console.error(`no dex/* run branch in ${projectDir} — run the loop first`);
  process.exit(1);
}

// Full --oneline subjects run to ~107 characters and clip in the code panel, so
// the card shows the checkpoint tags instead. The displayed command is the real
// pipeline that produces exactly these lines — nothing is reformatted by hand.
const subjects = git('log', runBranch, '--format=%s');
const tags = subjects
  .split('\n')
  .map((line) => line.match(/\[checkpoint:[a-z_]+:[0-9]+\]/)?.[0])
  .filter(Boolean);
if (!tags.length) {
  console.error(`no checkpoint commits on ${runBranch} — run the loop first`);
  process.exit(1);
}
const log = tags.slice(0, 5).join('\n');
const total = tags.length;

const runsDir = path.join(projectDir, '.dex', 'runs');
if (!fs.existsSync(runsDir)) {
  console.error(`no ${runsDir} — run the loop first`);
  process.exit(1);
}
const newest = fs
  .readdirSync(runsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, mtime: fs.statSync(path.join(runsDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];
if (!newest) {
  console.error(`no run records in ${runsDir}`);
  process.exit(1);
}

const record = JSON.parse(fs.readFileSync(path.join(runsDir, newest.f), 'utf8'));
const summary = JSON.stringify({
  status: record.status,
  mode: record.mode,
  agentRuns: record.agentRuns?.length ?? 0,
});

const content = [
  `$ git log ${runBranch} --format='%s' \\`,
  "    | grep -oE '\\[checkpoint:[a-z_]+:[0-9]+\\]' | head -5",
  log,
  `# ${total} checkpoint commits in this run`,
  '',
  "$ ls -t .dex/runs/*.json | head -1 | xargs jq -c \\",
  "    '{status, mode, agentRuns: (.agentRuns|length)}'",
  summary,
  '',
].join('\n');

const storyboard = JSON.parse(fs.readFileSync(storyboardPath, 'utf8'));
// Matched on the slug, not the full id: the ordinal moves whenever a section is
// inserted ahead of this one (insert-section.mjs), and a hard-coded "07-audit" would
// then silently update nothing.
const section = storyboard.sections.find((s) => s.id.endsWith('-audit'));
if (!section) {
  console.error('storyboard has no *-audit section');
  process.exit(1);
}
// The header is a caption for what is on the card, and the card is a shell session —
// naming the run-record file here read as "you are looking at that JSON", which is not
// what the panel shows. The run record is one of the two things the session queries.
section.code = { file: `shell — ${path.basename(projectDir)}, after the recorded run`, content };
fs.writeFileSync(storyboardPath, `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');

const widest = Math.max(...content.split('\n').map((l) => l.length));
console.log(`updated section ${section.id} from ${projectDir}`);
console.log(content.replace(/^/gm, '  '));
if (widest > 78) {
  console.warn(`WARNING: widest line is ${widest} chars — may clip or wrap in the code panel`);
}
