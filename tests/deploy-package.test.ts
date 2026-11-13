import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { globMatch, matchesPackagePatterns, selectPackageFiles } from '@/lib/deploy/serverless/package';

describe('package.patterns', () => {
  it('matches ** as descendants and * as a single segment', () => {
    expect(globMatch('handlers/binding/create.py', 'handlers/**')).toBe(true);
    expect(globMatch('handlers/create.py', 'handlers/**')).toBe(true);
    expect(globMatch('services/foo.py', 'handlers/**')).toBe(false);
    expect(globMatch('handlers_ext/foo.py', 'handlers/**')).toBe(false);
    expect(globMatch('requirements.txt', 'requirements.txt')).toBe(true);
    expect(globMatch('utils/a.py', 'utils/*')).toBe(true);
    expect(globMatch('utils/a/b.py', 'utils/*')).toBe(false);
  });

  it('keeps only include patterns and drops bangs', () => {
    const patterns = [
      'handlers/**',
      'services/**',
      'utils/**',
      '!.git/**',
      '!tests/**',
      '!node_modules/**',
      '!requirements.txt',
    ];
    expect(matchesPackagePatterns('handlers/binding/create.py', patterns)).toBe(true);
    expect(matchesPackagePatterns('services/x.py', patterns)).toBe(true);
    expect(matchesPackagePatterns('utils/y.py', patterns)).toBe(true);
    expect(matchesPackagePatterns('tests/test_x.py', patterns)).toBe(false);
    expect(matchesPackagePatterns('requirements.txt', patterns)).toBe(false);
    expect(matchesPackagePatterns('gushwork/huge.bin', patterns)).toBe(false);
    expect(matchesPackagePatterns('cf-workers/src.js', patterns)).toBe(false);
  });

  it('with only excludes, packs everything else', () => {
    expect(matchesPackagePatterns('src/a.py', ['!tests/**'])).toBe(true);
    expect(matchesPackagePatterns('tests/a.py', ['!tests/**'])).toBe(false);
  });

  it('selectPackageFiles skips heavy dirs and honors patterns', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-pat-'));
    fs.mkdirSync(path.join(root, 'handlers', 'binding'), { recursive: true });
    fs.mkdirSync(path.join(root, 'services'), { recursive: true });
    fs.mkdirSync(path.join(root, 'utils'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(root, 'gushwork'), { recursive: true });
    fs.writeFileSync(path.join(root, 'handlers', 'binding', 'create.py'), '#');
    fs.writeFileSync(path.join(root, 'services', 'x.py'), '#');
    fs.writeFileSync(path.join(root, 'utils', 'y.py'), '#');
    fs.writeFileSync(path.join(root, 'tests', 'test_x.py'), '#');
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), '#');
    fs.writeFileSync(path.join(root, 'gushwork', 'huge.bin'), '#');
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'foo');

    const files = selectPackageFiles(root, {
      patterns: ['handlers/**', 'services/**', 'utils/**', '!tests/**', '!node_modules/**', '!requirements.txt'],
    }).sort();
    expect(files).toEqual(['handlers/binding/create.py', 'services/x.py', 'utils/y.py']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
