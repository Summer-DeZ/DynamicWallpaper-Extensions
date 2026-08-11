import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  RuntimeCompatibilityReport,
  RuntimeUserProperty,
  WallpaperEngineRuntimeManifest
} from '../../domain/runtime';
import { getProjectDirectory, projectFileFor } from '../settings';
import {
  isValidHost,
  loadRuntimeState,
  RuntimePropertyValue,
  updateRuntimeState
} from '../runtimeState';

interface RuntimeProjectFiles {
  projectFile: string;
  manifest?: WallpaperEngineRuntimeManifest;
  report?: RuntimeCompatibilityReport;
}

export async function openRuntimeProperties(context: vscode.ExtensionContext): Promise<void> {
  const files = await readActiveRuntimeProject(context);
  const properties = files.manifest && 'userProperties' in files.manifest
    ? files.manifest.userProperties
    : [];
  if (properties.length === 0) {
    void vscode.window.showInformationMessage('当前壁纸没有可配置的用户属性。');
    return;
  }

  let state = await updateRuntimeState(context, files.projectFile, current => ({
    ...current,
    userProperties: {
      ...Object.fromEntries(properties.map(property => [property.id, scalarValue(property.value)])),
      ...current.userProperties
    }
  }));
  const panel = vscode.window.createWebviewPanel(
    'dynamicWallpaper.properties',
    `壁纸属性：${files.manifest?.title ?? path.basename(path.dirname(files.projectFile))}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = propertyPanelHtml(panel.webview, properties, state.userProperties);
  panel.webview.onDidReceiveMessage(async message => {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return;
    const definition = properties.find(property => property.id === message.id);
    if (!definition) return;
    if (message.type === 'browse') {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
      if (!selected?.[0]) return;
      message.value = selected[0].fsPath;
    } else if (message.type !== 'update') {
      return;
    }
    const value = validatePropertyValue(definition, message.value);
    state = await updateRuntimeState(context, files.projectFile, current => ({
      ...current,
      userProperties: { ...current.userProperties, [definition.id]: value }
    }));
    await panel.webview.postMessage({ type: 'state', values: state.userProperties });
  });
}

export async function manageRuntimeNetworkAccess(context: vscode.ExtensionContext): Promise<void> {
  const files = await readActiveRuntimeProject(context);
  if (files.manifest?.kind !== 'wallpaper-engine-web') {
    void vscode.window.showInformationMessage('域名授权仅适用于 Wallpaper Engine Web 工程。');
    return;
  }
  const state = await loadRuntimeState(context, files.projectFile);
  const choice = await vscode.window.showQuickPick([
    { label: '$(add) 授权新域名', action: 'add' as const },
    ...state.networkHosts.map(host => ({ label: `$(remove-close) 撤销 ${host}`, action: 'remove' as const, host }))
  ], { title: '壁纸网络授权（默认禁止联网）', placeHolder: '授权仅对当前壁纸生效' });
  if (!choice) return;
  if (choice.action === 'add') {
    const input = await vscode.window.showInputBox({
      title: '授权当前壁纸访问域名',
      prompt: '输入域名或 URL，例如 api.example.com',
      validateInput: value => normalizeHost(value) ? undefined : '请输入有效的域名或 HTTP(S) URL。'
    });
    const host = input && normalizeHost(input);
    if (!host) return;
    await updateRuntimeState(context, files.projectFile, current => ({
      ...current,
      networkHosts: [...new Set([...current.networkHosts, host])]
    }));
    void vscode.window.showInformationMessage(`已授权当前壁纸访问 ${host}，Web 表面将自动重载。`);
  } else if (choice.host) {
    await updateRuntimeState(context, files.projectFile, current => ({
      ...current,
      networkHosts: current.networkHosts.filter(host => host !== choice.host)
    }));
    void vscode.window.showInformationMessage(`已撤销 ${choice.host} 的访问权限。`);
  }
}

export async function openRuntimeDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const files = await readActiveRuntimeProject(context);
  await updateRuntimeState(context, files.projectFile, state => ({ ...state, diagnosticsVisible: true }));
  const panel = vscode.window.createWebviewPanel(
    'dynamicWallpaper.diagnostics',
    'Dynamic Wallpaper 兼容性与运行时诊断',
    vscode.ViewColumn.Active,
    { enableScripts: false }
  );
  const report = files.report ?? files.manifest?.compatibility;
  panel.webview.html = diagnosticsPanelHtml(report);
  panel.onDidDispose(() => {
    void updateRuntimeState(context, files.projectFile, state => ({ ...state, diagnosticsVisible: false }));
  });
}

async function readActiveRuntimeProject(context: vscode.ExtensionContext): Promise<RuntimeProjectFiles> {
  const projectDirectory = getProjectDirectory(context);
  if (!projectDirectory) throw new Error('尚未选择壁纸工程。');
  const projectFile = projectFileFor(projectDirectory);
  const project = JSON.parse(await fs.readFile(projectFile, 'utf8')) as {
    version?: number;
    runtime?: { manifest?: string; report?: string };
  };
  if (project.version !== 2 || !project.runtime?.manifest) {
    return { projectFile };
  }
  const manifestFile = path.resolve(projectDirectory, project.runtime.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as WallpaperEngineRuntimeManifest;
  const reportFile = project.runtime.report ? path.resolve(projectDirectory, project.runtime.report) : undefined;
  const report = reportFile
    ? JSON.parse(await fs.readFile(reportFile, 'utf8')) as RuntimeCompatibilityReport
    : undefined;
  return { projectFile, manifest, report };
}

function scalarValue(value: unknown): RuntimePropertyValue {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? value as RuntimePropertyValue
    : JSON.stringify(value);
}

function validatePropertyValue(definition: RuntimeUserProperty, value: unknown): RuntimePropertyValue {
  if (definition.type === 'bool') return value === true || value === 'true';
  if (definition.type === 'slider') {
    const numeric = typeof value === 'number' ? value : Number(value);
    const minimum = definition.minimum ?? Number.NEGATIVE_INFINITY;
    const maximum = definition.maximum ?? Number.POSITIVE_INFINITY;
    return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : scalarValue(definition.value);
  }
  if (definition.type === 'combo') {
    const option = definition.options?.find(candidate => String(candidate.value) === String(value));
    return option ? scalarValue(option.value) : scalarValue(definition.value);
  }
  return typeof value === 'string' ? value.slice(0, 16_384) : String(value ?? '');
}

function propertyPanelHtml(
  webview: vscode.Webview,
  properties: RuntimeUserProperty[],
  values: Record<string, RuntimePropertyValue>
): string {
  const nonce = randomBytes(18).toString('base64');
  const model = JSON.stringify({ properties, values }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width"><style>
  body{padding:20px;max-width:760px;font:13px var(--vscode-font-family);color:var(--vscode-foreground)}
  .property{display:grid;grid-template-columns:minmax(150px,240px) 1fr;gap:12px;align-items:center;margin:0 0 14px}
  label{font-weight:600} input,select,textarea,button{box-sizing:border-box;width:100%;padding:7px;border:1px solid var(--vscode-input-border,transparent);color:var(--vscode-input-foreground);background:var(--vscode-input-background)}
  input[type=checkbox]{width:auto}.file{display:grid;grid-template-columns:1fr auto;gap:6px}.file button{width:auto}.hint{opacity:.75;margin-bottom:18px}
  </style></head><body><h2>Wallpaper Engine 用户属性</h2><p class="hint">更改会按当前壁纸持久化，并在约 1–3 秒内同步到 WebGL 运行时。</p><main id="properties"></main>
  <script nonce="${nonce}">const vscode=acquireVsCodeApi();const model=${model};let values={...model.values};const root=document.getElementById('properties');
  function conditionMatches(condition){if(!condition)return true;const m=String(condition).match(/^!?([\w.-]+)(?:\s*(?:==|=)\s*["']?([^"']+)["']?)?$/);if(!m)return true;const actual=values[m[1]];const matched=m[2]===undefined?Boolean(actual):String(actual)===m[2];return String(condition).trim().startsWith('!')?!matched:matched}
  function render(){root.replaceChildren();for(const p of model.properties){const row=document.createElement('div');row.className='property';row.hidden=!conditionMatches(p.condition);const label=document.createElement('label');label.textContent=p.label||p.id;row.append(label);let input;if(p.type==='bool'){input=document.createElement('input');input.type='checkbox';input.checked=Boolean(values[p.id]);}else if(p.type==='slider'){input=document.createElement('input');input.type='range';if(p.minimum!==undefined)input.min=p.minimum;if(p.maximum!==undefined)input.max=p.maximum;if(p.step!==undefined)input.step=p.step;input.value=values[p.id];}else if(p.type==='combo'){input=document.createElement('select');for(const option of p.options||[]){const node=document.createElement('option');node.textContent=option.label;node.value=String(option.value);node.selected=String(values[p.id])===node.value;input.append(node);}}else{input=document.createElement(p.type==='textinput'?'textarea':'input');input.value=values[p.id]??'';if(p.type==='file'||p.type==='scenetexture'){const group=document.createElement('div');group.className='file';group.append(input);const browse=document.createElement('button');browse.textContent='浏览…';browse.onclick=()=>vscode.postMessage({type:'browse',id:p.id});group.append(browse);row.append(group);root.append(row);continue;}}
  input.onchange=()=>{const value=p.type==='bool'?input.checked:p.type==='slider'?Number(input.value):input.value;values[p.id]=value;vscode.postMessage({type:'update',id:p.id,value});render()};row.append(input);root.append(row)}}
  addEventListener('message',event=>{if(event.data?.type==='state'){values={...event.data.values};render()}});render();</script></body></html>`;
}

function diagnosticsPanelHtml(report?: RuntimeCompatibilityReport): string {
  const diagnostics = report?.diagnostics ?? [];
  const rows = diagnostics.length
    ? diagnostics.map(entry => `<tr><td>${escapeHtml(entry.severity)}</td><td><code>${escapeHtml(entry.code)}</code></td><td>${escapeHtml(entry.message)}${entry.resource ? `<br><small>${escapeHtml(entry.resource)}</small>` : ''}${entry.details ? `<pre>${escapeHtml(entry.details)}</pre>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="3">导入阶段没有兼容性诊断。</td></tr>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{padding:20px;font:13px var(--vscode-font-family);color:var(--vscode-foreground)}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid var(--vscode-panel-border);text-align:left;vertical-align:top}pre{white-space:pre-wrap}small{opacity:.7}</style></head><body><h2>兼容性报告</h2><p>状态：<strong>${escapeHtml(report?.status ?? 'legacy')}</strong>。面板打开期间，WebGL 表面右上角会同步显示实时 shader、脚本、资源与 context-loss 诊断；关闭本面板即可隐藏覆盖层。</p><table><thead><tr><th>级别</th><th>代码</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function normalizeHost(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  try {
    const host = trimmed.includes('://') ? new URL(trimmed).hostname : trimmed;
    return isValidHost(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
