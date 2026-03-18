import * as path from 'node:path';
import * as vscode from 'vscode';

const STATE_VERSION = 3;
const STATE_FILENAME = 'solidity-auditor-extension.json';

const LEGACY_WORKSPACE_KEYS = {
  manualFiles: 'marked.manualFiles',
  manualFolders: 'marked.manualFolders',
  excludedFiles: 'marked.excludedFiles',
  excludedFolders: 'marked.excludedFolders',
  filterMode: 'marked.filterMode',
  auditedEntryIds: 'tracker.auditedEntryIds',
  selectedFileKey: 'tracker.selectedFileKey'
};

export type PersistedMarkedFilterMode = 'all' | 'entrypoints';
export type PersistedTrackerFilterMode = 'all' | 'unaudited';

export interface DailyProgressAction {
  type: 'entryPointAudited' | 'fileAudited';
  filePath: string;
  functionName?: string;
  lineCount?: number;
}

export interface DailyProgress {
  date: string;
  entryPointsAudited: number;
  linesAudited: number;
  filesAudited: number;
  actions: DailyProgressAction[];
}

interface PersistedState {
  version: number;
  marked: {
    manualFiles: string[];
    excludedFiles: string[];
    filterMode: PersistedMarkedFilterMode;
    legacyManualFolders: string[];
    legacyExcludedFolders: string[];
  };
  tracker: {
    auditedEntryIds: string[];
    selectedFileKey?: string;
    filterMode: PersistedTrackerFilterMode;
    lastAuditedAtByTrackedId: Record<string, string>;
  };
  progressHistory: DailyProgress[];
  cache: {
    entryPointSnapshots: Record<string, PersistedEntryPointSnapshot>;
  };
}

interface PersistedEntryPointSnapshot {
  mtime: number;
  size: number;
  entryPointIds: string[];
}

function createDefaultState(): PersistedState {
  return {
    version: STATE_VERSION,
    marked: {
      manualFiles: [],
      excludedFiles: [],
      filterMode: 'all',
      legacyManualFolders: [],
      legacyExcludedFolders: []
    },
    tracker: {
      auditedEntryIds: [],
      filterMode: 'all',
      lastAuditedAtByTrackedId: {}
    },
    progressHistory: [],
    cache: {
      entryPointSnapshots: {}
    }
  };
}

