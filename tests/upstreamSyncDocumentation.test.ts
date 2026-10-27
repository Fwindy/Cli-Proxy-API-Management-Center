import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(new URL('../.github/workflows/sync-upstream.yml', import.meta.url), 'utf8')
) as {
  jobs: { 'sync-upstream': { steps: { id?: string; run?: string }[] } };
};
const mergeScript = workflow.jobs['sync-upstream'].steps.find((step) => step.id === 'merge')?.run;
if (!mergeScript) throw new Error('The upstream workflow must define its merge step.');

const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
const bash = process.platform === 'win32' ? resolve(gitExecPath, '../../../bin/bash.exe') : 'bash';
const localGuidance = '# Local Codex instructions\nKeep the fork monitoring features.\n';

function withRepository(
  options: {
    claude?: 'added' | 'changed' | 'removed';
    removeAgents?: boolean;
    collision?: boolean;
  },
  run: (fixture: {
    root: string;
    git: (...args: string[]) => string;
    merge: () => { status: number | null; output: string };
    outputPath: string;
  }) => void
) {
  const root = mkdtempSync(join(tmpdir(), 'upstream-docs-'));
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) {
    throw new Error('Refusing to use a fixture outside the temporary directory.');
  }
  const globalConfig = join(root, 'empty-git-config');
  const outputPath = join(root, 'github-output');
  writeFileSync(globalConfig, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
    delete env[key];
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error}`);
    }
    return result.stdout.trim();
  };
  const write = (path: string, content: string) => writeFileSync(join(root, path), content);
  const commit = (message: string) => {
    git('add', '--force', 'AGENTS.md', 'README.md', 'code.txt', '.gitignore');
    if (existsSync(join(root, 'CLAUDE.md'))) git('add', '--force', 'CLAUDE.md');
    git('commit', '--quiet', '-m', message);
  };

  try {
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Sync fixture');
    git('config', 'user.email', 'sync-fixture@example.invalid');
    git('config', 'core.autocrlf', 'false');
    write('.git/info/exclude', '/AGENTS.override.md\n');
    write('.gitignore', '/github-output\n/empty-git-config\n');
    write('AGENTS.md', '# Original shared guidance\n');
    write('README.md', '# Original README\n');
    write('code.txt', 'original code\n');
    if (options.claude === 'changed' || options.claude === 'removed') {
      write('CLAUDE.md', '# Original Claude guidance\n');
    }
    commit('Initial upstream state');

    git('checkout', '--quiet', '-b', 'incoming');
    write('AGENTS.md', '# Updated upstream guidance\n');
    write('README.md', '# Updated upstream README\n');
    write('code.txt', 'updated upstream code\n');
    if (options.claude === 'added' || options.claude === 'changed') {
      write('CLAUDE.md', '# Updated upstream Claude guidance\n');
    } else if (options.claude === 'removed') {
      git('rm', '--quiet', 'CLAUDE.md');
    }
    commit('Update upstream');
    if (options.removeAgents) {
      git('rm', '--quiet', 'AGENTS.md');
      git('commit', '--quiet', '-m', 'Remove upstream guidance');
    }
    if (options.collision) {
      write('AGENTS.override.md', '# Unexpected upstream override\n');
      git('add', '--force', 'AGENTS.override.md');
      git('commit', '--quiet', '-m', 'Add colliding upstream file');
    }
    git('update-ref', 'refs/remotes/upstream/main', 'HEAD');

    git('checkout', '--quiet', 'main');
    write('AGENTS.md', '# Obsolete fork guidance\n');
    write('CLAUDE.md', '# Obsolete local Claude guidance\n');
    write('README.md', '# Fork features and plugin compatibility\n');
    commit('Fork changes');
    write('AGENTS.override.md', localGuidance);

    run({
      root,
      git,
      outputPath,
      merge: () => {
        const result = spawnSync(bash, ['-c', mergeScript], {
          cwd: root,
          env: { ...env, GITHUB_OUTPUT: outputPath },
          encoding: 'utf8',
        });
        if (result.error) throw result.error;
        return { status: result.status, output: result.stdout + result.stderr };
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('upstream documentation sync', () => {
  for (const claude of [undefined, 'added', 'changed', 'removed'] as const) {
    test(`uses upstream shared guidance when CLAUDE.md is ${claude ?? 'absent'}`, () => {
      withRepository({ claude }, ({ root, git, merge, outputPath }) => {
        const result = merge();
        expect(result.output).toContain('Merge upstream/main');
        expect(result.status).toBe(0);
        expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# Updated upstream guidance\n');
        if (claude === 'added' || claude === 'changed') {
          expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(
            '# Updated upstream Claude guidance\n'
          );
        } else {
          expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
          expect(git('ls-files', '--', 'CLAUDE.md')).toBe('');
        }
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(
          '# Fork features and plugin compatibility\n'
        );
        expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('updated upstream code\n');
        expect(readFileSync(join(root, 'AGENTS.override.md'), 'utf8')).toBe(localGuidance);
        expect(git('ls-files', '--', 'AGENTS.override.md')).toBe('');
        expect(git('status', '--porcelain')).toBe('');
        expect(git('diff', '--name-only', '--diff-filter=U')).toBe('');
        expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
        expect(readFileSync(outputPath, 'utf8')).toContain('changed=true');
      });
    });
  }

  test('follows upstream removal of AGENTS.md without removing the local override', () => {
    withRepository({ removeAgents: true }, ({ root, git, merge }) => {
      expect(merge().status).toBe(0);
      expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      expect(git('ls-files', '--', 'AGENTS.md')).toBe('');
      expect(readFileSync(join(root, 'AGENTS.override.md'), 'utf8')).toBe(localGuidance);
    });
  });

  test('does not create another commit when upstream is already merged', () => {
    withRepository({}, ({ root, git, merge, outputPath }) => {
      expect(merge().status).toBe(0);
      const previousHead = git('rev-parse', 'HEAD');
      writeFileSync(outputPath, '');
      expect(merge().status).toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(previousHead);
      expect(readFileSync(outputPath, 'utf8')).toBe('changed=false\n');
      expect(readFileSync(join(root, 'AGENTS.override.md'), 'utf8')).toBe(localGuidance);
    });
  });

  test('refuses to overwrite an ignored local override added by upstream', () => {
    withRepository({ collision: true }, ({ root, git, merge }) => {
      const previousHead = git('rev-parse', 'HEAD');
      const result = merge();
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('AGENTS.override.md is reserved for local instructions');
      expect(git('rev-parse', 'HEAD')).toBe(previousHead);
      expect(readFileSync(join(root, 'AGENTS.override.md'), 'utf8')).toBe(localGuidance);
      expect(git('ls-files', '--', 'AGENTS.override.md')).toBe('');
    });
  });

  test('leaves business code conflicts for manual resolution', () => {
    withRepository({}, ({ root, git, merge }) => {
      writeFileSync(join(root, 'code.txt'), 'fork code\n');
      git('add', 'code.txt');
      git('commit', '--quiet', '-m', 'Fork code change');
      const previousHead = git('rev-parse', 'HEAD');
      const result = merge();
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Merge conflicts require manual resolution:');
      expect(git('diff', '--name-only', '--diff-filter=U')).toBe('code.txt');
      expect(git('rev-parse', 'HEAD')).toBe(previousHead);
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# Updated upstream guidance\n');
      expect(readFileSync(join(root, 'AGENTS.override.md'), 'utf8')).toBe(localGuidance);
    });
  });
});
