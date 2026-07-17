'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, PATHS, verboseLog } = require('./config');
const {
  ensureBaselineSemantics,
  loadIndex,
  saveIndex,
  loadProgress,
  saveProgress,
  saveStatus,
  ensureDir,
} = require('./storage');
const { sanitizeFilename, sanitizeProjectFolder, getDatePrefix, conversationToMarkdown } = require('./formatter');
const { fetchConversation, fetchConversationListIncremental, fetchProjectList, fetchProjectConversations } = require('./api');
const {
  downloadConversationFiles,
  downloadProjectFiles,
  retryPendingFiles,
} = require('./downloader');
const { throttle, restorePacingSnapshot, getPacingStats, resetSessionPacingStats } = require('./auth');

// Shared between run() and the conversation loop so saveStatus can record a
// stable start time regardless of where it's called from.
let runStartTime = null;
const UPDATE_HORIZON_CAP = 50;

function progressWrite(message) {
  const output = CONFIG.nonInteractive ? process.stderr : process.stdout;
  output.write(message);
}

function conversationTimestamp(conv) {
  const value = conv.update_time ?? conv.create_time ?? 0;
  if (typeof value === 'number') return value;

  const parsedNumber = Number(value);
  if (!Number.isNaN(parsedNumber)) return parsedNumber;

  const parsedDate = Date.parse(value);
  return Number.isNaN(parsedDate) ? 0 : parsedDate / 1000;
}

function findExistingConversationFiles(conv) {
  const shortId = conv.id.substring(0, 13);
  const files = [];

  const collect = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.includes(shortId) && (f.endsWith('.json') || f.endsWith('.md'))) {
        files.push(path.join(dir, f));
      }
    }
  };

  collect(PATHS.jsonDir);
  collect(PATHS.mdDir);
  if (fs.existsSync(PATHS.projectsDir)) {
    for (const entry of fs.readdirSync(PATHS.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      collect(path.join(PATHS.projectsDir, entry.name, 'json'));
      collect(path.join(PATHS.projectsDir, entry.name, 'markdown'));
    }
  }

  return files;
}