export class PersistentStateManager {
  private state = createDefaultState();
  private saveChain: Promise<void> = Promise.resolve();
  private readonly stateFileUri?: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      this.stateFileUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, '.vscode', STATE_FILENAME));
    }
  }

  async initialize(): Promise<void> {
    if (!this.stateFileUri) {
      this.state = this.migrateLegacyWorkspaceState();
      return;
    }

    try {
      const content = await vscode.workspace.fs.readFile(this.stateFileUri);
      this.state = this.normalizeState(JSON.parse(Buffer.from(content).toString('utf8')));
      return;
    } catch {
      this.state = this.migrateLegacyWorkspaceState();
      await this.save();
    }
  }

  getMarkedState(): PersistedState['marked'] {
    return {
      manualFiles: [...this.state.marked.manualFiles],
      excludedFiles: [...this.state.marked.excludedFiles],
      filterMode: this.state.marked.filterMode,
      legacyManualFolders: [...this.state.marked.legacyManualFolders],
      legacyExcludedFolders: [...this.state.marked.legacyExcludedFolders]
    };
  }

  async setMarkedState(marked: PersistedState['marked']): Promise<void> {
    this.state.marked = {
      manualFiles: [...marked.manualFiles],
      excludedFiles: [...marked.excludedFiles],
      filterMode: marked.filterMode,
      legacyManualFolders: [...marked.legacyManualFolders],
      legacyExcludedFolders: [...marked.legacyExcludedFolders]
    };
    await this.save();
  }

  getTrackerState(): PersistedState['tracker'] {
    return {
      auditedEntryIds: [...this.state.tracker.auditedEntryIds],
      selectedFileKey: this.state.tracker.selectedFileKey,
      filterMode: this.state.tracker.filterMode,
      lastAuditedAtByTrackedId: { ...this.state.tracker.lastAuditedAtByTrackedId }
    };
  }

  async setTrackerState(tracker: PersistedState['tracker']): Promise<void> {
    this.state.tracker = {
      auditedEntryIds: [...tracker.auditedEntryIds],
      selectedFileKey: tracker.selectedFileKey,
      filterMode: tracker.filterMode,
      lastAuditedAtByTrackedId: { ...tracker.lastAuditedAtByTrackedId }
    };
    await this.save();
  }

  getProgressHistory(): DailyProgress[] {
    return this.state.progressHistory.map((entry) => ({
      date: entry.date,
      entryPointsAudited: entry.entryPointsAudited,
      linesAudited: entry.linesAudited,
      filesAudited: entry.filesAudited,
      actions: entry.actions.map((action) => ({ ...action }))
    }));
  }

  async recordEntryPointAudited(filePath: string, functionName: string, lineCount: number): Promise<void> {
    const progress = this.getOrCreateTodayProgress();
    progress.entryPointsAudited += 1;
    progress.linesAudited += lineCount;
    progress.actions.push({
      type: 'entryPointAudited',
      filePath,
      functionName,
      lineCount
    });
    await this.save();
  }

  async recordFileAudited(filePath: string): Promise<void> {
    const progress = this.getOrCreateTodayProgress();
    progress.filesAudited += 1;
    progress.actions.push({
      type: 'fileAudited',
      filePath
    });
    await this.save();
  }

  getEntryPointSnapshot(fileKey: string): PersistedEntryPointSnapshot | undefined {
    const snapshot = this.state.cache.entryPointSnapshots[fileKey];
    if (!snapshot) {
      return undefined;
    }

    return {
      mtime: snapshot.mtime,
      size: snapshot.size,
      entryPointIds: [...snapshot.entryPointIds]
    };
  }

  async setEntryPointSnapshot(fileKey: string, snapshot: PersistedEntryPointSnapshot | undefined): Promise<void> {
    if (!snapshot) {
      delete this.state.cache.entryPointSnapshots[fileKey];
    } else {
      this.state.cache.entryPointSnapshots[fileKey] = {
        mtime: snapshot.mtime,
        size: snapshot.size,
        entryPointIds: [...snapshot.entryPointIds]
      };
    }
    await this.save();
  }

  async clearEntryPointSnapshots(): Promise<void> {
    this.state.cache.entryPointSnapshots = {};
    await this.save();
  }

  private migrateLegacyWorkspaceState(): PersistedState {
    const state = createDefaultState();
    state.marked.manualFiles = this.context.workspaceState.get<string[]>(LEGACY_WORKSPACE_KEYS.manualFiles, []);
    state.marked.excludedFiles = this.context.workspaceState.get<string[]>(LEGACY_WORKSPACE_KEYS.excludedFiles, []);
    state.marked.filterMode = this.context.workspaceState.get<PersistedMarkedFilterMode>(LEGACY_WORKSPACE_KEYS.filterMode, 'all');
    state.marked.legacyManualFolders = this.context.workspaceState.get<string[]>(LEGACY_WORKSPACE_KEYS.manualFolders, []);
    state.marked.legacyExcludedFolders = this.context.workspaceState.get<string[]>(LEGACY_WORKSPACE_KEYS.excludedFolders, []);
    state.tracker.auditedEntryIds = this.context.workspaceState.get<string[]>(LEGACY_WORKSPACE_KEYS.auditedEntryIds, []);
    state.tracker.selectedFileKey = this.context.workspaceState.get<string | undefined>(LEGACY_WORKSPACE_KEYS.selectedFileKey);
    state.tracker.filterMode = 'all';
    state.tracker.lastAuditedAtByTrackedId = {};
    return state;
  }

  private normalizeState(raw: any): PersistedState {
    const state = createDefaultState();
    const marked = raw?.marked ?? {};
    const tracker = raw?.tracker ?? {};

    state.version = typeof raw?.version === 'number' ? raw.version : STATE_VERSION;
    state.marked.manualFiles = normalizeStringArray(marked.manualFiles);
    state.marked.excludedFiles = normalizeStringArray(marked.excludedFiles);
    state.marked.filterMode = marked.filterMode === 'entrypoints' ? 'entrypoints' : 'all';
    state.marked.legacyManualFolders = normalizeStringArray(marked.legacyManualFolders);
    state.marked.legacyExcludedFolders = normalizeStringArray(marked.legacyExcludedFolders);
    state.tracker.auditedEntryIds = normalizeStringArray(tracker.auditedEntryIds);
    state.tracker.selectedFileKey = typeof tracker.selectedFileKey === 'string' && tracker.selectedFileKey.length > 0
      ? tracker.selectedFileKey
      : undefined;
    state.tracker.filterMode = tracker.filterMode === 'unaudited' ? 'unaudited' : 'all';
    state.tracker.lastAuditedAtByTrackedId = normalizeStringRecord(tracker.lastAuditedAtByTrackedId);
    state.progressHistory = normalizeProgressHistory(raw?.progressHistory);
    state.cache.entryPointSnapshots = normalizeEntryPointSnapshotRecord(raw?.cache?.entryPointSnapshots);

    return state;
  }

  private getOrCreateTodayProgress(): DailyProgress {
    const today = formatLocalDate(new Date());
    let entry = this.state.progressHistory.find((item) => item.date === today);
    if (!entry) {
      entry = {
        date: today,
        entryPointsAudited: 0,
        linesAudited: 0,
        filesAudited: 0,
        actions: []
      };
      this.state.progressHistory.push(entry);
    }
    return entry;
  }

  private async save(): Promise<void> {
    if (!this.stateFileUri) {
      return;
    }

    const runSave = async (): Promise<void> => {
      const vscodeDirUri = vscode.Uri.file(path.dirname(this.stateFileUri!.fsPath));
      await vscode.workspace.fs.createDirectory(vscodeDirUri);
      const content = Buffer.from(JSON.stringify(this.state, null, 2), 'utf8');
      await vscode.workspace.fs.writeFile(this.stateFileUri!, content);
    };

    this.saveChain = this.saveChain.then(runSave, runSave);
    await this.saveChain;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeEntryPointSnapshotRecord(value: unknown): Record<string, PersistedEntryPointSnapshot> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const snapshots: Record<string, PersistedEntryPointSnapshot> = {};
  for (const [fileKey, rawSnapshot] of Object.entries(value)) {
    if (!fileKey || !rawSnapshot || typeof rawSnapshot !== 'object') {
      continue;
    }

    const snapshot = rawSnapshot as Partial<PersistedEntryPointSnapshot>;
    if (typeof snapshot.mtime !== 'number' || typeof snapshot.size !== 'number') {
      continue;
    }

    snapshots[fileKey] = {
      mtime: snapshot.mtime,
      size: snapshot.size,
      entryPointIds: normalizeStringArray(snapshot.entryPointIds)
    };
  }

  return snapshots;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!key || typeof rawValue !== 'string' || rawValue.length === 0) {
      continue;
    }
    normalized[key] = rawValue;
  }

  return normalized;
}

function normalizeProgressHistory(value: unknown): DailyProgress[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const progress = entry as Partial<DailyProgress>;
    if (typeof progress.date !== 'string' || progress.date.length === 0) {
      return [];
    }

    return [{
      date: progress.date,
      entryPointsAudited: typeof progress.entryPointsAudited === 'number' ? progress.entryPointsAudited : 0,
      linesAudited: typeof progress.linesAudited === 'number' ? progress.linesAudited : 0,
      filesAudited: typeof progress.filesAudited === 'number' ? progress.filesAudited : 0,
      actions: normalizeDailyProgressActions(progress.actions)
    }];
  });
}

function normalizeDailyProgressActions(value: unknown): DailyProgressAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const action = entry as Partial<DailyProgressAction>;
    if ((action.type !== 'entryPointAudited' && action.type !== 'fileAudited') || typeof action.filePath !== 'string') {
      return [];
    }

    return [{
      type: action.type,
      filePath: action.filePath,
      functionName: typeof action.functionName === 'string' ? action.functionName : undefined,
      lineCount: typeof action.lineCount === 'number' ? action.lineCount : undefined
    }];
  });
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}
