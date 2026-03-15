import * as vscode from 'vscode';
import { MarkManager, MarkedEntry } from './marks';
import { analyzeActiveContract, ContractAnalysis, FunctionSummary, isSolidityDocument, provideInlayHints as provideSolidityInlayHints, VariableSummary } from './solidity';

class CockpitProvider implements vscode.TreeDataProvider<FunctionSummary> {
  private readonly emitter = new vscode.EventEmitter<any>();
  private items: FunctionSummary[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  setItems(items: FunctionSummary[]): void {
    this.items = items;
    this.emitter.fire();
  }

  getTreeItem(item: FunctionSummary): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
    treeItem.description = item.detail;
    treeItem.tooltip = `${item.label}\n${item.detail}`;
    if (item.location) {
      treeItem.command = {
        command: 'vscode.open',
        title: 'Open Function',
        arguments: [item.location.uri, { selection: item.location.range }]
      };
    }
    return treeItem;
  }

  getChildren(): FunctionSummary[] {
    return this.items;
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
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.detail} | ${element.modifiedBy.length} modifying functions`;
      item.tooltip = `${element.name}\n${element.detail}`;
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cockpitProvider = new CockpitProvider();
  const variableProvider = new VariableProvider();
  const markManager = new MarkManager(context);

  const cockpitView = vscode.window.createTreeView<FunctionSummary>('solidityAuditor.cockpit', { treeDataProvider: cockpitProvider });
  const variableView = vscode.window.createTreeView<VariableTreeNode>('solidityAuditor.variables', { treeDataProvider: variableProvider });
  const markedView = vscode.window.createTreeView<MarkedEntry>('solidityAuditor.marked', { treeDataProvider: markManager });
  const diagnostics = vscode.languages.createDiagnosticCollection('solidityAuditor');

  const mutableStateDecoration = vscode.window.createTextEditorDecorationType({
    fontWeight: '700',
    textDecoration: 'underline'
  });

  context.subscriptions.push(
    cockpitView,
    variableView,
    markedView,
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

  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      void refreshActiveEditor();
    }, 120);
  };

  const applyAnalysis = (editor: vscode.TextEditor | undefined, analysis?: ContractAnalysis) => {
    if (!editor || !analysis) {
      cockpitProvider.setItems([]);
      variableProvider.setItems([]);
      cockpitView.description = 'No contract';
      variableView.description = 'No contract';
      for (const visibleEditor of vscode.window.visibleTextEditors) {
        visibleEditor.setDecorations(mutableStateDecoration, []);
      }
      return;
    }

    cockpitProvider.setItems(analysis.cockpitItems);
    variableProvider.setItems(analysis.variables);
    cockpitView.description = analysis.contractName;
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
    vscode.window.onDidChangeActiveTextEditor(() => scheduleRefresh()),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.activeTextEditor?.document === event.document) {
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (vscode.window.activeTextEditor?.document === document) {
        scheduleRefresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('solidityAuditor.toggleMarkFile', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      await markManager.toggleFile(target);
    }),
    vscode.commands.registerCommand('solidityAuditor.toggleMarkFolder', async (uri?: vscode.Uri) => {
      if (!uri) {
        return;
      }
      await markManager.toggleFolder(uri);
    }),
    vscode.commands.registerCommand('solidityAuditor.toggleMarkedItem', async (entry?: MarkedEntry) => {
      if (!entry) {
        return;
      }
      await markManager.toggleEntry(entry);
    }),
    vscode.commands.registerCommand('solidityAuditor.reloadScope', async () => {
      await markManager.reloadScopeMarks();
    })
  );

  await refreshActiveEditor();
}

export function deactivate(): void {
  // Nothing to dispose manually beyond subscriptions.
}