function readExportedUpdateTime(filePath) {
  try {
    if (filePath.endsWith('.json')) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')).update_time ?? null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/^update_time:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function normalizedTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const timestamp = conversationTimestamp({ update_time: value });
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function sameTimestamp(left, right) {
  const a = normalizedTimestamp(left);
  const b = normalizedTimestamp(right);
  return a !== null && b !== null && Math.abs(a - b) < 0.001;
}

function markdownMetadata(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const end = content.indexOf('\n---', 4);
  if (!content.startsWith('---\n') || end < 0) throw new Error('invalid Markdown frontmatter');
  const frontmatter = content.slice(4, end);
  return {
    id: frontmatter.match(/^id:\s*(.+)$/m)?.[1]?.trim() || null,
    update_time: frontmatter.match(/^update_time:\s*(.+)$/m)?.[1]?.trim() || null,
    content,
  };
}

function artifactContainers() {
  const containers = [{ jsonDir: PATHS.jsonDir, mdDir: PATHS.mdDir, filesDir: PATHS.filesDir }];
  if (fs.existsSync(PATHS.projectsDir)) {
    for (const entry of fs.readdirSync(PATHS.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(PATHS.projectsDir, entry.name);
      containers.push({
        jsonDir: path.join(projectDir, 'json'),
        mdDir: path.join(projectDir, 'markdown'),
        filesDir: path.join(projectDir, 'files'),
      });
    }
  }
  return containers;
}

function collectExportedArtifactPairs() {
  const candidates = new Map();
  for (const container of artifactContainers()) {
    const jsonNames = fs.existsSync(container.jsonDir) ? fs.readdirSync(container.jsonDir) : [];
    for (const name of jsonNames) {
      if (!name.endsWith('.json')) continue;
      const stem = name.slice(0, -5);
      const jsonPath = path.join(container.jsonDir, name);
      const markdownPath = path.join(container.mdDir, `${stem}.md`);
      try {
        const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const id = json.id || json.conversation_id;
        if (typeof id !== 'string') continue;
        const markdown = fs.existsSync(markdownPath) ? markdownMetadata(markdownPath) : null;
        const candidate = {
          id,
          jsonPath,
          markdownPath: markdown && markdown.id === id ? markdownPath : null,
          filesDir: container.filesDir,
          jsonUpdateTime: json.update_time,
          markdownUpdateTime: markdown?.id === id ? markdown.update_time : null,
          atomic: markdown?.id === id && sameTimestamp(json.update_time, markdown.update_time),
        };
        const prior = candidates.get(id);
        const candidateTime = normalizedTimestamp(candidate.jsonUpdateTime);
        const priorTime = normalizedTimestamp(prior?.jsonUpdateTime);
        if (
          !prior || candidateTime > priorTime ||
          (candidateTime === priorTime && candidate.atomic && !prior.atomic)
        ) {
          candidates.set(id, candidate);
        }
      } catch {}
    }

    const markdownNames = fs.existsSync(container.mdDir) ? fs.readdirSync(container.mdDir) : [];
    for (const name of markdownNames) {
      if (!name.endsWith('.md')) continue;
      try {
        const markdownPath = path.join(container.mdDir, name);
        const markdown = markdownMetadata(markdownPath);
        if (!markdown.id || candidates.has(markdown.id)) continue;
        candidates.set(markdown.id, {
          id: markdown.id,
          jsonPath: null,
          markdownPath,
          filesDir: container.filesDir,
          jsonUpdateTime: null,
          markdownUpdateTime: markdown.update_time,
          atomic: false,
        });
      } catch {}
    }
  }
  return candidates;
}

function collectExportedArtifactTimes() {
  const exported = new Map();
  for (const [id, pair] of collectExportedArtifactPairs()) {
    exported.set(id, {
      json: pair.jsonUpdateTime,
      markdown: pair.markdownUpdateTime,
      atomic: pair.atomic,
    });
  }
  return exported;
}

function conversationNeedsUpdate(conv, exportedArtifactTimes = null) {
  if (exportedArtifactTimes) {
    const exported = exportedArtifactTimes.get(conv.id);
    if (!exported) return true;

    const targetTimestamp = conversationTimestamp(conv);
    const hasCurrent = (kind) => {
      const updateTime = exported[kind];
      return !!updateTime && conversationTimestamp({ update_time: updateTime }) >= targetTimestamp;
    };

    if (CONFIG.exportFormat === 'json') return !hasCurrent('json');
    if (CONFIG.exportFormat === 'markdown') return !hasCurrent('markdown');
    return !exported.atomic || !hasCurrent('json') || !hasCurrent('markdown');
  }

  const files = findExistingConversationFiles(conv);
  if (files.length === 0) return true;

  const targetTimestamp = conversationTimestamp(conv);
  return !files.some(file => {
    const exportedUpdateTime = readExportedUpdateTime(file);
    if (!exportedUpdateTime) return false;
    return conversationTimestamp({ update_time: exportedUpdateTime }) >= targetTimestamp;
  });
}

function updateMaxDownloadWindow(conversations, exportedArtifactTimes) {
  let limit = Math.min(CONFIG.maxConversations, UPDATE_HORIZON_CAP);
  const scanLimit = Math.min(conversations.length, UPDATE_HORIZON_CAP);
  let furthestPendingRank = 0;

  for (let i = 0; i < scanLimit; i++) {
    if (conversationNeedsUpdate(conversations[i], exportedArtifactTimes)) {
      furthestPendingRank = i + 1;
    }
  }

  while (limit < furthestPendingRank) {
    const nextLimit = Math.min(limit + 5, UPDATE_HORIZON_CAP);
    console.log(`  Update window has pending conversation at rank ${furthestPendingRank}; expanding to ${nextLimit} conversations`);
    limit = nextLimit;
  }

  if (furthestPendingRank >= UPDATE_HORIZON_CAP && conversations.length > UPDATE_HORIZON_CAP) {
    const error = new Error(
      'UPDATE_DOWNLOAD_LIMIT_EXCEEDED: update mode still has unsynced conversations at 50; manual inspection or full refresh is required.'
    );
    error.partialKind = 'horizon';
    throw error;
  }

  const checkedTail = scanLimit - limit;
  if (checkedTail > 0) {
    console.log(`  Update tail closed at ${limit}: no pending conversations in next ${checkedTail} checked`);
  } else {
    console.log(`  Update tail closed at ${limit}: no more indexed conversations in checked range`);
  }

  return conversations.slice(0, limit);
}

function updateCatchupStats(conversations, exportedArtifactTimes) {
  let current = 0;
  let pending = 0;
  for (const conv of conversations) {
    if (conversationNeedsUpdate(conv, exportedArtifactTimes)) pending++;
    else current++;
  }
  return { current, pending };
}

function usesUnifiedProjectUpdateWindow() {
  return CONFIG.includeProjects &&
    !CONFIG.projectsOnly &&
    CONFIG.updateExisting &&
    CONFIG.maxConversations !== null;
}

function trackedDownloadCounts(progress) {
  const regularIds = new Set(progress.downloadedIds || []);
  const projectIds = new Set();

  for (const projectProgress of Object.values(progress.projects || {})) {
    for (const id of projectProgress?.downloadedIds || []) {
      projectIds.add(id);
    }
  }

  const totalIds = new Set([...regularIds, ...projectIds]);
  let projectOnly = 0;
  for (const id of projectIds) {
    if (!regularIds.has(id)) projectOnly++;
  }

  return {
    total: totalIds.size,
    regular: regularIds.size,
    projectOnly,
  };
}

async function exportConversations(accessToken, progress) {
  ensureDir(CONFIG.outputDir);
  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') ensureDir(PATHS.jsonDir);
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') ensureDir(PATHS.mdDir);

  const existingIndex = loadIndex();

  if (existingIndex.size > 0) {
    const counts = trackedDownloadCounts(progress);
    console.log(`Found existing index with ${existingIndex.size} conversations`);
    console.log(`   ${counts.total} tracked downloaded total (${counts.regular} regular, ${counts.projectOnly} project-only)\n`);
  }

  const activeMode = progress.indexingComplete ? 'incremental' : 'baseline';
  const conversationIndex = await fetchConversationListIncremental(accessToken, existingIndex, progress);
  const activeIndex = {
    mode: activeMode,
    completion: activeMode === 'baseline' ? 'end_of_list' : 'update_horizon_closed',
    known: Array.from(conversationIndex.values()).filter(conv => conv._archived === false).length,
  };

  if (conversationIndex.size === 0) {
    console.log('No conversations found.\n');
    return {
      success: 0, skip: 0, update: 0, error: 0, fileCount: 0,
      writtenIds: [], failed: [], activeIndex,
    };
  }

  console.log('Downloading conversations...\n');

  let conversations = Array.from(conversationIndex.values());
  if (CONFIG.convFilter) {
    conversations = conversations.filter(c => CONFIG.convFilter.has(c.id));
  }
  const updateMaxWindow = CONFIG.updateExisting && CONFIG.maxConversations !== null;
  if (updateMaxWindow) {
    const exportedArtifactTimes = collectExportedArtifactTimes();
    const fullStats = updateCatchupStats(conversations, exportedArtifactTimes);
    console.log(
      `Update state: found ${conversations.length} conversations; ${fullStats.current} already downloaded/current; ${fullStats.pending} need download/update`
    );
    conversations = conversations
      .sort((a, b) => conversationTimestamp(b) - conversationTimestamp(a));
    const window = updateMaxDownloadWindow(conversations, exportedArtifactTimes);
    const windowStats = updateCatchupStats(window, exportedArtifactTimes);
    console.log(
      `Update plan: will download ${windowStats.pending} now; scanned ${window.length} latest conversations; ${windowStats.current} already current in safety window`
    );
    conversations = window.filter(conv => conversationNeedsUpdate(conv, exportedArtifactTimes));
  }
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;
  let sessionDownloads = 0;
  const writtenIds = [];
  const failed = [];

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const progress_display = `[${i + 1}/${conversations.length}]`;

    if (!updateMaxWindow && CONFIG.maxConversations !== null && sessionDownloads >= CONFIG.maxConversations) {
      skipCount += conversations.length - i;
      break;
    }
    // 13-char prefix spans the full first UUID segment + dash + start of
    // second segment. 8 chars collided silently when many conversations
    // shared a timestamp-encoded prefix (bulk-archive assigns many IDs in
    // the same second), causing the existence check below to match any
    // collision-sharing file and silently skip all but one.
    const shortId = conv.id.substring(0, 13);

    if (!CONFIG.updateExisting) {
      if (progress.downloadedIds.includes(conv.id)) {
        skipCount++;
        continue;
      }

      const jsonDirExists = fs.existsSync(PATHS.jsonDir);
      if (jsonDirExists) {
        const existingFiles = fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(shortId));
        if (existingFiles.length > 0) {
          progress.downloadedIds.push(conv.id);
          saveProgress(progress);
          skipCount++;
          continue;
        }
      }
    }

    const isUpdate = CONFIG.updateExisting && (
      progress.downloadedIds.includes(conv.id) ||
      (fs.existsSync(PATHS.jsonDir) && fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(shortId)).length > 0)
    );

    try {
      await throttle('payload');
      const action = isUpdate ? '~' : '+';
      progressWrite(`${progress_display} ${action} "${(conv.title || 'Untitled').substring(0, 50)}"... `);

      const fullConversation = await fetchConversation(accessToken, conv.id);
      if (conv.update_time && conversationTimestamp(conv) > conversationTimestamp(fullConversation)) {
        fullConversation.update_time = conv.update_time;
      }
      if (!fullConversation.gizmo_id && (conv.gizmo_id || conv._project_id)) {
        fullConversation.gizmo_id = conv.gizmo_id || conv._project_id;
      }

      const filename = sanitizeFilename(conv.title || conv.id);
      const datePrefix = getDatePrefix(conv.create_time);
      const baseFilename = `${datePrefix}_${filename}_${shortId}`;

      if (isUpdate) {
        for (const dir of [PATHS.jsonDir, PATHS.mdDir]) {
          if (fs.existsSync(dir)) {
            const oldFiles = fs.readdirSync(dir).filter(f => f.includes(shortId));
            for (const f of oldFiles) fs.unlinkSync(path.join(dir, f));
          }
        }
      }

      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        fs.writeFileSync(path.join(PATHS.jsonDir, `${baseFilename}.json`), JSON.stringify(fullConversation, null, 2));
      }

      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        fs.writeFileSync(path.join(PATHS.mdDir, `${baseFilename}.md`), markdown);
      }

      if (CONFIG.downloadFiles) {
        const fc = await downloadConversationFiles(accessToken, fullConversation, PATHS.filesDir, progress, conv);
        fileCount += fc;
        saveIndex(conversationIndex);
      }

      if (!progress.downloadedIds.includes(conv.id)) {
        progress.downloadedIds.push(conv.id);
      }
      saveProgress(progress);
      saveStatus(progress, { startTime: runStartTime });

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;
      writtenIds.push(conv.id);
      sessionDownloads++;
    } catch (error) {
      if (error.authError) {
        if (error.cloudflareError) {
          console.log('\n\n  Cloudflare challenge during download. Progress saved.');
          console.log(`   Downloaded ${successCount} this session (${progress.downloadedIds.length} total).`);
          console.log('   Token is likely fine — wait (CF IP reputation decays over hours) or retry from a different public IP.\n');
        } else {
          console.log('\n\n  Token expired during download. Progress saved.');
          console.log(`   Downloaded ${successCount} this session (${progress.downloadedIds.length} total).`);
          console.log('   Run again with a fresh token to continue.\n');
        }
        throw error;
      }
      console.log(`error: ${error.message}`);
      verboseLog(`    Failed conversation ID: ${conv.id}`);
      errorCount++;
      failed.push({ id: conv.id, reason: error.message });
    }
  }

  return {
    success: successCount,
    skip: skipCount,
    update: updateCount,
    error: errorCount,
    fileCount,
    writtenIds,
    failed,
    activeIndex,
  };
}

