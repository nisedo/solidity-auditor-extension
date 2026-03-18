import * as path from 'node:path';
import * as vscode from 'vscode';
import { MarkManager, MarkedEntry } from './marks';
import {
  analyzeActiveContract,
  ContractAnalysis,
  FunctionSummary,
  isSolidityDocument,
  provideInlayHints as provideSolidityInlayHints,
  VariableSummary
} from './solidity';
import { DailyProgress, PersistedTrackerFilterMode, PersistentStateManager } from './state';

interface TrackedEntryPointItem extends FunctionSummary {
  fileKey: string;
  isAudited: boolean;
  lastAuditedAt?: string;
}

interface ProgressTotals {
  totalEntryPoints: number;
  totalAudited: number;
  totalFiles: number;
  filesFullyAudited: number;
}

interface UnauditedFileSummary {
  filePath: string;
  remaining: number;
  audited: number;
  total: number;
}

class TrackerState {
  private auditedEntryIds: Set<string>;
  private selectedFileKey?: string;
  private filterMode: PersistedTrackerFilterMode;
  private lastAuditedAtByTrackedId: Map<string, string>;

  constructor(private readonly stateManager: PersistentStateManager) {
    const trackerState = this.stateManager.getTrackerState();
    this.auditedEntryIds = new Set(trackerState.auditedEntryIds);
    this.selectedFileKey = trackerState.selectedFileKey;
    this.filterMode = trackerState.filterMode;
    this.lastAuditedAtByTrackedId = new Map(Object.entries(trackerState.lastAuditedAtByTrackedId));
  }

  getSelectedFileKey(): string | undefined {
    return this.selectedFileKey;
  }

  async setSelectedFileKey(fileKey: string | undefined): Promise<void> {
    this.selectedFileKey = fileKey;
    await this.persist();
  }

  isAudited(fileKey: string, entryId: string): boolean {
    return this.auditedEntryIds.has(this.toTrackedId(fileKey, entryId));
  }

  getLastAuditedAt(fileKey: string, entryId: string): string | undefined {
    return this.lastAuditedAtByTrackedId.get(this.toTrackedId(fileKey, entryId));
  }

  isUnauditedFilterEnabled(): boolean {
    return this.filterMode === 'unaudited';
  }

  async toggleUnauditedFilter(): Promise<void> {
    this.filterMode = this.filterMode === 'all' ? 'unaudited' : 'all';
    await this.persist();
  }

  async setAudited(fileKey: string, entryId: string, audited: boolean): Promise<boolean> {
    const trackedId = this.toTrackedId(fileKey, entryId);
    const alreadyAudited = this.auditedEntryIds.has(trackedId);
    if (alreadyAudited === audited) {
      return false;
    }

    if (audited) {
      this.auditedEntryIds.add(trackedId);
      this.lastAuditedAtByTrackedId.set(trackedId, new Date().toISOString());
    } else {
      this.auditedEntryIds.delete(trackedId);
    }
    await this.persist();
    return true;
  }

  private toTrackedId(fileKey: string, entryId: string): string {
    return `${fileKey}::${entryId}`;
  }

  private async persist(): Promise<void> {
    await this.stateManager.setTrackerState({
      auditedEntryIds: Array.from(this.auditedEntryIds),
      selectedFileKey: this.selectedFileKey,
      filterMode: this.filterMode,
      lastAuditedAtByTrackedId: Object.fromEntries(this.lastAuditedAtByTrackedId)
    });
  }
}

