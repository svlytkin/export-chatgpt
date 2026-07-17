'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('storage', () => {
  let PATHS, ensureBaselineSemantics, ensureDir, loadIndex, saveIndex, loadProgress, saveProgress;
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));

    const config = require('../../lib/config');
    config.CONFIG.outputDir = tmpDir;
    config.initPaths();

    ({ PATHS } = config);
    ({ ensureBaselineSemantics, ensureDir, loadIndex, saveIndex, loadProgress, saveProgress } = require('../../lib/storage'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ensureDir', () => {
    test('creates directory if it does not exist', () => {
      const dir = path.join(tmpDir, 'new-dir');
      ensureDir(dir);
      expect(fs.existsSync(dir)).toBe(true);
    });

    test('does nothing if directory already exists', () => {
      ensureDir(tmpDir);
      expect(fs.existsSync(tmpDir)).toBe(true);
    });

    test('creates nested directories', () => {
      const dir = path.join(tmpDir, 'a', 'b', 'c');
      ensureDir(dir);
      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  describe('loadIndex / saveIndex', () => {
    test('returns empty Map when no index file exists', () => {
      const index = loadIndex();
      expect(index).toBeInstanceOf(Map);
      expect(index.size).toBe(0);
    });

    test('round-trips index data', () => {
      const data = new Map([
        ['id1', { id: 'id1', title: 'Conv 1' }],
        ['id2', { id: 'id2', title: 'Conv 2' }],
      ]);
      saveIndex(data);
      const loaded = loadIndex();
      expect(loaded.size).toBe(2);
      expect(loaded.get('id1').title).toBe('Conv 1');
      expect(loaded.get('id2').title).toBe('Conv 2');
    });

    test('returns empty Map for corrupted index file', () => {
      fs.writeFileSync(PATHS.indexFile, 'not json');
      const spy = jest.spyOn(console, 'log').mockImplementation();
      const index = loadIndex();
      expect(index.size).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Warning'));
      spy.mockRestore();
    });
  });

  describe('loadProgress / saveProgress', () => {
    test('returns default progress when no file exists', () => {
      const progress = loadProgress();
      expect(progress).toEqual({
        baselineSemanticsVersion: 1,
        indexingComplete: false,
        lastOffset: 0,
        downloadedIds: [],
        projectsIndexingComplete: false,
        projectsLastCursor: null,
        projects: {},
        downloadedFileIds: [],
        failedFileIds: {},
        skippedFileIds: {},
      });
    });

    test('round-trips progress data', () => {
      const data = {
        indexingComplete: true,
        lastOffset: 100,
        downloadedIds: ['id1', 'id2'],
        projectsIndexingComplete: true,
        projectsLastCursor: 'cursor123',
        projects: { proj1: { downloadedIds: ['c1'] } },
        downloadedFileIds: ['f1'],
        failedFileIds: { 'f2': 'file_not_found' },
        skippedFileIds: { 'f3': { reason: 'size_limit' } },
      };
      saveProgress(data);
      const loaded = loadProgress();
      expect(loaded).toEqual(data);
    });

    test('adds missing fields to legacy progress data', () => {
      const legacyData = {
        indexingComplete: true,
        lastOffset: 50,
        downloadedIds: ['id1'],
      };
      fs.writeFileSync(PATHS.progressFile, JSON.stringify(legacyData));
      const loaded = loadProgress();
      expect(loaded.projects).toEqual({});
      expect(loaded.downloadedFileIds).toEqual([]);
      expect(loaded.failedFileIds).toEqual({});
      expect(loaded.skippedFileIds).toEqual({});
      expect(loaded.projectsIndexingComplete).toBe(false);
      expect(loaded.projectsLastCursor).toBeNull();
    });

    test('upgrades legacy active and project baselines from the beginning', () => {
      const progress = {
        indexingComplete: true,
        lastOffset: 84,
        downloadedIds: [],
        projectsIndexingComplete: true,
        projectsLastCursor: 'project-page-3',
        projects: {
          alpha: { indexingComplete: true, lastCursor: 'chat-page-4', downloadedIds: ['c1'] },
          beta: { indexingComplete: false, lastCursor: 'chat-page-2', downloadedIds: [] },
        },
        downloadedFileIds: [],
        failedFileIds: {},
        skippedFileIds: {},
      };

      expect(ensureBaselineSemantics(progress)).toBe(true);
      expect(progress).toMatchObject({
        baselineSemanticsVersion: 1,
        indexingComplete: false,
        lastOffset: 0,
        projectsIndexingComplete: true,
        projectsLastCursor: 'project-page-3',
        projects: {
          alpha: { indexingComplete: false, lastCursor: null, downloadedIds: ['c1'] },
          beta: { indexingComplete: false, lastCursor: null, downloadedIds: [] },
        },
      });
      expect(JSON.parse(fs.readFileSync(PATHS.progressFile, 'utf8'))).toMatchObject({
        baselineSemanticsVersion: 1,
        indexingComplete: false,
        lastOffset: 0,
      });
      expect(ensureBaselineSemantics(progress)).toBe(false);
    });

    test('returns default for corrupted progress file', () => {
      fs.writeFileSync(PATHS.progressFile, '{broken');
      const progress = loadProgress();
      expect(progress.indexingComplete).toBe(false);
      expect(progress.downloadedIds).toEqual([]);
    });
  });
});