async function exportProjectConversations(accessToken, project, progress) {
  const projectId = project.id;
  const projProgress = progress.projects[projectId];
  if (!projProgress) {
    return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0, writtenIds: [], failed: [] };
  }

  const folderName = sanitizeProjectFolder(project.name);
  const projectDir = path.join(PATHS.projectsDir, folderName);
  const jsonDir = path.join(projectDir, 'json');
  const mdDir = path.join(projectDir, 'markdown');
  const filesDir = path.join(projectDir, 'files');
  const projectConvIndexFile = path.join(projectDir, 'conversation-index.json');

  let conversations = [];
  if (fs.existsSync(projectConvIndexFile)) {
    try {
      conversations = JSON.parse(fs.readFileSync(projectConvIndexFile, 'utf8'));
    } catch (e) {
      return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0, writtenIds: [], failed: [] };
    }
  }

  if (conversations.length === 0) {
    return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0, writtenIds: [], failed: [] };
  }

  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') ensureDir(jsonDir);
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') ensureDir(mdDir);

  if (CONFIG.convFilter) {
    conversations = conversations.filter(c => CONFIG.convFilter.has(c.id));
  }
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;
  let sessionDownloads = 0;
  const writtenIds = [];
  const failed = [];

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    // 13-char prefix — see comment in exportConversations above for rationale.
    const shortId = conv.id.substring(0, 13);

    if (CONFIG.maxConversations !== null && sessionDownloads >= CONFIG.maxConversations) {
      skipCount += conversations.length - i;
      break;
    }

    if (!CONFIG.updateExisting && projProgress.downloadedIds.includes(conv.id)) {
      skipCount++;
      continue;
    }

    const isUpdate = CONFIG.updateExisting && projProgress.downloadedIds.includes(conv.id);

    try {
      await throttle('payload');
      const action = isUpdate ? '  ~' : '  +';
      progressWrite(`${action} "${(conv.title || 'Untitled').substring(0, 50)}"... `);

      const fullConversation = await fetchConversation(accessToken, conv.id);
      if (conv.update_time && conversationTimestamp(conv) > conversationTimestamp(fullConversation)) {
        fullConversation.update_time = conv.update_time;
      }

      const filename = sanitizeFilename(conv.title || conv.id);
      const datePrefix = getDatePrefix(conv.create_time);
      const baseFilename = `${datePrefix}_${filename}_${shortId}`;

      if (isUpdate) {
        for (const dir of [jsonDir, mdDir]) {
          if (fs.existsSync(dir)) {
            const oldFiles = fs.readdirSync(dir).filter(f => f.includes(shortId));
            for (const f of oldFiles) fs.unlinkSync(path.join(dir, f));
          }
        }
      }

      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        fs.writeFileSync(path.join(jsonDir, `${baseFilename}.json`), JSON.stringify(fullConversation, null, 2));
      }

      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        fs.writeFileSync(path.join(mdDir, `${baseFilename}.md`), markdown);
      }

      if (CONFIG.downloadFiles) {
        const fc = await downloadConversationFiles(accessToken, fullConversation, filesDir, progress, conv);
        fileCount += fc;
        fs.writeFileSync(projectConvIndexFile, JSON.stringify(conversations, null, 2));
      }

      if (!projProgress.downloadedIds.includes(conv.id)) {
        projProgress.downloadedIds.push(conv.id);
      }
      saveProgress(progress);

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;
      writtenIds.push(conv.id);
      sessionDownloads++;
    } catch (error) {
      if (error.authError) {
        const label = error.cloudflareError ? 'Cloudflare challenge' : 'Token expired';
        console.log(`\n  ${label} during project "${project.name}" export. Progress saved.`);
        throw error;
      }
      console.log(`error: ${error.message}`);
      errorCount++;
      failed.push({ id: conv.id, reason: error.message });
    }
  }

  return {
    success: successCount,
    skip: skipCount,
    update: updateCount,
    error: errorCount,
    fileCount,
    writtenIds,
    failed,
  };
}