class TrackerProvider implements vscode.TreeDataProvider<TrackedEntryPointItem> {
  private readonly emitter = new vscode.EventEmitter<any>();
  private items: TrackedEntryPointItem[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  setItems(items: TrackedEntryPointItem[]): void {
    this.items = items;
    this.emitter.fire();
  }

  getChildren(): TrackedEntryPointItem[] {
    return this.items;
  }

  getTreeItem(item: TrackedEntryPointItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      `${item.isAudited ? '✓' : '○'} ${item.name}`,
      vscode.TreeItemCollapsibleState.None
    );
    treeItem.description = item.inherited ? '(inherited)' : undefined;
    treeItem.tooltip = [
      item.name,
      item.inherited ? '(inherited)' : undefined,
      formatLastAuditedLabel(item.lastAuditedAt)
    ].filter((part): part is string => Boolean(part)).join('\n');
    treeItem.contextValue = item.isAudited ? 'trackedEntryPointAudited' : 'trackedEntryPointUnaudited';
    if (item.location) {
      treeItem.command = {
        command: 'vscode.open',
        title: 'Open Entry Point',
        arguments: [item.location.uri, { selection: item.location.range }]
      };
    }
    return treeItem;
  }
}

type VariableTreeNode = VariableSummary | FunctionSummary;

