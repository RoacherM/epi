// Offline probe: Git review bases vs the existing preview ledger; no user repository is changed.
// Run: node scripts/probes/review-baselines.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ChangeLedger } from '../../dist/extensions/preview/ledger.js';

const scratch=mkdtempSync(join(tmpdir(),'epi-review-probe-'));
try {
  const home=join(scratch,'home'), cwd=join(scratch,'repo');
  mkdirSync(home); mkdirSync(cwd);
  const env={PATH:process.env.PATH,HOME:home,EPI_HOME:join(home,'.epi'),GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'};
  const git=(...args)=>execFileSync('git',args,{cwd,env,encoding:'utf8'});
  git('init','-q'); git('config','user.name','Offline Probe'); git('config','user.email','probe@example.invalid');
  const put=(p,s)=>writeFileSync(join(cwd,p),s);
  put('a.ts','base\n'); put('old name.ts','rename\n');
  git('add','.'); git('-c','commit.gpgsign=false','commit','-qm','base');
  put('a.ts','staged\n'); git('add','--','a.ts');
  // This modification exists before the agent first touches the file.
  put('a.ts','pre-existing local change\n');
  const ledger=new ChangeLedger(); ledger.onAgentStart();
  ledger.onToolCall('edit',{path:'a.ts'},cwd); put('a.ts','agent change\n');
  // Shell/external changes bypass write/edit hooks.
  put('shell only.ts','shell edit\n');
  renameSync(join(cwd,'old name.ts'),join(cwd,'new name.ts'));
  git('add','-A','--','old name.ts','new name.ts');
  put('binary.bin',Buffer.from([0,1,2,3]));

  assert.equal(git('show','HEAD:a.ts'),'base\n');
  assert.equal(git('show',':0:a.ts'),'staged\n');
  assert.equal(readFileSync(join(cwd,'a.ts'),'utf8'),'agent change\n');
  assert.equal(ledger.changes('session')[0].before.text,'pre-existing local change\n');
  const status=git('status','--porcelain=v2','-z','--untracked-files=all');
  assert.ok(status.includes(' MM '));
  assert.ok(status.includes('new name.ts\0old name.ts\0'));
  assert.ok(status.includes('? shell only.ts\0'));
  assert.ok(status.includes('? binary.bin\0'));
  assert.deepEqual(ledger.changes('session').map(c=>c.path),[join(cwd,'a.ts')]);
  assert.equal(new ChangeLedger().changes('session').length,0,'ledger has no replay state');
  const staged=git('diff','--cached','--no-ext-diff','--no-textconv','--','a.ts');
  const unstaged=git('diff','--no-ext-diff','--no-textconv','--','a.ts');
  assert.ok(staged.includes('+staged')); assert.ok(!staged.includes('+agent change'));
  assert.ok(unstaged.includes('-staged')); assert.ok(unstaged.includes('+agent change'));

  // A review note at line 2 becomes unsafe after a new line is inserted.
  const sha=(s)=>createHash('sha256').update(s).digest('hex');
  const reviewed='header\nconst target = true;\ntail\n';
  const anchor={side:'new',line:2,hash:sha(reviewed),quote:'const target = true;'};
  const later='inserted\n'+reviewed;
  assert.notEqual(later.split('\n')[anchor.line-1],anchor.quote);
  assert.notEqual(sha(later),anchor.hash);
  console.log(JSON.stringify({checks:'HEAD/index/worktree/ledger; rename with spaces; untracked; binary entry; replay gap; stale line anchor: PASS',
    bases:{head:'base',index:'staged',firstTouch:'pre-existing local change',worktree:'agent change'},
    ledgerFiles:1,gitStatus:status.split('\0').filter(Boolean).map(s=>s.replace(/\b[0-9a-f]{40,64}\b/g,'<oid>')),
    noteAfterInsert:'snapshot changed: line 2 is no longer the reviewed text'},null,2));
} finally {rmSync(scratch,{recursive:true,force:true});}