function mergeProjectConversationIntoMainIndex(mainIndex, project, conv) {
  const projectId = conv.gizmo_id || project.id;
  const candidate = { ...conv, gizmo_id: projectId, _project_id: project.id };

  if (!mainIndex.has(conv.id)) {
    mainIndex.set(conv.id, candidate);
    return 'added';
  }

  const existing = mainIndex.get(conv.id);
  const updated = { ...existing, ...candidate };
  if (
    existing.update_time !== updated.update_time ||
    existing.title !== updated.title ||
    existing.gizmo_id !== updated.gizmo_id
  ) {
    mainIndex.set(conv.id, updated);
    return 'updated';
  }

  return 'unchanged';
}

async function mergeProjectConversationsIntoMainIndex(projects) {
  const mainIndex = loadIndex();
  let addedCount = 0;
  let updatedCount = 0;

  for (const project of projects) {
    const folderName = sanitizeProjectFolder(project.name);
    const projectConvIndexFile = path.join(PATHS.projectsDir, folderName, 'conversation-index.json');

    if (!fs.existsSync(projectConvIndexFile)) continue;

    let projectConvs;
    try {
      projectConvs = JSON.parse(fs.readFileSync(projectConvIndexFile, 'utf8'));
    } catch (e) {
      verboseLog(`  Warning: could not read project index for "${project.name}", skipping merge`);
      continue;
    }

    for (const conv of projectConvs) {
      const result = mergeProjectConversationIntoMainIndex(mainIndex, project, conv);
      if (result === 'added') addedCount++;
      if (result === 'updated') updatedCount++;
    }
  }

  if (addedCount > 0 || updatedCount > 0) {
    saveIndex(mainIndex);
    console.log(`  Merged ${addedCount} new / ${updatedCount} updated project conversation(s) into main index`);
  } else {
    verboseLog('  No new project conversations to merge into main index');
  }
}

async function mergeProjectConversationPreviewsIntoMainIndex(projects) {
  if (!projectPreviewContainersAvailable(projects)) {
    return false;
  }

  const mainIndex = loadIndex();
  let addedCount = 0;
  let updatedCount = 0;

  for (const project of projects) {
    for (const conv of project._conversationPreviews || []) {
      const result = mergeProjectConversationIntoMainIndex(mainIndex, project, conv);
      if (result === 'added') addedCount++;
      if (result === 'updated') updatedCount++;
    }
  }

  if (addedCount > 0 || updatedCount > 0) {
    saveIndex(mainIndex);
    console.log(`  Merged ${addedCount} new / ${updatedCount} updated project preview conversation(s) into main index`);
  } else {
    verboseLog('  No new project preview conversations to merge into main index');
  }

  return true;
}

function projectPreviewContainersAvailable(projects) {
  return projects.every(project => project._hasConversationPreviewContainer === true);
}