class VariableProvider implements vscode.TreeDataProvider<VariableTreeNode> {
  private readonly emitter = new vscode.EventEmitter<any>();
  private items: VariableSummary[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  setItems(items: VariableSummary[]): void {
    this.items = items;
    this.emitter.fire();
  }

  getChildren(element?: VariableTreeNode): VariableTreeNode[] {
    if (!element) {
      return this.items;
    }
    if ('modifiedBy' in element) {
      return element.modifiedBy;
    }
    return [];
  }

  getTreeItem(element: VariableTreeNode): vscode.TreeItem {
    if ('modifiedBy' in element) {
      const item = new vscode.TreeItem(
        element.name,
        element.modifiedBy.length === 0
          ? vscode.TreeItemCollapsibleState.None
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = element.modifiedBy.length === 0 && element.initializedInConstructor
        ? `${element.detail} | initialized in constructor`
        : `${element.detail} | ${element.modifiedBy.length} modifying functions`;
      item.tooltip = [
        element.name,
        element.detail,
        element.modifiedBy.length === 0 && element.initializedInConstructor
          ? 'initialized in constructor'
          : undefined
      ].filter((part): part is string => Boolean(part)).join('\n');
      if (element.location) {
        item.command = {
          command: 'vscode.open',
          title: 'Open Variable',
          arguments: [element.location.uri, { selection: element.location.range }]
        };
      }
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.detail;
    item.tooltip = `${element.label}\n${element.detail}`;
    if (element.location) {
      item.command = {
        command: 'vscode.open',
        title: 'Open Function',
        arguments: [element.location.uri, { selection: element.location.range }]
      };
    }
    return item;
  }
}

function toWorkspaceKey(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').replace(/\/+$/, '');
}

function formatLastAuditedLabel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return `Last audited: ${date.toLocaleString()}`;
}

function generateProgressReport(
  repoName: string,
  history: DailyProgress[],
  totals: ProgressTotals,
  unauditedByFile: UnauditedFileSummary[]
): string {
  const timestamp = new Date().toLocaleString();
  const auditedPct = totals.totalEntryPoints > 0
    ? ((totals.totalAudited / totals.totalEntryPoints) * 100).toFixed(1)
    : '0.0';
  const filesAuditedPct = totals.totalFiles > 0
    ? ((totals.filesFullyAudited / totals.totalFiles) * 100).toFixed(1)
    : '0.0';

  let report = `# Audit Progress Report - ${repoName}\n\n`;
  report += `Generated: ${timestamp}\n\n`;
  report += '## Overall Progress\n\n';
  report += '| Metric | Progress | Percentage |\n';
  report += '|--------|----------|------------|\n';
  report += `| Entry Points Audited | ${totals.totalAudited}/${totals.totalEntryPoints} | ${auditedPct}% |\n`;
  report += `| Files Fully Audited | ${totals.filesFullyAudited}/${totals.totalFiles} | ${filesAuditedPct}% |\n\n`;

  report += '## Unaudited By File\n\n';
  if (unauditedByFile.length === 0) {
    report += '*All tracked files are fully audited.*\n\n';
  } else {
    report += '| File | Remaining | Audited | Total |\n';
    report += '|------|-----------|---------|-------|\n';
    for (const entry of unauditedByFile) {
      report += `| \`${entry.filePath}\` | ${entry.remaining} | ${entry.audited} | ${entry.total} |\n`;
    }
    report += '\n';
  }

  if (history.length === 0) {
    report += '## Daily Activity\n\n';
    report += '*No activity recorded yet.*\n';
    return report;
  }

  const sortedHistory = [...history].sort((left, right) => right.date.localeCompare(left.date));
  report += '## Daily Activity Summary\n\n';
  report += '| Date | Entry Points Audited | Lines Audited | Files Audited |\n';
  report += '|------|----------------------|---------------|---------------|\n';
  for (const day of sortedHistory) {
    report += `| ${day.date} | ${day.entryPointsAudited} | ${day.linesAudited} | ${day.filesAudited} |\n`;
  }

  report += '\n---\n\n';
  report += '## Detailed Activity Log\n\n';
  for (const day of sortedHistory) {
    if (day.actions.length === 0) {
      continue;
    }

    report += `### ${day.date}\n\n`;
    const entryPointsAudited = day.actions.filter((action) => action.type === 'entryPointAudited');
    const filesAudited = day.actions.filter((action) => action.type === 'fileAudited');

    if (entryPointsAudited.length > 0) {
      report += `**Entry Points Audited (${entryPointsAudited.length}):**\n`;
      for (const action of entryPointsAudited) {
        report += `- \`${action.filePath}\` -> \`${action.functionName ?? '(unknown)'}\`\n`;
      }
      report += '\n';
    }

    if (filesAudited.length > 0) {
      report += '**Files Completed:**\n';
      for (const action of filesAudited) {
        report += `- \`${action.filePath}\`\n`;
      }
      report += '\n';
    }
  }

  return report;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const persistentState = new PersistentStateManager(context);
  await persistentState.initialize();
  const variableProvider = new VariableProvider();
  const markManager = new MarkManager(context, persistentState);
  const trackerState = new TrackerState(persistentState);
  const trackerProvider = new TrackerProvider();

  const trackerView = vscode.window.createTreeView<TrackedEntryPointItem>('solidityAuditor.cockpit', {
    treeDataProvider: trackerProvider,
    showCollapseAll: false
  });
  const variableView = vscode.window.createTreeView<VariableTreeNode>('solidityAuditor.variables', { treeDataProvider: variableProvider });
  const markedView = vscode.window.createTreeView<MarkedEntry>('solidityAuditor.marked', { treeDataProvider: markManager });
  const diagnostics = vscode.languages.createDiagnosticCollection('solidityAuditor');

  const mutableStateDecoration = vscode.window.createTextEditorDecorationType({
    fontWeight: '700',
    textDecoration: 'underline'
  });

  context.subscriptions.push(
    variableView,
    markedView,
    trackerView,
    markManager,
    diagnostics,
    mutableStateDecoration,
    vscode.window.registerFileDecorationProvider(markManager),
    vscode.languages.registerInlayHintsProvider({ language: 'solidity' }, {
      provideInlayHints(document, range) {
        return provideSolidityInlayHints(document, range);
      }
    })
  );

  await markManager.initialize();

  const updateMarkedViewDescription = () => {
    markedView.description = markManager.isEntryPointFilterEnabled() ? 'entry points only' : 'all';
  };

  const updateTrackerViewDescription = (
    contractName: string | undefined,
    auditedCount: number,
    totalCount: number
  ) => {
    if (!contractName) {
      trackerView.description = trackerState.isUnauditedFilterEnabled() ? 'No contract | unaudited only' : 'No contract';
      return;
    }

    const suffix = trackerState.isUnauditedFilterEnabled() ? ' | unaudited only' : '';
    trackerView.description = `${contractName} ${auditedCount}/${totalCount}${suffix}`;
  };

  const getMarkedSolidityEntries = async (): Promise<MarkedEntry[]> =>
    (await markManager.getMarkedEntries({ applyFilter: false }))
      .filter((entry) => entry.kind === 'file' && entry.uri.fsPath.endsWith('.sol'));

  const getMarkedEntryByKey = async (fileKey: string): Promise<MarkedEntry | undefined> =>
    (await getMarkedSolidityEntries()).find((entry) => entry.key === fileKey);

  let refreshTimer: NodeJS.Timeout | undefined;
  let trackerRefreshTimer: NodeJS.Timeout | undefined;
  let trackerRefreshVersion = 0;

  const refreshTracker = async (preferredFileKey?: string) => {
    const refreshVersion = ++trackerRefreshVersion;
    const markedEntries = await getMarkedSolidityEntries();

    if (markedEntries.length === 0) {
      trackerProvider.setItems([]);
      updateTrackerViewDescription(undefined, 0, 0);
      trackerView.message = 'Mark a Solidity file to track its state-changing entry points.';
      if (trackerState.getSelectedFileKey()) {
        await trackerState.setSelectedFileKey(undefined);
      }
      return;
    }

    const activeEditorKey = vscode.window.activeTextEditor
      ? toWorkspaceKey(vscode.window.activeTextEditor.document.uri)
      : undefined;
    const activeMarkedFileKey = activeEditorKey && markedEntries.some((entry) => entry.key === activeEditorKey)
      ? activeEditorKey
      : undefined;

    let selectedFileKey = activeMarkedFileKey ?? preferredFileKey ?? trackerState.getSelectedFileKey();
    if (!selectedFileKey || !markedEntries.some((entry) => entry.key === selectedFileKey)) {
      selectedFileKey = markedEntries[0].key;
    }

    if (selectedFileKey !== trackerState.getSelectedFileKey()) {
      await trackerState.setSelectedFileKey(selectedFileKey);
    }

    const selectedEntry = markedEntries.find((entry) => entry.key === selectedFileKey);
    if (!selectedEntry) {
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const useActiveEditor = Boolean(
      activeEditor
        && isSolidityDocument(activeEditor.document)
        && toWorkspaceKey(activeEditor.document.uri) === selectedFileKey
    );
    const document = useActiveEditor
      ? activeEditor!.document
      : await vscode.workspace.openTextDocument(selectedEntry.uri);
    const position = useActiveEditor ? activeEditor!.selection.active : new vscode.Position(0, 0);
    const analysis = await analyzeActiveContract(document, position);
    if (refreshVersion !== trackerRefreshVersion) {
      return;
    }

    const items = (analysis?.cockpitItems ?? []).map((summary) => ({
      ...summary,
      fileKey: selectedFileKey,
      isAudited: trackerState.isAudited(selectedFileKey, summary.id),
      lastAuditedAt: trackerState.getLastAuditedAt(selectedFileKey, summary.id)
    }));
    const visibleItems = trackerState.isUnauditedFilterEnabled()
      ? items.filter((item) => !item.isAudited)
      : items;

    trackerProvider.setItems(visibleItems);
    updateTrackerViewDescription(
      analysis?.contractName,
      items.filter((item) => item.isAudited).length,
      items.length
    );
    trackerView.message = items.length === 0
      ? 'No state-changing entry points in the selected contract.'
      : visibleItems.length === 0 && trackerState.isUnauditedFilterEnabled()
        ? 'All tracked entry points are audited in the selected contract.'
      : undefined;
  };

  const scheduleRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      void refreshActiveEditor();
    }, 120);
  };

  let queuedTrackerFileKey: string | undefined;
  const scheduleTrackerRefresh = (preferredFileKey?: string) => {
    if (preferredFileKey) {
      queuedTrackerFileKey = preferredFileKey;
    }
    if (trackerRefreshTimer) {
      clearTimeout(trackerRefreshTimer);
    }
    trackerRefreshTimer = setTimeout(() => {
      const fileKey = queuedTrackerFileKey;
      queuedTrackerFileKey = undefined;
      void refreshTracker(fileKey);
    }, 120);
  };

  const applyAnalysis = (editor: vscode.TextEditor | undefined, analysis?: ContractAnalysis) => {
    if (!editor || !analysis) {
      variableProvider.setItems([]);
      variableView.description = 'No contract';
      for (const visibleEditor of vscode.window.visibleTextEditors) {
        visibleEditor.setDecorations(mutableStateDecoration, []);
      }
      return;
    }

    variableProvider.setItems(analysis.variables);
    variableView.description = analysis.contractName;
    editor.setDecorations(mutableStateDecoration, analysis.decorations.mutable);
  };

  const clearForEditor = (editor?: vscode.TextEditor) => {
    diagnostics.clear();
    applyAnalysis(editor);
  };

  const refreshActiveEditor = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSolidityDocument(editor.document)) {
      clearForEditor(editor);
      return;
    }

    const documentVersion = editor.document.version;
    const analysis = await analyzeActiveContract(editor.document, editor.selection.active);
    if (vscode.window.activeTextEditor !== editor || editor.document.version !== documentVersion) {
      return;
    }

    diagnostics.set(editor.document.uri, analysis?.diagnostics ?? []);
    applyAnalysis(editor, analysis);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (vscode.window.activeTextEditor?.document) {
        markManager.refreshEntryPointCounts(vscode.window.activeTextEditor.document.uri);
      }
      scheduleRefresh();
      scheduleTrackerRefresh();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        if (isSolidityDocument(event.textEditor.document)) {
          markManager.refreshEntryPointCounts(event.textEditor.document.uri);
        }
        scheduleRefresh();
      }
      if (trackerState.getSelectedFileKey() === toWorkspaceKey(event.textEditor.document.uri)) {
        scheduleTrackerRefresh(trackerState.getSelectedFileKey());
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.activeTextEditor?.document === event.document) {
        scheduleRefresh();
      }
      if (trackerState.getSelectedFileKey() === toWorkspaceKey(event.document.uri)) {
        scheduleTrackerRefresh(trackerState.getSelectedFileKey());
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (vscode.window.activeTextEditor?.document === document) {
        scheduleRefresh();
      }
      if (isSolidityDocument(document)) {
        markManager.refreshEntryPointCounts(document.uri);
      }
      if (trackerState.getSelectedFileKey() === toWorkspaceKey(document.uri)) {
        scheduleTrackerRefresh(trackerState.getSelectedFileKey());
      }
    })
  );

  context.subscriptions.push(
    markManager.onDidChangeTreeData(() => {
      updateMarkedViewDescription();
      scheduleTrackerRefresh();
    }),
    vscode.commands.registerCommand('solidityAuditor.openMarkedFile', async (entry?: MarkedEntry) => {
      if (!entry) {
        return;
      }

      if (entry.uri.fsPath.endsWith('.sol')) {
        await trackerState.setSelectedFileKey(entry.key);
        scheduleTrackerRefresh(entry.key);
      }

      const document = await vscode.workspace.openTextDocument(entry.uri);
      await vscode.window.showTextDocument(document);
    }),
    vscode.commands.registerCommand('solidityAuditor.toggleMarkFile', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      await markManager.toggleFile(target);
      scheduleTrackerRefresh();
    }),
    vscode.commands.registerCommand('solidityAuditor.toggleMarkFolder', async (uri?: vscode.Uri) => {
      if (!uri) {
        return;
      }
      await markManager.toggleFolder(uri);
      scheduleTrackerRefresh();
    }),
    vscode.commands.registerCommand('solidityAuditor.toggleMarkedItem', async (entry?: MarkedEntry) => {
      if (!entry) {
        return;
      }
      await markManager.toggleEntry(entry);
      scheduleTrackerRefresh();
    }),
    vscode.commands.registerCommand('solidityAuditor.markEntryPointAudited', async (item?: TrackedEntryPointItem) => {
      if (!item) {
        return;
      }
      const trackedEntry = await getMarkedEntryByKey(item.fileKey);
      const trackedUri = trackedEntry?.uri;
      const beforeProgress = trackedUri ? await markManager.getEntryPointProgress(trackedUri) : undefined;
      const changed = await trackerState.setAudited(item.fileKey, item.id, true);
      if (!changed) {
        return;
      }
      if (trackedUri) {
        markManager.refreshEntryPointCounts(trackedUri);
        const afterProgress = await markManager.getEntryPointProgress(trackedUri);
        const lineCount = item.location ? item.location.range.end.line - item.location.range.start.line + 1 : 0;
        await persistentState.recordEntryPointAudited(
          item.fileKey,
          `${item.label}${item.inherited ? ' (inherited)' : ''}`,
          Math.max(0, lineCount)
        );
        if (
          beforeProgress
          && afterProgress
          && beforeProgress.total > 0
          && beforeProgress.audited < beforeProgress.total
          && afterProgress.audited === afterProgress.total
        ) {
          await persistentState.recordFileAudited(item.fileKey);
        }
      }
      await refreshTracker(item.fileKey);
    }),
    vscode.commands.registerCommand('solidityAuditor.unmarkEntryPointAudited', async (item?: TrackedEntryPointItem) => {
      if (!item) {
        return;
      }
      const trackedEntry = await getMarkedEntryByKey(item.fileKey);
      const changed = await trackerState.setAudited(item.fileKey, item.id, false);
      if (!changed) {
        return;
      }
      if (trackedEntry?.uri) {
        markManager.refreshEntryPointCounts(trackedEntry.uri);
      }
      await refreshTracker(item.fileKey);
    }),
    vscode.commands.registerCommand('solidityAuditor.reloadScope', async () => {
      await markManager.reloadScopeMarks();
      scheduleTrackerRefresh();
    }),
    vscode.commands.registerCommand('solidityAuditor.toggleMarkedEntryPointFilter', async () => {
      await markManager.toggleEntryPointFilter();
    }),
    vscode.commands.registerCommand('solidityAuditor.toggleTrackerUnauditedFilter', async () => {
      await trackerState.toggleUnauditedFilter();
      scheduleTrackerRefresh(trackerState.getSelectedFileKey());
    }),
    vscode.commands.registerCommand('solidityAuditor.clearCachedAnalysisSnapshots', async () => {
      await markManager.clearCachedAnalysisSnapshots();
      scheduleTrackerRefresh(trackerState.getSelectedFileKey());
      vscode.window.showInformationMessage('Solidity Auditor cached analysis snapshots cleared.');
    }),
    vscode.commands.registerCommand('solidityAuditor.showProgressReport', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const repoName = workspaceFolder.name;
      const markedEntries = await getMarkedSolidityEntries();
      const progressEntries = await Promise.all(markedEntries.map(async (entry) => ({
        entry,
        progress: await markManager.getEntryPointProgress(entry.uri)
      })));
      const filesWithEntryPoints = progressEntries.filter(
        (item): item is { entry: MarkedEntry; progress: { audited: number; total: number } } =>
          Boolean(item.progress && item.progress.total > 0)
      );

      const report = generateProgressReport(
        repoName,
        persistentState.getProgressHistory(),
        {
          totalEntryPoints: filesWithEntryPoints.reduce((sum, item) => sum + item.progress.total, 0),
          totalAudited: filesWithEntryPoints.reduce((sum, item) => sum + item.progress.audited, 0),
          totalFiles: filesWithEntryPoints.length,
          filesFullyAudited: filesWithEntryPoints.filter((item) => item.progress.audited === item.progress.total).length
        },
        filesWithEntryPoints
          .map((item) => ({
            filePath: item.entry.key,
            remaining: item.progress.total - item.progress.audited,
            audited: item.progress.audited,
            total: item.progress.total
          }))
          .filter((item) => item.remaining > 0)
          .sort((left, right) => right.remaining - left.remaining || left.filePath.localeCompare(right.filePath))
      );

      const reportUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, '.vscode', `${repoName}-audit-progress.md`));
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, '.vscode')));
      await vscode.workspace.fs.writeFile(reportUri, Buffer.from(report, 'utf8'));
      const document = await vscode.workspace.openTextDocument(reportUri);
      await vscode.window.showTextDocument(document);
    })
  );

  updateMarkedViewDescription();
  await refreshActiveEditor();
  await refreshTracker();
}

export function deactivate(): void {
  // Nothing to dispose manually beyond subscriptions.
}