function projectPreviewHorizonClosed(projects, previewLimit) {
  const candidates = Array.from(loadIndex().values());
  for (const project of projects) {
    candidates.push(...(project._conversationPreviews || []));
  }

  if (candidates.length === 0) return true;

  const sorted = candidates
    .slice()
    .sort((a, b) => conversationTimestamp(b) - conversationTimestamp(a));
  const cutoffIndex = Math.min(UPDATE_HORIZON_CAP, sorted.length) - 1;
  const cutoff = conversationTimestamp(sorted[cutoffIndex]);

  for (const project of projects) {
    const previews = project._conversationPreviews || [];
    if (previews.length < previewLimit) continue;
    if (previews.length === 0) continue;

    let oldestPreview = previews[0];
    for (const preview of previews) {
      if (conversationTimestamp(preview) < conversationTimestamp(oldestPreview)) {
        oldestPreview = preview;
      }
    }
    const oldest = conversationTimestamp(oldestPreview);
    if (oldest >= cutoff) return false;
  }

  return true;
}

async function refreshProjectIndexes(accessToken, progress, existingProjects = null) {
  let projects = existingProjects || await fetchProjectList(accessToken, progress);
  if (CONFIG.projFilter) {
    projects = projects.filter(p => CONFIG.projFilter.has(p.id));
  }

  for (const project of projects) {
    const folderName = sanitizeProjectFolder(project.name);
    console.log(`  Refreshing project index: "${project.name}" (${folderName}/)`);
    await fetchProjectConversations(accessToken, project, progress);
  }

  await mergeProjectConversationsIntoMainIndex(projects);
  return projects;
}

async function refreshProjectPreviewIndexes(accessToken, progress) {
  let previewLimit = Math.min(CONFIG.maxConversations, UPDATE_HORIZON_CAP);
  let baselineProjectIds = null;
  while (previewLimit <= UPDATE_HORIZON_CAP) {
    console.log(`  Fetching project previews: conversations_per_gizmo=${previewLimit}`);
    let projects = await fetchProjectList(accessToken, progress, {
      conversationsPerGizmo: previewLimit,
    });
    if (CONFIG.projFilter) {
      projects = projects.filter(p => CONFIG.projFilter.has(p.id));
    }

    if (baselineProjectIds === null) {
      baselineProjectIds = new Set(
        projects
          .filter(project => !progress.projects[project.id]?.indexingComplete)
          .map(project => project.id)
      );
      const baselineProjects = projects.filter(project => baselineProjectIds.has(project.id));
      for (const project of baselineProjects) {
        const folderName = sanitizeProjectFolder(project.name);
        console.log(`  Building project baseline: "${project.name}" (${folderName}/)`);
        await fetchProjectConversations(accessToken, project, progress);
      }
      await mergeProjectConversationsIntoMainIndex(baselineProjects);
    }

    const incrementalProjects = projects.filter(project => !baselineProjectIds.has(project.id));
    if (incrementalProjects.length === 0) {
      return { projects, incrementalCompletion: 'not_run' };
    }

    if (!projectPreviewContainersAvailable(incrementalProjects)) {
      console.log('  Sidebar project conversation previews unavailable; falling back to full project refresh');
      await refreshProjectIndexes(accessToken, progress, incrementalProjects);
      return { projects, incrementalCompletion: 'update_horizon_closed' };
    }

    if (projectPreviewHorizonClosed(incrementalProjects, previewLimit)) {
      await mergeProjectConversationPreviewsIntoMainIndex(incrementalProjects);
      return { projects, incrementalCompletion: 'update_horizon_closed' };
    }
    if (previewLimit < UPDATE_HORIZON_CAP) {
      const nextPreviewLimit = Math.min(previewLimit + 5, UPDATE_HORIZON_CAP);
      console.log(`  Project preview horizon still open at ${previewLimit}; expanding to ${nextPreviewLimit}`);
      previewLimit = nextPreviewLimit;
    } else {
      break;
    }
  }

  const error = new Error(
    'PROJECT_PREVIEW_LIMIT_EXCEEDED: project preview horizon reached 50 in update mode; manual inspection or full refresh is required.'
  );
  error.partialKind = 'horizon';
  throw error;
}

// Scans every JSON file on disk (regular + project dirs) and returns the set
// of conversation IDs actually present.
function collectIdsOnDisk() {
  const onDisk = new Set();
  const scanJsonDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const id = data.id || data.conversation_id;
        if (id) onDisk.add(id);
      } catch {}
    }
  };
  scanJsonDir(PATHS.jsonDir);
  if (fs.existsSync(PATHS.projectsDir)) {
    for (const projFolder of fs.readdirSync(PATHS.projectsDir)) {
      scanJsonDir(path.join(PATHS.projectsDir, projFolder, 'json'));
    }
  }
  return onDisk;
}

// Returns IDs in progress.downloadedIds that have no corresponding file on disk.
function findSilentlySkippedConversations(progress) {
  const onDisk = collectIdsOnDisk();
  return (progress.downloadedIds || []).filter(id => !onDisk.has(id));
}

// Removes any IDs from progress.downloadedIds (and per-project arrays) that don't have a file
// on disk so the main export loop re-fetches them. Mutates progress; saves to disk.
function refetchMissing(progress) {
  const onDisk = collectIdsOnDisk();

  const topMissing = (progress.downloadedIds || []).filter(id => !onDisk.has(id));
  progress.downloadedIds = (progress.downloadedIds || []).filter(id => onDisk.has(id));

  let projMissingCount = 0;
  if (progress.projects) {
    for (const pid of Object.keys(progress.projects)) {
      const pp = progress.projects[pid];
      if (pp && Array.isArray(pp.downloadedIds)) {
        const before = pp.downloadedIds.length;
        pp.downloadedIds = pp.downloadedIds.filter(id => onDisk.has(id));
        projMissingCount += before - pp.downloadedIds.length;
      }
    }
  }

  const total = topMissing.length + projMissingCount;
  if (total === 0) {
    console.log('  No missing conversations — progress and disk are in sync.\n');
    return 0;
  }
  saveProgress(progress);
  console.log(`  Marked ${total} silently-skipped conversation(s) for re-download.\n`);
  return total;
}

function readKnownProjects() {
  if (!fs.existsSync(PATHS.projectIndexFile)) return [];
  try {
    const projects = JSON.parse(fs.readFileSync(PATHS.projectIndexFile, 'utf8'));
    return Array.isArray(projects) ? projects : [];
  } catch {
    return [];
  }
}

function failureSample(failures, limit = 10) {
  return failures.slice(0, limit).map(item => ({
    id: String(item.id || ''),
    reason: String(item.reason || 'unknown error'),
  }));
}

function uniqueFailures(failures) {
  const byId = new Map();
  for (const failure of failures) {
    if (!failure?.id) continue;
    byId.set(String(failure.id), {
      id: String(failure.id),
      reason: String(failure.reason || 'unknown error'),
    });
  }
  return Array.from(byId.values());
}

function relativeOutputPath(filePath) {
  return path.relative(CONFIG.outputDir, filePath).split(path.sep).join('/');
}

function pendingConversations(index) {
  const pairs = collectExportedArtifactPairs();
  const pending = [];
  for (const conv of index.values()) {
    const pair = pairs.get(conv.id);
    const target = normalizedTimestamp(conv.update_time ?? conv.create_time);
    let reason = null;
    if (!pair) reason = 'JSON/Markdown pair is missing';
    else if (!pair.atomic) reason = 'JSON and Markdown versions do not match';
    else if (normalizedTimestamp(pair.jsonUpdateTime) < target) reason = 'artifact version is older than index';
    if (reason) pending.push({ id: conv.id, reason });
  }
  return pending;
}

function fileTypeRequested(type) {
  if (!CONFIG.downloadFiles) return false;
  if (type === 'image') return CONFIG.downloadImages;
  if (type === 'canvas') return CONFIG.downloadCanvas;
  return CONFIG.downloadAttachments;
}

function fileArtifactState(filesDir, fileId) {
  if (!fs.existsSync(filesDir)) return 'missing';
  const names = fs.readdirSync(filesDir).filter(name => name === fileId || name.startsWith(`${fileId}.`));
  if (names.some(name => !name.includes('.skipped-download'))) return 'present';
  for (const name of names.filter(candidate => candidate.includes('.skipped-download'))) {
    try {
      const placeholder = JSON.parse(fs.readFileSync(path.join(filesDir, name), 'utf8'));
      if (placeholder.reason === 'size_limit') return 'allowed_skip';
    } catch {}
  }
  return 'missing';
}

function requiredFileRefs(index) {
  const refs = [];
  const addConversationRefs = (conversations, filesDir, skipProjectRows = false) => {
    for (const conv of conversations) {
      if (skipProjectRows && conv._project_id) continue;
      for (const ref of conv.files || []) {
        if (ref?.fileId && fileTypeRequested(ref.type)) refs.push({ id: ref.fileId, filesDir });
      }
    }
  };
  addConversationRefs(index.values(), PATHS.filesDir, true);

  for (const project of readKnownProjects()) {
    const projectDir = path.join(PATHS.projectsDir, sanitizeProjectFolder(project.name));
    const filesDir = path.join(projectDir, 'files');
    const conversationIndexFile = path.join(projectDir, 'conversation-index.json');
    if (fs.existsSync(conversationIndexFile)) {
      try {
        const conversations = JSON.parse(fs.readFileSync(conversationIndexFile, 'utf8'));
        if (Array.isArray(conversations)) addConversationRefs(conversations, filesDir);
      } catch {}
    }
    for (const file of project.files || []) {
      const id = file.file_id || file.id;
      if (id && fileTypeRequested(file.type)) refs.push({ id, filesDir });
    }
  }
  return refs;
}

function requiredFileFailures(progress, index) {
  const failures = new Map();
  for (const ref of requiredFileRefs(index)) {
    if (fileArtifactState(ref.filesDir, ref.id) !== 'missing') continue;
    const stored = progress.failedFileIds?.[ref.id];
    const runError = progress._runFileErrors?.[ref.id];
    const reason = runError || (
      typeof stored === 'string' ? stored : stored?.error || stored?.reason
    ) || 'required file is missing after retries';
    const key = `${relativeOutputPath(ref.filesDir)}:${ref.id}`;
    failures.set(key, { id: ref.id, reason: String(reason) });
  }
  return Array.from(failures.values());
}

function buildExportResult(progress, summary, options = {}) {
  // Одноразовая зачистка manifest-файла, оставшегося от прежней версии.
  fs.rmSync(path.join(CONFIG.outputDir, 'artifact-manifest.json'), { force: true });
  const index = loadIndex();
  const pending = pendingConversations(index);
  const conversationFailures = uniqueFailures([
    ...(summary.regular.failed || []),
    ...(summary.projects.failed || []),
  ]);
  const writtenIds = Array.from(new Set([
    ...(summary.regular.writtenIds || []),
    ...(summary.projects.writtenIds || []),
  ]));
  const knownProjects = readKnownProjects();
  const incompleteProjects = knownProjects
    .filter(project => !progress.projects?.[project.id]?.indexingComplete)
    .map(project => ({ id: project.id, reason: 'baseline has not reached end_of_list' }));
  const fileFailures = requiredFileFailures(progress, index);
  const activeIndex = summary.regular.activeIndex || {
    mode: options.activeMode || (progress.indexingComplete ? 'incremental' : 'baseline'),
    completion: progress.indexingComplete ? 'update_horizon_closed' : 'partial',
    known: Array.from(index.values()).filter(conv => conv._archived === false).length,
  };
  if (options.failure && !summary.regular.activeIndex) activeIndex.completion = 'partial';
  if (!progress.indexingComplete) activeIndex.completion = 'partial';

  const projectsRequested = CONFIG.includeProjects || CONFIG.projectsOnly;
  const result = {
    outcome: 'complete',
    output_dir: path.resolve(CONFIG.outputDir),
    user_id: options.userId,
    active_index: activeIndex,
    projects: {
      requested: projectsRequested,
      baseline_incomplete_count: incompleteProjects.length,
      baseline_incomplete_sample: failureSample(incompleteProjects),
      incremental_completion: summary.projects.incrementalCompletion || 'not_run',
    },
    conversations: {
      written_ids: writtenIds,
      pending_count: pending.length,
      pending_sample: failureSample(pending),
      failed_count: conversationFailures.length,
      failed_sample: failureSample(conversationFailures),
    },
    files: {
      failed_count: fileFailures.length,
      failed_sample: failureSample(fileFailures),
    },
  };

  const partial = options.failure ||
    activeIndex.completion === 'partial' ||
    incompleteProjects.length > 0 ||
    summary.projects.incrementalCompletion === 'partial' ||
    pending.length > 0 ||
    conversationFailures.length > 0 ||
    fileFailures.length > 0;
  if (partial) result.outcome = 'partial';
  if (options.failure) result.failure = options.failure;
  return result;
}

function hasUsableExportIndex() {
  if (!fs.existsSync(PATHS.indexFile)) return false;
  try {
    const index = JSON.parse(fs.readFileSync(PATHS.indexFile, 'utf8'));
    return Array.isArray(index);
  } catch {
    return false;
  }
}

async function runVerify(progress) {
  console.log('=== Verify mode (dry run) ===\n');
  const missing = findSilentlySkippedConversations(progress);
  const index = loadIndex();
  console.log(`Index entries:           ${index.size}`);
  console.log(`Progress "downloaded":   ${(progress.downloadedIds || []).length}`);
  console.log(`Silently skipped:        ${missing.length}`);
  if (missing.length === 0) {
    console.log('\n  ✓ No silent skips detected. Export is clean.\n');
    return;
  }
  console.log('\n  ⚠ Conversation IDs marked downloaded but not present on disk:\n');
  const preview = missing.slice(0, 10);
  for (const id of preview) {
    const entry = index.get(id);
    console.log(`    - ${id}  ${entry?.title ? `"${entry.title.substring(0, 50)}"` : ''}`);
  }
  if (missing.length > 10) console.log(`    ... and ${missing.length - 10} more`);
  console.log('');
}

async function run(accessToken, options = {}) {
  const progress = loadProgress();
  if (CONFIG.resetPacing) {
    console.log('  Pacing reset: ignoring previous run snapshot (--reset-pacing)');
  } else {
    restorePacingSnapshot(progress.pacing);
  }
  const baselineTransitioned = ensureBaselineSemantics(progress);
  if (baselineTransitioned) {
    console.log('Baseline semantics upgraded: active and project indexes will be re-read from the beginning.');
  }
  const activeMode = progress.indexingComplete ? 'incremental' : 'baseline';
  resetSessionPacingStats();
  runStartTime = Date.now();

  // Graceful shutdown: on Ctrl-C, flush progress + status before exiting.
  // Double Ctrl-C bypasses the save and exits immediately. Registered
  // inside run() so the handler closes over `progress`; unregistered in
  // the finally block below so repeated invocations (e.g., e2e tests)
  // don't pile up listeners and trigger MaxListenersExceeded warnings.
  let interrupting = false;
  const sigintHandler = () => {
    if (interrupting) {
      console.log('\nForce-exit.');
      process.exit(130);
    }
    interrupting = true;
    console.log('\n\nInterrupted. Flushing progress before exit...');
    try { saveProgress(progress); } catch {}
    try { saveStatus(progress, { startTime: runStartTime }); } catch {}
    console.log('Saved. Re-run with the same args to resume.');
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigintHandler);
  const unregisterSignals = () => {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigintHandler);
  };

  try {
  console.log('Using provided Bearer token');
  if (CONFIG.accountId) {
    console.log(`Teams Account ID: ${CONFIG.accountId}`);
  }

  // --verify short-circuits: dry-run report, no network calls.
  if (CONFIG.verifyMode) {
    await runVerify(progress);
    return { verified: true };
  }

  // Refetch-missing runs before the main export loop so the main loop
  // treats the cleared IDs as first-time downloads.
  if (CONFIG.refetchMissing) {
    console.log('Refetch-missing: scanning for silent skips...');
    refetchMissing(progress);
  }

  if (CONFIG.updateExisting) {
    console.log('Update mode: Will re-download existing conversations');
  }
  if (CONFIG.includeProjects || CONFIG.projectsOnly) {
    console.log(`Project export: ${CONFIG.projectsOnly ? 'projects only' : 'included'}`);
  }
  if (CONFIG.downloadFiles) {
    console.log('File downloads: enabled');
  }
  if (CONFIG.verbose) {
    console.log('Verbose mode: on');
  }
  if (CONFIG.throttleMs === 0) {
    console.log('Pacing: disabled');
  } else if (typeof CONFIG.throttleMs === 'number' && CONFIG.throttleMs > 0) {
    console.log(`Pacing: adaptive (user floor: ${CONFIG.throttleMs / 1000}s)`);
  } else {
    console.log('Pacing: adaptive (payload 2s / indexing 5s baseline, climbs on 429s)');
  }
  if (CONFIG.maxConversations !== null) console.log(`Max this session: ${CONFIG.maxConversations} conversations`);
  if (CONFIG.convFilter) console.log(`Conversation filter: ${[...CONFIG.convFilter].join(', ')}`);
  if (CONFIG.projFilter) console.log(`Project filter: ${[...CONFIG.projFilter].join(', ')}`);
  console.log('');

  const summary = {
    regular: { success: 0, skip: 0, update: 0, error: 0, fileCount: 0, writtenIds: [], failed: [] },
    projects: {
      count: 0, conversations: 0, success: 0, skip: 0, update: 0, error: 0,
      fileCount: 0, writtenIds: [], failed: [], incrementalCompletion: 'not_run',
    },
  };

  let resultFailure = null;

  try {
    if (usesUnifiedProjectUpdateWindow()) {
      console.log('=== Project Index Refresh ===\n');
      const projectRefresh = await refreshProjectPreviewIndexes(accessToken, progress);
      summary.projects.count = projectRefresh.projects.length;
      summary.projects.incrementalCompletion = projectRefresh.incrementalCompletion;
      console.log('');
    }

    if (!CONFIG.projectsOnly) {
      console.log('=== Regular Conversations ===\n');
      summary.regular = await exportConversations(accessToken, progress);
    }

    if ((CONFIG.includeProjects || CONFIG.projectsOnly) && !usesUnifiedProjectUpdateWindow()) {
      console.log('\n=== Project Conversations ===\n');

      let projects = await fetchProjectList(accessToken, progress);
      if (CONFIG.projFilter) {
        projects = projects.filter(p => CONFIG.projFilter.has(p.id));
      }
      summary.projects.count = projects.length;

      for (const project of projects) {
        const folderName = sanitizeProjectFolder(project.name);
        console.log(`\nProject: "${project.name}" (${folderName}/)`);

        const conversations = await fetchProjectConversations(accessToken, project, progress);
        if (!conversations || conversations.length === 0) {
          console.log('  No conversations.');
        } else {
          console.log(`  ${conversations.length} conversations`);

          const result = await exportProjectConversations(accessToken, project, progress);
          summary.projects.conversations += (result.success + result.skip + result.update + result.error);
          summary.projects.success += result.success;
          summary.projects.skip += result.skip;
          summary.projects.update += result.update;
          summary.projects.error += result.error;
          summary.projects.fileCount += result.fileCount;
          summary.projects.writtenIds.push(...(result.writtenIds || []));
          summary.projects.failed.push(...(result.failed || []));
        }

        if (CONFIG.downloadFiles && project.files && project.files.length > 0) {
          console.log(`  Downloading ${project.files.length} project-level files...`);
          const fc = await downloadProjectFiles(accessToken, project, progress);
          summary.projects.fileCount += fc;
        }
      }

      await mergeProjectConversationsIntoMainIndex(projects);
    }

    if (CONFIG.downloadFiles) {
      const retried = await retryPendingFiles(accessToken, progress);
      if (retried > 0) summary.retriedFiles = retried;
      const failedCount = Object.keys(progress.failedFileIds).length;
      if (failedCount > 0) summary.failedFiles = failedCount;
    }
  } catch (error) {
    if (error.authError) {
      printSummary(summary);
      throw error;
    }
    if ((error.partialKind || error.sourceError) && hasUsableExportIndex()) {
      resultFailure = {
        kind: error.partialKind || 'source',
        message: error.message,
      };
      summary.projects.incrementalCompletion = usesUnifiedProjectUpdateWindow() ? 'partial' : summary.projects.incrementalCompletion;
    } else {
      throw error;
    }
  }

  summary.elapsedMs = Date.now() - runStartTime;
  summary.pacingStats = getPacingStats();
  printSummary(summary);
  return buildExportResult(progress, summary, {
    activeMode,
    failure: resultFailure,
    userId: options.userId,
  });
  } finally {
    unregisterSignals();
    if (CONFIG.useBrowserFetch) {
      try { await require('./browser-fetch').closeBrowser(); } catch {}
    }
  }
}

function printSummary(summary) {
  if (!CONFIG.showSummary) return;

  const r = summary.regular;
  const p = summary.projects;

  const downloaded = r.success + r.update + p.success + p.update;
  const skipped = r.skip + p.skip;
  const errors = r.error + p.error;
  const files = r.fileCount + p.fileCount;
  const projects = p.count;

  console.log('\n' + '='.repeat(50));
  console.log('  Export Complete!');
  console.log('='.repeat(50));

  // Conversations line (always shown)
  let convParts = [`${downloaded} downloaded`];
  if (skipped > 0) convParts.push(`${skipped} skipped`);
  if (errors > 0) convParts.push(`${errors} errors`);
  console.log(`\n  Conversations:  ${convParts.join('    ')}`);

  // Projects line (only if projects were included)
  if (CONFIG.includeProjects || CONFIG.projectsOnly) {
    console.log(`  Projects:       ${projects} found`);
  }

  // Files line (only if file downloads were enabled and any were downloaded, retried, or failed)
  if (CONFIG.downloadFiles && (files > 0 || summary.retriedFiles > 0 || summary.failedFiles > 0)) {
    let fileParts = [`${files} downloaded`];
    if (summary.retriedFiles > 0) fileParts.push(`${summary.retriedFiles} retried`);
    if (summary.failedFiles > 0) fileParts.push(`${summary.failedFiles} permanently failed`);
    console.log(`  Files:          ${fileParts.join('    ')}`);
  }

  if (typeof summary.elapsedMs === 'number') {
    const mins = summary.elapsedMs / 60000;
    const elapsed = mins >= 60
      ? `${(mins / 60).toFixed(1)}h`
      : `${mins.toFixed(1)}m`;
    const pace = downloaded > 0 && mins > 0
      ? `${(downloaded / mins).toFixed(1)} conv/min`
      : null;
    const paceSuffix = pace ? `    (${pace})` : '';
    console.log(`  Elapsed:        ${elapsed}${paceSuffix}`);
  }

  if (summary.pacingStats) {
    const s = summary.pacingStats;
    console.log(`  Pacing:         final ${(s.currentInterval / 1000).toFixed(1)}s    peak ${(s.peakInterval / 1000).toFixed(1)}s`);
  }

  console.log(`\n  Output directory: ${path.resolve(CONFIG.outputDir)}`);
}

module.exports = {
  buildExportResult,
  collectExportedArtifactTimes,
  collectIdsOnDisk,
  conversationTimestamp,
  exportConversations,
  exportProjectConversations,
  findSilentlySkippedConversations,
  printSummary,
  refetchMissing,
  run,
};
